import { Encoder, Decoder, count, writeHeader, readHeader } from './arithmetic.js';
import { createSubsetModel } from './subset.js';
import { writeBasics, readBasics, quantities } from './quantities.js';

const check = (v, m = 'Invalid deck') => { if (!v) throw Error(m); };

export function createDeckCodec(model, settings = model.settings ?? {}) {
  const subset = createSubsetModel(model, settings), version = model.version;
  const playable = (id, mask) => (model.cards[id].playMask >> mask) & 1;
  let paletteMass;
  // The palette is the 5-bit colour mask under which the deck is cheapest to
  // describe; off-palette cards are allowed but improbable.
  function maskOf(deck) {
    const color = settings.color ?? .015, rotation = settings.rotation ?? .025;
    if (!paletteMass) {
      paletteMass = new Float64Array(32);
      for (let mask = 0; mask < 32; mask++) for (let id = 0; id < model.cards.length; id++) {
        paletteMass[mask] += model.weights[id] * (playable(id, mask) ? 1 : color) * (model.cards[id].legal ? 1 : rotation);
      }
    }
    let best = 0, score = Infinity;
    for (let mask = 0; mask < 32; mask++) {
      let loss = deck.cards.length * Math.log(paletteMass[mask]);
      for (const [id] of deck.cards) if (!playable(id, mask)) loss -= Math.log(color);
      if (loss < score) { score = loss; best = mask; }
    }
    return best;
  }
  return {
    encode(deck) {
      let previous = -1;
      for (const [id, m, s] of deck.cards) {
        check(Number.isInteger(id) && id > previous && id < model.cards.length);
        previous = id;
        check(Number.isSafeInteger(m) && Number.isSafeInteger(s) && m >= 0 && s >= 0 && m + s > 0);
      }
      check(deck.basics.length === 5);
      for (const pair of deck.basics) check(pair.length === 2 && pair.every(v => Number.isSafeInteger(v) && v >= 0));
      const e = new Encoder(), mask = maskOf(deck);
      writeHeader(e, version);
      e.int(mask, 32);
      count(e, model.sizes.nonbasic, deck.cards.length);
      writeBasics(e, deck.basics, model.basicTables, mask);
      subset.encode(e, deck.cards.map(([id]) => id), mask);
      quantities(e, deck.cards.map(([id]) => id), deck.basics, model, deck.cards);
      return e.finish();
    },
    decode(payload) {
      const d = payload instanceof Decoder ? payload : new Decoder(payload);
      if (!(payload instanceof Decoder)) check(readHeader(d) === version, 'Unknown model');
      const mask = Number(d.int(32)), n = count(d, model.sizes.nonbasic);
      check(n <= model.cards.length);
      const basics = readBasics(d, model.basicTables, mask), ids = subset.decode(d, n, mask);
      return { cards: quantities(d, ids, basics, model), basics };
    },
  };
}
