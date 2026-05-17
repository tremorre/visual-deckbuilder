// Deck-URL codec. Compresses a Revolution-format decklist into a short
// base64url string suitable for sharing as `#d=…`. Matches the Python
// reference encoder in scratch/url_deck/encode_v3.py byte-for-byte; if you
// change the scheme here, change it there too.
//
// ════════════════════════════════════════════════════════════════════
// FORMAT FROZEN — version 1, locked 2026-05-07.
//
// Do not change the bit layout, MAIN_CODES/APP_CODES, the pool
// definition (legal AND NOT unplayable from cards.json + unplayable.txt),
// or staples.txt without coordinating a version bump. Doing so breaks
// every URL ever shared.
//
// Regression test: scratch/url_deck/test_freeze.py — re-encodes the
// 104-deck rev_26_05 corpus and compares byte-for-byte against
// scratch/url_deck/corpus_urls.txt.
// JS↔Python parity: scratch/url_deck/verify_js.mjs.
// ════════════════════════════════════════════════════════════════════
//
// Stream layout (bits):
//   [front pad: 0..7 zero bits + 1 marker]   makes total byte-aligned
//   [8: version=1]
//   [5: color mask, WUBRG]
//   [6: n_staples_picked]                  count for staple segment
//   [4: k1] [4: k2]                        Rice k for each segment
//   [5: basic-presence mask P/I/S/M/F]
//   [for each present basic: 4 main + 3 side]
//   [staple seg: n_staples × (Rice(k1) gap + Huffman count)]
//   [rest seg: (Rice(k2) gap + Huffman count) × repeat, terminated by EOS
//              or end-of-bytes if no appendix]
//   [optional appendix: 13-bit absolute full-pool index + Huffman count,
//     repeats until end-of-bytes]
//
// Pool: only cards with legalities['revolution']==='Legal' on at least one
// printing. Frozen at format-launch from cards.json's legalities field.
// Within the legal pool, two segments:
//   1. staples (cards listed in static/staples.txt) in canonical (set, num)
//   2. remaining legal cards in canonical order
// Each segment gets its own Rice k optimized for its gap density.
//
// staples.txt is part of the format spec — frozen at launch. Editing it
// breaks all previously-encoded URLs. The labeling app (static/label.html)
// is the supported way to draft additions before format-freeze.
(function () {
  'use strict';

  // Encoder always emits v2. The decoder accepts both v1 and v2, dispatching
  // to a version-specific pool so URLs shared from the pre-v2 deckbuilder
  // continue to round-trip. v1 ≡ single-pass bare-name strip + no basic
  // overflow in the appendix (the broken EOS encoder lived here, but its
  // output is still bit-readable when the appendix's first bit happens to be
  // `1` — the cases where it isn't were never decodable to begin with).
  // v2 ≡ multi-pass strip (so `Foo_PRO_KDT` collapses to bare `Foo`) + basics
  // appended to fullCanonical at indices N..N+4 for overflow + EOS rice pad.
  const VERSION = 2;
  const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_BIT = { W: 1, U: 2, B: 4, R: 8, G: 16 };
  const BASIC_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const BASIC_BIT = { Plains: 1, Island: 2, Swamp: 4, Mountain: 8, Forest: 16 };
  const EOS = 'EOS';

  // Canonical Huffman codes derived from the rev_26_05 corpus (104 decks,
  // 2371 in-pool entries, 6 appendix-using decks). See build_huffman.py.
  // Symbols are "main,side" pair strings; EOS is the appendix sentinel.
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

  // ------------------------------------------------------------------------
  // Mana cost parsing — mirrors league.js parseManaCost / Python parse_mana_cost.

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

  // ------------------------------------------------------------------------
  // Card pool — load cards.json + staples.txt. Cached after first build.

  // Cached pool per version (v1 for legacy decode, v2 for encode + decode).
  const _poolPromises = new Map();

  // Builds the canonical card data structures the encoder/decoder share.
  // The legal-pool is the gap-stream's universe; the full-pool is used by
  // the appendix for 13-bit absolute indices so any card can still be encoded.
  function buildPool(data, staples, unplayable, version) {
    const info = new Map();
    const lookup = new Map();
    const sets = Object.keys(data).sort();
    // Bare-name strip semantics differ by version. v1 strips one trailing
    // `_<ALNUM>` only — leaves phantom bares like `Foo_PRO` when the actual
    // printing is `Foo_PRO_KDT`. v2 strips repeatedly, honouring every
    // cards.json set code AND `_PRO` (matching app.js's canonicalName) so
    // every printing of a card lands at the same pool index and produces the
    // same URL.
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
            // The cards.json printing name first encountered for this bare.
            // Used as the decoder's output name so alt-art / set-only printings
            // (e.g. `Swamp Romantic_DOV`, whose stripped bare `Swamp Romantic`
            // matches no `STATE.byName` key) re-import cleanly. For bares whose
            // first printing is the base name (no `_SET`/parens/word suffix),
            // firstName == bare so output is unchanged from the pre-fix codec.
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
    // v2 only: append the 5 basic names at indices N..N+4 so the appendix
    // can encode basic overflows (>15 main or >7 side per basic — the
    // header's 4+3-bit counts top out there). In v1 there are no
    // basic-overflow appendix entries (and the pool has no slot for them),
    // so basics live only in the header.
    const nonBasicFullLen = fullCanonical.length;
    if (version === 2) {
      for (const b of BASIC_NAMES) fullCanonical.push(b);
    }
    const fullNameIndex = new Map();
    fullCanonical.forEach((b, i) => fullNameIndex.set(b, i));
    // The gap-coded legal pool excludes freeze-time illegal cards AND
    // user-marked unplayable cards (still encode via appendix on rare picks).
    // Only the non-basic prefix participates — basics live at the tail of
    // fullCanonical purely for appendix overflow indexing.
    const legalCanonical = fullCanonical.slice(0, nonBasicFullLen).filter(
      b => info.get(b).legal && !unplayable.has(b));
    const legalNameIndex = new Map();
    legalCanonical.forEach((b, i) => legalNameIndex.set(b, i));
    return { fullCanonical, fullNameIndex, legalCanonical, legalNameIndex,
             info, lookup, staples, nonBasicFullLen };
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

  // Sort key for card numbers: pad numeric prefix to fixed width so "10"
  // sorts after "2", and append the alpha suffix so "162a" < "162b".
  function numKey(n) {
    const s = String(n || '');
    const m = /^(\d+)([A-Za-z]*)$/.exec(s);
    if (m) return m[1].padStart(8, '0') + m[2];
    return '￿' + s;
  }

  async function ensurePool(version) {
    if (_poolPromises.has(version)) return _poolPromises.get(version);
    const p = (async () => {
      const [cardsResp, staplesResp, unplayableResp] = await Promise.all([
        fetch('cards.json', { cache: 'force-cache' }),
        fetch('staples.txt', { cache: 'force-cache' }),
        fetch('unplayable.txt', { cache: 'force-cache' }),
      ]);
      if (!cardsResp.ok) throw new Error('cards.json fetch failed');
      const data = (await cardsResp.json()).data || {};
      const staples = parseStaples(staplesResp.ok ? await staplesResp.text() : '');
      const unplayable = parseStaples(unplayableResp.ok ? await unplayableResp.text() : '');
      return buildPool(data, staples, unplayable, version);
    })();
    _poolPromises.set(version, p);
    return p;
  }

  // ------------------------------------------------------------------------
  // Color identity (deck-level): producible ∩ required, hybrids resolved by
  // producibility. Both main and side included.

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
      // phyrexian / monohybrid / generic always payable
    }
    return true;
  }

  // ------------------------------------------------------------------------
  // Bit writer / reader

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

  // Pack a bit array with front-pad framing so the result is byte-aligned.
  // Pad layout: (0..7 zero bits) + (1 marker bit) + bits.
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
    put(1); // marker
    for (const b of bits) put(b);
    return out;
  }

  // base64url encode (no padding).
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

  // ------------------------------------------------------------------------
  // Encode

  // entries: [{ name, main, side }]   — name is the cards.json suffixed canonical form
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
      const canon = lookup.get(e.name) || lookup.get(e.name.split('_')[0]);
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

    // Filter the legal pool by the deck color mask, then split into staple
    // and rest segments (canonical order within each).
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

    // Partition picks across (staple, rest, appendix).
    const seg1 = []; const seg2 = []; const appendix = [];
    for (const nb of nonbasic) {
      const legalIdx = legalNameIndex.has(nb.canon) ? legalNameIndex.get(nb.canon) : -1;
      if (legalIdx < 0 || !legalToSegPos.has(legalIdx)) {
        // Off-color or freeze-time-illegal — go to appendix using full-pool index.
        appendix.push([fullNameIndex.get(nb.canon), nb.main, nb.side]);
        continue;
      }
      const pos = legalToSegPos.get(legalIdx);
      const entry = [pos, nb.main, nb.side];
      (pos < nStapleInPool ? seg1 : seg2).push(entry);
    }
    // Basic overflow: header bits cap each basic at 15 main / 7 side; emit
    // the remainder via appendix entries using the per-basic full-pool index
    // (placed at nonBasicFullLen + basicIndex when the pool was built).
    // Each appendix entry carries up to 4 main or 4 side via the Huffman
    // pair table — chunk overflow into the biggest pair that fits.
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

    // Per-segment optimal Rice k.
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

    // Emit.
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
      // The decoder reads each rest entry as rice(gap)+huffman(sym); when it
      // hits EOS it switches to the appendix. Naively writing just the 9-bit
      // EOS code lets the decoder's rice consume the first `1` (unary
      // terminator) and re-read the remaining 8 ones + the appendix's first
      // bit as the 9-bit code `111111110` (= sym '1,3'), missing EOS.
      // Pad with a discarded rice gap of 0 so rice consumes the padding and
      // huffman reads the full EOS code.
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

  // ------------------------------------------------------------------------
  // Decode

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
      table.set(parseInt(bits, 2) | (1 << bits.length), sym); // tag with sentinel bit
      if (bits.length > maxLen) maxLen = bits.length;
    }
    return { table, maxLen };
  }

  function huffmanDecodeOne(br, hd) {
    let val = 1; // sentinel bit
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
    br.pos++; // marker
    const version = br.read(8);
    if (version !== 1 && version !== 2) {
      throw new Error('unknown deck-URL version: ' + version);
    }
    const pool = await ensurePool(version);
    const { legalCanonical, fullCanonical, info, staples, nonBasicFullLen } = pool;
    // Output the first cards.json printing name we saw for each bare, falling
    // back to the bare itself. Fixes round-trip for cards whose stripped bare
    // doesn't match any byName key (e.g. `Swamp Romantic_DOV` → bare
    // `Swamp Romantic`, which is not a real printing). Applies to both
    // versions — strictly improves re-importability without changing bytes.
    const nameOut = (bare) =>
      (info.has(bare) && info.get(bare).firstName) || bare;
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

    // Reconstruct the same filtered + segmented pool the encoder used.
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
    // Read exactly nStaplesPicked from the staple segment.
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
    // Rest segment: keep reading until EOS or end of bits.
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
          // Basic-overflow entry: accumulate onto the basics counter so the
          // header's (clamped) main/side and any number of overflow entries
          // sum to the original count.
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

  // Public API.
  window.DeckUrl = { encode, decode, _ensurePool: ensurePool };
})();
