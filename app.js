// Revolution Deckbuilder — single-page JS app
// All card data is loaded once from a bundled JSON file (mtgjson-style
// AllSetsEternal.json) and translated into the in-memory STATE.cards index.
// Everything else (search, pile layout, drag/drop, .cod import/export) runs
// in the browser too. No backend required.

'use strict';

// Card images live in the cajunwritescode/Revolution repo. We hit raw.git
// directly so the SPA can run from any static host (e.g. GitHub Pages).
const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';

// Upstream JSON snapshot the "Refresh data" button pulls from. mtgjson-style
// shape: { meta: {}, data: { SETCODE: { name, code, releaseDate, cards: [...] } } }
const REFRESH_URL = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/AllSetsEternal.json';

// localStorage key for the refreshed snapshot. Once the user has refreshed,
// subsequent loads use this and skip even the bundled cards.json fetch.
// Bumped to v10: page cards now carry a synthesized `pageFace` object with
// its own type / text / mana / colors / cmc / keywords so searches match
// face-by-face (no cross-side partial hits between the creature and its
// Adventure/Discharge spell). Main face keywords are no longer combined
// with page keywords.
const STORAGE_VERSION = 11;
const STORAGE_KEY = `rev-deckbuilder-cards-v${STORAGE_VERSION}`;

// User preferences (format toggle + chosen set range). Kept separate from
// the card-data snapshot so refreshing card data doesn't reset the format,
// and switching format doesn't bust the card cache.
const PREFS_KEY = 'rev-deckbuilder-prefs-v1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE = {
  cards: [],            // full card list, parsed from the bundled cards.json
  byId: new Map(),      // id -> card
  byName: new Map(),    // name -> card
  byCanonical: new Map(), // canonical name -> sorted-by-date list of cards (every printing)
  uuidMap: {},          // uuid -> { cardId, set, num }
  setCodes: new Set(),  // every set code (used for canonical-name stripping at parse time)
  setsByCode: {},       // set code -> { code, longname, releasedate }
  setOrder: [],         // set codes sorted oldest -> newest (then by code for ties)

  // Each zone holds an ordered list of piles, each pile is an array of card-instance objects.
  // A card instance is { uid, cardId } — uid is unique per copy.
  zones: {
    main:  { piles: [] },
    side:  { piles: [] },
    maybe: { piles: [] },
  },

  focusedZone: 'main',  // 'main' | 'side' | 'maybe' | 'search' (only when searchPanel is on)
  searchPanel: false,   // when true, hide the dropdown and render results in the pile pane
  format: 'standard',   // 'standard' | 'eternal' | 'range'
  rangeStart: null,     // set code (only meaningful when format === 'range')
  rangeEnd: null,       // set code (only meaningful when format === 'range')
  listSort: 'type',     // how the text deck list is sorted
  pileSort: 'type',     // primary pile-sort method — kept in sync with pileSortChain[0].
  pileSortChain: ['type'], // Most-recent-primary-first list of pile-sort methods. Ties from
                           // the primary fall through to the next method in the chain,
                           // letting the user express multi-key sorts ("color, break
                           // ties by mana") just by picking color after mana.
  theme: 'dark',        // 'dark' | 'light' — applied via <html data-theme="...">. An inline
                        // script in index.html reads the same pref to avoid a flash on load.

  search: {
    results: [],
    selectedIdx: 0,
    error: null,       // parser error, shown under the dropdown
  },

  uidCounter: 1,        // monotonic id for card instances
  dragging: null,       // { uids: [uid, ...] }
  dragGhost: null,      // { el, offsetX, offsetY } — custom floating ghost element
  selection: new Set(), // selected card-instance uids (multi-select via Shift/Ctrl/Cmd-click)
  searchSelection: new Set(), // selected card ids in the search panel (parallel to `selection`
                              // but keyed by card id since search tiles aren't uid-tracked instances)
  loadedDeckName: null, // name of the currently loaded saved deck (null = unsaved)
  loadedDeckFolder: null, // folder string of the loaded deck (null = unfiled)
  loadedDeckTags: [],   // tags of the loaded deck (empty = untagged)
  deckSnapshot: null,   // JSON string of zones at last load/save/new — used to detect unsaved changes

  // Undo/redo history. `lastSnapshot` mirrors the zones JSON as of the last
  // commit; renderAll() compares a fresh serialization against it and pushes
  // the previous value onto `past` whenever they differ. `future` holds the
  // stack of states the user can redo into (populated by undo()).
  history: { past: [], future: [], lastSnapshot: null },
};

const UNDO_MAX = 50;

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

// mtgjson's `types` array preserves the order types appear on the card's
// type line, which means an enchantment creature comes in as
// ["Enchantment", "Creature"]. For bucketing/sorting we want the
// highest-priority type per TYPE_ORDER, so a creature-enchantment lives
// with the creatures, artifact creatures with creatures, etc.
function pickMainType(types) {
  if (!types || types.length === 0) return '';
  let best = types[0];
  let bestRank = TYPE_ORDER[best] ?? 99;
  for (let i = 1; i < types.length; i++) {
    const r = TYPE_ORDER[types[i]] ?? 99;
    if (r < bestRank) { best = types[i]; bestRank = r; }
  }
  return best;
}

const ZONE_LABELS = { main: 'Main', side: 'Sideboard', maybe: 'Maybeboard' };

// ---------------------------------------------------------------------------
// Custom drag ghost — bypasses the native drag-image which browsers scale
// down unpredictably on HiDPI screens and force to ~50% opacity.
// ---------------------------------------------------------------------------

const EMPTY_DRAG_IMG = new Image();
EMPTY_DRAG_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
EMPTY_DRAG_IMG.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:-1;';
document.documentElement.appendChild(EMPTY_DRAG_IMG);

/**
 * Show a card-image overlay that follows the cursor during drag.
 * When uids has multiple entries the ghost stacks them like a pile.
 */
function startDragGhost(ev, uids, width, height, offsetX, offsetY) {
  console.log('[drag] startDragGhost called', {
    uids, width, height, offsetX, offsetY,
    clientX: ev.clientX, clientY: ev.clientY,
    hadPriorGhost: !!STATE.dragGhost,
  });
  endDragGhost();
  // Hide the native ghost by substituting a 1×1 transparent image.
  ev.dataTransfer.setDragImage(EMPTY_DRAG_IMG, 0, 0);

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';

  const stackOffset = PILE_OFFSET_Y;
  const count = uids.length;
  ghost.style.width = width + 'px';
  ghost.style.height = (height + Math.max(0, count - 1) * stackOffset) + 'px';

  let imgCount = 0;
  uids.forEach((uid, i) => {
    const found = findInstance(uid);
    if (!found) {
      console.warn('[drag]   uid', uid, '— findInstance returned null, skipping');
      return;
    }
    const card = STATE.byId.get(found.inst.cardId);
    const face = currentFace(found.inst, card);
    const src = imgUrl(face);
    console.log('[drag]   uid', uid, '— card:', card?.name, '— img:', src.slice(-40));
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `position:absolute;top:${i * stackOffset}px;left:0;`
                       + `width:${width}px;height:${height}px;`
                       + `object-fit:cover;border-radius:5px;`;
    ghost.appendChild(img);
    imgCount++;
  });

  ghost.style.left = (ev.clientX - offsetX) + 'px';
  ghost.style.top = (ev.clientY - offsetY) + 'px';
  document.body.appendChild(ghost);
  STATE.dragGhost = { el: ghost, offsetX, offsetY };
  console.log('[drag] ghost appended to body — children:', imgCount,
              '— rect:', ghost.getBoundingClientRect());
}

function endDragGhost() {
  if (STATE.dragGhost) {
    console.log('[drag] endDragGhost — removing ghost, caller:',
                new Error().stack.split('\n')[2]?.trim());
    STATE.dragGhost.el.remove();
    STATE.dragGhost = null;
  }
}

// Track cursor during drag to reposition the ghost.
let _lastDragoverLog = 0;
document.addEventListener('dragover', (ev) => {
  if (STATE.dragGhost) {
    STATE.dragGhost.el.style.left = (ev.clientX - STATE.dragGhost.offsetX) + 'px';
    STATE.dragGhost.el.style.top = (ev.clientY - STATE.dragGhost.offsetY) + 'px';
    const now = Date.now();
    if (now - _lastDragoverLog > 500) {
      console.log('[drag] dragover — ghost pos:', ev.clientX, ev.clientY,
                  '— ghost in DOM:', document.body.contains(STATE.dragGhost.el),
                  '— ghost rect:', STATE.dragGhost.el.getBoundingClientRect());
      _lastDragoverLog = now;
    }
  }
});

// ---------------------------------------------------------------------------
// Drag-to-delete trash can (shown when dragging 2+ cards)
// ---------------------------------------------------------------------------

function showDragTrash() {
  document.getElementById('drag-trash').classList.remove('hidden');
}
function hideDragTrash() {
  const el = document.getElementById('drag-trash');
  el.classList.remove('hidden', 'drag-over');
  el.classList.add('hidden');
}

function wireDragTrash() {
  const trashEl = document.getElementById('drag-trash');
  trashEl.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    trashEl.classList.add('drag-over');
  });
  trashEl.addEventListener('dragleave', () => {
    trashEl.classList.remove('drag-over');
  });
  trashEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    trashEl.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    endDragGhost();
    if (uids.length === 0) return;
    for (const uid of uids) removeInstance(uid);
    STATE.selection.clear();
    hideDragTrash();
    renderAll();
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function init() {
  for (let v = 1; v < STORAGE_VERSION; v++) {
    try { localStorage.removeItem(`rev-deckbuilder-cards-v${v}`); } catch (_) {}
  }

  loadPrefs();

  let data = null;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) data = JSON.parse(cached);
  } catch (e) {
    console.warn('Could not read cached card data:', e);
  }
  if (!data) {
    const res = await fetch('cards.json');
    if (!res.ok) throw new Error(`failed to load cards.json (HTTP ${res.status})`);
    const json = await res.json();
    data = parseAllSetsJson(json);
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
  wireSearchToggle();
  wireUndoRedo();
  wireVersionPicker();
  setFocusedZone('main');
  // applySearchPanelMode comes after setFocusedZone so it can override focus
  // to 'search' when panel mode is on from a prior session.
  applySearchPanelMode();
  markDeckClean();

  // Register the image-caching service worker. Needs a secure context
  // (https or localhost) — silently a no-op on file:// or unsupported
  // browsers, which is fine: the app just falls back to the browser's
  // HTTP cache as before.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => {
      console.warn('Service worker registration failed:', e);
    });
  }
})().catch(err => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f88;padding:20px';
  pre.textContent = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  document.body.innerHTML = '';
  document.body.appendChild(pre);
});

// Fields that identify a card's *gameplay identity* — if two differently-named
// cards share all of these, they're the same card's alt-art variants, not
// two separate cards. Used by consolidateCanonicals to decide whether a
// name-strip is safe (Mirage Island and Island share a structurally-distinct
// type line so they never merge, for instance).
function structKey(c) {
  return JSON.stringify([
    c.text || '',
    c.type || '',
    c.cmc != null ? c.cmc : 0,
    c.manacost || '',
    c.colors || '',
    c.ci || '',
    c.power || '',
    c.toughness || '',
  ]);
}

// Try one step of suffix-stripping. Returns { stem, variant } describing
// what was cut; null if nothing matches. The variant label is the piece
// that was removed — used to label the alt-art chip in the version picker
// (so an `Island (Pixel)` variant shows as `Pixel`, not as its shared set
// code). Rules try parentheticals first, then `_<word>` tokens, then a
// trailing whitespace-separated word.
function stripNameOnce(name) {
  const paren = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[1]) return { stem: paren[1], variant: paren[2] };
  const under = name.match(/^(.*)_([A-Za-z0-9]+)$/);
  if (under && under[1]) return { stem: under[1], variant: under[2] };
  const word  = name.match(/^(.*\S)\s+(\S+)$/);
  if (word && word[1]) return { stem: word[1], variant: word[2] };
  return null;
}

// Post-parse pass that collapses alt-art variants into a shared canonical.
// parseAllSetsJson already stripped trailing `_SETCODE` / `_PRO` tokens; this
// handles the non-setcode patterns (`(Pixel)`, `_Cidraeth`, trailing
// " Romantic") that the user has in the corpus. A strip only commits when
// a card with the stem name already exists AND shares the structural key,
// so Mirage Island doesn't accidentally collapse into Island.
function consolidateCanonicals(cards, byName) {
  for (const c of cards) {
    const key = structKey(c);
    let cur = c.canonical;
    let variant = null;
    while (true) {
      const step = stripNameOnce(cur);
      if (!step) break;
      const host = byName.get(step.stem);
      if (host && host !== c && structKey(host) === key) {
        cur = step.stem;
        variant = step.variant;   // last-stripped label wins — it's what the user sees
        continue;
      }
      break;
    }
    c.canonical = cur;
    if (variant) c.variant = variant;
    // Keep the synthesized page-face's canonical in sync — it was assigned
    // `card.canonical` at construction time, so without this sync any face-
    // level predicate that reads canonical would see the pre-consolidation
    // name.
    if (c.pageFace) c.pageFace.canonical = cur;
  }
}

// Swap STATE over to a fresh card index. Re-maps any existing zone-instance
// card ids by card name so the user's deck-in-progress survives a refresh
// (the underlying integer ids are reassigned by parseAllSetsJson, so we
// can't trust the old numbers).
function applyCardData(data) {
  const oldById = STATE.byId;
  const newById = new Map();
  const newByName = new Map();
  const newByCanonical = new Map();
  for (const c of data.cards) {
    newById.set(c.id, c);
    newByName.set(c.name, c);
  }
  // Collapse alt-art variants (names like `Island_Cidraeth`, `Island (Pixel)`,
  // `Island Romantic_DOV`) onto the base card's canonical, gated by
  // structural equivalence so genuinely different cards stay separate. Must
  // run BEFORE byCanonical is built so the grouping reflects the merge.
  consolidateCanonicals(data.cards, newByName);
  for (const c of data.cards) {
    let arr = newByCanonical.get(c.canonical);
    if (!arr) { arr = []; newByCanonical.set(c.canonical, arr); }
    arr.push(c);
  }
  // Sort each canonical's printings oldest -> newest using the set release
  // date (ties broken by set code, then card id). Used by the search UI to
  // present printings in a stable order regardless of insertion order.
  const setsForSort = data.sets || {};
  function setDate(code) {
    const s = setsForSort[code];
    return s ? (s.releasedate || '') : '';
  }
  for (const arr of newByCanonical.values()) {
    arr.sort((a, b) => {
      const da = setDate(a.set), db = setDate(b.set);
      if (da !== db) return da < db ? -1 : 1;
      if (a.set !== b.set) return a.set < b.set ? -1 : 1;
      // Within a set, the normal print appears earlier in the upstream card
      // list than its alt-art variants, so lower-id = normal print. Sort
      // descending on id so the normal print ends up last and becomes the
      // default pick.
      return b.id - a.id;
    });
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
  STATE.byCanonical = newByCanonical;
  STATE.setsByCode = data.sets || {};
  // STATE.setCodes is used only for stripping _SETCODE suffixes off card
  // names at import time, so it includes excluded sets (REV, PLANE, TK)
  // too — older decklists referencing "Foo_REV" should still canonicalise.
  // The list of *visible* sets lives in setOrder / setsByCode below.
  STATE.setCodes = new Set(data.allSetCodes || Object.keys(STATE.setsByCode));
  // Set order: oldest -> newest, ties broken by code so the original 6 stay
  // in their fabricated daily-increment order and ERR/KDT (truly tied) sort
  // alphabetically. This is the list used for the range picker and for any
  // chronological set lookup; reprint-only sets (REV) are filtered out so
  // they aren't selectable as range bounds, but they remain in setsByCode
  // so date lookups for their cards still work.
  STATE.setOrder = Object.keys(STATE.setsByCode)
    .filter(code => !HIDDEN_FROM_RANGE_PICKER.has(code))
    .sort((a, b) => {
      const da = STATE.setsByCode[a].releasedate || '';
      const db = STATE.setsByCode[b].releasedate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  // Reconcile any persisted range against the current set list. If the saved
  // codes don't exist (e.g. cards.json changed), fall back to full range.
  if (!STATE.setsByCode[STATE.rangeStart]) STATE.rangeStart = STATE.setOrder[0] || null;
  if (!STATE.setsByCode[STATE.rangeEnd])   STATE.rangeEnd   = STATE.setOrder[STATE.setOrder.length - 1] || null;
  // If start is somehow after end (e.g. user persisted backwards), swap.
  if (STATE.rangeStart && STATE.rangeEnd && setIndex(STATE.rangeStart) > setIndex(STATE.rangeEnd)) {
    [STATE.rangeStart, STATE.rangeEnd] = [STATE.rangeEnd, STATE.rangeStart];
  }
  renderRangePickers();
  STATE.selection.clear();
  const searchInput = document.getElementById('search');
  if (searchInput) runSearch(searchInput.value);
  renderAll();
}

function setIndex(code) {
  return STATE.setOrder.indexOf(code);
}

// Persist user preferences (format + range bounds) across reloads.
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (obj.format === 'standard' || obj.format === 'eternal' || obj.format === 'range') {
        STATE.format = obj.format;
      }
      if (typeof obj.rangeStart === 'string') STATE.rangeStart = obj.rangeStart;
      if (typeof obj.rangeEnd === 'string')   STATE.rangeEnd   = obj.rangeEnd;
      if (obj.theme === 'light' || obj.theme === 'dark') STATE.theme = obj.theme;
      if (typeof obj.searchPanel === 'boolean') STATE.searchPanel = obj.searchPanel;
    }
  } catch (e) {
    console.warn('Could not read deckbuilder prefs:', e);
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      format: STATE.format,
      rangeStart: STATE.rangeStart,
      rangeEnd: STATE.rangeEnd,
      theme: STATE.theme,
      searchPanel: STATE.searchPanel,
    }));
  } catch (e) {
    console.warn('Could not persist deckbuilder prefs:', e);
  }
}

