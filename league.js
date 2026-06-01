/* league.js — wraps lackeybot.com's published Revolution league decklists.
 *
 * Pages:
 *   - List view (rows of decks): aesthetically consonant with the deckbuilder
 *   - Detail view (one deck): mirrors the deckbuilder's pane layout
 *     (.zones aside + .piles-pane) so the deck UI users know from the
 *     editor renders identically here. Drag is within-zone only — moving
 *     cards to a different zone (Main → Side) is forbidden, and the deck
 *     itself is read-only (no add/remove). Pile rearrangements within a
 *     zone are temporary view state.
 *
 * Data source: lackeybot.com's statDex API directly (POST /statdex/api,
 * with `Access-Control-Allow-Origin: *` so the browser can call it). Two
 * data_types are used: `viewable` to enumerate `<pKey>/<run>` slugs for
 * the tourney, and `decklist` (with `deckviewer: true`) to fetch each
 * deck's full slim shape — counts plus the per-card metadata
 * (setID/cardID/fullName/type/shape) the renderer needs.
 *
 * The assembled bundle is cached in localStorage with a short TTL so
 * repeat visits are instant and a typical visit only hits lackeybot once.
 * The Refresh button bypasses the cache.
 */

(() => {
'use strict';

// ---------------------------------------------------------------------------
// Configuration

// League seasons follow the `rev_YY_MM` convention (zero-padded month),
// one per calendar month. lackeybot has no "list tournaments" endpoint, so
// we don't discover seasons — we generate the slugs by convention, from the
// first 2026 season through the current month. This auto-rolls forward:
// next month's slug appears in the picker with no code change.
const SEASON_FLOOR_YEAR = 2026;     // don't list seasons before 2026
const SEASON_FLOOR_MONTH = 1;       // January 2026 (rev_26_01)
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function seasonSlug(year, month) {
  return `rev_${String(year % 100).padStart(2, '0')}_${String(month).padStart(2, '0')}`;
}
function parseSeasonSlug(slug) {
  const m = /^rev_(\d{2})_(\d{2})$/.exec(slug || '');
  if (!m) return null;
  return { year: 2000 + Number(m[1]), month: Number(m[2]) };
}
function seasonLabel(slug) {
  const p = parseSeasonSlug(slug);
  if (!p || p.month < 1 || p.month > 12) return slug;   // e.g. a gprev_ override
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
function currentSeasonSlug() {
  const now = new Date();
  return seasonSlug(now.getFullYear(), now.getMonth() + 1);
}
// Season slugs newest-first, from the floor through the current month.
function listSeasons() {
  const now = new Date();
  const out = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  while (y > SEASON_FLOOR_YEAR || (y === SEASON_FLOOR_YEAR && m >= SEASON_FLOOR_MONTH)) {
    out.push(seasonSlug(y, m));
    if (--m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// The tournament slug the page wraps. Read from URL hash if provided
// (#t=foo) so the page can also browse arbitrary lackeybot tournaments
// (e.g. a grand prix slug). Default tracks the current month's season.
function getTourney() {
  const m = /[#&?]t=([\w-]+)/.exec(location.hash || '');
  return (m && m[1]) || currentSeasonSlug();
}
const TOURNEY = getTourney();

// lackeybot.com's statDex API. `Access-Control-Allow-Origin: *` is set,
// so the browser can POST to it directly. The same endpoint serves the
// viewable index (data_type: "viewable") and individual deck bodies
// (data_type: "decklist"); see fetchBundle.
const API_URL = 'https://lackeybot.com/statdex/api';

// localStorage cache. Key is per-tourney so multiple leagues don't fight.
// TTL is short enough that "I want fresh data" is rarely more than one
// click on Refresh away, but long enough that opening a deck and bouncing
// back to the list doesn't re-fetch 80 decks.
// :v2 — bumped when the player-username map was added to the bundle. Old
// :v1 entries don't carry players, so falling back to them would silently
// reproduce the broken-author bug after we fixed it.
// :v3 — bumped when 404 "no decklist on file" run slots stopped counting as
// load failures. A :v2 bundle still carries those ids in missingDeckIds, so
// falling back to it would keep showing the stale "N could not be loaded".
const CACHE_KEY = 'rev-deckbuilder-league-cache:v3:' + TOURNEY;
const CACHE_TTL_MS = 30 * 60 * 1000;

// How many deck POSTs to run in parallel during a fresh fetch. Browsers
// already cap per-host concurrency at ~6, so anything higher is wasted.
const FETCH_CONCURRENCY = 6;

const SAVED_DECK_PREFIX = 'rev-deckbuilder-savedeck:';

const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';

// Pile rendering knobs — must mirror the deckbuilder so the visual stack
// spacing matches what users see in the editor.
const PILE_OFFSET_Y = 30;

// ---------------------------------------------------------------------------
// State

const STATE = {
  decks: [],              // [{ id, parsed, colors, author, idCards, error? }]
  byId: new Map(),        // id -> entry
  cards: null,            // card index, or null until loaded
  cardsLoading: null,     // Promise while loading
  view: 'list',           // 'list' | 'detail'
  detailId: null,         // currently open deck id
  detailZones: null,      // working pile state for detail view
  focusedZone: 'main',    // which zone the right pane shows
  filterText: '',
  uidCounter: 0,
  // List sort: chain of methods, primary first. Most-recently-chosen
  // primary slides previous primaries down to serve as tiebreakers, just
  // like the deckbuilder's pile-sort chain.
  sortChain: ['wins'],
  // refName -> total mainCount+sideCount across all decks in the bundle.
  // Built once after the bundle loads; the identifying-card logic looks
  // each card up here to find the deck's "rarest" cards league-wide.
  cardUsage: new Map(),
  // Discord ID -> display username, populated from lackeybot's `tournament`
  // endpoint. Empty if that fetch fails — the row falls back to the legacy
  // "<player>'s <deck>" parse, which is correct for the subset of decks
  // whose names follow that convention.
  players: new Map(),
};
function newUid() { return ++STATE.uidCounter; }

// ---------------------------------------------------------------------------
// Cards.json index — lazy-loaded so the page renders deck rows fast and
// only pulls the ~10MB blob if the user opens a detail view (or sooner,
// for color analysis on the list).

async function ensureCards() {
  if (STATE.cards) return STATE.cards;
  if (STATE.cardsLoading) return STATE.cardsLoading;
  STATE.cardsLoading = (async () => {
    const r = await fetch('cards.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('cards.json fetch failed');
    const data = await r.json();
    const bySetNum = new Map();   // "SET:123" -> card
    const byCanonical = new Map();// canonical name -> card (first wins)
    for (const setId of Object.keys(data.data || {})) {
      const sd = data.data[setId];
      for (const c of (sd.cards || [])) {
        const baseNum = String(c.number || '').replace(/[a-zA-Z]+$/, '');
        bySetNum.set(setId + ':' + baseNum, c);
        const canon = (c.name || '').replace(/_[A-Z0-9]+$/, '');
        if (canon && !byCanonical.has(canon)) byCanonical.set(canon, c);
      }
    }
    STATE.cards = { bySetNum, byCanonical };
    return STATE.cards;
  })();
  return STATE.cardsLoading;
}

function lookupCard(deckCard) {
  if (!STATE.cards || !deckCard) return null;
  const key = (deckCard.setID || '') + ':' + (deckCard.cardID || '');
  let c = STATE.cards.bySetNum.get(key);
  if (c) return c;
  return STATE.cards.byCanonical.get(deckCard.fullName || '') || null;
}

// ---------------------------------------------------------------------------
// Mana / color reasoning
//
// A deck is color C iff (deck can produce C) AND (some card cost requires
// C, given the producible set). Hybrid {X/Y} contributes a requirement
// for whichever of {X,Y} is actually producible — so a {W/U} card in a
// W-only deck requires W, but in a deck that produces neither it
// requires nothing. Phyrexian {X/P}, mono-hybrid {2/X}, snow, colorless
// and generic pips never contribute a required color.

const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];

function parseManaCost(cost) {
  if (!cost) return [];
  const out = [];
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(cost)) !== null) {
    const inside = m[1];
    if (/^[WUBRG]$/.test(inside)) {
      out.push({ kind: 'mono', color: inside });
      continue;
    }
    if (inside.includes('/')) {
      const parts = inside.split('/');
      if (parts.length === 2) {
        const [a, b] = parts;
        if (a === 'P' || b === 'P') {
          const color = (a === 'P') ? b : a;
          out.push(MANA_COLORS.includes(color)
            ? { kind: 'phyrexian', color }
            : { kind: 'generic' });
          continue;
        }
        if (a === '2' && MANA_COLORS.includes(b)) {
          out.push({ kind: 'monohybrid', color: b });
          continue;
        }
        if (MANA_COLORS.includes(a) && MANA_COLORS.includes(b)) {
          out.push({ kind: 'hybrid', colors: [a, b] });
          continue;
        }
      }
    }
    out.push({ kind: 'generic' });
  }
  return out;
}

function producibleColors(text) {
  const out = new Set();
  if (!text) return out;
  const sentenceRe = /Add\b([^.]*)/gi;
  let m;
  while ((m = sentenceRe.exec(text)) !== null) {
    const seg = m[1];
    const symRe = /\{([^}]+)\}/g;
    let s;
    while ((s = symRe.exec(seg)) !== null) {
      const pip = s[1];
      if (/^[WUBRG]$/.test(pip)) { out.add(pip); continue; }
      if (pip.includes('/')) {
        for (const part of pip.split('/')) {
          if (MANA_COLORS.includes(part)) out.add(part);
        }
      }
    }
    if (/\bany\s+(?:one\s+)?color/i.test(seg) || /\bof\s+any\s+color\b/i.test(seg)) {
      for (const c of MANA_COLORS) out.add(c);
    }
  }
  return out;
}

function computeDeckColors(deck) {
  // Sideboard cards don't count — color identity reflects the maindeck only.
  const producible = new Set();
  const cardEntries = Object.values(deck.cards || {});
  for (const e of cardEntries) {
    if ((e.mainCount || 0) === 0) continue;
    const c = lookupCard(e);
    if (!c) continue;
    for (const col of producibleColors(c.text || '')) producible.add(col);
  }
  const required = new Set();
  for (const e of cardEntries) {
    if ((e.mainCount || 0) === 0) continue;
    const c = lookupCard(e);
    if (!c) continue;
    const pips = parseManaCost(c.manaCost || '');
    for (const p of pips) {
      if (p.kind === 'mono') required.add(p.color);
      else if (p.kind === 'hybrid') {
        for (const col of p.colors) if (producible.has(col)) required.add(col);
      }
    }
  }
  const colors = [];
  for (const c of MANA_COLORS) {
    if (producible.has(c) && required.has(c)) colors.push(c);
  }
  return colors;
}

// ---------------------------------------------------------------------------
// Deck stats

function deckRecord(deck) {
  // Order: [wins, losses, draws]. Match-level — sum equals matches played.
  const sc = Array.isArray(deck.scores) ? deck.scores : [0, 0, 0];
  const wins = sc[0] || 0;
  const losses = sc[1] || 0;
  const draws = sc[2] || 0;
  const played = wins + losses + draws;
  const decided = wins + losses;
  const pct = decided > 0 ? Math.round((wins / decided) * 100) : null;
  return { wins, losses, draws, played, pct };
}

function totalCardCounts(deck) {
  let main = 0, side = 0;
  for (const c of Object.values(deck.cards || {})) {
    main += c.mainCount || 0;
    side += c.sideCount || 0;
  }
  return { main, side };
}

function deckArchetype(deck) {
  const name = deck.name || '';
  const cleaned = name.replace(/\([^)]*\)\s*$/, '').trim();
  const m = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})$/.exec(cleaned);
  return m ? m[1] : null;
}

// Resolve a deck's author and the cleaned-up deck-name shown in the list.
//
// Author comes from lackeybot's `tournament` endpoint (STATE.players),
// keyed by the deck's discord ID. The deck endpoint itself doesn't include
// a username — only the discord ID — so the tournament map is the only
// signal we can trust. When it's missing (tournament fetch failed, or the
// player isn't listed) we fall through with author=''; buildDeckRow then
// surfaces a truncated discord ID stub. We intentionally do NOT parse
// "<x>'s <deck>" out of the deck name: many decks don't follow that
// convention, and even when they do the prefix is just text the player
// typed (clan tags, joke names, references to other players) — treating
// it as authoritative produces wrong attributions.
//
// shortName is stripped of a `<author>'s ` prefix only when it matches the
// resolved author exactly, for the same reason — we won't strip on a loose
// regex match.
function authorAndShortName(deck) {
  const raw = (deck.name || '').trim();
  const username = STATE.players.get(String(deck.player || '')) || '';
  if (!username) return { author: '', shortName: raw };
  const stripPrefix = username.toLowerCase() + "'s ";
  if (raw.toLowerCase().startsWith(stripPrefix)) {
    return { author: username, shortName: raw.slice(stripPrefix.length).trim() };
  }
  return { author: username, shortName: raw };
}

// Map lackeybot refName to the deckbuilder's byName key.
//
// Single-faced: "Forest_VLR" → "Forest_VLR" (passthrough).
// Double-faced: "Root Fossil//Reborn Lily_CCR" → "Root Fossil_CCR".
//
// Why: parseAllSetsJson keys DFCs in byName under the FRONT face's name
// only (it slices `rawName` at " // " and discards the back), so the
// composite "Front // Back_SET" we used to emit never matched, and even the
// canonical fallback failed because card.canonical is just "Root Fossil"
// while canonicalName("Root Fossil // Reborn Lily_CCR") strips only the
// trailing "_CCR" and stops at the still-present " // ". Result: every DFC
// vanished from a copied deck. Reattaching the set suffix to the front
// face restores both the byName hit (when it has the suffixed form) and
// the canonical fallback (which strips it cleanly).
function refNameToDeckbuilderName(refName) {
  if (!refName) return refName;
  const slash = refName.indexOf('//');
  if (slash < 0) return refName;
  const front = refName.slice(0, slash).replace(/\s+$/, '');
  const back  = refName.slice(slash + 2).replace(/^\s+/, '');
  const m = /_([A-Za-z0-9]+)$/.exec(back);
  return m ? `${front}_${m[1]}` : front;
}

// Build the image URL for a deck card. `face` selects which side of a
// double-faced card to show. cajunwritescode/Revolution publishes DFCs as
// "<n>a.jpg" (front) and "<n>b.jpg" (back); the bare "<n>.jpg" is the
// printed two-sided thumbnail, which is too cramped to use in the viewer.
// Single-faced cards live at "<n>.jpg" with no suffix.
function imgUrlForDeckCard(deckCard, face) {
  if (!deckCard) return null;
  const set = deckCard.setID;
  const num = String(deckCard.cardID || '');
  if (!set || !num) return null;
  let suffix = '';
  if (isDoubleface(deckCard)) suffix = face === 'back' ? 'b' : 'a';
  else if (face === 'back') suffix = 'b';
  return `${IMG_BASE}/${set}/${encodeURIComponent(num + suffix)}.jpg`;
}

function isDoubleface(deckCard) {
  return !!(deckCard && deckCard.shape === 'doubleface');
}

// ---------------------------------------------------------------------------
// DOM utilities

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') {
        e.addEventListener(k.slice(2), attrs[k]);
      } else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
  }
  if (children) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function pipsRow(colors) {
  if (!colors || !colors.length) {
    return el('span', { class: 'league-pips colorless' }, [manaIcon('C')]);
  }
  return el('span', { class: 'league-pips' }, colors.map(manaIcon));
}

