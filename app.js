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

// Voyager is a parallel custom format with its own card pool. Its card data
// lives in a Cockatrice-format XML file at a separate GitHub Pages host.
// Selecting "Voyager" in the format dropdown swaps the entire card index
// (no overlap with Revolution, including alt-art reprints).
const VOYAGER_URL = 'https://voyager-mtg.github.io/lists/cards.xml';

// localStorage keys for parsed card-data snapshots, one slot per dataset.
// v14 bump: Voyager reprints now get `_SETCODE` suffixes so alt printings
// survive save/load (prior cache has 17 collapsed Mountains etc.) and the
// user's chosen art is preserved.
const STORAGE_VERSION = 15;
const STORAGE_KEY = `rev-deckbuilder-cards-v${STORAGE_VERSION}`;
const VOYAGER_STORAGE_KEY = `rev-deckbuilder-voyager-v${STORAGE_VERSION}`;

// In-memory snapshot of each dataset's parsed card data, used by
// loadDatasetData so a within-session round-trip (Voyager → Revolution →
// Voyager) survives even when the localStorage write silently failed —
// the parsed payload is ~10MB and reliably exceeds the 5–10MB origin quota
// in most browsers, which would otherwise wipe a fresh "Update cards"
// refresh on the way back. Cleared at page unload.
const _datasetSessionCache = { revolution: null, voyager: null };

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
  // `sanctum` is a Voyager-specific zone (basic lands, Wonder-subtype cards,
  // and cards with Pathbound/Transcend/Usurpate/Heir keywords). It lives in
  // STATE unconditionally so zone-iteration sites don't need per-dataset
  // branching; the UI hides it via a body class when not in Voyager mode.
  zones: {
    main:    { piles: [] },
    sanctum: { piles: [] },
    side:    { piles: [] },
    maybe:   { piles: [] },
  },

  focusedZone: 'main',  // 'main' | 'side' | 'maybe' | 'search' (only when searchPanel is on)
  searchPanel: false,   // when true, hide the dropdown and render results in the pile pane
  format: 'standard',   // 'standard' | 'eternal' | 'range' | 'voyager'
  rangeStart: null,     // set code (only meaningful when format === 'range')
  rangeEnd: null,       // set code (only meaningful when format === 'range')
  // Per-dataset stash. On dataset switch we snapshot the outgoing dataset's
  // full working state (zones + loaded-deck pointer + dirty baseline) here,
  // and restore it when the user returns. This makes each dataset feel like
  // a persistent workspace: unsaved edits survive, and a loaded deck stays
  // loaded (not just its cards). Slot is null until first used.
  stashedByDataset: { revolution: null, voyager: null },
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

  // Sideboard-plan state. A plan is a named alternate partitioning of the
  // loaded deck's main+side into main+side — same 75 cards, different split.
  // Plans live inside the deck's payload under `plans[]`. While a plan is
  // active, the maybeboard is locked (plans don't touch maybe).
  loadedPlanName: null, // string | null; null means editing the base deck
  basePlanZones: null,  // { main: [[names],…], side: [[names],…] } | null;
                        // captured from the base deck when a plan is loaded,
                        // used for the live "75 matches" diff indicator.

  // Undo/redo history. `lastSnapshot` mirrors the zones JSON as of the last
  // commit; renderAll() compares a fresh serialization against it and pushes
  // the previous value onto `past` whenever they differ. `future` holds the
  // stack of states the user can redo into (populated by undo()).
  history: { past: [], future: [], lastSnapshot: null },

  // Tags (loaded from static/tags.json). Keyed by dataset, then by
  // canonical card name. `order` is the tag MRU list — the most recently
  // added-to tag is first; what the tagger sidebar and `is:<tag>` searches
  // both read. Revolution and Voyager have separate maps so a tag applied
  // in one dataset never leaks into the other.
  // `aliases` maps lowercased alternate names to the canonical display
  // name. Cards never store aliases — when a user types or searches an
  // alias it resolves once to the canonical, and the canonical is what
  // gets read/written. Aliasing "kill" → "removal" makes is:kill find
  // every removal-tagged card in the deckbuilder too.
  tags: {
    revolution: { cards: {}, order: [], aliases: {} },
    voyager:    { cards: {}, order: [], aliases: {} },
  },
  // Tagging tool — set to true when app.js is loaded via tags.html (which
  // sets window.TAG_MODE before the script tag). Switches the sidebar to
  // tag sections, swaps the search-tile action buttons, and enables
  // drag-to-tag drops. Never flips at runtime.
  tagMode: !!(typeof window !== 'undefined' && window.TAG_MODE),
  focusedTag: null,     // which tag section is currently showing in the pile pane
  lastUsedTag: null,    // most-recent tag applied — the "repeat" button uses this
  tagSaveState: 'idle', // 'idle' | 'saving' | 'saved' | 'error' | 'offline'
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

const ZONE_LABELS = { main: 'Main', sanctum: 'Sanctum', side: 'Sideboard', maybe: 'Maybeboard' };

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
    if (isPlanActive()) {
      // All deletions are blocked under a plan — removing from main/side
      // breaks the 75, and maybe is frozen.
      notePlanLock("Plan has a fixed 75 — can't delete cards.");
      hideDragTrash();
      return;
    }
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

  // Pick the dataset matching the persisted format. If loading Voyager
  // fails (first-ever switch + offline, bad fetch), fall back to Revolution
  // / Standard so the page still boots into a usable state.
  let data = null;
  try {
    data = await loadDatasetData(currentDataset());
  } catch (e) {
    console.warn('Could not load active dataset, falling back to Standard:', e);
    if (currentDataset() !== 'revolution') {
      STATE.format = 'standard';
      savePrefs();
      data = await loadDatasetData('revolution');
    } else {
      throw e;
    }
  }
  applyCardData(data);

  // Tags are a separate static asset, read from disk (or /tags.json on the
  // deployed host). Loading runs in parallel with wiring — the file is
  // tiny and only affects is:<tag> matches + the tagger sidebar, both of
  // which tolerate empty tags cleanly.
  await loadTags();

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
  if (STATE.tagMode) initTagMode();
  markDeckClean();
  // Paint the initial zone counts (and their validity badges) so an empty
  // deck already shows "main < 60" red on page load, without waiting for
  // the first user action to trigger renderAll.
  renderAll();

  // If the page was loaded with `#d=<payload>`, decode it and replace the
  // current deck. The loader handles dataset mismatches (offers to switch
  // to Revolution) and unsaved-work guards on its own.
  await loadDeckFromUrlFragment();

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
      if (obj.format === 'standard' || obj.format === 'eternal' || obj.format === 'range' || obj.format === 'voyager') {
        STATE.format = obj.format;
      }
      if (typeof obj.rangeStart === 'string') STATE.rangeStart = obj.rangeStart;
      if (typeof obj.rangeEnd === 'string')   STATE.rangeEnd   = obj.rangeEnd;
      if (obj.theme === 'light' || obj.theme === 'dark') STATE.theme = obj.theme;
      // searchPanel intentionally not restored — every fresh load boots into
      // the main pane in dropdown mode, regardless of where the prior
      // session left off.
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
        defense: c.defense != null ? String(c.defense) : extractDefenseFromText(c.text),
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
        defense: c.defense != null ? String(c.defense) : extractDefenseFromText(c.text),
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
          defense: '',
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
  _datasetSessionCache.revolution = data;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Could not persist refreshed card data:', e);
  }
}

// ---------------------------------------------------------------------------
// XML ingestion (Voyager — Cockatrice carddatabase format)
// ---------------------------------------------------------------------------

// Cockatrice writes type-line subtype separators as U+2013 (en-dash);
// parseTypeLineParts splits on U+2014 (em-dash), matching Revolution's
// mtgjson convention. Normalize at parse time so the helper keeps its
// existing contract.
function normalizeTypeDash(s) { return s.replace(/–/g, '—'); }

// Turn Voyager's bare mana-cost form ("4I/BI/B", "R/W", "XG") into the
// mtgjson-style braced form ("{4}{I/B}{I/B}", "{R/W}", "{X}{G}") so the
// existing formatManaCost / colorsFromManaCost / cmcFromManaCost helpers
// can consume it unchanged. Digits form one generic pip; a bare letter is
// one pip; LETTER/LETTER is one hybrid pip. Unknown characters are
// skipped to keep the loop bounded.
function voyagerBareManaToBraced(bare) {
  if (!bare) return '';
  const out = [];
  let i = 0;
  while (i < bare.length) {
    const ch = bare[i];
    if (ch === ' ') { i++; continue; }
    if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < bare.length && /\d/.test(bare[j])) j++;
      out.push(bare.slice(i, j));
      i = j;
    } else if (/[A-Za-z]/.test(ch)) {
      if (i + 2 < bare.length && bare[i + 1] === '/' && /[A-Za-z]/.test(bare[i + 2])) {
        out.push(bare.slice(i, i + 3));
        i += 3;
      } else {
        out.push(ch);
        i++;
      }
    } else {
      i++;
    }
  }
  return out.map(t => '{' + t + '}').join('');
}

// Build the "back face" record (attached as card.back on the front) from a
// Cockatrice <card> element whose <prop><side> is "back". Mirrors the
// back-face shape that parseAllSetsJson emits for transform cards.
function buildVoyagerBackCard(el) {
  const get = sel => (el.querySelector(sel)?.textContent || '').trim();
  const name = get(':scope > name');
  const text = (el.querySelector(':scope > text')?.textContent || '');
  const typeLine = normalizeTypeDash(get('prop > type'));
  const typeParts = parseTypeLineParts(typeLine);
  const bareMc = get('prop > manacost');
  const rawManaCost = voyagerBareManaToBraced(bareMc);
  const ptText = get('prop > pt');
  let power = '', toughness = '';
  if (ptText) {
    const slash = ptText.indexOf('/');
    if (slash >= 0) { power = ptText.slice(0, slash); toughness = ptText.slice(slash + 1); }
  }
  const setEl = el.querySelector(':scope > set');
  const setCode = (setEl?.textContent || '').trim();
  const num = (setEl?.getAttribute('num') || '').trim();
  const picurlRaw = (setEl?.getAttribute('picurl') || '').trim();
  return {
    name,
    canonical: name,
    text,
    type: typeLine,
    maintype: pickMainType(typeParts.types),
    subtypes: typeParts.subtypes,
    supertypes: typeParts.supertypes,
    types: typeParts.types,
    manacost: formatManaCost(rawManaCost),
    rawManaCost,
    colors: get('prop > colors').toUpperCase(),
    power,
    toughness,
    loyalty: get('prop > loyalty'),
    artist: '',
    flavor: '',
    keywords: extractKeywords(text),
    layout: get('prop > layout') || 'normal',
    set: setCode,
    num,
    imgVersion: 0,
    picUrl: picurlRaw ? encodeURI(picurlRaw) : '',
  };
}

// Parse the Voyager cards.xml document into the same {cards, sets, uuidMap,
// allSetCodes} shape parseAllSetsJson returns, so applyCardData can ingest
// it interchangeably. Transform backs are merged onto their front via the
// <related attach="transform"> pointer; adventure halves become pageFace.
function parseCockatriceXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error('failed to parse Voyager cards.xml: ' + (perr.textContent || ''));

  // Set order is unavailable in the XML, so fabricate release dates from
  // declaration order. That way setsByCode.releasedate stays populated and
  // pile sort-by-set has a stable order for Voyager.
  const sets = {};
  const allSetCodes = new Set();
  const setEls = Array.from(doc.querySelectorAll('sets > set'));
  setEls.forEach((setEl, idx) => {
    const code = (setEl.querySelector('name')?.textContent || '').trim();
    if (!code) return;
    const longname = (setEl.querySelector('longname')?.textContent || '').trim();
    const day = new Date(Date.UTC(2020, 0, 1 + idx));
    sets[code] = { code, longname, releasedate: day.toISOString().slice(0, 10) };
    allSetCodes.add(code);
  });

  // Index every back-side card by (set, name) so front cards can attach
  // their back-face in one pass below. A card with multiple printings of
  // the same transform pair — e.g. Hazard Technician // Hazardous
  // Technician printed in both AKT and TZE-01 — produces multiple back
  // entries with identical names, so a name-only key would collide.
  // Keying by set is always safe because a transform's two faces share
  // a set.
  const cardEls = Array.from(doc.querySelectorAll('cards > card'));
  const backsByKey = new Map();
  for (const el of cardEls) {
    const side = (el.querySelector('prop > side')?.textContent || '').trim().toLowerCase();
    if (side !== 'back') continue;
    const name = (el.querySelector(':scope > name')?.textContent || '').trim();
    const setEl = el.querySelector(':scope > set');
    const setCode = (setEl?.textContent || '').trim();
    if (name) backsByKey.set(setCode + '|' + name, buildVoyagerBackCard(el));
  }

  const cards = [];
  const uuidMap = {};
  let nextId = 1;
  // Track claimed front-card names so every printing gets a unique byName
  // key. Revolution's data already carries `_SETCODE` suffixes for reprints;
  // Voyager's XML doesn't (17 Mountains all named "Mountain"), so without
  // disambiguation a chosen printing wouldn't survive save/load. The first
  // occurrence of a name stays plain; later printings get `_SETCODE`, and
  // if several are in the same set (e.g. 4 Mountains in FOE), later ones
  // get `_SETCODE_<collectorNumber>`. An `art` field carries a short label
  // the version picker can show to distinguish same-set variants.
  const claimedNames = new Set();

  for (const el of cardEls) {
    const side = (el.querySelector('prop > side')?.textContent || '').trim().toLowerCase();
    if (side === 'back') continue;
    const rawName = (el.querySelector(':scope > name')?.textContent || '').trim();
    if (!rawName) continue;

    // Adventure cards use "Front // Back" in name/type/manacost, and split
    // the rules text with a "\n---\n" separator. Every other layout has
    // plain single-face fields (transform backs live in separate <card>s).
    const splitIdx = rawName.indexOf(' // ');
    const frontName = splitIdx >= 0 ? rawName.slice(0, splitIdx) : rawName;
    const advName   = splitIdx >= 0 ? rawName.slice(splitIdx + 4) : '';

    const rawText = (el.querySelector(':scope > text')?.textContent || '');
    const textSplit = rawText.indexOf('\n---\n');
    const frontText = textSplit >= 0 ? rawText.slice(0, textSplit) : rawText;
    const advText   = textSplit >= 0 ? rawText.slice(textSplit + 5) : '';

    const typeLine = normalizeTypeDash((el.querySelector('prop > type')?.textContent || '').trim());
    const typeSplit = typeLine.indexOf(' // ');
    const frontType = typeSplit >= 0 ? typeLine.slice(0, typeSplit).trim() : typeLine;
    const advType   = typeSplit >= 0 ? typeLine.slice(typeSplit + 4).trim() : '';

    const bareMc = (el.querySelector('prop > manacost')?.textContent || '').trim();
    const mcSplit = bareMc.indexOf(' // ');
    const frontBareMc = mcSplit >= 0 ? bareMc.slice(0, mcSplit).trim() : bareMc;
    const advBareMc   = mcSplit >= 0 ? bareMc.slice(mcSplit + 4).trim() : '';

    const cmcRaw = (el.querySelector('prop > cmc')?.textContent || '').trim();
    const cmc = cmcRaw ? (parseInt(cmcRaw, 10) || 0) : 0;
    const colors = (el.querySelector('prop > colors')?.textContent || '').trim().toUpperCase();
    const ci = (el.querySelector('prop > coloridentity')?.textContent || '').trim().toUpperCase();
    const ptText = (el.querySelector('prop > pt')?.textContent || '').trim();
    let power = '', toughness = '';
    if (ptText) {
      const slash = ptText.indexOf('/');
      if (slash >= 0) { power = ptText.slice(0, slash); toughness = ptText.slice(slash + 1); }
    }
    const loyalty = (el.querySelector('prop > loyalty')?.textContent || '').trim();
    const layout = (el.querySelector('prop > layout')?.textContent || '').trim() || 'normal';

    const setEl = el.querySelector(':scope > set');
    const setCode = (setEl?.textContent || '').trim();
    const rarity = (setEl?.getAttribute('rarity') || '').trim().toLowerCase();
    const num = (setEl?.getAttribute('num') || '').trim();
    const picurlRaw = (setEl?.getAttribute('picurl') || '').trim();
    const picUrl = picurlRaw ? encodeURI(picurlRaw) : '';
    const uuid = (setEl?.getAttribute('uuid') || '').trim();

    const typeParts = parseTypeLineParts(frontType);
    const frontRawManaCost = voyagerBareManaToBraced(frontBareMc);

    const pageData = (advName && advType) ? {
      name: advName,
      type: advType,
      manaCost: voyagerBareManaToBraced(advBareMc),
      text: advText,
    } : null;

    // Transform back: <related attach="transform">OtherFaceName</related>.
    // Scope the lookup to the front's set so collisions between backs with
    // identical names in different sets resolve correctly.
    let backData = null;
    let transformBackName = '';
    const transformRel = el.querySelector('related[attach="transform"]');
    if (transformRel) {
      transformBackName = (transformRel.textContent || '').trim();
      if (transformBackName) backData = backsByKey.get(setCode + '|' + transformBackName) || null;
    }

    // Build a unique name for byName. Try plain → +_SETCODE → +_SETCODE_num,
    // claiming the first form that isn't already taken.
    let uniqueName = frontName;
    let variantLabel = null;
    if (claimedNames.has(uniqueName)) {
      uniqueName = `${frontName}_${setCode}`;
      variantLabel = setCode;
      if (claimedNames.has(uniqueName)) {
        uniqueName = `${frontName}_${setCode}_${num}`;
        variantLabel = `${setCode} ${num}`;
        // Fallback counter if even num collides (shouldn't happen in valid
        // data, but defensive).
        let counter = 2;
        while (claimedNames.has(uniqueName)) {
          uniqueName = `${frontName}_${setCode}_${num}_${counter}`;
          counter++;
        }
      }
    }
    claimedNames.add(uniqueName);

    const id = nextId++;
    const card = {
      id,
      name: uniqueName,
      canonical: frontName,
      // `variant` drives the version-picker chip label. Null for the
      // canonical "base" printing; for reprints it's the set code (or
      // set-code + collector-number when a single set has multiple
      // printings of the same card).
      variant: variantLabel,
      text: frontText,
      type: frontType,
      maintype: pickMainType(typeParts.types),
      subtypes: typeParts.subtypes,
      supertypes: typeParts.supertypes,
      types: typeParts.types,
      cmc,
      manacost: formatManaCost(frontRawManaCost),
      rawManaCost: frontRawManaCost,
      colors,
      ci,
      power,
      toughness,
      loyalty,
      artist: '',
      flavor: '',
      keywords: extractKeywords(frontText),
      pageData,
      layout,
      set: setCode,
      num,
      rarity,
      legalities: {},
      fmt_rev: '',
      fmt_eternal: '',
      related: transformBackName,
      imgVersion: 0,
      picUrl,
      back: backData,
    };

    if (pageData) {
      const advParts = parseTypeLineParts(pageData.type);
      card.pageFace = {
        id,
        name: pageData.name,
        canonical: card.canonical,
        text: pageData.text,
        type: pageData.type,
        maintype: pickMainType(advParts.types),
        subtypes: advParts.subtypes,
        supertypes: advParts.supertypes,
        types: advParts.types,
        cmc: cmcFromManaCost(pageData.manaCost),
        manacost: formatManaCost(pageData.manaCost),
        rawManaCost: pageData.manaCost,
        colors: colorsFromManaCost(pageData.manaCost),
        ci: card.ci,
        power: '',
        toughness: '',
        loyalty: '',
        defense: '',
        artist: '',
        flavor: '',
        keywords: extractKeywords(pageData.text),
        pageData,
        layout: card.layout,
        set: setCode,
        num,
        rarity,
        legalities: {},
        fmt_rev: '',
        fmt_eternal: '',
        related: '',
        imgVersion: 0,
        picUrl,
        back: null,
      };
    }

    cards.push(card);
    if (uuid) uuidMap[uuid] = { cardId: id, set: setCode, num };
  }

  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { cards, sets, uuidMap, allSetCodes: Array.from(allSetCodes) };
}

