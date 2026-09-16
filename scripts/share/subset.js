import { exp } from './arithmetic.js';

const check = (v, m = 'Invalid subset') => { if (!v) throw Error(m); };

// Cards are visited in the learned order. At each step every remaining card
// gets one weight: prior odds, colour fit under the palette, legality, and
// relationships to cards already chosen. A suffix pass conditions on how many
// cards are still needed and rewards picks close to the previous one.
export function createSubsetModel(model, settings = {}) {
  const { strength = .35, decay = 1, gap = .4, color = .015, rotation = .025 } = settings;
  const ids = model.order, n = ids.length, position = new Int32Array(n);
  ids.forEach((id, i) => { position[id] = i; });
  const edges = model.edges.map(flat => {
    const out = [];
    for (let j = 0; j < flat.length; j += 2) out.push([position[flat[j]], flat[j + 1]]);
    return out;
  });
  const playable = (id, mask) => (model.cards[id].playMask >> mask) & 1;

  function run(io, k, mask, wanted) {
    check(k >= 0 && k <= n);
    const scores = new Float64Array(n);
    const base = Float64Array.from(ids, id => model.weights[id] / 4096 * (playable(id, mask) ? 1 : color));
    let start = 0, previous = -1, remaining = k, rotated = 0;
    const found = [];
    while (remaining) {
      if (remaining === n - start) {
        if (wanted) check(wanted.slice(k - remaining).every((i, j) => i === start + j));
        found.push(...ids.slice(start));
        break;
      }
      const weights = new Float64Array(n);
      for (let i = start; i < n; i++) {
        const legal = model.cards[ids[i]].legal ? 1 : Math.min(1, rotation + rotated * .25);
        weights[i] = base[i] * exp(Math.min(6, strength * scores[i])) * legal;
      }
      // Each cardinality column shares a scale that cancels in the next-card
      // distribution, so two columns cover every suffix sum.
      let dp = new Float64Array(n + 1).fill(1), column = new Float64Array(n + 1);
      for (let r = 1; r < remaining; r++) {
        column.fill(0);
        for (let i = n - r; i >= start; i--) {
          let z = dp[i + 1];
          if (gap) { z += 4 * gap * (dp[i + 1] - dp[Math.min(n, i + 3)]); z += gap * (dp[i + 1] - dp[Math.min(n, i + 17)]); }
          column[i] = column[i + 1] + weights[i] * Math.max(0, z);
        }
        const scale = column[start];
        check(scale > 0 && Number.isFinite(scale), 'Subset normalization');
        for (let i = start; i <= n - r; i++) column[i] /= scale;
        [dp, column] = [column, dp];
      }
      const end = n - remaining + 1, masses = new Float64Array(end - start);
      let total = 0;
      for (let i = start; i < end; i++) {
        let z = dp[i + 1];
        if (gap) { z += 4 * gap * (dp[i + 1] - dp[Math.min(n, i + 3)]); z += gap * (dp[i + 1] - dp[Math.min(n, i + 17)]); }
        const bonus = previous < 0 ? 1 : 1 + gap * (i - previous <= 16 ? 1 : 0) + 4 * gap * (i - previous <= 2 ? 1 : 0);
        const mass = weights[i] * Math.max(0, z) * bonus;
        masses[i - start] = mass;
        total += mass;
      }
      check(total > 0 && Number.isFinite(total), 'Subset normalization');
      let freqTotal = 0;
      const frequencies = Int32Array.from(masses, w => {
        const f = Math.max(1, Math.round(1073741824 * w / total));
        freqTotal += f;
        return f;
      });
      let pick, low = 0;
      if (wanted) {
        pick = wanted[k - remaining] - start;
        check(pick >= 0 && pick < frequencies.length);
        for (let i = 0; i < pick; i++) low += frequencies[i];
      } else {
        const v = Number(io.peek(freqTotal));
        pick = 0;
        while (low + frequencies[pick] <= v) low += frequencies[pick++];
      }
      io.interval(low, low + frequencies[pick], freqTotal);
      const selected = start + pick;
      found.push(ids[selected]);
      if (!model.cards[ids[selected]].legal) rotated++;
      for (let i = selected + 1; i < n; i++) scores[i] *= decay;
      for (const [i, w] of edges[ids[selected]]) if (i > selected) scores[i] += w;
      previous = selected;
      start = selected + 1;
      remaining--;
    }
    return found.sort((a, b) => a - b);
  }

  return {
    encode(io, selected, mask) {
      const ordered = selected.map(i => position[i]).sort((a, b) => a - b);
      run(io, ordered.length, mask, ordered);
    },
    decode(io, k, mask) { return run(io, k, mask); },
    bits(selected, mask) {
      let bits = 0;
      this.encode({ interval(a, b, r) { bits += Math.log2(r / (b - a)); } }, selected, mask);
      return bits;
    },
  };
}