// Render one MTG mana symbol via Andrew Gioia's mana-font (vendored under
// static/vendor/mana-font/). The font already paints WUBRG with the
// canonical disc + stylized symbol when both .ms and .ms-cost are set.
function manaIcon(c) {
  const lc = String(c || '').toLowerCase();
  return el('i', {
    class: `ms ms-${lc} ms-cost`,
    'aria-label': colorName(c),
    title: colorName(c),
  });
}

function colorName(c) {
  return ({ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' }[c]) || c;
}

function pctClass(pct) {
  if (pct == null) return '';
  if (pct >= 60) return 'high';
  if (pct >= 40) return 'mid';
  return 'low';
}

function setStatus(msg, isError) {
  const node = document.getElementById('league-status');
  node.textContent = msg || '';
  node.classList.toggle('error', !!isError);
}

let toastTimer = null;
function toast(msg) {
  const node = document.getElementById('league-toast');
  node.textContent = msg;
  node.classList.remove('hidden', 'fade-out');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add('fade-out');
    setTimeout(() => node.classList.add('hidden'), 220);
  }, 2200);
}

// ---------------------------------------------------------------------------
// List view

// ---------------------------------------------------------------------------
// Structured query language
//
// Modeled on the deckbuilder's parseQuery (app.js) but tailored to the
// fields a league row exposes:
//   name:foo          — substring of deck name (case-insensitive)
//   author:foo, p:foo — substring of author OR Discord ID
//   color:WU, c:wu    — color comparison (operators below)
//   has:CardName      — deck contains a card whose fullName contains the term
//   wins:N, w:N       — numeric comparison on match wins
//   losses:N, l:N     — numeric comparison on match losses
//   winrate:X, wr:X   — wins / (wins + losses); X<=1 is a fraction, X>1 is
//                       a percent. Decks with no decided games never match.
//
// Numeric fields accept :, =, !=, <, <=, >, >=. `:` and `=` are equality.
// Color comparisons accept :, =, !=, <, <=, >, >=. The RHS is a string of
// color letters in any order ("uw" == "wu") or `c`/`0` for colorless.
//   color=WU    deck colors == {W, U}
//   color>=WU   deck colors ⊇ {W, U}      (default for bare terms — see below)
//   color<=WU   deck colors ⊆ {W, U}      (alias of color:)
//   color<WU    strict subset
//   color>WU    strict superset
//
// Boolean operators: AND (implicit between atoms), OR, NOT. Leading `-`
// before an atom is a negation. Parentheses group.
//
// A bare term (no field:) matches if ANY of (color>=term, name:term,
// author:term) holds — so "wu jund kayiu" each independently extend in
// whichever direction is plausible. All bare/atomic predicates AND together.

function parseLeagueQuery(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return { predicate: () => true, error: null };
  const tokens = tokenizeQ(trimmed);
  const cur = { i: 0, tokens };
  try {
    const pred = parseOr(cur);
    if (cur.i < tokens.length) throw new Error('unexpected ' + JSON.stringify(tokens[cur.i]));
    return { predicate: pred, error: null };
  } catch (e) {
    // Fail-soft: a malformed query matches everything so the user can keep
    // typing instead of seeing the list disappear mid-keystroke.
    return { predicate: () => true, error: e.message };
  }
}

function tokenizeQ(q) {
  const out = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { out.push({ type: 'rparen' }); i++; continue; }
    // Leading-minus NOT, only at the start or after whitespace/(.
    if (ch === '-') {
      const prev = i === 0 ? null : q[i - 1];
      const next = i + 1 < n ? q[i + 1] : null;
      if ((prev === null || /\s|\(/.test(prev)) && next !== null && !/\s|\)/.test(next)) {
        out.push({ type: 'not' });
        i++;
        continue;
      }
    }
    // Atom: read until whitespace/paren, honoring quoted spans.
    let atom = '';
    let inQ = null;
    while (i < n) {
      const c = q[i];
      if (inQ) {
        if (c === '\\' && i + 1 < n) { atom += q[i + 1]; i += 2; continue; }
        if (c === inQ) { inQ = null; i++; continue; }
        atom += c; i++; continue;
      }
      if (/\s/.test(c) || c === '(' || c === ')') break;
      if (c === '"' || c === "'") { inQ = c; i++; continue; }
      atom += c; i++;
    }
    const up = atom.toUpperCase();
    if (up === 'AND') out.push({ type: 'and' });
    else if (up === 'OR') out.push({ type: 'or' });
    else if (up === 'NOT') out.push({ type: 'not' });
    else out.push({ type: 'atom', value: atom });
  }
  return out;
}