// Fetch + parse Voyager card data from upstream. Caller is responsible for
// persisting to localStorage / calling applyCardData().
async function fetchVoyagerData() {
  const res = await fetch(VOYAGER_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Voyager cards.xml`);
  const xmlText = await res.text();
  return parseCockatriceXml(xmlText);
}

// Resolve the parsed card-data snapshot for a dataset. Tries localStorage
// first, then the bundled static asset (cards.json for Revolution,
// voyager.xml for Voyager). Upstream is reached only via the "Update
// cards" button (refreshCurrentDataset) — first-load never touches the
// network, matching Revolution's behavior.
// Load persisted tags from static/tags.json. This is the SAME data the
// deployed static site reads on page load, so `is:<tag>` works there too;
// the tagger just has an extra write path (POST /api/tags) that the
// production host doesn't serve. Missing / malformed file is fine: we
// stay with an empty tag map and the tagger behaves as if no tags exist.
async function loadTags() {
  try {
    const res = await fetch('tags.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data !== 'object') return;
    for (const ds of ['revolution', 'voyager']) {
      const d = data[ds];
      if (!d) continue;
      const slot = STATE.tags[ds];
      if (d.cards && typeof d.cards === 'object') {
        // Shallow-copy each array so in-memory edits don't alias the
        // parsed JSON (we later mutate these).
        slot.cards = {};
        for (const canon of Object.keys(d.cards)) {
          const arr = d.cards[canon];
          if (Array.isArray(arr) && arr.length > 0) {
            slot.cards[canon] = arr.filter(t => typeof t === 'string');
          }
        }
      }
      if (Array.isArray(d.order)) {
        slot.order = d.order.filter(t => typeof t === 'string');
      }
      slot.aliases = {};
      if (d.aliases && typeof d.aliases === 'object' && !Array.isArray(d.aliases)) {
        for (const k of Object.keys(d.aliases)) {
          const v = d.aliases[k];
          if (typeof v !== 'string') continue;
          const lk = String(k).toLowerCase().trim();
          const tv = v.trim();
          if (!lk || !tv) continue;
          if (lk === tv.toLowerCase()) continue;  // self-alias, drop
          slot.aliases[lk] = tv;
        }
      }
      // Defensive normalization: if any cards still carry an alias name
      // (e.g. tags.json was hand-edited), rewrite those entries onto the
      // canonical so subsequent operations see a clean state.
      for (const canon of Object.keys(slot.cards)) {
        const arr = slot.cards[canon];
        const next = [];
        const seen = new Set();
        let dirty = false;
        for (const t of arr) {
          const tl = t.toLowerCase();
          const real = slot.aliases[tl] || t;
          const rl = real.toLowerCase();
          if (seen.has(rl)) { dirty = true; continue; }
          seen.add(rl);
          if (rl !== tl) dirty = true;
          next.push(real);
        }
        if (dirty) slot.cards[canon] = next;
      }
    }
  } catch (e) {
    console.warn('could not load tags.json:', e);
  }
}

// Debounced POST of the current STATE.tags to /api/tags. Only meaningful
// when running under server.py (local dev); the deployed static host
// rejects POST, so we tag the save state as 'offline' so the tagger
// sidebar can surface that to the user.
let _tagsSaveTimer = null;
function persistTags() {
  if (_tagsSaveTimer) clearTimeout(_tagsSaveTimer);
  STATE.tagSaveState = 'saving';
  renderTagSaveStatus();
  _tagsSaveTimer = setTimeout(() => {
    _tagsSaveTimer = null;
    doSaveTags();
  }, 250);
}
async function doSaveTags() {
  const payload = {
    revolution: STATE.tags.revolution,
    voyager: STATE.tags.voyager,
  };
  try {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 405 || res.status === 404) {
      STATE.tagSaveState = 'offline';
    } else if (!res.ok) {
      STATE.tagSaveState = 'error';
    } else {
      STATE.tagSaveState = 'saved';
    }
  } catch (e) {
    STATE.tagSaveState = 'error';
    console.warn('tag save failed:', e);
  }
  renderTagSaveStatus();
}

// Core mutators. `canonicals` is a list of canonical card names. Adding a
// tag moves it to the top of the MRU order even if every card already had
// it — matches the spec: the sidebar's top slot is the most recently
// ACTED-ON tag, not the most recently newly-created.
function addTagToCards(tag, canonicals, dataset = currentDataset()) {
  const input = String(tag || '').trim();
  if (!input) return null;
  const slot = STATE.tags[dataset];
  if (!slot) return null;
  // If the user typed an alias, swap in the canonical before doing anything
  // else — cards always carry the canonical, never the alias. The toast
  // surfaces the rewrite so the user knows what was actually saved.
  const aliasedTo = slot.aliases ? slot.aliases[input.toLowerCase()] : null;
  const real = aliasedTo || input;
  const low = real.toLowerCase();
  let changed = false;
  for (const canon of canonicals) {
    if (!canon) continue;
    let arr = slot.cards[canon];
    if (!arr) { arr = []; slot.cards[canon] = arr; changed = true; }
    if (!arr.some(t => t.toLowerCase() === low)) {
      arr.push(real);
      changed = true;
    }
  }
  // Move tag to the head of `order` (MRU). Preserves the display casing
  // the user first entered it with.
  const idx = slot.order.findIndex(t => t.toLowerCase() === low);
  let display = real;
  if (idx >= 0) {
    display = slot.order[idx];
    slot.order.splice(idx, 1);
  }
  slot.order.unshift(display);
  STATE.lastUsedTag = display;
  if (aliasedTo) showAliasToast(input, display);
  refreshCardTagChips(canonicals);
  persistTags();
  return display;
}

function removeTagFromCard(tag, canonical, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot) return;
  // Resolve aliases so removing "kill" from a card actually drops the
  // canonical "removal" entry it's stored under.
  const inputLow = String(tag).toLowerCase();
  const aliased = slot.aliases ? slot.aliases[inputLow] : null;
  const low = aliased ? String(aliased).toLowerCase() : inputLow;
  const arr = slot.cards[canonical];
  if (!arr) return;
  const filtered = arr.filter(t => t.toLowerCase() !== low);
  if (filtered.length === arr.length) return;
  if (filtered.length === 0) delete slot.cards[canonical];
  else slot.cards[canonical] = filtered;
  // If no card still has this tag, retire it from `order` so the sidebar
  // doesn't show an empty section.
  const stillUsed = Object.values(slot.cards).some(a =>
    a.some(t => t.toLowerCase() === low));
  if (!stillUsed) {
    slot.order = slot.order.filter(t => t.toLowerCase() !== low);
    if (STATE.focusedTag && STATE.focusedTag.toLowerCase() === low) {
      STATE.focusedTag = null;
    }
  }
  refreshCardTagChips([canonical]);
  persistTags();
}

function tagsForCard(canonical, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot) return [];
  return (slot.cards[canonical] || []).slice();
}

function cardsForTag(tag, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot) return [];
  // Querying by an alias returns the canonical's cards.
  const inputLow = String(tag).toLowerCase();
  const aliased = slot.aliases ? slot.aliases[inputLow] : null;
  const low = aliased ? String(aliased).toLowerCase() : inputLow;
  const out = [];
  for (const canon of Object.keys(slot.cards)) {
    if (slot.cards[canon].some(t => t.toLowerCase() === low)) {
      out.push(canon);
    }
  }
  return out;
}

// Add an alias `aliasName` → `canonical`. Migrates any cards already tagged
// with `aliasName` onto the canonical (so an alias added after the fact
// doesn't leave orphaned cards), retires the alias from `order`, and
// repoints any aliases that pointed at the alias we just absorbed (so the
// store never holds a multi-hop chain).
function addTagAlias(aliasName, canonical, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot) return false;
  const aliasLow = String(aliasName || '').trim().toLowerCase();
  const canonInput = String(canonical || '').trim();
  const canonLowInput = canonInput.toLowerCase();
  if (!aliasLow || !canonLowInput || aliasLow === canonLowInput) return false;
  if (!slot.aliases) slot.aliases = {};
  // If the user picked another alias as the canonical, walk one hop so we
  // store the terminal name. (Aliases are flat, never chained.)
  let canonDisplay = canonInput;
  let canonLow = canonLowInput;
  if (slot.aliases[canonLow]) {
    canonDisplay = slot.aliases[canonLow];
    canonLow = canonDisplay.toLowerCase();
    if (canonLow === aliasLow) return false;  // would form a cycle
  }
  // If the canonical already exists in `order`, prefer its display casing —
  // keeps the alias map and order from drifting when callers pass a
  // differently-cased canonical name.
  const orderMatchIdx = slot.order.findIndex(t => t.toLowerCase() === canonLow);
  if (orderMatchIdx >= 0) canonDisplay = slot.order[orderMatchIdx];
  let changed = false;
  // Migrate cards tagged with the old alias name onto the canonical.
  for (const c of Object.keys(slot.cards)) {
    const arr = slot.cards[c];
    let touched = false;
    let hasCanon = false;
    const next = [];
    for (const t of arr) {
      const tl = t.toLowerCase();
      if (tl === aliasLow) { touched = true; continue; }
      if (tl === canonLow) hasCanon = true;
      next.push(t);
    }
    if (touched) {
      if (!hasCanon) next.push(canonDisplay);
      slot.cards[c] = next;
      changed = true;
    }
  }
  const aliasIdx = slot.order.findIndex(t => t.toLowerCase() === aliasLow);
  if (aliasIdx >= 0) { slot.order.splice(aliasIdx, 1); changed = true; }
  if (!slot.order.some(t => t.toLowerCase() === canonLow)) {
    slot.order.unshift(canonDisplay);
    changed = true;
  }
  if ((slot.aliases[aliasLow] || '') !== canonDisplay) {
    slot.aliases[aliasLow] = canonDisplay;
    changed = true;
  }
  for (const k of Object.keys(slot.aliases)) {
    if (slot.aliases[k].toLowerCase() === aliasLow) {
      slot.aliases[k] = canonDisplay;
      changed = true;
    }
  }
  if (STATE.focusedTag && STATE.focusedTag.toLowerCase() === aliasLow) {
    STATE.focusedTag = canonDisplay;
  }
  if (changed) persistTags();
  return changed;
}

function removeTagAlias(aliasName, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot || !slot.aliases) return false;
  const low = String(aliasName || '').toLowerCase();
  if (!(low in slot.aliases)) return false;
  delete slot.aliases[low];
  persistTags();
  return true;
}

// Lowercased alias names that resolve to `canonical`. Used by the sidebar
// (subtitle line + tooltip) and the alias editor to render existing chips.
function aliasesForTag(canonical, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot || !slot.aliases) return [];
  const low = String(canonical || '').toLowerCase();
  const out = [];
  for (const k of Object.keys(slot.aliases)) {
    if (slot.aliases[k].toLowerCase() === low) out.push(k);
  }
  out.sort();
  return out;
}

async function loadDatasetData(dataset) {
  if (_datasetSessionCache[dataset]) return _datasetSessionCache[dataset];
  const key = dataset === 'voyager' ? VOYAGER_STORAGE_KEY : STORAGE_KEY;
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      _datasetSessionCache[dataset] = parsed;
      return parsed;
    }
  } catch (e) {
    console.warn('Could not read cached card data:', e);
  }
  let data;
  if (dataset === 'voyager') {
    const res = await fetch('voyager.xml');
    if (!res.ok) throw new Error(`failed to load voyager.xml (HTTP ${res.status})`);
    data = parseCockatriceXml(await res.text());
  } else {
    const res = await fetch('cards.json');
    if (!res.ok) throw new Error(`failed to load cards.json (HTTP ${res.status})`);
    data = parseAllSetsJson(await res.json());
  }
  _datasetSessionCache[dataset] = data;
  return data;
}

// Refresh the active dataset's upstream and update the matching cache.
// Used by the "Update cards" button regardless of which dataset is active.
async function refreshCurrentDataset() {
  if (currentDataset() === 'voyager') {
    const data = await fetchVoyagerData();
    applyCardData(data);
    _datasetSessionCache.voyager = data;
    try { localStorage.setItem(VOYAGER_STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
  } else {
    await refreshFromUpstream();
  }
}

// Snapshot of the empty zones struct, used when switching to a dataset for
// the first time (before any stash exists).
function freshZones() {
  return {
    main:    { piles: [] },
    sanctum: { piles: [] },
    side:    { piles: [] },
    maybe:   { piles: [] },
  };
}

// Serialize zones as arrays of card-NAME strings per pile, keyed by zone.
// Same shape saved decks use. cardIds are only meaningful against the
// currently-loaded card index — after a dataset swap, the other dataset's
// byId can't resolve them, but names round-trip cleanly.
function snapshotZonesByName(zones) {
  const out = {};
  for (const z of Object.keys(zones)) {
    out[z] = zones[z].piles.map(pile => pile.map(inst => {
      const c = STATE.byId.get(inst.cardId);
      return c ? c.name : null;
    }).filter(n => n != null));
  }
  return out;
}

// Inverse of snapshotZonesByName — reads through the current STATE.byName
// to rebuild cardId-based pile instances. Must be called AFTER the new
// dataset has been loaded via applyCardData (so byName reflects it).
function rehydrateZonesFromNames(snapshot) {
  const zones = freshZones();
  if (!snapshot) return zones;
  for (const z of Object.keys(snapshot)) {
    if (!zones[z]) continue;
    for (const pileNames of snapshot[z]) {
      const pile = [];
      for (const name of pileNames) {
        const card = STATE.byName.get(name)
                     || STATE.cards.find(c => c.canonical === canonicalName(name));
        if (card) pile.push({ uid: newUid(), cardId: card.id });
      }
      if (pile.length) zones[z].piles.push(pile);
    }
  }
  return zones;
}

// Switch the active dataset. On the way out we snapshot the outgoing
// workspace (zones by name + loaded-deck pointer + dirty baseline) into
// STATE.stashedByDataset so the user can come back and pick up exactly
// where they left off — including the deck's loaded identity and any
// unsaved edits. On the way in we either restore the incoming dataset's
// stash, or start blank if none.
async function switchDataset(toDataset) {
  const from = currentDataset();
  if (from === toDataset) return;
  // Snapshot outgoing state against the CURRENT card index before we
  // swap, because the stash uses names and needs STATE.byId to resolve
  // them. Deep-copy the tags array so later edits don't alias.
  const outgoingStash = {
    zones: snapshotZonesByName(STATE.zones),
    loadedDeckName: STATE.loadedDeckName,
    loadedDeckFolder: STATE.loadedDeckFolder,
    loadedDeckTags: (STATE.loadedDeckTags || []).slice(),
    loadedPlanName: STATE.loadedPlanName,
    basePlanZones: STATE.basePlanZones,
    deckSnapshot: STATE.deckSnapshot,
  };
  // Preserve the live zones object so we can put everything back on a
  // failed load (offline, bad fetch). Nothing else has been mutated yet.
  const savedZones = STATE.zones;
  STATE.zones = freshZones();
  let data;
  try {
    data = await loadDatasetData(toDataset);
  } catch (e) {
    STATE.zones = savedZones;
    throw e;
  }
  // Commit the outgoing stash now that the swap is definitely happening.
  STATE.stashedByDataset[from] = outgoingStash;
  applyCardData(data);
  // Restore incoming dataset's workspace if present; otherwise blank.
  const incoming = STATE.stashedByDataset[toDataset];
  if (incoming) {
    STATE.zones = rehydrateZonesFromNames(incoming.zones);
    STATE.loadedDeckName = incoming.loadedDeckName;
    STATE.loadedDeckFolder = incoming.loadedDeckFolder;
    STATE.loadedDeckTags = (incoming.loadedDeckTags || []).slice();
    STATE.loadedPlanName = incoming.loadedPlanName;
    STATE.basePlanZones = incoming.basePlanZones;
    STATE.deckSnapshot = incoming.deckSnapshot;
  } else {
    STATE.zones = freshZones();
    STATE.loadedDeckName = null;
    STATE.loadedDeckFolder = null;
    STATE.loadedDeckTags = [];
    STATE.loadedPlanName = null;
    STATE.basePlanZones = null;
    markDeckClean();
  }
  updateSaveButtons();
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

// Serialize one zone's piles as arrays of card-NAME strings (matching the
// saved-deck payload shape). Dropped-card ids (orphaned instances) are
// filtered out.
function zoneNamesByPile(zoneName) {
  return STATE.zones[zoneName].piles.map(pile => pile.map(inst => {
    const c = STATE.byId.get(inst.cardId);
    return c ? c.name : null;
  }).filter(n => n != null));
}

// Build a Map<canonicalName, count> covering main+side combined. Inputs are
// in the pile-of-names shape that saved decks use. Canonical names collapse
// different printings of the same card — that's what the "same 75" invariant
// compares against.
function canonicalMultiset(pilesMain, pilesSide) {
  const m = new Map();
  for (const piles of [pilesMain || [], pilesSide || []]) {
    for (const pile of piles) {
      for (const name of pile) {
        const c = canonicalName(name);
        m.set(c, (m.get(c) || 0) + 1);
      }
    }
  }
  return m;
}

// Compare two canonical multisets. `b` - `a` semantically:
//   added  = what's extra in `b` (need to side OUT of the base to reach `b`)
//   removed = what's missing in `b` (need to side IN from the base)
function diffMultisets(a, b) {
  const added = [], removed = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ca = a.get(k) || 0;
    const cb = b.get(k) || 0;
    if (cb > ca) added.push({ name: k, count: cb - ca });
    else if (ca > cb) removed.push({ name: k, count: ca - cb });
  }
  added.sort((x, y) => x.name.localeCompare(y.name));
  removed.sort((x, y) => x.name.localeCompare(y.name));
  return { added, removed };
}

function diffIsEmpty(diff) {
  return diff.added.length === 0 && diff.removed.length === 0;
}

// "−2 Llanowar Elves, +2 Duress" — negatives (cards missing from the plan)
// first, then positives. Uses the unicode minus sign to avoid confusion with
// a hyphen in card names.
function describeDiff(diff) {
  const parts = [];
  for (const r of diff.removed) parts.push('−' + r.count + ' ' + r.name);
  for (const a of diff.added) parts.push('+' + a.count + ' ' + a.name);
  return parts.join(', ');
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
  // Voyager is its own dataset; whatever is loaded IS the Voyager pool, so
  // every card is legal within it. Revolution-family legalities don't apply.
  if (STATE.format === 'voyager') return true;
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
const FORMAT_LABELS = { standard: 'Standard', eternal: 'Eternal', range: 'Sets', voyager: 'Voyager' };

// Which dataset the given format draws cards from. Voyager is its own pool;
// the Revolution-family formats (standard/eternal/range) all share the
// Revolution card pool and just filter by legality/range on top.
function datasetForFormat(fmt) { return fmt === 'voyager' ? 'voyager' : 'revolution'; }
function currentDataset() { return datasetForFormat(STATE.format); }

// Deck zones visible to the user in the current dataset. Sanctum is Voyager-
// only; it's always present in STATE.zones (see the comment on STATE.zones)
// but the UI hides it outside Voyager mode, so keyboard cycling and any
// other UI-ordered iteration should skip it there.
function visibleZoneOrder() {
  return currentDataset() === 'voyager'
    ? ['main', 'sanctum', 'side', 'maybe']
    : ['main', 'side', 'maybe'];
}

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
  // "Update cards" refreshes whichever dataset is active. Label stays
  // generic; the tooltip surfaces which upstream it'll hit.
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.title = currentDataset() === 'voyager'
      ? 'Re-fetch card data from the upstream Voyager list'
      : 'Re-fetch card data from the upstream Revolution repo';
  }
  // Body class gates voyager-only UI (sanctum zone section, sanctum
  // add-to-zone button). STATE.zones.sanctum still exists either way so
  // a stashed Voyager deck round-trips cleanly.
  document.body.classList.toggle('voyager-mode', currentDataset() === 'voyager');
  // Swap the tab icon to the silver variant while Voyager is active. Only
  // the webp link is mutated — all evergreen browsers prefer it over the
  // png fallback, and the png stays pointing at the default on the off
  // chance a browser without webp support is in use.
  const favLink = document.querySelector('link[rel="icon"][type="image/webp"]');
  if (favLink) {
    favLink.href = currentDataset() === 'voyager' ? 'favicon-silver.webp' : 'favicon.webp';
  }
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
  // I (silver) appended after WUBRG so I cards sort after Green-monocolor
  // cards rather than interleaving with them.
  const order = 'WUBRGI';
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
  // Voyager cards carry an absolute URL directly from cards.xml's picurl.
  // Revolution cards construct from set/num with cajun's repurposed
  // multiverseId stamp (YYYYMMDD) as a cache-buster.
  if (card && card.picUrl) return card.picUrl;
  const base = `${IMG_BASE}/${card.set}/${encodeURIComponent(card.num)}.jpg`;
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
  // Voyager-specific (custom-set keywords — sanctum-eligibility depends on
  // these, so the extractor has to catch them).
  'pathbound', 'transcend', 'usurpate', 'heir', 'bisapience', 'liberate',
  'embrace', 'sift',
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
// WUBRG + I (Voyager's silver color) as a string, in that canonical order.
// The alphabet is dataset-agnostic: Revolution cards never carry I, so
// including it has no observable effect on them.
const COLOR_LETTERS = 'WUBRGI';
function colorsFromManaCost(cost) {
  const seen = new Set();
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(cost || '')) !== null) {
    for (const ch of m[1].toUpperCase()) {
      if (COLOR_LETTERS.includes(ch)) seen.add(ch);
    }
  }
  return COLOR_LETTERS.split('').filter(ch => seen.has(ch)).join('');
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
// Battle cards in the Revolution corpus carry no top-level defense field;
// the value sits at the end of the oracle text as `Starting defense: N`.
// We pluck it once at parse time so `defense:` / `def:` predicates can
// compare numerically. Returns '' for cards with no Starting-defense line.
function extractDefenseFromText(text) {
  if (!text) return '';
  const m = text.match(/Starting defense:\s*(\d+)/i);
  return m ? m[1] : '';
}

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
        // kw followed by space/dash/brace/digit = keyword usage. Accept
        // both em-dash (—, Revolution) and en-dash (–, Voyager) — several
        // Voyager keywords attach their reminder with an en-dash (e.g.
        // "Heir–You've created...").
        const after = lower.slice(kw.length, kw.length + 1);
        if (lower.startsWith(kw) && (after === ' ' || after === '—' || after === '–' || after === '{' || after === '' || /\d/.test(after))) {
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
  // Colorize WUBRG, I (silver), and V (Voyager Vertex resource). Numbers
  // and X are left untouched. Escape HTML entities first so a card data
  // source (upstream JSON, tampered localStorage) can't sneak markup
  // through this path into the DOM. The entity expansions (&amp;, &lt;,
  // etc.) don't contain any uppercase WUBRGIV, so colorizing the escaped
  // string still hits the right letters.
  if (!cost) return '';
  return escapeHtml(cost)
             .replace(/W/g, '<span class="mana-w">W</span>')
             .replace(/U/g, '<span class="mana-u">U</span>')
             .replace(/B/g, '<span class="mana-b">B</span>')
             .replace(/R/g, '<span class="mana-r">R</span>')
             .replace(/G/g, '<span class="mana-g">G</span>')
             .replace(/I/g, '<span class="mana-i">I</span>')
             .replace(/V/g, '<span class="mana-v">V</span>');
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
  castable: 'castable',
  pow: 'power', power: 'power',
  tou: 'toughness', toughness: 'toughness',
  loy: 'loyalty', loyalty: 'loyalty',
  def: 'defense', defense: 'defense',
  r: 'rarity', rarity: 'rarity',
  e: 'set', set: 'set', edition: 'set',
  sets: 'sets',
  cn: 'cn', number: 'cn', num: 'cn',
  a: 'artist', art: 'artist', artist: 'artist',
  kw: 'kw', keyword: 'kw',
  f: 'format', format: 'format',
  legal: 'legal', banned: 'banned', restricted: 'restricted',
  is: 'is',
  tag: 'tag',
  has: 'has',
  manabase: 'manabase',
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
  defense: (c) => parseIntOrNaN(c.defense),
  def: (c) => parseIntOrNaN(c.defense),
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
// Returns { kind: 'count'|'multi'|'colorless'|'letters', value: number|null,
// letters: WUBRG + I subset }. "silver" is accepted as a synonym for I.
function parseColorSpec(raw) {
  const v = stripQuotes(raw).toLowerCase();
  if (/^\d+$/.test(v)) return { kind: 'count', value: parseInt(v, 10), letters: '' };
  if (v === 'm' || v === 'multi' || v === 'multicolor') return { kind: 'multi', letters: '' };
  if (v === 'silver') return { kind: 'letters', letters: 'I' };
  // 'c' alone is colorless; 'c' embedded in a multi-letter string ("wubrgic")
  // would be ambiguous, but the existing tokenizer only hits this path for
  // single tokens so keep the simple rule.
  if (v === 'c' || v === 'colorless') return { kind: 'colorless', letters: '' };
  const letters = [];
  for (const ch of v) {
    if ('wubrgi'.includes(ch)) letters.push(ch.toUpperCase());
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
    case 'castable':   return buildCastablePredicate(op, rawValue);
    case 'power':      return buildNumericPredicate((c) => parseIntOrNaN(c.power), op, rawValue);
    case 'toughness':  return buildNumericPredicate((c) => parseIntOrNaN(c.toughness), op, rawValue);
    case 'loyalty':    return buildNumericPredicate((c) => parseIntOrNaN(c.loyalty), op, rawValue);
    case 'defense':    return buildNumericPredicate((c) => parseIntOrNaN(c.defense), op, rawValue);
    case 'rarity':     return buildRarityPredicate(op, rawValue);
    case 'set':        return buildSetPredicate(op, rawValue);
    case 'sets':       return buildSetsRangePredicate(op, rawValue);
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
    case 'tag':        return buildTagPredicate(rawValue);
    case 'has':        return buildHasPredicate(rawValue);
    case 'manabase':   return buildManabasePredicate(rawValue);
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
    // Aliases for grouping by spell-vs-permanent rather than a single
    // printed type. Only fires for `:` since `=`/`<=`/`==` test the
    // types[] array word-by-word, where these names match nothing.
    const v = stripQuotes(rawValue).toLowerCase();
    if (v === 'spell' || v === 'permanent' || v === 'thing') {
      const SPELL = new Set(['instant', 'sorcery']);
      const THING = new Set(['enchantment', 'artifact', 'battle']);
      return (c) => {
        const ts = (c.types || []).map(t => String(t).toLowerCase());
        if (v === 'spell')     return ts.some(t => SPELL.has(t));
        if (v === 'permanent') return !ts.some(t => SPELL.has(t));
        return ts.some(t => THING.has(t));
      };
    }
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
    let re;
    try { re = new RegExp(body, 'i'); }
    catch (e) { throw new Error(`bad regex /${body}/`); }
    return (c) => {
      const text = oracleTextFor(c);
      return re.test(text);
    };
  }
  // `o=phrase` / `o==phrase`: whole-word match — wrap in \b…\b so `o=if`
  // doesn't hit "lifelink" / "swift" / "modify". Multi-word values stay
  // intact: `o="hot dog"` requires the literal sequence with word boundaries
  // on each end. Falls back to substring for the bare `:` operator.
  const needle = stripQuotes(raw);
  if (op === '=' || op === '==') {
    return (c) => {
      const text = oracleTextFor(c);
      const expanded = needle.replace(/~/g, c.canonical);
      if (!expanded) return true;
      const escaped = expanded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      return re.test(text);
    };
  }
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
  // mana={} → no mana cost (lands etc.)
  if (raw === '{}' || raw === '') {
    return (c) => !(c.rawManaCost && c.rawManaCost.length);
  }
  // Unified numeric+multiset model for every other op. Digit runs in the
  // query are summed as a generic-mana threshold; the rest become pip
  // matchers (WUBRGIVXP, hybrid h, any-color c, anti-bind m/n/o, slash-pips
  // like U/G). Inclusive ops permit equality; strict ops require a proper
  // relation (at least one of generic or pip-count differs):
  //   mana>=Q / mana:Q   → card_generic ≥ qGen AND card pips ⊇ qPips
  //   mana>Q             → as >=, AND card != query (proper superset)
  //   mana<=Q            → card_generic ≤ qGen AND card pips ⊆ qPips
  //   mana<Q             → as <=, AND card != query (proper subset)
  //   mana=Q / mana==Q   → equal (multiset equality on pips)
  //   mana!=Q            → not equal
  // Lands (no mana cost) trivially satisfy `<` and `<=` (they sit strictly
  // below every specified cost) and `!=` (no cost ≠ a specified cost), but
  // never satisfy `>` / `>=` / `:` / `=` — those are spell queries.
  const { generic: qGen, pipMatchers: qPips } = decomposeManaQuery(raw);
  const hasCost = (c) => !!(c.rawManaCost && c.rawManaCost.length);
  switch (op) {
    case '>=':
      return (c) => {
        if (!hasCost(c)) return false;
        const cd = decomposeCardCost(c.rawManaCost);
        return cd.generic >= qGen && containsPips(cd.pips, qPips);
      };
    case '>':
      return (c) => {
        if (!hasCost(c)) return false;
        const cd = decomposeCardCost(c.rawManaCost);
        if (cd.generic < qGen) return false;
        if (!containsPips(cd.pips, qPips)) return false;
        return cd.generic > qGen || cd.pips.length > qPips.length;
      };
    case '<=':
      return (c) => {
        const cd = decomposeCardCost(c.rawManaCost);
        return cd.generic <= qGen && pipsAreSubset(cd.pips, qPips);
      };
    case '<':
      return (c) => {
        if (!hasCost(c)) return true;
        const cd = decomposeCardCost(c.rawManaCost);
        if (cd.generic > qGen) return false;
        if (!pipsAreSubset(cd.pips, qPips)) return false;
        return cd.generic < qGen || cd.pips.length < qPips.length;
      };
    case ':':
    case '=':
    case '==':
      return (c) => {
        if (!hasCost(c)) return false;
        const cd = decomposeCardCost(c.rawManaCost);
        return cd.generic === qGen
            && cd.pips.length === qPips.length
            && pipsAreSubset(cd.pips, qPips);
      };
    case '!=':
      return (c) => {
        if (!hasCost(c)) return true;
        const cd = decomposeCardCost(c.rawManaCost);
        if (cd.generic !== qGen) return true;
        if (cd.pips.length !== qPips.length) return true;
        return !pipsAreSubset(cd.pips, qPips);
      };
  }
  return (_c) => false;
}

// Split a card's mana cost into a numeric generic total + the remaining
// non-numeric pips (colored, hybrid, X, P, etc.). Used by the `>` / `<`
// mana operators where digits represent a numeric threshold rather than a
// literal {N} pip.
function decomposeCardCost(rawManaCost) {
  const pips = splitCostPips(rawManaCost);
  let generic = 0;
  const others = [];
  for (const p of pips) {
    if (/^\d+$/.test(p)) generic += parseInt(p, 10);
    else others.push(p);
  }
  return { generic, pips: others };
}

// Parse a mana query for buildManaPredicate. Digit runs collapse into a
// single generic threshold (so `10` is ten, not two pips); other characters
// become pip matchers — exact (WUBRGIVXP, single digit), hybrid (h),
// any-color (c), anti-bind variables (m/n/o), or a literal slash-pip (U/G,
// 2/W) when the value contains '/'. V is Voyager's Vertex resource — not a
// color, but it appears in braced pips so mana-cost search accepts it as
// an exact-pip letter. `c:V` still returns nothing because no card carries
// V in its colors string.
function decomposeManaQuery(raw) {
  const v = raw.toUpperCase().replace(/[{}]/g, '');
  if (v.includes('/')) return { generic: 0, pipMatchers: [{ kind: 'exact', pip: v }] };
  let generic = 0;
  const pipMatchers = [];
  let i = 0;
  while (i < v.length) {
    const ch = v[i];
    // Revolution's prismatic pip is the 2-char symbol `Vp` (uppercased to
    // "VP" in card-cost form by splitCostPips). Detect it before the single-
    // char branch so `mana:Vp` parses as one matcher, not [V, P].
    if (ch === 'V' && v[i + 1] === 'P') {
      pipMatchers.push({ kind: 'exact', pip: 'VP' });
      i += 2;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < v.length && /\d/.test(v[j])) j++;
      generic += parseInt(v.slice(i, j), 10);
      i = j;
    } else if (ch === 'H') { pipMatchers.push({ kind: 'hybrid' }); i++; }
    else if ('MNO'.includes(ch)) { pipMatchers.push({ kind: 'var', label: ch.toLowerCase() }); i++; }
    else if (ch === 'C') { pipMatchers.push({ kind: 'any-color' }); i++; }
    else if ('WUBRGIVXP'.includes(ch)) { pipMatchers.push({ kind: 'exact', pip: ch }); i++; }
    else { i++; }
  }
  return { generic, pipMatchers };
}

// Multiset-subset check for the `mana<` op: every card pip must consume one
// distinct query matcher. Mirrors containsPips's matcher-driven loop, but
// runs the loop over the card's pips (strings) so each one finds a query
// matcher rather than the other way round.
function pipsAreSubset(cardPips, queryMatchers) {
  const used = new Array(queryMatchers.length).fill(false);
  const bindings = {};
  for (const cp of cardPips) {
    let matched = false;
    for (let qi = 0; qi < queryMatchers.length; qi++) {
      if (used[qi]) continue;
      const savedM = bindings.m, savedN = bindings.n, savedO = bindings.o;
      if (pipMatches(queryMatchers[qi], cp, bindings)) {
        used[qi] = true;
        matched = true;
        break;
      }
      bindings.m = savedM; bindings.n = savedN; bindings.o = savedO;
    }
    if (!matched) return false;
  }
  return true;
}

function pipMatches(matcher, cardPip, varBindings) {
  if (matcher.kind === 'exact') {
    return cardPip === matcher.pip;
  }
  if (matcher.kind === 'hybrid') {
    // V pairs with any color in Voyager hybrids (`{V/W}`, `{V/U}`, …) so
    // the hybrid-pip matcher accepts it on either side.
    return /^[WUBRGIV]\/[WUBRGIV]$|^2\/[WUBRGIV]$|^[WUBRGIV]\/P$/.test(cardPip);
  }
  if (matcher.kind === 'any-color') {
    return /^[WUBRGI]$/.test(cardPip);
  }
  if (matcher.kind === 'var') {
    if (!/^[WUBRGI]$/.test(cardPip)) return false;
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

// `castable:<pool>` — every pip in the card's mana cost is payable from a
// pool of available mana colors. Differs from `mana<=` (multiset-subset):
// the pool is a *set* of colors with unlimited quantity, so {W}{W} is
// castable from pool W. Vertex {V} is treated as always free; {Vp}
// (Revolution prismatic) requires k distinct pool colors that are *not*
// already part of the spell's color, where k is the {Vp} pip count.
//
// Pool letters: w u b r g i (silver) → WUBRGI; c → colorless mana available.
// Only `:` / `=` / `==` are supported (castability isn't ordered).
function buildCastablePredicate(op, rawValue) {
  if (op !== ':' && op !== '=' && op !== '==') return (_c) => false;
  const raw = stripQuotes(rawValue).toLowerCase();
  const pool = new Set();
  for (const ch of raw) {
    if ('wubrgi'.includes(ch)) pool.add(ch.toUpperCase());
    else if (ch === 'c') pool.add('C');
  }
  return (c) => {
    if (!c.rawManaCost) return false;
    const pips = splitCostPips(c.rawManaCost);
    let vpCount = 0;
    const spellColors = new Set();
    for (const pip of pips) {
      if (pip === 'VP') { vpCount++; continue; }
      if (!pipCastable(pip, pool, spellColors)) return false;
    }
    if (vpCount > 0) {
      let avail = 0;
      for (const ch of 'WUBRGI') {
        if (pool.has(ch) && !spellColors.has(ch)) avail++;
      }
      if (avail < vpCount) return false;
    }
    return true;
  };
}

// Per-pip payability for `castable:`. Returns true iff the pip can be paid
// from `pool`, and (as a side effect) accumulates the pip's WUBRGI color
// contribution into `spellColors` for the {Vp} distinct-color rule. {Vp}
// is handled by the caller and never reaches this function.
function pipCastable(pip, pool, spellColors) {
  if (/^\d+$/.test(pip)) return true;
  if (pip === 'X' || pip === 'Y' || pip === 'Z') return true;
  if (pip === 'V') return true;
  if (pip === 'C') return pool.has('C');
  if (pip.length === 1 && 'WUBRGI'.includes(pip)) {
    if (!pool.has(pip)) return false;
    spellColors.add(pip);
    return true;
  }
  if (pip.includes('/')) {
    const [a, b] = pip.split('/');
    const addColors = () => {
      if ('WUBRGI'.includes(a)) spellColors.add(a);
      if ('WUBRGI'.includes(b)) spellColors.add(b);
    };
    // Phyrexian {C/P}: pay 2 life. Always payable.
    if (b === 'P') { addColors(); return true; }
    // Monohybrid {2/W}: pay 2 generic. Always payable.
    if (a === '2') { addColors(); return true; }
    // Vertex hybrid {V/W}: V side is always free.
    if (a === 'V' || b === 'V') { addColors(); return true; }
    // Two-color hybrid (incl. {C/W}): pay either side.
    const sideOK = (s) => (s === 'C' && pool.has('C')) || (/[WUBRGI]/.test(s) && pool.has(s));
    if (!sideOK(a) && !sideOK(b)) return false;
    addColors();
    return true;
  }
  return false;
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
  // Comparison operators (`set>=sol`, `set<=sol`, etc.) match any printing
  // whose set's release date sits on the correct side of the pivot set's
  // release date. The value must resolve to a known set code — substring
  // matching only applies to `:`/`=`/`==`. Voyager sets get synthetic
  // ordinal release dates in declaration order, so this works there too.
  if (op === '>=' || op === '<=' || op === '>' || op === '<') {
    const code = stripQuotes(rawValue).toUpperCase();
    const pivotSet = STATE.setsByCode[code];
    if (!pivotSet) return (_c) => false;
    const pivot = pivotSet.releasedate || '';
    return (c) => {
      const printings = STATE.byCanonical.get(c.canonical) || [c];
      for (const p of printings) {
        const ps = STATE.setsByCode[p.set];
        if (!ps) continue;
        const d = ps.releasedate || '';
        if (op === '>=' && d >= pivot) return true;
        if (op === '<=' && d <= pivot) return true;
        if (op === '>'  && d >  pivot) return true;
        if (op === '<'  && d <  pivot) return true;
      }
      return false;
    };
  }
  const values = parseListValue(rawValue).map(v => v.toLowerCase());
  if (!values.length) return (_c) => false;
  return (c) => {
    // A canonical card matches if any of its printings matches. Substring
    // match on set code or name across `:`, `=`, `==`, `!=`. (The
    // comparison-operator branch above handles `>=`/`<=`/`>`/`<`.)
    const printings = STATE.byCanonical.get(c.canonical) || [c];
    for (const p of printings) {
      const code = (p.set || '').toLowerCase();
      const setObj = STATE.setsByCode[p.set];
      const name = setObj ? (setObj.longname || '').toLowerCase() : '';
      for (const v of values) {
        if (code.includes(v) || (name && name.includes(v))) return true;
      }
    }
    return false;
  };
}

// `sets:CODE1-CODE2` — any printing in the chronological range between the
// two set codes, inclusive. Either bound may be empty (open-ended). Order
// of the two codes doesn't matter. A value with no dash falls through to
// `set:` so `sets:CODE` is forgiving.
function buildSetsRangePredicate(op, rawValue) {
  const raw = stripQuotes(rawValue);
  const m = raw.match(/^([A-Za-z0-9_]*)\s*-\s*([A-Za-z0-9_]*)$/);
  if (!m) return buildSetPredicate(op, rawValue);
  const codeOf = (s) => s.toUpperCase();
  const dateOf = (code) => {
    const obj = STATE.setsByCode[code];
    return obj ? (obj.releasedate || '') : null;
  };
  const aCode = m[1] ? codeOf(m[1]) : null;
  const bCode = m[2] ? codeOf(m[2]) : null;
  if (aCode && !STATE.setsByCode[aCode]) return (_c) => false;
  if (bCode && !STATE.setsByCode[bCode]) return (_c) => false;
  const aDate = aCode ? dateOf(aCode) : '';
  // Empty upper bound means "newest"; using a sentinel that sorts after any
  // real ISO date keeps the comparison logic uniform.
  const bDate = bCode ? dateOf(bCode) : '￿';
  const lo = aDate < bDate ? aDate : bDate;
  const hi = aDate < bDate ? bDate : aDate;
  return (c) => {
    const printings = STATE.byCanonical.get(c.canonical) || [c];
    for (const p of printings) {
      const setObj = STATE.setsByCode[p.set];
      if (!setObj) continue;
      const d = setObj.releasedate || '';
      if (d >= lo && d <= hi) return true;
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
    // Voyager's Vertex mechanic: cards whose mana cost contains a V pip
    // (bare or hybrid). Catches the 7 back-face Vertex spells without
    // requiring the user to enumerate every V/W, V/U, … hybrid.
    case 'vertex':    return (c) => /\{[^}]*V[^}]*\}/.test(c.rawManaCost || '');
    // Any braced pip with a slash — covers WUBRG hybrids, colorless
    // hybrids (`{C/W}`), Voyager silver hybrids (`{I/B}`), Vertex
    // hybrids (`{V/G}`), and future `{2/W}` monohybrids if either
    // dataset adopts them. Prismatic `{Vp}` has no slash and is a
    // distinct atomic pip, so it doesn't match.
    case 'hybrid':    return (c) => /\{[^}]*\/[^}]*\}/.test(c.rawManaCost || '');
    // Revolution's POP-set prismatic mana renders as `{Vp}` — a single
    // atomic pip (not a slash-hybrid). Only the POP set uses it.
    case 'prismatic': return (c) => /\{Vp\}/.test(c.rawManaCost || '');
    // Rarity shortcuts the spec mentions under "Search by Rarity"
    case 'common':
    case 'uncommon':
    case 'rare':
    case 'mythic':
    case 'special':   return (c) => c.rarity === v;
    // Fall back to user-defined tags. `tag:<x>` reaches the same lookup
    // directly, skipping the built-in keywords — use it when a tag name
    // collides with a built-in (e.g. a user tag literally named "page").
    default: return buildTagPredicate(rawValue);
  }
}

// User-defined tag lookup. Scoped to the active dataset (Revolution /
// Voyager never overlap) and keyed by canonical name so reprints share
// tags. Case-insensitive. Aliases resolve here too — `tag:kill` finds
// every removal-tagged card the same way the tagger does. tags.json
// (with its aliases map) is loaded in both modes.
function buildTagPredicate(rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  const ds = currentDataset();
  const slot0 = STATE.tags[ds];
  const aliased = slot0 && slot0.aliases ? slot0.aliases[v] : null;
  const matchLow = aliased ? String(aliased).toLowerCase() : v;
  return (c) => {
    const slot = STATE.tags[ds];
    if (!slot) return false;
    const arr = slot.cards[c.canonical] || slot.cards[c.name];
    if (!arr) return false;
    for (const t of arr) {
      if (String(t).toLowerCase() === matchLow) return true;
    }
    return false;
  };
}

// Tag-name shape recognised by `manabase:`. Also used by the tagger
// sidebar to hide these (there are a lot of them, and the tagger sidebar
// is the wrong place to scan them — `manabase:<colors>` is). Matches
// goldland, utilityland, and any `<colors>land` name where colors is a
// non-empty subset of WUBRG, case-insensitive.
function isLandManabaseTag(name) {
  const low = String(name || '').toLowerCase();
  if (low === 'goldland' || low === 'utilityland') return true;
  return /^[wubrg]+land$/.test(low);
}

// `manabase:<colors>` (or `manabase<=<colors>`) — shorthand for "lands that
// fit a deck of this color identity". Walks the dataset's existing tags
// and keeps the ones whose name is `<colors>land` (any subset of WUBRG,
// any ordering, any case) where the colors fit within the input — so a
// 1-, 2-, 3- (and beyond) color land tag is included as long as none of
// its colors is outside the input. Always includes `utilityland`, and
// `goldland` when the input is multicolor (a mono-color deck doesn't
// want gold lands cluttering its manabase view). Operator is ignored:
// `:` and `<=` mean the same thing here, since both express "fits
// within this color set".
function buildManabasePredicate(rawValue) {
  const allowed = new Set();
  for (const ch of stripQuotes(rawValue).toLowerCase()) {
    if ('wubrg'.includes(ch)) allowed.add(ch);
  }
  const includeGold = allowed.size >= 2;
  const ds = currentDataset();
  const slot = STATE.tags[ds];
  const wanted = new Set();
  if (slot) {
    for (const t of slot.order) {
      const low = String(t).toLowerCase();
      if (low === 'utilityland') { wanted.add(low); continue; }
      if (low === 'goldland') {
        if (includeGold) wanted.add(low);
        continue;
      }
      const m = low.match(/^([wubrg]+)land$/);
      if (!m) continue;
      let fits = true;
      for (const ch of m[1]) {
        if (!allowed.has(ch)) { fits = false; break; }
      }
      if (fits) wanted.add(low);
    }
  }
  return (c) => {
    const sl = STATE.tags[ds];
    if (!sl) return false;
    const arr = sl.cards[c.canonical] || sl.cards[c.name];
    if (!arr) return false;
    for (const t of arr) {
      if (wanted.has(String(t).toLowerCase())) return true;
    }
    return false;
  };
}

function buildHasPredicate(rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  if (v === 'flavor' || v === 'flavour') {
    return (c) => anyPrinting(c, p => p.flavor && p.flavor.trim());
  }
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

// Default zone for "add this dropdown card" actions. Modifier keys still
// override (Shift→maybe, Alt→side); otherwise the focused deck pane wins,
// so working in the side/maybe/sanctum pane lets Enter add straight there.
function searchAddZone(ev) {
  if (ev && ev.shiftKey) return 'maybe';
  if (ev && ev.altKey)   return 'side';
  const f = STATE.focusedZone;
  if (f === 'side' || f === 'maybe' || f === 'sanctum') return f;
  return 'main';
}

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
      const zone = searchAddZone(ev);
      addCardToZone(picked.id, zone);
      // Don't clear input — power users repeatedly add the same card by hitting Enter 4x.
      // But do refocus and reset selection.
      renderSearchResults();
      renderAll();
    }
    // Escape is handled by the wrap-level listener below so it also works
    // when focus is on the panel-toggle button (not just the input) — e.g.
    // after the user clicks the toggle off mid-search.
  });

  input.addEventListener('focus', () => {
    if (STATE.searchPanel) return;
    const n = STATE.search.results.length;
    if (n > 0) results.classList.remove('hidden');
  });

  document.addEventListener('click', (ev) => {
    if (!input.contains(ev.target) && !results.contains(ev.target)) {
      results.classList.add('hidden');
      hidePreview();
    }
  });

  // Escape from anywhere inside the search wrap (input *or* the panel-toggle
  // button) blurs focus and hides the dropdown. Needed because the toolbar
  // is suppressed via `.search-wrap:focus-within` — if focus stays on the
  // toggle button after turning panel mode off, the toolbar stays hidden
  // until we blur something.
  const wrap = document.querySelector('.search-wrap');
  if (wrap) {
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const a = document.activeElement;
      if (!a || !wrap.contains(a)) return;
      results.classList.add('hidden');
      hidePreview();
      a.blur();
    });
  }
}

// Threshold above which the dropdown stays hidden. Broad queries
// (`t:creature` etc.) are meant to be browsed in panel mode, which renders
// every match. STATE.search.results stores the full uncapped list — counts
// and panel mode reflect it; only the dropdown is suppressed past this
// many matches.
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
  STATE.search.results = items;
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

// Sort the result list. When the query includes sort:X, the parsed spec
// wins (ties broken by canonical name). Otherwise fall back to the current
// pile-sort chain so the displayed order matches the Pile-sort dropdown
// label — an alphabetical default would make the label look like a no-op.
// A leading -sort desc direction is stored as desc=true on the entry
// (currently always false — the grammar accepts -sort:mv but we treat the
// minus as NOT and drop the sort; see the FIXME below if we want proper
// descending support).
function sortSearchItems(items, sortSpec) {
  const specs = (sortSpec && sortSpec.length) ? sortSpec : null;
  if (!specs) {
    sortSearchItemsByPileChain(items);
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

// Sort search items using the current pile-sort chain, via the same
// comparator the deck panes use. Wraps each item's newest printing in a
// minimal { cardId } stand-in so compareCardsChained (which expects card
// instances) can look the card up in STATE.byId.
function sortSearchItemsByPileChain(items) {
  items.sort((a, b) => {
    const ac = a.printings[a.printings.length - 1];
    const bc = b.printings[b.printings.length - 1];
    const c = compareCardsChained({ cardId: ac.id }, { cardId: bc.id }, STATE.pileSortChain);
    if (c !== 0) return c;
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
  if (r.length > SEARCH_RESULT_CAP) {
    // Broad queries are meant to be browsed in panel mode. Surface the count
    // and point the user at the grid view (or to refine) instead of silently
    // hiding the dropdown.
    results.classList.remove('hidden');
    results.innerHTML = '';
    const notice = document.createElement('div');
    notice.className = 'result-overflow';
    notice.textContent = `${r.length} results, use grid view or restrict more`;
    results.appendChild(notice);
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
      const zone = searchAddZone(ev);
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
          const zone = searchAddZone(ev);
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

// While a sideboard plan is active the 75 is fixed — no adds, no removes,
// no maybe writes. Moves between main and side are still allowed (that's
// the whole point of a plan), and printing/art swaps are allowed (they
// don't change canonical identity) and propagate back to the base deck.
function isMaybeLocked() { return !!STATE.loadedPlanName; }
function isPlanActive() { return !!STATE.loadedPlanName; }

function notePlanLock(msg) {
  // Brief status ribbon shown when a plan-mode write is rejected. Reuses
  // the search error element so there's exactly one "that didn't work"
  // channel the user scans.
  const el = document.getElementById('search-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(notePlanLock._t);
  notePlanLock._t = setTimeout(() => {
    el.classList.add('hidden');
    el.textContent = '';
  }, 1800);
}

function addCardToZone(cardId, zoneName, count = 1) {
  if (isPlanActive()) {
    notePlanLock("Plan has a fixed 75 — can't add new cards.");
    return;
  }
  placeCardsInZone(cardId, zoneName, count);
}

// Unguarded placement used by the import flow, which needs to rewrite zones
// even while a plan is active (the 75-invariant is checked after load).
function placeCardsInZone(cardId, zoneName, count = 1) {
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
  // Writes into maybe while a plan is active are rejected. Moves OUT of
  // maybe while a plan is active are also rejected, because maybe isn't a
  // zone the plan controls — those edits belong on the base deck.
  if (isMaybeLocked() && (toZone === 'maybe' || found.zoneName === 'maybe')) {
    notePlanLock('Maybeboard is locked while a sideboard plan is active.');
    return;
  }
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
  if (isMaybeLocked() && zoneName === 'maybe') {
    notePlanLock('Maybeboard is locked while a sideboard plan is active.');
    return;
  }
  // Also reject drags that would SOURCE from maybe while a plan is active —
  // maybe is supposed to be frozen, not a card pool for the plan.
  if (isMaybeLocked()) {
    for (const uid of uids) {
      const found = findInstance(uid);
      if (found && found.zoneName === 'maybe') {
        notePlanLock('Maybeboard is locked while a sideboard plan is active.');
        return;
      }
    }
  }
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
  updatePlanBanner();
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
// Called on deck swaps (New / Load) — undoing back into a prior
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
    // typing corrections aren't hijacked by deck undo. #search is excluded:
    // every search-add path refocuses it, so leaving it in this bucket means
    // Ctrl+Z is a no-op for the most common add flow.
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.isContentEditable
              || (a.tagName === 'INPUT' && a.id !== 'search'))) return;
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
  const el = document.getElementById('count-' + zoneName);
  if (!el) return;
  el.textContent = String(totalCount(zoneName));
  const err = zoneValidityError(zoneName);
  el.classList.toggle('invalid', !!err);
  if (err) el.title = err;
  else el.removeAttribute('title');
}

// Is this card eligible to live in the Voyager sanctum? Criteria:
//   (a) a basic land (`Basic` supertype + `Land` type), OR
//   (b) any printing with the `Wonder`, `Realm`, or `Frontier` subtype, OR
//   (c) any card with Pathbound, Transcend, Usurpate, or Heir keyword.
// Kept dataset-agnostic: Revolution cards never satisfy any of these, so
// the predicate can be called unconditionally without per-dataset gating.
const SANCTUM_SUBTYPES = ['Wonder', 'Realm', 'Frontier'];
const SANCTUM_KEYWORDS = ['pathbound', 'transcend', 'usurpate', 'heir'];
function isSanctumEligible(card) {
  if (!card) return false;
  const supers = card.supertypes || [];
  const types = card.types || [];
  if (supers.includes('Basic') && types.includes('Land')) return true;
  const subs = card.subtypes || [];
  for (const st of SANCTUM_SUBTYPES) if (subs.includes(st)) return true;
  const kws = card.keywords || [];
  for (const kw of SANCTUM_KEYWORDS) if (kws.includes(kw)) return true;
  return false;
}

// Return a user-facing reason string if `zoneName` is in an invalid state,
// or null if valid. Rules:
//   - main < 60 cards
//   - side > 15 cards
//   - sanctum > 7 cards or contains cards that aren't sanctum-eligible
// Deliberately non-blocking: we only mark the count badge red (with a
// tooltip), never reject the edit that caused it. Matches the existing
// soft-validation posture the rest of the deckbuilder uses.
function zoneValidityError(zoneName) {
  const n = totalCount(zoneName);
  if (zoneName === 'main') {
    return n < 60 ? `Main deck has ${n} card${n === 1 ? '' : 's'} (min 60)` : null;
  }
  if (zoneName === 'side') {
    return n > 15 ? `Sideboard has ${n} cards (max 15)` : null;
  }
  if (zoneName === 'sanctum') {
    const parts = [];
    if (n > 7) parts.push(`Sanctum has ${n} cards (max 7)`);
    let ineligible = 0;
    for (const pile of STATE.zones.sanctum.piles) {
      for (const inst of pile) {
        const c = STATE.byId.get(inst.cardId);
        if (c && !isSanctumEligible(c)) ineligible++;
      }
    }
    if (ineligible) {
      parts.push(`${ineligible} card${ineligible === 1 ? '' : 's'} can't be in sanctum`);
    }
    return parts.length ? parts.join('; ') : null;
  }
  return null;
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
  if (STATE.tagMode && STATE.focusedZone === 'tag') { renderTagMemberPanel(); return; }
  if (STATE.tagMode && STATE.focusedZone === 'tag-list') { renderAllTagsPanel(); return; }
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
  const oldToNewNames = [];
  for (const uid of targetUids) {
    const f = findInstance(uid);
    if (f && f.inst.cardId !== newCardId) {
      const oldCard = STATE.byId.get(f.inst.cardId);
      const newCard = STATE.byId.get(newCardId);
      if (oldCard && newCard) oldToNewNames.push({ oldName: oldCard.name, newName: newCard.name });
      f.inst.cardId = newCardId;
    }
  }
  if (oldToNewNames.length > 0) {
    // Art/printing swaps under a plan also update the base deck's saved
    // payload so the plan and its deck always agree on which art is used.
    // Canonical identity is unchanged, so the 75 invariant stays intact.
    if (isPlanActive()) propagatePrintingToBase(oldToNewNames);
    renderAll();
  }
}