// Push STATE.theme into the DOM and update the toggle button's label.
// The label shows the *target* of the toggle, not the current theme.
function applyTheme() {
  if (STATE.theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = STATE.theme === 'light' ? 'Dark mode' : 'Light mode';
}

// ---------------------------------------------------------------------------
// JSON ingestion (refresh from upstream)
// ---------------------------------------------------------------------------

// Sets that are present in the upstream JSON but should be dropped from the
// card index entirely:
//   TK    — token set, not draftable
//   PLANE — Planechase: Revolution, a side product not part of normal play.
const EXCLUDED_SETS = new Set(['TK', 'PLANE']);

// Sets whose cards we DO want in the index (so users can search for and
// add those specific printings) but which should not appear as selectable
// bounds in the set-range format picker:
//   REV — Revolution Renegades is a curated reprint set; every card has a
//         printing in some other set, so it isn't a meaningful range bound.
//         Cards from REV are still legal whenever their canonical card is
//         legal in the chosen format (handled by the canonical-based
//         isLegal check below).
const HIDDEN_FROM_RANGE_PICKER = new Set(['REV']);

// Translate the upstream mtgjson-style AllSetsEternal.json into the same
// {cards, sets, uuidMap} shape that loadCardsFromDb() returns. The translation
// mirrors carddb.py's logic: drop excluded sets, drop back faces of
// double-faced cards, store legalities lowercased, store manacost without
// braces, sort cards by name, assign monotonic ids.
function parseAllSetsJson(json) {
  const setsObj = (json && json.data) || {};

  const sets = {};
  for (const code of Object.keys(setsObj)) {
    if (EXCLUDED_SETS.has(code)) continue;
    const s = setsObj[code] || {};
    sets[code] = {
      code,
      longname: s.name || '',
      releasedate: s.releaseDate || '',
    };
  }
  const setCodes = new Set(Object.keys(sets));

  // For canonicalization we strip ANY recognised set code, including
  // excluded ones — that way an "Foo_REV" reference (e.g. in an imported
  // decklist) still canonicalises to "Foo" and finds a reprint.
  const allSetCodes = new Set(Object.keys(setsObj));
  function canonicalize(name) {
    while (name.includes('_')) {
      const i = name.lastIndexOf('_');
      const tail = name.slice(i + 1);
      if (allSetCodes.has(tail) || tail === 'PRO') name = name.slice(0, i);
      else break;
    }
    return name;
  }

  const cards = [];
  const uuidMap = {};
  let nextId = 1;

  // First pass: build a (set, rawName) -> back-face record map. We need
  // this because mtgjson can list back faces before fronts, and we want to
  // attach the back data to the front card object. The back record carries
  // enough fields to render the back image and a basic tooltip — image URL
  // construction only needs set/num/imgVersion, but text/type/manacost let
  // future UI surfaces (e.g. preview captions) read the back without
  // re-fetching anything.
  const backsBySetAndName = new Map();
  for (const code of Object.keys(setsObj)) {
    if (EXCLUDED_SETS.has(code)) continue;
    const cardList = (setsObj[code] || {}).cards || [];
    for (const c of cardList) {
      const side = (c.side || '').toLowerCase();
      if (side !== 'b' && side !== 'back') continue;
      const rawName = c.name || '';
      const splitIdx = rawName.indexOf(' // ');
      const backName = splitIdx >= 0 ? rawName.slice(splitIdx + 4) : rawName;
      const num = c.number != null ? String(c.number) : '';
      const back = {
        name: backName,
        canonical: canonicalize(backName),
        text: c.text || '',
        type: c.type || '',
        maintype: pickMainType(c.types),
        subtypes: (c.subtypes || []).slice(),
        supertypes: (c.supertypes || []).slice(),
        types: (c.types || []).slice(),
        manacost: formatManaCost(c.manaCost),
        rawManaCost: c.manaCost || '',
        colors: (c.colors || []).join(''),
        power: c.power != null ? String(c.power) : '',
        toughness: c.toughness != null ? String(c.toughness) : '',
        loyalty: c.loyalty != null ? String(c.loyalty) : '',
        artist: c.artist || '',
        flavor: c.flavor || '',
        keywords: extractKeywords(c.text || ''),
        layout: c.layout || 'normal',
        set: code,
        num,
        imgVersion: (c.identifiers && c.identifiers.multiverseId) || 0,
      };
      backsBySetAndName.set(code + '\u0000' + rawName, back);
    }
  }

  for (const code of Object.keys(setsObj)) {
    if (EXCLUDED_SETS.has(code)) continue;
    const setObj = setsObj[code] || {};
    const cardList = setObj.cards || [];
    for (const c of cardList) {
      // Front faces (or single-sided cards) only. Backs were captured in
      // the first pass above and get attached as `card.back` below.
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
      // Cajun re-purposes the mtgjson `multiverseId` field as a YYYYMMDD
      // updated-at stamp for the card's image. Storing it here lets imgUrl()
      // append it as a query string so browsers re-fetch when art changes.
      const imgVersion = (c.identifiers && c.identifiers.multiverseId) || 0;
      const back = backsBySetAndName.get(code + '\u0000' + rawName) || null;
      const legalities = {};
      for (const [fmt, status] of Object.entries(c.legalities || {})) {
        legalities[fmt.toLowerCase()] = String(status || '').toLowerCase();
      }
      // pageData is a secondary spell attached to the front of a creature —
      // the "page" mechanic family. Revolution uses Adventure (shared with
      // canon) and Discharge (Revolution-only). Any new page-style mechanic
      // from a future set parses here the same way as long as mtgjson
      // delivers it in `pageData`.
      const pageData = c.pageData ? {
        name: c.pageData.name || '',
        type: c.pageData.type || '',
        manaCost: c.pageData.manaCost || '',
        text: c.pageData.text || '',
      } : null;
      const card = {
        id,
        name,
        canonical: canonicalize(name),
        text: c.text || '',
        type: c.type || '',
        maintype: pickMainType(c.types),
        subtypes: (c.subtypes || []).slice(),
        supertypes: (c.supertypes || []).slice(),
        types: (c.types || []).slice(),
        cmc: cmcVal,
        manacost: formatManaCost(c.manaCost),
        rawManaCost: c.manaCost || '',
        colors: (c.colors || []).join(''),
        ci: (c.colorIdentity || []).join(''),
        power: c.power != null ? String(c.power) : '',
        toughness: c.toughness != null ? String(c.toughness) : '',
        loyalty: c.loyalty != null ? String(c.loyalty) : '',
        artist: c.artist || '',
        flavor: c.flavor || '',
        keywords: extractKeywords(c.text || ''),
        pageData,
        layout: c.layout || 'normal',
        set: code,
        num,
        rarity: c.rarity || '',
        legalities,
        fmt_rev: legalities.revolution || '',
        fmt_eternal: legalities.eternal || '',
        related: splitRelated
                   || ((c.relatedCards && Array.isArray(c.relatedCards.spellbook))
                         ? c.relatedCards.spellbook.join('; ')
                         : ''),
        imgVersion,
        back,
      };
      // Synthesize a "page face" for cards with a page mechanic (Adventure /
      // Discharge). Each face gets its own type/text/mana/colors/keywords,
      // so a query like `t:creature c:w` only matches if one *complete*
      // face — creature side OR page side — satisfies it. The page face
      // keeps a reference to the parent's `pageData` so card-level predicates
      // like `is:page` / `is:adventure` / `is:discharge` still match when
      // evaluated against the page face.
      if (pageData) {
        const parts = parseTypeLineParts(pageData.type);
        card.pageFace = {
          id,
          name: pageData.name,
          canonical: card.canonical,
          text: pageData.text,
          type: pageData.type,
          maintype: pickMainType(parts.types),
          subtypes: parts.subtypes,
          supertypes: parts.supertypes,
          types: parts.types,
          cmc: cmcFromManaCost(pageData.manaCost),
          manacost: formatManaCost(pageData.manaCost),
          rawManaCost: pageData.manaCost,
          colors: colorsFromManaCost(pageData.manaCost),
          ci: card.ci,
          power: '',
          toughness: '',
          loyalty: '',
          artist: card.artist,
          flavor: '',
          keywords: extractKeywords(pageData.text),
          pageData,  // card-level predicates still see the page info
          layout: card.layout,
          set: code,
          num,
          rarity: card.rarity,
          legalities: card.legalities,
          fmt_rev: card.fmt_rev,
          fmt_eternal: card.fmt_eternal,
          imgVersion,
          back: null,
        };
      }
      cards.push(card);
      if (c.uuid) uuidMap[c.uuid] = { cardId: id, set: code, num };
    }
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { cards, sets, uuidMap, allSetCodes: Array.from(allSetCodes) };
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
  // Strip trailing _<setcode> and _PRO tokens. Mirrors the backend rule.
  while (name.includes('_')) {
    const i = name.lastIndexOf('_');
    const tail = name.slice(i + 1);
    if (STATE.setCodes.has(tail) || tail === 'PRO') name = name.slice(0, i);
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
//
// Legality is canonical-based: a printing is legal iff *any* printing of
// the same canonical card satisfies the format's check. This means
// reprint-only sets like REV ride along with the legality of their
// canonical, even though REV itself isn't a selectable range bound — if
// Forest is legal in Standard, every Forest_<SET> printing is legal too.
function isLegal(card) {
  if (!card) return true;
  const printings = STATE.byCanonical.get(card.canonical) || [card];
  if (STATE.format === 'eternal') {
    return printings.some(p => p.fmt_eternal === 'legal');
  }
  if (STATE.format === 'range') {
    // Set range: legal iff *some* printing of the canonical falls inside
    // the [start, end] window (inclusive on both ends). Format-specific
    // legality (revolution / eternal) is intentionally NOT layered on top —
    // the range is the only filter, so users can build with whatever was
    // printed in those sets even if it later got banned.
    const startSet = STATE.setsByCode[STATE.rangeStart];
    const endSet   = STATE.setsByCode[STATE.rangeEnd];
    if (!startSet || !endSet) return false;
    const startDate = startSet.releasedate || '';
    const endDate   = endSet.releasedate || '';
    for (const p of printings) {
      const ps = STATE.setsByCode[p.set];
      if (!ps) continue;
      const pd = ps.releasedate || '';
      if (pd >= startDate && pd <= endDate) return true;
    }
    return false;
  }
  return printings.some(p => p.fmt_rev === 'legal');
}

// Build (or rebuild) the two start/end <select>s for the set-range picker.
// Called on init and after every applyCardData (refresh data could add /
// remove sets). Visibility of the wrapper is owned by syncFormatUI() since
// it depends on STATE.format, not on the data.
function renderRangePickers() {
  const startSel = document.getElementById('range-start');
  const endSel   = document.getElementById('range-end');
  if (!startSel || !endSel) return;
  const opts = STATE.setOrder.map(code => {
    const s = STATE.setsByCode[code];
    const label = `${code} — ${s.longname || code}`;
    return `<option value="${escapeHtml(code)}">${escapeHtml(label)}</option>`;
  }).join('');
  startSel.innerHTML = opts;
  endSel.innerHTML   = opts;
  if (STATE.rangeStart) startSel.value = STATE.rangeStart;
  if (STATE.rangeEnd)   endSel.value   = STATE.rangeEnd;
}

// Format labels for the dropdown trigger button.
const FORMAT_LABELS = { standard: 'Standard', eternal: 'Eternal', range: 'Sets' };

// Sync the visible state of the format dropdown (trigger label, active menu
// item, range picker visibility) with STATE.
function syncFormatUI() {
  const btn = document.getElementById('format-btn');
  if (btn) btn.textContent = (FORMAT_LABELS[STATE.format] || 'Standard') + ' \u25BE';
  document.querySelectorAll('#format-menu button').forEach(b => {
    b.classList.toggle('active', b.dataset.format === STATE.format);
  });
  const wrap = document.getElementById('range-pickers');
  if (wrap) wrap.classList.toggle('hidden', STATE.format !== 'range');
  const startSel = document.getElementById('range-start');
  const endSel   = document.getElementById('range-end');
  if (startSel && STATE.rangeStart) startSel.value = STATE.rangeStart;
  if (endSel && STATE.rangeEnd)     endSel.value   = STATE.rangeEnd;
}

// Compare two card instances by a single sort method. Returns 0 on tie so
// callers can cascade to the next tiebreaker (see compareCardsChained).
function compareCards(a, b, mode) {
  const ca = STATE.byId.get(a.cardId);
  const cb = STATE.byId.get(b.cardId);
  if (!ca || !cb) return 0;
  switch (mode) {
    case 'cmc': {
      const ba = cmcBucket(ca).sortVal;
      const bb = cmcBucket(cb).sortVal;
      return ba - bb;
    }
    case 'set': {
      const codeA = pickSetForSort(ca);
      const codeB = pickSetForSort(cb);
      const metaA = STATE.setsByCode[codeA];
      const metaB = STATE.setsByCode[codeB];
      const dateA = (metaA && metaA.releasedate) || '';
      const dateB = (metaB && metaB.releasedate) || '';
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      return (codeA || '').localeCompare(codeB || '');
    }
    case 'color': {
      const ka = colorSortKey(ca);
      const kb = colorSortKey(cb);
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    }
    case 'name':
      return ca.canonical.localeCompare(cb.canonical);
    case 'type':
    default:
      return typeRank(ca) - typeRank(cb);
  }
}

// Walk the sort chain: primary first, fall through each subsequent method on
// ties. Always ends with canonical-name as an implicit stable tiebreaker so
// ties don't produce undefined ordering.
function compareCardsChained(a, b, chain) {
  for (const m of chain) {
    const c = compareCards(a, b, m);
    if (c !== 0) return c;
  }
  const ca = STATE.byId.get(a.cardId);
  const cb = STATE.byId.get(b.cardId);
  if (!ca || !cb) return 0;
  return ca.canonical.localeCompare(cb.canonical);
}

// Pick the set code to sort a card under. Cards printed only in PLANE or REV
// (special/testing sets) would otherwise clump at the dates those sets were
// released — not where the card "belongs" flavor-wise. For those, fall back
// to any other printing's set; if none, keep the original.
const SORT_SET_EXCLUDE = new Set(['PLANE', 'REV']);
function pickSetForSort(card) {
  if (!SORT_SET_EXCLUDE.has(card.set)) return card.set;
  const printings = STATE.byCanonical.get(card.canonical) || [];
  const alt = printings.find(p => !SORT_SET_EXCLUDE.has(p.set));
  return alt ? alt.set : card.set;
}

// Build a lexicographically-comparable key from a card's color identity.
// Ordering: WUBRG monocolored → multicolored (by count, then WUBRG sequence)
// → colorless. Matches the conventional MTG chart ordering.
function colorSortKey(card) {
  // card.colors is a joined string ("W", "WU", "WUBRG", ...) — see the
  // card-normalization pass at parse time. Treat it as a string of single-
  // letter color codes.
  const cols = card.colors || '';
  const order = 'WUBRG';
  if (cols.length === 0) return '9';
  if (cols.length === 1) {
    const idx = order.indexOf(cols);
    return '1' + (idx < 0 ? '9' : String(idx));
  }
  const sorted = [...cols]
    .sort((x, y) => order.indexOf(x) - order.indexOf(y))
    .join('');
  // Pad count so '10' doesn't sort before '2'. (Unlikely with real MTG cards
  // but cheap to guard.)
  const pad = String(cols.length).padStart(2, '0');
  return '2' + pad + sorted;
}

function imgUrl(card) {
  const base = `${IMG_BASE}/${card.set}/${encodeURIComponent(card.num)}.jpg`;
  // Cache-busting via cajun's repurposed multiverseId stamp: when an image
  // is updated upstream, the YYYYMMDD changes, so the URL changes, so the
  // browser re-fetches instead of serving its cached copy.
  return card.imgVersion ? `${base}?v=${card.imgVersion}` : base;
}

// Known MTG keywords the deckbuilder recognises for `kw:`. Includes
// evergreen + commonly-seen expert keywords, the "Enchant ..." ability
// keywords, the protection variants we see in Revolution, and the
// set-specific custom keywords found in the current card corpus. The list
// is intentionally the authoritative set — if a card's text starts a line
// with one of these, the card gets tagged. Add new entries here when new
// keywords ship.
//
// Stored lowercased. Multi-word keywords ("first strike", "double strike",
// the landcycling variants, the "enchant X" variants) must appear here
// verbatim so the extractor recognises the space.
const KNOWN_KEYWORDS = [
  // evergreen
  'flying', 'trample', 'vigilance', 'haste', 'first strike', 'double strike',
  'flash', 'deathtouch', 'hexproof', 'indestructible', 'lifelink', 'menace',
  'reach', 'defender', 'shroud', 'ward', 'prowess', 'protection',
  // deciduous / evergreen-ish
  'scry', 'fight',
  // very common expert
  'cycling', 'flashback', 'equip', 'crew', 'dash', 'ninjutsu', 'surveil',
  'exalted', 'wither', 'infect', 'kicker', 'buyback', 'suspend', 'madness',
  'morph', 'echo', 'evoke', 'cascade', 'convoke', 'delve', 'storm',
  'threshold', 'undying', 'unearth', 'persist', 'fading', 'vanishing',
  'graft', 'bestow', 'extort', 'heroic', 'bloodthirst', 'dredge',
  'rebound', 'retrace', 'replicate', 'changeling', 'champion', 'bushido',
  'entwine', 'hideaway', 'transmute', 'soulbond', 'miracle', 'devour',
  'exploit', 'renown', 'afflict', 'embalm', 'eternalize', 'adapt',
  'amass', 'afterlife', 'mutate', 'companion', 'boast', 'foretell',
  'escape', 'encore', 'myriad', 'transform', 'mentor',
  // enchant abilities (count as keywords for kw:)
  'enchant creature', 'enchant land', 'enchant player', 'enchant permanent',
  'enchant artifact', 'enchant enchantment', 'enchant planeswalker',
  // landcycling variants seen in the corpus
  'plainscycling', 'islandcycling', 'swampcycling', 'mountaincycling',
  'forestcycling',
  // Revolution-specific (custom-set keywords found in text)
  'spellcharge', 'surface', 'wander', 'traverse', 'invoke', 'reflect',
  'coalesce', 'multitude', 'cybersoul', 'propagate', 'chant',
  // "Discharge", "Adventure", "Omen", "Prepare" are page-frame mechanic
  // subtypes (see pageData below), not ability keywords — they appear on
  // the page's type line, not as line-start abilities on the main card.
  // Search them via t:/is:page / is:adventure etc.
];

// Reverse-lookup by first word for fast scanning. Single-word keywords map
// to themselves; multi-word keywords map to an array of candidates sharing
// the first word, so "First strike" and "First ..." are both considered
// when a line starts with "First".
const KEYWORD_BY_FIRST_WORD = (() => {
  const m = new Map();
  for (const kw of KNOWN_KEYWORDS) {
    const first = kw.split(' ')[0];
    const arr = m.get(first) || [];
    arr.push(kw);
    // longer keywords first so "first strike" wins over "first" if we ever
    // add both.
    arr.sort((a, b) => b.length - a.length);
    m.set(first, arr);
  }
  return m;
})();

// Parse a type line like "Legendary Creature — Human Wizard" into
// { supertypes, types, subtypes } arrays. Used to synthesize page faces
// whose raw input is just the type-line string (mtgjson doesn't split
// pageData.type into parts). The split character is the em-dash '—' that
// Wizards has used since Magic 2010; no ASCII "-" fallback because the
// deckbuilder's data is all em-dash.
function parseTypeLineParts(line) {
  const SUPERTYPES = new Set([
    'Basic', 'Legendary', 'Ongoing', 'Snow', 'World', 'Host', 'Elite', 'Token',
  ]);
  const raw = String(line || '').trim();
  if (!raw) return { supertypes: [], types: [], subtypes: [] };
  const dashIdx = raw.indexOf('—');
  const leftRaw  = dashIdx < 0 ? raw : raw.slice(0, dashIdx).trim();
  const rightRaw = dashIdx < 0 ? ''  : raw.slice(dashIdx + 1).trim();
  const leftWords = leftRaw.split(/\s+/).filter(Boolean);
  const supertypes = [];
  const types = [];
  for (const w of leftWords) {
    if (SUPERTYPES.has(w)) supertypes.push(w);
    else types.push(w);
  }
  const subtypes = rightRaw ? rightRaw.split(/\s+/).filter(Boolean) : [];
  return { supertypes, types, subtypes };
}

// Walk a mana cost string like "{2}{W}{U/B}{X}" and pull out the distinct
// colors present. Hybrid pips contribute both halves. Returns a subset of
// "WUBRG" as a string (letters sorted in WUBRG order so output is stable).
function colorsFromManaCost(cost) {
  const seen = new Set();
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(cost || '')) !== null) {
    for (const ch of m[1].toUpperCase()) {
      if ('WUBRG'.includes(ch)) seen.add(ch);
    }
  }
  return 'WUBRG'.split('').filter(ch => seen.has(ch)).join('');
}

// Converted mana cost from a raw cost string. Generic integers add their
// literal value; X and most colored / hybrid / Phyrexian pips count as 1.
function cmcFromManaCost(cost) {
  let total = 0;
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(cost || '')) !== null) {
    const p = m[1];
    if (/^\d+$/.test(p)) total += parseInt(p, 10);
    else if (p === 'X' || p === 'Y' || p === 'Z') total += 0;
    else total += 1;
  }
  return total;
}

// Given a card's oracle text, return the deduplicated set of known keywords
// that appear as the first word of a line (optionally followed by a cost,
// a number, an em-dash, a comma, or end-of-line). Reminder text — both the
// italicised `*...*` form used in the deckbuilder data and the
// parenthesised `(...)` form — is stripped first so "Whenever ~ attacks,
// target creature gains flying" doesn't get mis-tagged with `flying` via
// reminder text. Comma-separated keyword lists are also supported
// ("Flying, vigilance").
function extractKeywords(text) {
  if (!text) return [];
  const cleaned = text.replace(/\*[^*]*\*/g, '').replace(/\([^)]*\)/g, '');
  const found = new Set();
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Comma-separated keyword list: split and check each item independently.
    const parts = line.split(/\s*,\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      // First word (strip any trailing cost / punctuation).
      const firstWord = (lower.match(/^([a-z][a-z-]*)/) || [null, null])[1];
      if (!firstWord) continue;
      const candidates = KEYWORD_BY_FIRST_WORD.get(firstWord);
      if (!candidates) continue;
      for (const kw of candidates) {
        if (lower === kw) { found.add(kw); break; }
        // kw followed by space/em-dash/brace/digit = keyword usage
        const after = lower.slice(kw.length, kw.length + 1);
        if (lower.startsWith(kw) && (after === ' ' || after === '—' || after === '{' || after === '' || /\d/.test(after))) {
          found.add(kw);
          break;
        }
      }
    }
  }
  return Array.from(found);
}

// Turn mtgjson's raw `{2}{U/G}{U/G}` into a compact display string. Any
// braced pip containing a slash (hybrid, Phyrexian, monocolor hybrid) gets
// wrapped in parens so the group boundaries survive once the outer braces
// are stripped; the rest of the braces simply drop out.
function formatManaCost(raw) {
  if (!raw) return '';
  return raw.replace(/\{([^}]*\/[^}]*)\}/g, '($1)').replace(/[{}]/g, '');
}

function colorizedMana(cost) {
  // Just colorize WUBRG letters; leave numbers/X alone. Escape HTML entities
  // first so a card data source (upstream JSON, tampered localStorage) can't
  // sneak markup through this path into the DOM. The entity expansions
  // (&amp;, &lt;, etc.) don't contain any uppercase WUBRG, so colorizing the
  // escaped string still hits the right letters.
  if (!cost) return '';
  return escapeHtml(cost)
             .replace(/W/g, '<span class="mana-w">W</span>')
             .replace(/U/g, '<span class="mana-u">U</span>')
             .replace(/B/g, '<span class="mana-b">B</span>')
             .replace(/R/g, '<span class="mana-r">R</span>')
             .replace(/G/g, '<span class="mana-g">G</span>');
}

// ---------------------------------------------------------------------------
// Query parser — scryfall-style search
//
// parseQuery(q) returns
//   { predicate: (card) => bool,
//     sort:      [{ field, desc }, ...],   // from sort:X / -sort:X
//     overridesFormat: bool,               // true if query has f:/legal:/banned:
//     error:     null | "message" }
//
// Grammar (precedence lowest -> highest):
//   expr    := or
//   or      := and ('OR' and)*
//   and     := not ([AND] not)*     // implicit AND between atoms
//   not     := ['NOT' | '-'] atom
//   atom    := '(' expr ')' | '!' NAME | FIELD_OP | BARE | REGEX
//
// An ATOM is one of:
//   !Name                     → exact name match
//   /pattern/                 → regex against card name
//   field<op>value            → operator-specific match
//   bareword                  → case-insensitive substring of card name
// where <op> is one of :  =  !=  ==  <  <=  >  >=
// ---------------------------------------------------------------------------

const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 };
const RARITY_CANON = {
  c: 'common', u: 'uncommon', r: 'rare', m: 'mythic', s: 'special',
  common: 'common', uncommon: 'uncommon', rare: 'rare',
  mythic: 'mythic', special: 'special',
};

