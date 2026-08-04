(function () {
  'use strict';

  const VERSION = 2;
  const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_BIT = { W: 1, U: 2, B: 4, R: 8, G: 16 };
  const BASIC_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const BASIC_BIT = { Plains: 1, Island: 2, Swamp: 4, Mountain: 8, Forest: 16 };
  const EOS = 'EOS';

  const MAIN_CODES = {
    '3,0': '00',
    '4,0': '01',
    '1,0': '100',
    '2,0': '101',
    '0,2': '1100',
    '0,3': '1101',
    '0,4': '1110',
    '0,1': '11110',
    '1,2': '1111100',
    '2,2': '1111101',
    '1,1': '11111100',
    '2,1': '11111101',
    '3,1': '11111110',
    '1,3': '111111110',
    EOS:   '111111111',
  };
  const APP_CODES = {
    '3,0': '00',
    '4,0': '01',
    '1,0': '100',
    '2,0': '101',
    '0,2': '1100',
    '0,3': '1101',
    '0,4': '1110',
    '0,1': '11110',
    '1,2': '1111100',
    '2,2': '1111101',
    '1,1': '11111100',
    '1,3': '11111101',
    '2,1': '11111110',
    '3,1': '11111111',
  };

  function pairKey(m, s) { return m + ',' + s; }
  function parsePair(k) {
    const i = k.indexOf(',');
    return [parseInt(k.slice(0, i), 10), parseInt(k.slice(i + 1), 10)];
  }


  function parseManaCost(cost) {
    const out = [];
    if (!cost) return out;
    const re = /\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(cost)) !== null) {
      const inside = m[1];
      if (/^[WUBRG]$/.test(inside)) { out.push({ kind: 'mono', color: inside }); continue; }
      if (inside.indexOf('/') >= 0) {
        const parts = inside.split('/');
        if (parts.length === 2) {
          const [a, b] = parts;
          if (a === 'P' || b === 'P') {
            const color = a === 'P' ? b : a;
            out.push(MANA_COLORS.indexOf(color) >= 0
              ? { kind: 'phyrexian', color }
              : { kind: 'generic' });
            continue;
          }
          if (a === '2' && MANA_COLORS.indexOf(b) >= 0) {
            out.push({ kind: 'monohybrid', color: b }); continue;
          }
          if (MANA_COLORS.indexOf(a) >= 0 && MANA_COLORS.indexOf(b) >= 0) {
            out.push({ kind: 'hybrid', colors: [a, b] }); continue;
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
    const segRe = /Add\b([^.]*)/gi;
    let m;
    while ((m = segRe.exec(text)) !== null) {
      const seg = m[1];
      const symRe = /\{([^}]+)\}/g;
      let s;
      while ((s = symRe.exec(seg)) !== null) {
        const pip = s[1];
        if (/^[WUBRG]$/.test(pip)) { out.add(pip); continue; }
        if (pip.indexOf('/') >= 0) {
          for (const part of pip.split('/')) {
            if (MANA_COLORS.indexOf(part) >= 0) out.add(part);
          }
        }
      }
      if (/\bany\s+(?:one\s+)?color/i.test(seg) || /\bof\s+any\s+color\b/i.test(seg)) {
        for (const c of MANA_COLORS) out.add(c);
      }
    }
    return out;
  }


  const _poolPromises = new Map();

  function buildPool(data, staples, unplayable, version) {
    const info = new Map();
    const lookup = new Map();
    const bareBySetNum = new Map();
    const sets = Object.keys(data).sort();
    const allSetCodes = new Set(Object.keys(data));
    function stripBareV1(name) {
      const m = /^(.*)_([A-Z0-9]+)$/.exec(name);
      return m ? m[1] : name;
    }
    function stripBareV2(name) {
      while (name.includes('_')) {
        const i = name.lastIndexOf('_');
        const tail = name.slice(i + 1);
        if (allSetCodes.has(tail) || tail === 'PRO') name = name.slice(0, i);
        else break;
      }
      return name;
    }
    const stripBare = version === 1 ? stripBareV1 : stripBareV2;
    for (const s of sets) {
      if (s === 'REV') continue;
      const cards = (data[s] && data[s].cards) || [];
      const sortedCards = cards.slice().sort((a, b) => numKey(a.number).localeCompare(numKey(b.number)));
      for (const c of sortedCards) {
        const side = (c.side || '').toLowerCase();
        if (side === 'b' || side === 'back') continue;
        const full = (c.name || '').split(' // ', 2)[0];
        const bare = stripBare(full);
        if (BASIC_NAMES.indexOf(bare) >= 0) continue;
        bareBySetNum.set(s + '|' + String(c.number || ''), bare);
        let ci = 0;
        for (const col of (c.colorIdentity || [])) {
          if (COLOR_BIT[col]) ci |= COLOR_BIT[col];
        }
        const isLegalPrinting = ((c.legalities || {}).revolution === 'Legal');
        if (!info.has(bare)) {
          info.set(bare, {
            ci,
            set: s,
            num: String(c.number || ''),
            manaCost: c.manaCost || '',
            text: c.text || '',
            legal: isLegalPrinting,
            firstName: full,
          });
          lookup.set(bare, bare);
          lookup.set(full, bare);
        } else {
          const e = info.get(bare);
          e.ci |= ci;
          e.legal = e.legal || isLegalPrinting;
          lookup.set(full, bare);
        }
      }
    }
    const fullCanonical = Array.from(info.keys()).sort((a, b) => {
      const ia = info.get(a), ib = info.get(b);
      if (ia.set !== ib.set) return ia.set < ib.set ? -1 : 1;
      return numKey(ia.num).localeCompare(numKey(ib.num));
    });
    const nonBasicFullLen = fullCanonical.length;
    if (version === 2) {
      for (const b of BASIC_NAMES) fullCanonical.push(b);
    }
    const fullNameIndex = new Map();
    fullCanonical.forEach((b, i) => fullNameIndex.set(b, i));
    const legalCanonical = fullCanonical.slice(0, nonBasicFullLen).filter(
      b => info.get(b).legal && !unplayable.has(b));
    const legalNameIndex = new Map();
    legalCanonical.forEach((b, i) => legalNameIndex.set(b, i));
    return { fullCanonical, fullNameIndex, legalCanonical, legalNameIndex,
             info, lookup, staples, nonBasicFullLen, bareBySetNum, allSetCodes };
  }

  function buildLiveBridge(data) {
    const liveByName = new Set();
    const liveNameBySetNum = new Map();
    const liveSetNumByName = new Map();
    for (const s of Object.keys(data)) {
      const cards = (data[s] && data[s].cards) || [];
      for (const c of cards) {
        const side = (c.side || '').toLowerCase();
        if (side === 'b' || side === 'back') continue;
        const full = (c.name || '').split(' // ', 2)[0];
        if (!full) continue;
        const sn = s + '|' + String(c.number || '');
        liveByName.add(full);
        if (!liveNameBySetNum.has(sn)) liveNameBySetNum.set(sn, full);
        if (!liveSetNumByName.has(full)) liveSetNumByName.set(full, sn);
      }
    }
    return { liveByName, liveNameBySetNum, liveSetNumByName };
  }

  function parseStaples(text) {
    const out = new Set();
    if (!text) return out;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      out.add(line);
    }
    return out;
  }

  function parseRenames(text) {
    const fwd = new Map(); const back = new Map();
    if (!text) return { fwd, back };
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=>');
      if (i < 0) continue;
      const from = line.slice(0, i).trim();
      const to = line.slice(i + 2).trim();
      if (!from || !to) continue;
      if (!fwd.has(from)) fwd.set(from, to);
      if (!back.has(to)) back.set(to, from);
    }
    return { fwd, back };
  }

  function renameToLive(name, fwd, liveByName) {
    let cur = name; const seen = new Set([cur]);
    while (fwd.has(cur)) {
      cur = fwd.get(cur);
      if (seen.has(cur)) break;
      seen.add(cur);
      if (liveByName && liveByName.has(cur)) return cur;
    }
    return null;
  }

  function renameToFrozen(name, back, lookup) {
    let cur = name; const seen = new Set([cur]);
    while (back.has(cur)) {
      cur = back.get(cur);
      if (seen.has(cur)) break;
      seen.add(cur);
      if (lookup.has(cur)) return lookup.get(cur);
    }
    return null;
  }

  function numKey(n) {
    const s = String(n || '');
    const m = /^(\d+)([A-Za-z]*)$/.exec(s);
    if (m) return m[1].padStart(8, '0') + m[2];
    return '￿' + s;
  }

  async function ensurePool(version) {
    if (_poolPromises.has(version)) return _poolPromises.get(version);
    const p = (async () => {
      const [frozenResp, liveResp, staplesResp, unplayableResp, renamesResp] = await Promise.all([
        fetch('cards.frozen.json', { cache: 'force-cache' }),
        fetch('cards.json', { cache: 'force-cache' }).catch(() => null),
        fetch('staples.txt', { cache: 'force-cache' }),
        fetch('unplayable.txt', { cache: 'force-cache' }),
        fetch('renames.txt', { cache: 'force-cache' }).catch(() => null),
      ]);
      if (!frozenResp.ok) throw new Error('cards.frozen.json fetch failed');
      const data = (await frozenResp.json()).data || {};
      const staples = parseStaples(staplesResp.ok ? await staplesResp.text() : '');
      const unplayable = parseStaples(unplayableResp.ok ? await unplayableResp.text() : '');
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


  function isBasic(name) {
    const i = (name || '').indexOf('_');
    const head = i >= 0 ? name.slice(0, i) : name;
    return BASIC_NAMES.indexOf(head) >= 0 ? head : null;
  }

  function computeDeckMask(deckCards, info, lookup) {
    const producible = new Set();
    for (const e of deckCards) {
      if ((e.main + e.side) <= 0) continue;
      const b = isBasic(e.name);
      if (b) {
        producible.add('WUBRG'.charAt(BASIC_NAMES.indexOf(b)));
        continue;
      }
      const canon = lookup.get(e.name) || lookup.get(e.name.split('_')[0]);
      const c = canon ? info.get(canon) : null;
      if (c) for (const col of producibleColors(c.text)) producible.add(col);
    }
    const required = new Set();
    for (const e of deckCards) {
      if ((e.main + e.side) <= 0) continue;
      if (isBasic(e.name)) continue;
      const canon = lookup.get(e.name) || lookup.get(e.name.split('_')[0]);
      const c = canon ? info.get(canon) : null;
      if (!c) continue;
      for (const pip of parseManaCost(c.manaCost)) {
        if (pip.kind === 'mono') required.add(pip.color);
        else if (pip.kind === 'hybrid') {
          for (const col of pip.colors) if (producible.has(col)) required.add(col);
        }
      }
    }
    let mask = 0;
    for (const c of MANA_COLORS) if (producible.has(c) && required.has(c)) mask |= COLOR_BIT[c];
    return mask;
  }

  function playable(cost, mask) {
    for (const pip of parseManaCost(cost)) {
      if (pip.kind === 'mono') {
        if (!(mask & COLOR_BIT[pip.color])) return false;
      } else if (pip.kind === 'hybrid') {
        const [a, b] = pip.colors;
        if (!(mask & COLOR_BIT[a]) && !(mask & COLOR_BIT[b])) return false;
      }
    }
    return true;
  }

  function resolveCanon(name, pool) {
    const { lookup, info, bareBySetNum, liveSetNumByName, liveByName,
            allSetCodes, renameBack } = pool;
    const head = name.split('_')[0];
    let c = lookup.get(name) || lookup.get(head);
    if (c) return c;
    if (renameBack) {
      const b = renameToFrozen(name, renameBack, lookup)
             || renameToFrozen(head, renameBack, lookup);
      if (b) return b;
    }
    const sn = (liveSetNumByName && (liveSetNumByName.get(name) || liveSetNumByName.get(head)));
    if (sn && bareBySetNum.has(sn)) {
      const fbare = bareBySetNum.get(sn);
      const e = info && info.get(fbare);
      const fn = (e && e.firstName) || fbare;
      if (!liveByName || (!liveByName.has(fbare) && !liveByName.has(fn))) return fbare;
    }
    const m = /^(.*) \(([0-9A-Z]+)\)$/.exec(head);
    if (m && allSetCodes && allSetCodes.has(m[2])) {
      const base = lookup.get(m[1]);
      if (base) return base;
    }
    return null;
  }


  class BitWriter {
    constructor() { this.bits = []; }
    w(value, n) {
      for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    }
    writeBits(s) { for (const ch of s) this.bits.push(ch === '1' ? 1 : 0); }
    unary(n) { for (let i = 0; i < n; i++) this.bits.push(0); this.bits.push(1); }
    length() { return this.bits.length; }
  }

  function rice(bw, value, k) {
    bw.unary(value >> k);
    if (k) bw.w(value & ((1 << k) - 1), k);
  }

  function bitsToBytesWithFrontPad(bits) {
    const pad = (7 - bits.length % 8 + 8) % 8;
    const total = pad + 1 + bits.length;
    const out = new Uint8Array(total / 8);
    let pos = 0;
    function put(b) {
      const byteIx = pos >> 3, bitIx = 7 - (pos & 7);
      if (b) out[byteIx] |= 1 << bitIx;
      pos++;
    }
    for (let i = 0; i < pad; i++) put(0);
    put(1);
    for (const b of bits) put(b);
    return out;
  }

  function bytesToBase64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBytes(s) {
    const pad = (4 - s.length % 4) % 4;
    const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }


  async function encode(entries) {
    const pool = await ensurePool(VERSION);
    const { legalCanonical, legalNameIndex, fullNameIndex,
            info, lookup, staples, nonBasicFullLen } = pool;

    const basics = {};
    for (const b of BASIC_NAMES) basics[b] = [0, 0];
    const nonbasic = [];
    const unresolved = [];
    for (const e of entries) {
      const m = e.main || 0, s = e.side || 0;
      if (m + s <= 0) continue;
      const b = isBasic(e.name);
      if (b) { basics[b][0] += m; basics[b][1] += s; continue; }
      const canon = resolveCanon(e.name, pool);
      if (canon && info.has(canon)) nonbasic.push({ canon, main: m, side: s });
      else unresolved.push(e.name);
    }

    const maskInputs = [];
    for (const b of BASIC_NAMES) {
      if (basics[b][0] || basics[b][1]) {
        maskInputs.push({ name: b, main: basics[b][0], side: basics[b][1] });
      }
    }
    for (const nb of nonbasic) {
      maskInputs.push({ name: nb.canon, main: nb.main, side: nb.side });
    }
    const mask = computeDeckMask(maskInputs, info, lookup);

    const stapleSeg = []; const restSeg = [];
    for (let i = 0; i < legalCanonical.length; i++) {
      const name = legalCanonical[i];
      if (!playable(info.get(name).manaCost, mask)) continue;
      if (staples.has(name)) stapleSeg.push(i); else restSeg.push(i);
    }
    const newPool = stapleSeg.concat(restSeg);
    const legalToSegPos = new Map();
    newPool.forEach((legalIdx, segPos) => legalToSegPos.set(legalIdx, segPos));
    const nStapleInPool = stapleSeg.length;

    const seg1 = []; const seg2 = []; const appendix = [];
    for (const nb of nonbasic) {
      const legalIdx = legalNameIndex.has(nb.canon) ? legalNameIndex.get(nb.canon) : -1;
      if (legalIdx < 0 || !legalToSegPos.has(legalIdx)) {
        appendix.push([fullNameIndex.get(nb.canon), nb.main, nb.side]);
        continue;
      }
      const pos = legalToSegPos.get(legalIdx);
      const entry = [pos, nb.main, nb.side];
      (pos < nStapleInPool ? seg1 : seg2).push(entry);
    }
    for (let i = 0; i < BASIC_NAMES.length; i++) {
      const b = BASIC_NAMES[i];
      let mOver = Math.max(0, basics[b][0] - 15);
      let sOver = Math.max(0, basics[b][1] - 7);
      if (!mOver && !sOver) continue;
      const idx = nonBasicFullLen + i;
      while (mOver > 0) {
        const take = mOver >= 4 ? 4 : mOver;
        appendix.push([idx, take, 0]);
        mOver -= take;
      }
      while (sOver > 0) {
        const take = sOver >= 4 ? 4 : sOver;
        appendix.push([idx, 0, take]);
        sOver -= take;
      }
    }

    seg1.sort((a, b) => a[0] - b[0]);
    seg2.sort((a, b) => a[0] - b[0]);
    appendix.sort((a, b) => a[0] - b[0]);

    function gapsOf(picks, start) {
      const g = []; let prev = start - 1;
      for (const p of picks) { g.push(p[0] - prev - 1); prev = p[0]; }
      return g;
    }
    function bestK(gaps) {
      let bk = 0, best = Infinity;
      for (let k = 0; k < 15; k++) {
        let t = 0; for (const g of gaps) t += (g >>> k) + 1 + k;
        if (t < best) { best = t; bk = k; }
      }
      return bk;
    }
    const g1 = gapsOf(seg1, 0);
    const g2 = gapsOf(seg2, nStapleInPool);
    const k1 = g1.length ? bestK(g1) : 0;
    const k2 = g2.length ? bestK(g2) : 0;

    const bw = new BitWriter();
    bw.w(VERSION, 8);
    bw.w(mask, 5);
    bw.w(Math.min(seg1.length, 63), 6);
    bw.w(k1, 4);
    bw.w(k2, 4);
    let presence = 0;
    for (let i = 0; i < BASIC_NAMES.length; i++) {
      if (basics[BASIC_NAMES[i]][0] || basics[BASIC_NAMES[i]][1]) presence |= 1 << i;
    }
    bw.w(presence, 5);
    for (let i = 0; i < BASIC_NAMES.length; i++) {
      if (presence & (1 << i)) {
        bw.w(Math.min(basics[BASIC_NAMES[i]][0], 15), 4);
        bw.w(Math.min(basics[BASIC_NAMES[i]][1], 7), 3);
      }
    }
    let prev = -1;
    for (const [idx, m, s] of seg1) {
      rice(bw, idx - prev - 1, k1);
      bw.writeBits(MAIN_CODES[pairKey(m, s)]);
      prev = idx;
    }
    prev = nStapleInPool - 1;
    for (const [idx, m, s] of seg2) {
      rice(bw, idx - prev - 1, k2);
      bw.writeBits(MAIN_CODES[pairKey(m, s)]);
      prev = idx;
    }
    if (appendix.length) {
      rice(bw, 0, k2);
      bw.writeBits(MAIN_CODES[EOS]);
      for (const [fullIdx, m, s] of appendix) {
        bw.w(fullIdx, 13);
        bw.writeBits(APP_CODES[pairKey(m, s)]);
      }
    }

    const bytes = bitsToBytesWithFrontPad(bw.bits);
    const b64 = bytesToBase64url(bytes);
    return { b64, mask, basics,
             inPoolCount: seg1.length + seg2.length,
             stapleCount: seg1.length, restCount: seg2.length,
             appendixCount: appendix.length, unresolved };
  }


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

  async function decode(b64) {
    const bytes = base64urlToBytes(b64);
    const br = new BitReader(bytes);
    while (br.bits[br.pos] === 0) br.pos++;
    br.pos++;
    const version = br.read(8);
    if (version !== 1 && version !== 2) {
      throw new Error('unknown deck-URL version: ' + version);
    }
    const pool = await ensurePool(version);
    const { legalCanonical, fullCanonical, info, staples, nonBasicFullLen,
            lookup, liveByName, liveNameBySetNum, renameFwd } = pool;
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
      while (br.remaining() >= 14) {
        let fullIdx, sym;
        try {
          fullIdx = br.read(13);
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

  window.DeckUrl = { encode, decode, _ensurePool: ensurePool };
})();