function propagatePrintingToBase(swaps) {
  // `swaps` is an array of { oldName, newName }. For each swap, update ONE
  // matching name in the base deck's stored main or side piles. Running one
  // swap at a time means "swap 1 of 4 copies in the plan" also swaps "1 of
  // 4 copies in the base," which matches the user's local-feeling mutation.
  if (!STATE.loadedDeckName) return;
  const payload = readDeckPayload(STATE.loadedDeckName);
  if (!payload || !payload.zones) return;
  let changed = false;
  for (const { oldName, newName } of swaps) {
    if (oldName === newName) continue;
    let replaced = false;
    for (const z of ['main', 'side']) {
      if (replaced) break;
      const piles = payload.zones[z] || [];
      for (let p = 0; p < piles.length && !replaced; p++) {
        for (let i = 0; i < piles[p].length && !replaced; i++) {
          if (piles[p][i] === oldName) {
            piles[p][i] = newName;
            replaced = true;
            changed = true;
          }
        }
      }
    }
  }
  if (!changed) return;
  writeDeckPayload(STATE.loadedDeckName, payload);
  // basePlanZones caches the base's names for the live 75-diff indicator —
  // keep it in sync so the banner doesn't flash a spurious mismatch.
  STATE.basePlanZones = {
    main: payload.zones.main || [],
    side: payload.zones.side || [],
  };
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
      // Tile may still carry a data-src from the lazy-load observer. Clear
      // it so a later intersection callback can't overwrite the flipped
      // face with the front-face URL.
      img.removeAttribute('data-src');
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

  // Under a plan the 75 is fixed, so +, −, and ? (maybe) are all rejected
  // by the write-path guards. Skip rendering them so the user isn't teased
  // with actions that can't succeed. The main↔side swap is still allowed.
  const planActive = isPlanActive();

  if (!planActive) wrap.appendChild(makeBtn('+', 'Add another copy', () => {
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
  if (!planActive) wrap.appendChild(makeBtn('\u2212', 'Remove this copy', () => {
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
  if (!planActive) wrap.appendChild(makeBtn('?', 'Move to/from maybeboard', () => {
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
    // Maybe is read-only under a plan. Gate both same-zone re-orders (when
    // the user is viewing maybe) and cross-zone drops from/into maybe.
    if (isMaybeLocked()) {
      const m = 'Maybeboard is locked while a sideboard plan is active.';
      if (STATE.focusedZone === 'maybe') { notePlanLock(m); return; }
      for (const uid of uids) {
        const found = findInstance(uid);
        if (found && found.zoneName === 'maybe') { notePlanLock(m); return; }
      }
    }
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
  // deck panes. Results are ordered by an explicit sort:X in the query if
  // present, otherwise by the current pile-sort chain (see sortSearchItems).
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
  // Lazy-load: broad queries can return 100+ results, and eager-loading every
  // tile fires a storm of parallel image requests (many of which the user
  // will never scroll to). The observer swaps data-src → src when the tile
  // is within a viewport or two of the scrolled-into view, so only ~30
  // tiles' worth fetch at a time.
  img.dataset.src = imgUrl(face0);
  img.addEventListener('error', () => {
    slot.classList.add('no-image');
    slot.textContent = face0.canonical || face0.name || '???';
  });
  slot.appendChild(img);
  // Observe *after* the slot lands in the DOM so the observer has a valid
  // ancestor chain to compute intersection against; scheduled as a
  // microtask since the caller appends to the container synchronously
  // right after we return.
  queueMicrotask(() => getSearchImgObserver().observe(img));
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
  // In tag mode, overlay the card's full tag list as chips so the user can
  // see (and click-× to remove) every tag without having to focus the tag
  // section first. Same widget the focused-tag panel uses.
  if (STATE.tagMode && card.canonical) {
    slot.appendChild(makeCardTagChips(card.canonical));
  }
  return slot;
}

function makeSearchSlotButtons(card) {
  const wrap = document.createElement('div');
  wrap.className = 'slot-buttons';
  wrap.draggable = false;

  function makeBtn(label, title, onClick, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.dataset.title = title;
    b.draggable = false;
    b.addEventListener('mousedown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onClick(b, ev);
    });
    return b;
  }

  // Tag mode swaps the 4 deck-add buttons for 2 tag actions: open the
  // popover to enter a tag (with autocomplete), or apply the last-used
  // tag directly. Multi-select semantics mirror the deck-mode buttons.
  if (STATE.tagMode) {
    const pickCanonicals = () => {
      const ids = (STATE.searchSelection.size > 0 && STATE.searchSelection.has(card.id))
        ? [...STATE.searchSelection]
        : [card.id];
      return ids.map(id => STATE.byId.get(id)?.canonical).filter(Boolean);
    };
    wrap.appendChild(makeBtn('+', 'Add a tag (autocomplete)', (btn) => {
      openTagPopover(btn, pickCanonicals());
    }, 'tag-btn'));
    const repeatTitle = STATE.lastUsedTag
      ? `Apply "${STATE.lastUsedTag}"`
      : 'No recent tag yet — opens picker';
    const repeatBtn = makeBtn('↻', repeatTitle, () => {
      if (!STATE.lastUsedTag) {
        openTagPopover(repeatBtn, pickCanonicals());
        return;
      }
      addTagToCards(STATE.lastUsedTag, pickCanonicals());
      renderTagSidebar();
      if (STATE.focusedTag) renderPiles();
    }, 'tag-btn tag-repeat-btn');
    if (!STATE.lastUsedTag) repeatBtn.classList.add('disabled');
    wrap.appendChild(repeatBtn);
    return wrap;
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
  // Under a sideboard plan all adds are blocked — the 75 is fixed.
  if (!isPlanActive()) {
    wrap.appendChild(makeBtn('+', 'Add to main deck', () => addTo('main')));
    // Sanctum button is CSS-hidden outside Voyager mode (see .sanctum-only
    // in style.css) so Revolution users don't see an option they can't use.
    const sanctumBtn = makeBtn('\u25a0', 'Add to sanctum', () => addTo('sanctum'));
    sanctumBtn.classList.add('sanctum-only');
    wrap.appendChild(sanctumBtn);
    wrap.appendChild(makeBtn('\u2194', 'Add to sideboard', () => addTo('side')));
    wrap.appendChild(makeBtn('?', 'Add to maybeboard', () => addTo('maybe')));
  }

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

  // Arrow keys cycle focus between visible zones when no text input is
  // focused (so the search box's own arrow-key handling still works).
  // Sanctum is only in the order when we're in Voyager mode.
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    let delta = 0;
    if (ev.key === 'ArrowDown') delta = 1;
    else if (ev.key === 'ArrowUp') delta = -1;
    else return;
    ev.preventDefault();
    const order = visibleZoneOrder();
    const idx = order.indexOf(STATE.focusedZone);
    const next = order[((idx < 0 ? 0 : idx) + delta + order.length) % order.length];
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
  const allTagsBtn = document.getElementById('btn-all-tags');
  if (allTagsBtn) allTagsBtn.classList.toggle('active', zoneName === 'tag-list');
  renderPiles();
}

// ---------------------------------------------------------------------------
// Toolbar (import/export/clear/legal toggle)
// ---------------------------------------------------------------------------

// wireToolbar wires the deckbuilder header. Two of its concerns are shared
// with the tagger page (which loads this same module): the format dropdown
// and the floating actions (theme / refresh / image cache). Those are
// extracted into wireFormatDropdown / wireFloatingActions and run in both
// modes. Everything below the `if (STATE.tagMode) return` is deckbuilder-
// only — its buttons live in index.html, NOT tags.html, so the wiring code
// here may assume each getElementById hits and may crash loudly if it
// doesn't (a missing button on index.html is a bug). When you add a new
// deckbuilder-only toolbar button, wire it below the gate; do NOT add a
// hidden stub to tags.html.
function wireToolbar() {
  wireFormatDropdown();
  wireFloatingActions();
  // wireSearchHelp / wirePlanBanner null-check their own controls and are
  // safe in both modes. Tag mode has no search-help modal but does have
  // a plan-exit stub; both tolerate either.
  wireSearchHelp();
  wirePlanBanner();
  // drag-trash is a shared element (tags.html ships it too) so the drag
  // handlers wire in either mode.
  wireDragTrash();

  if (STATE.tagMode) return;

  // ---- deckbuilder-only wiring below ----
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
  wireShare();
  wirePasteImport();
  wireCopyTxt();
  wireSavedDecks();
  document.getElementById('btn-new-deck').addEventListener('click', () => {
    if (deckIsDirty() && !confirm('Clear all zones and start a new deck?')) return;
    clearAllZones();
    STATE.loadedDeckName = null;
    STATE.loadedDeckFolder = null;
    STATE.loadedDeckTags = [];
    STATE.loadedPlanName = null;
    STATE.basePlanZones = null;
    updateSaveButtons();
    renderAll();
    resetHistory();
    markDeckClean();
  });
}

// Format / dataset switcher. Shared between deckbuilder and tagger; both
// pages ship the format-btn / format-menu / range-pickers DOM.
function wireFormatDropdown() {
  const formatBtn = document.getElementById('format-btn');
  const formatMenu = document.getElementById('format-menu');
  formatBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    formatMenu.classList.toggle('hidden');
  });
  formatMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const newFormat = btn.dataset.format;
      const crossesDataset = datasetForFormat(newFormat) !== currentDataset();
      // Keep menu open when "Sets" is picked so range pickers are accessible.
      if (newFormat !== 'range') formatMenu.classList.add('hidden');
      if (crossesDataset) {
        // Crossing the Revolution/Voyager boundary: swap the card pool.
        // First-time Voyager loads fetch live; if that fails, surface the
        // error and leave the user on the current format.
        formatBtn.disabled = true;
        try {
          await switchDataset(datasetForFormat(newFormat));
        } catch (e) {
          console.error(e);
          alert('Could not load Voyager cards: ' + (e.message || e));
          formatBtn.disabled = false;
          return;
        }
        formatBtn.disabled = false;
      }
      STATE.format = newFormat;
      savePrefs();
      syncFormatUI();
      // Close the Decks dropdown if it's open — its saved-decks list is
      // filtered by format, so leaving it rendered would show stale
      // entries. Next open rebuilds from listSavedDecks().
      const decksDropdown = document.getElementById('decks-dropdown');
      if (decksDropdown) decksDropdown.classList.add('hidden');
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
}

// Floating actions (theme / refresh / image cache). Shared between
// deckbuilder and tagger; both pages ship these buttons.
function wireFloatingActions() {
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn.addEventListener('click', async () => {
    const original = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Updating\u2026';
    try {
      const wasVoyager = currentDataset() === 'voyager';
      await refreshCurrentDataset();
      // Revolution's image URLs carry a multiverseId cache-buster that
      // bumps on upstream updates; drop the image cache so stale ?v=<old>
      // entries don't linger. Voyager uses absolute per-card picurls that
      // change only when the file renames, so its cache stays valid.
      if (!wasVoyager) await clearImageCache();
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

  const cacheImgsBtn = document.getElementById('btn-cache-imgs');
  if (cacheImgsBtn) {
    let cancelCache = false;
    cacheImgsBtn.addEventListener('click', async () => {
      // Second click while running cancels.
      if (cacheImgsBtn.dataset.running === '1') { cancelCache = true; return; }
      const original = cacheImgsBtn.textContent;
      cacheImgsBtn.dataset.running = '1';
      cancelCache = false;
      try {
        const result = await cacheAllImages((done, total, failed) => {
          cacheImgsBtn.textContent = `${done}/${total}` + (failed ? ` (${failed} failed)` : '');
          return cancelCache;
        });
        if (result.cancelled) {
          cacheImgsBtn.textContent = 'Stopped';
        } else {
          cacheImgsBtn.textContent = result.failed
            ? `Cached \u2713 (${result.failed} failed)`
            : 'Cached \u2713';
        }
        setTimeout(() => { cacheImgsBtn.textContent = original; }, 2500);
      } catch (e) {
        console.error(e);
        cacheImgsBtn.textContent = 'Failed';
        setTimeout(() => { cacheImgsBtn.textContent = original; }, 2500);
      } finally {
        delete cacheImgsBtn.dataset.running;
      }
    });
  }
}

// Pre-fetch every card image in the current dataset so the SW caches them.
// Sequential-ish with a small concurrency window to avoid hammering the
// upstream host. progressCb(done, total, failed) can return truthy to stop.
async function cacheAllImages(progressCb) {
  const urls = new Set();
  for (const card of STATE.cards) {
    const u = imgUrl(card);
    if (u) urls.add(u);
    if (card.back) {
      const bu = imgUrl(card.back);
      if (bu) urls.add(bu);
    }
  }
  const list = [...urls];
  const total = list.length;

  // Skip URLs already in the SW's image cache: a single keys() read is
  // dramatically faster than firing N Image() loads through the SW just
  // to learn they're hits. Same storage the SW writes to, so a tiny race
  // window is possible (a put() in flight from a card we just viewed) —
  // worst case we re-fetch one image.
  let alreadyCached = new Set();
  if ('caches' in self) {
    try {
      const cache = await caches.open('rev-img-v1');
      const keys = await cache.keys();
      alreadyCached = new Set(keys.map(req => req.url));
    } catch (e) { /* fall through and fetch everything */ }
  }
  const misses = list.filter(u => !alreadyCached.has(u));
  let done = total - misses.length;
  let failed = 0, cancelled = false;
  let idx = 0;
  // Surface the "already-cached" jump immediately so the button shows
  // e.g. 2847/2900 the moment you click, not after the first miss completes.
  if (progressCb && progressCb(done, total, failed)) {
    return { total, done, failed, cancelled: true };
  }
  const CONCURRENCY = 6;
  function fetchOne(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }
  async function worker() {
    while (idx < misses.length && !cancelled) {
      const myIdx = idx++;
      const ok = await fetchOne(misses[myIdx]);
      if (!ok) failed++;
      done++;
      if (progressCb && progressCb(done, total, failed)) {
        cancelled = true;
        return;
      }
    }
  }
  const workers = Array(Math.min(CONCURRENCY, misses.length)).fill(0).map(worker);
  await Promise.all(workers);
  return { total, done, failed, cancelled };
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
      if (STATE.focusedZone === 'search') {
        sortSearchItemsByPileChain(STATE.search.results);
      } else {
        resortPiles(STATE.focusedZone);
      }
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
    // this drag so mousemove doesn't have to re-check on every tick. The
    // tagger's focused-tag panel reuses search slots (cardId-keyed), so it
    // needs the same store and key as the search pane.
    const mode = (STATE.focusedZone === 'search'
                  || (STATE.tagMode && STATE.focusedZone === 'tag'))
                ? 'search' : 'deck';
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
  // The tag popover sits next to the card the user just clicked — suppress
  // the hover preview while it's open so it doesn't cover the input.
  const pop = document.getElementById('tag-popover');
  if (pop && !pop.classList.contains('hidden')) return;
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

// Shared IntersectionObserver for search-panel / tag-panel tiles. Tiles
// render with `data-src` but no `src`, and this observer swaps them in as
// each tile scrolls within ~one viewport of being visible. That keeps the
// initial burst to roughly a screenful (~30 tiles) instead of a full
// flood for 100+ result queries, while still prefetching a screen ahead
// so scrolling stays lag-free.
let _searchImgObserver = null;
function getSearchImgObserver() {
  if (_searchImgObserver) return _searchImgObserver;
  const piles = document.getElementById('piles');
  _searchImgObserver = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      const src = img.dataset.src;
      if (src) {
        img.src = src;
        img.removeAttribute('data-src');
      }
      obs.unobserve(img);
    }
  }, {
    // `.piles` is the scroll container (overflow:auto). Fall back to the
    // viewport when it doesn't exist (defensive — it's baked into both HTMLs).
    root: piles || null,
    // ~one viewport of predictive margin — a screen's worth of tiles load
    // before they scroll into view, so scrolling isn't gated on the network.
    rootMargin: '400px 0px',
    threshold: 0,
  });
  return _searchImgObserver;
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
  for (const z of Object.keys(STATE.zones)) {
    STATE.zones[z].piles = [];
  }
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

// Apply an imported decklist to the current zones. Behavior splits on
// whether a sideboard plan is active:
//   - Plan active: overwrite the main/side split, then verify the 75 still
//     matches the plan's base. On mismatch, revert and alert the user.
//   - Otherwise: overwrite the zones as the current deck's new contents.
// Import is a single undo step in both cases — Ctrl+Z restores pre-import.
function importDeck(text) {
  const stripped = text.replace(/^\uFEFF/, '').trimStart();
  const isXml = stripped.startsWith('<');
  const pre = serializeZones();
  const planActive = isPlanActive();
  const result = isXml ? importCod(text) : importTxt(text);
  if (!result) return;
  if (planActive) {
    const diff = currentPlanDiff();
    if (!diffIsEmpty(diff)) {
      STATE.zones = JSON.parse(pre);
      renderAll();
      alert("Imported list doesn't match this plan's 75: " + describeDiff(diff));
      return;
    }
  }
  renderAll();
  updateSaveButtons();
  reportUnknown(result.unknown);
}

function importCod(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) { alert('Failed to parse XML: ' + e); return null; }
  const err = doc.querySelector('parsererror');
  if (err) { alert('Failed to parse .cod: ' + err.textContent); return null; }

  clearAllZones();

  const zones = doc.querySelectorAll('zone');
  const unknown = [];
  zones.forEach(zoneEl => {
    const zname = (zoneEl.getAttribute('name') || '').toLowerCase();
    let target = 'main';
    if (zname === 'side' || zname === 'sideboard') target = 'side';
    else if (zname === 'maybe' || zname === 'maybeboard') target = 'maybe';
    else if (zname === 'sanctum') target = 'sanctum';

    zoneEl.querySelectorAll('card').forEach(cardEl => {
      const number = parseInt(cardEl.getAttribute('number') || '1', 10);
      const name = cardEl.getAttribute('name') || '';
      const uuid = cardEl.getAttribute('uuid') || '';
      const cardId = resolveCardName(name, uuid);
      if (!cardId) { unknown.push(name); return; }
      placeCardsInZone(cardId, target, number);
    });
  });

  for (const z of Object.keys(STATE.zones)) resortPiles(z);
  return { unknown };
}

function importTxt(text) {
  // Group cards by runs of "<count> <name>" lines, separated by anything
  // else (blank lines, headers, comments). Zone-name headers ("sideboard",
  // "sanctum", …) are honored when present; runs without a preceding header
  // fall back to the legacy positional convention (first run → main,
  // second → side, third → maybe). Sanctum is header-only — no positional
  // fallback — so old Revolution imports keep their current behavior.
  const cardLine = /^\s*(\d+)\s+(.+?)\s*$/;
  const HEADER_ALIASES = {
    main:    ['main', 'maindeck', 'mainboard', 'deck'],
    side:    ['side', 'sideboard'],
    maybe:   ['maybe', 'maybeboard'],
    sanctum: ['sanctum'],
  };
  function matchHeader(line) {
    const lower = line.trim().toLowerCase().replace(/[:.]+$/, '');
    for (const [zone, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(lower)) return zone;
    }
    return null;
  }

  const groups = [];  // each: { zone: string|null, entries: [...] }
  let cur = null;
  let pendingZone = null;
  for (const raw of text.split(/\r?\n/)) {
    const hdr = matchHeader(raw);
    if (hdr) {
      pendingZone = hdr;
      cur = null;
      continue;
    }
    const m = raw.match(cardLine);
    if (m) {
      if (!cur) {
        cur = { zone: pendingZone, entries: [] };
        pendingZone = null;
        groups.push(cur);
      }
      // Strip a single trailing period on the card name — decklists that
      // end a line with a sentence terminator ("1 Sundown.") shouldn't
      // cause the lookup to fail.
      const name = m[2].replace(/\.$/, '').trim();
      cur.entries.push({ count: parseInt(m[1], 10), name });
    } else {
      cur = null;
    }
  }

  clearAllZones();
  const POSITIONAL = ['main', 'side', 'maybe'];
  let positionalIdx = 0;
  const unknown = [];
  for (const group of groups) {
    let zone = group.zone;
    if (!zone) {
      zone = POSITIONAL[positionalIdx] || 'maybe';
      positionalIdx++;
    }
    for (const { count, name } of group.entries) {
      const cardId = resolveCardName(name, null);
      if (!cardId) { unknown.push(name); continue; }
      placeCardsInZone(cardId, zone, count);
    }
  }

  for (const z of Object.keys(STATE.zones)) resortPiles(z);
  return { unknown };
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

// Ask the user whether to merge the maybeboard into the sideboard or leave
// it out of the export entirely. Called from the txt export handler, gated
// on the maybeboard actually having cards. Returns a Promise that resolves
// to 'merge', 'omit', or 'cancel'.
function promptMaybeboardInclusion(exportLabel) {
  return new Promise((resolve) => {
    const modal  = document.getElementById('maybe-export-modal');
    const msg    = document.getElementById('maybe-export-msg');
    const cancel = document.getElementById('maybe-export-cancel');
    const omit   = document.getElementById('maybe-export-omit');
    const merge  = document.getElementById('maybe-export-merge');
    const maybeCount = STATE.zones.maybe.piles.reduce((n, p) => n + p.length, 0);
    msg.textContent = `Your maybeboard has ${maybeCount} card${maybeCount === 1 ? '' : 's'}. `
                    + `For the ${exportLabel} export, merge them into the sideboard, `
                    + `or leave them out entirely?`;
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      cancel.removeEventListener('click', onCancel);
      omit.removeEventListener('click', onOmit);
      merge.removeEventListener('click', onMerge);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onCancel() { cleanup('cancel'); }
    function onOmit()   { cleanup('omit'); }
    function onMerge()  { cleanup('merge'); }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); onMerge(); }
    }
    const backdrop = modal.querySelector('.modal-backdrop');
    cancel.addEventListener('click', onCancel);
    omit.addEventListener('click', onOmit);
    merge.addEventListener('click', onMerge);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    // Default focus lands on the primary action so Enter merges.
    setTimeout(() => merge.focus(), 0);
  });
}

// Decide the maybeboard mode for the current export. Resolves synchronously
// to 'omit' when the maybeboard is empty (no prompt needed) — otherwise
// awaits the user's choice from the modal.
async function resolveMaybeMode(exportLabel) {
  const maybeCount = STATE.zones.maybe.piles.reduce((n, p) => n + p.length, 0);
  if (maybeCount === 0) return 'omit';
  return promptMaybeboardInclusion(exportLabel);
}

// ---------------------------------------------------------------------------
// Search-syntax docs modal
// ---------------------------------------------------------------------------

function wireSearchHelp() {
  const modal = document.getElementById('search-help-modal');
  const trigger = document.getElementById('btn-search-help');
  if (!modal || !trigger) return;
  const open = () => modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  trigger.addEventListener('click', open);
  document.getElementById('search-help-close').addEventListener('click', close);
  document.getElementById('search-help-ok').addEventListener('click', close);
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (modal.classList.contains('hidden')) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
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
    importDeck(text);
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

// Should a deck saved under `deckFormat` be visible while the user is in
// the currently-active format? Rules:
//   - Voyager mode shows only Voyager decks (separate card pool).
//   - Standard mode is strict — only decks explicitly saved as Standard
//     (plus legacy decks with no stored format, treated as Standard).
//   - Eternal / Range / Sets mode shows any Revolution-family deck — they
//     share Revolution's card pool, and the broader format can accommodate
//     a Standard-only build.
// Any other deckFormat (future additions, corrupted data) is treated as
// Revolution-family for back-compat.
function deckFormatVisibleInCurrentFormat(deckFormat) {
  const dfmt = deckFormat || 'standard';
  if (STATE.format === 'voyager') return dfmt === 'voyager';
  if (dfmt === 'voyager') return false;
  if (STATE.format === 'standard') return dfmt === 'standard';
  return true;  // eternal / range / unknown Revolution-family deck
}

function listSavedDecks() {
  // Returns [{ name, savedAt, folder, tags, format }] sorted by savedAt
  // descending (newest first), filtered to just the decks compatible with
  // the currently-active format. Decks built for a different card pool
  // (e.g. Voyager decks while browsing in Revolution, or Eternal decks
  // while browsing in Standard) are hidden so users don't accidentally
  // load a deck they can't use.
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SAVED_DECK_PREFIX)) continue;
    try {
      const obj = JSON.parse(localStorage.getItem(key));
      if (!obj || typeof obj.name !== 'string') continue;
      const format = (typeof obj.format === 'string' && obj.format) ? obj.format : 'standard';
      if (!deckFormatVisibleInCurrentFormat(format)) continue;
      out.push({
        name: obj.name,
        savedAt: obj.savedAt || '',
        folder: (typeof obj.folder === 'string' && obj.folder) ? obj.folder : null,
        tags: Array.isArray(obj.tags) ? obj.tags.slice() : [],
        format,
      });
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
  for (const z of ['main', 'sanctum', 'side', 'maybe']) {
    zones[z] = zoneNamesByPile(z);
  }
  const prev = readDeckMeta(name);
  const folder = opts && 'folder' in opts
    ? ((typeof opts.folder === 'string' && opts.folder) ? opts.folder : null)
    : prev.folder;
  const tags = opts && 'tags' in opts
    ? (Array.isArray(opts.tags) ? opts.tags.slice() : [])
    : prev.tags;

  // Preserve existing sideboard plans and recompute staleness against the
  // new main+side. A plan is stale iff its (main+side) canonical multiset
  // no longer matches the deck's (main+side) canonical multiset.
  const prevPayload = readDeckPayload(name);
  const prevPlans = (prevPayload && Array.isArray(prevPayload.plans)) ? prevPayload.plans : [];
  const newBaseMulti = canonicalMultiset(zones.main, zones.side);
  const plans = prevPlans.map(plan => {
    const pz = plan.zones || { main: [], side: [] };
    const pMulti = canonicalMultiset(pz.main, pz.side);
    const diff = diffMultisets(newBaseMulti, pMulti);
    return { ...plan, zones: pz, stale: !diffIsEmpty(diff) };
  });

  const payload = {
    name,
    savedAt: new Date().toISOString(),
    zones,
    format: STATE.format,
    rangeStart: STATE.rangeStart,
    rangeEnd: STATE.rangeEnd,
    folder,
    tags,
    plans,
  };
  localStorage.setItem(SAVED_DECK_PREFIX + name, JSON.stringify(payload));
  markDeckClean();
}

function readDeckPayload(name) {
  const raw = localStorage.getItem(SAVED_DECK_PREFIX + name);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function writeDeckPayload(name, payload) {
  localStorage.setItem(SAVED_DECK_PREFIX + name, JSON.stringify(payload));
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
  for (const z of ['main', 'sanctum', 'side', 'maybe']) {
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
  // Loading a base deck always clears any active plan — the plan belongs to
  // whichever deck was loaded before.
  STATE.loadedPlanName = null;
  STATE.basePlanZones = null;
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
  updateSaveButtons();
  if (unknown.length > 0) reportUnknown(unknown);
  return true;
}

function deleteDeckFromStorage(name) {
  localStorage.removeItem(SAVED_DECK_PREFIX + name);
}

// ---------------------------------------------------------------------------
// Sideboard plans (per-deck, stored inside the deck payload's plans[] array)
// ---------------------------------------------------------------------------

function listPlans(deckName) {
  const p = readDeckPayload(deckName);
  return (p && Array.isArray(p.plans)) ? p.plans : [];
}

function createPlan(deckName, planName) {
  const payload = readDeckPayload(deckName);
  if (!payload) throw new Error('Deck "' + deckName + '" not found.');
  if (!Array.isArray(payload.plans)) payload.plans = [];
  if (payload.plans.some(p => p.name === planName)) {
    throw new Error('A plan named "' + planName + '" already exists for this deck.');
  }
  payload.plans.push({
    name: planName,
    savedAt: new Date().toISOString(),
    zones: { main: zoneNamesByPile('main'), side: zoneNamesByPile('side') },
    stale: false,
  });
  writeDeckPayload(deckName, payload);
}

function deletePlan(deckName, planName) {
  const payload = readDeckPayload(deckName);
  if (!payload || !Array.isArray(payload.plans)) return;
  payload.plans = payload.plans.filter(p => p.name !== planName);
  writeDeckPayload(deckName, payload);
}

function renamePlan(deckName, oldName, newName) {
  const payload = readDeckPayload(deckName);
  if (!payload || !Array.isArray(payload.plans)) return false;
  if (oldName === newName) return true;
  if (payload.plans.some(p => p.name === newName)) return false;
  const plan = payload.plans.find(p => p.name === oldName);
  if (!plan) return false;
  plan.name = newName;
  writeDeckPayload(deckName, payload);
  if (STATE.loadedDeckName === deckName && STATE.loadedPlanName === oldName) {
    STATE.loadedPlanName = newName;
  }
  return true;
}

function loadPlanFromStorage(deckName, planName) {
  const payload = readDeckPayload(deckName);
  if (!payload || !Array.isArray(payload.plans)) return false;
  const plan = payload.plans.find(p => p.name === planName);
  if (!plan) return false;
  if (plan.stale) {
    const baseMulti = canonicalMultiset(payload.zones.main || [], payload.zones.side || []);
    const pMulti = canonicalMultiset(plan.zones.main || [], plan.zones.side || []);
    const diff = diffMultisets(baseMulti, pMulti);
    alert('Plan "' + planName + '" no longer matches the deck\'s 75:\n  ' +
          describeDiff(diff) +
          '\nEdit the base deck back to match (or delete this plan) to use it again.');
    return false;
  }

  const unknown = [];
  function materialize(pileNameLists) {
    return pileNameLists.map(pileNames => {
      const pile = [];
      for (const name of pileNames) {
        const card = STATE.byName.get(name);
        if (!card) {
          const fallback = STATE.cards.find(c => c.canonical === canonicalName(name));
          if (fallback) pile.push({ uid: newUid(), cardId: fallback.id });
          else unknown.push(name);
          continue;
        }
        pile.push({ uid: newUid(), cardId: card.id });
      }
      return pile;
    }).filter(p => p.length > 0);
  }
  STATE.zones.main.piles = materialize(plan.zones.main || []);
  STATE.zones.side.piles = materialize(plan.zones.side || []);
  // maybeboard is untouched — it belongs to the base deck.
  STATE.selection.clear();
  STATE.loadedPlanName = planName;
  STATE.basePlanZones = {
    main: payload.zones.main || [],
    side: payload.zones.side || [],
  };
  renderAll();
  resetHistory();
  markDeckClean();
  updateSaveButtons();
  if (unknown.length > 0) reportUnknown(unknown);
  return true;
}

// Without mutating storage: for the deck named `deckName`, figure out which
// of its existing plans would become stale if we saved STATE.zones's
// main+side right now. Returns [{ planName, diff }]. Empty array if none.
function planStalenessPreview(deckName) {
  const payload = readDeckPayload(deckName);
  if (!payload || !Array.isArray(payload.plans)) return [];
  const newBase = canonicalMultiset(zoneNamesByPile('main'), zoneNamesByPile('side'));
  const out = [];
  for (const plan of payload.plans) {
    const pMulti = canonicalMultiset((plan.zones || {}).main || [], (plan.zones || {}).side || []);
    const diff = diffMultisets(newBase, pMulti);
    if (!diffIsEmpty(diff)) out.push({ planName: plan.name, diff });
  }
  return out;
}

function showStalePlansConfirm(stalePlans) {
  return new Promise((resolve) => {
    const modal = document.getElementById('stale-plans-modal');
    const list = document.getElementById('stale-plans-list');
    list.innerHTML = '';
    for (const { planName, diff } of stalePlans) {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.className = 'stale-plan-name';
      nm.textContent = planName;
      const d = document.createElement('span');
      d.className = 'stale-plan-diff';
      d.textContent = describeDiff(diff);
      li.appendChild(nm);
      li.appendChild(d);
      list.appendChild(li);
    }
    modal.classList.remove('hidden');
    function cleanup() {
      modal.classList.add('hidden');
      document.getElementById('stale-plans-ok').removeEventListener('click', onOk);
      document.getElementById('stale-plans-cancel').removeEventListener('click', onCancel);
      modal.querySelector('.modal-backdrop').removeEventListener('click', onCancel);
    }
    function onOk()     { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    document.getElementById('stale-plans-ok').addEventListener('click', onOk);
    document.getElementById('stale-plans-cancel').addEventListener('click', onCancel);
    modal.querySelector('.modal-backdrop').addEventListener('click', onCancel);
  });
}

// Modal that prompts for a plan name. Returns the entered name (trimmed) or
// null if cancelled.
function showPlanNamePrompt(defaultName) {
  return new Promise((resolve) => {
    const modal = document.getElementById('plan-name-modal');
    const input = document.getElementById('plan-name-input');
    input.value = defaultName || '';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
    function cleanup() {
      modal.classList.add('hidden');
      document.getElementById('plan-name-ok').removeEventListener('click', onOk);
      document.getElementById('plan-name-cancel').removeEventListener('click', onCancel);
      modal.querySelector('.modal-backdrop').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }
    function onOk() {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      cleanup(); resolve(v);
    }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); onOk(); }
      if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
    }
    document.getElementById('plan-name-ok').addEventListener('click', onOk);
    document.getElementById('plan-name-cancel').addEventListener('click', onCancel);
    modal.querySelector('.modal-backdrop').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

function exitPlanMode() {
  // Return the editor to the base deck. Used by the × button on the plan
  // banner, and as a precondition for import/new-deck flows when a plan is
  // active (avoids silently blowing away the plan's context).
  if (!STATE.loadedPlanName || !STATE.loadedDeckName) return false;
  const name = STATE.loadedDeckName;
  const ok = loadDeckFromStorage(name);
  if (!ok) {
    // Base deck vanished out from under us — clear plan state anyway so the
    // UI isn't stuck.
    STATE.loadedPlanName = null;
    STATE.basePlanZones = null;
    renderAll();
    updateSaveButtons();
  }
  return true;
}

// Diff of the current main+side zones against the base deck's main+side,
// when a plan is active. Returns null if no plan is active. Used both by the
// live indicator and by the save-active-plan validation.
function currentPlanDiff() {
  if (!STATE.basePlanZones) return null;
  const base = canonicalMultiset(STATE.basePlanZones.main, STATE.basePlanZones.side);
  const cur = canonicalMultiset(zoneNamesByPile('main'), zoneNamesByPile('side'));
  return diffMultisets(base, cur);
}

function saveActivePlan() {
  if (!STATE.loadedDeckName || !STATE.loadedPlanName) {
    throw new Error('No active plan to save.');
  }
  const payload = readDeckPayload(STATE.loadedDeckName);
  if (!payload || !Array.isArray(payload.plans)) {
    throw new Error('Base deck "' + STATE.loadedDeckName + '" not found.');
  }
  const plan = payload.plans.find(p => p.name === STATE.loadedPlanName);
  if (!plan) throw new Error('Plan "' + STATE.loadedPlanName + '" not found.');
  const curMain = zoneNamesByPile('main');
  const curSide = zoneNamesByPile('side');
  const baseMulti = canonicalMultiset(payload.zones.main || [], payload.zones.side || []);
  const curMulti = canonicalMultiset(curMain, curSide);
  const diff = diffMultisets(baseMulti, curMulti);
  if (!diffIsEmpty(diff)) {
    throw new Error("Plan doesn't match the deck's 75: " + describeDiff(diff));
  }
  plan.zones = { main: curMain, side: curSide };
  plan.savedAt = new Date().toISOString();
  plan.stale = false;
  // Refresh basePlanZones from the payload so the live indicator stays
  // accurate (the base didn't change, but it's cheap to re-cache).
  STATE.basePlanZones = {
    main: payload.zones.main || [],
    side: payload.zones.side || [],
  };
  writeDeckPayload(STATE.loadedDeckName, payload);
  markDeckClean();
}

function deckIsEmpty() {
  return Object.keys(STATE.zones).every(z => totalCount(z) === 0);
}

// Serialize zone state to a stable string for dirty-checking. Uses card names
// in pile order (same representation as saveDeckToStorage) so uid differences
// don't create false positives.
function snapshotDeck() {
  const zones = {};
  for (const z of ['main', 'sanctum', 'side', 'maybe']) {
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
  if (STATE.loadedPlanName) {
    saveBtn.textContent = 'Save plan';
    saveAsBtn.classList.add('hidden');
    document.title = STATE.loadedDeckName + ' · ' + STATE.loadedPlanName + ' — Revolution Deckbuilder';
  } else if (STATE.loadedDeckName) {
    saveBtn.textContent = 'Save deck';
    saveAsBtn.classList.remove('hidden');
    document.title = STATE.loadedDeckName + ' — Revolution Deckbuilder';
  } else {
    saveBtn.textContent = 'Save deck';
    saveAsBtn.classList.add('hidden');
    document.title = 'Revolution Deckbuilder';
  }
  updatePlanBanner();
}

function updatePlanBanner() {
  // Drives the centered deck/plan title bar sitting above the pile-title.
  //   no deck loaded      → bar hidden
  //   deck loaded         → "BG Midrange"
  //   plan active         → "BG Midrange · vs Jeskai ✓"  (✗ on mismatch)
  // The ✓/✗ pill carries the full per-card diff in its tooltip; the exit
  // × only shows in plan mode. The body.plan-active class drives the
  // maybe-zone dim and any other plan-mode styling.
  document.body.classList.toggle('plan-active', !!STATE.loadedPlanName);
  const bar = document.getElementById('deck-title-bar');
  if (!bar) return;
  const hasDeck = !!STATE.loadedDeckName;
  const hasPlan = !!STATE.loadedPlanName;
  if (!hasDeck && !hasPlan) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('deck-title-name').textContent = STATE.loadedDeckName || '';
  const sep = document.getElementById('plan-title-sep');
  const planNameEl = document.getElementById('plan-title-name');
  const statusEl = document.getElementById('plan-status');
  const exitEl = document.getElementById('plan-exit');
  if (hasPlan) {
    sep.classList.remove('hidden');
    planNameEl.classList.remove('hidden');
    planNameEl.textContent = STATE.loadedPlanName;
    statusEl.classList.remove('hidden');
    exitEl.classList.remove('hidden');
    const diff = currentPlanDiff();
    if (!diff || diffIsEmpty(diff)) {
      statusEl.textContent = '✓';
      statusEl.classList.remove('mismatch');
      statusEl.classList.add('match');
      statusEl.dataset.title = '75 matches the base deck';
    } else {
      statusEl.textContent = '✗';
      statusEl.classList.remove('match');
      statusEl.classList.add('mismatch');
      statusEl.dataset.title = describeDiff(diff);
    }
  } else {
    sep.classList.add('hidden');
    planNameEl.classList.add('hidden');
    planNameEl.textContent = '';
    statusEl.classList.add('hidden');
    exitEl.classList.add('hidden');
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
  // Folders default to closed (empty set = all collapsed); each user
  // expansion sticks for the lifetime of the page so reopening the Decks
  // dropdown preserves whichever folders they had open. Reload starts
  // fresh with everything closed again.
  const expandedFolders = new Set();
  let saveDialogTags = [];

  function closeAllDropdowns() {
    saveDropdown.classList.add('hidden');
    decksDropdown.classList.add('hidden');
    decksDropdown.style.left = '';
  }

  // Shift the decks panel leftward when a long plan name would push its
  // right edge past the viewport. Keeps the panel anchored to the button's
  // left side in the normal case, but lets it overhang to the left when it
  // has to. Capped so the panel's left edge never crosses the viewport's
  // left margin.
  function positionDecksDropdown() {
    if (decksDropdown.classList.contains('hidden')) return;
    decksDropdown.style.left = '';
    const margin = 8;
    const rect = decksDropdown.getBoundingClientRect();
    const overflowRight = rect.right - (window.innerWidth - margin);
    if (overflowRight <= 0) return;
    const maxShift = Math.max(0, rect.left - margin);
    const shift = Math.min(overflowRight, maxShift);
    decksDropdown.style.left = (-shift) + 'px';
  }

  // Reposition on every size change of the panel — covers row adds/removes
  // from renderDecksList and, importantly, the inline rename input growing
  // as you type (it uses field-sizing: content). Moving the panel via
  // style.left doesn't count as a resize, so this won't loop.
  new ResizeObserver(() => {
    if (!decksDropdown.classList.contains('hidden')) positionDecksDropdown();
  }).observe(decksDropdown);

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

  saveBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (STATE.loadedPlanName) {
      try { saveActivePlan(); }
      catch (e) { alert('Could not save plan: ' + (e && e.message ? e.message : e)); return; }
      updatePlanBanner();
      renderDecksList();
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => { saveBtn.textContent = orig; }, 1200);
      return;
    }
    if (STATE.loadedDeckName) {
      const stale = planStalenessPreview(STATE.loadedDeckName);
      if (stale.length > 0) {
        const ok = await showStalePlansConfirm(stale);
        if (!ok) return;
      }
      try {
        saveDeckToStorage(STATE.loadedDeckName, {
          folder: STATE.loadedDeckFolder,
          tags: STATE.loadedDeckTags,
        });
      } catch (e) {
        alert('Could not save deck: ' + (e && e.message ? e.message : e));
        return;
      }
      renderDecksList();
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
      for (const deck of decks) appendDeckAndPlans(deck, false);
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
    for (const deck of unfiled) appendDeckAndPlans(deck, false);
    const sortedKeys = [...groups.keys()].sort();
    for (const k of sortedKeys) {
      const g = groups.get(k);
      // Folder headers only render when the format filter hasn't emptied
      // them out — a Revolution-only folder shouldn't show a lonely "0"
      // header while browsing in Voyager mode.
      if (g.decks.length === 0) continue;
      renderFolderGroup(g.display, g.decks);
    }
  }

  function appendDeckAndPlans(deck, indent) {
    listEl.appendChild(buildDeckRow(deck, indent));
    if (deck.name !== STATE.loadedDeckName) return;
    // Only the currently-loaded deck's row expands with its plans + the
    // "+ Create plan" affordance. Other deck rows stay compact.
    const plans = listPlans(deck.name);
    for (const plan of plans) listEl.appendChild(buildPlanRow(deck.name, plan));
    listEl.appendChild(buildCreatePlanRow(deck.name));
  }
  function renderFolderGroup(folderName, groupDecks) {
    const displayKey = folderName || '__unfiled__';
    const isCollapsed = !expandedFolders.has(displayKey);
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
      if (expandedFolders.has(displayKey)) expandedFolders.delete(displayKey);
      else expandedFolders.add(displayKey);
      renderDecksList();
    });
    listEl.appendChild(header);
    if (isCollapsed) return;
    for (const deck of groupDecks) appendDeckAndPlans(deck, true);
  }

  function buildDeckRow(deck, indent) {
    const row = document.createElement('div');
    row.className = 'saved-deck-row' + (indent ? ' indent' : '');
    if (STATE.loadedDeckName === deck.name) row.classList.add('loaded');

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
        STATE.loadedPlanName = null;
        STATE.basePlanZones = null;
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

  function buildPlanRow(deckName, plan) {
    const row = document.createElement('div');
    row.className = 'saved-plan-row';
    if (plan.stale) row.classList.add('stale');
    if (STATE.loadedDeckName === deckName && STATE.loadedPlanName === plan.name) {
      row.classList.add('active');
    }

    const caret = document.createElement('span');
    caret.className = 'plan-caret';
    caret.innerHTML = '&#x21B3;';
    row.appendChild(caret);

    const nameEl = document.createElement('span');
    nameEl.className = 'plan-name';
    nameEl.textContent = plan.name;
    if (plan.stale) nameEl.dataset.title = "Plan no longer matches the deck's 75 — edit the deck back or delete the plan.";
    row.appendChild(nameEl);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'deck-action';
    renameBtn.dataset.title = 'Rename plan';
    renameBtn.innerHTML = '&#x270E;';
    renameBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const v = await showPlanNamePrompt(plan.name);
      if (!v || v === plan.name) return;
      if (!renamePlan(deckName, plan.name, v)) {
        alert('A plan named "' + v + '" already exists for this deck.');
        return;
      }
      updateSaveButtons();
      renderDecksList();
    });
    row.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'deck-action deck-delete';
    delBtn.dataset.title = 'Delete plan';
    delBtn.innerHTML = '&#x1f5d1;';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete plan “' + plan.name + '”?')) return;
      const wasActive = (STATE.loadedPlanName === plan.name && STATE.loadedDeckName === deckName);
      deletePlan(deckName, plan.name);
      if (wasActive) exitPlanMode();
      renderDecksList();
    });
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      if (plan.stale) {
        // loadPlanFromStorage surfaces its own alert with the diff.
        loadPlanFromStorage(deckName, plan.name);
        return;
      }
      if (deckIsDirty() && !confirm('Discard unsaved changes and switch to plan “' + plan.name + '”?')) return;
      const ok = loadPlanFromStorage(deckName, plan.name);
      if (!ok) return;
      closeAllDropdowns();
    });

    return row;
  }

  function buildCreatePlanRow(deckName) {
    const row = document.createElement('div');
    row.className = 'saved-plan-row create-plan-row';
    const have75 = totalCount('main') + totalCount('side') > 0;
    const dirty = deckIsDirty();
    const planActive = !!STATE.loadedPlanName;
    const disabled = !have75 || dirty || planActive;
    if (disabled) row.classList.add('disabled');

    const plus = document.createElement('span');
    plus.className = 'plan-caret';
    plus.textContent = '+';
    row.appendChild(plus);

    const label = document.createElement('span');
    label.className = 'create-plan-label';
    if (!have75) { label.textContent = 'Create plan (add cards)'; row.title = 'Main or sideboard must have cards before you can create a plan'; }
    else if (dirty) { label.textContent = 'Create plan (save first)'; row.title = 'Save the deck before creating a plan'; }
    else if (planActive) { label.textContent = 'Create plan (exit plan)'; row.title = 'Exit the current plan before creating a new one'; }
    else label.textContent = 'Create plan';
    row.appendChild(label);

    if (!disabled) {
      row.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const name = await showPlanNamePrompt('');
        if (!name) return;
        try { createPlan(deckName, name); }
        catch (e) { alert(e && e.message ? e.message : e); return; }
        loadPlanFromStorage(deckName, name);
        renderDecksList();
      });
    }
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
      decksDropdown.classList.remove('hidden');
      positionDecksDropdown();
      setTimeout(() => filterInput.focus(), 0);
    } else {
      closeAllDropdowns();
    }
  });

  window.addEventListener('resize', () => {
    if (!decksDropdown.classList.contains('hidden')) positionDecksDropdown();
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

function wirePlanBanner() {
  const btn = document.getElementById('plan-exit');
  if (!btn) return;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (deckIsDirty() && !confirm('Discard unsaved plan changes?')) return;
    exitPlanMode();
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

// Share button: encode the current deck (main + side, no maybeboard) into
// a compact base64url payload and put a "<origin><path>#d=<payload>" URL
// on the clipboard. The encoder is Revolution-only — Voyager decks fall
// out cleanly with a one-shot warning. See scripts/deck_url.js for the
// stream layout.
function wireShare() {
  const btn = document.getElementById('btn-share');
  btn.addEventListener('click', async () => {
    if (currentDataset() !== 'revolution') {
      alert('Share URL is only available for Revolution decks.');
      return;
    }
    const original = btn.textContent;
    try {
      const byName = new Map();
      for (const z of ['main', 'side']) {
        for (const { count, card } of aggregateZone(z)) {
          if (!byName.has(card.name)) byName.set(card.name, { name: card.name, main: 0, side: 0 });
          byName.get(card.name)[z === 'main' ? 'main' : 'side'] += count;
        }
      }
      const result = await window.DeckUrl.encode(Array.from(byName.values()));
      if (result.unresolved && result.unresolved.length) {
        console.warn('share: unresolved cards (skipped):', result.unresolved);
      }
      const url = location.origin + location.pathname + '#d=' + result.b64;
      await navigator.clipboard.writeText(url);
      btn.textContent = 'URL copied ✓';
    } catch (e) {
      console.error(e);
      btn.textContent = 'Copy failed';
      alert('Could not copy to clipboard: ' + (e && e.message ? e.message : e));
    }
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

// If the page was loaded with `#d=<payload>` in the URL, decode it and
// import the deck. The fragment is stripped after import so a refresh
// doesn't re-clobber the imported state. Errors surface as alerts; the
// existing zones are left untouched on failure.
async function loadDeckFromUrlFragment() {
  const hash = location.hash || '';
  if (!hash.startsWith('#d=')) return;
  const payload = hash.slice(3);
  if (!payload) return;
  const clearHash = () =>
    history.replaceState(null, '', location.pathname + location.search);

  // The encoder is keyed against Revolution's cards.json; a Voyager session
  // can't resolve any of the names. Offer to switch.
  if (currentDataset() !== 'revolution') {
    const ok = confirm(
      'This share URL is a Revolution deck. Switch to Revolution to load it?');
    if (!ok) { clearHash(); return; }
    try {
      await switchDataset('revolution');
    } catch (e) {
      alert('Could not switch to Revolution: ' + (e && e.message ? e.message : e));
      clearHash();
      return;
    }
    STATE.format = 'standard';
    savePrefs();
    syncFormatUI();
    renderAll();
  }

  // Don't silently clobber existing work. (Ctrl+Z would still recover after
  // import, but a refresh on top of unsaved edits should ask first.)
  if (!deckIsEmpty()) {
    const ok = confirm('Replace the current deck with the one in this URL?');
    if (!ok) { clearHash(); return; }
  }

  try {
    const decoded = await window.DeckUrl.decode(payload);
    const lines = [];
    for (const [name, c] of Object.entries(decoded.cards)) {
      if (c.main) lines.push(`${c.main} ${name}`);
    }
    for (const b of ['Plains','Island','Swamp','Mountain','Forest']) {
      const v = decoded.basics[b];
      if (v && v[0]) lines.push(`${v[0]} ${b}`);
    }
    const sideLines = [];
    for (const [name, c] of Object.entries(decoded.cards)) {
      if (c.side) sideLines.push(`${c.side} ${name}`);
    }
    for (const b of ['Plains','Island','Swamp','Mountain','Forest']) {
      const v = decoded.basics[b];
      if (v && v[1]) sideLines.push(`${v[1]} ${b}`);
    }
    const text = lines.join('\n') + (sideLines.length ? '\n\n' + sideLines.join('\n') : '') + '\n';
    importDeck(text);
  } catch (e) {
    console.error('failed to load deck from URL:', e);
    alert('Could not load deck from URL: ' + (e && e.message ? e.message : e));
  } finally {
    clearHash();
  }
}

// Build the plain decklist text used by Export to clipboard:
//   "<count> <name>" lines, with a blank line separating zones.
// We write main, then side. The maybeboard is either folded into the
// sideboard or left out entirely — never its own section. No header line —
// the imported title line, if any, isn't tracked in state.
// `maybeMode` is 'merge' | 'omit'. 'merge' folds the maybeboard into the
// sideboard section; 'omit' drops it.
function buildTxtExport(maybeMode) {
  const mode = maybeMode || 'omit';
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
  return sections.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tagging tool (window.TAG_MODE === true)
//
// The tagger reuses the deckbuilder's card index, search input, format
// dropdown, and piles pane. What it swaps in is:
//   - a "Tags" sidebar (#tag-sections) that replaces the zone sidebar
//   - 2 tile buttons (add-tag + repeat-last-tag) per search result
//   - a floating popover (#tag-popover) for tag entry with autocomplete
//   - a focused-tag panel (renderTagMemberPanel) when a tag section is clicked
//   - /api/tags POST writes whenever tags change (no-op when offline)
// Tag data is loaded in init() via loadTags() in every mode, so is:<tag>
// searches work in the deckbuilder too — the tagger just writes the file.
// ---------------------------------------------------------------------------

function initTagMode() {
  document.body.classList.add('tag-mode');
  // Tagger always runs in search-panel mode. The pile pane shows search
  // results by default; clicking a tag section swaps it to that tag's
  // card list.
  STATE.searchPanel = true;
  applySearchPanelMode();
  // applySearchPanelMode left focus on the synthetic 'search' zone; the
  // tagger builds its own sidebar and starts there.
  ensureTagPopover();
  wireTagPopover();
  wireTagSearchTab();
  renderTagSidebar();
  renderTagSaveStatus();
  // Focus the search input so the user can start typing immediately.
  const input = document.getElementById('search');
  if (input) input.focus();
  // Dataset swaps (Revolution <-> Voyager) rebuild the tag sidebar so it
  // reflects the dataset's own tag map. Hook into the existing format
  // dropdown by watching the format button's label text change — simpler
  // than reaching into switchDataset and less invasive than a state
  // observer.
  const formatBtn = document.getElementById('format-btn');
  if (formatBtn) {
    const mo = new MutationObserver(() => {
      STATE.focusedTag = null;
      setFocusedZone('search');
      renderTagSidebar();
    });
    mo.observe(formatBtn, { childList: true, characterData: true, subtree: true });
  }
}

// Wire the sidebar's "Search" tab (static element in tags.html) and the
// document-level Escape handler that returns to the search pane from a
// focused tag view. Both are tag-mode only.
function wireTagSearchTab() {
  const tab = document.getElementById('tag-search-tab');
  if (tab) {
    tab.addEventListener('click', () => {
      STATE.focusedTag = null;
      setFocusedZone('search');
      renderTagSidebar();
    });
  }
  // Click anywhere on the "Tags" header (empty space, the save-status
  // badge, the title) to toggle into the all-tags view. The button itself
  // only covers its text, so binding on the parent makes the whole strip
  // a hit target.
  const allTagsBtn = document.getElementById('btn-all-tags');
  const sidebarHeader = document.querySelector('.tag-sidebar-header');
  const toggleAllTags = () => {
    if (STATE.focusedZone === 'tag-list') {
      STATE.focusedTag = null;
      setFocusedZone('search');
    } else {
      STATE.focusedTag = null;
      setFocusedZone('tag-list');
    }
    renderTagSidebar();
  };
  if (sidebarHeader) {
    sidebarHeader.addEventListener('click', toggleAllTags);
    sidebarHeader.style.cursor = 'pointer';
  } else if (allTagsBtn) {
    allTagsBtn.addEventListener('click', toggleAllTags);
  }
  document.addEventListener('keydown', (ev) => {
    if (!STATE.tagMode) return;
    if (ev.key !== 'Escape') return;
    // Let the popover's own Escape handler close it first.
    const pop = document.getElementById('tag-popover');
    if (pop && !pop.classList.contains('hidden')) return;
    if (!STATE.focusedTag && STATE.focusedZone !== 'tag-list') return;
    ev.preventDefault();
    STATE.focusedTag = null;
    setFocusedZone('search');
    renderTagSidebar();
  });
}

function renderTagSidebar() {
  const host = document.getElementById('tag-sections');
  if (!host) return;
  host.innerHTML = '';
  const allTagsBtn = document.getElementById('btn-all-tags');
  if (allTagsBtn) allTagsBtn.classList.toggle('active', STATE.focusedZone === 'tag-list');
  const ds = currentDataset();
  const slot = STATE.tags[ds];
  if (!slot) return;

  // Per-tag sections in MRU order — the top section is the most-recently
  // acted-on tag, matching the spec. No prepended "all/card pool" entry:
  // clicking a focused section a second time unfocuses it (falls back to
  // the search results), and typing in the search box already auto-flips
  // focus back to 'search' via wireSearch's input handler. Land-manabase
  // tags are filtered out — there are too many of them (every WUBRG
  // subset × land), and `manabase:<colors>` is the intended UI for them.
  for (const tag of slot.order) {
    if (isLandManabaseTag(tag)) continue;
    const low = tag.toLowerCase();
    let count = 0;
    for (const canon of Object.keys(slot.cards)) {
      if (slot.cards[canon].some(t => t.toLowerCase() === low)) count++;
    }
    const aliases = aliasesForTag(tag, ds);
    const sec = document.createElement('section');
    sec.className = 'zone tag-zone'
                  + (STATE.focusedTag && STATE.focusedTag.toLowerCase() === low ? ' focused' : '');
    sec.dataset.tag = tag;
    sec.dataset.title = aliases.length
      ? `${tag} — also: ${aliases.join(', ')}`
      : `${tag}`;
    sec.innerHTML = `
      <header>
        <span class="zone-title">${escapeHtml(tag)}</span>
        <button type="button" class="tag-zone-edit" data-title="Manage aliases for this tag">✎</button>
        <span class="zone-count">${count}</span>
      </header>
    `;
    const editBtn = sec.querySelector('.tag-zone-edit');
    if (editBtn) {
      // Stop the click propagating into the section's focus toggle. mousedown
      // is also stopped so the section's drag affordance doesn't try to
      // start a drag from the button.
      editBtn.addEventListener('mousedown', (ev) => ev.stopPropagation());
      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openAliasEditorPopover(editBtn, tag);
      });
    }
    sec.addEventListener('click', (ev) => {
      // Shift-click on the row also opens the editor (power-user shortcut),
      // but the visible pencil button is now the discoverable affordance.
      if (ev.shiftKey) {
        ev.preventDefault();
        openAliasEditorPopover(editBtn || sec, tag);
        return;
      }
      // Second click on the already-focused section returns to the card
      // pool (search view) — the tag list should never need a pseudo-entry
      // above the most-recent-tag section to navigate back.
      if (STATE.focusedTag && STATE.focusedTag.toLowerCase() === tag.toLowerCase()) {
        STATE.focusedTag = null;
        setFocusedZone('search');
      } else {
        STATE.focusedTag = tag;
        setFocusedZone('tag');
      }
      renderTagSidebar();
    });
    sec.addEventListener('dragover', (ev) => {
      if (!STATE.dragging) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      sec.classList.add('drag-over');
    });
    sec.addEventListener('dragleave', (ev) => {
      if (!sec.contains(ev.relatedTarget)) sec.classList.remove('drag-over');
    });
    sec.addEventListener('drop', (ev) => {
      ev.preventDefault();
      sec.classList.remove('drag-over');
      const canonicals = canonicalsFromDrag(ev);
      endDragGhost();
      if (!canonicals.length) return;
      addTagToCards(tag, canonicals);
      renderTagSidebar();
      if (STATE.focusedTag) renderPiles();
    });
    host.appendChild(sec);
  }

  // Refresh the datalist that the popover's autocomplete reads from.
  refreshTagDatalist();
}

function renderTagSaveStatus() {
  const el = document.getElementById('tag-save-status');
  if (!el) return;
  const map = {
    idle:    '',
    saving:  'saving…',
    saved:   'saved',
    error:   'save failed',
    offline: 'offline (tags not persisted)',
  };
  el.textContent = map[STATE.tagSaveState] || '';
  el.className = 'tag-save-status tag-save-' + STATE.tagSaveState;
}

// Given a drop event from any source in tag mode, return the list of
// canonical card names involved. Handles:
//   - search-tile drags (STATE.dragging.fromSearch + cardIds)
//   - tag-panel drags (STATE.dragging.fromTag + canonicals)
function canonicalsFromDrag(ev) {
  if (STATE.dragging && STATE.dragging.fromSearch) {
    return (STATE.dragging.cardIds || [])
      .map(id => STATE.byId.get(id)?.canonical)
      .filter(Boolean);
  }
  if (STATE.dragging && STATE.dragging.fromTag) {
    return (STATE.dragging.canonicals || []).slice();
  }
  // Fallback: a plain text payload containing the canonical (used by the
  // preview-image drag for readability; not a primary path).
  const txt = ev.dataTransfer && ev.dataTransfer.getData('text/canonical');
  return txt ? [txt] : [];
}

// Render the piles pane as the member-cards view for STATE.focusedTag.
// Reuses makeSearchSlot for visual parity with the search grid — each
// card is one printing picked by the newest-printing-first default.
function renderTagMemberPanel() {
  const tag = STATE.focusedTag;
  const ds = currentDataset();
  const allCanonicals = tag ? cardsForTag(tag, ds) : [];
  // Respect the current format selector — clicking a tag while Standard
  // is active should only surface standard-legal cards; Eternal widens
  // to every rev card; Voyager passes through (isLegal is always true).
  const canonicals = allCanonicals.filter(canon => {
    const printings = STATE.byCanonical.get(canon) || [];
    if (printings.length === 0) return false;
    return isLegal(printings[printings.length - 1]);
  });
  document.getElementById('pile-title').textContent =
    tag ? `${tag} (${canonicals.length})` : 'Tag';
  const container = document.getElementById('piles');
  container.innerHTML = '';
  container.classList.add('search-mode');

  // Sort members by name for stability; users who want a different
  // ordering can filter / sort in the search input instead (the pool
  // remains accessible via the "Card pool" sidebar entry).
  canonicals.sort((a, b) => a.localeCompare(b));

  for (const canon of canonicals) {
    const printings = STATE.byCanonical.get(canon) || [];
    if (printings.length === 0) continue;
    const picked = printings[printings.length - 1];
    const item = {
      canonical: canon,
      printings,
      pickedIdx: printings.length - 1,
      flipped: false,
    };
    const wrapper = document.createElement('div');
    wrapper.className = 'pile-wrapper';
    const pile = document.createElement('div');
    pile.className = 'pile';
    pile.style.height = CARD_HEIGHT + 'px';
    const slot = makeSearchSlot(picked, item);
    pile.appendChild(slot);
    wrapper.appendChild(pile);
    container.appendChild(wrapper);
  }
}

// Render the piles pane as a flat alphabetical list of every known tag for
// the current dataset. Triggered by clicking the "Tags" header above the
// sidebar. Each row click focuses that tag (same behavior as clicking a
// section in the sidebar).
function renderAllTagsPanel() {
  const ds = currentDataset();
  const slot = STATE.tags[ds];
  const order = slot ? slot.order.slice() : [];
  // Tag-card counts.
  const counts = new Map();
  if (slot) {
    for (const canon of Object.keys(slot.cards)) {
      for (const t of slot.cards[canon]) {
        const low = t.toLowerCase();
        counts.set(low, (counts.get(low) || 0) + 1);
      }
    }
  }
  order.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  document.getElementById('pile-title').textContent = `All tags (${order.length})`;
  const container = document.getElementById('piles');
  container.innerHTML = '';
  container.classList.remove('search-mode');
  const list = document.createElement('div');
  list.className = 'tag-list-view';
  for (const tag of order) {
    const aliases = aliasesForTag(tag, ds);
    const row = document.createElement('div');
    row.className = 'tag-list-row';
    row.dataset.tag = tag;
    const name = document.createElement('span');
    name.className = 'tag-list-name';
    name.textContent = tag;
    const count = document.createElement('span');
    count.className = 'tag-list-count';
    count.textContent = counts.get(tag.toLowerCase()) || 0;
    row.appendChild(name);
    if (aliases.length) {
      const ali = document.createElement('span');
      ali.className = 'tag-list-aliases';
      ali.textContent = aliases.join(', ');
      row.appendChild(ali);
    }
    row.appendChild(count);
    row.addEventListener('click', () => {
      STATE.focusedTag = tag;
      setFocusedZone('tag');
      renderTagSidebar();
    });
    list.appendChild(row);
  }
  container.appendChild(list);
}

// Floating popover for editing a tag's aliases. Opens from either the
// pencil button on a row in the all-tags panel or shift-click on a sidebar
// tag section. Mutations go through addTagAlias / removeTagAlias so the
// data model stays consistent (cards migrated, order pruned, save fired).
function ensureAliasEditor() {
  if (document.getElementById('alias-editor')) return;
  const pop = document.createElement('div');
  pop.id = 'alias-editor';
  pop.className = 'tag-popover alias-editor hidden';
  pop.innerHTML = `
    <div class="alias-editor-title"></div>
    <div class="alias-editor-chips tag-chip-editor"></div>
    <div class="alias-editor-hint">Type an alias, press <kbd>Enter</kbd>. <kbd>×</kbd> on a chip removes it.</div>
  `;
  document.body.appendChild(pop);
  // Click outside closes the editor.
  document.addEventListener('mousedown', (ev) => {
    const el = document.getElementById('alias-editor');
    if (!el || el.classList.contains('hidden')) return;
    if (el.contains(ev.target)) return;
    closeAliasEditor();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const el = document.getElementById('alias-editor');
    if (!el || el.classList.contains('hidden')) return;
    closeAliasEditor();
  });
}

let _aliasEditorTag = null;

function openAliasEditorPopover(anchorEl, tag) {
  ensureAliasEditor();
  const pop = document.getElementById('alias-editor');
  const titleEl = pop.querySelector('.alias-editor-title');
  const chipsEl = pop.querySelector('.alias-editor-chips');
  if (!pop || !titleEl || !chipsEl) return;
  _aliasEditorTag = tag;
  titleEl.textContent = `Aliases for "${tag}"`;
  renderAliasEditorChips();
  pop.classList.remove('hidden');
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    const popW = 260;
    let left = r.right + 8;
    if (left + popW > window.innerWidth - 8) left = r.left - popW - 8;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, r.top) + 'px';
  } else {
    pop.style.left = (window.innerWidth / 2 - 130) + 'px';
    pop.style.top  = (window.innerHeight / 3) + 'px';
  }
  setTimeout(() => {
    const inp = pop.querySelector('input');
    if (inp) inp.focus();
  }, 0);
}

function closeAliasEditor() {
  const pop = document.getElementById('alias-editor');
  if (!pop) return;
  pop.classList.add('hidden');
  _aliasEditorTag = null;
}

// Briefly surface that a typed alias was rewritten to its canonical. Used
// only by addTagToCards when the user typed an alias — nothing if they
// typed the canonical directly. Re-uses a single floating element so
// rapid-fire applies don't stack.
let _aliasToastTimer = null;
function showAliasToast(typed, applied) {
  let el = document.getElementById('alias-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'alias-toast';
    el.className = 'alias-toast hidden';
    document.body.appendChild(el);
  }
  el.textContent = `applied "${applied}" (alias of "${typed}")`;
  el.classList.remove('hidden');
  if (_aliasToastTimer) clearTimeout(_aliasToastTimer);
  _aliasToastTimer = setTimeout(() => {
    el.classList.add('hidden');
    _aliasToastTimer = null;
  }, 2200);
}

function renderAliasEditorChips() {
  const pop = document.getElementById('alias-editor');
  if (!pop) return;
  const chipsEl = pop.querySelector('.alias-editor-chips');
  if (!chipsEl || !_aliasEditorTag) return;
  chipsEl.innerHTML = '';
  const aliases = aliasesForTag(_aliasEditorTag);
  for (const a of aliases) {
    const chip = document.createElement('span');
    chip.className = 'deck-tag-chip';
    chip.textContent = a;
    const x = document.createElement('span');
    x.className = 'chip-x';
    x.innerHTML = '&times;';
    x.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeTagAlias(a);
      renderAliasEditorChips();
      renderTagSidebar();
      // The all-tags pane shows aliases inline too — re-render if visible.
      if (STATE.focusedZone === 'tag-list') renderPiles();
      const inp = chipsEl.querySelector('input');
      if (inp) inp.focus();
    });
    chip.appendChild(x);
    chipsEl.appendChild(chip);
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = aliases.length ? '' : 'add alias…';
  input.setAttribute('list', 'tag-datalist');
  input.addEventListener('input', () => refreshTagDatalist(input.value));
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault();
      const val = input.value.trim().replace(/,$/, '');
      if (!val || !_aliasEditorTag) return;
      const ok = addTagAlias(val, _aliasEditorTag);
      input.value = '';
      if (ok) {
        renderAliasEditorChips();
        renderTagSidebar();
        if (STATE.focusedZone === 'tag-list') renderPiles();
      } else {
        // Visual nudge that the alias was rejected (self-alias / cycle / empty).
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeAliasEditor();
    }
  });
  chipsEl.appendChild(input);
}