function parseOr(cur) {
  let left = parseAnd(cur);
  while (cur.i < cur.tokens.length && cur.tokens[cur.i].type === 'or') {
    cur.i++;
    const right = parseAnd(cur);
    const a = left, b = right;
    left = (entry) => a(entry) || b(entry);
  }
  return left;
}
function parseAnd(cur) {
  let left = parseNot(cur);
  while (cur.i < cur.tokens.length) {
    const t = cur.tokens[cur.i];
    if (t.type === 'or' || t.type === 'rparen') break;
    if (t.type === 'and') { cur.i++; }            // explicit AND is just a no-op separator
    const right = parseNot(cur);
    const a = left, b = right;
    left = (entry) => a(entry) && b(entry);
  }
  return left;
}
function parseNot(cur) {
  if (cur.i < cur.tokens.length && cur.tokens[cur.i].type === 'not') {
    cur.i++;
    const inner = parseNot(cur);
    return (entry) => !inner(entry);
  }
  return parseAtom(cur);
}
function parseAtom(cur) {
  const t = cur.tokens[cur.i];
  if (!t) throw new Error('unexpected end of query');
  if (t.type === 'lparen') {
    cur.i++;
    const inner = parseOr(cur);
    if (cur.tokens[cur.i] && cur.tokens[cur.i].type === 'rparen') cur.i++;
    else throw new Error('missing )');
    return inner;
  }
  if (t.type !== 'atom') throw new Error('unexpected token ' + t.type);
  cur.i++;
  return atomPredicate(t.value);
}

// Map an atom string to a predicate. Recognizes "field<op>value"; otherwise
// treats the atom as a bare term (the OR-of-three default).
const FIELD_ALIASES_LEAGUE = {
  name: 'name', n: 'name',
  author: 'author', a: 'author', player: 'author', p: 'author',
  color: 'color', c: 'color', colors: 'color',
  has: 'has',
  wins: 'wins', w: 'wins',
  losses: 'losses', l: 'losses',
  winrate: 'winrate', wr: 'winrate',
};
function atomPredicate(atom) {
  const m = /^([A-Za-z]+)(>=|<=|!=|=|>|<|:)(.*)$/.exec(atom);
  if (m) {
    const field = FIELD_ALIASES_LEAGUE[m[1].toLowerCase()];
    const op = m[2];
    const val = m[3];
    if (field) return fieldPredicate(field, op, val);
  }
  return barePredicate(atom);
}

function fieldPredicate(field, op, valRaw) {
  const val = valRaw.toLowerCase();
  switch (field) {
    case 'name':   return predFromString((e) => (e.parsed.name || '').toLowerCase(), op, val);
    case 'author': return predFromString((e) => authorHaystack(e), op, val);
    case 'has':    return (e) => deckHasCard(e, val);
    case 'color':  return predColor(op, parseColorRHS(val));
    case 'wins':   return predFromNumber((e) => deckRecord(e.parsed).wins, op, parseFloat(valRaw));
    case 'losses': return predFromNumber((e) => deckRecord(e.parsed).losses, op, parseFloat(valRaw));
    case 'winrate': {
      const n = parseFloat(valRaw);
      // n in [0, 1] — fraction; n > 1 — percent. Either way, threshold
      // is stored as a fraction so the getter returns a fraction too.
      const threshold = Number.isNaN(n) ? NaN : (n <= 1 ? n : n / 100);
      return predFromNumber((e) => {
        const r = deckRecord(e.parsed);
        const decided = r.wins + r.losses;
        return decided > 0 ? r.wins / decided : null;
      }, op, threshold);
    }
    default:       return () => true;
  }
}

function authorHaystack(e) {
  return [(e.author || ''), (e.parsed && e.parsed.player) || ''].join(' ').toLowerCase();
}

function deckHasCard(e, lowerName) {
  if (!e.parsed) return false;
  for (const c of Object.values(e.parsed.cards || {})) {
    const inDeck = (c.mainCount || 0) + (c.sideCount || 0);
    if (!inDeck) continue;
    if ((c.fullName || '').toLowerCase().includes(lowerName)) return true;
  }
  return false;
}

// String comparator. `:` and `=` accept substring; `=` is also exact (we
// treat both as substring for the user-friendly behavior). `!=` is the
// negation of substring. Inequalities compare lexicographically — useful
// for prefix-style queries on author names.
function predFromString(getter, op, val) {
  switch (op) {
    case ':': case '=':
      return (e) => getter(e).includes(val);
    case '!=':
      return (e) => !getter(e).includes(val);
    case '<':  return (e) => getter(e) <  val;
    case '<=': return (e) => getter(e) <= val;
    case '>':  return (e) => getter(e) >  val;
    case '>=': return (e) => getter(e) >= val;
    default:   return () => false;
  }
}

// Numeric comparator. Getter returning null/NaN means "no value" — those
// entries never match (so wr<X doesn't sweep up decks with no decided
// games). NaN threshold (unparseable RHS) likewise matches nothing.
function predFromNumber(getter, op, val) {
  if (Number.isNaN(val)) return () => false;
  return (e) => {
    const v = getter(e);
    if (v == null || Number.isNaN(v)) return false;
    switch (op) {
      case ':': case '=': return v === val;
      case '!=': return v !== val;
      case '<':  return v <  val;
      case '<=': return v <= val;
      case '>':  return v >  val;
      case '>=': return v >= val;
      default:   return false;
    }
  };
}

function parseColorRHS(s) {
  const set = new Set();
  for (const ch of s.toUpperCase()) {
    if ('WUBRG'.includes(ch)) set.add(ch);
    // 'C' or '0' alone keeps the set empty, which is the colorless rep.
  }
  return set;
}

function predColor(op, target) {
  return (e) => {
    const deckSet = new Set(e.colors || []);
    switch (op) {
      case '=':  return setEq(deckSet, target);
      case '!=': return !setEq(deckSet, target);
      case ':': case '<=':
        return isSubset(deckSet, target);
      case '<':
        return isSubset(deckSet, target) && !setEq(deckSet, target);
      case '>=':
        return isSubset(target, deckSet);
      case '>':
        return isSubset(target, deckSet) && !setEq(deckSet, target);
      default: return false;
    }
  };
}
function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function isSubset(small, big) {
  for (const x of small) if (!big.has(x)) return false;
  return true;
}

// Bare term: matches if any of (color superset, name substring, author
// substring) holds. The color branch is only attempted when the term is
// recognizable as a color string (only WUBRG/C letters), so names that
// happen to start with "rg" don't get hijacked.
function barePredicate(atom) {
  const lower = atom.toLowerCase();
  const colorsForBare = isColorWord(atom) ? parseColorRHS(atom) : null;
  return (e) => {
    if (colorsForBare && colorsForBare.size && isSubset(colorsForBare, new Set(e.colors || []))) return true;
    if ((e.parsed.name || '').toLowerCase().includes(lower)) return true;
    if (authorHaystack(e).includes(lower)) return true;
    return false;
  };
}
function isColorWord(s) {
  if (!s) return false;
  return /^[wubrgcWUBRGC]+$/.test(s);
}

function entryMatchesFilter(entry, parsed) {
  if (!entry || !entry.parsed) return false;
  return parsed.predicate(entry);
}

function renderList() {
  const host = document.getElementById('league-list');
  host.innerHTML = '';
  const parsed = parseLeagueQuery(STATE.filterText);
  setSearchError(parsed.error);
  const entries = STATE.decks
    .filter(e => e.parsed)
    .filter(e => entryMatchesFilter(e, parsed));
  if (!entries.length) {
    host.appendChild(el('div', { class: 'league-empty', text: STATE.decks.length
      ? 'No decks match.'
      : 'Loading league index…' }));
    return;
  }
  sortListEntries(entries);

  for (const entry of entries) host.appendChild(buildDeckRow(entry));
}

function setSearchError(msg) {
  const input = document.getElementById('league-search');
  if (!input) return;
  if (msg) {
    input.title = 'Query parse error: ' + msg;
    input.classList.add('error');
  } else {
    input.title = '';
    input.classList.remove('error');
  }
}

