// Revolution Deckbuilder — single-page JS app
// All card data is loaded once by querying cards.db in the browser via sql.js;
// everything else (search, pile layout, drag/drop, .cod import/export) runs
// in the browser too. No backend required.

'use strict';

// Card images live in the cajunwritescode/Revolution repo. We hit raw.git
// directly so the SPA can run from any static host (e.g. GitHub Pages).
const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';

// Upstream JSON snapshot the "Refresh data" button pulls from. mtgjson-style
// shape: { meta: {}, data: { SETCODE: { name, code, releaseDate, cards: [...] } } }
const REFRESH_URL = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/AllSetsEternal.json';

// localStorage key for the refreshed snapshot. Once the user has refreshed,
// subsequent loads use this and skip the bundled cards.db (and the sql.js
// wasm) entirely.
const STORAGE_KEY = 'rev-deckbuilder-cards-v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE = {
  cards: [],            // full card list, built from cards.db via sql.js
  byId: new Map(),      // id -> card
  byName: new Map(),    // name -> card
  uuidMap: {},          // uuid -> { cardId, set, num }
  setCodes: new Set(),  // every set code (used for canonical-name stripping at parse time)

  // Each zone holds an ordered list of piles, each pile is an array of card-instance objects.
  // A card instance is { uid, cardId } — uid is unique per copy.
  zones: {
    main:  { piles: [] },
    side:  { piles: [] },
    maybe: { piles: [] },
  },

  focusedZone: 'main',  // which zone the right-hand pile pane shows
  format: 'standard',   // 'standard' (fmt_revolution=legal) or 'eternal' (fmt_eternal=legal)
  listSort: 'type',     // how the text deck list is sorted
  pileSort: 'type',     // how the pile pane is sorted (until manually edited)

  search: {
    results: [],
    selectedIdx: 0,
  },

  uidCounter: 1,        // monotonic id for card instances
  dragging: null,       // { uids: [uid, ...] }
  selection: new Set(), // selected card-instance uids (multi-select via Shift/Ctrl/Cmd-click)
};

const TYPE_ORDER = {
  'Land': 0,
  'Planeswalker': 1,
  'Creature': 2,
  'Battle': 3,
  'Enchantment': 4,
  'Artifact': 5,
  'Instant': 6,
  'Sorcery': 7,
  'Plane': 8,
};

const ZONE_LABELS = { main: 'Main', side: 'Sideboard', maybe: 'Maybeboard' };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function init() {
  let data = null;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) data = JSON.parse(cached);
  } catch (e) {
    console.warn('Could not read cached card data:', e);
  }
  if (!data) {
    data = await loadCardsFromDb();
  }
  applyCardData(data);

  wireSearch();
  wireZones();
  wireToolbar();
  wirePileSort();
  wireListSort();
  wirePreviewHover();
  wireSelectionClear();
  wireRegionSelect();
  setFocusedZone('main');
  document.getElementById('search').focus();
})().catch(err => {
  document.body.innerHTML = '<pre style="color:#f88;padding:20px">' + (err.stack || err) + '</pre>';
});

// Swap STATE over to a fresh card index. Re-maps any existing zone-instance
// card ids by card name so the user's deck-in-progress survives a refresh
// (the underlying integer ids are reassigned by parseAllSetsJson, so we
// can't trust the old numbers).
function applyCardData(data) {
  const oldById = STATE.byId;
  const newById = new Map();
  const newByName = new Map();
  for (const c of data.cards) {
    newById.set(c.id, c);
    newByName.set(c.name, c);
  }
  // Re-map every existing instance.cardId via name. Drop instances whose
  // card has disappeared from the new data entirely. Try several name forms
  // to survive the inconsistency between bundled and refreshed naming of
  // split / double-faced cards (some sources use "Front // Back", some use
  // just "Front").
  function findReplacement(oldCard) {
    if (!oldCard) return null;
    let n = newByName.get(oldCard.name);
    if (n) return n;
    const splitIdx = oldCard.name.indexOf(' // ');
    if (splitIdx >= 0) {
      n = newByName.get(oldCard.name.slice(0, splitIdx));
      if (n) return n;
    }
    for (const c of data.cards) {
      if (c.canonical === oldCard.canonical) return c;
    }
    const oldCanonFront = oldCard.canonical.split(' // ')[0];
    if (oldCanonFront !== oldCard.canonical) {
      for (const c of data.cards) {
        if (c.canonical === oldCanonFront) return c;
      }
    }
    return null;
  }
  for (const zname of Object.keys(STATE.zones)) {
    const zone = STATE.zones[zname];
    for (const pile of zone.piles) {
      for (let i = pile.length - 1; i >= 0; i--) {
        const oldCard = oldById && oldById.get(pile[i].cardId);
        const newCard = findReplacement(oldCard);
        if (newCard) pile[i].cardId = newCard.id;
        else pile.splice(i, 1);
      }
    }
    zone.piles = zone.piles.filter(p => p.length > 0);
  }
  STATE.cards = data.cards;
  STATE.uuidMap = data.uuidMap || {};
  STATE.byId = newById;
  STATE.byName = newByName;
  STATE.setCodes = new Set(Object.keys(data.sets || {}));
  STATE.selection.clear();
  const searchInput = document.getElementById('search');
  if (searchInput) runSearch(searchInput.value);
  renderAll();
}

// ---------------------------------------------------------------------------
// JSON ingestion (refresh from upstream)
// ---------------------------------------------------------------------------