// After a tag mutation, replace the chip strip on any visible card tiles
// for the affected canonicals. Surgical so we don't rebuild the search /
// focused-tag panel (which would drop scroll and re-trigger lazy images).
// Safe outside tag mode — no .card-tag-chips exist there, so the query
// returns nothing.
function refreshCardTagChips(canonicals) {
  if (!canonicals || !canonicals.length) return;
  const wanted = new Set(canonicals);
  const slots = document.querySelectorAll('.card-slot[data-card-id]');
  for (const slot of slots) {
    const card = STATE.byId.get(Number(slot.dataset.cardId));
    if (!card || !card.canonical || !wanted.has(card.canonical)) continue;
    const old = slot.querySelector(':scope > .card-tag-chips');
    if (old) old.remove();
    slot.appendChild(makeCardTagChips(card.canonical));
  }
}

function makeCardTagChips(canonical) {
  const ds = currentDataset();
  const tags = tagsForCard(canonical, ds);
  const strip = document.createElement('div');
  strip.className = 'card-tag-chips';
  strip.draggable = false;
  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'card-tag-chip';
    if (STATE.focusedTag && STATE.focusedTag.toLowerCase() === tag.toLowerCase()) {
      chip.classList.add('focused');
    }
    chip.textContent = tag;
    chip.dataset.title = `Remove "${tag}"`;
    chip.draggable = false;
    chip.addEventListener('mousedown', (ev) => ev.stopPropagation());
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      removeTagFromCard(tag, canonical);
      renderTagSidebar();
      renderPiles();
    });
    strip.appendChild(chip);
  }
  return strip;
}