// Compare two list entries by the active sort chain. Each chain entry is a
// method name; ties from the primary fall through to the next, etc. The
// final implicit tiebreaker is canonical deck name. The chain is updated by
// pushSort() — the most-recently-chosen method moves to the front, and
// previously-chosen methods slide down to serve as tiebreakers, mirroring
// the deckbuilder's pile-sort chain.
const SORT_KEYS = {
  // Wins: more wins first.
  wins: (e) => -((deckRecord(e.parsed).wins) || 0),
  // Color: bucket by color combination, ordered to keep similar colors
  // adjacent (mono first by WUBRG, then guilds, then 3+, then colorless).
  color: (e) => colorSortKey(e.colors || []),
  // Author: lowercase alpha. Empty author sorts last.
  author: (e) => (e.author ? e.author.toLowerCase() : '￿'),
};
function sortListEntries(entries) {
  entries.sort((a, b) => {
    for (const method of STATE.sortChain) {
      const fn = SORT_KEYS[method];
      if (!fn) continue;
      const va = fn(a), vb = fn(b);
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return (a.parsed.name || '').localeCompare(b.parsed.name || '');
  });
}

// Canonical color-combo ordering: WUBRG order for mono, then number of
// colors ascending, then WUBRG-lex within a tier so guilds/shards land near
// their components. Colorless ('') sorts last.
const COLOR_ORDER_INDEX = (() => {
  const idx = Object.create(null);
  MANA_COLORS.forEach((c, i) => { idx[c] = i; });
  return idx;
})();
function colorSortKey(colors) {
  if (!colors.length) return '9';                     // colorless last
  const sorted = [...colors].sort(
    (a, b) => COLOR_ORDER_INDEX[a] - COLOR_ORDER_INDEX[b]);
  // Single-digit count prefix (max 5) clusters monos / guilds / shards;
  // the WUBRG-ordered suffix orders within a count tier.
  return String(sorted.length) + sorted.join('');
}

function buildDeckRow(entry) {
  const d = entry.parsed;
  const rec = deckRecord(d);
  const archetype = deckArchetype(d);
  const author = entry.author || '';
  const shortName = entry.shortName || d.name || '(untitled)';

  const row = el('div', {
    class: 'league-deck-row',
    onclick: () => openDetail(entry.id),
  });

  // Author column — falls back to a short Discord ID so the row never
  // shows just blank space when the deck name doesn't fit the
  // "<player>'s ..." convention.
  let authorLabel = author;
  let authorClass = 'deck-author';
  if (!authorLabel) {
    authorLabel = d.player ? '#' + String(d.player).slice(-5) : '(unknown)';
    authorClass += ' unknown';
  }
  row.appendChild(el('span', {
    class: authorClass,
    text: authorLabel,
    title: d.player ? ('Discord ID: ' + d.player) : '',
  }));

  // Deck name column (without the duplicated author prefix). Hovering the
  // name (specifically) is what summons the decklist popup — using the
  // whole row as the trigger fired the popup constantly when scanning the
  // list, including when the cursor was just passing over the copy button.
  const nameCell = el('span', { class: 'deck-name' }, [
    document.createTextNode(shortName),
    archetype && !shortName.includes(archetype) ? el('span', { class: 'deck-archetype', text: archetype }) : null,
  ]);
  nameCell.addEventListener('mouseenter', () => showDecklistPopup(entry, nameCell));
  nameCell.addEventListener('mouseleave', hideDecklistPopup);
  row.appendChild(nameCell);

  // Record (wins-losses[-draws]) — no percent, no card count.
  const recBox = el('span', { class: 'league-record' });
  if (rec.played > 0) {
    recBox.appendChild(el('span', { class: 'raw wins', text: String(rec.wins) }));
    recBox.appendChild(el('span', { class: 'raw',
      text: rec.draws > 0 ? `–${rec.losses}–${rec.draws}` : `–${rec.losses}` }));
  } else {
    recBox.appendChild(el('span', { class: 'raw', text: '—' }));
  }
  row.appendChild(recBox);

  row.appendChild(pipsRow(entry.colors));

  // Identifying-card swatches: A) least-used 4-of non-land, B) least-used
  // overall card in the deck. See computeIdentifyingCards().
  const ids = entry.idCards || {};
  row.appendChild(buildIdCards(d, ids));

  const copyBtn = el('button', {
    class: 'league-copy-btn',
    text: 'Copy',
    title: 'Save a copy of this deck to local storage',
    onclick: (ev) => { ev.stopPropagation(); copyDeckToDeckbuilder(entry); },
  });
  row.appendChild(copyBtn);

  return row;
}

function buildIdCards(deck, ids) {
  const wrap = el('span', { class: 'league-id-cards' });
  const labels = ['4-of', 'rarest'];                  // for placeholders + a11y
  [ids.fourOf, ids.rarest].forEach((ref, idx) => {
    if (!ref) {
      wrap.appendChild(el('span', { class: 'id-card placeholder', text: '—' }));
      return;
    }
    const dc = deck.cards[ref];
    const total = STATE.cardUsage.get(ref) || 0;
    const node = el('span', {
      class: 'id-card',
      text: dc.fullName || ref,
      title: `${labels[idx]} — played ${total}× across the league. Hover for the card image.`,
    });
    // Hover preview reuses the existing #league-card-preview overlay so the
    // visual is the same one the deck-list piles use.
    node.addEventListener('mouseenter', (ev) => { ev.stopPropagation(); showCardPreview(dc, ev); });
    node.addEventListener('mousemove', moveCardPreview);
    node.addEventListener('mouseleave', hideCardPreview);
    wrap.appendChild(node);
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// Card-usage statistics and identifying-card derivation
//
// We compute a single map of refName -> total mainCount + sideCount summed
// across every deck in the bundle. Each row then picks two badges:
//
//   A. The non-land card with mainCount === 4 in this deck whose total
//      league usage is smallest (the deck's most distinguishing 4-of).
//   B. The card with the smallest total league usage out of every card in
//      the deck (main or side). Ties broken by *more copies in this deck*
//      first — a 4-of seen in 2 decks is a louder signal than a 1-of in
//      the same 2 decks.
//
// Card B always picks a different ref than card A so the two swatches don't
// duplicate. If no 4-of non-land exists, A is omitted; B then ignores A.

function buildCardUsage(decks) {
  const usage = new Map();
  for (const d of decks) {
    if (!d) continue;
    for (const [ref, c] of Object.entries(d.cards || {})) {
      const n = (c.mainCount || 0) + (c.sideCount || 0);
      if (n === 0) continue;
      usage.set(ref, (usage.get(ref) || 0) + n);
    }
  }
  return usage;
}

function isLandType(typeStr) {
  return /\bLand\b/.test(typeStr || '');
}

function computeIdentifyingCards(deck, usage) {
  if (!deck) return { fourOf: null, rarest: null };
  // First-tier candidate (a 4-of non-land) is the cleanest "iconic" badge
  // because a 4-of declares the deck cares about that card. When a deck has
  // no 4-of non-land (control decks with mostly singletons, prototype lists,
  // etc.) we fall back to 3-ofs, then 2-ofs — keeping the same min-usage
  // criterion. Singletons aren't iconic enough to slot into the "4-of"
  // badge and would just duplicate the rarest-card badge, so we stop at 2.
  const buckets = new Map();   // playsetSize → best { ref, total }
  let bestRarest = null;       // { ref, total, copies }
  for (const [ref, c] of Object.entries(deck.cards || {})) {
    const main = c.mainCount || 0;
    // Sideboard-only cards aren't iconic — the badges should reflect the
    // 60-card deck the pilot is leading with, not their tech against
    // specific matchups. (A sideboard-only 1-of of an obscure card would
    // otherwise dominate the rarest-card calculation.)
    if (main === 0) continue;
    // Lands are not iconic — basics get artificially "rare" via per-printing
    // usage stats (a 1-of Mountain_CYB beats every spell), and non-basics
    // mostly identify the colors, which the pip strip already shows. The
    // playset-bucket and rarest-card badges should both come from spells.
    if (isLandType(c.type)) continue;
    const total = usage.get(ref) || 0;
    if (main >= 2 && main <= 4) {
      const cur = buckets.get(main);
      if (!cur || total < cur.total) buckets.set(main, { ref, total });
    }
    if (!bestRarest
        || total < bestRarest.total
        || (total === bestRarest.total && main > bestRarest.copies)) {
      bestRarest = { ref, total, copies: main };
    }
  }
  const bestFour = buckets.get(4) || buckets.get(3) || buckets.get(2) || null;
  // Make sure the two badges don't collide. If bestRarest === bestFour,
  // pick the next-best rarest distinct ref. Must apply the same land
  // filter as the main pass — otherwise lands sneak in here when the
  // deck's rarest spell happens to also be its iconic playset.
  if (bestFour && bestRarest && bestFour.ref === bestRarest.ref) {
    let alt = null;
    for (const [ref, c] of Object.entries(deck.cards || {})) {
      if (ref === bestFour.ref) continue;
      const main = c.mainCount || 0;
      if (main === 0) continue;
      if (isLandType(c.type)) continue;
      const total = usage.get(ref) || 0;
      if (!alt
          || total < alt.total
          || (total === alt.total && main > alt.copies)) {
        alt = { ref, total, copies: main };
      }
    }
    bestRarest = alt;
  }
  return {
    fourOf: bestFour ? bestFour.ref : null,
    rarest: bestRarest ? bestRarest.ref : null,
  };
}

function rebuildAllIdentifyingCards() {
  for (const e of STATE.decks) {
    if (e.parsed) e.idCards = computeIdentifyingCards(e.parsed, STATE.cardUsage);
  }
}

// ---------------------------------------------------------------------------
// Decklist hover popup — shows the full main+side list when you hover a row.

let popupHideTimer = null;
function showDecklistPopup(entry, anchor) {
  if (!entry || !entry.parsed) return;
  if (popupHideTimer) { clearTimeout(popupHideTimer); popupHideTimer = null; }
  const popup = document.getElementById('league-decklist-popup');
  popup.innerHTML = '';
  popup.appendChild(buildPopupContents(entry.parsed));
  popup.classList.add('show');
  positionPopup(popup, anchor);
}

function hideDecklistPopup() {
  // Slight delay so a hover that crosses between row children doesn't
  // flicker the popup off and back on.
  if (popupHideTimer) clearTimeout(popupHideTimer);
  popupHideTimer = setTimeout(() => {
    document.getElementById('league-decklist-popup').classList.remove('show');
    popupHideTimer = null;
  }, 60);
}

function buildPopupContents(deck) {
  const frag = document.createDocumentFragment();
  for (const zone of ['main', 'side']) {
    const rows = popupRowsFor(deck, zone);
    if (!rows.length) continue;
    const total = rows.reduce((n, r) => n + r.count, 0);
    const group = el('div', { class: 'group' });
    group.appendChild(el('div', { class: 'group-header',
      text: (zone === 'main' ? 'Main' : 'Sideboard') + ` (${total})` }));
    for (const r of rows) {
      const row = el('div', { class: 'row' });
      row.appendChild(el('span', { class: 'qty', text: String(r.count) }));
      row.appendChild(el('span', { class: 'name', text: r.name }));
      if (r.cost) row.appendChild(el('span', { class: 'cmc', text: r.cost }));
      group.appendChild(row);
    }
    frag.appendChild(group);
  }
  if (!frag.childNodes.length) {
    frag.appendChild(el('div', { class: 'group-header', text: '(empty)' }));
  }
  return frag;
}

function popupRowsFor(deck, zone) {
  const out = [];
  for (const [ref, c] of Object.entries(deck.cards || {})) {
    const n = zone === 'main' ? (c.mainCount || 0) : (c.sideCount || 0);
    if (n === 0) continue;
    const mtg = lookupCard(c);
    out.push({
      ref,
      count: n,
      name: c.fullName || ref,
      type: c.type || '',
      cost: mtg && mtg.manaCost ? mtg.manaCost : '',
    });
  }
  out.sort((a, b) => {
    const ra = typeRank(a.type), rb = typeRank(b.type);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function positionPopup(popup, anchor) {
  // Anchor at the row's right edge by default. If the popup would overflow
  // the viewport horizontally, flip to the row's left edge. Vertical: align
  // the popup's top with the row's top, but clamp inside the viewport.
  const margin = 8;
  // Reset before measuring so previous size doesn't bias the calc.
  popup.style.left = '0px';
  popup.style.top = '0px';
  const rect = anchor.getBoundingClientRect();
  const pw = popup.offsetWidth || 280;
  const ph = popup.offsetHeight || 200;
  let x = rect.right + margin;
  if (x + pw > window.innerWidth) x = rect.left - pw - margin;
  if (x < 4) x = 4;
  let y = rect.top;
  if (y + ph > window.innerHeight - 4) y = window.innerHeight - ph - 4;
  if (y < 4) y = 4;
  popup.style.left = x + 'px';
  popup.style.top = y + 'px';
}

// ---------------------------------------------------------------------------
// Detail view — replicates the deckbuilder's pile-pane UI

const TYPE_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery',
                    'Artifact', 'Enchantment', 'Battle', 'Land'];
function primaryType(typeStr) {
  if (!typeStr) return 'Other';
  for (const t of TYPE_ORDER) if (typeStr.includes(t)) return t;
  return 'Other';
}
function typeRank(typeStr) {
  const i = TYPE_ORDER.indexOf(primaryType(typeStr));
  return i < 0 ? TYPE_ORDER.length : i;
}

// Build the working pile state for a freshly-opened deck. Mirrors the
// deckbuilder's import default (placeInstanceIntoZone in app.js): each
// distinct card occupies its own pile, with a 4-of forming a "playset
// pile" and additional copies starting a fresh pile right after it. New
// piles slot in by primary type. The result is many short piles (one per
// card) instead of a single giant pile per type.
function buildInitialZones(deck) {
  function expand(getCount) {
    const piles = [];
    const refs = Object.keys(deck.cards || {});
    refs.sort((a, b) => compareRefsForPiles(a, b, deck.cards));
    for (const ref of refs) {
      const n = getCount(deck.cards[ref]);
      for (let i = 0; i < n; i++) {
        placeInstance(piles, { uid: newUid(), ref }, ref, deck.cards);
      }
    }
    return piles;
  }
  return {
    main: { piles: expand((e) => e.mainCount || 0) },
    side: { piles: expand((e) => e.sideCount || 0) },
  };
}

// Sort comparator for the "where does a brand-new pile go?" decision.
// Type rank first (matches the deckbuilder's default `pileSort: 'type'`),
// then card name as a stable tiebreaker.
function compareRefsForPiles(a, b, deckCards) {
  const ca = deckCards[a] || {}, cb = deckCards[b] || {};
  const ra = typeRank(ca.type), rb = typeRank(cb.type);
  if (ra !== rb) return ra - rb;
  return (ca.fullName || a).localeCompare(cb.fullName || b);
}

function isLeaguePlaysetPile(pile, ref) {
  return pile.length === 4 && pile.every(x => x.ref === ref);
}

// Replicates app.js's placeInstanceIntoZone:
//   1. existing non-playset pile already containing this card → merge in
//   2. an existing playset pile of this card → start a new pile right after it
//   3. otherwise → new pile, slotted by sort comparator
function placeInstance(piles, inst, ref, deckCards) {
  for (let i = 0; i < piles.length; i++) {
    const p = piles[i];
    if (p.length === 0) continue;
    if (isLeaguePlaysetPile(p, ref)) continue;
    if (p.some(x => x.ref === ref)) {
      // Group same-ref copies together within a pile.
      let lastIdx = -1;
      for (let j = 0; j < p.length; j++) if (p[j].ref === ref) lastIdx = j;
      p.splice(lastIdx + 1, 0, inst);
      return;
    }
  }
  for (let i = 0; i < piles.length; i++) {
    if (isLeaguePlaysetPile(piles[i], ref)) {
      piles.splice(i + 1, 0, [inst]);
      return;
    }
  }
  let insertIdx = piles.length;
  for (let i = 0; i < piles.length; i++) {
    if (piles[i].length === 0) continue;
    if (compareRefsForPiles(ref, piles[i][0].ref, deckCards) < 0) {
      insertIdx = i;
      break;
    }
  }
  piles.splice(insertIdx, 0, [inst]);
}

function openDetail(id) {
  const entry = STATE.byId.get(id);
  if (!entry || !entry.parsed) return;
  STATE.detailId = id;
  STATE.view = 'detail';
  STATE.focusedZone = 'main';
  STATE.detailZones = buildInitialZones(entry.parsed);

  document.getElementById('league-list-view').classList.add('hidden');
  document.getElementById('league-detail-view').classList.remove('hidden');
  // Detail view uses internal pane scrolling — clamp html/body back to 100vh.
  document.body.classList.add('detail-active');
  renderDetail();
  window.scrollTo(0, 0);
}

function closeDetail() {
  STATE.view = 'list';
  STATE.detailId = null;
  STATE.detailZones = null;
  document.getElementById('league-list-view').classList.remove('hidden');
  document.getElementById('league-detail-view').classList.add('hidden');
  document.body.classList.remove('detail-active');
}

function renderDetail() {
  const entry = STATE.byId.get(STATE.detailId);
  if (!entry || !entry.parsed) return;
  const d = entry.parsed;

  // Header
  document.getElementById('league-detail-name').textContent = d.name || '(untitled)';
  // Source link points at the deck's lackeybot statdex page (the
  // human-readable HTML view). The slim shape we render here comes from
  // the JSON API, but the HTML page is the canonical permalink users
  // expect to see when they click "view source".
  const src = document.getElementById('league-detail-source');
  if (src) {
    const url = lackeybotDeckUrl(d.id);
    if (url) { src.href = url; src.classList.remove('hidden'); }
    else { src.removeAttribute('href'); src.classList.add('hidden'); }
  }
  const meta = document.getElementById('league-detail-meta');
  meta.innerHTML = '';
  const rec = deckRecord(d);
  if (rec.played) {
    const recBox = el('span', { class: 'league-record' }, [
      el('span', { class: 'pct ' + pctClass(rec.pct), text: rec.pct + '%' }),
      document.createTextNode(' '),
      el('span', { text: rec.draws ? `${rec.wins}-${rec.losses}-${rec.draws}` : `${rec.wins}-${rec.losses}` }),
      document.createTextNode(` · ${rec.played} match${rec.played === 1 ? '' : 'es'}`),
    ]);
    meta.appendChild(recBox);
  }
  meta.appendChild(pipsRow(entry.colors));
  if (d.player) {
    const username = STATE.players.get(String(d.player)) || '';
    meta.appendChild(el('span', {
      text: username || ('Player #' + String(d.player).slice(-5)),
      title: 'Discord ID: ' + d.player,
    }));
  }
  if (d.tournName) meta.appendChild(el('span', { text: d.tournName }));

  // Zone sidebar
  for (const zone of ['main', 'side']) renderZoneSidebar(zone);
  // Focus zone styling
  for (const sec of document.querySelectorAll('#lg-zones .zone')) {
    sec.classList.toggle('focused', sec.dataset.zone === STATE.focusedZone);
  }
  document.getElementById('lg-pile-title').textContent =
    (STATE.focusedZone === 'main' ? 'Main' : 'Sideboard')
    + ` (${STATE.detailZones[STATE.focusedZone].piles.reduce((n, p) => n + p.length, 0)})`;

  renderPiles();
}

function renderZoneSidebar(zoneName) {
  const list = document.getElementById('lg-list-' + zoneName);
  list.innerHTML = '';
  const zone = STATE.detailZones[zoneName];
  // Aggregate by ref → count for the list display (deckbuilder's convention).
  const counts = new Map();
  for (const pile of zone.piles) {
    for (const inst of pile) {
      const cur = counts.get(inst.ref);
      counts.set(inst.ref, (cur || 0) + 1);
    }
  }
  document.getElementById('lg-count-' + zoneName).textContent =
    String([...counts.values()].reduce((n, x) => n + x, 0));

  const entry = STATE.byId.get(STATE.detailId);
  const deckCards = entry.parsed.cards;

  // Group rows by primary type
  const rows = [...counts.entries()].map(([ref, count]) => {
    const dc = deckCards[ref] || {};
    return { ref, count, deckCard: dc, mtgCard: lookupCard(dc) };
  });
  rows.sort((a, b) => {
    const ra = typeRank(a.deckCard.type), rb = typeRank(b.deckCard.type);
    if (ra !== rb) return ra - rb;
    return (a.deckCard.fullName || '').localeCompare(b.deckCard.fullName || '');
  });
  // Emit grouped rows with type-group-headers
  const totals = new Map();
  for (const r of rows) {
    const t = primaryType(r.deckCard.type);
    totals.set(t, (totals.get(t) || 0) + r.count);
  }
  let curKey = null;
  for (const r of rows) {
    const t = primaryType(r.deckCard.type);
    if (t !== curKey) {
      curKey = t;
      list.appendChild(el('div', { class: 'type-group-header', text: `${t} (${totals.get(t)})` }));
    }
    list.appendChild(buildSidebarRow(zoneName, r));
  }
}

function buildSidebarRow(zoneName, row) {
  const fullName = row.deckCard.fullName || row.ref;
  const cost = row.mtgCard && row.mtgCard.manaCost ? row.mtgCard.manaCost : '';
  const div = el('div', {
    class: 'row',
    title: fullName + (cost ? ' ' + cost : ''),
    onmouseenter: (ev) => showCardPreview(row.deckCard, ev),
    onmousemove: moveCardPreview,
    onmouseleave: hideCardPreview,
  });
  div.appendChild(el('span', { class: 'qty', text: String(row.count) }));
  div.appendChild(el('span', { class: 'name', text: fullName }));
  div.appendChild(el('span', { class: 'cmc', text: cost }));
  return div;
}

function renderPiles() {
  const container = document.getElementById('lg-piles');
  container.innerHTML = '';
  const zone = STATE.detailZones[STATE.focusedZone];

  zone.piles.forEach((pile, pileIdx) => {
    if (pile.length === 0) return;
    const wrapper = el('div', { class: 'pile-wrapper' });
    wrapper.appendChild(makePileGap(pileIdx));
    wrapper.appendChild(makePileEl(pile, pileIdx));
    container.appendChild(wrapper);
  });
  container.appendChild(makePileGap(zone.piles.length));
}

function makePileGap(insertIdx) {
  const g = el('div', {
    class: 'pile-gap',
    'data-insert-idx': String(insertIdx),
    ondragover: (ev) => {
      const z = ev.dataTransfer.types.includes('text/league-zone')
                ? null : null;
      // Within-zone enforcement happens at drop: we still allow visual
      // hover so the user gets feedback if they're in the right zone.
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      clearOtherDragOver(g);
      g.classList.add('drag-over');
    },
    ondragleave: () => g.classList.remove('drag-over'),
    ondrop: (ev) => {
      ev.preventDefault();
      g.classList.remove('drag-over');
      const payload = readDragPayload(ev.dataTransfer);
      if (!payload) return;
      if (payload.zone !== STATE.focusedZone) {
        toast('Cards stay in their original zone (drag within Main or Sideboard only)');
        return;
      }
      insertNewPileWithUids(payload.uids, insertIdx);
      renderPiles();
      renderZoneSidebar(STATE.focusedZone);
    },
  });
  return g;
}

function makePileEl(pile, pileIdx) {
  const cardHeight = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue('--card-height'), 10) || 181;
  const totalH = cardHeight + Math.max(0, pile.length - 1) * PILE_OFFSET_Y;
  const pileEl = el('div', {
    class: 'pile',
    'data-pile-idx': String(pileIdx),
  });
  pileEl.style.height = totalH + 'px';

  pile.forEach((inst, slotIdx) => {
    pileEl.appendChild(makeCardSlot(inst, slotIdx));
  });

  pileEl.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearOtherDragOver(pileEl);
    pileEl.classList.add('drag-over');
  });
  pileEl.addEventListener('dragleave', (ev) => {
    if (!pileEl.contains(ev.relatedTarget)) pileEl.classList.remove('drag-over');
  });
  pileEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    pileEl.classList.remove('drag-over');
    const payload = readDragPayload(ev.dataTransfer);
    if (!payload) return;
    if (payload.zone !== STATE.focusedZone) {
      toast('Cards stay in their original zone (drag within Main or Sideboard only)');
      return;
    }
    moveUidsToPile(payload.uids, pileIdx);
    renderPiles();
    renderZoneSidebar(STATE.focusedZone);
  });
  return pileEl;
}

function makeCardSlot(inst, slotIdx) {
  const entry = STATE.byId.get(STATE.detailId);
  const dc = entry.parsed.cards[inst.ref] || {};
  const mtg = lookupCard(dc);
  const slot = el('div', {
    class: 'card-slot',
    draggable: 'true',
    'data-uid': String(inst.uid),
  });
  slot.style.top = (slotIdx * PILE_OFFSET_Y) + 'px';
  slot.style.zIndex = String(slotIdx + 1);

  const dfc = isDoubleface(dc);
  const face = (dfc && inst.flipped) ? 'back' : 'front';
  const url = imgUrlForDeckCard(dc, face);
  if (url) {
    const img = document.createElement('img');
    img.alt = dc.fullName || inst.ref;
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('error', () => {
      slot.classList.add('no-image');
      slot.textContent = dc.fullName || inst.ref;
    });
    slot.appendChild(img);
  } else {
    slot.classList.add('no-image');
    slot.textContent = dc.fullName || inst.ref;
  }
  if (dfc && inst.flipped) slot.classList.add('flipped');
  const titleParts = [dc.fullName || inst.ref];
  if (mtg) {
    if (mtg.manaCost) titleParts.push(mtg.manaCost);
    if (mtg.type) titleParts.push(mtg.type);
    if (mtg.text) titleParts.push('', mtg.text);
  }
  slot.title = titleParts.join('\n');

  slot.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/league-card', JSON.stringify({
      uids: [inst.uid],
      zone: STATE.focusedZone,
    }));
    ev.dataTransfer.setData('text/league-zone', STATE.focusedZone);
    slot.classList.add('dragging');
    // Custom card-image ghost (matches the deckbuilder). Anchor offset
    // halfway across, 30px down — same anchor app.js uses on its piles, so
    // the ghost feels "weighted" at the same point the user grabbed.
    startLeagueDragGhost(ev, dc, !!inst.flipped,
      slot.offsetWidth, slot.offsetHeight,
      slot.offsetWidth / 2, 30);
    // Suppress the hover preview while dragging — the ghost is the visual,
    // and a popup hanging next to the cursor on top of it is just noise.
    hideCardPreview();
  });
  slot.addEventListener('dragend', () => {
    slot.classList.remove('dragging');
    endLeagueDragGhost();
  });
  slot.addEventListener('mouseenter', (ev) => showCardPreview(dc, ev, !!inst.flipped, slot));
  slot.addEventListener('mousemove', moveCardPreview);
  slot.addEventListener('mouseleave', hideCardPreview);

  // DFC flip overlay — transparent center button identical to the
  // deckbuilder's. Toggles inst.flipped, swaps the image src, and adds the
  // .flipped outline. Only rendered when the card actually has a back side.
  if (dfc) slot.appendChild(makeLeagueFlipButton(inst, dc, slot));

  return slot;
}

