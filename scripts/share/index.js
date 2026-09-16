import { Decoder, isArithmeticFrame, readHeader } from './arithmetic.js';
import { createDeckCodec } from './codec.js';
import { decodeLegacy } from './legacy.js';
import { BASIC_NAMES, parseRenames } from './catalog.js';

export const VERSION = 4;
export const modelPath = version => `share/v${version}/model.json`;

// Shipped models store each card as [name, firstName, set, ci, legal, playMask]
// and quantity rows through a shared table; expand to the runtime shape.
export function expandModel(packed) {
  const cards = packed.cards.map(([name, firstName, set, ci, legal, playMask]) =>
    ({ name, firstName: firstName || name, set, ci, legal: !!legal, playMask }));
  const quantity = packed.quantity.map(i => packed.quantityTable[i]);
  return { ...packed, cards, quantity };
}

export function createDeckUrl(model, { renames = '', loadModel = null } = {}) {
  const codec = createDeckCodec(model);
  const { fwd: renameFwd, back: renameBack } = parseRenames(renames);
  const sets = new Set(model.sets);
  const names = new Map();
  model.cards.forEach((c, i) => { names.set(c.name, i); names.set(c.firstName, i); });
  for (const [alias, canon] of Object.entries(model.aliases || {})) {
    if (names.has(canon) && !names.has(alias)) names.set(alias, names.get(canon));
  }
  const basicAliases = model.basicAliases || {};
  const others = new Map();

  function bare(name) {
    while (name.includes('_')) {
      const at = name.lastIndexOf('_'), suffix = name.slice(at + 1);
      if (!sets.has(suffix) && suffix !== 'PRO') break;
      name = name.slice(0, at);
    }
    return name;
  }
  function lookup(name) {
    return names.get(name) ?? names.get(bare(name));
  }
  function resolve(name) {
    let id = lookup(name);
    if (id !== undefined) return id;
    // Renamed cards: the model may predate the rename (walk back) or the
    // decklist may use a name older than the model (walk forward).
    for (const ledger of [renameBack, renameFwd]) {
      let cur = name;
      const seen = new Set([cur]);
      while (ledger.has(cur)) {
        cur = ledger.get(cur);
        if (seen.has(cur)) break;
        seen.add(cur);
        id = lookup(cur);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }
  function currentName(name) {
    let cur = name;
    const seen = new Set([cur]);
    while (renameFwd.has(cur)) {
      cur = renameFwd.get(cur);
      if (seen.has(cur)) break;
      seen.add(cur);
    }
    return cur;
  }
  function basicOf(name) {
    const b = basicAliases[name] ?? basicAliases[bare(name)] ?? bare(name);
    return BASIC_NAMES.includes(b) ? b : null;
  }
  function present(deck, cards) {
    return {
      version: cards.version,
      cards: Object.fromEntries(deck.cards.map(([id, main, side]) => [currentName(cards.cards[id].firstName), { main, side }])),
      basics: Object.fromEntries(BASIC_NAMES.map((name, i) => [name, deck.basics[i]])),
    };
  }
  async function modelFor(version) {
    if (version === model.version) return { model, codec };
    if (!loadModel) throw Error('Unknown share URL version ' + version);
    if (!others.has(version)) {
      others.set(version, Promise.resolve(loadModel(version)).then(packed => {
        const m = expandModel(packed);
        if (m.version !== version) throw Error('Share model mismatch for version ' + version);
        return { model: m, codec: createDeckCodec(m) };
      }));
    }
    return others.get(version);
  }

  return {
    async encode(entries) {
      const counts = new Map(), basics = BASIC_NAMES.map(() => [0, 0]), unresolved = [];
      for (const { name, main = 0, side = 0 } of entries) {
        if (typeof name !== 'string' || !Number.isSafeInteger(main) || !Number.isSafeInteger(side) || main < 0 || side < 0) {
          throw Error('Invalid card name or count');
        }
        if (!main && !side) continue;
        const b = basicOf(name);
        if (b) { const pair = basics[BASIC_NAMES.indexOf(b)]; pair[0] += main; pair[1] += side; continue; }
        const id = resolve(name);
        if (id === undefined) { unresolved.push(name); continue; }
        const row = counts.get(id) ?? [id, 0, 0];
        row[1] += main; row[2] += side;
        counts.set(id, row);
      }
      if (unresolved.length) throw Error('Not in the share catalog yet: ' + unresolved.join(', '));
      const deck = { cards: [...counts.values()].sort((a, b) => a[0] - b[0]), basics };
      return { b64: codec.encode(deck), unresolved, version: model.version };
    },
    async decode(payload) {
      if (typeof payload !== 'string' || !payload) throw Error('Invalid share payload');
      if (!isArithmeticFrame(payload)) return decodeLegacy(payload);
      const d = new Decoder(payload), version = readHeader(d);
      const target = await modelFor(version);
      return present(target.codec.decode(d), target.model);
    },
  };
}
