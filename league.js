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
  decks: [],              // [{ id, parsed, colors, error? }]
  byId: new Map(),        // id -> entry
  cards: null,            // card index, or null until loaded
  cardsLoading: null,     // Promise while loading
  view: 'list',           // 'list' | 'detail'
  detailId: null,         // currently open deck id
  detailZones: null,      // working pile state for detail view
  focusedZone: 'main',    // which zone the right pane shows
  filterText: '',
  uidCounter: 0,
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

// Map lackeybot refName ("Forest_VLR", "Root Fossil//Reborn Lily_CCR") to the
// deckbuilder's byName key ("Forest_VLR", "Root Fossil // Reborn Lily_CCR").
function refNameToDeckbuilderName(refName) {
  if (!refName) return refName;
  return refName.replace(/\s*\/\/\s*/, ' // ');
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
    return el('span', { class: 'league-pips colorless' }, [
      el('span', { class: 'pip pip-C', title: 'Colorless / no required colors', text: 'C' }),
    ]);
  }
  return el('span', { class: 'league-pips' },
    colors.map(c => el('span', { class: 'pip pip-' + c, title: colorName(c), text: c })));
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

function entryMatchesFilter(entry, filter) {
  if (!filter) return true;
  const d = entry.parsed;
  if (!d) return false;
  const haystack = [
    d.name || '',
    d.player || '',
    deckArchetype(d) || '',
    (entry.colors || []).join(''),
    (entry.colors || []).map(colorName).join(' '),
  ].join(' ').toLowerCase();
  for (const term of filter.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (!haystack.includes(term)) return false;
  }
  return true;
}

function renderList() {
  const host = document.getElementById('league-list');
  host.innerHTML = '';
  const filter = STATE.filterText.trim();
  const entries = STATE.decks
    .filter(e => e.parsed)
    .filter(e => entryMatchesFilter(e, filter));
  if (!entries.length) {
    host.appendChild(el('div', { class: 'league-empty', text: STATE.decks.length
      ? 'No decks match.'
      : 'Loading league index…' }));
    return;
  }
  entries.sort((a, b) => {
    const ar = deckRecord(a.parsed), br = deckRecord(b.parsed);
    const aPct = ar.pct == null ? -1 : ar.pct;
    const bPct = br.pct == null ? -1 : br.pct;
    if (aPct !== bPct) return bPct - aPct;
    if (ar.wins !== br.wins) return br.wins - ar.wins;
    return (a.parsed.name || '').localeCompare(b.parsed.name || '');
  });

  for (const entry of entries) host.appendChild(buildDeckRow(entry));
}

function buildDeckRow(entry) {
  const d = entry.parsed;
  const rec = deckRecord(d);
  const counts = totalCardCounts(d);
  const archetype = deckArchetype(d);

  const row = el('div', {
    class: 'league-deck-row',
    onclick: () => openDetail(entry.id),
  });
  row.appendChild(el('span', { class: 'deck-name' }, [
    document.createTextNode(d.name || '(untitled)'),
    archetype ? el('span', { class: 'deck-archetype', text: archetype }) : null,
  ]));
  const playerLabel = d.player ? '#' + String(d.player).slice(-5) : '';
  row.appendChild(el('span', { class: 'deck-player', text: playerLabel,
    title: d.player ? ('Player ID: ' + d.player) : '' }));

  const recBox = el('span', { class: 'league-record' });
  if (rec.played > 0) {
    recBox.appendChild(el('span', { class: 'pct ' + pctClass(rec.pct), text: rec.pct + '%' }));
    recBox.appendChild(el('span', { class: 'raw',
      text: rec.draws > 0 ? `${rec.wins}-${rec.losses}-${rec.draws}` : `${rec.wins}-${rec.losses}` }));
  } else {
    recBox.appendChild(el('span', { class: 'raw', text: '—' }));
  }
  row.appendChild(recBox);

  row.appendChild(pipsRow(entry.colors));

  row.appendChild(el('span', {
    class: 'league-cardcount',
    text: counts.side ? `${counts.main}/${counts.side}` : `${counts.main}`,
    title: 'Main' + (counts.side ? ' / Sideboard' : '') + ' card count',
  }));

  const copyBtn = el('button', {
    class: 'league-copy-btn',
    text: 'Copy',
    title: 'Save a copy of this deck to local storage',
    onclick: (ev) => { ev.stopPropagation(); copyDeckToDeckbuilder(entry); },
  });
  row.appendChild(copyBtn);

  return row;
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

// Build the working pile state for a freshly-opened deck. lackeybot data
// has no pile structure, so we lay out one pile per primary type — the
// same default the deckbuilder produces when you load a deck without
// saved pile arrangement.
function buildInitialZones(deck) {
  function expand(area, getCount) {
    const groups = new Map();
    const refs = Object.keys(deck.cards || {});
    refs.sort((a, b) => {
      const ea = deck.cards[a], eb = deck.cards[b];
      const ra = typeRank(ea.type), rb = typeRank(eb.type);
      if (ra !== rb) return ra - rb;
      return (ea.fullName || '').localeCompare(eb.fullName || '');
    });
    for (const ref of refs) {
      const e = deck.cards[ref];
      const n = getCount(e);
      if (!n) continue;
      const t = primaryType(e.type || '');
      if (!groups.has(t)) groups.set(t, []);
      const arr = groups.get(t);
      for (let i = 0; i < n; i++) arr.push({ uid: newUid(), ref });
    }
    const piles = [];
    for (const t of [...TYPE_ORDER, 'Other']) {
      if (groups.has(t)) piles.push(groups.get(t));
    }
    return piles;
  }
  return {
    main: { piles: expand('main', (e) => e.mainCount || 0) },
    side: { piles: expand('side', (e) => e.sideCount || 0) },
  };
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
  renderDetail();
  window.scrollTo(0, 0);
}

function closeDetail() {
  STATE.view = 'list';
  STATE.detailId = null;
  STATE.detailZones = null;
  document.getElementById('league-list-view').classList.remove('hidden');
  document.getElementById('league-detail-view').classList.add('hidden');
}

function renderDetail() {
  const entry = STATE.byId.get(STATE.detailId);
  if (!entry || !entry.parsed) return;
  const d = entry.parsed;

  // Header
  document.getElementById('league-detail-name').textContent = d.name || '(untitled)';
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
  STATE.decks = decks.map(d => ({ id: d.id, parsed: d, colors: [] }));
  STATE.byId = new Map(STATE.decks.map(e => [e.id, e]));
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
