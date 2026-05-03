#!/usr/bin/env python3
"""Fetch a Revolution league's decks from lackeybot.com and bundle them as
a slim, same-origin static file at ``league/<tourney>/decks.json`` (paths
are relative to the GitHub Pages repo root, which is the deckbuilder's
``static/`` directory).

Designed to run from the GitHub Action defined in
``.github/workflows/league-update.yml``, but works standalone:

    cd static && python scripts/update_league.py rev_26_05

Behavior:
  1. GET https://lackeybot.com/rev/viewable/<tourney> -> {lists: [...]}
  2. For each id, GET https://lackeybot.com/rev/statdex/d/<tourney>/<uid>/<run>
     and slice the ``var deckObjs = [...]`` literal out of the HTML.
  3. Project to slim fields and merge with the previous bundle, falling back
     to the previous entry on parse/network failure so a transient blip
     never wipes the snapshot.
  4. Atomically rewrite ``decks.json`` and ``meta.json``.
  5. Write a one-line commit subject to ``.commit-msg`` for the workflow.

Stdlib-only.
"""

from __future__ import annotations

import json
import os
import sys
import time
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UPSTREAM_BASE = "https://lackeybot.com/rev/"
USER_AGENT = "rev-deckbuilder-league-sync/1 (+github.com/tremorre/visual-deckbuilder)"

REQUEST_TIMEOUT = 30
SLEEP_BETWEEN_FETCHES = 0.5  # polite throttle

# Slim shape: just enough for league.js to render rows + open detail.
DECK_FIELDS = ("id", "name", "player", "tournName", "run", "matches", "scores")
CARD_FIELDS = ("mainCount", "sideCount", "setID", "cardID",
               "fullName", "refName", "shape", "type")


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def parse_deck_html(html: str):
    """Slice the outermost `var deckObjs = [...]` array literal out of the
    upstream HTML and JSON-parse it. Mirrors the bracket-walker that used
    to live in the page (string-aware so '[' inside card text doesn't fool
    the depth counter)."""
    start = html.find("var deckObjs")
    if start < 0:
        return None
    eq = html.find("=", start)
    if eq < 0:
        return None
    i = eq + 1
    n = len(html)
    while i < n and html[i].isspace():
        i += 1
    if i >= n or html[i] != "[":
        return None
    arr_start = i
    depth = 0
    in_str = False
    str_ch = ""
    escape = False
    end = -1
    while i < n:
        c = html[i]
        if escape:
            escape = False
        elif in_str:
            if c == "\\":
                escape = True
            elif c == str_ch:
                in_str = False
        elif c == '"' or c == "'":
            in_str = True
            str_ch = c
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
        i += 1
    if end < 0:
        return None
    try:
        return json.loads(html[arr_start:end + 1])
    except json.JSONDecodeError:
        return None


def slim_deck(raw: dict) -> dict:
    out = {k: raw.get(k) for k in DECK_FIELDS if k in raw}
    cards_in = raw.get("cards") or {}
    cards_out = {}
    for ref, c in cards_in.items():
        cards_out[ref] = {k: c.get(k) for k in CARD_FIELDS if k in c}
    out["cards"] = cards_out
    return out


def fetch_index(tourney: str) -> list[str]:
    url = UPSTREAM_BASE + f"viewable/{tourney}"
    data = json.loads(http_get(url))
    lists = data.get("lists")
    if not isinstance(lists, list):
        raise RuntimeError(f"unexpected index shape from {url}")
    return [str(x) for x in lists]


