import { Encoder, Decoder } from './arithmetic.js';

// Field Test decks: a uniform subset of an append-only name list, with gamma
// counts. Version v decodes against the first versions[v] names, so links
// survive the list growing.
export function createFieldDeckUrl(pool) {
  const { names, versions } = pool;
  if (!Array.isArray(names) || !Array.isArray(versions) || !versions.length) throw Error('Invalid Field Test share list');
  const version = versions.length - 1, size = versions[version];
  const index = new Map();
  names.slice(0, size).forEach((n, i) => { if (!index.has(n)) index.set(n, i); });

  return {
    version,
    encode(entries) {
      const rows = new Map(), unresolved = [];
      for (const { names: printings, main = 0, side = 0 } of entries) {
        if (!Array.isArray(printings) || !printings.length
            || !Number.isSafeInteger(main) || !Number.isSafeInteger(side) || main < 0 || side < 0) {
          throw Error('Invalid card name or count');
        }
        if (!main && !side) continue;
        let at;
        for (const n of printings) {
          const i = index.get(n);
          if (i !== undefined && (at === undefined || i < at)) at = i;
        }
        if (at === undefined) { unresolved.push(printings[0]); continue; }
        const row = rows.get(at) ?? [at, 0, 0];
        row[1] += main; row[2] += side;
        rows.set(at, row);
      }
      if (unresolved.length) throw Error('Not in the Field Test share list yet: ' + unresolved.join(', '));
      const cards = [...rows.values()].sort((a, b) => a[0] - b[0]);
      const e = new Encoder();
      e.gamma(version);
      e.gamma(cards.length);
      e.subset(cards.map(r => r[0]), size);
      for (const [, main, side] of cards) {
        e.gamma(main);
        e.gamma(main ? side : side - 1);
      }
      return { b64: e.finish(), version };
    },
    decode(payload) {
      if (typeof payload !== 'string' || !payload) throw Error('Invalid share payload');
      const d = new Decoder(payload);
      const v = d.gamma();
      if (v >= versions.length) throw Error('Unknown Field Test share version ' + v);
      const n = versions[v], k = d.gamma();
      if (k > n) throw Error('Invalid share payload');
      const cards = {};
      for (const i of d.subset(n, k)) {
        const main = d.gamma(), side = d.gamma() + (main ? 0 : 1);
        cards[names[i]] = { main, side };
      }
      return { version: v, cards };
    },
  };
}
