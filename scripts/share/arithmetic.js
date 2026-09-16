const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// v1-v3 payloads begin with pad zeros then a 1 bit, so their first two bits
// are at most '10'; arithmetic payloads begin with '11'.
const FRAME = 3;
const VERSION_ESCAPE = 63;

const assert = (value, message = 'Invalid arithmetic stream') => { if (!value) throw Error(message); };

export function symbol(io, weights, wanted) {
  const total = weights.reduce((a, b) => a + b, 0);
  let low = 0, index = wanted;
  if (index === undefined) {
    const v = Number(io.peek(total));
    index = 0;
    while (low + weights[index] <= v) low += weights[index++];
    assert(index < weights.length);
  } else {
    assert(Number.isInteger(index) && index >= 0 && index < weights.length);
    for (let i = 0; i < index; i++) low += weights[i];
  }
  io.interval(low, low + weights[index], total);
  return index;
}

// Learned count distribution; the last bucket escapes to a gamma code.
export function count(io, weights, value) {
  const cap = weights.length - 1;
  const v = symbol(io, weights, value === undefined ? undefined : Math.min(value, cap));
  if (v < cap) return v;
  if (value === undefined) return cap + io.gamma();
  io.gamma(value - cap);
  return value;
}

const memoComb = new Map();
export function comb(n, k) {
  if (k < 0 || k > n) return 0n;
  k = Math.min(k, n - k);
  if (!k) return 1n;
  const key = n * 8192 + k;
  if (memoComb.has(key)) return memoComb.get(key);
  let v = 1n;
  for (let j = 1; j <= k; j++) v = v * BigInt(n - k + j) / BigInt(j);
  memoComb.set(key, v);
  return v;
}

export function rankSubset(xs, n) {
  let rank = 0n, prev = -1;
  for (let j = 0; j < xs.length; j++) {
    assert(xs[j] > prev && xs[j] < n, 'invalid subset');
    rank += comb(xs[j], j + 1);
    prev = xs[j];
  }
  return rank;
}

export function unrankSubset(rank, n, k) {
  assert(rank >= 0n && rank < comb(n, k), 'subset rank');
  const xs = Array(k);
  for (let j = k; j > 0; j--) {
    let low = j - 1, high = n - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (comb(mid, j) <= rank) low = mid; else high = mid - 1;
    }
    xs[j - 1] = low;
    rank -= comb(low, j);
    n = low;
  }
  assert(rank === 0n);
  return xs;
}

// Exact arithmetic coding over BigInt intervals: no per-field rounding, byte
// padding or flush trailer. The payload is a base64url point inside the final
// interval, and the decoder reads back exactly that point.
export class Encoder {
  constructor() { this.l = 0n; this.h = 1n; this.d = 1n; }
  interval(a, b, r) {
    a = BigInt(a); b = BigInt(b); r = BigInt(r);
    assert(0n <= a && a < b && b <= r);
    if (a === 0n && b === r) return;
    const w = this.h - this.l, old = this.l;
    this.l = old * r + w * a;
    this.h = old * r + w * b;
    this.d *= r;
  }
  int(v, r) { v = BigInt(v); this.interval(v, v + 1n, r); }
  bit(v) { this.int(v ? 1 : 0, 2); }
  gamma(n) {
    assert(Number.isSafeInteger(n) && n >= 0 && n <= 1048575, 'count limit');
    const bits = (n + 1).toString(2);
    for (let i = 1; i < bits.length; i++) this.bit(0);
    for (const b of bits) this.bit(b === '1');
  }
  subset(xs, n) { this.int(rankSubset(xs, n), comb(n, xs.length)); }
  // Shortest string whose decoder midpoint lands inside [l, h).
  finish() {
    for (let chars = 1; ; chars++) {
      const scale = 1n << BigInt(6 * chars), denom = 2n * this.d;
      const numer = 2n * this.l * scale - this.d;
      let code = numer <= 0n ? 0n : (numer + denom - 1n) / denom;
      if (code < scale && (2n * code + 1n) * this.d < 2n * this.h * scale) {
        let s = '';
        for (let j = 0; j < chars; j++) { s = ALPHABET[Number(code & 63n)] + s; code >>= 6n; }
        return s;
      }
    }
  }
}

export class Decoder {
  constructor(str) {
    assert(typeof str === 'string' && str.length > 0 && str.length < 100000);
    let code = 0n;
    for (const c of str) {
      const i = ALPHABET.indexOf(c);
      assert(i >= 0);
      code = code * 64n + BigInt(i);
    }
    this.n = 2n * code + 1n;
    this.d = 1n << BigInt(6 * str.length + 1);
  }
  peek(r) { return this.n * BigInt(r) / this.d; }
  interval(a, b, r) {
    a = BigInt(a); b = BigInt(b); r = BigInt(r);
    if (a === 0n && b === r) return;
    this.n = this.n * r - this.d * a;
    this.d *= b - a;
    assert(this.n >= 0n && this.n < this.d);
  }
  int(r) { const v = this.peek(r); assert(v < BigInt(r)); this.interval(v, v + 1n, r); return v; }
  bit() { return Number(this.int(2)); }
  gamma() {
    let z = 0;
    while (!this.bit()) { z++; assert(z <= 20); }
    let v = 1;
    for (let j = 0; j < z; j++) v = v * 2 + this.bit();
    return v - 1;
  }
  subset(n, k) { return unrankSubset(this.int(comb(n, k)), n, k); }
}

export function isArithmeticFrame(payload) {
  const first = ALPHABET.indexOf(payload[0]);
  return first >= 0 && (first >> 4) === FRAME;
}

export function writeHeader(e, version) {
  assert(Number.isInteger(version) && version >= 0, 'bad version');
  e.int(FRAME, 4);
  if (version < VERSION_ESCAPE) e.int(version, 64);
  else { e.int(VERSION_ESCAPE, 64); e.gamma(version - VERSION_ESCAPE); }
}

export function readHeader(d) {
  assert(Number(d.int(4)) === FRAME, 'Not a share payload');
  let version = Number(d.int(64));
  if (version === VERSION_ESCAPE) version += d.gamma();
  return version;
}

// exp built from basic IEEE operations only, so encoder and decoder compute
// identical frequencies on every JS engine: exp(x) = 2^k * exp(r).
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
export function exp(x) {
  if (x > 700) return Infinity;
  if (x < -700) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2;
  let term = 1, sum = 1;
  for (let i = 1; i <= 14; i++) { term = term * r / i; sum += term; }
  let scale = 1;
  const step = k >= 0 ? 2 : 0.5;
  for (let i = 0; i < Math.abs(k); i++) scale *= step;
  return sum * scale;
}
