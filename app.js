
'use strict';

const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';

const REFRESH_URL = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/AllSetsEternal.json';

const VOYAGER_URL = 'https://voyager-mtg.github.io/lists/cards.xml';

const STORAGE_VERSION = 15;
const STORAGE_KEY = `rev-deckbuilder-cards-v${STORAGE_VERSION}`;
const VOYAGER_STORAGE_KEY = `rev-deckbuilder-voyager-v${STORAGE_VERSION}`;

const _datasetSessionCache = { revolution: null, voyager: null };

const PREFS_KEY = 'rev-deckbuilder-prefs-v1';
const SESSION_KEY = 'rev-deckbuilder-session-v1';


const STATE = {
  cards: [],
  byId: new Map(),
  byName: new Map(),
  byCanonical: new Map(),
  uuidMap: {},
  setCodes: new Set(),
  setsByCode: {},
  setOrder: [],

  zones: {
    main:    { piles: [] },
    sanctum: { piles: [] },
    side:    { piles: [] },
    maybe:   { piles: [] },
  },

  focusedZone: 'main',
  searchPanel: false,
  format: 'standard',
  rangeStart: null,
  rangeEnd: null,
  formatLock: null,
  stashedByDataset: { revolution: null, voyager: null },
  listSort: 'type',
  pileSort: 'type',
  pileSortChain: ['type'],
  theme: 'dark',

  search: {
    results: [],
    selectedIdx: 0,
    error: null,
  },

  uidCounter: 1,
  dragging: null,
  dragGhost: null,
  selection: new Set(),
  searchSelection: new Set(),
  loadedDeckName: null,
  loadedDeckFolder: null,
  loadedDeckTags: [],
  deckSnapshot: null,

  loadedPlanName: null,
  basePlanZones: null,

  history: { past: [], future: [], lastSnapshot: null },

  tags: {
    revolution: { cards: {}, order: [], aliases: {} },
    voyager:    { cards: {}, order: [], aliases: {} },
  },
  tagMode: !!(typeof window !== 'undefined' && window.TAG_MODE),
  focusedTag: null,
  lastUsedTag: null,
  tagSaveState: 'idle',
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


const EMPTY_DRAG_IMG = new Image();
EMPTY_DRAG_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
EMPTY_DRAG_IMG.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:-1;';
document.documentElement.appendChild(EMPTY_DRAG_IMG);

function startDragGhost(ev, uids, width, height, offsetX, offsetY) {
  console.log('[drag] startDragGhost called', {
    uids, width, height, offsetX, offsetY,
    clientX: ev.clientX, clientY: ev.clientY,
    hadPriorGhost: !!STATE.dragGhost,
  });
  endDragGhost();
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


(async function init() {
  for (let v = 1; v < STORAGE_VERSION; v++) {
    try { localStorage.removeItem(`rev-deckbuilder-cards-v${v}`); } catch (_) {}
  }

  loadPrefs();

  const startHash = location.hash || '';
  const sessionPayload = (startHash.startsWith('#d=') || startHash.startsWith('#open='))
    ? null : readSessionState();
  if (sessionPayload && (sessionPayload.format === 'standard' || sessionPayload.format === 'eternal'
      || sessionPayload.format === 'range' || sessionPayload.format === 'voyager')) {
    STATE.format = sessionPayload.format;
    STATE.rangeStart = typeof sessionPayload.rangeStart === 'string' ? sessionPayload.rangeStart : null;
    STATE.rangeEnd   = typeof sessionPayload.rangeEnd   === 'string' ? sessionPayload.rangeEnd   : null;
  }

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

  await loadTags();

  wireSearch();
  wireFormatLock();
  syncFormatLockUI();
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
  wireSessionPersistence();
  setFocusedZone('main');
  applySearchPanelMode();
  if (STATE.tagMode) initTagMode();
  markDeckClean();
  renderAll();

  if (sessionPayload) applySessionState(sessionPayload);

  await loadDeckFromUrlFragment();
  await loadSavedDeckFromUrlFragment();

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

function stripNameOnce(name) {
  const paren = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[1]) return { stem: paren[1], variant: paren[2] };
  const under = name.match(/^(.*)_([A-Za-z0-9]+)$/);
  if (under && under[1]) return { stem: under[1], variant: under[2] };
  const word  = name.match(/^(.*\S)\s+(\S+)$/);
  if (word && word[1]) return { stem: word[1], variant: word[2] };
  return null;
}

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
        variant = step.variant;
        continue;
      }
      break;
    }
    c.canonical = cur;
    if (variant) c.variant = variant;
    if (c.pageFace) c.pageFace.canonical = cur;
  }
}

function applyCardData(data) {
  LOCK_CACHE = null;
  const oldById = STATE.byId;
  const newById = new Map();
  const newByName = new Map();
  const newByCanonical = new Map();
  for (const c of data.cards) {
    newById.set(c.id, c);
    newByName.set(c.name, c);
  }
  consolidateCanonicals(data.cards, newByName);
  for (const c of data.cards) {
    let arr = newByCanonical.get(c.canonical);
    if (!arr) { arr = []; newByCanonical.set(c.canonical, arr); }
    arr.push(c);
  }
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
      return b.id - a.id;
    });
  }
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
  STATE.setCodes = new Set(data.allSetCodes || Object.keys(STATE.setsByCode));
  STATE.setOrder = Object.keys(STATE.setsByCode)
    .filter(code => !HIDDEN_FROM_RANGE_PICKER.has(code))
    .sort((a, b) => {
      const da = STATE.setsByCode[a].releasedate || '';
      const db = STATE.setsByCode[b].releasedate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  if (!STATE.setsByCode[STATE.rangeStart]) STATE.rangeStart = STATE.setOrder[0] || null;
  if (!STATE.setsByCode[STATE.rangeEnd])   STATE.rangeEnd   = STATE.setOrder[STATE.setOrder.length - 1] || null;
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
      if (typeof obj.formatLock === 'string' && obj.formatLock) STATE.formatLock = obj.formatLock;
      if (obj.theme === 'light' || obj.theme === 'dark') STATE.theme = obj.theme;
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
      formatLock: STATE.formatLock,
      theme: STATE.theme,
    }));
  } catch (e) {
    console.warn('Could not persist deckbuilder prefs:', e);
  }
}