// Build the popover DOM lazily on first use. Lives at body level so it
// can float over the piles pane without clipping.
function ensureTagPopover() {
  if (document.getElementById('tag-popover')) return;
  const pop = document.createElement('div');
  pop.id = 'tag-popover';
  pop.className = 'tag-popover hidden';
  pop.innerHTML = `
    <input id="tag-popover-input" type="text" placeholder="tag…"
           autocomplete="off" spellcheck="false" list="tag-datalist">
    <datalist id="tag-datalist"></datalist>
    <div class="tag-popover-hint"><kbd>Enter</kbd> add · <kbd>Esc</kbd> cancel</div>
  `;
  document.body.appendChild(pop);
}

function refreshTagDatalist(currentInput = '') {
  const dl = document.getElementById('tag-datalist');
  if (!dl) return;
  const ds = currentDataset();
  const slot = STATE.tags[ds];
  const order = (slot?.order || []).slice();
  const aliases = slot?.aliases || {};
  // Once the user has typed a complete canonical, suggestions are noise
  // (they'd just echo the typed value and pull in any aliases pointing at
  // it). Empty the datalist so the browser dropdown collapses.
  const trimmedLow = currentInput.trim().toLowerCase();
  if (trimmedLow && order.some(t => t.toLowerCase() === trimmedLow)) {
    dl.innerHTML = '';
    return;
  }
  // Canonicals first, then each alias (with the canonical as a hint label
  // — datalists render `option[label]` next to the value in modern browsers).
  const parts = order.map(t => `<option value="${escapeHtml(t)}">`);
  for (const k of Object.keys(aliases).sort()) {
    const target = aliases[k];
    parts.push(`<option value="${escapeHtml(k)}" label="→ ${escapeHtml(target)}">`);
  }
  dl.innerHTML = parts.join('');
}