// Field aliases → canonical field name. Keys are lowercase.
const FIELD_ALIASES = {
  name: 'name',
  t: 'type', type: 'type',
  o: 'oracle', oracle: 'oracle', text: 'oracle',
  c: 'color', color: 'color',
  ci: 'id', id: 'id', identity: 'id',
  mv: 'mv', cmc: 'mv',
  mana: 'mana',
  pow: 'power', power: 'power',
  tou: 'toughness', toughness: 'toughness',
  loy: 'loyalty', loyalty: 'loyalty',
  def: 'defense', defense: 'defense',
  r: 'rarity', rarity: 'rarity',
  e: 'set', set: 'set', edition: 'set',
  cn: 'cn', number: 'cn', num: 'cn',
  a: 'artist', art: 'artist', artist: 'artist',
  kw: 'kw', keyword: 'kw',
  f: 'format', format: 'format',
  legal: 'legal', banned: 'banned', restricted: 'restricted',
  is: 'is',
  has: 'has',
  ft: 'flavor', flavor: 'flavor',
  in: 'in',
  layout: 'layout',
  sort: 'sort',
};

// Numeric-RHS fields that can also be compared to another field on the card.
const NUMERIC_FIELDS = {
  mv: (c) => Number(c.cmc) || 0,
  cmc: (c) => Number(c.cmc) || 0,
  power: (c) => parseIntOrNaN(c.power),
  pow: (c) => parseIntOrNaN(c.power),
  toughness: (c) => parseIntOrNaN(c.toughness),
  tou: (c) => parseIntOrNaN(c.toughness),
  loyalty: (c) => parseIntOrNaN(c.loyalty),
  loy: (c) => parseIntOrNaN(c.loyalty),
};

function parseIntOrNaN(s) {
  if (s == null || s === '') return NaN;
  const n = parseInt(String(s), 10);
  return isNaN(n) ? NaN : n;
}

// Test `pred` against every printing of a card's canonical; returns true on
// the first hit. Lone prints fall back to `[c]` so a one-printing card still
// gets tested. Used by search predicates whose semantics are "any printing
// satisfies" (rarity, artist, flavor, etc.).
function anyPrinting(c, pred) {
  const ps = STATE.byCanonical.get(c.canonical) || [c];
  return ps.some(pred);
}

// Format-name aliases → canonical legality key (matches the data).
const FORMAT_ALIASES = {
  rev: 'revolution', revolution: 'revolution', standard: 'revolution',
  eternal: 'eternal',
  brawl: 'brawl',
  'eternal-pauper': 'eternal-pauper', pauper: 'eternal-pauper',
  planechase: 'planechase', plane: 'planechase',
  archaeologist: 'archaeologist', arch: 'archaeologist',
};

function canonFormat(name) {
  const k = String(name || '').toLowerCase();
  return FORMAT_ALIASES[k] || k;
}

// ---- Tokenizer ----
//
// Produces a flat list of tokens: { type: 'lparen'|'rparen'|'or'|'and'|'not'|'atom', value? }.
// Atoms include field:value pairs, quoted strings, /regex/, !name, and bare
// terms. Whitespace separates atoms; parens are single-char tokens; a bare
// word 'OR'/'AND'/'NOT' (any case) becomes a keyword token; a leading '-'
// (at start-of-input or after whitespace/paren) becomes a NOT token.

function tokenizeQuery(q) {
  const tokens = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (ch === '-') {
      const prev = i === 0 ? null : q[i - 1];
      const next = i + 1 < n ? q[i + 1] : null;
      if ((prev === null || /\s|\(/.test(prev)) && next !== null && !/\s|\)/.test(next)) {
        tokens.push({ type: 'not' });
        i++;
        continue;
      }
    }
    // Read atom: everything until unescaped whitespace / paren, with quote
    // tracking so "foo bar" and 'foo bar' stay together, and regex /…/
    // where the first char is '/'.
    let atom = '';
    let inQuote = null;   // '"' | "'" | null
    let inRegex = false;
    if (ch === '/') inRegex = true;  // only if atom starts with /
    while (i < n) {
      const c = q[i];
      if (inQuote) {
        atom += c;
        if (c === '\\' && i + 1 < n) { atom += q[i + 1]; i += 2; continue; }
        if (c === inQuote) inQuote = null;
        i++;
        continue;
      }
      if (inRegex) {
        atom += c;
        if (c === '\\' && i + 1 < n) { atom += q[i + 1]; i += 2; continue; }
        if (c === '/' && atom.length > 1) inRegex = false;
        i++;
        continue;
      }
      if (/\s/.test(c) || c === '(' || c === ')') break;
      if (c === '"' || c === "'") { inQuote = c; atom += c; i++; continue; }
      atom += c;
      i++;
    }
    const up = atom.toUpperCase();
    if (up === 'OR') tokens.push({ type: 'or' });
    else if (up === 'AND') tokens.push({ type: 'and' });
    else if (up === 'NOT') tokens.push({ type: 'not' });
    else tokens.push({ type: 'atom', value: atom });
  }
  return tokens;
}

// ---- Parser (recursive descent) ----

function parseQuery(q) {
  const ctx = { sort: [], overridesFormat: false, error: null };
  const trimmed = (q || '').trim();
  if (!trimmed) {
    return { predicate: (_c) => true, sort: [], overridesFormat: false, error: null };
  }
  const tokens = tokenizeQuery(trimmed);
  // sort:X / -sort:X are modifiers, not filters — pull them out of the token
  // stream *before* the parser sees them, so a leading '-' can mean
  // "descending" without also negating a (no-op true) predicate and making
  // the query return nothing.
  extractSortTokens(tokens, ctx);
  // If the query was nothing but sort modifiers, no filter is imposed.
  if (tokens.length === 0) {
    return { predicate: (_c) => true, sort: ctx.sort, overridesFormat: false, error: null };
  }
  const state = { tokens, pos: 0 };
  let predicate;
  try {
    predicate = parseOr(state, ctx);
    if (state.pos < tokens.length) {
      const leftover = tokens[state.pos];
      throw new Error(`unexpected ${leftover.type === 'rparen' ? "')'" : JSON.stringify(leftover.value || leftover.type)}`);
    }
  } catch (e) {
    return { predicate: (_c) => false, sort: [], overridesFormat: false, error: e.message };
  }
  return {
    predicate,
    sort: ctx.sort,
    overridesFormat: ctx.overridesFormat,
    error: null,
  };
}

function peek(state) { return state.tokens[state.pos]; }
function consume(state) { return state.tokens[state.pos++]; }

// Scan the token list for sort:X / -sort:X pairs, record them in ctx.sort,
// and splice them out. Mutates `tokens` in place. If only sort tokens are
// present, an empty token list remains and parse returns a predicate that
// matches everything (the caller's default behaviour).
function extractSortTokens(tokens, ctx) {
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    // `-sort:X`
    if (t.type === 'not' && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      const m = next.type === 'atom' && /^sort[:=]/i.test(next.value)
                  ? next.value.match(/^sort[:=](.*)$/i) : null;
      if (m) {
        ctx.sort.push({ field: stripQuotes(m[1]).toLowerCase(), desc: true });
        tokens.splice(i, 2);
        continue;
      }
    }
    // `sort:X`
    if (t.type === 'atom') {
      const m = t.value.match(/^sort[:=](.*)$/i);
      if (m) {
        ctx.sort.push({ field: stripQuotes(m[1]).toLowerCase(), desc: false });
        tokens.splice(i, 1);
        continue;
      }
    }
    i++;
  }
}

function parseOr(state, ctx) {
  let left = parseAnd(state, ctx);
  while (peek(state) && peek(state).type === 'or') {
    consume(state);
    const right = parseAnd(state, ctx);
    const l = left, r = right;
    left = (c) => l(c) || r(c);
  }
  return left;
}

function parseAnd(state, ctx) {
  let left = parseNot(state, ctx);
  while (peek(state)
         && peek(state).type !== 'or'
         && peek(state).type !== 'rparen') {
    if (peek(state).type === 'and') consume(state);
    const right = parseNot(state, ctx);
    const l = left, r = right;
    left = (c) => l(c) && r(c);
  }
  return left;
}

function parseNot(state, ctx) {
  if (peek(state) && peek(state).type === 'not') {
    consume(state);
    const inner = parseNot(state, ctx);
    return (c) => !inner(c);
  }
  return parseAtomOrGroup(state, ctx);
}

function parseAtomOrGroup(state, ctx) {
  const t = peek(state);
  if (!t) throw new Error('expected atom');
  if (t.type === 'lparen') {
    consume(state);
    const inner = parseOr(state, ctx);
    const close = consume(state);
    if (!close || close.type !== 'rparen') throw new Error("expected ')'");
    return inner;
  }
  if (t.type === 'atom') {
    consume(state);
    return compileAtom(t.value, ctx);
  }
  throw new Error(`unexpected ${t.type}`);
}

// ---- Atom compiler ----

function compileAtom(atom, ctx) {
  // !Name → exact (case-insensitive) name match
  if (atom.startsWith('!')) {
    const name = stripQuotes(atom.slice(1)).toLowerCase();
    return (c) => c.name.toLowerCase() === name || c.canonical.toLowerCase() === name;
  }
  // /regex/ → regex on name (oracle uses field syntax, so this is the bare form)
  if (atom.length >= 2 && atom[0] === '/' && atom[atom.length - 1] === '/') {
    const body = atom.slice(1, -1);
    let re;
    try { re = new RegExp(body, 'i'); }
    catch (e) { throw new Error(`bad regex /${body}/`); }
    return (c) => re.test(c.name) || re.test(c.canonical);
  }
  // field<op>value?
  const m = atom.match(/^([a-zA-Z][a-zA-Z0-9_-]*?)(:|!=|==|<=|>=|=|<|>)(.*)$/);
  if (m) {
    const fieldRaw = m[1].toLowerCase();
    const op = m[2];
    const value = m[3];
    const field = FIELD_ALIASES[fieldRaw];
    if (!field) {
      // Not a recognized field → treat as bare term (e.g. a word that
      // happens to contain a colon: `ex:ample` → substring of name).
      return bareNamePredicate(atom);
    }
    // Empty operator value (`t:`, `o:`, `c:` with nothing after the colon)
    // would otherwise fall through to a substring-matches-everything or a
    // no-color-letters-means-match-all. Reject at the atom level so that
    // typing `t:` mid-query doesn't flood the dropdown with every card.
    // mana={} is the one exception (value is `{}`, not empty).
    if (value === '' && field !== 'sort') {
      return (_c) => false;
    }
    return buildFieldPredicate(field, op, value, ctx);
  }
  // Bare term
  return bareNamePredicate(atom);
}

function bareNamePredicate(atom) {
  const needle = stripQuotes(atom).toLowerCase();
  if (!needle) return (_c) => true;
  return (c) => c.name.toLowerCase().includes(needle)
             || c.canonical.toLowerCase().includes(needle);
}