function makeLeagueFlipButton(inst, deckCard, slot) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'flip-btn';
  btn.dataset.title = 'Flip card to see other side';
  btn.draggable = false;
  btn.innerHTML = '<span class="flip-icon" aria-hidden="true">&#x21bb;</span>';
  btn.setAttribute('aria-label', 'Flip card');
  btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    inst.flipped = !inst.flipped;
    const face = inst.flipped ? 'back' : 'front';
    const img = slot.querySelector('img');
    if (img) img.src = imgUrlForDeckCard(deckCard, face);
    slot.classList.toggle('flipped', !!inst.flipped);
  });
  return btn;
}

function readDragPayload(dt) {
  const raw = dt.getData('text/league-card');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function clearOtherDragOver(except) {
  for (const e of document.querySelectorAll('#lg-piles .drag-over')) {
    if (e !== except) e.classList.remove('drag-over');
  }
}

// Walk the focused zone's piles, take out instances with these uids, and
// drop them at the end of the destination pile. Empty source piles are
// pruned. Operates on the working detail-view state only — never writes
// upstream.
function moveUidsToPile(uids, destPileIdx) {
  const zone = STATE.detailZones[STATE.focusedZone];
  const dest = zone.piles[destPileIdx];
  if (!dest) return;
  const taken = takeUidsFromZone(uids);
  for (const inst of taken) dest.push(inst);
  pruneEmptyPiles();
}

function insertNewPileWithUids(uids, insertIdx) {
  const zone = STATE.detailZones[STATE.focusedZone];
  const taken = takeUidsFromZone(uids);
  if (!taken.length) return;
  const safeIdx = Math.min(Math.max(0, insertIdx), zone.piles.length);
  zone.piles.splice(safeIdx, 0, taken);
  pruneEmptyPiles();
}

function takeUidsFromZone(uids) {
  const set = new Set(uids);
  const zone = STATE.detailZones[STATE.focusedZone];
  const taken = [];
  for (const pile of zone.piles) {
    for (let i = pile.length - 1; i >= 0; i--) {
      if (set.has(pile[i].uid)) {
        taken.push(pile[i]);
        pile.splice(i, 1);
      }
    }
  }
  return taken;
}

function pruneEmptyPiles() {
  const zone = STATE.detailZones[STATE.focusedZone];
  zone.piles = zone.piles.filter(p => p.length > 0);
}

// ---------------------------------------------------------------------------
// Card image preview (hover) — mirrors the deckbuilder's showPreview /
// positionPreview / hidePreview (app.js) so hovering a card in the league
// detail view feels identical to hovering one in the editor:
//   - 250 ms debounce so flicking the cursor across a row doesn't flash a
//     dozen popups
//   - When invoked from a card slot (avoidEl set), the popup anchors to the
//     slot's edge instead of chasing the cursor — so it never covers the
//     card you're trying to look at
//   - Hides while the new image is loading so the previous card never
//     flashes for a fraction of a second under the new title
//
// Its own DOM node (#league-card-preview) since league.html doesn't carry
// the deckbuilder's #card-preview, but the visual / behavior is the same.

const previewEl = () => document.getElementById('league-card-preview');
const previewImg = () => document.getElementById('league-card-preview-img');

const PREVIEW_DELAY_MS = 250;
let _leaguePreviewTimer = null;
let _leaguePreviewAvoidEl = null;

function showCardPreview(deckCard, ev, isFlipped, avoidEl) {
  if (_leaguePreviewTimer) clearTimeout(_leaguePreviewTimer);
  _leaguePreviewAvoidEl = avoidEl || null;
  // Capture cursor position now; the timer fires later when ev is stale.
  const startEv = { clientX: ev.clientX, clientY: ev.clientY };
  const face = (isDoubleface(deckCard) && isFlipped) ? 'back' : 'front';
  const url = imgUrlForDeckCard(deckCard, face);
  if (!url) return;
  const run = () => {
    _leaguePreviewTimer = null;
    const node = previewEl();
    const img = previewImg();
    img.alt = deckCard.fullName || '';
    // Hide while loading so we never flash the previous card under a new
    // hover. show() runs once the new image is in (or immediately if it's
    // the same URL we already loaded).
    node.classList.remove('show');
    const show = () => {
      node.classList.add('show');
      positionCardPreview(startEv);
    };
    if (img.src === url || img.src === new URL(url, location.href).href) {
      img.src = url;
      show();
    } else {
      img.onload = () => { img.onload = null; show(); };
      img.src = url;
    }
  };
  _leaguePreviewTimer = setTimeout(run, PREVIEW_DELAY_MS);
}

function positionCardPreview(ev) {
  const node = previewEl();
  if (!node.classList.contains('show')) return;
  const w = node.offsetWidth || 240;
  const h = node.offsetHeight || 336;
  if (_leaguePreviewAvoidEl) {
    // Anchor to the slot's right edge; flip to the left if it would overflow.
    const ar = _leaguePreviewAvoidEl.getBoundingClientRect();
    let x = ar.right + 8;
    if (x + w > window.innerWidth) x = ar.left - w - 8;
    let y = ar.top;
    if (y < 8) y = 8;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  } else {
    let x = ev.clientX + 16;
    let y = ev.clientY - h / 2;
    if (x + w > window.innerWidth) x = ev.clientX - w - 16;
    if (y < 8) y = 8;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }
}
// Kept for the cursor-tracking call sites (sidebar rows, id-card badges)
// where the preview chases the cursor instead of anchoring to a slot.
function moveCardPreview(ev) {
  if (_leaguePreviewAvoidEl) return;
  positionCardPreview(ev);
}
function hideCardPreview() {
  if (_leaguePreviewTimer) { clearTimeout(_leaguePreviewTimer); _leaguePreviewTimer = null; }
  previewEl().classList.remove('show');
}

// ---------------------------------------------------------------------------
// Custom drag ghost — replaces the browser's default semi-transparent
// screenshot with a card-image overlay that matches the deckbuilder's drag
// feel exactly. Same trick as app.js: a 1×1 transparent gif suppresses the
// native ghost (setDragImage), and a fixed-position .drag-ghost div is
// repositioned on every dragover.

const LEAGUE_EMPTY_DRAG_IMG = new Image();
LEAGUE_EMPTY_DRAG_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
LEAGUE_EMPTY_DRAG_IMG.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:-1;';
document.documentElement.appendChild(LEAGUE_EMPTY_DRAG_IMG);

let _leagueDragGhost = null;  // { el, offsetX, offsetY }

function startLeagueDragGhost(ev, deckCard, isFlipped, width, height, offsetX, offsetY) {
  endLeagueDragGhost();
  ev.dataTransfer.setDragImage(LEAGUE_EMPTY_DRAG_IMG, 0, 0);
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.style.width = width + 'px';
  ghost.style.height = height + 'px';
  const face = (isDoubleface(deckCard) && isFlipped) ? 'back' : 'front';
  const src = imgUrlForDeckCard(deckCard, face);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `position:absolute;top:0;left:0;`
                      + `width:${width}px;height:${height}px;`
                      + `object-fit:cover;border-radius:5px;`;
    ghost.appendChild(img);
  }
  ghost.style.left = (ev.clientX - offsetX) + 'px';
  ghost.style.top = (ev.clientY - offsetY) + 'px';
  document.body.appendChild(ghost);
  _leagueDragGhost = { el: ghost, offsetX, offsetY };
}
function endLeagueDragGhost() {
  if (_leagueDragGhost) {
    _leagueDragGhost.el.remove();
    _leagueDragGhost = null;
  }
}
// Cursor tracking. dragover fires continuously during a drag — including
// over the document — so a single document-level listener keeps the ghost
// glued to the cursor regardless of which child element is under it.
document.addEventListener('dragover', (ev) => {
  if (_leagueDragGhost) {
    _leagueDragGhost.el.style.left = (ev.clientX - _leagueDragGhost.offsetX) + 'px';
    _leagueDragGhost.el.style.top = (ev.clientY - _leagueDragGhost.offsetY) + 'px';
  }
});