// Popover state — the canonicals the next Enter/submit applies to.
const _tagPopoverState = { canonicals: [], anchorEl: null };

function openTagPopover(anchorEl, canonicals) {
  ensureTagPopover();
  refreshTagDatalist();
  const pop = document.getElementById('tag-popover');
  const input = document.getElementById('tag-popover-input');
  if (!pop || !input) return;
  _tagPopoverState.canonicals = (canonicals || []).slice();
  _tagPopoverState.anchorEl = anchorEl;
  input.value = '';
  pop.classList.remove('hidden');
  // The popover anchors next to the card the user just clicked; leaving the
  // floating hover preview up would cover the input. showPreview also
  // short-circuits while the popover is visible, so new mouseenter events
  // on nearby tiles won't bring it back.
  hidePreview();
  // Anchor to the right edge of the triggering button, falling back to
  // the center of the viewport when no anchor is given (keyboard path).
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    const popW = 220;
    let left = r.right + 8;
    if (left + popW > window.innerWidth - 8) left = r.left - popW - 8;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top  = Math.max(8, r.top) + 'px';
  } else {
    pop.style.left = (window.innerWidth / 2 - 110) + 'px';
    pop.style.top  = (window.innerHeight / 3) + 'px';
  }
  input.focus();
  input.select();
}

