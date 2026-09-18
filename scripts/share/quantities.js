import { count, symbol } from './arithmetic.js';

const POPCOUNT = Array.from({ length: 32 }, (_, n) => n.toString(2).replaceAll('0', '').length);
const PAIRS = [[3,0],[4,0],[1,0],[2,0],[0,2],[0,3],[0,4],[0,1],[1,2],[2,2],[1,1],[1,3],[2,1],[3,1]];
const check = (v, m = 'Invalid quantities') => { if (!v) throw Error(m); };

// With learned tables (model.basicTables) the presence pattern, a sideboard
// flag and each count are arithmetic-coded; without them the layout is the
// original 5-bit presence word plus gamma counts. Presence may be conditioned
// on the palette and the main count on how many basic colours are present.
export function writeBasics(io, basics, tables, mask) {
  const presence = basics.reduce((m, [a, b], i) => m | ((a + b ? 1 : 0) << i), 0);
  if (!tables) {
    io.int(presence, 32);
    for (const [m, s] of basics) if (m + s) { io.gamma(m); io.gamma(s); }
    return;
  }
  symbol(io, tables.presenceByPalette?.[mask] ?? tables.presence, presence);
  if (!presence) return;
  const side = Number(basics.some(([, s]) => s > 0));
  symbol(io, tables.anySide, side);
  const mainTable = tables.mainByColors?.[POPCOUNT[presence] - 1] ?? tables.main;
  for (const [m, s] of basics) if (m + s) {
    count(io, mainTable, m);
    if (side) count(io, tables.side, s);
  }
}

export function readBasics(io, tables, mask) {
  if (!tables) {
    const presence = Number(io.int(32));
    return Array.from({ length: 5 }, (_, i) => presence & (1 << i) ? [io.gamma(), io.gamma()] : [0, 0]);
  }
  const presence = symbol(io, tables.presenceByPalette?.[mask] ?? tables.presence);
  if (!presence) return Array.from({ length: 5 }, () => [0, 0]);
  const side = symbol(io, tables.anySide);
  const mainTable = tables.mainByColors?.[POPCOUNT[presence] - 1] ?? tables.main;
  return Array.from({ length: 5 }, (_, i) =>
    presence & (1 << i) ? [count(io, mainTable), side ? count(io, tables.side) : 0] : [0, 0]);
}

// One function for both directions: `entries` present means encode.
export function quantities(io, ids, basics, model, entries) {
  const encode = entries !== undefined, n = ids.length;
  const basicMain = basics.reduce((s, c) => s + c[0], 0), basicSide = basics.reduce((s, c) => s + c[1], 0);
  let main = count(io, model.sizes.main, encode ? entries.reduce((s, c) => s + c[1], 0) + basicMain : undefined) - basicMain;
  let side = count(io, model.sizes.side, encode ? entries.reduce((s, c) => s + c[2], 0) + basicSide : undefined) - basicSide;
  check(main >= 0 && side >= 0);
  const result = new Map();
  // Cards with more than four copies escape to explicit gamma counts.
  let large = encode ? entries.map(([, m, s], i) => m + s > 4 ? i : -1).filter(i => i >= 0) : [];
  let hasLarge;
  if (model.largeFlag) hasLarge = symbol(io, model.largeFlag, encode ? Number(large.length > 0) : undefined);
  else if (encode) { hasLarge = Number(large.length > 0); io.bit(hasLarge); }
  else hasLarge = io.bit();
  if (hasLarge) {
    if (encode) { io.gamma(large.length - 1); io.subset(large, n); }
    else large = io.subset(n, io.gamma() + 1);
    for (const i of large) {
      const m = encode ? entries[i][1] : io.gamma(), s = encode ? entries[i][2] : io.gamma();
      if (encode) { io.gamma(m); io.gamma(s); }
      check(m + s > 4);
      result.set(ids[i], [ids[i], m, s]);
      main -= m; side -= s;
    }
  }
  const ordinary = ids.filter(id => !result.has(id));
  const weights = ordinary.map(id => model.quantity[id].map(BigInt));
  const memo = new Map(), width = side + 1, height = main + 1;
  function W(j, m, s) {
    if (m < 0 || s < 0 || m + s < ordinary.length - j || m + s > 4 * (ordinary.length - j)) return 0n;
    if (j === ordinary.length) return BigInt(m === 0 && s === 0);
    const key = (j * height + m) * width + s;
    if (memo.has(key)) return memo.get(key);
    let z = 0n;
    for (let a = 0; a < PAIRS.length; a++) { const [x, y] = PAIRS[a]; z += weights[j][a] * W(j + 1, m - x, s - y); }
    memo.set(key, z);
    return z;
  }
  const wanted = encode ? new Map(entries.map(row => [row[0], row])) : null;
  for (let j = 0; j < ordinary.length; j++) {
    const mass = W(j, main, side);
    check(mass > 0n);
    let pick, low = 0n;
    if (encode) {
      const [, m, s] = wanted.get(ordinary[j]);
      pick = PAIRS.findIndex(([a, b]) => a === m && b === s);
      check(pick >= 0);
      for (let a = 0; a < pick; a++) { const [x, y] = PAIRS[a]; low += weights[j][a] * W(j + 1, main - x, side - y); }
    } else {
      const v = io.peek(mass);
      pick = 0;
      while (pick < PAIRS.length) {
        const [a, b] = PAIRS[pick], w = weights[j][pick] * W(j + 1, main - a, side - b);
        if (v < low + w) break;
        low += w;
        pick++;
      }
      check(pick < PAIRS.length);
    }
    const [m, s] = PAIRS[pick], w = weights[j][pick] * W(j + 1, main - m, side - s);
    io.interval(low, low + w, mass);
    main -= m; side -= s;
    result.set(ordinary[j], [ordinary[j], m, s]);
  }
  check(main === 0 && side === 0);
  return ids.map(id => result.get(id));
}