// ---------------------------------------------------------------------------
// Copy to deckbuilder

function copyDeckToDeckbuilder(entry) {
  const d = entry.parsed;
  const zones = { main: [], sanctum: [], side: [], maybe: [] };
  const mainPile = [];
  const sidePile = [];
  for (const e of Object.values(d.cards || {})) {
    for (let i = 0; i < (e.mainCount || 0); i++) mainPile.push(refNameToDeckbuilderName(e.refName));
    for (let i = 0; i < (e.sideCount || 0); i++) sidePile.push(refNameToDeckbuilderName(e.refName));
  }
  if (mainPile.length) zones.main.push(mainPile);
  if (sidePile.length) zones.side.push(sidePile);

  const baseName = makeUniqueDeckbuilderName(d.name || `Deck ${entry.id}`);
  const tags = ['league', TOURNEY];
  if (d.player) tags.push('player:' + d.player);
  const payload = {
    name: baseName,
    savedAt: new Date().toISOString(),
    zones,
    format: 'standard',
    rangeStart: null,
    rangeEnd: null,
    folder: 'League ' + TOURNEY,
    tags,
    plans: [],
  };
  try {
    localStorage.setItem(SAVED_DECK_PREFIX + baseName, JSON.stringify(payload));
    toast('Copied "' + baseName + '" to deckbuilder');
  } catch (e) {
    toast('Copy failed: ' + e.message);
  }
}