function closeTagPopover() {
  const pop = document.getElementById('tag-popover');
  if (!pop) return;
  pop.classList.add('hidden');
  _tagPopoverState.canonicals = [];
  _tagPopoverState.anchorEl = null;
}

function wireTagPopover() {
  const input = document.getElementById('tag-popover-input');
  if (!input) return;
  input.addEventListener('input', () => refreshTagDatalist(input.value));
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) { closeTagPopover(); return; }
      addTagToCards(v, _tagPopoverState.canonicals);
      closeTagPopover();
      renderTagSidebar();
      if (STATE.focusedTag) renderPiles();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeTagPopover();
    }
  });
  // Click-out closes the popover — but the input itself is inside, and
  // autocomplete's datalist popup fires blur/click events we must not
  // treat as outside.
  document.addEventListener('mousedown', (ev) => {
    const pop = document.getElementById('tag-popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(ev.target)) return;
    // Slot-button clicks that open the popover also fire mousedown here;
    // skip those by checking for a .tag-btn target in the path.
    if (ev.target.closest && ev.target.closest('.tag-btn')) return;
    closeTagPopover();
  });
}

// Search-input Enter (which normally adds to main/maybe/side) applies the
// most-recent tag to the highlighted result instead when in tag mode.
// Shift+Enter in tag mode opens the popover. Hooked in initTagMode by
// intercepting at capture so the default handler never runs.
document.addEventListener('keydown', (ev) => {
  if (!STATE.tagMode) return;
  const input = document.getElementById('search');
  if (!input || document.activeElement !== input) return;
  if (ev.key !== 'Enter') return;
  const r = STATE.search.results;
  if (r.length === 0) return;
  const item = r[STATE.search.selectedIdx];
  const picked = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
  const canon = picked.canonical;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.shiftKey || !STATE.lastUsedTag) {
    openTagPopover(input, [canon]);
  } else {
    addTagToCards(STATE.lastUsedTag, [canon]);
    renderTagSidebar();
    if (STATE.focusedTag) renderPiles();
  }
}, /*capture*/ true);
