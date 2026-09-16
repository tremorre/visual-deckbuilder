import { BASIC_NAMES, buildPool, buildLiveBridge, parseStaples, parseRenames, renameToLive, playable } from './catalog.js';

// v1-v3 share URLs: Rice-coded gaps over a frozen pool snapshot.
const POOL_FILES = { 1: 'cards.frozen.json', 2: 'cards.frozen.json', 3: 'cards.frozen.v3.json' };
const EOS = 'EOS';
const MAIN_CODES = {
  '3,0': '00', '4,0': '01', '1,0': '100', '2,0': '101', '0,2': '1100', '0,3': '1101', '0,4': '1110',
  '0,1': '11110', '1,2': '1111100', '2,2': '1111101', '1,1': '11111100', '2,1': '11111101',
  '3,1': '11111110', '1,3': '111111110', EOS: '111111111',
};
const APP_CODES = {
  '3,0': '00', '4,0': '01', '1,0': '100', '2,0': '101', '0,2': '1100', '0,3': '1101', '0,4': '1110',
  '0,1': '11110', '1,2': '1111100', '2,2': '1111101', '1,1': '11111100', '1,3': '11111101',
  '2,1': '11111110', '3,1': '11111111',
};

function parsePair(k) {
  const i = k.indexOf(',');
  return [parseInt(k.slice(0, i), 10), parseInt(k.slice(i + 1), 10)];
}

function base64urlToBytes(s) {
  const pad = (4 - s.length % 4) % 4;
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const _poolPromises = new Map();
// Site-root files, located from this module rather than the page.
const asset = file => fetch(new URL('../../' + file, import.meta.url), { cache: 'force-cache' });

class BitReader {
  constructor(bytes) {
    this.bits = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) {
      for (let j = 0; j < 8; j++) this.bits[i * 8 + j] = (bytes[i] >> (7 - j)) & 1;
    }
    this.pos = 0;
  }
  remaining() { return this.bits.length - this.pos; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bits[this.pos++];
    return v;
  }
  readUnary() {
    let n = 0;
    while (this.bits[this.pos] === 0) { n++; this.pos++; }
    this.pos++;
    return n;
  }
}

function riceRead(br, k) {
  const q = br.readUnary();
  const r = k ? br.read(k) : 0;
  return (q << k) | r;
}

function buildHuffmanTable(codes) {
  const table = new Map();
  let maxLen = 0;
  for (const sym of Object.keys(codes)) {
    const bits = codes[sym];
    table.set(parseInt(bits, 2) | (1 << bits.length), sym);
    if (bits.length > maxLen) maxLen = bits.length;
  }
  return { table, maxLen };
}

function huffmanDecodeOne(br, hd) {
  let val = 1;
  for (let L = 1; L <= hd.maxLen; L++) {
    val = (val << 1) | br.bits[br.pos++];
    if (hd.table.has(val)) return hd.table.get(val);
  }
  throw new Error('invalid Huffman code');
}

export async function ensurePool(version) {
  if (_poolPromises.has(version)) return _poolPromises.get(version);
  const p = (async () => {
    const poolFile = POOL_FILES[version];
    if (!poolFile) throw new Error('unknown deck-URL version: ' + version);
    // v1/v2 pools carve out staples.txt / unplayable.txt; v3+ is every legal card
    const sideLists = version <= 2;
    const [frozenResp, liveResp, staplesResp, unplayableResp, renamesResp] = await Promise.all([
      asset(poolFile),
      asset('cards.json').catch(() => null),
      sideLists ? asset('staples.txt') : null,
      sideLists ? asset('unplayable.txt') : null,
      asset('renames.txt').catch(() => null),
    ]);
    if (!frozenResp.ok) throw new Error(poolFile + ' fetch failed');
    const data = (await frozenResp.json()).data || {};
    const staples = parseStaples(staplesResp && staplesResp.ok ? await staplesResp.text() : '');
    const unplayable = parseStaples(unplayableResp && unplayableResp.ok ? await unplayableResp.text() : '');
    const renames = parseRenames(renamesResp && renamesResp.ok ? await renamesResp.text() : '');
    const pool = buildPool(data, staples, unplayable, version);
    let liveData = {};
    try { if (liveResp && liveResp.ok) liveData = (await liveResp.json()).data || {}; } catch (e) {}
    Object.assign(pool, buildLiveBridge(liveData),
                  { renameFwd: renames.fwd, renameBack: renames.back });
    return pool;
  })();
  _poolPromises.set(version, p);
  return p;
}