function stripQuotes(s) {
  if (s.length >= 2
      && ((s[0] === '"' && s[s.length - 1] === '"')
       || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

// Parse a list value like "MON" / "MON,CCR,TRX" / "(MON, CCR)" / quoted.
function parseListValue(raw) {
  const stripped = stripQuotes(raw);
  // Parenthesised (a, b, c)
  const inner = stripped.match(/^\(\s*(.*?)\s*\)$/);
  if (inner) return inner[1].split(/\s*,\s*/).filter(Boolean);
  if (stripped.includes(',')) return stripped.split(/\s*,\s*/).filter(Boolean);
  return [stripped];
}

// Turn a regex literal /foo/ or a bare needle into a test fn over a string.
function stringMatcher(rawValue) {
  const v = String(rawValue);
  if (v.length >= 2 && v[0] === '/' && v[v.length - 1] === '/') {
    const re = new RegExp(v.slice(1, -1), 'i');
    return (s) => re.test(String(s || ''));
  }
  const needle = stripQuotes(v).toLowerCase();
  return (s) => String(s || '').toLowerCase().includes(needle);
}

// Compile a numeric-ish RHS. Handles: 4, >=4, ==4, odd/even/prime keywords,
// or another card field (pow vs tou, tou=mv, etc). Returns
// { compare: (lhs, card) => bool, isFieldRef: bool }.
function compileNumericRhs(op, rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  const fieldRef = NUMERIC_FIELDS[v];
  if (fieldRef) {
    return {
      compare: (lhs, card) => numericCompare(op, lhs, fieldRef(card)),
      isFieldRef: true,
    };
  }
  if (v === 'odd' || v === 'even' || v === 'prime') {
    return {
      compare: (lhs, _card) => {
        if (!Number.isFinite(lhs)) return false;
        if (v === 'odd') return lhs % 2 === 1;
        if (v === 'even') return lhs % 2 === 0;
        if (v === 'prime') return isPrime(lhs);
        return false;
      },
      isFieldRef: false,
    };
  }
  const n = Number(v);
  if (!isFinite(n)) return { compare: (_l, _c) => false, isFieldRef: false };
  return { compare: (lhs, _c) => numericCompare(op, lhs, n), isFieldRef: false };
}

function numericCompare(op, a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (op) {
    case ':':
    case '=':
    case '==': return a === b;
    case '!=': return a !== b;
    case '<':  return a < b;
    case '<=': return a <= b;
    case '>':  return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

function isPrime(n) {
  if (n < 2 || !Number.isInteger(n)) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

// Split a cost string "{2}{W}{U/G}{X}" into an array of pips (upper-cased,
// braces stripped, hybrid/Phyrexian preserved with the slash):
//   "{2}{W}{U/G}" → ["2", "W", "U/G"]
function splitCostPips(raw) {
  if (!raw) return [];
  const pips = [];
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) pips.push(m[1].toUpperCase());
  return pips;
}

// Canonicalise color letters / multi / colorless / count specifiers.
// Returns { kind: 'count'|'multi'|'colorless'|'letters', value: number|null, letters: 'WUBRG' subset }.
function parseColorSpec(raw) {
  const v = stripQuotes(raw).toLowerCase();
  if (/^\d+$/.test(v)) return { kind: 'count', value: parseInt(v, 10), letters: '' };
  if (v === 'm' || v === 'multi' || v === 'multicolor') return { kind: 'multi', letters: '' };
  if (v === 'c' || v === 'colorless') return { kind: 'colorless', letters: '' };
  const letters = [];
  for (const ch of v) {
    if ('wubrg'.includes(ch)) letters.push(ch.toUpperCase());
  }
  return { kind: 'letters', letters: letters.join('') };
}

// ---- Field predicate builders ----

function buildFieldPredicate(field, op, rawValue, ctx) {
  switch (field) {
    case 'name':       return buildNamePredicate(op, rawValue);
    case 'type':       return buildTypePredicate(op, rawValue);
    case 'oracle':     return buildOraclePredicate(op, rawValue);
    case 'color':      return buildColorPredicate('colors', op, rawValue);
    case 'id':         return buildColorPredicate('ci', op, rawValue);
    case 'mv':         return buildNumericPredicate((c) => Number(c.cmc) || 0, op, rawValue);
    case 'mana':       return buildManaPredicate(op, rawValue);
    case 'power':      return buildNumericPredicate((c) => parseIntOrNaN(c.power), op, rawValue);
    case 'toughness':  return buildNumericPredicate((c) => parseIntOrNaN(c.toughness), op, rawValue);
    case 'loyalty':    return buildNumericPredicate((c) => parseIntOrNaN(c.loyalty), op, rawValue);
    case 'defense':    return (_c) => false;  // no defense data — see SEARCH_SKIPPED.md
    case 'rarity':     return buildRarityPredicate(op, rawValue);
    case 'set':        return buildSetPredicate(op, rawValue);
    case 'cn':         return buildNumericPredicate((c) => parseIntOrNaN(c.num), op, rawValue);
    case 'artist':     return buildArtistPredicate(op, rawValue);
    case 'kw':         return buildKeywordPredicate(op, rawValue);
    case 'format':     ctx.overridesFormat = true;
                       return buildFormatPredicate('legal', rawValue);
    case 'legal':      ctx.overridesFormat = true;
                       return buildFormatPredicate('legal', rawValue);
    case 'banned':     ctx.overridesFormat = true;
                       return buildFormatPredicate('banned', rawValue);
    case 'restricted': ctx.overridesFormat = true;
                       return buildFormatPredicate('restricted', rawValue);
    case 'is':         return buildIsPredicate(rawValue);
    case 'has':        return buildHasPredicate(rawValue);
    case 'flavor':     return buildFlavorPredicate(op, rawValue);
    case 'in':         return buildInPredicate(op, rawValue);
    case 'layout':     return buildLayoutPredicate(op, rawValue);
    case 'sort':       {
      // Unreachable — extractSortTokens strips sort atoms before parse.
      // Keep the case for safety if the preprocessor ever misses one.
      ctx.sort.push({ field: stripQuotes(rawValue).toLowerCase(), desc: false });
      return (_c) => true;
    }
    default:           return (_c) => false;
  }
}

function buildNamePredicate(op, rawValue) {
  const matcher = stringMatcher(rawValue);
  if (op === '=' || op === '==') {
    const needle = stripQuotes(rawValue).toLowerCase();
    return (c) => c.name.toLowerCase() === needle || c.canonical.toLowerCase() === needle;
  }
  return (c) => matcher(c.name) || matcher(c.canonical);
}

function buildTypePredicate(op, rawValue) {
  const matcher = stringMatcher(rawValue);
  // Face-level matching: each face (main card + page face) is tested
  // independently, so `t:` only scans the *current* face's own type line.
  // Page subtypes (Adventure / Discharge) are reachable via `t:adventure`
  // because the page face's own type is "Instant — Adventure" etc.
  if (op === ':') {
    return (c) => matcher(c.type || '');
  }
  const words = stripQuotes(rawValue)
    .split(/\s+/).map(s => s.toLowerCase()).filter(Boolean);
  const normaliseTypes = (c) => {
    const all = [].concat(c.supertypes || [], c.types || [], c.subtypes || []);
    return all.map(s => s.toLowerCase());
  };
  if (op === '=' || op === '>=') {
    // all listed words are present on the card
    return (c) => {
      const ts = normaliseTypes(c);
      return words.every(w => ts.includes(w));
    };
  }
  if (op === '<=') {
    // card's types are a subset of the listed words
    return (c) => {
      const ts = normaliseTypes(c);
      return ts.every(t => words.includes(t));
    };
  }
  if (op === '==') {
    // exactly the same set (order-insensitive, case-insensitive)
    return (c) => {
      const ts = normaliseTypes(c);
      if (ts.length !== words.length) return false;
      const tsSet = new Set(ts);
      return words.every(w => tsSet.has(w));
    };
  }
  return (c) => matcher(c.type || '');
}

function buildKeywordPredicate(_op, rawValue) {
  const needle = stripQuotes(rawValue).toLowerCase();
  if (!needle) return (_c) => false;
  // `card.keywords` is precomputed in parseAllSetsJson — see extractKeywords().
  return (c) => Array.isArray(c.keywords) && c.keywords.includes(needle);
}

function buildOraclePredicate(op, rawValue) {
  // ~ is replaced by the card's name (or front-canonical for split/DFC).
  const raw = rawValue;
  // If /regex/, use it directly; otherwise substring.
  const isRegex = raw.length >= 2 && raw[0] === '/' && raw[raw.length - 1] === '/';
  if (isRegex) {
    const body = raw.slice(1, -1);
    // Expand shortcut sequences: \spt \spp \smm \spm \smp \sbd \sm \smr \smh \sc
    const expanded = expandOracleShortcuts(body);
    let re;
    try { re = new RegExp(expanded, 'i'); }
    catch (e) { throw new Error(`bad regex /${body}/`); }
    return (c) => {
      const text = oracleTextFor(c);
      return re.test(text);
    };
  }
  const needle = stripQuotes(raw);
  return (c) => {
    const text = oracleTextFor(c);
    const hay = text.toLowerCase();
    const nee = needle.toLowerCase().replace(/~/g, c.canonical.toLowerCase());
    if (!nee) return true;
    return hay.includes(nee);
  };
}

function oracleTextFor(c) {
  // Combine front + back for double-faced so o: hits either side.
  const front = c.text || '';
  const back = (c.back && c.back.text) || '';
  return back ? (front + '\n' + back) : front;
}

// Expand the oracle-regex shortcut sequences from the search spec.
function expandOracleShortcuts(body) {
  const subs = [
    [/\\spt/g,  '[+-]?\\d+/[+-]?\\d+'],
    [/\\spp/g,  '\\+\\d+/\\+\\d+'],
    [/\\smm/g,  '-\\d+/-\\d+'],
    [/\\spm/g,  '\\+\\d+/-\\d+'],
    [/\\smp/g,  '-\\d+/\\+\\d+'],
    [/\\sbd/g,  '[+-]?\\d+/[+-]?\\d+'],
    [/\\smr/g,  '\\{[WUBRG]\\}\\{[WUBRG]\\}'],
    [/\\smh/g,  '\\{[WUBRG]/[WUBRG]\\}'],
    [/\\sc/g,   '\\{[WUBRG]\\}'],
    [/\\sm/g,   '\\{[^}]+\\}'],
  ];
  let out = body;
  for (const [pat, rep] of subs) out = out.replace(pat, rep);
  return out;
}

function buildColorPredicate(fieldKey, op, rawValue) {
  const spec = parseColorSpec(rawValue);
  const colorsOf = (c) => (c[fieldKey] || '').toUpperCase();
  return (c) => {
    const cs = colorsOf(c);
    if (spec.kind === 'count') {
      return cs.length === spec.value;
    }
    if (spec.kind === 'multi') {
      if (op === '=' || op === '==') return cs.length >= 2;
      return cs.length >= 2;
    }
    if (spec.kind === 'colorless') {
      if (op === '=' || op === '==' || op === ':') return cs.length === 0;
      return cs.length === 0;
    }
    const want = spec.letters;
    const wantSet = new Set(want);
    const haveSet = new Set(cs);
    if (op === ':' || op === '>=') {
      // card includes all query letters
      for (const l of want) if (!haveSet.has(l)) return false;
      return true;
    }
    if (op === '=' || op === '==') {
      if (haveSet.size !== wantSet.size) return false;
      for (const l of want) if (!haveSet.has(l)) return false;
      return true;
    }
    if (op === '<=') {
      // card's colors are subset of query
      for (const l of cs) if (!wantSet.has(l)) return false;
      return true;
    }
    if (op === '<') {
      if (haveSet.size >= wantSet.size) return false;
      for (const l of cs) if (!wantSet.has(l)) return false;
      return true;
    }
    if (op === '>') {
      if (haveSet.size <= wantSet.size) return false;
      for (const l of want) if (!haveSet.has(l)) return false;
      return true;
    }
    if (op === '!=') {
      if (haveSet.size !== wantSet.size) return true;
      for (const l of want) if (!haveSet.has(l)) return true;
      return false;
    }
    return false;
  };
}

function buildNumericPredicate(extract, op, rawValue) {
  const { compare } = compileNumericRhs(op, rawValue);
  return (c) => compare(extract(c), c);
}

function buildManaPredicate(op, rawValue) {
  const raw = stripQuotes(rawValue);
  // mana={} → no mana cost
  if (raw === '{}' || raw === '') {
    return (c) => !(c.rawManaCost && c.rawManaCost.length);
  }
  // Bare integer → CMC equality shortcut (spec: mana=1 → cost is literally {1})
  if (/^\d+$/.test(raw) && (op === '=' || op === '==')) {
    const want = `{${raw}}`;
    return (c) => (c.rawManaCost || '').toUpperCase() === want;
  }
  // Pip-pattern matching
  const queryPips = splitPipPattern(raw);
  const cardPipsFn = (c) => splitCostPips(c.rawManaCost);
  // mana>=UU means "the card's cost contains at least the query pips"
  // mana<=UU means "the card's cost is a subset of the query pips"
  // mana:UU / mana=UU means "the card has exactly these pips (any order)"
  if (op === '>=' || op === ':') {
    return (c) => containsPips(cardPipsFn(c), queryPips);
  }
  if (op === '<=') {
    return (c) => containsPips(queryPips, cardPipsFn(c));
  }
  if (op === '=' || op === '==') {
    return (c) => samePips(cardPipsFn(c), queryPips);
  }
  if (op === '!=') {
    return (c) => !samePips(cardPipsFn(c), queryPips);
  }
  return (_c) => false;
}

// Turn a user-typed pip pattern like "UU", "B/G", "h", "mmm", "mno" into an
// ordered list of pip-matchers. Each matcher is one of:
//   {kind:'exact', pip:'U'}          — a specific mana symbol
//   {kind:'hybrid'}                  — any single hybrid pip (h)
//   {kind:'any-color'}               — any single colored pip (c)
//   {kind:'var', label:'m'|'n'|'o'}  — 'same color as the 'm' group', etc.
function splitPipPattern(raw) {
  // Split by '/' only if it's a multi-pip (UU) vs single hybrid (U/G).
  // If the string contains '/', treat the whole thing as a single hybrid pip.
  const v = raw.toUpperCase();
  if (v.includes('/')) {
    return [{ kind: 'exact', pip: v.replace(/[{}]/g, '') }];
  }
  const pips = [];
  for (const ch of v) {
    if (ch === 'H') pips.push({ kind: 'hybrid' });
    else if ('MNO'.includes(ch)) pips.push({ kind: 'var', label: ch });
    else if (ch === 'C') pips.push({ kind: 'any-color' });
    else if ('WUBRGXP'.includes(ch)) pips.push({ kind: 'exact', pip: ch });
    else if (/\d/.test(ch)) pips.push({ kind: 'exact', pip: ch });
  }
  return pips;
}

function pipMatches(matcher, cardPip, varBindings) {
  if (matcher.kind === 'exact') {
    return cardPip === matcher.pip;
  }
  if (matcher.kind === 'hybrid') {
    return /^[WUBRG]\/[WUBRG]$|^2\/[WUBRG]$|^[WUBRG]\/P$/.test(cardPip);
  }
  if (matcher.kind === 'any-color') {
    return /^[WUBRG]$/.test(cardPip);
  }
  if (matcher.kind === 'var') {
    if (!/^[WUBRG]$/.test(cardPip)) return false;
    const prior = varBindings[matcher.label];
    if (matcher.label === 'm') {
      if (prior == null) { varBindings[matcher.label] = cardPip; return true; }
      return prior === cardPip;
    }
    // 'n' = different from 'm'; 'o' = different from m and n
    const m = varBindings.m;
    if (matcher.label === 'n') {
      if (m != null && cardPip === m) return false;
      if (prior == null) { varBindings[matcher.label] = cardPip; return true; }
      return prior === cardPip;
    }
    if (matcher.label === 'o') {
      if (m != null && cardPip === m) return false;
      const n = varBindings.n;
      if (n != null && cardPip === n) return false;
      if (prior == null) { varBindings[matcher.label] = cardPip; return true; }
      return prior === cardPip;
    }
    return false;
  }
  return false;
}

// Does the card's pip list contain a match for every matcher in the query?
// Greedy consumption with backtracking on variable bindings — but since
// queries are short (<=6 pips typical), brute force is fine.
function containsPips(cardPips, queryPips) {
  const used = new Array(cardPips.length).fill(false);
  const bindings = {};
  return tryMatchAll(queryPips, 0, cardPips, used, bindings);
}

function tryMatchAll(queryPips, qi, cardPips, used, bindings) {
  if (qi >= queryPips.length) return true;
  const matcher = queryPips[qi];
  for (let ci = 0; ci < cardPips.length; ci++) {
    if (used[ci]) continue;
    const savedM = bindings.m, savedN = bindings.n, savedO = bindings.o;
    if (pipMatches(matcher, cardPips[ci], bindings)) {
      used[ci] = true;
      if (tryMatchAll(queryPips, qi + 1, cardPips, used, bindings)) return true;
      used[ci] = false;
    }
    bindings.m = savedM; bindings.n = savedN; bindings.o = savedO;
  }
  return false;
}

// "Same pips" for mana=XYZ: same total pip count AND every query matcher
// consumes a card pip (same greedy match as containsPips). That's the
// intuitive reading — mana=WU hits {W}{U} but not {W}{U}{2}.
function samePips(cardPips, queryPips) {
  if (cardPips.length !== queryPips.length) return false;
  return containsPips(cardPips, queryPips);
}

function buildRarityPredicate(op, rawValue) {
  const raw = stripQuotes(rawValue).toLowerCase();
  const canon = RARITY_CANON[raw];
  if (!canon) return (_c) => false;
  const want = RARITY_RANK[canon];
  // Rarity varies across reprints (e.g. rare → mythic on a reprint). Match
  // any printing that satisfies the op, mirroring Cockatrice's behaviour.
  return (c) => anyPrinting(c, p => {
    const have = RARITY_RANK[p.rarity];
    if (have == null) return false;
    return numericCompare(op, have, want);
  });
}

function buildSetPredicate(op, rawValue) {
  const values = parseListValue(rawValue).map(v => v.toLowerCase());
  if (!values.length) return (_c) => false;
  return (c) => {
    // A canonical card matches if any of its printings matches.
    const printings = STATE.byCanonical.get(c.canonical) || [c];
    for (const p of printings) {
      const code = (p.set || '').toLowerCase();
      const setObj = STATE.setsByCode[p.set];
      const name = setObj ? (setObj.longname || '').toLowerCase() : '';
      for (const v of values) {
        if (op === '=' || op === '==') {
          if (code === v || name === v) return true;
        } else {
          if (code.includes(v) || (name && name.includes(v))) return true;
        }
      }
    }
    return false;
  };
}

function buildArtistPredicate(op, rawValue) {
  const matcher = stringMatcher(rawValue);
  // Match across any printing of the canonical — so a reprint with different
  // art still hits.
  return (c) => anyPrinting(c, p => matcher(p.artist || ''));
}

function buildFormatPredicate(status, rawValue) {
  const fmt = canonFormat(stripQuotes(rawValue));
  // status is a fixed value ('legal' / 'banned' / 'restricted')
  return (c) => (c.legalities && c.legalities[fmt]) === status;
}

function buildIsPredicate(rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  switch (v) {
    case 'permanent': {
      const bad = new Set(['instant', 'sorcery']);
      return (c) => !(c.types || []).some(t => bad.has(String(t).toLowerCase()));
    }
    case 'split':     return (c) => c.layout === 'split';
    case 'mdfc':      return (c) => c.layout === 'modal_dfc';
    case 'transform': return (c) => c.layout === 'transform';
    case 'saga':      return (c) => c.layout === 'saga';
    case 'class':     return (c) => c.layout === 'class';
    case 'planar':    return (c) => c.layout === 'planar';
    case 'reprint':   return (c) => {
      const arr = STATE.byCanonical.get(c.canonical) || [c];
      return arr.length > 1;
    };
    // Page mechanics — `is:page` matches any second-spell card. The
    // specific Revolution subtypes are adventure and discharge; the
    // upstream corpus has no omen / prepare yet, so we don't wire them.
    case 'page':      return (c) => !!c.pageData;
    case 'adventure':
    case 'discharge': return (c) => !!(c.pageData
                                      && c.pageData.type
                                      && c.pageData.type.toLowerCase().includes(v));
    // Rarity shortcuts the spec mentions under "Search by Rarity"
    case 'common':
    case 'uncommon':
    case 'rare':
    case 'mythic':
    case 'special':   return (c) => c.rarity === v;
    default:          return (_c) => false;  // see SEARCH_SKIPPED.md
  }
}

function buildHasPredicate(rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  if (v === 'flavor' || v === 'flavour') {
    return (c) => anyPrinting(c, p => p.flavor && p.flavor.trim());
  }
  if (v === 'oracle' || v === 'text')    return (c) => !!(c.text && c.text.trim());
  if (v === 'power')                     return (c) => Number.isFinite(parseIntOrNaN(c.power));
  if (v === 'toughness')                 return (c) => Number.isFinite(parseIntOrNaN(c.toughness));
  if (v === 'loyalty')                   return (c) => Number.isFinite(parseIntOrNaN(c.loyalty));
  return (_c) => false;
}

function buildFlavorPredicate(_op, rawValue) {
  const matcher = stringMatcher(rawValue);
  // Flavor text is per-printing; match if any printing has text hitting.
  return (c) => anyPrinting(c, p => matcher(p.flavor || ''));
}

function buildInPredicate(_op, rawValue) {
  // in:common → ever printed at common (any printing of the canonical)
  const raw = stripQuotes(rawValue).toLowerCase();
  const canon = RARITY_CANON[raw];
  if (canon) {
    return (c) => anyPrinting(c, p => p.rarity === canon);
  }
  // Fall back to set code if not a rarity
  return (c) => anyPrinting(c, p => (p.set || '').toLowerCase() === raw);
}

function buildLayoutPredicate(_op, rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  return (c) => String(c.layout || '').toLowerCase() === v;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function wireSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    runSearch(input.value);
    // Typing changes the result set; the old preview is for a card that
    // may no longer be focused. Hide it until the user interacts again.
    hidePreview();
    // In panel mode, typing implies the user wants to see results — swing
    // the pile pane to the Search tab automatically.
    if (STATE.searchPanel && STATE.focusedZone !== 'search') setFocusedZone('search');
  });

  input.addEventListener('keydown', (ev) => {
    const r = STATE.search.results;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (r.length === 0) return;
      STATE.search.selectedIdx = (STATE.search.selectedIdx + 1) % r.length;
      renderSearchResults();
      showFocusedResultPreview();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (r.length === 0) return;
      STATE.search.selectedIdx = (STATE.search.selectedIdx - 1 + r.length) % r.length;
      renderSearchResults();
      showFocusedResultPreview();
    } else if (ev.key === 'Tab' && ev.shiftKey) {
      // Shift+Tab cycles backward through the highlighted result's
      // printings (oldest direction; wraps at zero). The picked printing
      // is what Enter / click adds and what the chip strip highlights.
      if (r.length === 0) return;
      ev.preventDefault();
      const item = r[STATE.search.selectedIdx];
      if (item && item.printings.length > 1) {
        const n = item.printings.length;
        item.pickedIdx = (item.pickedIdx - 1 + n) % n;
        renderSearchResults();
        showFocusedResultPreview();
      }
    } else if (ev.key === 'Tab') {
      // Tab "picks" the highlighted result into the search box for refinement.
      if (r.length === 0) return;
      ev.preventDefault();
      const item = r[STATE.search.selectedIdx];
      input.value = item.canonical;
      runSearch(input.value);
    } else if (ev.key === 'Enter') {
      if (r.length === 0) return;
      ev.preventDefault();
      const item = r[STATE.search.selectedIdx];
      const picked = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
      const zone = ev.shiftKey ? 'maybe' : (ev.altKey ? 'side' : 'main');
      addCardToZone(picked.id, zone);
      // Don't clear input — power users repeatedly add the same card by hitting Enter 4x.
      // But do refocus and reset selection.
      renderSearchResults();
      renderAll();
    } else if (ev.key === 'Escape') {
      results.classList.add('hidden');
      hidePreview();
      input.blur();
    }
  });

  input.addEventListener('focus', () => {
    if (STATE.searchPanel) return;
    if (STATE.search.results.length > 0) results.classList.remove('hidden');
  });

  document.addEventListener('click', (ev) => {
    if (!input.contains(ev.target) && !results.contains(ev.target)) {
      results.classList.add('hidden');
      hidePreview();
    }
  });
}

// Cap on how many result rows the dropdown renders. Not a "top N by
// relevance" cut — the list is scrollable, this just keeps the DOM small for
// broad queries like `t:creature`.
const SEARCH_RESULT_CAP = 300;

function runSearch(q) {
  const raw = (q || '').trim();
  const results = document.getElementById('search-results');
  // Hide the dropdown on empty input. A bare one-char query like "f" is
  // almost never what the user meant; keep the old min-2-char guard, but
  // only when there are no operator-looking characters.
  const looksStructured = /[:<>=!/"'()]/.test(raw) || /\s(?:AND|OR|NOT)\s/i.test(raw);
  if (!raw || (!looksStructured && raw.length < 2)) {
    STATE.search.results = [];
    results.classList.add('hidden');
    STATE.search.error = null;
    renderSearchError();
    hidePreview();
    if (STATE.searchPanel) {
      updateSearchZoneCount();
      if (STATE.focusedZone === 'search') renderPiles();
    }
    return;
  }

  const parsed = parseQuery(raw);
  STATE.search.error = parsed.error;
  renderSearchError();

  // Parse error → surface the error ribbon and render an empty list. Doing a
  // fallback substring match here just mixes garbage results in with the
  // error, which is confusing. (`fallbackNamePredicate` is kept in case we
  // later decide to use it for specific recoverable errors.)
  if (parsed.error) {
    STATE.search.results = [];
    STATE.search.selectedIdx = 0;
    renderSearchResults();
    hidePreview();
    return;
  }
  const predicate = parsed.predicate;

  const seenCanon = new Set();
  const items = [];
  for (const c of STATE.cards) {
    // Format-operator queries override the global isLegal toggle; otherwise
    // results stay restricted to the toggle's format just like before.
    if (!parsed.overridesFormat && !isLegal(c)) continue;
    if (seenCanon.has(c.canonical)) continue;
    // Face-level matching: a page card has two faces — the creature main
    // and the page spell. A query must match *one complete face* to hit;
    // it can't mix "t:creature" from the main with "c:w" from the page.
    // `card.pageFace` is synthesized at parse time; non-page cards have
    // only one face.
    if (!facesMatch(c, predicate)) continue;
    seenCanon.add(c.canonical);
    const allPrintings = STATE.byCanonical.get(c.canonical) || [c];
    const printings = parsed.overridesFormat
      ? allPrintings
      : allPrintings.filter(isLegal);
    if (printings.length === 0) continue;
    items.push({
      canonical: c.canonical,
      printings,
      pickedIdx: printings.length - 1,
    });
  }
  sortSearchItems(items, parsed.sort);
  STATE.search.results = items.slice(0, SEARCH_RESULT_CAP);
  STATE.search.selectedIdx = 0;
  renderSearchResults();
}

// Evaluate the parsed predicate against each of the card's faces and
// return true if any one face satisfies the whole predicate. A face is
// either the card itself (the main side) or, for page cards, the
// synthesized pageFace. This preserves the user-visible rule that a query
// like `t:creature c:w` can't mix "creature" from the main with "white"
// from the page — one face must carry both.
function facesMatch(card, predicate) {
  if (predicate(card)) return true;
  if (card.pageFace && predicate(card.pageFace)) return true;
  return false;
}

// Used when the parser reports an error: fall back to substring-on-name so
// partial / mid-typing queries still produce something useful.
function fallbackNamePredicate(raw) {
  const needle = raw.toLowerCase();
  return (c) => c.name.toLowerCase().includes(needle)
             || c.canonical.toLowerCase().includes(needle);
}

// Sort the result list. Default is alphabetical by canonical name. sort:X
// entries from the parsed query can override — pull a value for the chosen
// field, ties broken by canonical name. A leading -sort desc direction is
// stored as desc=true on the entry (currently always false — the grammar
// accepts -sort:mv but we treat the minus as NOT and drop the sort; see
// the FIXME below if we want proper descending support).
function sortSearchItems(items, sortSpec) {
  const specs = (sortSpec && sortSpec.length) ? sortSpec : null;
  if (!specs) {
    items.sort((a, b) => a.canonical.localeCompare(b.canonical));
    return;
  }
  const keyFns = specs.map(s => sortKeyFn(s.field)).filter(Boolean);
  items.sort((a, b) => {
    // Use the "picked" printing (newest legal) as the representative for
    // field lookups — that's what the user sees in the row meta.
    const ac = a.printings[a.printings.length - 1];
    const bc = b.printings[b.printings.length - 1];
    for (let i = 0; i < keyFns.length; i++) {
      const va = keyFns[i](ac), vb = keyFns[i](bc);
      const desc = specs[i].desc;
      // NaN means "no meaningful value" (variable power/toughness like *,
      // missing loyalty, etc.). Always sort NaNs to the end, regardless of
      // direction — reversing sort shouldn't promote "no value" to the top.
      const aNaN = typeof va === 'number' && !Number.isFinite(va);
      const bNaN = typeof vb === 'number' && !Number.isFinite(vb);
      if (aNaN && !bNaN) return 1;
      if (!aNaN && bNaN) return -1;
      if (aNaN && bNaN) continue;
      const cmp = compareAny(va, vb);
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return a.canonical.localeCompare(b.canonical);
  });
}

function sortKeyFn(field) {
  switch (field) {
    case 'name':      return (c) => c.canonical.toLowerCase();
    case 'cmc':
    case 'mv':        return (c) => Number(c.cmc) || 0;
    case 'power':
    case 'pow':       return (c) => parseIntOrNaN(c.power);
    case 'toughness':
    case 'tou':       return (c) => parseIntOrNaN(c.toughness);
    case 'rarity':    return (c) => RARITY_RANK[c.rarity] ?? -1;
    case 'set':       return (c) => c.set || '';
    case 'color':     return (c) => (c.colors || '').length;
    default:          return (c) => c.canonical.toLowerCase();
  }
}

function compareAny(a, b) {
  const aNaN = typeof a === 'number' && !Number.isFinite(a);
  const bNaN = typeof b === 'number' && !Number.isFinite(b);
  if (aNaN && bNaN) return 0;
  if (aNaN) return 1;    // NaNs sort last
  if (bNaN) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function renderSearchResults() {
  const results = document.getElementById('search-results');
  // In panel mode the dropdown is suppressed; results are shown in the pile
  // pane. Re-render that pane whenever results change, and keep the Search
  // zone's header count live.
  if (STATE.searchPanel) {
    results.classList.add('hidden');
    results.innerHTML = '';
    updateSearchZoneCount();
    if (STATE.focusedZone === 'search') renderPiles();
    return;
  }
  const r = STATE.search.results;
  if (r.length === 0) {
    results.classList.add('hidden');
    results.innerHTML = '';
    return;
  }
  results.classList.remove('hidden');
  results.innerHTML = '';
  r.forEach((item, i) => {
    // The "picked" printing is what Enter / row-click will add, what the
    // chip strip highlights, and what the row's mana / type meta reflects.
    // Defaults to the newest printing; Shift+Tab and chip clicks move it.
    if (item.pickedIdx == null || item.pickedIdx >= item.printings.length) {
      item.pickedIdx = item.printings.length - 1;
    }
    const picked = item.printings[item.pickedIdx];
    const el = document.createElement('div');
    el.className = 'result' + (i === STATE.search.selectedIdx ? ' selected' : '');

    const head = document.createElement('div');
    head.className = 'result-head';
    head.innerHTML = `
      <span class="name">${escapeHtml(item.canonical)}</span>
      <span>
        <span class="mana">${colorizedMana(picked.manacost)}</span>
        <span class="meta">${escapeHtml(picked.maintype || '')}</span>
      </span>`;
    el.appendChild(head);

    el.addEventListener('mouseenter', (ev) => {
      if (STATE.search.selectedIdx !== i) {
        STATE.search.selectedIdx = i;
        renderSearchResults();
      }
      // Show the big card preview for the hovered row. Uses avoidEl so
      // it docks next to the row instead of following the cursor (nicer
      // when the cursor is over the row itself).
      const picked = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
      showPreview(picked, ev, el);
    });
    el.addEventListener('mousemove', (ev) => positionPreview(ev));
    el.addEventListener('mouseleave', hidePreview);
    // preventDefault on mousedown stops the search input from blurring on
    // mouse users; the actual add happens in click, which fires reliably on
    // touch devices / assistive tech where mousedown may not.
    el.addEventListener('mousedown', (ev) => ev.preventDefault());
    el.addEventListener('click', (ev) => {
      // Chip clicks bubble up here too — but the chip handler stopPropagation()s
      // before we get called, so reaching this code means "row body was clicked",
      // which adds whichever printing is currently picked.
      const zone = ev.shiftKey ? 'maybe' : (ev.altKey ? 'side' : 'main');
      addCardToZone(item.printings[item.pickedIdx].id, zone);
      renderAll();
      document.getElementById('search').focus();
    });

    // Per-printing chips: only render on the highlighted row, and only when
    // there's more than one printing to choose from. Clicking a chip both
    // sets the picked printing AND adds it; Shift+Tab also walks the
    // pickedIdx without adding (so power users can cycle and then Enter).
    if (i === STATE.search.selectedIdx && item.printings.length > 1) {
      const chips = document.createElement('div');
      chips.className = 'printing-chips';
      item.printings.forEach((p, pi) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'printing-chip';
        if (pi === item.pickedIdx) chip.classList.add('picked');
        chip.textContent = p.variant || p.set;
        const setMeta = STATE.setsByCode[p.set];
        const baseTitle = setMeta
          ? `${setMeta.longname || p.set} (${setMeta.releasedate || '?'})\nClick to add this printing`
          : p.set;
        chip.dataset.title = p.variant ? `${p.variant} — ${baseTitle}` : baseTitle;
        chip.addEventListener('mousedown', (ev) => {
          // Stop the parent .result's mousedown handling and the input
          // blur it would otherwise cause.
          ev.preventDefault();
          ev.stopPropagation();
        });
        chip.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          item.pickedIdx = pi;
          const zone = ev.shiftKey ? 'maybe' : (ev.altKey ? 'side' : 'main');
          addCardToZone(p.id, zone);
          renderAll();
          document.getElementById('search').focus();
        });
        // Hover preview shows this specific printing's image, so the user
        // can compare art before picking.
        chip.addEventListener('mouseenter', (ev) => {
          ev.stopPropagation();
          showPreview(p, ev);
        });
        chip.addEventListener('mousemove', positionPreview);
        chip.addEventListener('mouseleave', hidePreview);
        chips.appendChild(chip);
      });
      el.appendChild(chips);
    }

    results.appendChild(el);
  });
  // Keep the focused row visible when keyboard nav moves past the viewport.
  // (Not done for mouseenter-triggered renders because the mouse is already
  // on the row — the nearest-ish block scroll would fight the cursor.)
  const focused = results.querySelector('.result.selected');
  if (focused && focused.scrollIntoView) {
    focused.scrollIntoView({ block: 'nearest' });
  }
}

// Render the parser-error ribbon under the search input. null clears it.
function renderSearchError() {
  const el = document.getElementById('search-error');
  if (!el) return;
  const err = STATE.search.error;
  if (!err) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = 'query: ' + err;
  el.classList.remove('hidden');
}

// Show the big card preview for the currently focused (selectedIdx) result,
// docked next to its row. Triggered by arrow-key nav and Shift+Tab printing
// cycling, where there's no mouse event to seed the preview from.
function showFocusedResultPreview() {
  const r = STATE.search.results;
  if (!r || r.length === 0) return;
  const item = r[STATE.search.selectedIdx];
  if (!item) return;
  const pick = (it) => it.printings[it.pickedIdx] || it.printings[it.printings.length - 1];
  const picked = pick(item);
  const resultsEl = document.getElementById('search-results');
  const rowEl = resultsEl.querySelector('.result.selected') || resultsEl.firstElementChild;
  if (!rowEl) return;
  // showPreview needs an ev for the cursor fallback path; passing the row's
  // top-left as a synthetic position means positionPreview has something to
  // anchor to even when avoidEl isn't honoured by the layout.
  const rect = rowEl.getBoundingClientRect();
  const fakeEv = { clientX: rect.right, clientY: rect.top + rect.height / 2 };
  // Keyboard-driven focus is deliberate intent — skip the mouse-sweep
  // debounce so the preview appears the instant the image is ready.
  showPreview(picked, fakeEv, rowEl, /*immediate*/ true);

  // Warm the service-worker cache for nearby rows so the next arrow
  // press renders off cache instead of waiting on the network.
  const idx = STATE.search.selectedIdx;
  const neighbors = [];
  for (const d of [-2, -1, 1, 2]) {
    const n = idx + d;
    if (n >= 0 && n < r.length) neighbors.push(pick(r[n]));
  }
  prefetchCardImages(neighbors);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Deck operations
// ---------------------------------------------------------------------------

// Is this pile exactly a 4-of playset of `card`? Playset piles are treated
// as a deliberate user choice: new copies go into a fresh pile next to them,
// not into them.
function isPlaysetPile(pile, card) {
  if (!card || pile.length !== 4) return false;
  const canon = card.canonical;
  return pile.every(i => {
    const c = STATE.byId.get(i.cardId);
    return c && c.canonical === canon;
  });
}

// Place `inst` inside `pile` next to any existing copies with the same
// canonical name, so like cards stay grouped within a pile. Falls back to
// appending if no siblings are present.
function insertInstanceGroupedByCard(pile, inst) {
  const card = STATE.byId.get(inst.cardId);
  const canon = card && card.canonical;
  if (canon) {
    let lastIdx = -1;
    for (let i = 0; i < pile.length; i++) {
      const c = STATE.byId.get(pile[i].cardId);
      if (c && c.canonical === canon) lastIdx = i;
    }
    if (lastIdx >= 0) {
      pile.splice(lastIdx + 1, 0, inst);
      return;
    }
  }
  pile.push(inst);
}

// Index of the first non-playset pile in `zone` that already contains `card`,
// or -1 if none. Used to funnel same-name copies into a shared pile.
function findMergeablePileIdx(zone, card) {
  if (!card || !card.canonical) return -1;
  for (let i = 0; i < zone.piles.length; i++) {
    const pile = zone.piles[i];
    if (pile.length === 0) continue;
    if (isPlaysetPile(pile, card)) continue;
    if (pile.some(inst => {
      const c = STATE.byId.get(inst.cardId);
      return c && c.canonical === card.canonical;
    })) return i;
  }
  return -1;
}

function findPlaysetPileIdx(zone, card) {
  for (let i = 0; i < zone.piles.length; i++) {
    if (isPlaysetPile(zone.piles[i], card)) return i;
  }
  return -1;
}

// Drop `inst` into the right spot in `zone`:
//   1. an existing non-playset pile containing this card, or
//   2. a brand-new pile immediately after a playset of this card, or
//   3. a brand-new pile in sorted order.
function placeInstanceIntoZone(zone, inst, card) {
  const mergeIdx = findMergeablePileIdx(zone, card);
  if (mergeIdx >= 0) {
    insertInstanceGroupedByCard(zone.piles[mergeIdx], inst);
    return;
  }
  const playsetIdx = findPlaysetPileIdx(zone, card);
  if (playsetIdx >= 0) {
    zone.piles.splice(playsetIdx + 1, 0, [inst]);
    return;
  }
  let insertIdx = zone.piles.length;
  for (let i = 0; i < zone.piles.length; i++) {
    if (zone.piles[i].length === 0) continue;
    if (compareCardsChained(inst, zone.piles[i][0], STATE.pileSortChain) < 0) {
      insertIdx = i;
      break;
    }
  }
  zone.piles.splice(insertIdx, 0, [inst]);
}

function addCardToZone(cardId, zoneName, count = 1) {
  const card = STATE.byId.get(cardId);
  if (!card) return;
  const zone = STATE.zones[zoneName];
  for (let i = 0; i < count; i++) {
    placeInstanceIntoZone(zone, { uid: newUid(), cardId }, card);
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
  const found = findInstance(uid);
  if (!found) return;
  const inst = found.inst;
  const card = STATE.byId.get(inst.cardId);
  STATE.zones[found.zoneName].piles[found.pileIdx].splice(found.slotIdx, 1);
  if (STATE.zones[found.zoneName].piles[found.pileIdx].length === 0) {
    STATE.zones[found.zoneName].piles.splice(found.pileIdx, 1);
  }
  placeInstanceIntoZone(STATE.zones[toZone], inst, card);
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
  // destPile must already be in some zone.piles array.
  //
  // Pile rendering stacks instances in array order: later indices get a
  // higher `top` offset AND a higher z-index, so the LAST instance in a
  // pile is the visually dominant one. Everything below picks ordering so
  // the just-dragged card ends up there — matching the "pick up, drop on
  // top" mental model.
  //
  // "Raise to top" case: every dragged uid is already in destPile. Move
  // the dragged group and all same-name copies to the END of the array
  // (visually on top), preserving relative order within each partition.
  const allInDest = uids.length > 0 && uids.every(u => destPile.some(i => i.uid === u));
  if (allInDest) {
    const canons = new Set();
    for (const u of uids) {
      const inst = destPile.find(i => i.uid === u);
      const c = STATE.byId.get(inst.cardId);
      if (c) canons.add(c.canonical);
    }
    const top = [];
    const rest = [];
    for (const inst of destPile) {
      const c = STATE.byId.get(inst.cardId);
      if (c && canons.has(c.canonical)) top.push(inst);
      else rest.push(inst);
    }
    destPile.length = 0;
    destPile.push(...rest, ...top);
    return;
  }
  // Cross-pile drag: pull each uid from its source and append to the end of
  // destPile, dragging any existing same-name siblings up with it so the
  // whole name group ends up visually on top as one contiguous block.
  for (const uid of uids) {
    const inst = detachInstance(uid);
    if (!inst) continue;
    const card = STATE.byId.get(inst.cardId);
    const canon = card && card.canonical;
    if (canon) {
      const sames = [];
      const rest = [];
      for (const i of destPile) {
        const c = STATE.byId.get(i.cardId);
        if (c && c.canonical === canon) sames.push(i);
        else rest.push(i);
      }
      destPile.length = 0;
      destPile.push(...rest, ...sames, inst);
    } else {
      destPile.push(inst);
    }
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
  const zone = STATE.zones[zoneName];
  for (const uid of uids) {
    const inst = detachInstance(uid);
    if (!inst) continue;
    const card = STATE.byId.get(inst.cardId);
    placeInstanceIntoZone(zone, inst, card);
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
  all.sort((a, b) => compareCardsChained(a, b, STATE.pileSortChain));
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
  endDragGhost();
  for (const z of Object.keys(STATE.zones)) {
    renderZoneList(z);
    renderZoneCount(z);
  }
  renderPiles();
  captureUndoSnapshot();
}

// ---------------------------------------------------------------------------
// Undo / redo (Ctrl+Z / Ctrl+Y)
// ---------------------------------------------------------------------------

function serializeZones() { return JSON.stringify(STATE.zones); }

// Called at the tail of every renderAll — the central choke point for
// zone-mutating actions. If the serialized zones differ from the last
// committed snapshot, push that prior value onto the undo stack. Anything
// sitting in the redo stack belongs to an alternate timeline that the new
// mutation has diverged from, so drop it.
function captureUndoSnapshot() {
  const current = serializeZones();
  if (STATE.history.lastSnapshot == null) {
    STATE.history.lastSnapshot = current;
    return;
  }
  if (current === STATE.history.lastSnapshot) return;
  STATE.history.past.push(STATE.history.lastSnapshot);
  if (STATE.history.past.length > UNDO_MAX) STATE.history.past.shift();
  STATE.history.future.length = 0;
  STATE.history.lastSnapshot = current;
}

// Restore a zones JSON and re-render. Clears selection (uids referenced by
// the selection set are no longer valid for the restored instances), and
// resyncs uidCounter so newly-added cards don't collide with restored uids.
function applyZonesSnapshot(json) {
  STATE.zones = JSON.parse(json);
  let maxUid = 0;
  for (const z of Object.values(STATE.zones)) {
    for (const p of z.piles) for (const i of p) {
      if (i.uid > maxUid) maxUid = i.uid;
    }
  }
  STATE.uidCounter = Math.max(STATE.uidCounter, maxUid + 1);
  STATE.selection.clear();
  // Set lastSnapshot BEFORE renderAll so captureUndoSnapshot's diff is a
  // no-op — otherwise the restore itself would be recorded as a mutation.
  STATE.history.lastSnapshot = json;
  renderAll();
  // STATE.deckSnapshot (the baseline used by deckIsDirty) is *not* touched —
  // it's the last save/load/new point, and undo/redo just navigates zone
  // state around it. deckIsDirty() re-derives the correct answer on demand.
}

// Drop the entire undo/redo stack and rebaseline on the current zones.
// Called on deck swaps (New / Import / Load) — undoing back into a prior
// deck after intentionally switching to a different one would surprise the
// user more than help them. Save is NOT a swap and intentionally leaves
// history intact.
function resetHistory() {
  STATE.history.past.length = 0;
  STATE.history.future.length = 0;
  STATE.history.lastSnapshot = serializeZones();
}

function undo() {
  // Don't unwind zones mid-drag — the dragged DOM would be recreated under
  // the user's cursor and the in-flight drag source would point at a stale
  // uid.
  if (STATE.dragging) return;
  const h = STATE.history;
  if (h.past.length === 0) return;
  h.future.push(h.lastSnapshot);
  if (h.future.length > UNDO_MAX) h.future.shift();
  applyZonesSnapshot(h.past.pop());
}

function redo() {
  if (STATE.dragging) return;
  const h = STATE.history;
  if (h.future.length === 0) return;
  h.past.push(h.lastSnapshot);
  if (h.past.length > UNDO_MAX) h.past.shift();
  applyZonesSnapshot(h.future.pop());
}

function wireUndoRedo() {
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    // Let the browser's native text-undo handle the input/textarea case so
    // typing corrections aren't hijacked by deck undo.
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && ev.shiftKey)) {
      // Ctrl+Y is the requested redo binding; Ctrl+Shift+Z is the common
      // alternate (and the macOS convention) — accept both.
      ev.preventDefault();
      redo();
    }
  });
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
  return div;
}

// ---------------------------------------------------------------------------
// Rendering — pile pane (right)
// ---------------------------------------------------------------------------

const PILE_OFFSET_Y = 30;   // px between stacked card images in a pile
const CARD_HEIGHT   = parseInt(getComputedStyle(document.documentElement)
                        .getPropertyValue('--card-height'), 10) || 181;

function renderPiles() {
  if (STATE.focusedZone === 'search') { renderSearchPanel(); return; }
  document.getElementById('pile-title').textContent =
    `${ZONE_LABELS[STATE.focusedZone]} (${totalCount(STATE.focusedZone)})`;
  const container = document.getElementById('piles');
  container.classList.remove('search-mode');
  container.innerHTML = '';
  const zone = STATE.zones[STATE.focusedZone];

  // Render piles in their stored zone.piles order — no automatic bucketing
  // by type/CMC. Users arrange piles freely (or click Re-sort to group them
  // by the current pile-sort mode), and drops always land where the user
  // dropped them. Each pile is wrapped with its preceding gap drop-target in
  // a single flex child so the pair never splits across wrapped rows.
  zone.piles.forEach((pile, pileIdx) => {
    if (pile.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pile-wrapper';
    wrapper.appendChild(makePileGap(pileIdx));
    wrapper.appendChild(makePileEl(pile, pileIdx));
    container.appendChild(wrapper);
  });

  // Trailing gap drop target — dropping here creates a new pile at the end.
  container.appendChild(makePileGap(zone.piles.length));
}

// Clear drag-over highlight from all drop targets except the given element.
function clearOtherDragOver(except) {
  for (const el of document.querySelectorAll('#piles .drag-over')) {
    if (el !== except) el.classList.remove('drag-over');
  }
}

// Build a gap drop target. Dropping a card here splices a NEW pile into the
// focused zone at the given index. Used both between piles (inside
// pile-wrappers) and as the trailing drop target at the end of the row.
function makePileGap(insertIdx) {
  const g = document.createElement('div');
  g.className = 'pile-gap';
  g.dataset.insertIdx = String(insertIdx);
  g.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearOtherDragOver(g);
    g.classList.add('drag-over');
  });
  g.addEventListener('dragleave', () => g.classList.remove('drag-over'));
  g.addEventListener('drop', (ev) => {
    ev.preventDefault();
    g.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    console.log('[drag] DROP on pile-gap — uids:', uids, '— insertIdx:', insertIdx);
    endDragGhost();
    if (uids.length === 0) return;
    insertNewPileWithUids(uids, STATE.focusedZone, insertIdx);
    STATE.selection.clear();
    renderAll();
  });
  return g;
}

// Return the face (front or back) currently shown for this instance. Used
// by the slot renderer, the hover preview, and anywhere else that needs to
// reflect a flipped DFC. Single-faced cards always return the card itself.
function currentFace(inst, card) {
  if (inst && inst.flipped && card && card.back) return card.back;
  return card;
}

// Lotus-icon button on the bottom-right of a pile slot. Clicking pops open
// a floating chip strip with every printing of this card; picking a chip
// rewrites inst.cardId to that printing's id. If the clicked instance is
// part of the active selection, every selected instance sharing the same
// canonical name is swapped alongside it.
function makeVersionButton(openPickerAt) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'version-btn';
  btn.dataset.title = 'Change printing';
  btn.draggable = false;
  // Three-petal lotus silhouette — reads recognizably at 14×14.
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">'
                + '<path d="M8 14 C6.2 11 6.2 8 8 4 C9.8 8 9.8 11 8 14 Z"/>'
                + '<path d="M8 14 C4 12 2.3 9 2.3 6.3 C4.5 8.5 6.5 10.5 8 14 Z"/>'
                + '<path d="M8 14 C12 12 13.7 9 13.7 6.3 C11.5 8.5 9.5 10.5 8 14 Z"/>'
                + '</svg>';
  btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    openPickerAt(btn);
  });
  return btn;
}