function applyTheme() {
  if (STATE.theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = STATE.theme === 'light' ? 'Dark mode' : 'Light mode';
}


const EXCLUDED_SETS = new Set(['TK', 'PLANE']);

const HIDDEN_FROM_RANGE_PICKER = new Set(['REV']);

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
      const side = (c.side || '').toLowerCase();
      if (side === 'b' || side === 'back') continue;

      const id = nextId++;
      const rawName = c.name || '';
      const splitIdx = rawName.indexOf(' // ');
      const name = splitIdx >= 0 ? rawName.slice(0, splitIdx) : rawName;
      const splitRelated = splitIdx >= 0 ? rawName.slice(splitIdx + 4) : '';
      const num = c.number != null ? String(c.number) : '';
      const cmcVal = c.manaValue != null ? c.manaValue
                     : (c.convertedManaCost != null ? c.convertedManaCost : 0);
      const imgVersion = (c.identifiers && c.identifiers.multiverseId) || 0;
      const back = backsBySetAndName.get(code + '\u0000' + rawName) || null;
      const legalities = {};
      for (const [fmt, status] of Object.entries(c.legalities || {})) {
        legalities[fmt.toLowerCase()] = String(status || '').toLowerCase();
      }
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
          pageData,
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


function normalizeTypeDash(s) { return s.replace(/–/g, '—'); }

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

function parseCockatriceXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error('failed to parse Voyager cards.xml: ' + (perr.textContent || ''));

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
  const claimedNames = new Set();

  for (const el of cardEls) {
    const side = (el.querySelector('prop > side')?.textContent || '').trim().toLowerCase();
    if (side === 'back') continue;
    const rawName = (el.querySelector(':scope > name')?.textContent || '').trim();
    if (!rawName) continue;

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

    let backData = null;
    let transformBackName = '';
    const transformRel = el.querySelector('related[attach="transform"]');
    if (transformRel) {
      transformBackName = (transformRel.textContent || '').trim();
      if (transformBackName) backData = backsByKey.get(setCode + '|' + transformBackName) || null;
    }

    let uniqueName = frontName;
    let variantLabel = null;
    if (claimedNames.has(uniqueName)) {
      uniqueName = `${frontName}_${setCode}`;
      variantLabel = setCode;
      if (claimedNames.has(uniqueName)) {
        uniqueName = `${frontName}_${setCode}_${num}`;
        variantLabel = `${setCode} ${num}`;
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

async function fetchVoyagerData() {
  const res = await fetch(VOYAGER_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Voyager cards.xml`);
  const xmlText = await res.text();
  return parseCockatriceXml(xmlText);
}

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
          if (lk === tv.toLowerCase()) continue;
          slot.aliases[lk] = tv;
        }
      }
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

function addTagToCards(tag, canonicals, dataset = currentDataset()) {
  const input = String(tag || '').trim();
  if (!input) return null;
  const slot = STATE.tags[dataset];
  if (!slot) return null;
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
  const inputLow = String(tag).toLowerCase();
  const aliased = slot.aliases ? slot.aliases[inputLow] : null;
  const low = aliased ? String(aliased).toLowerCase() : inputLow;
  const arr = slot.cards[canonical];
  if (!arr) return;
  const filtered = arr.filter(t => t.toLowerCase() !== low);
  if (filtered.length === arr.length) return;
  if (filtered.length === 0) delete slot.cards[canonical];
  else slot.cards[canonical] = filtered;
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

function addTagAlias(aliasName, canonical, dataset = currentDataset()) {
  const slot = STATE.tags[dataset];
  if (!slot) return false;
  const aliasLow = String(aliasName || '').trim().toLowerCase();
  const canonInput = String(canonical || '').trim();
  const canonLowInput = canonInput.toLowerCase();
  if (!aliasLow || !canonLowInput || aliasLow === canonLowInput) return false;
  if (!slot.aliases) slot.aliases = {};
  let canonDisplay = canonInput;
  let canonLow = canonLowInput;
  if (slot.aliases[canonLow]) {
    canonDisplay = slot.aliases[canonLow];
    canonLow = canonDisplay.toLowerCase();
    if (canonLow === aliasLow) return false;
  }
  const orderMatchIdx = slot.order.findIndex(t => t.toLowerCase() === canonLow);
  if (orderMatchIdx >= 0) canonDisplay = slot.order[orderMatchIdx];
  let changed = false;
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

function freshZones() {
  return {
    main:    { piles: [] },
    sanctum: { piles: [] },
    side:    { piles: [] },
    maybe:   { piles: [] },
  };
}

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

let sessionSaveTimer = null;

function writeSessionState() {
  sessionSaveTimer = null;
  if (STATE.tagMode) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      format: STATE.format,
      rangeStart: STATE.rangeStart,
      rangeEnd: STATE.rangeEnd,
      formatLock: STATE.formatLock,
      zones: snapshotZonesByName(STATE.zones),
      loadedDeckName: STATE.loadedDeckName,
      loadedDeckFolder: STATE.loadedDeckFolder,
      loadedDeckTags: (STATE.loadedDeckTags || []).slice(),
      loadedPlanName: STATE.loadedPlanName,
      basePlanZones: STATE.basePlanZones,
      deckSnapshot: STATE.deckSnapshot,
      stashedByDataset: STATE.stashedByDataset,
    }));
  } catch (_) {}
}

function scheduleSessionSave() {
  if (sessionSaveTimer != null) return;
  sessionSaveTimer = setTimeout(writeSessionState, 300);
}

function flushSessionSave() {
  if (sessionSaveTimer != null) clearTimeout(sessionSaveTimer);
  writeSessionState();
}

function readSessionState() {
  if (STATE.tagMode) return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || !obj.zones) return null;
    return obj;
  } catch (_) { return null; }
}

function applySessionState(payload) {
  if (datasetForFormat(payload.format) !== currentDataset()) return;
  STATE.zones = rehydrateZonesFromNames(payload.zones);
  STATE.loadedDeckName = typeof payload.loadedDeckName === 'string' ? payload.loadedDeckName : null;
  STATE.loadedDeckFolder = typeof payload.loadedDeckFolder === 'string' ? payload.loadedDeckFolder : null;
  STATE.loadedDeckTags = Array.isArray(payload.loadedDeckTags) ? payload.loadedDeckTags.slice() : [];
  STATE.loadedPlanName = typeof payload.loadedPlanName === 'string' ? payload.loadedPlanName : null;
  STATE.basePlanZones = payload.basePlanZones || null;
  if (STATE.loadedPlanName && (!STATE.loadedDeckName
      || !listPlans(STATE.loadedDeckName).some(p => p.name === STATE.loadedPlanName))) {
    STATE.loadedPlanName = null;
    STATE.basePlanZones = null;
  }
  if (payload.stashedByDataset && typeof payload.stashedByDataset === 'object') {
    STATE.stashedByDataset.revolution = payload.stashedByDataset.revolution || null;
    STATE.stashedByDataset.voyager = payload.stashedByDataset.voyager || null;
  }
  if (typeof payload.deckSnapshot === 'string') STATE.deckSnapshot = payload.deckSnapshot;
  else markDeckClean();
  setFormatLock(typeof payload.formatLock === 'string' ? payload.formatLock : null);
  runSearch(document.getElementById('search').value);
  renderAll();
  resetHistory();
  updateSaveButtons();
}

function wireSessionPersistence() {
  window.addEventListener('pagehide', flushSessionSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSessionSave();
  });
}

async function switchDataset(toDataset) {
  const from = currentDataset();
  if (from === toDataset) return;
  const outgoingStash = {
    zones: snapshotZonesByName(STATE.zones),
    loadedDeckName: STATE.loadedDeckName,
    loadedDeckFolder: STATE.loadedDeckFolder,
    loadedDeckTags: (STATE.loadedDeckTags || []).slice(),
    loadedPlanName: STATE.loadedPlanName,
    basePlanZones: STATE.basePlanZones,
    deckSnapshot: STATE.deckSnapshot,
  };
  const savedZones = STATE.zones;
  STATE.zones = freshZones();
  let data;
  try {
    data = await loadDatasetData(toDataset);
  } catch (e) {
    STATE.zones = savedZones;
    throw e;
  }
  STATE.stashedByDataset[from] = outgoingStash;
  applyCardData(data);
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


function newUid() { return STATE.uidCounter++; }

function canonicalName(name) {
  while (name.includes('_')) {
    const i = name.lastIndexOf('_');
    const tail = name.slice(i + 1);
    if (STATE.setCodes.has(tail) || tail === 'PRO') name = name.slice(0, i);
    else break;
  }
  return name;
}

function zoneNamesByPile(zoneName) {
  return STATE.zones[zoneName].piles.map(pile => pile.map(inst => {
    const c = STATE.byId.get(inst.cardId);
    return c ? c.name : null;
  }).filter(n => n != null));
}

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

function describeDiff(diff) {
  const parts = [];
  for (const r of diff.removed) parts.push('−' + r.count + ' ' + r.name);
  for (const a of diff.added) parts.push('+' + a.count + ' ' + a.name);
  return parts.join(', ');
}

function typeRank(card) {
  return TYPE_ORDER[card.maintype] ?? 99;
}

function cmcBucket(card) {
  if (card.maintype === 'Land') return { key: 'L', label: 'Lands', sortVal: -1 };
  const n = Math.floor(card.cmc || 0);
  return { key: String(n), label: String(n), sortVal: n };
}

let LOCK_CACHE = null;

function getFormatLock() {
  if (STATE.tagMode) return null;
  const text = STATE.formatLock;
  if (!text) return null;
  const ds = currentDataset();
  if (!LOCK_CACHE || LOCK_CACHE.text !== text || LOCK_CACHE.dataset !== ds) {
    LOCK_CACHE = { text, dataset: ds, parsed: parseQuery(text) };
  }
  return LOCK_CACHE.parsed.error ? null : LOCK_CACHE.parsed;
}

function lockMatches(card) {
  const lock = getFormatLock();
  if (!lock) return true;
  return facesMatch(card, lock.predicate);
}

function setFormatLock(text) {
  STATE.formatLock = (typeof text === 'string' && text.trim()) ? text.trim() : null;
  LOCK_CACHE = null;
  savePrefs();
  syncFormatLockUI();
}

function isLegal(card) {
  if (!card) return true;
  const lock = getFormatLock();
  if (lock) {
    if (!facesMatch(card, lock.predicate)) return false;
    if (lock.overridesFormat) return true;
  }
  return isLegalBase(card);
}

function isLegalBase(card) {
  if (!card) return true;
  if (STATE.format === 'voyager') return true;
  const printings = STATE.byCanonical.get(card.canonical) || [card];
  if (STATE.format === 'eternal') {
    return printings.some(p => p.fmt_eternal === 'legal');
  }
  if (STATE.format === 'range') {
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

const FORMAT_LABELS = { standard: 'Standard', eternal: 'Eternal', range: 'Sets', voyager: 'Voyager' };

function datasetForFormat(fmt) { return fmt === 'voyager' ? 'voyager' : 'revolution'; }
function currentDataset() { return datasetForFormat(STATE.format); }

function visibleZoneOrder() {
  return currentDataset() === 'voyager'
    ? ['main', 'sanctum', 'side', 'maybe']
    : ['main', 'side', 'maybe'];
}

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
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.title = currentDataset() === 'voyager'
      ? 'Re-fetch card data from the upstream Voyager list'
      : 'Re-fetch card data from the upstream Revolution repo';
  }
  document.body.classList.toggle('voyager-mode', currentDataset() === 'voyager');
  const favLink = document.querySelector('link[rel="icon"][type="image/webp"]');
  if (favLink) {
    favLink.href = currentDataset() === 'voyager' ? 'favicon-silver.webp' : 'favicon.webp';
  }
}

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

const SORT_SET_EXCLUDE = new Set(['PLANE', 'REV']);
function pickSetForSort(card) {
  if (!SORT_SET_EXCLUDE.has(card.set)) return card.set;
  const printings = STATE.byCanonical.get(card.canonical) || [];
  const alt = printings.find(p => !SORT_SET_EXCLUDE.has(p.set));
  return alt ? alt.set : card.set;
}

function colorSortKey(card) {
  const cols = card.colors || '';
  const order = 'WUBRGI';
  if (cols.length === 0) return '9';
  if (cols.length === 1) {
    const idx = order.indexOf(cols);
    return '1' + (idx < 0 ? '9' : String(idx));
  }
  const sorted = [...cols]
    .sort((x, y) => order.indexOf(x) - order.indexOf(y))
    .join('');
  const pad = String(cols.length).padStart(2, '0');
  return '2' + pad + sorted;
}

function imgUrl(card) {
  if (card && card.picUrl) return card.picUrl;
  const base = `${IMG_BASE}/${card.set}/${encodeURIComponent(card.num)}.jpg`;
  return card.imgVersion ? `${base}?v=${card.imgVersion}` : base;
}

const KNOWN_KEYWORDS = [
  'flying', 'trample', 'vigilance', 'haste', 'first strike', 'double strike',
  'flash', 'deathtouch', 'hexproof', 'indestructible', 'lifelink', 'menace',
  'reach', 'defender', 'shroud', 'ward', 'prowess', 'protection',
  'scry', 'fight',
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
  'enchant creature', 'enchant land', 'enchant player', 'enchant permanent',
  'enchant artifact', 'enchant enchantment', 'enchant planeswalker',
  'plainscycling', 'islandcycling', 'swampcycling', 'mountaincycling',
  'forestcycling',
  'spellcharge', 'surface', 'wander', 'traverse', 'invoke', 'reflect',
  'coalesce', 'multitude', 'cybersoul', 'propagate', 'chant',
  'pathbound', 'transcend', 'usurpate', 'heir', 'bisapience', 'liberate',
  'embrace', 'sift',
];

const KEYWORD_BY_FIRST_WORD = (() => {
  const m = new Map();
  for (const kw of KNOWN_KEYWORDS) {
    const first = kw.split(' ')[0];
    const arr = m.get(first) || [];
    arr.push(kw);
    arr.sort((a, b) => b.length - a.length);
    m.set(first, arr);
  }
  return m;
})();

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
    const parts = line.split(/\s*,\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      const firstWord = (lower.match(/^([a-z][a-z-]*)/) || [null, null])[1];
      if (!firstWord) continue;
      const candidates = KEYWORD_BY_FIRST_WORD.get(firstWord);
      if (!candidates) continue;
      for (const kw of candidates) {
        if (lower === kw) { found.add(kw); break; }
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

function formatManaCost(raw) {
  if (!raw) return '';
  return raw.replace(/\{([^}]*\/[^}]*)\}/g, '($1)').replace(/[{}]/g, '');
}

function colorizedMana(cost) {
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


const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 };
const RARITY_CANON = {
  c: 'common', u: 'uncommon', r: 'rare', m: 'mythic', s: 'special',
  common: 'common', uncommon: 'uncommon', rare: 'rare',
  mythic: 'mythic', special: 'special',
};

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

function anyPrinting(c, pred) {
  const ps = STATE.byCanonical.get(c.canonical) || [c];
  return ps.some(pred);
}

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
    let atom = '';
    let inQuote = null;
    let inRegex = false;
    if (ch === '/') inRegex = true;
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


function parseQuery(q, opts) {
  const ctx = {
    sort: [],
    overridesFormat: false,
    error: null,
    hasBareTerm: false,
    bareMatchesOracle: !!(opts && opts.bareMatchesOracle),
  };
  const trimmed = (q || '').trim();
  if (!trimmed) {
    return { predicate: (_c) => true, sort: [], overridesFormat: false, error: null, hasBareTerm: false };
  }
  const tokens = tokenizeQuery(trimmed);
  extractSortTokens(tokens, ctx);
  if (tokens.length === 0) {
    return { predicate: (_c) => true, sort: ctx.sort, overridesFormat: false, error: null, hasBareTerm: false };
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
    return { predicate: (_c) => false, sort: [], overridesFormat: false, error: e.message, hasBareTerm: false };
  }
  return {
    predicate,
    sort: ctx.sort,
    overridesFormat: ctx.overridesFormat,
    error: null,
    hasBareTerm: ctx.hasBareTerm,
  };
}

function peek(state) { return state.tokens[state.pos]; }
function consume(state) { return state.tokens[state.pos++]; }

function extractSortTokens(tokens, ctx) {
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
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


function compileAtom(atom, ctx) {
  if (atom.startsWith('!')) {
    const name = stripQuotes(atom.slice(1)).toLowerCase();
    return (c) => cardNames(c).some(n => n.toLowerCase() === name);
  }
  if (atom.length >= 2 && atom[0] === '/' && atom[atom.length - 1] === '/') {
    const body = atom.slice(1, -1);
    let re;
    try { re = new RegExp(body, 'i'); }
    catch (e) { throw new Error(`bad regex /${body}/`); }
    return (c) => cardNames(c).some(n => re.test(n));
  }
  const m = atom.match(/^([a-zA-Z][a-zA-Z0-9_-]*?)(:|!=|==|<=|>=|=|<|>)(.*)$/);
  if (m) {
    const fieldRaw = m[1].toLowerCase();
    const op = m[2];
    const value = m[3];
    const field = FIELD_ALIASES[fieldRaw];
    if (!field) {
      return bareNamePredicate(atom, ctx);
    }
    if (value === '' && field !== 'sort') {
      return (_c) => false;
    }
    return buildFieldPredicate(field, op, value, ctx);
  }
  return bareNamePredicate(atom, ctx);
}

function cardNames(c) {
  const names = [c.name || '', c.canonical || ''];
  if (c.back) names.push(c.back.name || '', c.back.canonical || '');
  return names;
}

function bareNamePredicate(atom, ctx) {
  if (ctx) ctx.hasBareTerm = true;
  const needle = stripQuotes(atom).toLowerCase();
  if (!needle) return (_c) => true;
  const nameHit = (c) => cardNames(c).some(n => n.toLowerCase().includes(needle));
  if (!ctx || !ctx.bareMatchesOracle) return nameHit;
  return (c) => nameHit(c) || oracleTextFor(c).toLowerCase().includes(needle);
}

function stripQuotes(s) {
  if (s.length >= 2
      && ((s[0] === '"' && s[s.length - 1] === '"')
       || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

function parseListValue(raw) {
  const stripped = stripQuotes(raw);
  const inner = stripped.match(/^\(\s*(.*?)\s*\)$/);
  if (inner) return inner[1].split(/\s*,\s*/).filter(Boolean);
  if (stripped.includes(',')) return stripped.split(/\s*,\s*/).filter(Boolean);
  return [stripped];
}

function stringMatcher(rawValue) {
  const v = String(rawValue);
  if (v.length >= 2 && v[0] === '/' && v[v.length - 1] === '/') {
    const re = new RegExp(v.slice(1, -1), 'i');
    return (s) => re.test(String(s || ''));
  }
  const needle = stripQuotes(v).toLowerCase();
  return (s) => String(s || '').toLowerCase().includes(needle);
}

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

function splitCostPips(raw) {
  if (!raw) return [];
  const pips = [];
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) pips.push(m[1].toUpperCase());
  return pips;
}

function parseColorSpec(raw) {
  const v = stripQuotes(raw).toLowerCase();
  if (/^\d+$/.test(v)) return { kind: 'count', value: parseInt(v, 10), letters: '' };
  if (v === 'm') return { kind: 'multi', letters: '' };
  if (v === 'silver') return { kind: 'letters', letters: 'I' };
  if (v === 'c' || v === 'colorless') return { kind: 'colorless', letters: '' };
  const letters = [];
  for (const ch of v) {
    if (!'wubrgi'.includes(ch)) throw new Error(`bad color "${stripQuotes(raw)}"`);
    letters.push(ch.toUpperCase());
  }
  if (!letters.length) throw new Error(`bad color "${stripQuotes(raw)}"`);
  return { kind: 'letters', letters: letters.join('') };
}


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
    return (c) => cardNames(c).some(n => n.toLowerCase() === needle);
  }
  return (c) => cardNames(c).some(n => matcher(n));
}

function buildTypePredicate(op, rawValue) {
  const matcher = stringMatcher(rawValue);
  if (op === ':') {
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
    return (c) => {
      const ts = normaliseTypes(c);
      return words.every(w => ts.includes(w));
    };
  }
  if (op === '<=') {
    return (c) => {
      const ts = normaliseTypes(c);
      return ts.every(t => words.includes(t));
    };
  }
  if (op === '==') {
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
  return (c) => Array.isArray(c.keywords) && c.keywords.includes(needle);
}

function buildOraclePredicate(op, rawValue) {
  const raw = rawValue;
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
      return numericCompare(op, cs.length, spec.value);
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
      for (const l of want) if (!haveSet.has(l)) return false;
      return true;
    }
    if (op === '=' || op === '==') {
      if (haveSet.size !== wantSet.size) return false;
      for (const l of want) if (!haveSet.has(l)) return false;
      return true;
    }
    if (op === '<=') {
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
  if (raw === '{}' || raw === '') {
    return (c) => !(c.rawManaCost && c.rawManaCost.length);
  }
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

function decomposeManaQuery(raw) {
  const v = raw.toUpperCase().replace(/[{}]/g, '');
  if (v.includes('/')) return { generic: 0, pipMatchers: [{ kind: 'exact', pip: v }] };
  let generic = 0;
  const pipMatchers = [];
  let i = 0;
  while (i < v.length) {
    const ch = v[i];
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
    if (b === 'P') { addColors(); return true; }
    if (a === '2') { addColors(); return true; }
    if (a === 'V' || b === 'V') { addColors(); return true; }
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
  return (c) => anyPrinting(c, p => {
    const have = RARITY_RANK[p.rarity];
    if (have == null) return false;
    return numericCompare(op, have, want);
  });
}

function buildSetPredicate(op, rawValue) {
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
  return (c) => anyPrinting(c, p => matcher(p.artist || ''));
}

function buildFormatPredicate(status, rawValue) {
  const fmt = canonFormat(stripQuotes(rawValue));
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
    case 'page':      return (c) => !!c.pageData;
    case 'adventure':
    case 'discharge': return (c) => !!(c.pageData
                                      && c.pageData.type
                                      && c.pageData.type.toLowerCase().includes(v));
    case 'vertex':    return (c) => /\{[^}]*V[^}]*\}/.test(c.rawManaCost || '');
    case 'hybrid':    return (c) => /\{[^}]*\/[^}]*\}/.test(c.rawManaCost || '');
    case 'prismatic': return (c) => /\{Vp\}/.test(c.rawManaCost || '');
    case 'common':
    case 'uncommon':
    case 'rare':
    case 'mythic':
    case 'special':   return (c) => c.rarity === v;
    default: return buildTagPredicate(rawValue);
  }
}

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

function isLandManabaseTag(name) {
  const low = String(name || '').toLowerCase();
  if (low === 'goldland' || low === 'utilityland') return true;
  return /^[wubrg]+land$/.test(low);
}

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
  return (c) => anyPrinting(c, p => matcher(p.flavor || ''));
}

function buildInPredicate(_op, rawValue) {
  const raw = stripQuotes(rawValue).toLowerCase();
  const canon = RARITY_CANON[raw];
  if (canon) {
    return (c) => anyPrinting(c, p => p.rarity === canon);
  }
  return (c) => anyPrinting(c, p => (p.set || '').toLowerCase() === raw);
}

function buildLayoutPredicate(_op, rawValue) {
  const v = stripQuotes(rawValue).toLowerCase();
  return (c) => String(c.layout || '').toLowerCase() === v;
}


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
    hidePreview();
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
      renderSearchResults();
      renderAll();
    }
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

function syncFormatLockUI() {
  if (STATE.tagMode) return;
  const btn = document.getElementById('btn-search-lock');
  const input = document.getElementById('search');
  const locked = !!STATE.formatLock;
  if (btn) {
    btn.classList.toggle('active', locked);
    btn.dataset.title = locked
      ? 'Format filter locked: ' + STATE.formatLock
        + '\nApplies to every search and decides card legality. Click to unlock.'
      : 'Lock the current search as this deck’s format filter, e.g. "f:eternal r:c" for Eternal Pauper.'
        + '\nA locked filter applies to every search and decides card legality.';
  }
  if (input) {
    input.placeholder = locked ? '🔒 ' + STATE.formatLock : 'e.g. t:creature';
  }
}

function wireFormatLock() {
  const btn = document.getElementById('btn-search-lock');
  const input = document.getElementById('search');
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    if (STATE.formatLock) {
      if (!input.value.trim()) input.value = STATE.formatLock;
      setFormatLock(null);
      runSearch(input.value);
      renderAll();
      input.focus();
      return;
    }
    const text = input.value.trim();
    if (!text) {
      const errEl = document.getElementById('search-error');
      if (errEl) {
        errEl.textContent = 'Type a filter to lock, e.g. f:eternal r:c';
        errEl.classList.remove('hidden');
      }
      input.focus();
      return;
    }
    const parsed = parseQuery(text);
    if (parsed.error) {
      STATE.search.error = parsed.error;
      renderSearchError();
      input.focus();
      return;
    }
    setFormatLock(text);
    input.value = '';
    runSearch('');
    renderAll();
  });
}

const SEARCH_RESULT_CAP = 300;

function runSearch(q) {
  const raw = (q || '').trim();
  const results = document.getElementById('search-results');
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

  if (parsed.error) {
    STATE.search.results = [];
    STATE.search.selectedIdx = 0;
    renderSearchResults();
    hidePreview();
    return;
  }
  const lock = getFormatLock();
  let effective = parsed;
  let items = collectSearchItems(parsed, lock);
  if (items.length === 0 && parsed.hasBareTerm) {
    const widened = parseQuery(raw, { bareMatchesOracle: true });
    if (!widened.error) {
      effective = widened;
      items = collectSearchItems(widened, lock);
    }
  }
  sortSearchItems(items, effective.sort);
  STATE.search.results = items;
  STATE.search.selectedIdx = 0;
  renderSearchResults();
}

function collectSearchItems(parsed, lock) {
  const predicate = parsed.predicate;
  const seenCanon = new Set();
  const items = [];
  for (const c of STATE.cards) {
    if (lock && !facesMatch(c, lock.predicate)) continue;
    const baseOverridden = parsed.overridesFormat || (lock && lock.overridesFormat);
    if (!baseOverridden && !isLegalBase(c)) continue;
    if (seenCanon.has(c.canonical)) continue;
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
  return items;
}

function facesMatch(card, predicate) {
  if (predicate(card)) return true;
  if (card.pageFace && predicate(card.pageFace)) return true;
  return false;
}

function fallbackNamePredicate(raw) {
  const needle = raw.toLowerCase();
  return (c) => cardNames(c).some(n => n.toLowerCase().includes(needle));
}

function sortSearchItems(items, sortSpec) {
  const specs = (sortSpec && sortSpec.length) ? sortSpec : null;
  if (!specs) {
    sortSearchItemsByPileChain(items);
    return;
  }
  const keyFns = specs.map(s => sortKeyFn(s.field)).filter(Boolean);
  items.sort((a, b) => {
    const ac = a.printings[a.printings.length - 1];
    const bc = b.printings[b.printings.length - 1];
    for (let i = 0; i < keyFns.length; i++) {
      const va = keyFns[i](ac), vb = keyFns[i](bc);
      const desc = specs[i].desc;
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
  if (aNaN) return 1;
  if (bNaN) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function renderSearchResults() {
  const results = document.getElementById('search-results');
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
      const picked = item.printings[item.pickedIdx] || item.printings[item.printings.length - 1];
      showPreview(picked, ev, el);
    });
    el.addEventListener('mousemove', (ev) => positionPreview(ev));
    el.addEventListener('mouseleave', hidePreview);
    el.addEventListener('mousedown', (ev) => ev.preventDefault());
    el.addEventListener('click', (ev) => {
      const zone = searchAddZone(ev);
      addCardToZone(item.printings[item.pickedIdx].id, zone);
      renderAll();
      document.getElementById('search').focus();
    });

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
  const focused = results.querySelector('.result.selected');
  if (focused && focused.scrollIntoView) {
    focused.scrollIntoView({ block: 'nearest' });
  }
}

function renderSearchError() {
  const el = document.getElementById('search-error');
  if (!el) return;
  const err = STATE.search.error;
  if (!err) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = 'query: ' + err;
  el.classList.remove('hidden');
}

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
  const rect = rowEl.getBoundingClientRect();
  const fakeEv = { clientX: rect.right, clientY: rect.top + rect.height / 2 };
  showPreview(picked, fakeEv, rowEl,   true);

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


function isPlaysetPile(pile, card) {
  if (!card || pile.length !== 4) return false;
  const canon = card.canonical;
  return pile.every(i => {
    const c = STATE.byId.get(i.cardId);
    return c && c.canonical === canon;
  });
}

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

function isMaybeLocked() { return !!STATE.loadedPlanName; }
function isPlanActive() { return !!STATE.loadedPlanName; }

function notePlanLock(msg) {
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


function detachInstance(uid) {
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

function readUidsFromDrag(dt) {
  const raw = dt.getData('text/uids') || dt.getData('text/uid');
  if (!raw) return [];
  return raw.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
}

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


function renderAll() {
  endDragGhost();
  for (const z of Object.keys(STATE.zones)) {
    renderZoneList(z);
    renderZoneCount(z);
  }
  renderPiles();
  updatePlanBanner();
  captureUndoSnapshot();
  scheduleSessionSave();
}


function serializeZones() { return JSON.stringify(STATE.zones); }

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
  STATE.history.lastSnapshot = json;
  renderAll();
}

function resetHistory() {
  STATE.history.past.length = 0;
  STATE.history.future.length = 0;
  STATE.history.lastSnapshot = serializeZones();
}

function undo() {
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
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.isContentEditable
              || (a.tagName === 'INPUT' && a.id !== 'search'))) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && ev.shiftKey)) {
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

  const counts = new Map();
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

  const groupOf = (row) => {
    const card = STATE.byId.get(row.cardId);
    if (STATE.listSort === 'cmc') {
      const b = cmcBucket(card);
      return { key: b.key, label: b.label, sortVal: b.sortVal };
    }
    return { key: card.maintype || '?', label: card.maintype || '?', sortVal: typeRank(card) };
  };

  rows.sort((a, b) => {
    const ga = groupOf(a), gb = groupOf(b);
    if (ga.sortVal !== gb.sortVal) return ga.sortVal - gb.sortVal;
    const ca = STATE.byId.get(a.cardId), cb = STATE.byId.get(b.cardId);
    if (STATE.listSort === 'cmc') {
      if (typeRank(ca) !== typeRank(cb)) return typeRank(ca) - typeRank(cb);
    } else {
      if (ca.cmc !== cb.cmc) return ca.cmc - cb.cmc;
    }
    return a.canon.localeCompare(b.canon);
  });

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
  div.addEventListener('mouseenter', (ev) => showPreview(card, ev));
  div.addEventListener('mousemove', positionPreview);
  div.addEventListener('mouseleave', hidePreview);
  return div;
}


const PILE_OFFSET_Y = 30;
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

  zone.piles.forEach((pile, pileIdx) => {
    if (pile.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pile-wrapper';
    wrapper.appendChild(makePileGap(pileIdx));
    wrapper.appendChild(makePileEl(pile, pileIdx));
    container.appendChild(wrapper);
  });

  container.appendChild(makePileGap(zone.piles.length));
}

function clearOtherDragOver(except) {
  for (const el of document.querySelectorAll('#piles .drag-over')) {
    if (el !== except) el.classList.remove('drag-over');
  }
}

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

function currentFace(inst, card) {
  if (inst && inst.flipped && card && card.back) return card.back;
  return card;
}

function makeVersionButton(openPickerAt) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'version-btn';
  btn.dataset.title = 'Change printing';
  btn.draggable = false;
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
    chip.addEventListener('mouseenter', (ev) => showPreview(p, ev));
    chip.addEventListener('mousemove', positionPreview);
    chip.addEventListener('mouseleave', hidePreview);
    picker.appendChild(chip);
  });
  document.body.appendChild(picker);
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
    if (isPlanActive()) propagatePrintingToBase(oldToNewNames);
    renderAll();
  }
}

function propagatePrintingToBase(swaps) {
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
  const piles = document.getElementById('piles');
  if (piles) piles.addEventListener('scroll', closeVersionPicker, { passive: true });
  window.addEventListener('resize', closeVersionPicker);
}

function makeFlipButton(inst, card, slot) {
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
    const face = currentFace(inst, card);
    const img = slot.querySelector('img');
    if (img) {
      img.src = imgUrl(face);
      img.alt = face.canonical || face.name || card.canonical;
      img.removeAttribute('data-src');
    }
    slot.classList.toggle('flipped', !!inst.flipped);
  });
  return btn;
}

function makeSlotButtons(inst, card) {
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

  const planActive = isPlanActive();

  if (!planActive) wrap.appendChild(makeBtn('+', 'Add another copy', () => {
    const found = findInstance(inst.uid);
    if (!found) return;
    const { zoneName, pileIdx } = found;
    const pile = STATE.zones[zoneName].piles[pileIdx];
    const newInst = { uid: newUid(), cardId: card.id };
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
    if (card) {
      slot.addEventListener('mouseenter', (ev) => showPreview(currentFace(inst, card), ev, slot));
      slot.addEventListener('mousemove', positionPreview);
      slot.addEventListener('mouseleave', hidePreview);
    }

    if (card) {
      slot.appendChild(makeSlotButtons(inst, card));
      if (card.back) {
        slot.appendChild(makeFlipButton(inst, card, slot));
      }
      const printings = STATE.byCanonical.get(card.canonical);
      if (printings && printings.length > 1) {
        slot.appendChild(makeVersionButton((btn) => openVersionPicker(btn, inst, card)));
      }
    }
    el.appendChild(slot);
  });

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
    const destPile = STATE.zones[STATE.focusedZone].piles[pileIdx];
    if (!destPile) return;
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


function renderSearchPanel() {
  const count = STATE.search.results.length;
  document.getElementById('pile-title').textContent = `Search (${count})`;
  const container = document.getElementById('piles');
  container.innerHTML = '';
  container.classList.add('search-mode');
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

  const face0 = currentFace(item, card);
  const img = document.createElement('img');
  img.alt = face0.canonical || face0.name || card.canonical || '';
  img.dataset.src = imgUrl(face0);
  img.addEventListener('error', () => {
    slot.classList.add('no-image');
    slot.textContent = face0.canonical || face0.name || '???';
  });
  slot.appendChild(img);
  queueMicrotask(() => getSearchImgObserver().observe(img));
  if (item && item.flipped && card.back) slot.classList.add('flipped');

  const titleParts = [card.canonical, card.type, card.manacost || ''];
  if (card.text) titleParts.push('', card.text);
  if (card.power || card.toughness) titleParts.push(`${card.power}/${card.toughness}`);
  slot.dataset.title = titleParts.join('\n').trim();

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
    const cardIds = (STATE.searchSelection.size > 0 && STATE.searchSelection.has(card.id))
      ? [...STATE.searchSelection]
      : [card.id];
    ev.dataTransfer.effectAllowed = 'copyMove';
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
  if (card.back && item) {
    slot.appendChild(makeFlipButton(item, card, slot));
  }
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
    const ids = (STATE.searchSelection.size > 0 && STATE.searchSelection.has(card.id))
      ? [...STATE.searchSelection]
      : [card.id];
    for (const id of ids) addCardToZone(id, zone);
    renderAll();
  };
  if (!isPlanActive()) {
    wrap.appendChild(makeBtn('+', 'Add to main deck', () => addTo('main')));
    const sanctumBtn = makeBtn('\u25a0', 'Add to sanctum', () => addTo('sanctum'));
    sanctumBtn.classList.add('sanctum-only');
    wrap.appendChild(sanctumBtn);
    wrap.appendChild(makeBtn('\u2194', 'Add to sideboard', () => addTo('side')));
    wrap.appendChild(makeBtn('?', 'Add to maybeboard', () => addTo('maybe')));
  }

  return wrap;
}

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
    setFocusedZone('main');
  }
}

function updateSearchZoneCount() {
  const el = document.getElementById('count-search');
  if (el) el.textContent = String(STATE.search.results.length);
}


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
    });

    const list = document.getElementById('list-' + zoneName);
    list.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const cardId = parseInt(row.dataset.cardId, 10);
      const card = STATE.byId.get(cardId);
      const zone = STATE.zones[zoneName];
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

  const searchSec = document.querySelector('.zone[data-zone="search"]');
  if (searchSec) {
    searchSec.addEventListener('click', () => setFocusedZone('search'));
  }

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
  document.body.classList.toggle('search-active', zoneName === 'search');
  const allTagsBtn = document.getElementById('btn-all-tags');
  if (allTagsBtn) allTagsBtn.classList.toggle('active', zoneName === 'tag-list');
  renderPiles();
}


function wireToolbar() {
  wireFormatDropdown();
  wireFloatingActions();
  wireSearchHelp();
  wirePlanBanner();
  wireDragTrash();

  if (STATE.tagMode) return;

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
      if (newFormat !== 'range') formatMenu.classList.add('hidden');
      if (crossesDataset) {
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
      const decksDropdown = document.getElementById('decks-dropdown');
      if (decksDropdown) decksDropdown.classList.add('hidden');
      runSearch(document.getElementById('search').value);
      renderAll();
    });
  });
  document.getElementById('range-pickers').addEventListener('click', (ev) => {
    ev.stopPropagation();
  });
  document.addEventListener('click', () => {
    formatMenu.classList.add('hidden');
  });
  const startSel = document.getElementById('range-start');
  const endSel   = document.getElementById('range-end');
  function onRangeChange(which) {
    STATE.rangeStart = startSel.value;
    STATE.rangeEnd   = endSel.value;
    if (setIndex(STATE.rangeStart) > setIndex(STATE.rangeEnd)) {
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
  syncFormatUI();
}

function wireFloatingActions() {
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn.addEventListener('click', async () => {
    const original = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Updating\u2026';
    try {
      const wasVoyager = currentDataset() === 'voyager';
      await refreshCurrentDataset();
      const prefix = wasVoyager ? new URL(VOYAGER_URL).origin + '/' : IMG_BASE;
      await pruneImageCache(prefix, currentImageUrls());
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

function currentImageUrls() {
  const urls = new Set();
  for (const card of STATE.cards) {
    const u = imgUrl(card);
    if (u) urls.add(u);
    if (card.back) {
      const bu = imgUrl(card.back);
      if (bu) urls.add(bu);
    }
  }
  return urls;
}

async function cacheAllImages(progressCb) {
  const list = [...currentImageUrls()];
  const total = list.length;

  let alreadyCached = new Set();
  if ('caches' in self) {
    try {
      const cache = await caches.open('rev-img-v1');
      const keys = await cache.keys();
      alreadyCached = new Set(keys.map(req => req.url));
    } catch (e) {   }
  }
  const misses = list.filter(u => !alreadyCached.has(u));
  let done = total - misses.length;
  let failed = 0, cancelled = false;
  let idx = 0;
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
  if ('caches' in self) await caches.delete('rev-img-v1');
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'clear-img-cache' });
  }
}

async function pruneImageCache(prefix, wanted) {
  if (!('caches' in self)) return;
  try {
    const cache = await caches.open('rev-img-v1');
    for (const req of await cache.keys()) {
      if (req.url.startsWith(prefix) && !wanted.has(req.url)) await cache.delete(req);
    }
  } catch (e) {   }
}

function wireSortButtons(attr, stateKey, afterClick) {
  const sel = `[data-${attr}]`;
  const dataKey = attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  document.querySelectorAll(sel).forEach(btn => {
    btn.addEventListener('click', () => {
      STATE[stateKey] = btn.dataset[dataKey];
      document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b === btn));
      afterClick();
    });
  });
}

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

function pushPileSort(method) {
  const chain = STATE.pileSortChain;
  const i = chain.indexOf(method);
  if (i >= 0) chain.splice(i, 1);
  chain.unshift(method);
  if (chain.length > 5) chain.length = 5;
  STATE.pileSort = chain[0];
}

function wireListSort() {
  wireSortButtons('list-sort', 'listSort', () => {
    for (const z of Object.keys(STATE.zones)) renderZoneList(z);
  });
}


function wirePreviewHover() {
}

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

function wireRegionSelect() {
  const pilesEl = document.getElementById('piles');
  let active = null;

  pilesEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.card-slot, .slot-btn')) return;
    ev.preventDefault();
    document.getElementById('search').blur();
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
    if (dx > 3 || dy > 3) _suppressNextClickClear = true;
    active.rectEl.remove();
    active = null;
  });
}

const PREVIEW_DELAY_MS = 250;
let _previewTimer = null;
let _previewAvoidEl = null;

function showPreview(card, ev, avoidEl, immediate) {
  const pop = document.getElementById('tag-popover');
  if (pop && !pop.classList.contains('hidden')) return;
  if (_previewTimer) clearTimeout(_previewTimer);
  _previewAvoidEl = avoidEl || null;
  const startEv = { clientX: ev.clientX, clientY: ev.clientY };
  const run = () => {
    _previewTimer = null;
    const el = document.getElementById('card-preview');
    const img = document.getElementById('card-preview-img');
    const url = imgUrl(card);
    img.alt = card.canonical;
    el.classList.add('hidden');
    const show = () => {
      el.classList.remove('hidden');
      positionPreview(startEv);
    };
    if (img.src === url || img.src === new URL(url, location.href).href) {
      img.src = url;
      show();
    } else {
      img.onload = () => { img.onload = null; show(); };
      img.src = url;
    }
    const dragImg = document.getElementById('drag-img');
    if (dragImg) dragImg.src = url;
  };
  if (immediate) run();
  else _previewTimer = setTimeout(run, PREVIEW_DELAY_MS);
}

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
    root: piles || null,
    rootMargin: '400px 0px',
    threshold: 0,
  });
  return _searchImgObserver;
}

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


function clearAllZones() {
  for (const z of Object.keys(STATE.zones)) {
    STATE.zones[z].piles = [];
  }
}

function resolveCardName(name, uuid) {
  if (uuid && STATE.uuidMap[uuid]) return STATE.uuidMap[uuid].cardId;
  const exact = STATE.byName.get(name);
  if (exact) return exact.id;
  const canon = canonicalName(name);
  for (const c of STATE.cards) {
    if (c.canonical === canon) return c.id;
  }
  return null;
}

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

  const groups = [];
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
    setTimeout(() => merge.focus(), 0);
  });
}

async function resolveMaybeMode(exportLabel) {
  const maybeCount = STATE.zones.maybe.piles.reduce((n, p) => n + p.length, 0);
  if (maybeCount === 0) return 'omit';
  return promptMaybeboardInclusion(exportLabel);
}


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


function wirePasteImport() {
  const modal = document.getElementById('paste-modal');
  const textarea = document.getElementById('paste-textarea');
  const open = () => {
    textarea.value = '';
    modal.classList.remove('hidden');
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


const SAVED_DECK_PREFIX = 'rev-deckbuilder-savedeck:';

function deckFormatVisibleInCurrentFormat(deckFormat) {
  const dfmt = deckFormat || 'standard';
  if (STATE.format === 'voyager') return dfmt === 'voyager';
  if (dfmt === 'voyager') return false;
  if (STATE.format === 'standard') return dfmt === 'standard';
  return true;
}

function listSavedDecks() {
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
    } catch (_) {   }
  }
  out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return out;
}

function readDeckMeta(name) {
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
  const seen = new Map();
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
    formatLock: STATE.formatLock,
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

  const unknown = [];
  for (const z of ['main', 'sanctum', 'side', 'maybe']) {
    const piles = (payload.zones[z] || []).map(pileNames => {
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
    STATE.zones[z].piles = piles;
  }
  STATE.selection.clear();
  STATE.loadedPlanName = null;
  STATE.basePlanZones = null;
  if (payload.format === 'standard' || payload.format === 'eternal' || payload.format === 'range') {
    STATE.format = payload.format;
    STATE.rangeStart = payload.rangeStart || null;
    STATE.rangeEnd = payload.rangeEnd || null;
    savePrefs();
    syncFormatUI();
  }
  setFormatLock(typeof payload.formatLock === 'string' ? payload.formatLock : null);
  runSearch(document.getElementById('search').value);
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
  if (!STATE.loadedPlanName || !STATE.loadedDeckName) return false;
  const name = STATE.loadedDeckName;
  const ok = loadDeckFromStorage(name);
  if (!ok) {
    STATE.loadedPlanName = null;
    STATE.basePlanZones = null;
    renderAll();
    updateSaveButtons();
  }
  return true;
}

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

function snapshotDeck() {
  const zones = {};
  for (const z of ['main', 'sanctum', 'side', 'maybe']) {
    zones[z] = STATE.zones[z].piles.map(pile => pile.map(inst => {
      const c = STATE.byId.get(inst.cardId);
      return c ? c.name : null;
    }));
  }
  return JSON.stringify({ zones, formatLock: STATE.formatLock });
}

function markDeckClean() {
  STATE.deckSnapshot = snapshotDeck();
  scheduleSessionSave();
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
  scheduleSessionSave();
}

function updatePlanBanner() {
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
  const expandedFolders = new Set();
  let saveDialogTags = [];

  function closeAllDropdowns() {
    saveDropdown.classList.add('hidden');
    decksDropdown.classList.add('hidden');
    decksDropdown.style.left = '';
  }

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

  function openSaveNameDropdown(mode  ) {
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
    for (const deck of unfiled) appendDeckAndPlans(deck, false);
    const sortedKeys = [...groups.keys()].sort();
    for (const k of sortedKeys) {
      const g = groups.get(k);
      if (g.decks.length === 0) continue;
      renderFolderGroup(g.display, g.decks);
    }
  }

  function appendDeckAndPlans(deck, indent) {
    listEl.appendChild(buildDeckRow(deck, indent));
    if (deck.name !== STATE.loadedDeckName) return;
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

  saveDropdown.addEventListener('click', (ev) => ev.stopPropagation());
  decksDropdown.addEventListener('click', (ev) => ev.stopPropagation());

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

async function loadDeckFromUrlFragment() {
  const hash = location.hash || '';
  if (!hash.startsWith('#d=')) return;
  const payload = hash.slice(3);
  if (!payload) return;
  const clearHash = () =>
    history.replaceState(null, '', location.pathname + location.search);

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

async function loadSavedDeckFromUrlFragment() {
  const hash = location.hash || '';
  if (!hash.startsWith('#open=')) return;
  let name = '';
  try { name = decodeURIComponent(hash.slice(6)); } catch (_) {}
  history.replaceState(null, '', location.pathname + location.search);
  if (!name) return;
  const payload = readDeckPayload(name);
  if (!payload) {
    alert('No saved deck named “' + name + '” was found.');
    return;
  }
  if ((payload.format || 'standard') !== 'voyager' && currentDataset() !== 'revolution') {
    try {
      await switchDataset('revolution');
    } catch (e) {
      alert('Could not switch datasets to open “' + name + '”: ' + (e && e.message ? e.message : e));
      return;
    }
    STATE.format = 'standard';
    savePrefs();
    syncFormatUI();
    renderAll();
  }
  if (!loadDeckFromStorage(name)) {
    alert('Could not load deck “' + name + '”');
    return;
  }
  const meta = readDeckMeta(name);
  STATE.loadedDeckName = name;
  STATE.loadedDeckFolder = meta.folder;
  STATE.loadedDeckTags = meta.tags;
  updateSaveButtons();
}

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


function initTagMode() {
  document.body.classList.add('tag-mode');
  STATE.searchPanel = true;
  applySearchPanelMode();
  ensureTagPopover();
  wireTagPopover();
  wireTagSearchTab();
  renderTagSidebar();
  renderTagSaveStatus();
  const input = document.getElementById('search');
  if (input) input.focus();
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

function wireTagSearchTab() {
  const tab = document.getElementById('tag-search-tab');
  if (tab) {
    tab.addEventListener('click', () => {
      STATE.focusedTag = null;
      setFocusedZone('search');
      renderTagSidebar();
    });
  }
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
      editBtn.addEventListener('mousedown', (ev) => ev.stopPropagation());
      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openAliasEditorPopover(editBtn, tag);
      });
    }
    sec.addEventListener('click', (ev) => {
      if (ev.shiftKey) {
        ev.preventDefault();
        openAliasEditorPopover(editBtn || sec, tag);
        return;
      }
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

function canonicalsFromDrag(ev) {
  if (STATE.dragging && STATE.dragging.fromSearch) {
    return (STATE.dragging.cardIds || [])
      .map(id => STATE.byId.get(id)?.canonical)
      .filter(Boolean);
  }
  if (STATE.dragging && STATE.dragging.fromTag) {
    return (STATE.dragging.canonicals || []).slice();
  }
  const txt = ev.dataTransfer && ev.dataTransfer.getData('text/canonical');
  return txt ? [txt] : [];
}

function renderTagMemberPanel() {
  const tag = STATE.focusedTag;
  const ds = currentDataset();
  const allCanonicals = tag ? cardsForTag(tag, ds) : [];
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

function renderAllTagsPanel() {
  const ds = currentDataset();
  const slot = STATE.tags[ds];
  const order = slot ? slot.order.slice() : [];
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
  const trimmedLow = currentInput.trim().toLowerCase();
  if (trimmedLow && order.some(t => t.toLowerCase() === trimmedLow)) {
    dl.innerHTML = '';
    return;
  }
  const parts = order.map(t => `<option value="${escapeHtml(t)}">`);
  for (const k of Object.keys(aliases).sort()) {
    const target = aliases[k];
    parts.push(`<option value="${escapeHtml(k)}" label="→ ${escapeHtml(target)}">`);
  }
  dl.innerHTML = parts.join('');
}

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
  hidePreview();
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
  document.addEventListener('mousedown', (ev) => {
    const pop = document.getElementById('tag-popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(ev.target)) return;
    if (ev.target.closest && ev.target.closest('.tag-btn')) return;
    closeTagPopover();
  });
}

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
},   true);