export async function decodeLegacy(b64) {
  const bytes = base64urlToBytes(b64);
  const br = new BitReader(bytes);
  while (br.bits[br.pos] === 0) br.pos++;
  br.pos++;
  const version = br.read(8);
  if (!POOL_FILES[version]) {
    throw new Error('unknown deck-URL version: ' + version);
  }
  const pool = await ensurePool(version);
  const { legalCanonical, fullCanonical, info, staples, nonBasicFullLen,
          lookup, liveByName, liveNameBySetNum, renameFwd, appIdxBits } = pool;
  const claimedByPool = (nm) =>
    !!nm && (lookup.has(nm) || lookup.has(nm.split('_')[0]));
  const nameOut = (bare) => {
    const e = info.get(bare);
    const fn = (e && e.firstName) || bare;
    if (!liveByName || liveByName.has(fn)) return fn;
    const led = renameFwd && renameToLive(fn, renameFwd, liveByName);
    if (led) return led;
    const sn = e && (e.set + '|' + e.num);
    const cand = sn && liveNameBySetNum && liveNameBySetNum.get(sn);
    if (cand && !claimedByPool(cand)) return cand;
    return fn;
  };
  const mask = br.read(5);
  const nStaplesPicked = br.read(6);
  const k1 = br.read(4);
  const k2 = br.read(4);
  const presence = br.read(5);
  const basics = {};
  for (const b of BASIC_NAMES) basics[b] = [0, 0];
  for (let i = 0; i < BASIC_NAMES.length; i++) {
    if (presence & (1 << i)) {
      basics[BASIC_NAMES[i]][0] = br.read(4);
      basics[BASIC_NAMES[i]][1] = br.read(3);
    }
  }

  const stapleSeg = []; const restSeg = [];
  for (let i = 0; i < legalCanonical.length; i++) {
    const name = legalCanonical[i];
    if (!playable(info.get(name).manaCost, mask)) continue;
    if (staples.has(name)) stapleSeg.push(i); else restSeg.push(i);
  }
  const newPool = stapleSeg.concat(restSeg);
  const nStapleInPool = stapleSeg.length;

  const mainHd = buildHuffmanTable(MAIN_CODES);
  const appHd = buildHuffmanTable(APP_CODES);

  const cards = {};
  let prev = -1;
  for (let i = 0; i < nStaplesPicked; i++) {
    const gap = riceRead(br, k1);
    const sym = huffmanDecodeOne(br, mainHd);
    const segPos = prev + 1 + gap;
    const legalIdx = newPool[segPos];
    const [m, s] = parsePair(sym);
    cards[nameOut(legalCanonical[legalIdx])] = { main: m, side: s };
    prev = segPos;
  }
  let appendixStarts = false;
  prev = nStapleInPool - 1;
  while (br.remaining() > 0) {
    const savedPos = br.pos;
    let gap, sym;
    try {
      gap = riceRead(br, k2);
      sym = huffmanDecodeOne(br, mainHd);
    } catch (e) { br.pos = savedPos; break; }
    if (sym === EOS) { appendixStarts = true; break; }
    const segPos = prev + 1 + gap;
    const legalIdx = newPool[segPos];
    const [m, s] = parsePair(sym);
    cards[nameOut(legalCanonical[legalIdx])] = { main: m, side: s };
    prev = segPos;
  }
  if (appendixStarts) {
    while (br.remaining() >= appIdxBits + 1) {
      let fullIdx, sym;
      try {
        fullIdx = br.read(appIdxBits);
        sym = huffmanDecodeOne(br, appHd);
      } catch (e) { break; }
      const [m, s] = parsePair(sym);
      if (fullIdx >= nonBasicFullLen) {
        const name = fullCanonical[fullIdx];
        basics[name][0] += m;
        basics[name][1] += s;
      } else {
        cards[nameOut(fullCanonical[fullIdx])] = { main: m, side: s };
      }
    }
  }

  return { version, mask, basics, cards };
}