function openPrintingPicker(anchor, printings, currentId, onPick) {
  closeVersionPicker();
  if (!printings || printings.length <= 1) return;
  const picker = document.createElement('div');
  picker.className = 'version-picker';
  picker.id = 'version-picker';
  printings.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'version-chip' + (p.id === currentId ? ' current' : '');
    // Alt-art variants (Pixel/Hero/Cidraeth/...) share set codes with their
    // base printing, so the chip prefers the stripped variant label when
    // one was captured during consolidation. Base prints and plain _SETCODE
    // reprints fall back to the set code as before.
    chip.textContent = p.variant || p.set || '?';
    const setMeta = STATE.setsByCode[p.set];
    const baseTitle = setMeta
      ? `${setMeta.longname || p.set} (${setMeta.releasedate || '?'})`
      : (p.set || '');
    chip.dataset.title = p.variant ? `${p.variant} — ${baseTitle}` : baseTitle;
    chip.addEventListener('mousedown', (ev) => ev.stopPropagation());
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onPick(p);
      closeVersionPicker();
    });
    // Hover preview shows the specific printing's art so users can compare
    // before committing — same behavior as the search-dropdown chips.
    chip.addEventListener('mouseenter', (ev) => showPreview(p, ev));
    chip.addEventListener('mousemove', positionPreview);
    chip.addEventListener('mouseleave', hidePreview);
    picker.appendChild(chip);
  });
  document.body.appendChild(picker);
  // Anchor below-right of the button; flip above if it would overflow the
  // viewport, and nudge horizontally to stay in the viewport.
  const r = anchor.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  let top = r.bottom + 4;
  let left = r.right - pr.width;
  if (left < 4) left = 4;
  if (left + pr.width > window.innerWidth - 4) left = window.innerWidth - pr.width - 4;
  if (top + pr.height > window.innerHeight - 4) top = r.top - pr.height - 4;
  picker.style.left = left + 'px';
  picker.style.top = top + 'px';
  STATE._versionPicker = { el: picker };
}

function openVersionPicker(anchor, inst, card) {
  const printings = STATE.byCanonical.get(card.canonical) || [card];
  openPrintingPicker(anchor, printings, inst.cardId, (p) => swapVersion(inst, p.id));
}

function closeVersionPicker() {
  if (!STATE._versionPicker) return;
  STATE._versionPicker.el.remove();
  STATE._versionPicker = null;
}

function swapVersion(inst, newCardId) {
  const origCard = STATE.byId.get(inst.cardId);
  const canon = origCard && origCard.canonical;
  // If the clicked card is part of a multi-selection, swap every selected
  // instance whose canonical matches — so "select 3 of 7 ERR Mountains,
  // pick OLD" changes exactly those 3 without touching unrelated selected
  // cards.
  const targetUids = (STATE.selection.size > 0 && STATE.selection.has(inst.uid))
    ? [...STATE.selection].filter(uid => {
        const f = findInstance(uid);
        if (!f) return false;
        const c = STATE.byId.get(f.inst.cardId);
        return c && c.canonical === canon;
      })
    : [inst.uid];
  let changed = false;
  for (const uid of targetUids) {
    const f = findInstance(uid);
    if (f && f.inst.cardId !== newCardId) {
      f.inst.cardId = newCardId;
      changed = true;
    }
  }
  if (changed) renderAll();
}

