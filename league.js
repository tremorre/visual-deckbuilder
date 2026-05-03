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
 * Data source: a same-origin static `league/<TOURNEY>/decks.json` bundle
 * mirrored by .github/workflows/league-update.yml every ~45 min. The page
 * never talks to lackeybot.com directly — see scripts/update_league.py.
 */

(() => {
'use strict';

// ---------------------------------------------------------------------------
// Configuration

// The tournament slug the page wraps. Read from URL hash if provided
// (#t=foo) so the same page can browse other lackeybot tournaments later
// without code changes. Default tracks the current league.
function getTourney() {
  const m = /[#&?]t=([\w-]+)/.exec(location.hash || '');
  return (m && m[1]) || 'rev_26_05';
}
const TOURNEY = getTourney();

// Same-origin bundle written by scripts/update_league.py; refreshed on a
// ~45-min cron in .github/workflows/league-update.yml.
const BUNDLE_PATH = `league/${TOURNEY}/decks.json`;

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
  const producible = new Set();
  const cardEntries = Object.values(deck.cards || {});
  for (const e of cardEntries) {
    const c = lookupCard(e);
    if (!c) continue;
    for (const col of producibleColors(c.text || '')) producible.add(col);
  }
  const required = new Set();
  for (const e of cardEntries) {
    if ((e.mainCount || 0) === 0 && (e.sideCount || 0) === 0) continue;
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

// Lackeybot deck names follow `<player>'s <deck name>`. Pull the player out
// so the list can give it its own column. Fallback: empty string (the row
// still falls back to a short Discord ID for context).
function authorAndShortName(deck) {
  const raw = (deck.name || '').trim();
  const m = /^(.+?)'s\s+(.+)$/.exec(raw);
  if (m) return { author: m[1].trim(), shortName: m[2].trim() };
  return { author: '', shortName: raw };
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

function imgUrlForDeckCard(deckCard) {
  if (!deckCard) return null;
  const set = deckCard.setID;
  const num = String(deckCard.cardID || '');
  if (!set || !num) return null;
  return `${IMG_BASE}/${set}/${encodeURIComponent(num)}.jpg`;
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
//
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

  // Deck name column (without the duplicated author prefix).
  row.appendChild(el('span', { class: 'deck-name' }, [
    document.createTextNode(shortName),
    archetype && !shortName.includes(archetype) ? el('span', { class: 'deck-archetype', text: archetype }) : null,
  ]));

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

  // Hover popup with the full decklist. Anchored to the row so it follows
  // a consistent edge regardless of which child the cursor entered.
  row.addEventListener('mouseenter', () => showDecklistPopup(entry, row));
  row.addEventListener('mouseleave', hideDecklistPopup);

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
    const side = c.sideCount || 0;
    const inDeck = main + side;
    if (inDeck === 0) continue;
    const total = usage.get(ref) || 0;
    if (main >= 2 && main <= 4 && !isLandType(c.type)) {
      const cur = buckets.get(main);
      if (!cur || total < cur.total) buckets.set(main, { ref, total });
    }
    if (!bestRarest
        || total < bestRarest.total
        || (total === bestRarest.total && inDeck > bestRarest.copies)) {
      bestRarest = { ref, total, copies: inDeck };
    }
  }
  const bestFour = buckets.get(4) || buckets.get(3) || buckets.get(2) || null;
  // Make sure the two badges don't collide. If bestRarest === bestFour,
  // pick the next-best rarest distinct ref.
  if (bestFour && bestRarest && bestFour.ref === bestRarest.ref) {
    let alt = null;
    for (const [ref, c] of Object.entries(deck.cards || {})) {
      if (ref === bestFour.ref) continue;
      const main = c.mainCount || 0, side = c.sideCount || 0;
      const inDeck = main + side;
      if (inDeck === 0) continue;
      const total = usage.get(ref) || 0;
      if (!alt
          || total < alt.total
          || (total === alt.total && inDeck > alt.copies)) {
        alt = { ref, total, copies: inDeck };
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
  // Source link points at the deck's lackeybot statdex URL — this is the
  // same upstream endpoint that scripts/update_league.py fetches, so it's
  // guaranteed to land on the deck the bundle was sourced from.
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
  if (d.player) meta.appendChild(el('span', { text: 'Player #' + String(d.player).slice(-5),
    title: 'Discord ID: ' + d.player }));
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

  const url = imgUrlForDeckCard(dc);
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
  });
  slot.addEventListener('dragend', () => slot.classList.remove('dragging'));
  slot.addEventListener('mouseenter', (ev) => showCardPreview(dc, ev));
  slot.addEventListener('mousemove', moveCardPreview);
  slot.addEventListener('mouseleave', hideCardPreview);

  return slot;
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
// Card image preview (hover) — its own DOM node since the deckbuilder's
// #card-preview isn't on this page.

const previewEl = () => document.getElementById('league-card-preview');
const previewImg = () => document.getElementById('league-card-preview-img');

function showCardPreview(deckCard, ev) {
  const url = imgUrlForDeckCard(deckCard);
  if (!url) return;
  previewImg().src = url;
  previewEl().classList.add('show');
  moveCardPreview(ev);
}
function moveCardPreview(ev) {
  const node = previewEl();
  if (!node.classList.contains('show')) return;
  const margin = 16;
  const w = 240, h = 336;
  let x = ev.clientX + margin, y = ev.clientY + margin;
  if (x + w > window.innerWidth) x = ev.clientX - w - margin;
  if (y + h > window.innerHeight) y = window.innerHeight - h - margin;
  if (y < 4) y = 4;
  node.style.left = x + 'px';
  node.style.top = y + 'px';
}
function hideCardPreview() {
  previewEl().classList.remove('show');
}

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

// Build the deck's URL on lackeybot.com. Mirrors the path that
// scripts/update_league.py fetches for each deck.
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
  let bundle;
  try {
    const url = BUNDLE_PATH + (force ? `?v=${Date.now()}` : '');
    const r = await fetch(url, { cache: force ? 'no-cache' : 'default' });
    if (!r.ok) throw new Error(`bundle fetch ${r.status}`);
    bundle = await r.json();
  } catch (e) {
    setStatus('League bundle fetch failed: ' + e.message
      + ' — has the league-update workflow run yet?', true);
    return;
  }
  const decks = Array.isArray(bundle && bundle.decks) ? bundle.decks : [];
  STATE.decks = decks.map(d => {
    const an = authorAndShortName(d);
    return { id: d.id, parsed: d, colors: [],
             author: an.author, shortName: an.shortName, idCards: {} };
  });
  STATE.byId = new Map(STATE.decks.map(e => [e.id, e]));

  // Build (or load) the league-wide card usage map. The action-side
  // bundle may embed a `cardUsage` object as a precomputed cache; we
  // prefer that when present, otherwise compute it client-side from the
  // same data — semantically identical.
  if (bundle && bundle.cardUsage && typeof bundle.cardUsage === 'object') {
    STATE.cardUsage = new Map(Object.entries(bundle.cardUsage));
  } else {
    STATE.cardUsage = buildCardUsage(decks);
  }
  rebuildAllIdentifyingCards();

  renderListIfList();

  try { await ensureCards(); }
  catch (_) { /* color analysis is skipped if cards.json fails */ }
  for (const entry of STATE.decks) {
    if (entry.parsed) entry.colors = computeDeckColors(entry.parsed);
  }
  renderListIfList();

  const stamp = bundle && bundle.fetchedAt
    ? ' · synced ' + new Date(bundle.fetchedAt).toLocaleString()
    : '';
  setStatus(`${decks.length} deck${decks.length === 1 ? '' : 's'} loaded${stamp}`);
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

function wireUI() {
  document.getElementById('league-tourney').textContent = '· ' + TOURNEY;
  document.title = 'League: ' + TOURNEY;

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