// Build the deck's permalink on lackeybot.com (the human-readable HTML
// page, not the JSON API endpoint). Used by the "view source" link in
// the detail view.
function lackeybotDeckUrl(deckId) {
  if (!deckId || typeof deckId !== 'string' || deckId.indexOf('/') < 0) return null;
  return `https://lackeybot.com/rev/statdex/d/${TOURNEY}/${deckId}`;
}

// Plain-text decklist matching the deckbuilder's importTxt format:
// "<count> <name>" lines, blank line between zones, main → sideboard.
// Names are run through refNameToDeckbuilderName so DFCs come out as the
// front face's name (the same key the deckbuilder accepts on import).
function buildClipboardText(deck) {
  const sections = [];
  for (const zone of ['main', 'side']) {
    const lines = [];
    const refs = Object.keys(deck.cards || {})
      .filter(r => (zone === 'main' ? deck.cards[r].mainCount : deck.cards[r].sideCount) > 0)
      .sort((a, b) => (deck.cards[a].fullName || '').localeCompare(deck.cards[b].fullName || ''));
    for (const ref of refs) {
      const c = deck.cards[ref];
      const n = zone === 'main' ? c.mainCount : c.sideCount;
      if (!n) continue;
      lines.push(`${n} ${refNameToDeckbuilderName(ref)}`);
    }
    if (lines.length) sections.push(lines.join('\n'));
  }
  return sections.join('\n\n') + '\n';
}

async function copyDetailTextToClipboard() {
  if (!STATE.detailId) return;
  const entry = STATE.byId.get(STATE.detailId);
  if (!entry || !entry.parsed) return;
  const text = buildClipboardText(entry.parsed);
  const btn = document.getElementById('league-detail-copy-txt');
  const original = btn ? btn.textContent : '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older browsers / non-secure contexts: a hidden textarea
      // + execCommand. Modern Chromium/Firefox/Safari all support the
      // clipboard API on https or localhost, so this branch is rare.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn) btn.textContent = 'Copied ✓';
    toast('Decklist copied to clipboard');
  } catch (e) {
    if (btn) btn.textContent = 'Copy failed';
    toast('Clipboard copy failed: ' + (e && e.message ? e.message : e));
  }
  if (btn) setTimeout(() => { btn.textContent = original; }, 1500);
}

function copyDetailToDeckbuilder() {
  if (!STATE.detailId) return;
  const entry = STATE.byId.get(STATE.detailId);
  if (!entry) return;
  // Build payload from the in-page (possibly rearranged) zones, preserving
  // the user's pile arrangement so the deckbuilder loads it the same way
  // they laid it out in the viewer.
  const zones = { main: [], sanctum: [], side: [], maybe: [] };
  for (const z of ['main', 'side']) {
    for (const pile of STATE.detailZones[z].piles) {
      const names = pile.map(inst => refNameToDeckbuilderName(inst.ref));
      if (names.length) zones[z].push(names);
    }
  }
  const baseName = makeUniqueDeckbuilderName(entry.parsed.name || `Deck ${entry.id}`);
  const tags = ['league', TOURNEY];
  if (entry.parsed.player) tags.push('player:' + entry.parsed.player);
  const payload = {
    name: baseName,
    savedAt: new Date().toISOString(),
    zones,
    format: 'standard',
    rangeStart: null,
    rangeEnd: null,
    folder: 'League ' + TOURNEY,
    tags,
    plans: [],
  };
  try {
    localStorage.setItem(SAVED_DECK_PREFIX + baseName, JSON.stringify(payload));
    toast('Copied "' + baseName + '" to deckbuilder');
  } catch (e) {
    toast('Copy failed: ' + e.message);
  }
}

function makeUniqueDeckbuilderName(base) {
  const exists = (n) => localStorage.getItem(SAVED_DECK_PREFIX + n) != null;
  if (!exists(base)) return base;
  let n = 2;
  let cand = `${base} (${n})`;
  while (exists(cand)) { n++; cand = `${base} (${n})`; }
  return cand;
}

// ---------------------------------------------------------------------------
// Boot

async function loadAll(force) {
  setStatus('Loading league…');

  // Cache hit short-circuits the lackeybot round-trip. We still re-run
  // color analysis on every load (cheap, depends on cards.json which can
  // outlive any single cache entry).
  let bundle = null;
  if (!force) {
    bundle = readCache();
  }

  if (!bundle) {
    try {
      bundle = await fetchBundle((done, total) => {
        setStatus(`Loading league… ${done}/${total}`);
      });
    } catch (e) {
      setStatus('League fetch failed: ' + e.message, true);
      return;
    }
    writeCache(bundle);
  }

  hydrateFromBundle(bundle);

  // Cards.json drives color analysis (it has each card's text + manaCost,
  // which the statDex API doesn't return). The deckviewer payload already
  // gives us setID/cardID/type/fullName/shape, so no per-card enrichment
  // pass is needed.
  try { await ensureCards(); }
  catch (_) { /* color analysis is skipped if cards.json fails */ }
  for (const entry of STATE.decks) {
    if (entry.parsed) entry.colors = computeDeckColors(entry.parsed);
  }
  renderListIfList();

  const stamp = bundle.fetchedAt
    ? ' · synced ' + new Date(bundle.fetchedAt).toLocaleString()
    : '';
  // missingDeckIds is the gap between what `viewable` advertised and what the
  // per-deck `decklist` calls actually delivered. The endpoint returns HTTP
  // 500 for these IDs and the cause is opaque from the outside — neither the
  // docs' "active runs" hint nor any visible field on the run record (match
  // count, duplicate name, score shape, encoded card list) cleanly separates
  // the failing IDs from the rest. Surface the count so the list isn't
  // silently truncated.
  const missing = Array.isArray(bundle.missingDeckIds) ? bundle.missingDeckIds.length : 0;
  const total = bundle.decks.length + missing;
  const gap = missing
    ? ` · ${missing} of ${total} could not be loaded`
    : '';
  setStatus(`${bundle.decks.length} deck${bundle.decks.length === 1 ? '' : 's'} loaded${gap}${stamp}`);
}