function wireVersionPicker() {
  document.addEventListener('click', (ev) => {
    if (!STATE._versionPicker) return;
    if (STATE._versionPicker.el.contains(ev.target)) return;
    if (ev.target.closest('.version-btn')) return;
    closeVersionPicker();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && STATE._versionPicker) closeVersionPicker();
  });
  // Scrolling the pile pane or resizing the window leaves the anchor's
  // rect under the picker stale — close rather than try to re-anchor.
  const piles = document.getElementById('piles');
  if (piles) piles.addEventListener('scroll', closeVersionPicker, { passive: true });
  window.addEventListener('resize', closeVersionPicker);
}

// Build a transparent center overlay button on a pile-slot card. Click
// toggles inst.flipped, swaps the slot's <img> source between the front
// and back face, and updates the slot's title / "flipped" class. The
// button captures click + mousedown so it never starts a drag and never
// triggers the slot's selection-clear handler.
function makeFlipButton(inst, card, slot) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'flip-btn';
  btn.dataset.title = 'Flip card to see other side';
  btn.draggable = false;
  // The faint icon shows on slot hover; the button itself is transparent.
  btn.innerHTML = '<span class="flip-icon" aria-hidden="true">&#x21bb;</span>';
  btn.setAttribute('aria-label', 'Flip card');
  // Stop mousedown so the parent slot's drag doesn't pre-empt the click.
  btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    inst.flipped = !inst.flipped;
    const face = currentFace(inst, card);
    const img = slot.querySelector('img');
    if (img) {
      img.src = imgUrl(face);
      img.alt = face.canonical || face.name || card.canonical;
    }
    slot.classList.toggle('flipped', !!inst.flipped);
  });
  return btn;
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
    b.dataset.title = title;
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
    const { zoneName, pileIdx } = found;
    const pile = STATE.zones[zoneName].piles[pileIdx];
    const newInst = { uid: newUid(), cardId: card.id };
    // Default: drop the new copy straight into this card's pile, next to
    // its siblings. Exception: if this pile is a deliberate 4-of playset,
    // spawn a fresh pile right after it rather than ballooning it to 5.
    if (isPlaysetPile(pile, card)) {
      STATE.zones[zoneName].piles.splice(pileIdx + 1, 0, [newInst]);
    } else {
      insertInstanceGroupedByCard(pile, newInst);
    }
    STATE.selection.clear();
    renderAll();
  }));
  wrap.appendChild(makeBtn('\u2212', 'Remove this copy', () => {
    if (STATE.selection.size > 0 && STATE.selection.has(inst.uid)) {
      for (const uid of [...STATE.selection]) removeInstance(uid);
    } else {
      removeInstance(inst.uid);
    }
    STATE.selection.clear();
    renderAll();
  }));
  wrap.appendChild(makeBtn('\u2194', 'Move to/from sideboard', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    const target = (found.zoneName === 'side') ? 'main' : 'side';
    if (STATE.selection.size > 0 && STATE.selection.has(inst.uid)) {
      for (const uid of [...STATE.selection]) moveInstanceToZone(uid, target);
    } else {
      moveInstanceToZone(inst.uid, target);
    }
    STATE.selection.clear();
    renderAll();
  }));
  wrap.appendChild(makeBtn('?', 'Move to/from maybeboard', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    const target = (found.zoneName === 'maybe') ? 'main' : 'maybe';
    if (STATE.selection.size > 0 && STATE.selection.has(inst.uid)) {
      for (const uid of [...STATE.selection]) moveInstanceToZone(uid, target);
    } else {
      moveInstanceToZone(inst.uid, target);
    }
    STATE.selection.clear();
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
      // Pick the visible face: respect any prior flip on this instance.
      // currentFace() returns the back when inst.flipped is true and the
      // card has a back, otherwise the front.
      const face0 = currentFace(inst, card);
      const img = document.createElement('img');
      img.alt = face0.canonical || face0.name || card.canonical;
      img.src = imgUrl(face0);
      img.addEventListener('error', () => {
        slot.classList.add('no-image');
        slot.textContent = face0.canonical || face0.name || '???';
      });
      slot.appendChild(img);
      if (inst.flipped && card.back) slot.classList.add('flipped');
      const titleParts = [card.canonical, card.type, card.manacost || ''];
      if (card.text) titleParts.push('', card.text);
      if (card.power || card.toughness) titleParts.push(`${card.power}/${card.toughness}`);
      slot.dataset.title = titleParts.join('\n').trim();
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
      console.log('[drag] pile dragstart — uid:', inst.uid,
                  '— slot in DOM:', document.body.contains(slot),
                  '— slot size:', slot.offsetWidth, 'x', slot.offsetHeight,
                  '— selection:', [...STATE.selection]);
      ev.dataTransfer.effectAllowed = 'move';
      const uids = uidsToDrag(inst.uid);
      ev.dataTransfer.setData('text/uids', uids.join(','));
      startDragGhost(ev, uids,
        slot.offsetWidth, slot.offsetHeight,
        slot.offsetWidth / 2, 30);
      slot.classList.add('dragging');
      STATE.dragging = { uids };
      document.body.classList.add('dragging');
      if (uids.length >= 2) showDragTrash();
    });
    slot.addEventListener('dragend', () => {
      console.log('[drag] pile dragend — uid:', inst.uid,
                  '— slot in DOM:', document.body.contains(slot),
                  '— STATE.dragGhost:', !!STATE.dragGhost);
      slot.classList.remove('dragging');
      STATE.dragging = null;
      endDragGhost();
      hideDragTrash();
      document.body.classList.remove('dragging');
    });
    // Hover preview — same floating popup the deck-list rows use. Reads
    // inst.flipped fresh each time so flipping a card and then re-hovering
    // pops up the back image.
    if (card) {
      slot.addEventListener('mouseenter', (ev) => showPreview(currentFace(inst, card), ev, slot));
      slot.addEventListener('mousemove', positionPreview);
      slot.addEventListener('mouseleave', hidePreview);
    }

    // Overlay action buttons (only attach when we know which card it is)
    if (card) {
      slot.appendChild(makeSlotButtons(inst, card));
      // DFC flip button — transparent overlay in the center of the card
      // that swaps between front and back faces. Only rendered when the
      // card actually has a back side.
      if (card.back) {
        slot.appendChild(makeFlipButton(inst, card, slot));
      }
      // Version-swap lotus button (bottom-right). Omitted when there's only
      // one printing of this card — clicking would have no choices to offer.
      const printings = STATE.byCanonical.get(card.canonical);
      if (printings && printings.length > 1) {
        slot.appendChild(makeVersionButton((btn) => openVersionPicker(btn, inst, card)));
      }
    }
    el.appendChild(slot);
  });

  // Pile-level drop target
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearOtherDragOver(el);
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (ev) => {
    if (!el.contains(ev.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drag-over');
    const uids = readUidsFromDrag(ev.dataTransfer);
    console.log('[drag] DROP on pile — uids:', uids, '— pileIdx:', pileIdx);
    endDragGhost();
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
// Search panel mode: render search results as card tiles in the pile pane,
// draggable into Main/Side/Maybe. Switched on via the overlay toggle in the
// search wrap; state lives in STATE.searchPanel (persisted in prefs). While
// on, a synthetic "Search" tab appears in the sidebar and doubles as the
// one-click path back to results after the user checks a deck zone.
// ---------------------------------------------------------------------------

function renderSearchPanel() {
  const count = STATE.search.results.length;
  document.getElementById('pile-title').textContent = `Search (${count})`;
  const container = document.getElementById('piles');
  container.innerHTML = '';
  // `search-mode` swaps the container's column-gap in CSS so the tiles get
  // the same horizontal breathing room the deck panes provide via pile-gap
  // drop targets. We don't use pile-gaps here — they only make sense as
  // in-zone drop targets, which search results don't need.
  container.classList.add('search-mode');
  // Each result is its own single-card pile so tile spacing matches the
  // deck panes. Results come back in the search's own relevance/name order;
  // no pile-sort re-bucketing is applied.
  STATE.search.results.forEach((item) => {
    const picked = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
    if (!picked) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pile-wrapper';
    const pile = document.createElement('div');
    pile.className = 'pile';
    pile.style.height = CARD_HEIGHT + 'px';
    pile.appendChild(makeSearchSlot(picked, item));
    wrapper.appendChild(pile);
    container.appendChild(wrapper);
  });
}

function makeSearchSlot(card, item) {
  const slot = document.createElement('div');
  slot.className = 'card-slot'
                 + (isLegal(card) ? '' : ' illegal')
                 + (STATE.searchSelection.has(card.id) ? ' selected' : '');
  slot.style.top = '0px';
  slot.style.zIndex = '1';
  slot.draggable = true;
  slot.dataset.cardId = String(card.id);

  // Flip state lives on the search-result `item` so cycling printings or
  // re-rendering keeps the chosen face. The displayed face is resolved via
  // currentFace so flipped DFCs render their back immediately on mount.
  const face0 = currentFace(item, card);
  const img = document.createElement('img');
  img.alt = face0.canonical || face0.name || card.canonical || '';
  img.src = imgUrl(face0);
  img.addEventListener('error', () => {
    slot.classList.add('no-image');
    slot.textContent = face0.canonical || face0.name || '???';
  });
  slot.appendChild(img);
  if (item && item.flipped && card.back) slot.classList.add('flipped');

  const titleParts = [card.canonical, card.type, card.manacost || ''];
  if (card.text) titleParts.push('', card.text);
  if (card.power || card.toughness) titleParts.push(`${card.power}/${card.toughness}`);
  slot.dataset.title = titleParts.join('\n').trim();

  // Shift/Ctrl/Cmd-click toggles membership; a plain click clears any
  // selection — mirrors the deck-pane pile slots.
  slot.addEventListener('click', (ev) => {
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      ev.stopPropagation();
      if (STATE.searchSelection.has(card.id)) STATE.searchSelection.delete(card.id);
      else STATE.searchSelection.add(card.id);
      renderPiles();
    } else if (STATE.searchSelection.size > 0) {
      STATE.searchSelection.clear();
      renderPiles();
    }
  });

  slot.addEventListener('dragstart', (ev) => {
    // If this card is part of an active selection, drag the whole set.
    // Otherwise drag just this one.
    const cardIds = (STATE.searchSelection.size > 0 && STATE.searchSelection.has(card.id))
      ? [...STATE.searchSelection]
      : [card.id];
    // `copyMove` (not `copy`) so the zone drop targets — whose dragover
    // handlers set dropEffect='move' to match regular pile drags — still
    // accept the drop. A `copy` effectAllowed + `move` dropEffect mismatch
    // silently cancels the drop in Chrome/Firefox.
    ev.dataTransfer.effectAllowed = 'copyMove';
    // Marker so the drop is valid across Firefox/Safari. STATE.dragging.cardIds
    // is the source of truth; the dataTransfer value isn't read.
    ev.dataTransfer.setData('text/search-card-ids', cardIds.join(','));
    startSearchDragGhost(ev, cardIds, slot.offsetWidth, slot.offsetHeight,
                         slot.offsetWidth / 2, 30);
    slot.classList.add('dragging');
    STATE.dragging = { fromSearch: true, cardIds };
    document.body.classList.add('dragging');
  });
  slot.addEventListener('dragend', () => {
    slot.classList.remove('dragging');
    STATE.dragging = null;
    endDragGhost();
    hideDragTrash();
    document.body.classList.remove('dragging');
  });
  slot.addEventListener('mouseenter', (ev) => showPreview(currentFace(item, card), ev, slot));
  slot.addEventListener('mousemove', positionPreview);
  slot.addEventListener('mouseleave', hidePreview);

  slot.appendChild(makeSearchSlotButtons(card));
  // DFC flip button — `item` stands in for `inst` since both carry a
  // `flipped` boolean; reuses the pile pane's widget.
  if (card.back && item) {
    slot.appendChild(makeFlipButton(item, card, slot));
  }
  // Version-swap lotus. Mutates item.pickedIdx and re-renders the panel so
  // the tile (and subsequent drags) use the chosen printing.
  if (item && item.printings && item.printings.length > 1) {
    const current = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
    slot.appendChild(makeVersionButton((btn) => {
      openPrintingPicker(btn, item.printings, current ? current.id : null, (p) => {
        const idx = item.printings.findIndex(pp => pp.id === p.id);
        if (idx >= 0) item.pickedIdx = idx;
        renderSearchPanel();
      });
    }));
  }
  return slot;
}

function makeSearchSlotButtons(card) {
  const wrap = document.createElement('div');
  wrap.className = 'slot-buttons';
  wrap.draggable = false;

  function makeBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-btn';
    b.textContent = label;
    b.dataset.title = title;
    b.draggable = false;
    b.addEventListener('mousedown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  const addTo = (zone) => {
    // Mirror pile-slot semantics: if the clicked card is part of an active
    // selection, the button applies to the whole set. Otherwise only this
    // card is added.
    const ids = (STATE.searchSelection.size > 0 && STATE.searchSelection.has(card.id))
      ? [...STATE.searchSelection]
      : [card.id];
    for (const id of ids) addCardToZone(id, zone);
    renderAll();
  };
  wrap.appendChild(makeBtn('+', 'Add to main deck', () => addTo('main')));
  wrap.appendChild(makeBtn('\u2194', 'Add to sideboard', () => addTo('side')));
  wrap.appendChild(makeBtn('?', 'Add to maybeboard', () => addTo('maybe')));

  return wrap;
}

// Lightweight ghost for a search-result drag: no uids to look up, just the
// card images resolved from ids. Stacks vertically like the pile-pane ghost
// when the user is dragging a multi-selection.
function startSearchDragGhost(ev, cardIds, width, height, offsetX, offsetY) {
  endDragGhost();
  ev.dataTransfer.setDragImage(EMPTY_DRAG_IMG, 0, 0);
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const stackOffset = PILE_OFFSET_Y;
  const count = cardIds.length;
  ghost.style.width = width + 'px';
  ghost.style.height = (height + Math.max(0, count - 1) * stackOffset) + 'px';
  cardIds.forEach((cid, i) => {
    const c = STATE.byId.get(cid);
    if (!c) return;
    const img = document.createElement('img');
    img.src = imgUrl(c);
    img.style.cssText = `position:absolute;top:${i * stackOffset}px;left:0;`
                      + `width:${width}px;height:${height}px;`
                      + `object-fit:cover;border-radius:5px;`;
    ghost.appendChild(img);
  });
  ghost.style.left = (ev.clientX - offsetX) + 'px';
  ghost.style.top = (ev.clientY - offsetY) + 'px';
  document.body.appendChild(ghost);
  STATE.dragGhost = { el: ghost, offsetX, offsetY };
}

function wireSearchToggle() {
  const btn = document.getElementById('btn-search-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    STATE.searchPanel = !STATE.searchPanel;
    applySearchPanelMode();
    savePrefs();
  });
}

function applySearchPanelMode() {
  const on = STATE.searchPanel;
  const btn = document.getElementById('btn-search-toggle');
  const searchZone = document.querySelector('.zone[data-zone="search"]');
  const dropdown = document.getElementById('search-results');
  if (btn) btn.classList.toggle('active', on);
  if (searchZone) searchZone.classList.toggle('hidden', !on);
  if (on) {
    if (dropdown) dropdown.classList.add('hidden');
    setFocusedZone('search');
    updateSearchZoneCount();
  } else if (STATE.focusedZone === 'search') {
    // Leaving panel mode while viewing the synthetic Search pane — fall back
    // to a real zone so the pane shows something sensible.
    setFocusedZone('main');
  }
}

function updateSearchZoneCount() {
  const el = document.getElementById('count-search');
  if (el) el.textContent = String(STATE.search.results.length);
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
      // Drag sourced from a search-panel tile: create new instances in this
      // zone rather than moving existing uids. A single-card drag arrives as
      // a one-element cardIds array; a multi-selection drag carries every
      // selected card id.
      if (STATE.dragging && STATE.dragging.fromSearch) {
        const cardIds = STATE.dragging.cardIds || [];
        endDragGhost();
        for (const cid of cardIds) addCardToZone(cid, zoneName);
        renderAll();
        return;
      }
      const uids = readUidsFromDrag(ev.dataTransfer);
      console.log('[drag] DROP on zone — uids:', uids, '— zone:', zoneName);
      endDragGhost();
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
      console.log('[drag] list dragstart — uid:', foundUid, '— card:', card?.name);
      ev.dataTransfer.effectAllowed = 'move';
      // Deck-list rows always drag a single card; row drags don't participate
      // in pile-pane multi-select.
      ev.dataTransfer.setData('text/uids', String(foundUid));
      const root = document.documentElement;
      const cw = parseFloat(getComputedStyle(root).getPropertyValue('--card-width'));
      const ch = parseFloat(getComputedStyle(root).getPropertyValue('--card-height'));
      startDragGhost(ev, [foundUid], cw, ch, cw / 2, 60);
      STATE.dragging = { uids: [foundUid] };
      document.body.classList.add('dragging');
    });
    list.addEventListener('dragend', () => {
      console.log('[drag] list dragend — STATE.dragGhost:', !!STATE.dragGhost);
      STATE.dragging = null;
      endDragGhost();
      hideDragTrash();
      document.body.classList.remove('dragging');
    });
  }

  // Synthetic Search zone (no cards, no drop target — just a click-to-focus
  // header). Shown only while searchPanel mode is on; applySearchPanelMode
  // toggles its visibility.
  const searchSec = document.querySelector('.zone[data-zone="search"]');
  if (searchSec) {
    searchSec.addEventListener('click', () => setFocusedZone('search'));
  }

  // Arrow keys cycle focus between main / side / maybe when no text input
  // is focused (so the search box's own arrow-key handling still works).
  const ZONE_ORDER = ['main', 'side', 'maybe'];
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    let delta = 0;
    if (ev.key === 'ArrowDown') delta = 1;
    else if (ev.key === 'ArrowUp') delta = -1;
    else return;
    ev.preventDefault();
    const idx = ZONE_ORDER.indexOf(STATE.focusedZone);
    const next = ZONE_ORDER[((idx < 0 ? 0 : idx) + delta + ZONE_ORDER.length) % ZONE_ORDER.length];
    setFocusedZone(next);
  });
}

function setFocusedZone(zoneName) {
  STATE.focusedZone = zoneName;
  document.querySelectorAll('.zone').forEach(z => z.classList.toggle('focused', z.dataset.zone === zoneName));
  // Keep the search hints band visible and the toolbar suppressed while the
  // user is "within" the search pane, even if focus has left the input
  // (e.g., they're clicking result tiles). Tied to the focused zone so the
  // deck panes still get the normal toolbar.
  document.body.classList.toggle('search-active', zoneName === 'search');
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
  wirePasteImport();
  wireCopyTxt();
  wireSavedDecks();
  wireDragTrash();
  document.getElementById('btn-new-deck').addEventListener('click', () => {
    if (deckIsDirty() && !confirm('Clear all zones and start a new deck?')) return;
    STATE.zones.main.piles = [];
    STATE.zones.side.piles = [];
    STATE.zones.maybe.piles = [];
    STATE.loadedDeckName = null;
    STATE.loadedDeckFolder = null;
    STATE.loadedDeckTags = [];
    updateSaveButtons();
    renderAll();
    resetHistory();
    markDeckClean();
  });
  // Format dropdown: toggle menu on trigger click, pick on item click.
  const formatBtn = document.getElementById('format-btn');
  const formatMenu = document.getElementById('format-menu');
  formatBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    formatMenu.classList.toggle('hidden');
  });
  formatMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      STATE.format = btn.dataset.format;
      // Keep menu open when "Sets" is picked so range pickers are accessible.
      if (btn.dataset.format !== 'range') formatMenu.classList.add('hidden');
      savePrefs();
      syncFormatUI();
      runSearch(document.getElementById('search').value);
      renderAll();
    });
  });
  // Clicks inside the range pickers shouldn't close the menu.
  document.getElementById('range-pickers').addEventListener('click', (ev) => {
    ev.stopPropagation();
  });
  // Close format dropdown when clicking elsewhere.
  document.addEventListener('click', () => {
    formatMenu.classList.add('hidden');
  });
  // Range pickers: changing either bound updates STATE, persists, and
  // re-renders. Start can't be after end (and vice versa) — if the user
  // breaks that, snap the other dropdown to match.
  const startSel = document.getElementById('range-start');
  const endSel   = document.getElementById('range-end');
  function onRangeChange(which) {
    STATE.rangeStart = startSel.value;
    STATE.rangeEnd   = endSel.value;
    if (setIndex(STATE.rangeStart) > setIndex(STATE.rangeEnd)) {
      // Snap the OTHER dropdown so the just-edited one wins.
      if (which === 'start') {
        STATE.rangeEnd = STATE.rangeStart;
        endSel.value = STATE.rangeEnd;
      } else {
        STATE.rangeStart = STATE.rangeEnd;
        startSel.value = STATE.rangeStart;
      }
    }
    savePrefs();
    runSearch(document.getElementById('search').value);
    renderAll();
  }
  startSel.addEventListener('change', () => onRangeChange('start'));
  endSel.addEventListener('change', () => onRangeChange('end'));
  // Reflect any persisted format on first paint.
  syncFormatUI();
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn.addEventListener('click', async () => {
    const original = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Updating\u2026';
    try {
      await refreshFromUpstream();
      // New card data almost certainly means some multiverseIds bumped, so
      // the image URLs those entries point at have changed. Drop the image
      // cache so stale ?v=<old> entries don't linger forever.
      await clearImageCache();
      refreshBtn.textContent = 'Updated \u2713';
      setTimeout(() => { refreshBtn.textContent = original; }, 1500);
    } catch (e) {
      console.error(e);
      alert('Update failed: ' + (e.message || e));
      refreshBtn.textContent = original;
    } finally {
      refreshBtn.disabled = false;
    }
  });

  const themeBtn = document.getElementById('btn-theme');
  themeBtn.addEventListener('click', () => {
    STATE.theme = STATE.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    savePrefs();
  });
  applyTheme();

  const clearImgsBtn = document.getElementById('btn-clear-imgs');
  clearImgsBtn.addEventListener('click', async () => {
    const original = clearImgsBtn.textContent;
    clearImgsBtn.disabled = true;
    try {
      await clearImageCache();
      clearImgsBtn.textContent = 'Cleared \u2713';
      setTimeout(() => { clearImgsBtn.textContent = original; }, 1500);
    } catch (e) {
      console.error(e);
      clearImgsBtn.textContent = original;
    } finally {
      clearImgsBtn.disabled = false;
    }
  });
}

