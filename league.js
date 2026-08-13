
(() => {
'use strict';


const SEASON_FLOOR_YEAR = 2026;
const SEASON_FLOOR_MONTH = 1;
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
  if (!p || p.month < 1 || p.month > 12) return slug;
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
function currentSeasonSlug() {
  const now = new Date();
  return seasonSlug(now.getUTCFullYear(), now.getUTCMonth() + 1);
}
function listSeasons() {
  const now = new Date();
  const out = [];
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  while (y > SEASON_FLOOR_YEAR || (y === SEASON_FLOOR_YEAR && m >= SEASON_FLOOR_MONTH)) {
    out.push(seasonSlug(y, m));
    if (--m === 0) { m = 12; y -= 1; }
  }
  return out;
}

function getTourney() {
  const m = /[#&?]t=([\w-]+)/.exec(location.hash || '');
  return (m && m[1]) || currentSeasonSlug();
}
const TOURNEY = getTourney();

const API_URL = 'https://lackeybot.com/statdex/api';

const CACHE_KEY = 'rev-deckbuilder-league-cache:v3:' + TOURNEY;
const CACHE_TTL_MS = 30 * 60 * 1000;

const FETCH_CONCURRENCY = 6;

const SAVED_DECK_PREFIX = 'rev-deckbuilder-savedeck:';

const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';

const PILE_OFFSET_Y = 30;


const STATE = {
  decks: [],
  byId: new Map(),
  cards: null,
  cardsLoading: null,
  view: 'list',
  loaded: false,
  detailId: null,
  detailZones: null,
  focusedZone: 'main',
  filterText: '',
  uidCounter: 0,
  sortChain: ['wins'],
  cardUsage: new Map(),
  players: new Map(),
};
function newUid() { return ++STATE.uidCounter; }


async function ensureCards() {
  if (STATE.cards) return STATE.cards;
  if (STATE.cardsLoading) return STATE.cardsLoading;
  STATE.cardsLoading = (async () => {
    const r = await fetch('cards.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('cards.json fetch failed');
    const data = await r.json();
    const bySetNum = new Map();
    const byCanonical = new Map();
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


function deckRecord(deck) {
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

function refNameToDeckbuilderName(refName) {
  if (!refName) return refName;
  const slash = refName.indexOf('//');
  if (slash < 0) return refName;
  const front = refName.slice(0, slash).replace(/\s+$/, '');
  const back  = refName.slice(slash + 2).replace(/^\s+/, '');
  const m = /_([A-Za-z0-9]+)$/.exec(back);
  return m ? `${front}_${m[1]}` : front;
}

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
    if (ch === '-') {
      const prev = i === 0 ? null : q[i - 1];
      const next = i + 1 < n ? q[i + 1] : null;
      if ((prev === null || /\s|\(/.test(prev)) && next !== null && !/\s|\)/.test(next)) {
        out.push({ type: 'not' });
        i++;
        continue;
      }
    }
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
    if (t.type === 'and') { cur.i++; }
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
    let msg;
    if (STATE.decks.length) msg = 'No decks match.';
    else if (STATE.loaded) msg = 'No decks in this league yet.';
    else msg = 'Loading league index…';
    host.appendChild(el('div', { class: 'league-empty', text: msg }));
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

const SORT_KEYS = {
  wins: (e) => -((deckRecord(e.parsed).wins) || 0),
  color: (e) => colorSortKey(e.colors || []),
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

const COLOR_ORDER_INDEX = (() => {
  const idx = Object.create(null);
  MANA_COLORS.forEach((c, i) => { idx[c] = i; });
  return idx;
})();
function colorSortKey(colors) {
  if (!colors.length) return '9';
  const sorted = [...colors].sort(
    (a, b) => COLOR_ORDER_INDEX[a] - COLOR_ORDER_INDEX[b]);
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

  const nameCell = el('span', { class: 'deck-name' }, [
    document.createTextNode(shortName),
    archetype && !shortName.includes(archetype) ? el('span', { class: 'deck-archetype', text: archetype }) : null,
  ]);
  nameCell.addEventListener('mouseenter', () => showDecklistPopup(entry, nameCell));
  nameCell.addEventListener('mouseleave', hideDecklistPopup);
  row.appendChild(nameCell);

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
  const labels = ['4-of', 'rarest'];
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
    node.addEventListener('mouseenter', (ev) => { ev.stopPropagation(); showCardPreview(dc, ev); });
    node.addEventListener('mousemove', moveCardPreview);
    node.addEventListener('mouseleave', hideCardPreview);
    wrap.appendChild(node);
  });
  return wrap;
}


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
  const buckets = new Map();
  let bestRarest = null;
  for (const [ref, c] of Object.entries(deck.cards || {})) {
    const main = c.mainCount || 0;
    if (main === 0) continue;
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
  const margin = 8;
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

function compareRefsForPiles(a, b, deckCards) {
  const ca = deckCards[a] || {}, cb = deckCards[b] || {};
  const ra = typeRank(ca.type), rb = typeRank(cb.type);
  if (ra !== rb) return ra - rb;
  return (ca.fullName || a).localeCompare(cb.fullName || b);
}

function isLeaguePlaysetPile(pile, ref) {
  return pile.length === 4 && pile.every(x => x.ref === ref);
}

function placeInstance(piles, inst, ref, deckCards) {
  for (let i = 0; i < piles.length; i++) {
    const p = piles[i];
    if (p.length === 0) continue;
    if (isLeaguePlaysetPile(p, ref)) continue;
    if (p.some(x => x.ref === ref)) {
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

  document.getElementById('league-detail-name').textContent = d.name || '(untitled)';
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

  for (const zone of ['main', 'side']) renderZoneSidebar(zone);
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

  const rows = [...counts.entries()].map(([ref, count]) => {
    const dc = deckCards[ref] || {};
    return { ref, count, deckCard: dc, mtgCard: lookupCard(dc) };
  });
  rows.sort((a, b) => {
    const ra = typeRank(a.deckCard.type), rb = typeRank(b.deckCard.type);
    if (ra !== rb) return ra - rb;
    return (a.deckCard.fullName || '').localeCompare(b.deckCard.fullName || '');
  });
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
  slot.dataset.title = titleParts.join('\n');

  slot.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/league-card', JSON.stringify({
      uids: [inst.uid],
      zone: STATE.focusedZone,
    }));
    ev.dataTransfer.setData('text/league-zone', STATE.focusedZone);
    slot.classList.add('dragging');
    startLeagueDragGhost(ev, dc, !!inst.flipped,
      slot.offsetWidth, slot.offsetHeight,
      slot.offsetWidth / 2, 30);
    hideCardPreview();
  });
  slot.addEventListener('dragend', () => {
    slot.classList.remove('dragging');
    endLeagueDragGhost();
  });
  slot.addEventListener('mouseenter', (ev) => showCardPreview(dc, ev, !!inst.flipped, slot));
  slot.addEventListener('mousemove', moveCardPreview);
  slot.addEventListener('mouseleave', hideCardPreview);

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


const previewEl = () => document.getElementById('league-card-preview');
const previewImg = () => document.getElementById('league-card-preview-img');

const PREVIEW_DELAY_MS = 250;
let _leaguePreviewTimer = null;
let _leaguePreviewAvoidEl = null;

function showCardPreview(deckCard, ev, isFlipped, avoidEl) {
  if (_leaguePreviewTimer) clearTimeout(_leaguePreviewTimer);
  _leaguePreviewAvoidEl = avoidEl || null;
  const startEv = { clientX: ev.clientX, clientY: ev.clientY };
  const face = (isDoubleface(deckCard) && isFlipped) ? 'back' : 'front';
  const url = imgUrlForDeckCard(deckCard, face);
  if (!url) return;
  const run = () => {
    _leaguePreviewTimer = null;
    const node = previewEl();
    const img = previewImg();
    img.alt = deckCard.fullName || '';
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
function moveCardPreview(ev) {
  if (_leaguePreviewAvoidEl) return;
  positionCardPreview(ev);
}
function hideCardPreview() {
  if (_leaguePreviewTimer) { clearTimeout(_leaguePreviewTimer); _leaguePreviewTimer = null; }
  previewEl().classList.remove('show');
}


const LEAGUE_EMPTY_DRAG_IMG = new Image();
LEAGUE_EMPTY_DRAG_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
LEAGUE_EMPTY_DRAG_IMG.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:-1;';
document.documentElement.appendChild(LEAGUE_EMPTY_DRAG_IMG);

let _leagueDragGhost = null;

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
document.addEventListener('dragover', (ev) => {
  if (_leagueDragGhost) {
    _leagueDragGhost.el.style.left = (ev.clientX - _leagueDragGhost.offsetX) + 'px';
    _leagueDragGhost.el.style.top = (ev.clientY - _leagueDragGhost.offsetY) + 'px';
  }
});


function copyDeckToDeckbuilder(entry) {
  const d = entry.parsed;
  const zones = { main: [], sanctum: [], side: [], maybe: [] };
  const mainPile = [];
  const sidePile = [];
  for (const e of Object.values(d.cards || {})) {
    for (let i = 0; i < (e.mainCount || 0); i++) mainPile.push(deckbuilderCardName(e));
    for (let i = 0; i < (e.sideCount || 0); i++) sidePile.push(deckbuilderCardName(e));
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
  } catch (e) {
    toast('Copy failed: ' + e.message);
    return;
  }
  offerOpenInDeckbuilder(baseName, payload.folder);
}

function offerOpenInDeckbuilder(deckName, folder) {
  if (confirm('Copied "' + deckName + '" to the deckbuilder. Open it there now?')) {
    location.href = 'index.html#open=' + encodeURIComponent(deckName);
  } else {
    toast('Saved "' + deckName + '" to deckbuilder in folder "' + folder + '"');
  }
}

function lackeybotDeckUrl(deckId) {
  if (!deckId || typeof deckId !== 'string' || deckId.indexOf('/') < 0) return null;
  return `https://lackeybot.com/rev/statdex/d/${TOURNEY}/${deckId}`;
}

function deckbuilderCardName(deckCard) {
  const c = lookupCard(deckCard);
  if (c && c.name) {
    const i = c.name.indexOf(' // ');
    return i >= 0 ? c.name.slice(0, i) : c.name;
  }
  return refNameToDeckbuilderName(deckCard.refName);
}

function buildClipboardText(deck) {
  const sections = [];
  for (const zone of ['main', 'side']) {
    const counts = new Map();
    for (const c of Object.values(deck.cards || {})) {
      const n = zone === 'main' ? c.mainCount : c.sideCount;
      if (!n) continue;
      const name = deckbuilderCardName(c);
      counts.set(name, (counts.get(name) || 0) + n);
    }
    const lines = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, n]) => `${n} ${name}`);
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
  const zones = { main: [], sanctum: [], side: [], maybe: [] };
  for (const z of ['main', 'side']) {
    for (const pile of STATE.detailZones[z].piles) {
      const names = pile.map(inst => {
        const dc = entry.parsed && entry.parsed.cards && entry.parsed.cards[inst.ref];
        return dc ? deckbuilderCardName(dc) : refNameToDeckbuilderName(inst.ref);
      });
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
  } catch (e) {
    toast('Copy failed: ' + e.message);
    return;
  }
  offerOpenInDeckbuilder(baseName, payload.folder);
}

function makeUniqueDeckbuilderName(base) {
  const exists = (n) => localStorage.getItem(SAVED_DECK_PREFIX + n) != null;
  if (!exists(base)) return base;
  let n = 2;
  let cand = `${base} (${n})`;
  while (exists(cand)) { n++; cand = `${base} (${n})`; }
  return cand;
}


async function loadAll(force) {
  setStatus('Loading league…');

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

  try { await ensureCards(); }
  catch (_) {   }
  for (const entry of STATE.decks) {
    if (entry.parsed) entry.colors = computeDeckColors(entry.parsed);
  }
  renderListIfList();

  const stamp = bundle.fetchedAt
    ? ' · synced ' + new Date(bundle.fetchedAt).toLocaleString()
    : '';
  const missing = Array.isArray(bundle.missingDeckIds) ? bundle.missingDeckIds.length : 0;
  const total = bundle.decks.length + missing;
  const gap = missing
    ? ` · ${missing} of ${total} could not be loaded`
    : '';
  setStatus(`${bundle.decks.length} deck${bundle.decks.length === 1 ? '' : 's'} loaded${gap}${stamp}`);
}

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
    err.status = r.status;
    throw err;
  }
  return r.json();
}

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
  STATE.loaded = true;
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
  }
}

function renderListIfList() {
  if (STATE.view === 'list') renderList();
}

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
  if (chain.length > Object.keys(SORT_LABELS).length) {
    chain.length = Object.keys(SORT_LABELS).length;
  }
}

function wireSeasonDropdown() {
  const btn = document.getElementById('league-season-btn');
  const menu = document.getElementById('league-season-menu');
  if (!btn || !menu) return;

  const seasons = listSeasons();
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