def fetch_deck(tourney: str, deck_id: str) -> dict | None:
    """Returns the slim deck dict, or None if the upstream fetch or parse
    failed. Errors are logged to stderr, not raised — the caller decides
    how to handle (typically: keep the previous entry)."""
    if "/" not in deck_id:
        print(f"  ! malformed deck id {deck_id!r} — skipping", file=sys.stderr)
        return None
    uid, idx = deck_id.split("/", 1)
    url = UPSTREAM_BASE + f"statdex/d/{tourney}/{uid}/{idx}"
    try:
        html = http_get(url)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  ! fetch {deck_id} failed: {e}", file=sys.stderr)
        return None
    arr = parse_deck_html(html)
    if not arr:
        print(f"  ! parse {deck_id} failed", file=sys.stderr)
        return None
    raw = arr[0]
    raw.setdefault("id", deck_id)
    return slim_deck(raw)


def atomic_write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".tmp",
        dir=str(path.parent), delete=False,
    )
    try:
        json.dump(payload, tmp, ensure_ascii=False, indent=2, sort_keys=True)
        tmp.write("\n")
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def load_existing(decks_path: Path) -> dict[str, dict]:
    if not decks_path.exists():
        return {}
    try:
        with decks_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return {d["id"]: d for d in data.get("decks", []) if isinstance(d, dict) and "id" in d}


def shape_diff_summary(prev: dict[str, dict], curr_ids: list[str], curr: dict[str, dict]) -> str:
    new = sum(1 for i in curr_ids if i not in prev)
    changed = 0
    for i in curr_ids:
        if i in prev and i in curr and prev[i] != curr[i]:
            changed += 1
    bits = [f"{len(curr_ids)} decks"]
    if new:
        bits.append(f"+{new} new")
    if changed:
        bits.append(f"~{changed} changed")
    return " (".join((bits[0], ", ".join(bits[1:]) + ")")) if len(bits) > 1 else bits[0]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: update_league.py <tourney-slug>", file=sys.stderr)
        return 2
    tourney = argv[1]
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "league" / tourney
    decks_path = out_dir / "decks.json"
    meta_path = out_dir / "meta.json"

    print(f"== league update: {tourney} ==")
    try:
        ids = fetch_index(tourney)
    except Exception as e:
        print(f"index fetch failed: {e}", file=sys.stderr)
        return 1
    print(f"  index: {len(ids)} decks")

    prev = load_existing(decks_path)
    curr: dict[str, dict] = {}
    attempted = succeeded = kept_stale = failed = 0
    for deck_id in ids:
        attempted += 1
        deck = fetch_deck(tourney, deck_id)
        if deck is not None:
            curr[deck_id] = deck
            succeeded += 1
        elif deck_id in prev:
            curr[deck_id] = prev[deck_id]
            kept_stale += 1
        else:
            failed += 1
        time.sleep(SLEEP_BETWEEN_FETCHES)

    ordered_decks = [curr[i] for i in ids if i in curr]
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    # Precompute league-wide card usage so the page doesn't have to walk
    # every deck on every load. Sum of mainCount + sideCount across every
    # deck in the bundle, keyed by refName. The page falls back to
    # computing this itself if the field is missing, so old bundles still
    # work.
    card_usage: dict[str, int] = {}
    for d in ordered_decks:
        for ref, c in (d.get("cards") or {}).items():
            n = (c.get("mainCount") or 0) + (c.get("sideCount") or 0)
            if n:
                card_usage[ref] = card_usage.get(ref, 0) + n

    bundle = {
        "tourney": tourney,
        "fetchedAt": fetched_at,
        "decks": ordered_decks,
        "cardUsage": card_usage,
    }
    meta = {
        "tourney": tourney,
        "fetchedAt": fetched_at,
        "attempted": attempted,
        "succeeded": succeeded,
        "keptStale": kept_stale,
        "failed": failed,
    }
    atomic_write_json(decks_path, bundle)
    atomic_write_json(meta_path, meta)

    summary = shape_diff_summary(prev, ids, curr)
    subject = f"league: {tourney} — {summary}"
    if kept_stale or failed:
        subject += f" [stale={kept_stale} failed={failed}]"
    (repo_root / ".commit-msg").write_text(subject + "\n", encoding="utf-8")

    print(f"  {summary}; stale={kept_stale} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