async function clearImageCache() {
  // Delete the named cache directly; also ping the SW in case it has a
  // put() in flight (it'll no-op against the recreated-on-next-fetch cache).
  if ('caches' in self) await caches.delete('rev-img-v1');
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'clear-img-cache' });
  }
}

// Wire a group of sort-mode buttons that share a `data-<attr>` selector.
// Clicking a button updates `STATE[stateKey]` to the button's value, toggles
// the `.active` class across the group, and invokes `afterClick()` to
// re-render. Used by both pile-sort and zone-list-sort bars, which follow
// the same pattern.
function wireSortButtons(attr, stateKey, afterClick) {
  const sel = `[data-${attr}]`;
  // Convert the dashed attr name to the camelCased dataset key that DOM
  // APIs expose (`data-pile-sort` → `dataset.pileSort`).
  const dataKey = attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  document.querySelectorAll(sel).forEach(btn => {
    btn.addEventListener('click', () => {
      STATE[stateKey] = btn.dataset[dataKey];
      document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b === btn));
      afterClick();
    });
  });
}

// Pile sort is a dropdown. Each menu item promotes its method to the front
// of STATE.pileSortChain; previous methods slide down and serve as
// tiebreakers. Clicking the method that's already primary acts as a plain
// re-sort (matching the old Re-sort button's behavior).
const PILE_SORT_LABELS = {
  type: 'Type',
  cmc:  'Mana',
  set:  'Set',
  color:'Color',
  name: 'Name',
};

function wirePileSort() {
  const btn = document.getElementById('pile-sort-btn');
  const menu = document.getElementById('pile-sort-menu');
  const update = () => {
    const primary = STATE.pileSortChain[0] || 'type';
    btn.innerHTML = (PILE_SORT_LABELS[primary] || primary) + ' \u25BE';
    menu.querySelectorAll('button[data-pile-sort]').forEach(b => {
      b.classList.toggle('active', b.dataset.pileSort === primary);
    });
  };
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) {
      menu.classList.add('hidden');
    }
  });
  menu.querySelectorAll('button[data-pile-sort]').forEach(b => {
    b.addEventListener('click', () => {
      const method = b.dataset.pileSort;
      pushPileSort(method);
      update();
      menu.classList.add('hidden');
      resortPiles(STATE.focusedZone);
      renderPiles();
    });
  });
  update();
}

// Promote `method` to the front of the sort chain. If it was already in the
// chain, move it (don't duplicate) — preserves the relative order of the
// other tiebreakers.
function pushPileSort(method) {
  const chain = STATE.pileSortChain;
  const i = chain.indexOf(method);
  if (i >= 0) chain.splice(i, 1);
  chain.unshift(method);
  // Cap at the method count so the chain can't grow unbounded from repeated
  // repicking (naturally bounded since duplicates are removed above, but
  // defense-in-depth in case the method list grows).
  if (chain.length > 5) chain.length = 5;
  STATE.pileSort = chain[0];
}

function wireListSort() {
  wireSortButtons('list-sort', 'listSort', () => {
    for (const z of Object.keys(STATE.zones)) renderZoneList(z);
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
    const onSlot = ev.target.closest('.card-slot') || ev.target.closest('.slot-btn');
    if (onSlot) return;
    let dirty = false;
    if (STATE.selection.size > 0) { STATE.selection.clear(); dirty = true; }
    if (STATE.searchSelection.size > 0) { STATE.searchSelection.clear(); dirty = true; }
    if (dirty) renderPiles();
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
    // Ignore mousedowns that originated on card slots or their buttons —
    // let those elements handle drag/click. Pile-gaps are NOT excluded so
    // they can serve as the starting corner of a region select.
    if (ev.target.closest('.card-slot, .slot-btn')) return;
    ev.preventDefault();
    document.getElementById('search').blur();
    // Region-select operates on two different selection stores depending on
    // the pane contents: card-instance uids for deck zones, card ids for
    // the search pane. `mode` captures which we're in for the duration of
    // this drag so mousemove doesn't have to re-check on every tick.
    const mode = STATE.focusedZone === 'search' ? 'search' : 'deck';
    const selSet = (mode === 'search') ? STATE.searchSelection : STATE.selection;
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!additive && selSet.size > 0) {
      selSet.clear();
      renderPiles();
    }
    const baseSelection = new Set(selSet);
    const rectEl = document.createElement('div');
    rectEl.className = 'region-select';
    document.body.appendChild(rectEl);
    active = { startX: ev.clientX, startY: ev.clientY, additive, rectEl, baseSelection, mode };
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

    const keyAttr = active.mode === 'search' ? 'cardId' : 'uid';
    // Recompute selection live: base ∪ (slots inside rect).
    const nextSel = new Set(active.baseSelection);
    const slots = document.querySelectorAll('#piles .pile .card-slot');
    for (const slot of slots) {
      const r = slot.getBoundingClientRect();
      const intersects = r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2;
      if (intersects) {
        const k = parseInt(slot.dataset[keyAttr], 10);
        if (!isNaN(k)) nextSel.add(k);
      }
    }
    // Only touch DOM for slots whose selected state changed.
    for (const slot of slots) {
      const k = parseInt(slot.dataset[keyAttr], 10);
      const wantSel = nextSel.has(k);
      const hasSel = slot.classList.contains('selected');
      if (wantSel && !hasSel) slot.classList.add('selected');
      else if (!wantSel && hasSel) slot.classList.remove('selected');
    }
    if (active.mode === 'search') STATE.searchSelection = nextSel;
    else STATE.selection = nextSel;
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
// pending timer, so quick passes never show anything. Keyboard-driven
// callers (arrow-key nav through search results) pass immediate=true to
// skip the debounce, since those keystrokes are always deliberate.
const PREVIEW_DELAY_MS = 250;
let _previewTimer = null;
let _previewAvoidEl = null;  // element the preview must not cover (pile slots)

function showPreview(card, ev, avoidEl, immediate) {
  if (_previewTimer) clearTimeout(_previewTimer);
  _previewAvoidEl = avoidEl || null;
  // Capture cursor position now; the timer fires later when ev is stale.
  const startEv = { clientX: ev.clientX, clientY: ev.clientY };
  const run = () => {
    _previewTimer = null;
    const el = document.getElementById('card-preview');
    const img = document.getElementById('card-preview-img');
    const url = imgUrl(card);
    img.alt = card.canonical;
    // Hide while loading so the old image never flashes for a different card.
    el.classList.add('hidden');
    const show = () => {
      el.classList.remove('hidden');
      positionPreview(startEv);
    };
    if (img.src === url || img.src === new URL(url, location.href).href) {
      // Already loaded (same card re-hovered) — show immediately.
      img.src = url;
      show();
    } else {
      img.onload = () => { img.onload = null; show(); };
      img.src = url;
    }
    // Preload into the dedicated drag-preview img so a subsequent dragstart
    // from this row can use it as the drag preview image.
    const dragImg = document.getElementById('drag-img');
    if (dragImg) dragImg.src = url;
  };
  if (immediate) run();
  else _previewTimer = setTimeout(run, PREVIEW_DELAY_MS);
}

// Kick off a background fetch for each card's image. Setting `src` on a
// detached Image() fires a GET that the service worker intercepts and
// caches (`sw.js` stores under `rev-img-v1`), so a later render that
// actually shows the image can hit the cache instead of the network.
// Used to warm search-result neighbors while the user is arrow-keying.
function prefetchCardImages(cards) {
  for (const c of cards) {
    if (!c) continue;
    const img = new Image();
    img.src = imgUrl(c);
  }
}

function positionPreview(ev) {
  const el = document.getElementById('card-preview');
  if (el.classList.contains('hidden')) return;
  const w = el.offsetWidth, h = 336;

  if (_previewAvoidEl) {
    // Position next to the card slot, never overlapping it.
    const ar = _previewAvoidEl.getBoundingClientRect();
    let x = ar.right + 8;
    if (x + w > window.innerWidth) x = ar.left - w - 8;
    let y = ar.top;
    if (y < 8) y = 8;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  } else {
    let x = ev.clientX + 16;
    let y = ev.clientY - h / 2;
    if (x + w > window.innerWidth) x = ev.clientX - w - 16;
    if (y < 8) y = 8;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
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
  STATE.loadedDeckName = null;
  STATE.loadedDeckFolder = null;
  STATE.loadedDeckTags = [];
  updateSaveButtons();
  markDeckClean();
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
  resetHistory();
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
  resetHistory();
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

// Ask the user whether to merge the maybeboard into the sideboard at export
// time. Called from the cod/txt export handlers, gated on the maybeboard
// actually having cards. Returns a Promise that resolves to 'merge',
// 'keep', or 'cancel'. The modal HTML lives in index.html (#maybe-export-
// modal); we mutate its message to fit the chosen export format.
function promptMaybeboardInclusion(exportLabel) {
  return new Promise((resolve) => {
    const modal  = document.getElementById('maybe-export-modal');
    const msg    = document.getElementById('maybe-export-msg');
    const cancel = document.getElementById('maybe-export-cancel');
    const keep   = document.getElementById('maybe-export-keep');
    const merge  = document.getElementById('maybe-export-merge');
    const maybeCount = STATE.zones.maybe.piles.reduce((n, p) => n + p.length, 0);
    msg.textContent = `Your maybeboard has ${maybeCount} card${maybeCount === 1 ? '' : 's'}. `
                    + `For the ${exportLabel} export, merge them into the sideboard, `
                    + `or keep them as a separate maybeboard section?`;
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      cancel.removeEventListener('click', onCancel);
      keep.removeEventListener('click', onKeep);
      merge.removeEventListener('click', onMerge);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onCancel() { cleanup('cancel'); }
    function onKeep()   { cleanup('keep'); }
    function onMerge()  { cleanup('merge'); }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); onMerge(); }
    }
    const backdrop = modal.querySelector('.modal-backdrop');
    cancel.addEventListener('click', onCancel);
    keep.addEventListener('click', onKeep);
    merge.addEventListener('click', onMerge);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    // Default focus lands on the primary action so Enter merges.
    setTimeout(() => merge.focus(), 0);
  });
}

// Decide the maybeboard mode for the current export. Resolves synchronously
// to 'keep' when the maybeboard is empty (no prompt needed) — otherwise
// awaits the user's choice from the modal.
async function resolveMaybeMode(exportLabel) {
  const maybeCount = STATE.zones.maybe.piles.reduce((n, p) => n + p.length, 0);
  if (maybeCount === 0) return 'keep';
  return promptMaybeboardInclusion(exportLabel);
}

function buildCodXml(maybeMode) {
  // maybeMode is 'merge' | 'keep' (default). 'merge' folds maybeboard into
  // sideboard in the exported XML so tools that don't understand a
  // <zone name="maybe"> still see those cards.
  const mode  = maybeMode || 'keep';
  const main  = aggregateZone('main');
  const maybe = aggregateZone('maybe');
  let side    = aggregateZone('side');
  if (mode === 'merge') {
    const merged = new Map();
    for (const { count, card } of side) merged.set(card.name, { count, card });
    for (const { count, card } of maybe) {
      const ent = merged.get(card.name);
      if (ent) ent.count += count;
      else merged.set(card.name, { count, card });
    }
    side = Array.from(merged.values()).sort((a, b) => a.card.name.localeCompare(b.card.name));
  }
  // Suppress the separate <zone name="maybe"> when merging.
  const maybeForXml = mode === 'merge' ? [] : maybe;

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

  return `<?xml version="1.0" encoding="UTF-8"?>
<cockatrice_deck version="1">
    <deckname></deckname>
    <comments></comments>
    <tags/>
${renderZone('main', main)}${renderZone('side', side)}${renderZone('maybe', maybeForXml)}</cockatrice_deck>
`;
}

// Save a Cockatrice .cod file. On browsers that support the File System
// Access API (Chromium-family) the user gets a real "save as" dialog and
// picks where the file goes. On other browsers (Firefox, Safari) we fall
// back to the standard download-to-Downloads-folder behaviour.
async function exportCod() {
  const maybeMode = await resolveMaybeMode('.cod');
  if (maybeMode === 'cancel') return;
  const xml = buildCodXml(maybeMode);
  const filename = 'deck.cod';
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Cockatrice deck',
          accept: { 'application/xml': ['.cod'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(xml);
      await writable.close();
      return;
    } catch (e) {
      // User cancelled the dialog — that's not an error, just bail.
      if (e && e.name === 'AbortError') return;
      // Anything else: log and fall through to the download fallback so
      // the user still gets their file.
      console.warn('showSaveFilePicker failed, falling back to download:', e);
    }
  }
  downloadFile(filename, xml, 'application/xml');
}

// ---------------------------------------------------------------------------
// Paste-import modal + clipboard copy
// ---------------------------------------------------------------------------

function wirePasteImport() {
  const modal = document.getElementById('paste-modal');
  const textarea = document.getElementById('paste-textarea');
  const open = () => {
    textarea.value = '';
    modal.classList.remove('hidden');
    // Defer focus until after the modal is shown so the cursor lands in the
    // textarea reliably across browsers.
    setTimeout(() => textarea.focus(), 0);
  };
  const close = () => modal.classList.add('hidden');
  const submit = () => {
    const text = textarea.value;
    if (!text.trim()) { close(); return; }
    importTxt(text);
    STATE.loadedDeckName = null;
    STATE.loadedDeckFolder = null;
    STATE.loadedDeckTags = [];
    updateSaveButtons();
    markDeckClean();
    close();
  };

  document.getElementById('btn-paste-import').addEventListener('click', open);
  document.getElementById('paste-cancel').addEventListener('click', close);
  document.getElementById('paste-confirm').addEventListener('click', submit);
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (modal.classList.contains('hidden')) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
}

// ---------------------------------------------------------------------------
// Saved decks (localStorage)
// ---------------------------------------------------------------------------

const SAVED_DECK_PREFIX = 'rev-deckbuilder-savedeck:';

function listSavedDecks() {
  // Returns [{ name, savedAt, folder, tags }] sorted by savedAt descending
  // (newest first). `folder` is a string or null; `tags` is always an array.
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SAVED_DECK_PREFIX)) continue;
    try {
      const obj = JSON.parse(localStorage.getItem(key));
      if (obj && typeof obj.name === 'string') {
        out.push({
          name: obj.name,
          savedAt: obj.savedAt || '',
          folder: (typeof obj.folder === 'string' && obj.folder) ? obj.folder : null,
          tags: Array.isArray(obj.tags) ? obj.tags.slice() : [],
        });
      }
    } catch (_) { /* ignore corrupted entries */ }
  }
  out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return out;
}

function readDeckMeta(name) {
  // Returns { folder, tags } for a saved deck, or nulls if not found.
  try {
    const obj = JSON.parse(localStorage.getItem(SAVED_DECK_PREFIX + name));
    if (!obj) return { folder: null, tags: [] };
    return {
      folder: (typeof obj.folder === 'string' && obj.folder) ? obj.folder : null,
      tags: Array.isArray(obj.tags) ? obj.tags.slice() : [],
    };
  } catch (_) { return { folder: null, tags: [] }; }
}

function writeDeckMeta(name, { folder, tags }) {
  // Update only the folder/tags fields of an existing saved deck. No-op if
  // the deck is missing. Does not touch the dirty-snapshot — metadata edits
  // are independent of zone edits.
  const raw = localStorage.getItem(SAVED_DECK_PREFIX + name);
  if (!raw) return;
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  if (!payload) return;
  payload.folder = (typeof folder === 'string' && folder) ? folder : null;
  payload.tags = Array.isArray(tags) ? tags.slice() : [];
  localStorage.setItem(SAVED_DECK_PREFIX + name, JSON.stringify(payload));
  if (STATE.loadedDeckName === name) {
    STATE.loadedDeckFolder = payload.folder;
    STATE.loadedDeckTags = payload.tags.slice();
  }
}