// Translate the upstream mtgjson-style AllSetsEternal.json into the same
// {cards, sets, uuidMap} shape that loadCardsFromDb() returns. The translation
// mirrors carddb.py's logic: drop the TK token set, drop back faces of
// double-faced cards, store legalities lowercased, store manacost without
// braces, sort cards by name, assign monotonic ids.
function parseAllSetsJson(json) {
  const setsObj = (json && json.data) || {};

  const sets = {};
  for (const code of Object.keys(setsObj)) {
    if (code === 'TK') continue;
    const s = setsObj[code] || {};
    sets[code] = {
      code,
      longname: s.name || '',
      releasedate: s.releaseDate || '',
    };
  }
  const setCodes = new Set(Object.keys(sets));

  function canonicalize(name) {
    while (name.includes('_')) {
      const i = name.lastIndexOf('_');
      const tail = name.slice(i + 1);
      if (setCodes.has(tail)) name = name.slice(0, i);
      else break;
    }
    return name;
  }

  const cards = [];
  const uuidMap = {};
  let nextId = 1;

  for (const code of Object.keys(setsObj)) {
    if (code === 'TK') continue;
    const setObj = setsObj[code] || {};
    const cardList = setObj.cards || [];
    for (const c of cardList) {
      // Skip back faces of double-faced cards (mtgjson uses side: "a"|"b").
      const side = (c.side || '').toLowerCase();
      if (side === 'b' || side === 'back') continue;

      const id = nextId++;
      // Double-faced / split / adventure cards have a combined "Front // Back"
      // name on every face. Match the bundled format: keep just the front
      // half of the name, and stash the back-half(s) in `related`.
      const rawName = c.name || '';
      const splitIdx = rawName.indexOf(' // ');
      const name = splitIdx >= 0 ? rawName.slice(0, splitIdx) : rawName;
      const splitRelated = splitIdx >= 0 ? rawName.slice(splitIdx + 4) : '';
      const num = c.number != null ? String(c.number) : '';
      const cmcVal = c.manaValue != null ? c.manaValue
                     : (c.convertedManaCost != null ? c.convertedManaCost : 0);
      const card = {
        id,
        name,
        canonical: canonicalize(name),
        text: c.text || '',
        type: c.type || '',
        maintype: (c.types && c.types[0]) || '',
        cmc: cmcVal,
        manacost: (c.manaCost || '').replace(/[{}]/g, ''),
        colors: (c.colors || []).join(''),
        ci: (c.colorIdentity || []).join(''),
        power: c.power != null ? String(c.power) : '',
        toughness: c.toughness != null ? String(c.toughness) : '',
        layout: c.layout || 'normal',
        set: code,
        num,
        rarity: c.rarity || '',
        fmt_rev: ((c.legalities && c.legalities.revolution) || '').toLowerCase(),
        fmt_eternal: ((c.legalities && c.legalities.eternal) || '').toLowerCase(),
        related: splitRelated
                   || ((c.relatedCards && Array.isArray(c.relatedCards.spellbook))
                         ? c.relatedCards.spellbook.join('; ')
                         : ''),
      };
      cards.push(card);
      if (c.uuid) uuidMap[c.uuid] = { cardId: id, set: code, num };
    }
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { cards, sets, uuidMap };
}

async function refreshFromUpstream() {
  const res = await fetch(REFRESH_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching AllSetsEternal.json`);
  const json = await res.json();
  const data = parseAllSetsJson(json);
  applyCardData(data);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Could not persist refreshed card data:', e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newUid() { return STATE.uidCounter++; }

function canonicalName(name) {
  // Strip trailing _<setcode> tokens. Mirrors the backend rule.
  while (name.includes('_')) {
    const i = name.lastIndexOf('_');
    const tail = name.slice(i + 1);
    if (STATE.setCodes.has(tail)) name = name.slice(0, i);
    else break;
  }
  return name;
}

function typeRank(card) {
  return TYPE_ORDER[card.maintype] ?? 99;
}

// CMC bucket: lands always go in their own bucket regardless of mana value.
function cmcBucket(card) {
  if (card.maintype === 'Land') return { key: 'L', label: 'Lands', sortVal: -1 };
  const n = Math.floor(card.cmc || 0);
  return { key: String(n), label: String(n), sortVal: n };
}

// Is the card legal in the currently-selected format?
function isLegal(card) {
  if (!card) return true;
  if (STATE.format === 'eternal') return card.fmt_eternal === 'legal';
  return card.fmt_rev === 'legal';
}

function compareCards(a, b, mode) {
  const ca = STATE.byId.get(a.cardId);
  const cb = STATE.byId.get(b.cardId);
  if (!ca || !cb) return 0;
  if (mode === 'cmc') {
    const ba = cmcBucket(ca).sortVal;
    const bb = cmcBucket(cb).sortVal;
    if (ba !== bb) return ba - bb;
    if (typeRank(ca) !== typeRank(cb)) return typeRank(ca) - typeRank(cb);
    return ca.canonical.localeCompare(cb.canonical);
  }
  // 'type'
  if (typeRank(ca) !== typeRank(cb)) return typeRank(ca) - typeRank(cb);
  if (ca.cmc !== cb.cmc) return ca.cmc - cb.cmc;
  return ca.canonical.localeCompare(cb.canonical);
}

function imgUrl(card) {
  return `${IMG_BASE}/${card.set}/${encodeURIComponent(card.num)}.jpg`;
}

// ---------------------------------------------------------------------------
// Card-index loader (sql.js)
// ---------------------------------------------------------------------------

// Reads cards.db in the browser and returns the same {cards, sets, uuidMap}
// shape that the old Python backend's /api/cards.json used to return. The
// queries here mirror server.py's load_cards().
async function loadCardsFromDb() {
  const [SQL, dbBuf] = await Promise.all([
    initSqlJs({ locateFile: f => `vendor/${f}` }),
    fetch('cards.db').then(r => {
      if (!r.ok) throw new Error('failed to load cards.db');
      return r.arrayBuffer();
    }),
  ]);
  const db = new SQL.Database(new Uint8Array(dbBuf));

  // Sets.
  const sets = {};
  const setCodes = new Set();
  const setRows = db.exec('SELECT code, longname, releasedate FROM sets');
  if (setRows.length) {
    for (const row of setRows[0].values) {
      const [code, longname, releasedate] = row;
      sets[code] = { code, longname, releasedate };
      setCodes.add(code);
    }
  }

  // Strip trailing _<setcode> tokens repeatedly. Mirrors server.py canonical().
  function canonical(name) {
    while (name.includes('_')) {
      const i = name.lastIndexOf('_');
      const tail = name.slice(i + 1);
      if (setCodes.has(tail)) name = name.slice(0, i);
      else break;
    }
    return name;
  }

  // Cards. Same WHERE clause as the backend: front faces only, drop tokens.
  const cards = [];
  const cardRows = db.exec(`
    SELECT id, name, text, type, maintype, cmc, manacost, colors, coloridentity,
           power, toughness, layout, side, set_code, set_num, rarity,
           fmt_revolution, fmt_eternal, related
    FROM cards
    WHERE (side = 'front' OR side = '' OR side IS NULL)
      AND set_code != 'TK'
    ORDER BY name
  `);
  if (cardRows.length) {
    for (const row of cardRows[0].values) {
      const [id, name, text, type_, maintype, cmc, manacost, colors, coloridentity,
             power, toughness, layout, _side, set_code, set_num, rarity,
             fmt_rev, fmt_eternal, related] = row;
      cards.push({
        id,
        name,
        canonical: canonical(name),
        text: text || '',
        type: type_ || '',
        maintype: maintype || '',
        cmc: cmc != null ? cmc : 0,
        manacost: manacost || '',
        colors: colors || '',
        ci: coloridentity || '',
        power: power || '',
        toughness: toughness || '',
        layout: layout || 'normal',
        set: set_code,
        num: set_num,
        rarity: rarity || '',
        fmt_rev: fmt_rev || '',
        fmt_eternal: fmt_eternal || '',
        related: related || '',
      });
    }
  }

  // uuid -> printing, for resolving .cod imports.
  const uuidMap = {};
  const uuidRows = db.exec('SELECT card_id, set_code, set_num, uuid FROM card_sets');
  if (uuidRows.length) {
    for (const row of uuidRows[0].values) {
      const [cardId, set_code, set_num, uuid] = row;
      if (uuid) uuidMap[uuid] = { cardId, set: set_code, num: set_num };
    }
  }

  db.close();
  return { cards, sets, uuidMap };
}

function colorizedMana(cost) {
  // Just colorize WUBRG letters; leave numbers/X alone.
  if (!cost) return '';
  return cost.replace(/W/g, '<span class="mana-w">W</span>')
             .replace(/U/g, '<span class="mana-u">U</span>')
             .replace(/B/g, '<span class="mana-b">B</span>')
             .replace(/R/g, '<span class="mana-r">R</span>')
             .replace(/G/g, '<span class="mana-g">G</span>');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function wireSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    runSearch(input.value);
  });

  input.addEventListener('keydown', (ev) => {
    const r = STATE.search.results;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (r.length === 0) return;
      STATE.search.selectedIdx = (STATE.search.selectedIdx + 1) % r.length;
      renderSearchResults();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (r.length === 0) return;
      STATE.search.selectedIdx = (STATE.search.selectedIdx - 1 + r.length) % r.length;
      renderSearchResults();
    } else if (ev.key === 'Tab') {
      // Tab "picks" the highlighted result into the search box for refinement.
      if (r.length === 0) return;
      ev.preventDefault();
      const c = r[STATE.search.selectedIdx];
      input.value = c.canonical;
      runSearch(input.value);
    } else if (ev.key === 'Enter') {
      if (r.length === 0) return;
      ev.preventDefault();
      const c = r[STATE.search.selectedIdx];
      const zone = ev.shiftKey ? 'maybe' : (ev.altKey ? 'side' : 'main');
      addCardToZone(c.id, zone);
      // Don't clear input — power users repeatedly add the same card by hitting Enter 4x.
      // But do refocus and reset selection.
      STATE.search.selectedIdx = 0;
      renderSearchResults();
      renderZoneList(zone);
      renderZoneCount(zone);
      if (STATE.focusedZone === zone) renderPiles();
    } else if (ev.key === 'Escape') {
      results.classList.add('hidden');
    }
  });

  input.addEventListener('focus', () => {
    if (STATE.search.results.length > 0) results.classList.remove('hidden');
  });

  document.addEventListener('click', (ev) => {
    if (!input.contains(ev.target) && !results.contains(ev.target)) {
      results.classList.add('hidden');
    }
  });
}

function runSearch(q) {
  q = q.trim().toLowerCase();
  const results = document.getElementById('search-results');
  if (q.length < 2) {
    STATE.search.results = [];
    results.classList.add('hidden');
    return;
  }
  // Match against canonical name (so typing "forest" matches Forest_OLD too)
  // and full name. Dedupe by canonical name (newest printing wins).
  const seen = new Map(); // canonical -> card
  for (const c of STATE.cards) {
    if (!isLegal(c)) continue;
    const canon = c.canonical.toLowerCase();
    if (canon.includes(q) || c.name.toLowerCase().includes(q)) {
      const existing = seen.get(c.canonical);
      // Prefer higher id (newer printing).
      if (!existing || c.id > existing.id) seen.set(c.canonical, c);
    }
  }
  const list = Array.from(seen.values());
  list.sort((a, b) => a.canonical.localeCompare(b.canonical));
  STATE.search.results = list.slice(0, 10);
  STATE.search.selectedIdx = 0;
  renderSearchResults();
}

function renderSearchResults() {
  const results = document.getElementById('search-results');
  const r = STATE.search.results;
  if (r.length === 0) {
    results.classList.add('hidden');
    results.innerHTML = '';
    return;
  }
  results.classList.remove('hidden');
  results.innerHTML = '';
  r.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'result' + (i === STATE.search.selectedIdx ? ' selected' : '');
    el.innerHTML = `
      <span class="name">${escapeHtml(card.canonical)}</span>
      <span>
        <span class="mana">${colorizedMana(card.manacost)}</span>
        <span class="meta">${escapeHtml(card.maintype || '')}</span>
      </span>`;
    el.addEventListener('mouseenter', () => {
      STATE.search.selectedIdx = i;
      renderSearchResults();
    });
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const zone = ev.shiftKey ? 'maybe' : (ev.altKey ? 'side' : 'main');
      addCardToZone(card.id, zone);
      renderZoneList(zone);
      renderZoneCount(zone);
      if (STATE.focusedZone === zone) renderPiles();
    });
    results.appendChild(el);
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Deck operations
// ---------------------------------------------------------------------------

function addCardToZone(cardId, zoneName, count = 1) {
  const zone = STATE.zones[zoneName];
  for (let i = 0; i < count; i++) {
    const inst = { uid: newUid(), cardId };
    // Find the first non-full pile of the same canonical name and append.
    const card = STATE.byId.get(cardId);
    if (!card) continue;
    let placed = false;
    for (const pile of zone.piles) {
      if (pile.length === 0) continue;
      const head = STATE.byId.get(pile[0].cardId);
      if (head && head.canonical === card.canonical && pile.length < 4) {
        pile.push(inst);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Create a new pile, but try to insert it in the right sorted spot
      // so freshly-added cards land near similar ones.
      const newPile = [inst];
      let insertIdx = zone.piles.length;
      for (let i = 0; i < zone.piles.length; i++) {
        if (zone.piles[i].length === 0) continue;
        if (compareCards(inst, zone.piles[i][0], STATE.pileSort) < 0) {
          insertIdx = i;
          break;
        }
      }
      zone.piles.splice(insertIdx, 0, newPile);
    }
  }
}

function removeInstance(uid) {
  for (const zoneName of Object.keys(STATE.zones)) {
    const zone = STATE.zones[zoneName];
    for (let p = 0; p < zone.piles.length; p++) {
      const idx = zone.piles[p].findIndex(c => c.uid === uid);
      if (idx >= 0) {
        zone.piles[p].splice(idx, 1);
        if (zone.piles[p].length === 0) zone.piles.splice(p, 1);
        return zoneName;
      }
    }
  }
  return null;
}

function findInstance(uid) {
  for (const zoneName of Object.keys(STATE.zones)) {
    const zone = STATE.zones[zoneName];
    for (let p = 0; p < zone.piles.length; p++) {
      const idx = zone.piles[p].findIndex(c => c.uid === uid);
      if (idx >= 0) return { zoneName, pileIdx: p, slotIdx: idx, inst: zone.piles[p][idx] };
    }
  }
  return null;
}

function moveInstanceToZone(uid, toZone) {
  // For drops onto a zone list (not a specific pile): use the same auto-place logic.
  const found = findInstance(uid);
  if (!found) return;
  const inst = found.inst;
  const card = STATE.byId.get(inst.cardId);
  // Remove
  STATE.zones[found.zoneName].piles[found.pileIdx].splice(found.slotIdx, 1);
  if (STATE.zones[found.zoneName].piles[found.pileIdx].length === 0) {
    STATE.zones[found.zoneName].piles.splice(found.pileIdx, 1);
  }
  // Re-add via the auto-place rule
  const zone = STATE.zones[toZone];
  let placed = false;
  for (const pile of zone.piles) {
    if (pile.length === 0) continue;
    const head = STATE.byId.get(pile[0].cardId);
    if (head && head.canonical === card.canonical && pile.length < 4) {
      pile.push(inst);
      placed = true;
      break;
    }
  }
  if (!placed) zone.piles.push([inst]);
}

// ---------------------------------------------------------------------------
// Multi-card move helpers
//
// All drop targets call into these. They take a list of uids so a single
// drag-drop can move many cards (used by the multi-select feature). Single-
// card drags pass a one-element list.
//
// Strategy: do any structural splice (e.g. inserting a new pile) FIRST while
// indices are still untouched, then detach each instance from its source pile,
// then push them into the destination pile, then prune any source piles that
// became empty. This ordering avoids stale-index bugs.
// ---------------------------------------------------------------------------

function detachInstance(uid) {
  // Pop the instance out of its source pile (in place). Empty source piles
  // are NOT removed here — call pruneEmptyPiles() once at the end.
  for (const zoneName of Object.keys(STATE.zones)) {
    const zone = STATE.zones[zoneName];
    for (let p = 0; p < zone.piles.length; p++) {
      const idx = zone.piles[p].findIndex(c => c.uid === uid);
      if (idx >= 0) {
        const inst = zone.piles[p][idx];
        zone.piles[p].splice(idx, 1);
        return inst;
      }
    }
  }
  return null;
}

function pruneEmptyPiles() {
  for (const z of Object.keys(STATE.zones)) {
    STATE.zones[z].piles = STATE.zones[z].piles.filter(p => p.length > 0);
  }
}

function moveUidsToPile(uids, destPile) {
  // destPile must already be in some zone.piles array. We push by reference,
  // so it's OK if intermediate detach()es shift indices.
  for (const uid of uids) {
    const inst = detachInstance(uid);
    if (inst) destPile.push(inst);
  }
  pruneEmptyPiles();
}

function insertNewPileWithUids(uids, zoneName, atIdx) {
  // Splice a fresh pile into the zone at atIdx (or at the end if atIdx is -1
  // or out of range), then move uids into it.
  const dstZone = STATE.zones[zoneName];
  const newPile = [];
  if (atIdx < 0 || atIdx > dstZone.piles.length) atIdx = dstZone.piles.length;
  dstZone.piles.splice(atIdx, 0, newPile);
  for (const uid of uids) {
    const inst = detachInstance(uid);
    if (inst) newPile.push(inst);
  }
  pruneEmptyPiles();
}

function moveUidsToZoneAuto(uids, zoneName) {
  // Auto-place rule: stack onto an existing pile of the same canonical name
  // (up to 4) or start a new trailing pile.
  for (const uid of uids) {
    const inst = detachInstance(uid);
    if (!inst) continue;
    const card = STATE.byId.get(inst.cardId);
    const zone = STATE.zones[zoneName];
    let placed = false;
    for (const pile of zone.piles) {
      if (pile.length === 0) continue;
      const head = STATE.byId.get(pile[0].cardId);
      if (head && card && head.canonical === card.canonical && pile.length < 4) {
        pile.push(inst);
        placed = true;
        break;
      }
    }
    if (!placed) zone.piles.push([inst]);
  }
  pruneEmptyPiles();
}

// Read the uid list a drag put on the dataTransfer. Always uses 'text/uids'
// (comma-separated). Falls back to the legacy 'text/uid' just in case.
function readUidsFromDrag(dt) {
  const raw = dt.getData('text/uids') || dt.getData('text/uid');
  if (!raw) return [];
  return raw.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
}

// Compute the uid list a dragstart should put on the dataTransfer. If the
// dragged card is part of a multi-card selection, drag the whole selection;
// otherwise just the one card (and clear the selection so it doesn't linger).
function uidsToDrag(uid) {
  if (STATE.selection.has(uid) && STATE.selection.size > 1) {
    return Array.from(STATE.selection);
  }
  STATE.selection.clear();
  return [uid];
}

function totalCount(zoneName) {
  return STATE.zones[zoneName].piles.reduce((s, p) => s + p.length, 0);
}

function resortPiles(zoneName) {
  // Flatten, sort by current pile sort, regroup into piles of 4 by canonical name.
  const zone = STATE.zones[zoneName];
  const all = zone.piles.flat();
  all.sort((a, b) => compareCards(a, b, STATE.pileSort));
  const newPiles = [];
  let curPile = null;
  let curCanon = null;
  for (const inst of all) {
    const card = STATE.byId.get(inst.cardId);
    const canon = card?.canonical;
    if (curCanon !== canon || curPile.length >= 4) {
      curPile = [];
      newPiles.push(curPile);
      curCanon = canon;
    }
    curPile.push(inst);
  }
  zone.piles = newPiles;
}

// ---------------------------------------------------------------------------
// Rendering — zone list (left)
// ---------------------------------------------------------------------------

function renderAll() {
  for (const z of Object.keys(STATE.zones)) {
    renderZoneList(z);
    renderZoneCount(z);
  }
  renderPiles();
}

function renderZoneCount(zoneName) {
  document.getElementById('count-' + zoneName).textContent = String(totalCount(zoneName));
}

function renderZoneList(zoneName) {
  const list = document.getElementById('list-' + zoneName);
  list.innerHTML = '';
  const zone = STATE.zones[zoneName];

  // Aggregate by canonical name → count
  const counts = new Map(); // canonical -> { count, cardId }
  for (const pile of zone.piles) {
    for (const inst of pile) {
      const card = STATE.byId.get(inst.cardId);
      if (!card) continue;
      const k = card.canonical;
      const ent = counts.get(k);
      if (ent) ent.count++;
      else counts.set(k, { count: 1, cardId: inst.cardId, sample: inst.uid });
    }
  }
  const rows = Array.from(counts.entries()).map(([canon, v]) => ({ canon, ...v }));

  // Pick group key + label per row based on sort mode.
  const groupOf = (row) => {
    const card = STATE.byId.get(row.cardId);
    if (STATE.listSort === 'cmc') {
      const b = cmcBucket(card);
      return { key: b.key, label: b.label, sortVal: b.sortVal };
    }
    return { key: card.maintype || '?', label: card.maintype || '?', sortVal: typeRank(card) };
  };

  // Sort rows: by group sortVal, then by inner sort, then alphabetical.
  rows.sort((a, b) => {
    const ga = groupOf(a), gb = groupOf(b);
    if (ga.sortVal !== gb.sortVal) return ga.sortVal - gb.sortVal;
    const ca = STATE.byId.get(a.cardId), cb = STATE.byId.get(b.cardId);
    if (STATE.listSort === 'cmc') {
      // Within a CMC bucket, fall back to type rank then name.
      if (typeRank(ca) !== typeRank(cb)) return typeRank(ca) - typeRank(cb);
    } else {
      // Within a type, fall back to CMC then name.
      if (ca.cmc !== cb.cmc) return ca.cmc - cb.cmc;
    }
    return a.canon.localeCompare(b.canon);
  });

  // Walk rows, emit group headers as the key changes.
  // (Pre-compute totals per group so the header shows "(N)".)
  const totals = new Map();
  for (const row of rows) {
    const k = groupOf(row).key;
    totals.set(k, (totals.get(k) || 0) + row.count);
  }
  let curKey = null;
  for (const row of rows) {
    const g = groupOf(row);
    if (g.key !== curKey) {
      curKey = g.key;
      const h = document.createElement('div');
      h.className = 'type-group-header';
      h.textContent = `${g.label} (${totals.get(g.key)})`;
      list.appendChild(h);
    }
    list.appendChild(makeRow(zoneName, row));
  }
}

function makeRow(zoneName, row) {
  const card = STATE.byId.get(row.cardId);
  const div = document.createElement('div');
  div.className = 'row' + (isLegal(card) ? '' : ' illegal');
  div.draggable = true;
  div.dataset.cardId = card.id;
  div.innerHTML = `
    <span class="qty">${row.count}</span>
    <span class="name">${escapeHtml(card.canonical)}</span>
    <span class="cmc">${escapeHtml(card.manacost || '')}</span>`;
  // Hover preview
  div.addEventListener('mouseenter', (ev) => showPreview(card, ev));
  div.addEventListener('mousemove', positionPreview);
  div.addEventListener('mouseleave', hidePreview);
  // Right-click removes one copy
  div.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    // Remove the most-recently-added matching instance in this zone
    const zone = STATE.zones[zoneName];
    for (let p = zone.piles.length - 1; p >= 0; p--) {
      const pile = zone.piles[p];
      for (let i = pile.length - 1; i >= 0; i--) {
        const inst = pile[i];
        const c = STATE.byId.get(inst.cardId);
        if (c && c.canonical === card.canonical) {
          pile.splice(i, 1);
          if (pile.length === 0) zone.piles.splice(p, 1);
          renderZoneList(zoneName);
          renderZoneCount(zoneName);
          if (STATE.focusedZone === zoneName) renderPiles();
          return;
        }
      }
    }
  });
  return div;
}

// ---------------------------------------------------------------------------
// Rendering — pile pane (right)
// ---------------------------------------------------------------------------

const PILE_OFFSET_Y = 30;   // px between stacked card images in a pile
const CARD_HEIGHT   = 181;

function renderPiles() {
  document.getElementById('pile-title').textContent =
    `${ZONE_LABELS[STATE.focusedZone]} (${totalCount(STATE.focusedZone)})`;
  const container = document.getElementById('piles');
  container.innerHTML = '';
  const zone = STATE.zones[STATE.focusedZone];

  // Bucket each pile by the head card's group key (CMC bucket or maintype).
  // Sections appear in sortVal order so even manually-rearranged piles still
  // group sensibly until the user re-sorts.
  const sectionMap = new Map();
  zone.piles.forEach((pile, pileIdx) => {
    if (pile.length === 0) return;
    const card = STATE.byId.get(pile[0].cardId);
    if (!card) return;
    let key, label, sortVal;
    if (STATE.pileSort === 'cmc') {
      const b = cmcBucket(card);
      key = b.key; label = b.label; sortVal = b.sortVal;
    } else {
      key = card.maintype || '?';
      label = card.maintype || '?';
      sortVal = typeRank(card);
    }
    let s = sectionMap.get(key);
    if (!s) { s = { key, label, sortVal, piles: [] }; sectionMap.set(key, s); }
    s.piles.push({ pile, pileIdx });
  });
  const sections = Array.from(sectionMap.values()).sort((a, b) => a.sortVal - b.sortVal);

  for (const section of sections) {
    const sectEl = document.createElement('div');
    sectEl.className = 'pile-section';
    const h = document.createElement('div');
    h.className = 'pile-section-header';
    const total = section.piles.reduce((s, p) => s + p.pile.length, 0);
    h.textContent = `${section.label} (${total})`;
    sectEl.appendChild(h);
    const pilesEl = document.createElement('div');
    pilesEl.className = 'pile-section-piles';
    section.piles.forEach((entry, i) => {
      // Insert a gap drop target before every pile (including the first), so
      // the user can drop a card to create a new pile at that exact slot.
      pilesEl.appendChild(makePileGap(entry.pileIdx));
      pilesEl.appendChild(makePileEl(entry.pile, entry.pileIdx));
    });
    sectEl.appendChild(pilesEl);
    container.appendChild(sectEl);
  }

  // Trailing "new pile" drop zone — always at the very end
  const np = document.createElement('div');
  np.className = 'new-pile';
  np.textContent = '+ new pile';
  np.addEventListener('dragover', (ev) => { ev.preventDefault(); np.classList.add('drag-over'); });
  np.addEventListener('dragleave', () => np.classList.remove('drag-over'));
  np.addEventListener('drop', (ev) => {
    ev.preventDefault();
    np.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    if (uids.length === 0) return;
    insertNewPileWithUids(uids, STATE.focusedZone, -1);
    STATE.selection.clear();
    renderAll();
  });
  container.appendChild(np);
}

// Build an inter-pile gap drop target. Dropping a card here splices a NEW pile
// into the focused zone at the given global pile index. The gap is small in
// width but expands visually while a drag is in flight (body.dragging) so
// users can see the available drop slots.
function makePileGap(insertIdx) {
  const g = document.createElement('div');
  g.className = 'pile-gap';
  g.dataset.insertIdx = String(insertIdx);
  g.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    g.classList.add('drag-over');
  });
  g.addEventListener('dragleave', () => g.classList.remove('drag-over'));
  g.addEventListener('drop', (ev) => {
    ev.preventDefault();
    g.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    if (uids.length === 0) return;
    insertNewPileWithUids(uids, STATE.focusedZone, insertIdx);
    STATE.selection.clear();
    renderAll();
  });
  return g;
}

function makeSlotButtons(inst, card) {
  // Four transparent overlay buttons on a card slot:
  //   +  add another copy to the same zone (auto-place rule)
  //   −  remove this specific copy
  //   ↔  send to sideboard, or back to main if already in sideboard
  //   ?  send to maybeboard, or back to main if already in maybeboard
  const wrap = document.createElement('div');
  wrap.className = 'slot-buttons';
  // Buttons must NOT initiate dragging — let click events through normally.
  wrap.draggable = false;

  function makeBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-btn';
    b.textContent = label;
    b.title = title;
    b.draggable = false;
    // Stop mousedown so the parent slot's drag doesn't pre-empt the click.
    b.addEventListener('mousedown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  wrap.appendChild(makeBtn('+', 'Add another copy', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    addCardToZone(card.id, found.zoneName);
    renderAll();
  }));
  wrap.appendChild(makeBtn('\u2212', 'Remove this copy', () => {
    removeInstance(inst.uid);
    renderAll();
  }));
  wrap.appendChild(makeBtn('\u2194', 'Move to/from sideboard', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    const target = (found.zoneName === 'side') ? 'main' : 'side';
    moveInstanceToZone(inst.uid, target);
    renderAll();
  }));
  wrap.appendChild(makeBtn('?', 'Move to/from maybeboard', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    const target = (found.zoneName === 'maybe') ? 'main' : 'maybe';
    moveInstanceToZone(inst.uid, target);
    renderAll();
  }));

  return wrap;
}

function makePileEl(pile, pileIdx) {
  const el = document.createElement('div');
  el.className = 'pile';
  el.dataset.pileIdx = String(pileIdx);
  // Set pile height based on cards in it
  const totalH = CARD_HEIGHT + Math.max(0, pile.length - 1) * PILE_OFFSET_Y;
  el.style.height = totalH + 'px';

  pile.forEach((inst, slotIdx) => {
    const card = STATE.byId.get(inst.cardId);
    const slot = document.createElement('div');
    slot.className = 'card-slot' + (isLegal(card) ? '' : ' illegal')
                                 + (STATE.selection.has(inst.uid) ? ' selected' : '');
    slot.style.top = (slotIdx * PILE_OFFSET_Y) + 'px';
    slot.style.zIndex = String(slotIdx + 1);
    slot.draggable = true;
    slot.dataset.uid = String(inst.uid);
    if (card) {
      const img = document.createElement('img');
      img.alt = card.canonical;
      img.src = imgUrl(card);
      img.addEventListener('error', () => {
        slot.classList.add('no-image');
        slot.textContent = card.canonical;
      });
      slot.appendChild(img);
      slot.title = `${card.canonical}\n${card.type}\n${card.manacost || ''}`.trim();
    } else {
      slot.classList.add('no-image');
      slot.textContent = '???';
    }
    // Click toggles selection (with modifier) or clears it (plain click).
    slot.addEventListener('click', (ev) => {
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        ev.stopPropagation();
        if (STATE.selection.has(inst.uid)) STATE.selection.delete(inst.uid);
        else STATE.selection.add(inst.uid);
        renderPiles();
      } else {
        if (STATE.selection.size > 0) {
          STATE.selection.clear();
          renderPiles();
        }
      }
    });
    slot.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      const uids = uidsToDrag(inst.uid);
      ev.dataTransfer.setData('text/uids', uids.join(','));
      // Use the slot's already-loaded card image as the drag preview, so
      // overlay buttons / illegal tint don't show in the ghost.
      const slotImg = slot.querySelector('img');
      if (slotImg && slotImg.complete && slotImg.naturalWidth > 0) {
        ev.dataTransfer.setDragImage(slotImg, slotImg.offsetWidth / 2, 30);
      }
      slot.classList.add('dragging');
      STATE.dragging = { uids };
      document.body.classList.add('dragging');
    });
    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging');
      STATE.dragging = null;
      document.body.classList.remove('dragging');
    });
    // Right-click removes one copy from this pile
    slot.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      removeInstance(inst.uid);
      renderAll();
    });
    // Hover preview — same floating popup the deck-list rows use.
    if (card) {
      slot.addEventListener('mouseenter', (ev) => showPreview(card, ev));
      slot.addEventListener('mousemove', positionPreview);
      slot.addEventListener('mouseleave', hidePreview);
    }

    // Overlay action buttons (only attach when we know which card it is)
    if (card) {
      slot.appendChild(makeSlotButtons(inst, card));
    }
    el.appendChild(slot);
  });

  // Pile-level drop target
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (ev) => {
    if (!el.contains(ev.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    if (uids.length === 0) return;
    // Resolve the destination pile by reference (current pileIdx may shift
    // mid-drop as source piles get pruned, so we capture it now).
    const destPile = STATE.zones[STATE.focusedZone].piles[pileIdx];
    if (!destPile) return;
    moveUidsToPile(uids, destPile);
    STATE.selection.clear();
    renderAll();
  });

  return el;
}

// ---------------------------------------------------------------------------
// Zones: focus + drop targets
// ---------------------------------------------------------------------------

function wireZones() {
  for (const zoneName of Object.keys(STATE.zones)) {
    const sec = document.querySelector(`.zone[data-zone="${zoneName}"]`);
    sec.addEventListener('click', () => setFocusedZone(zoneName));

    sec.addEventListener('dragover', (ev) => {
      if (!STATE.dragging) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      sec.classList.add('drag-over');
    });
    sec.addEventListener('dragleave', (ev) => {
      if (!sec.contains(ev.relatedTarget)) sec.classList.remove('drag-over');
    });
    sec.addEventListener('drop', (ev) => {
      ev.preventDefault();
      sec.classList.remove('drag-over');
      const uids = readUidsFromDrag(ev.dataTransfer);
      if (uids.length === 0) return;
      moveUidsToZoneAuto(uids, zoneName);
      STATE.selection.clear();
      renderAll();
      // Intentionally do NOT change focus — the user explicitly wants the
      // pile pane to stay on whichever zone they were viewing.
    });

    // Drag from a row in the deck list — picks the most-recent matching instance
    const list = document.getElementById('list-' + zoneName);
    list.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const cardId = parseInt(row.dataset.cardId, 10);
      const card = STATE.byId.get(cardId);
      const zone = STATE.zones[zoneName];
      // Find any matching instance
      let foundUid = null;
      outer: for (const pile of zone.piles) {
        for (const inst of pile) {
          const c = STATE.byId.get(inst.cardId);
          if (c.canonical === card.canonical) { foundUid = inst.uid; break outer; }
        }
      }
      if (!foundUid) return;
      ev.dataTransfer.effectAllowed = 'move';
      // Deck-list rows always drag a single card; row drags don't participate
      // in pile-pane multi-select.
      ev.dataTransfer.setData('text/uids', String(foundUid));
      // Use the global drag-img (preloaded by hover) as the drag preview.
      const dragImg = document.getElementById('drag-img');
      if (dragImg) {
        dragImg.src = imgUrl(card);
        if (dragImg.complete && dragImg.naturalWidth > 0) {
          ev.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, 60);
        }
      }
      STATE.dragging = { uids: [foundUid] };
      document.body.classList.add('dragging');
    });
    list.addEventListener('dragend', () => {
      STATE.dragging = null;
      document.body.classList.remove('dragging');
    });
  }
}

function setFocusedZone(zoneName) {
  STATE.focusedZone = zoneName;
  document.querySelectorAll('.zone').forEach(z => z.classList.toggle('focused', z.dataset.zone === zoneName));
  renderPiles();
}

// ---------------------------------------------------------------------------
// Toolbar (import/export/clear/legal toggle)
// ---------------------------------------------------------------------------

function wireToolbar() {
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-import').click();
  });
  document.getElementById('file-import').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importDeck(reader.result, file.name);
    reader.readAsText(file);
    ev.target.value = '';
  });
  document.getElementById('btn-export-cod').addEventListener('click', exportCod);
  document.getElementById('btn-export-txt').addEventListener('click', exportTxt);
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear all zones?')) return;
    STATE.zones.main.piles = [];
    STATE.zones.side.piles = [];
    STATE.zones.maybe.piles = [];
    renderAll();
  });
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      STATE.format = btn.dataset.format;
      document.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b === btn));
      runSearch(document.getElementById('search').value);
      // Re-render decks so illegal-card highlighting updates immediately.
      renderAll();
    });
  });
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn.addEventListener('click', async () => {
    const original = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing\u2026';
    try {
      await refreshFromUpstream();
      refreshBtn.textContent = 'Updated \u2713';
      setTimeout(() => { refreshBtn.textContent = original; }, 1500);
    } catch (e) {
      console.error(e);
      alert('Refresh failed: ' + (e.message || e));
      refreshBtn.textContent = original;
    } finally {
      refreshBtn.disabled = false;
    }
  });
}

function wirePileSort() {
  document.querySelectorAll('[data-pile-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      STATE.pileSort = btn.dataset.pileSort;
      document.querySelectorAll('[data-pile-sort]').forEach(b => b.classList.toggle('active', b === btn));
      resortPiles(STATE.focusedZone);
      renderPiles();
    });
  });
  document.getElementById('btn-resort').addEventListener('click', () => {
    resortPiles(STATE.focusedZone);
    renderPiles();
  });
}

function wireListSort() {
  document.querySelectorAll('[data-list-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      STATE.listSort = btn.dataset.listSort;
      document.querySelectorAll('[data-list-sort]').forEach(b => b.classList.toggle('active', b === btn));
      for (const z of Object.keys(STATE.zones)) renderZoneList(z);
    });
  });
}

// ---------------------------------------------------------------------------
// Card preview on hover
// ---------------------------------------------------------------------------

function wirePreviewHover() {
  // Initially nothing — hooked into row mouseenter/move/leave events
}

// Clear the multi-select when the user clicks anywhere outside a card slot
// or its overlay buttons. Slot clicks are handled by the slot's own handler.
// A just-completed region-select sets _suppressNextClickClear so the click
// that fires after mouseup doesn't undo the selection.
let _suppressNextClickClear = false;
function wireSelectionClear() {
  document.addEventListener('click', (ev) => {
    if (_suppressNextClickClear) { _suppressNextClickClear = false; return; }
    if (STATE.selection.size === 0) return;
    if (ev.target.closest('.card-slot') || ev.target.closest('.slot-btn')) return;
    STATE.selection.clear();
    renderPiles();
  });
}

// Rubber-band region select: mousedown on empty pile-pane background starts
// a selection rectangle; all card slots the rect intersects get selected.
// Shift/Ctrl/Cmd adds to the existing selection instead of replacing it.
function wireRegionSelect() {
  const pilesEl = document.getElementById('piles');
  let active = null; // { startX, startY, additive, rectEl, baseSelection }

  pilesEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    // Ignore mousedowns that originated on anything interactive — let those
    // elements handle it (card drag, buttons, existing drop targets, etc).
    if (ev.target.closest('.card-slot, .slot-btn, .pile-gap, .new-pile')) return;
    ev.preventDefault();
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!additive) {
      STATE.selection.clear();
    }
    const baseSelection = new Set(STATE.selection);
    const rectEl = document.createElement('div');
    rectEl.className = 'region-select';
    document.body.appendChild(rectEl);
    active = { startX: ev.clientX, startY: ev.clientY, additive, rectEl, baseSelection };
  });

  document.addEventListener('mousemove', (ev) => {
    if (!active) return;
    const x1 = Math.min(active.startX, ev.clientX);
    const y1 = Math.min(active.startY, ev.clientY);
    const x2 = Math.max(active.startX, ev.clientX);
    const y2 = Math.max(active.startY, ev.clientY);
    active.rectEl.style.left = x1 + 'px';
    active.rectEl.style.top = y1 + 'px';
    active.rectEl.style.width = (x2 - x1) + 'px';
    active.rectEl.style.height = (y2 - y1) + 'px';

    // Recompute selection live: base ∪ (slots inside rect).
    const nextSel = new Set(active.baseSelection);
    const slots = document.querySelectorAll('#piles .pile .card-slot');
    for (const slot of slots) {
      const r = slot.getBoundingClientRect();
      const intersects = r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2;
      if (intersects) {
        const uid = parseInt(slot.dataset.uid, 10);
        if (!isNaN(uid)) nextSel.add(uid);
      }
    }
    // Only touch DOM for slots whose selected state changed.
    for (const slot of slots) {
      const uid = parseInt(slot.dataset.uid, 10);
      const wantSel = nextSel.has(uid);
      const hasSel = slot.classList.contains('selected');
      if (wantSel && !hasSel) slot.classList.add('selected');
      else if (!wantSel && hasSel) slot.classList.remove('selected');
    }
    STATE.selection = nextSel;
  });

  document.addEventListener('mouseup', (ev) => {
    if (!active) return;
    const dx = Math.abs(ev.clientX - active.startX);
    const dy = Math.abs(ev.clientY - active.startY);
    // If the drag was meaningful, suppress the next background click from
    // clearing the selection we just built.
    if (dx > 3 || dy > 3) _suppressNextClickClear = true;
    active.rectEl.remove();
    active = null;
  });
}

// Short delay before the floating preview pops up — prevents flicker as the
// cursor sweeps across many cards. mouseleave (hidePreview) cancels a
// pending timer, so quick passes never show anything.
const PREVIEW_DELAY_MS = 250;
let _previewTimer = null;

function showPreview(card, ev) {
  if (_previewTimer) clearTimeout(_previewTimer);
  // Capture cursor position now; the timer fires later when ev is stale.
  const startEv = { clientX: ev.clientX, clientY: ev.clientY };
  _previewTimer = setTimeout(() => {
    _previewTimer = null;
    const el = document.getElementById('card-preview');
    const img = document.getElementById('card-preview-img');
    const url = imgUrl(card);
    img.src = url;
    img.alt = card.canonical;
    el.classList.remove('hidden');
    positionPreview(startEv);
    // Preload into the dedicated drag-preview img so a subsequent dragstart
    // from this row can use it as the drag preview image.
    const dragImg = document.getElementById('drag-img');
    if (dragImg) dragImg.src = url;
  }, PREVIEW_DELAY_MS);
}

function positionPreview(ev) {
  const el = document.getElementById('card-preview');
  if (el.classList.contains('hidden')) return;
  const w = el.offsetWidth, h = 336;
  let x = ev.clientX + 16;
  let y = ev.clientY - h / 2;
  if (x + w > window.innerWidth) x = ev.clientX - w - 16;
  if (y < 8) y = 8;
  if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function hidePreview() {
  if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
  document.getElementById('card-preview').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Import / export — .cod (Cockatrice XML) and .txt (plain decklist)
// ---------------------------------------------------------------------------

function clearAllZones() {
  STATE.zones.main.piles = [];
  STATE.zones.side.piles = [];
  STATE.zones.maybe.piles = [];
}

function resolveCardName(name, uuid) {
  // Match by uuid first (exact printing), then exact name, then canonical.
  if (uuid && STATE.uuidMap[uuid]) return STATE.uuidMap[uuid].cardId;
  const exact = STATE.byName.get(name);
  if (exact) return exact.id;
  const canon = canonicalName(name);
  for (const c of STATE.cards) {
    if (c.canonical === canon) return c.id;
  }
  return null;
}

function importDeck(text, filename) {
  // Sniff format. .cod is XML; .txt is line-based. The first non-whitespace
  // character is enough to tell them apart.
  const stripped = text.replace(/^\uFEFF/, '').trimStart();
  const isXml = stripped.startsWith('<');
  if (isXml) importCod(text);
  else importTxt(text);
}

function importCod(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) { alert('Failed to parse XML: ' + e); return; }
  const err = doc.querySelector('parsererror');
  if (err) { alert('Failed to parse .cod: ' + err.textContent); return; }

  clearAllZones();

  const zones = doc.querySelectorAll('zone');
  let unknown = [];
  zones.forEach(zoneEl => {
    const zname = (zoneEl.getAttribute('name') || '').toLowerCase();
    let target = 'main';
    if (zname === 'side' || zname === 'sideboard') target = 'side';
    else if (zname === 'maybe' || zname === 'maybeboard') target = 'maybe';

    zoneEl.querySelectorAll('card').forEach(cardEl => {
      const number = parseInt(cardEl.getAttribute('number') || '1', 10);
      const name = cardEl.getAttribute('name') || '';
      const uuid = cardEl.getAttribute('uuid') || '';
      const cardId = resolveCardName(name, uuid);
      if (!cardId) { unknown.push(name); return; }
      addCardToZone(cardId, target, number);
    });
  });

  for (const z of Object.keys(STATE.zones)) resortPiles(z);
  renderAll();
  reportUnknown(unknown);
}

function importTxt(text) {
  // Group cards by runs of "<count> <name>" lines, separated by anything else
  // (blank lines, headers, comments). The first run is main, second side,
  // third maybe.
  const cardLine = /^\s*(\d+)\s+(.+?)\s*$/;
  const groups = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(cardLine);
    if (m) {
      if (!cur) { cur = []; groups.push(cur); }
      cur.push({ count: parseInt(m[1], 10), name: m[2] });
    } else {
      cur = null;
    }
  }

  clearAllZones();
  const zoneOrder = ['main', 'side', 'maybe'];
  const unknown = [];
  groups.forEach((group, gi) => {
    const zone = zoneOrder[gi] || 'maybe';
    for (const { count, name } of group) {
      const cardId = resolveCardName(name, null);
      if (!cardId) { unknown.push(name); continue; }
      addCardToZone(cardId, zone, count);
    }
  });

  for (const z of Object.keys(STATE.zones)) resortPiles(z);
  renderAll();
  reportUnknown(unknown);
}

function reportUnknown(unknown) {
  if (unknown.length === 0) return;
  alert(`Imported with ${unknown.length} unknown card(s):\n` +
        unknown.slice(0, 20).join('\n') +
        (unknown.length > 20 ? '\n...' : ''));
}

// Aggregate one zone into a sorted [{count, card}] list, keyed by the card's
// original (non-canonical) name so exports preserve the exact printing.
function aggregateZone(zoneName) {
  const m = new Map();
  for (const pile of STATE.zones[zoneName].piles) {
    for (const inst of pile) {
      const c = STATE.byId.get(inst.cardId);
      if (!c) continue;
      const ent = m.get(c.name);
      if (ent) ent.count++;
      else m.set(c.name, { count: 1, card: c });
    }
  }
  return Array.from(m.values()).sort((a, b) => a.card.name.localeCompare(b.card.name));
}

function downloadFile(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function exportCod() {
  const main  = aggregateZone('main');
  const side  = aggregateZone('side');
  const maybe = aggregateZone('maybe');

  const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                          .replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Find a uuid for a card by walking the uuidMap. Fall back to id.
  const uuidByCardId = new Map();
  for (const [uuid, info] of Object.entries(STATE.uuidMap)) {
    if (!uuidByCardId.has(info.cardId)) uuidByCardId.set(info.cardId, uuid);
  }

  function renderZone(name, items) {
    if (items.length === 0) return '';
    const lines = items.map(({ count, card }) => {
      const uuid = uuidByCardId.get(card.id) || String(card.id);
      return `        <card number="${count}" name="${xmlEsc(card.name)}" setShortName="${xmlEsc(card.set)}" collectorNumber="${xmlEsc(card.num)}" uuid="${xmlEsc(uuid)}"/>`;
    });
    return `    <zone name="${name}">\n${lines.join('\n')}\n    </zone>\n`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cockatrice_deck version="1">
    <deckname></deckname>
    <comments></comments>
    <tags/>
${renderZone('main', main)}${renderZone('side', side)}${renderZone('maybe', maybe)}</cockatrice_deck>
`;

  downloadFile('deck.cod', xml, 'application/xml');
}

function exportTxt() {
  //   "<count> <name>" lines, with a blank line separating zones.
  // We write main, then side, then maybe (if present). No header line —
  // the imported title line, if any, isn't tracked in state.
  const sections = [];
  for (const zone of ['main', 'side', 'maybe']) {
    const items = aggregateZone(zone);
    if (items.length === 0) continue;
    sections.push(items.map(({ count, card }) => `${count} ${card.name}`).join('\n'));
  }
  const text = sections.join('\n\n') + '\n';
  downloadFile('deck.txt', text, 'text/plain');
}