// Pulls the viewable index, fans out one POST per deck, and assembles the
// slim bundle. `onProgress(done, total)` fires after every fetch attempt
// so the page can show "Loading league… 23/80". Throws on index failure;
// per-deck failures are logged and skipped so one bad deck can't mask the
// other 79.
async function fetchBundle(onProgress) {
  const ids = await fetchViewable();

  if (onProgress) onProgress(0, ids.length);
  const out = new Array(ids.length);
  const missingDeckIds = [];
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      try {
        out[i] = await fetchOneDeck(ids[i]);
      } catch (e) {
        out[i] = null;
        // A 404 means the `viewable` index advertised a run slot that has no
        // decklist on file — a registered-but-unsubmitted/abandoned run, not
        // a load failure. There's no deck to show, so drop it silently rather
        // than counting it against the "could not be loaded" tally. Genuine
        // misses (500 withheld active runs, network errors) still count.
        if (!(e && e.status === 404)) {
          console.warn('league: deck fetch failed', ids[i], e);
          missingDeckIds.push(ids[i]);
        }
      }
      done += 1;
      if (onProgress) onProgress(done, ids.length);
    }
  }
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker);
  // Tournament data is needed for the discord-id → username map. It's a
  // single small POST and the only signal we have for player names (the
  // per-deck endpoint omits them), so kick it off in parallel with the
  // deck-fetch fan-out. A failure here isn't fatal — players just falls
  // back to {} and the rows surface truncated discord ids instead.
  const playersPromise = fetchTournamentPlayers().catch(e => {
    console.warn('league: tournament/players fetch failed', e);
    return {};
  });
  await Promise.all(workers);
  const players = await playersPromise;
  return {
    tourney: TOURNEY,
    fetchedAt: new Date().toISOString(),
    decks: out.filter(d => d != null),
    players,
    missingDeckIds,
  };
}

// Fetch the tournament endpoint and pluck the {pKey: username} map. The
// rest of the response (matches, leaderboards, etc.) we don't use yet, so
// keep only what's needed — caching the full body would balloon the
// localStorage entry.
async function fetchTournamentPlayers() {
  const data = await callStatDex({
    format: 'revolution',
    data_type: 'tournament',
    tKey: TOURNEY,
  });
  const players = (data && data.body && data.body.players) || {};
  const out = {};
  for (const [pKey, p] of Object.entries(players)) {
    if (p && typeof p.username === 'string' && p.username) out[pKey] = p.username;
  }
  return out;
}

async function fetchViewable() {
  const data = await callStatDex({
    format: 'revolution',
    data_type: 'viewable',
    tKey: TOURNEY,
  });
  if (!data || !data.body || !Array.isArray(data.body.lists)) {
    throw new Error('viewable: malformed response');
  }
  return data.body.lists.map(String);
}

async function fetchOneDeck(deckId) {
  const slash = deckId.indexOf('/');
  if (slash < 0) throw new Error('malformed deck id ' + deckId);
  const pKey = deckId.slice(0, slash);
  const rKey = deckId.slice(slash + 1);
  // `deckviewer: true` makes the response include the per-card metadata
  // (setID/cardID/type/fullName/shape) the renderer needs. Without it the
  // body's cards map only has counts, and we'd have to look everything up
  // in cards.json ourselves.
  const data = await callStatDex({
    format: 'revolution',
    data_type: 'decklist',
    tKey: TOURNEY,
    pKey,
    rKey,
    deckviewer: true,
  });
  if (!data || !data.body) {
    throw new Error('statdex error: ' + ((data && data.error) || 'malformed response'));
  }
  return apiDeckToSlim(deckId, data.body);
}

async function callStatDex(payload) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = new Error(`statdex ${r.status}`);
    err.status = r.status;   // let callers distinguish 404 (no such deck) from 500 etc.
    throw err;
  }
  return r.json();
}

// Translate the statDex API's per-deck shape into the slim shape the rest
// of league.js consumes. With `deckviewer: true`, every field we need is
// already on the upstream card record; we just flatten `decks: {main, side}`
// to the legacy `mainCount`/`sideCount` keys and pass the metadata through.
// The `opponents` array is preserved so a future detail view can surface
// match-by-match results.
function apiDeckToSlim(deckId, body) {
  const cards = {};
  for (const [ref, c] of Object.entries(body.cards || {})) {
    const counts = (c && c.decks) || {};
    cards[ref] = {
      mainCount: counts.main || 0,
      sideCount: counts.side || 0,
      setID: c.setID || '',
      cardID: c.cardID != null ? String(c.cardID).replace(/[a-zA-Z]+$/, '') : '',
      fullName: c.fullName || '',
      type: c.type || '',
      shape: c.shape || 'normal',
      refName: ref,
    };
  }
  return {
    id: deckId,
    name: body.name || '',
    tournName: body.tournName || '',
    player: body.player || '',
    run: body.run != null ? String(body.run) : '',
    matches: Array.isArray(body.matches) ? body.matches : [],
    scores: Array.isArray(body.scores) ? body.scores : [],
    opponents: Array.isArray(body.opponents) ? body.opponents : [],
    cards,
  };
}

function hydrateFromBundle(bundle) {
  // Populate STATE.players FIRST — authorAndShortName reads it. An older
  // cached bundle from before :v2 won't have `players`; the empty-map
  // fallback drops every row's author back to the discord-id stub, which
  // matches what those users would see if they refreshed.
  STATE.players = new Map(Object.entries(bundle.players || {}));
  const decks = Array.isArray(bundle.decks) ? bundle.decks : [];
  STATE.decks = decks.map(d => {
    const an = authorAndShortName(d);
    return { id: d.id, parsed: d, colors: [],
             author: an.author, shortName: an.shortName, idCards: {} };
  });
  STATE.byId = new Map(STATE.decks.map(e => [e.id, e]));
  STATE.cardUsage = buildCardUsage(decks);
  rebuildAllIdentifyingCards();
  renderListIfList();
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.fetchedAt || !Array.isArray(obj.decks)) return null;
    const ageMs = Date.now() - new Date(obj.fetchedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CACHE_TTL_MS) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function writeCache(bundle) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(bundle));
  } catch (_) {
    /* over quota or storage disabled — cache is best-effort */
  }
}

function renderListIfList() {
  if (STATE.view === 'list') renderList();
}

// Sort-chain UI. Mirrors the deckbuilder's pile-sort dropdown: clicking a
// method moves it to the front of STATE.sortChain so previously-chosen
// methods slide down to act as tiebreakers (the user-stated requirement is
// "ties broken by most recently chosen").
const SORT_LABELS = {
  wins:   'Wins',
  color:  'Color',
  author: 'Author',
};
function wireSortDropdown() {
  const btn = document.getElementById('league-sort-btn');
  const menu = document.getElementById('league-sort-menu');
  const updateLabel = () => {
    const primary = STATE.sortChain[0] || 'wins';
    btn.innerHTML = (SORT_LABELS[primary] || primary) + ' ▾';
    menu.querySelectorAll('button[data-league-sort]').forEach(b => {
      b.classList.toggle('active', b.dataset.leagueSort === primary);
    });
    const tail = STATE.sortChain.slice(1).map(m => SORT_LABELS[m] || m);
    document.getElementById('league-sort-chain').textContent =
      tail.length ? `(then ${tail.join(', ').toLowerCase()})` : '';
  };
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) menu.classList.add('hidden');
  });
  menu.querySelectorAll('button[data-league-sort]').forEach(b => {
    b.addEventListener('click', () => {
      pushSort(b.dataset.leagueSort);
      menu.classList.add('hidden');
      updateLabel();
      if (STATE.view === 'list') renderList();
    });
  });
  updateLabel();
}

function pushSort(method) {
  const chain = STATE.sortChain;
  const i = chain.indexOf(method);
  if (i >= 0) chain.splice(i, 1);
  chain.unshift(method);
  // Keep the chain bounded by the method count — duplicates can't grow it
  // since we splice them out above, but defense in depth.
  if (chain.length > Object.keys(SORT_LABELS).length) {
    chain.length = Object.keys(SORT_LABELS).length;
  }
}

// Season picker. Lists every generated season newest-first; the active one
// is highlighted. Picking a different season reloads the page with the new
// slug in the hash so all module-load-time state (TOURNEY, cache key, STATE)
// is rebuilt cleanly rather than surgically reset.
function wireSeasonDropdown() {
  const btn = document.getElementById('league-season-btn');
  const menu = document.getElementById('league-season-menu');
  if (!btn || !menu) return;

  const seasons = listSeasons();
  // If TOURNEY came from a #t= override outside the generated range (an old
  // season below the floor, or a non-league slug like a gprev), surface it
  // at the top so the button still shows the active selection.
  if (!seasons.includes(TOURNEY)) seasons.unshift(TOURNEY);

  btn.innerHTML = seasonLabel(TOURNEY) + ' &#x25BE;';
  menu.innerHTML = '';
  for (const slug of seasons) {
    const item = el('button', { 'data-season': slug, text: seasonLabel(slug) });
    if (slug === TOURNEY) item.classList.add('active');
    item.addEventListener('click', () => {
      menu.classList.add('hidden');
      if (slug !== TOURNEY) selectSeason(slug);
    });
    menu.appendChild(item);
  }

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) menu.classList.add('hidden');
  });
}

function selectSeason(slug) {
  location.hash = 't=' + slug;
  location.reload();
}

function wireUI() {
  document.title = 'League: ' + seasonLabel(TOURNEY);
  wireSeasonDropdown();

  const search = document.getElementById('league-search');
  search.addEventListener('input', () => {
    STATE.filterText = search.value;
    if (STATE.view === 'list') renderList();
  });
  document.getElementById('league-refresh').addEventListener('click', () => {
    loadAll(true);
  });
  document.getElementById('league-detail-back').addEventListener('click', closeDetail);
  document.getElementById('league-detail-copy').addEventListener('click', copyDetailToDeckbuilder);
  document.getElementById('league-detail-copy-txt').addEventListener('click', copyDetailTextToClipboard);

  wireSortDropdown();

  // Click a zone in the aside to focus it (matches the deckbuilder).
  for (const hdr of document.querySelectorAll('#lg-zones .zone > header')) {
    hdr.addEventListener('click', () => {
      const z = hdr.dataset.zoneTarget;
      if (!z || z === STATE.focusedZone) return;
      STATE.focusedZone = z;
      renderDetail();
    });
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && STATE.view === 'detail') {
      ev.preventDefault();
      closeDetail();
    }
    if (ev.key === '/' && document.activeElement !== search) {
      ev.preventDefault();
      search.focus();
      search.select();
    }
  });
}

wireUI();
loadAll(false);

})();