function getAllTags() {
  // Unique tag list across all saved decks, sorted alphabetically (case-insensitive),
  // preserving first-seen casing.
  const seen = new Map(); // lower -> original
  for (const d of listSavedDecks()) {
    for (const t of d.tags) {
      const k = t.toLowerCase();
      if (!seen.has(k)) seen.set(k, t);
    }
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function getAllFolders() {
  const seen = new Map();
  for (const d of listSavedDecks()) {
    if (!d.folder) continue;
    const k = d.folder.toLowerCase();
    if (!seen.has(k)) seen.set(k, d.folder);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Parse a deck-filter query into structured criteria.
// Grammar:
//   tag:<value>         require exact tag (case-insensitive)
//   -tag:<value>        forbid tag
//   folder:<value>      require exact folder (case-insensitive)
//   "quoted value"      spaces inside quotes don't split
//   <bare words>        case-insensitive substring match on deck name
// Returns { terms, tags, notTags, folder } where folder is a string or null.
function parseDeckFilter(query) {
  const out = { terms: [], tags: [], notTags: [], folder: null };
  if (!query) return out;
  const toks = [];
  let i = 0, cur = '', inQ = false;
  while (i < query.length) {
    const c = query[i];
    if (c === '"') { inQ = !inQ; i++; continue; }
    if (!inQ && /\s/.test(c)) {
      if (cur) { toks.push(cur); cur = ''; }
      i++; continue;
    }
    cur += c; i++;
  }
  if (cur) toks.push(cur);
  for (const tok of toks) {
    const mTag = /^(-)?tag:(.+)$/i.exec(tok);
    if (mTag && mTag[2]) {
      const neg = !!mTag[1];
      (neg ? out.notTags : out.tags).push(mTag[2].toLowerCase());
      continue;
    }
    const mFolder = /^folder:(.+)$/i.exec(tok);
    if (mFolder && mFolder[1]) {
      out.folder = mFolder[1].toLowerCase();
      continue;
    }
    out.terms.push(tok.toLowerCase());
  }
  return out;
}

function deckMatchesFilter(deck, filter) {
  if (filter.folder !== null) {
    if (!deck.folder || deck.folder.toLowerCase() !== filter.folder) return false;
  }
  if (filter.tags.length) {
    const have = new Set(deck.tags.map(t => t.toLowerCase()));
    for (const t of filter.tags) if (!have.has(t)) return false;
  }
  if (filter.notTags.length) {
    const have = new Set(deck.tags.map(t => t.toLowerCase()));
    for (const t of filter.notTags) if (have.has(t)) return false;
  }
  if (filter.terms.length) {
    const lname = deck.name.toLowerCase();
    const lTags = deck.tags.map(t => t.toLowerCase());
    for (const t of filter.terms) {
      if (lname.includes(t)) continue;
      if (lTags.some(tg => tg.includes(t))) continue;
      return false;
    }
  }
  return true;
}

function saveDeckToStorage(name, opts) {
  // Serialize the current zones as arrays of card-name arrays so the deck
  // survives a refresh of the underlying card-data (where ids change).
  // `opts.folder` / `opts.tags` override; if omitted, existing metadata is
  // preserved (so "Save" on a loaded deck doesn't wipe its folder/tags).
  const zones = {};
  for (const z of ['main', 'side', 'maybe']) {
    zones[z] = STATE.zones[z].piles.map(pile => pile.map(inst => {
      const c = STATE.byId.get(inst.cardId);
      return c ? c.name : null;
    }).filter(n => n != null));
  }
  const prev = readDeckMeta(name);
  const folder = opts && 'folder' in opts
    ? ((typeof opts.folder === 'string' && opts.folder) ? opts.folder : null)
    : prev.folder;
  const tags = opts && 'tags' in opts
    ? (Array.isArray(opts.tags) ? opts.tags.slice() : [])
    : prev.tags;
  const payload = {
    name,
    savedAt: new Date().toISOString(),
    zones,
    format: STATE.format,
    rangeStart: STATE.rangeStart,
    rangeEnd: STATE.rangeEnd,
    folder,
    tags,
  };
  localStorage.setItem(SAVED_DECK_PREFIX + name, JSON.stringify(payload));
  markDeckClean();
}

function loadDeckFromStorage(name) {
  const raw = localStorage.getItem(SAVED_DECK_PREFIX + name);
  if (!raw) return false;
  let payload;
  try { payload = JSON.parse(raw); }
  catch (_) { return false; }
  if (!payload || !payload.zones) return false;

  // Replace all zones, resolving card names against the current card index.
  // Cards that no longer exist (renamed / removed upstream) are dropped.
  const unknown = [];
  for (const z of ['main', 'side', 'maybe']) {
    const piles = (payload.zones[z] || []).map(pileNames => {
      const pile = [];
      for (const name of pileNames) {
        const card = STATE.byName.get(name);
        if (!card) {
          // Fall back: any card with the same canonical (handles split-card
          // naming inconsistencies the same way refresh-migration does).
          const fallback = STATE.cards.find(c => c.canonical === canonicalName(name));
          if (fallback) pile.push({ uid: newUid(), cardId: fallback.id });
          else unknown.push(name);
          continue;
        }
        pile.push({ uid: newUid(), cardId: card.id });
      }
      return pile;
    }).filter(p => p.length > 0);
    STATE.zones[z].piles = piles;
  }
  STATE.selection.clear();
  if (payload.format === 'standard' || payload.format === 'eternal' || payload.format === 'range') {
    STATE.format = payload.format;
    STATE.rangeStart = payload.rangeStart || null;
    STATE.rangeEnd = payload.rangeEnd || null;
    savePrefs();
    syncFormatUI();
    runSearch(document.getElementById('search').value);
  }
  renderAll();
  resetHistory();
  markDeckClean();
  if (unknown.length > 0) reportUnknown(unknown);
  return true;
}

function deleteDeckFromStorage(name) {
  localStorage.removeItem(SAVED_DECK_PREFIX + name);
}

function deckIsEmpty() {
  return Object.keys(STATE.zones).every(z => totalCount(z) === 0);
}

// Serialize zone state to a stable string for dirty-checking. Uses card names
// in pile order (same representation as saveDeckToStorage) so uid differences
// don't create false positives.
function snapshotDeck() {
  const zones = {};
  for (const z of ['main', 'side', 'maybe']) {
    zones[z] = STATE.zones[z].piles.map(pile => pile.map(inst => {
      const c = STATE.byId.get(inst.cardId);
      return c ? c.name : null;
    }));
  }
  return JSON.stringify(zones);
}

function markDeckClean() {
  STATE.deckSnapshot = snapshotDeck();
}

function deckIsDirty() {
  return STATE.deckSnapshot !== snapshotDeck();
}

function updateSaveButtons() {
  const saveBtn = document.getElementById('btn-save-deck');
  const saveAsBtn = document.getElementById('btn-save-as');
  if (STATE.loadedDeckName) {
    saveBtn.textContent = 'Save deck';
    saveAsBtn.classList.remove('hidden');
    document.title = STATE.loadedDeckName + ' — Revolution Deckbuilder';
  } else {
    saveBtn.textContent = 'Save deck';
    saveAsBtn.classList.add('hidden');
    document.title = 'Revolution Deckbuilder';
  }
}

// Show a name-conflict modal and return a promise resolving to
// 'overwrite', 'keep-both', or null (cancel).
function showNameConflict(name, verb) {
  return new Promise((resolve) => {
    const modal = document.getElementById('name-conflict-modal');
    const msg = document.getElementById('conflict-msg');
    document.getElementById('conflict-title').textContent = 'Name conflict';
    msg.textContent = 'A deck named \u201c' + name + '\u201d already exists. What would you like to do?';
    modal.classList.remove('hidden');
    function cleanup() {
      modal.classList.add('hidden');
      document.getElementById('conflict-overwrite').removeEventListener('click', onOverwrite);
      document.getElementById('conflict-keep-both').removeEventListener('click', onKeepBoth);
      document.getElementById('conflict-cancel').removeEventListener('click', onCancel);
      modal.querySelector('.modal-backdrop').removeEventListener('click', onCancel);
    }
    function onOverwrite() { cleanup(); resolve('overwrite'); }
    function onKeepBoth()  { cleanup(); resolve('keep-both'); }
    function onCancel()    { cleanup(); resolve(null); }
    document.getElementById('conflict-overwrite').addEventListener('click', onOverwrite);
    document.getElementById('conflict-keep-both').addEventListener('click', onKeepBoth);
    document.getElementById('conflict-cancel').addEventListener('click', onCancel);
    modal.querySelector('.modal-backdrop').addEventListener('click', onCancel);
  });
}

function showDeleteConfirm(name) {
  return new Promise((resolve) => {
    const modal = document.getElementById('delete-confirm-modal');
    document.getElementById('delete-confirm-msg').textContent =
      'Delete saved deck \u201c' + name + '\u201d? This cannot be undone.';
    modal.classList.remove('hidden');
    function cleanup() {
      modal.classList.add('hidden');
      document.getElementById('delete-confirm').removeEventListener('click', onYes);
      document.getElementById('delete-cancel').removeEventListener('click', onNo);
      modal.querySelector('.modal-backdrop').removeEventListener('click', onNo);
    }
    function onYes() { cleanup(); resolve(true); }
    function onNo()  { cleanup(); resolve(false); }
    document.getElementById('delete-confirm').addEventListener('click', onYes);
    document.getElementById('delete-cancel').addEventListener('click', onNo);
    modal.querySelector('.modal-backdrop').addEventListener('click', onNo);
  });
}

// Find a unique name by appending (2), (3), etc.
function uniqueDeckName(base) {
  let n = 2;
  let candidate = base + ' (' + n + ')';
  while (localStorage.getItem(SAVED_DECK_PREFIX + candidate)) {
    n++;
    candidate = base + ' (' + n + ')';
  }
  return candidate;
}

function wireSavedDecks() {
  const saveBtn = document.getElementById('btn-save-deck');
  const saveAsBtn = document.getElementById('btn-save-as');
  const saveDropdown = document.getElementById('save-name-dropdown');
  const nameInput = document.getElementById('save-deck-name');
  const saveFolderInput = document.getElementById('save-deck-folder');
  const saveFolderList = document.getElementById('save-deck-folder-list');
  const saveTagsHost = document.getElementById('save-deck-tags');
  const decksBtn = document.getElementById('btn-decks');
  const decksDropdown = document.getElementById('decks-dropdown');
  const filterInput = document.getElementById('decks-filter');
  const listEl = document.getElementById('decks-list');

  let filterText = '';
  const collapsedFolders = new Set();
  let saveDialogTags = [];

  function closeAllDropdowns() {
    saveDropdown.classList.add('hidden');
    decksDropdown.classList.add('hidden');
  }

  function mountChipEditor(host, { getTags, setTags, onClose, autoFocus = true }) {
    function focusInput() {
      const inp = host.querySelector('input');
      if (inp) inp.focus();
    }
    function render() {
      host.innerHTML = '';
      for (const tag of getTags()) {
        const chip = document.createElement('span');
        chip.className = 'deck-tag-chip';
        chip.textContent = tag;
        const x = document.createElement('span');
        x.className = 'chip-x';
        x.innerHTML = '&times;';
        x.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          setTags(getTags().filter(t => t !== tag));
          render();
          focusInput();
        });
        chip.appendChild(x);
        host.appendChild(chip);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = getTags().length ? '' : 'add tag…';
      input.setAttribute('list', 'all-deck-tags-datalist');
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' || ev.key === ',') {
          ev.preventDefault();
          const val = input.value.trim().replace(/,$/, '');
          if (val) {
            const tags = getTags();
            if (!tags.some(t => t.toLowerCase() === val.toLowerCase())) {
              setTags([...tags, val]);
              render();
              focusInput();
            } else { input.value = ''; }
          }
        } else if (ev.key === 'Backspace' && input.value === '') {
          const tags = getTags();
          if (tags.length) { setTags(tags.slice(0, -1)); render(); focusInput(); }
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          input.blur();
        }
      });
      input.addEventListener('click', (ev) => ev.stopPropagation());
      input.addEventListener('blur', () => {
        const val = input.value.trim();
        let added = false;
        if (val) {
          const tags = getTags();
          if (!tags.some(t => t.toLowerCase() === val.toLowerCase())) {
            setTags([...tags, val]);
            added = true;
          }
        }
        if (onClose) {
          onClose();
        } else if (added) {
          // Editor stays open (save dialog case) — re-render so the freshly
          // committed chip appears inline with the input the user is typing
          // into. No re-focus: the user actively moved away.
          render();
        }
      });
      host.appendChild(input);
      if (autoFocus) setTimeout(() => input.focus(), 0);
    }
    render();
  }

  function refreshTagsDatalist() {
    let dl = document.getElementById('all-deck-tags-datalist');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'all-deck-tags-datalist';
      document.body.appendChild(dl);
    }
    dl.innerHTML = '';
    for (const t of getAllTags()) {
      const opt = document.createElement('option');
      opt.value = t;
      dl.appendChild(opt);
    }
  }

  function refreshFolderDatalist() {
    if (!saveFolderList) return;
    saveFolderList.innerHTML = '';
    for (const f of getAllFolders()) {
      const opt = document.createElement('option');
      opt.value = f;
      saveFolderList.appendChild(opt);
    }
  }

  function refreshFoldersDatalist() {
    let dl = document.getElementById('all-deck-folders-datalist');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'all-deck-folders-datalist';
      document.body.appendChild(dl);
    }
    dl.innerHTML = '';
    for (const f of getAllFolders()) {
      const opt = document.createElement('option');
      opt.value = f;
      dl.appendChild(opt);
    }
  }

  function openSaveNameDropdown(mode /* 'new' | 'as' */) {
    closeAllDropdowns();
    refreshTagsDatalist();
    refreshFolderDatalist();
    if (mode === 'as' && STATE.loadedDeckName) {
      nameInput.value = STATE.loadedDeckName;
      saveFolderInput.value = STATE.loadedDeckFolder || '';
      saveDialogTags = (STATE.loadedDeckTags || []).slice();
    } else {
      nameInput.value = '';
      saveFolderInput.value = '';
      saveDialogTags = [];
    }
    mountChipEditor(saveTagsHost, {
      getTags: () => saveDialogTags,
      setTags: (v) => { saveDialogTags = v; },
      autoFocus: false,
    });
    saveDropdown.classList.remove('hidden');
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);
  }

  async function commitSaveName() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const folder = saveFolderInput.value.trim() || null;
    const tags = saveDialogTags.slice();
    const existing = localStorage.getItem(SAVED_DECK_PREFIX + name);
    let finalName = name;
    if (existing) {
      const choice = await showNameConflict(name, 'save');
      if (!choice) return;
      if (choice === 'keep-both') finalName = uniqueDeckName(name);
    }
    try { saveDeckToStorage(finalName, { folder, tags }); } catch (e) {
      alert('Could not save deck: ' + (e && e.message ? e.message : e)); return;
    }
    STATE.loadedDeckName = finalName;
    STATE.loadedDeckFolder = folder;
    STATE.loadedDeckTags = tags;
    closeAllDropdowns();
    updateSaveButtons();
  }

  saveBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (STATE.loadedDeckName) {
      try {
        saveDeckToStorage(STATE.loadedDeckName, {
          folder: STATE.loadedDeckFolder,
          tags: STATE.loadedDeckTags,
        });
      } catch (e) {
        alert('Could not save deck: ' + (e && e.message ? e.message : e));
      }
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => { saveBtn.textContent = orig; }, 1200);
    } else {
      if (saveDropdown.classList.contains('hidden')) openSaveNameDropdown('new');
      else closeAllDropdowns();
    }
  });

  saveAsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (saveDropdown.classList.contains('hidden')) openSaveNameDropdown('as');
    else closeAllDropdowns();
  });

  document.getElementById('save-name-ok').addEventListener('click', (ev) => {
    ev.stopPropagation();
    commitSaveName();
  });
  document.getElementById('save-name-cancel').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeAllDropdowns();
  });
  nameInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitSaveName(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeAllDropdowns(); }
  });
  nameInput.addEventListener('click', (ev) => ev.stopPropagation());
  saveFolderInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitSaveName(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closeAllDropdowns(); }
  });
  saveFolderInput.addEventListener('click', (ev) => ev.stopPropagation());

  function renderDecksList() {
    listEl.innerHTML = '';
    const all = listSavedDecks();
    if (all.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'saved-decks-empty';
      empty.textContent = 'No saved decks yet.';
      listEl.appendChild(empty);
      return;
    }
    const filter = parseDeckFilter(filterText);
    const hasFilter = filterText.trim().length > 0;
    const decks = all.filter(d => deckMatchesFilter(d, filter));
    if (decks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'saved-decks-empty';
      empty.textContent = 'No decks match.';
      listEl.appendChild(empty);
      return;
    }
    const hasAnyFolder = all.some(d => !!d.folder);
    const useTree = hasAnyFolder && !hasFilter;
    if (!useTree) {
      for (const deck of decks) listEl.appendChild(buildDeckRow(deck, false));
      return;
    }
    const groups = new Map();
    const unfiled = [];
    for (const d of decks) {
      if (!d.folder) { unfiled.push(d); continue; }
      const k = d.folder.toLowerCase();
      if (!groups.has(k)) groups.set(k, { display: d.folder, decks: [] });
      groups.get(k).decks.push(d);
    }
    // Unfiled decks render as flat rows at the top — no collapsible header —
    // so the no-folders-used experience matches the pre-folders UI.
    for (const deck of unfiled) listEl.appendChild(buildDeckRow(deck, false));
    const sortedKeys = [...groups.keys()].sort();
    for (const k of sortedKeys) {
      const g = groups.get(k);
      renderFolderGroup(g.display, g.decks);
    }
  }
  function renderFolderGroup(folderName, groupDecks) {
    const displayKey = folderName || '__unfiled__';
    const isCollapsed = collapsedFolders.has(displayKey);
    const header = document.createElement('div');
    header.className = 'deck-folder-header' + (isCollapsed ? ' collapsed' : '');
    const caret = document.createElement('span');
    caret.className = 'deck-folder-caret';
    caret.innerHTML = '&#x25BE;';
    header.appendChild(caret);
    const nm = document.createElement('span');
    nm.className = 'deck-folder-name';
    nm.textContent = folderName || '—';
    header.appendChild(nm);
    const ct = document.createElement('span');
    ct.className = 'deck-folder-count';
    ct.textContent = String(groupDecks.length);
    header.appendChild(ct);
    header.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (collapsedFolders.has(displayKey)) collapsedFolders.delete(displayKey);
      else collapsedFolders.add(displayKey);
      renderDecksList();
    });
    listEl.appendChild(header);
    if (isCollapsed) return;
    for (const deck of groupDecks) listEl.appendChild(buildDeckRow(deck, true));
  }

  function buildDeckRow(deck, indent) {
    const row = document.createElement('div');
    row.className = 'saved-deck-row' + (indent ? ' indent' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'deck-name';
    nameEl.textContent = deck.name;
    row.appendChild(nameEl);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'deck-action';
    renameBtn.dataset.title = 'Edit name and folder';
    renameBtn.innerHTML = '&#x270E;';
    renameBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      startEdit(row, deck.name);
    });
    row.appendChild(renameBtn);

    const tagBtn = document.createElement('button');
    tagBtn.className = 'deck-action';
    tagBtn.dataset.title = 'Edit tags';
    tagBtn.textContent = '\u{1F3F7}';
    tagBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      startTagEdit(row, deck.name);
    });
    row.appendChild(tagBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'deck-action deck-delete';
    delBtn.dataset.title = 'Delete';
    delBtn.innerHTML = '&#x1f5d1;';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await showDeleteConfirm(deck.name);
      if (!ok) return;
      deleteDeckFromStorage(deck.name);
      if (STATE.loadedDeckName === deck.name) {
        STATE.loadedDeckName = null;
        STATE.loadedDeckFolder = null;
        STATE.loadedDeckTags = [];
        updateSaveButtons();
      }
      renderDecksList();
    });
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      if (deckIsDirty() && !confirm('Replace the current deck with “' + deck.name + '”?')) return;
      const ok = loadDeckFromStorage(deck.name);
      if (!ok) { alert('Could not load deck “' + deck.name + '”'); return; }
      const meta = readDeckMeta(deck.name);
      STATE.loadedDeckName = deck.name;
      STATE.loadedDeckFolder = meta.folder;
      STATE.loadedDeckTags = meta.tags;
      updateSaveButtons();
      closeAllDropdowns();
    });

    return row;
  }

  function startEdit(row, oldName) {
    refreshFoldersDatalist();
    const meta = readDeckMeta(oldName);
    row.innerHTML = '';
    row.classList.add('editing');

    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'deck-folder-input';
    folderInput.setAttribute('list', 'all-deck-folders-datalist');
    folderInput.placeholder = 'folder (optional)';
    folderInput.value = meta.folder || '';
    folderInput.spellcheck = false;
    row.appendChild(folderInput);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'deck-name-input';
    nameInput.value = oldName;
    nameInput.spellcheck = false;
    row.appendChild(nameInput);

    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);

    let handled = false;
    async function finishEdit() {
      if (handled) return;
      handled = true;
      const newName = nameInput.value.trim();
      const newFolder = folderInput.value.trim() || null;
      let finalName = oldName;
      if (newName && newName !== oldName) {
        const existing = localStorage.getItem(SAVED_DECK_PREFIX + newName);
        if (existing) {
          const choice = await showNameConflict(newName, 'rename');
          if (!choice) { renderDecksList(); return; }
          if (choice === 'keep-both') {
            finalName = uniqueDeckName(newName);
            renameDeck(oldName, finalName);
          } else {
            deleteDeckFromStorage(newName);
            renameDeck(oldName, newName);
            finalName = newName;
          }
        } else {
          renameDeck(oldName, newName);
          finalName = newName;
        }
      }
      const keepTags = readDeckMeta(finalName).tags;
      writeDeckMeta(finalName, { folder: newFolder, tags: keepTags });
      renderDecksList();
    }

    function onKey(ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finishEdit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); handled = true; renderDecksList(); }
    }
    function onBlur() {
      setTimeout(() => {
        if (handled) return;
        if (document.activeElement === nameInput || document.activeElement === folderInput) return;
        finishEdit();
      }, 0);
    }
    nameInput.addEventListener('keydown', onKey);
    folderInput.addEventListener('keydown', onKey);
    nameInput.addEventListener('blur', onBlur);
    folderInput.addEventListener('blur', onBlur);
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    folderInput.addEventListener('click', (ev) => ev.stopPropagation());
  }

  function renameDeck(oldName, newName) {
    const raw = localStorage.getItem(SAVED_DECK_PREFIX + oldName);
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      payload.name = newName;
      localStorage.setItem(SAVED_DECK_PREFIX + newName, JSON.stringify(payload));
      localStorage.removeItem(SAVED_DECK_PREFIX + oldName);
      if (STATE.loadedDeckName === oldName) {
        STATE.loadedDeckName = newName;
        updateSaveButtons();
      }
    } catch (_) {}
  }

  function startTagEdit(row, name) {
    refreshTagsDatalist();
    const meta = readDeckMeta(name);
    let tags = meta.tags.slice();
    row.innerHTML = '';
    row.classList.add('editing');
    const nameEl = document.createElement('span');
    nameEl.className = 'deck-name';
    nameEl.textContent = name;
    row.appendChild(nameEl);
    const host = document.createElement('div');
    host.className = 'tag-chip-editor';
    host.addEventListener('click', (ev) => ev.stopPropagation());
    row.appendChild(host);
    mountChipEditor(host, {
      getTags: () => tags,
      setTags: (v) => { tags = v; },
      onClose: () => {
        writeDeckMeta(name, { folder: meta.folder, tags });
        renderDecksList();
      },
    });
  }

  decksBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (decksDropdown.classList.contains('hidden')) {
      closeAllDropdowns();
      renderDecksList();
      const btnLeft = decksBtn.getBoundingClientRect().left;
      const available = Math.max(280, window.innerWidth - btnLeft - 8);
      decksDropdown.style.maxWidth = available + 'px';
      decksDropdown.classList.remove('hidden');
      setTimeout(() => filterInput.focus(), 0);
    } else {
      closeAllDropdowns();
    }
  });

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    renderDecksList();
  });
  filterInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      if (filterInput.value) {
        filterInput.value = '';
        filterText = '';
        renderDecksList();
      } else {
        closeAllDropdowns();
      }
    }
  });
  filterInput.addEventListener('click', (ev) => ev.stopPropagation());

  // Stop clicks inside dropdowns from closing them
  saveDropdown.addEventListener('click', (ev) => ev.stopPropagation());
  decksDropdown.addEventListener('click', (ev) => ev.stopPropagation());

  // Close dropdowns when clicking elsewhere
  document.addEventListener('click', () => closeAllDropdowns());
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAllDropdowns();
  });
}

function wireCopyTxt() {
  const btn = document.getElementById('btn-copy-txt');
  btn.addEventListener('click', async () => {
    const maybeMode = await resolveMaybeMode('clipboard');
    if (maybeMode === 'cancel') return;
    const text = buildTxtExport(maybeMode);
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied \u2713';
    } catch (e) {
      console.error(e);
      btn.textContent = 'Copy failed';
      alert('Could not copy to clipboard: ' + (e && e.message ? e.message : e));
    }
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

// Build the plain decklist text used by Export to clipboard:
//   "<count> <name>" lines, with a blank line separating zones.
// We write main, then side, then maybe (if present). No header line —
// the imported title line, if any, isn't tracked in state.
// `maybeMode` is 'merge' | 'keep'. 'merge' folds the maybeboard into the
// sideboard section (no third section in the output).
function buildTxtExport(maybeMode) {
  const mode = maybeMode || 'keep';
  const main  = aggregateZone('main');
  const maybe = aggregateZone('maybe');
  let side    = aggregateZone('side');
  if (mode === 'merge' && maybe.length) {
    const merged = new Map();
    for (const { count, card } of side) merged.set(card.name, { count, card });
    for (const { count, card } of maybe) {
      const ent = merged.get(card.name);
      if (ent) ent.count += count;
      else merged.set(card.name, { count, card });
    }
    side = Array.from(merged.values()).sort((a, b) => a.card.name.localeCompare(b.card.name));
  }
  const sections = [];
  if (main.length) sections.push(main.map(({ count, card }) => `${count} ${card.name}`).join('\n'));
  if (side.length) sections.push(side.map(({ count, card }) => `${count} ${card.name}`).join('\n'));
  if (mode !== 'merge' && maybe.length) {
    sections.push(maybe.map(({ count, card }) => `${count} ${card.name}`).join('\n'));
  }
  return sections.join('\n\n') + '\n';
}
