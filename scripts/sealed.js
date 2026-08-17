(function () {
  'use strict';

  const DRAND = {
    genesis: 1595431050,
    period: 30,
    mirrors: [
      'https://api.drand.sh',
      'https://api2.drand.sh',
      'https://api3.drand.sh',
      'https://drand.cloudflare.com',
    ],
  };

  const PACKS = 6;

  // averaged main-set odds from the Collecting articles for TDM, EOE, TLA, ECL,
  // normalized to sum to 100% (basis points)
  const WILDCARD_WEIGHTS      = { common: 1276, uncommon: 6832, rare: 1676, mythic: 216 };
  const FOIL_WILDCARD_WEIGHTS = { common: 5873, uncommon: 3347, rare: 667,  mythic: 113 };

  const BOOSTER_TYPES = {
    draft: { commons: 10, uncommons: 3, rareMythics: 1, wildcards: [], lands: 1 },
    play:  { commons: 7,  uncommons: 3, rareMythics: 1,
             wildcards: [WILDCARD_WEIGHTS, FOIL_WILDCARD_WEIGHTS], lands: 1 },
  };
  // tentative: sets before TWI use draft boosters, TWI and later use play boosters
  const DRAFT_BOOSTER_SETS = new Set(['VST', 'SRC', 'MON', 'KUT', 'GQC', 'SVG', 'VRD',
    'KRS', 'KSV', 'BLR', 'DOV', 'POP', 'TRX', 'OLD', 'CYB', 'CNY', 'CCR', 'ERR', 'KDT',
    'REV', 'PLANE']);
  const DEFAULT_BOOSTER_TYPE = 'play';

  function boosterTypeFor(set) {
    return DRAFT_BOOSTER_SETS.has(set) ? 'draft' : DEFAULT_BOOSTER_TYPE;
  }

  function parseTimestamp(raw) {
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    let s = raw;
    // bare ISO times are pinned to UTC so every client maps to the same round
    if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error('unparseable timestamp: ' + raw);
    return ms;
  }

  function parseFragment(hash) {
    if (!hash.startsWith('#sealed=')) return null;
    const parts = hash.slice('#sealed='.length).split(':');
    if (parts.length < 3) {
      throw new Error('expected #sealed=SET:username:timestamp');
    }
    const set = decodeURIComponent(parts[0]).trim().toUpperCase();
    const username = decodeURIComponent(parts[1]).trim();
    const rawTime = parts.slice(2).join(':');
    if (!set) throw new Error('empty set code');
    if (!username) throw new Error('empty username');
    return { set, username, unlockMs: parseTimestamp(rawTime) };
  }

  function roundFor(unlockMs) {
    const t = Math.ceil(unlockMs / 1000);
    if (t <= DRAND.genesis) return 1;
    return Math.ceil((t - DRAND.genesis) / DRAND.period) + 1;
  }

  function roundTimeMs(round) {
    return (DRAND.genesis + (round - 1) * DRAND.period) * 1000;
  }

  async function fetchBeacon(round) {
    let lastErr = null;
    for (const base of DRAND.mirrors) {
      try {
        const res = await fetch(base + '/public/' + round);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + base);
        const body = await res.json();
        if (!body || typeof body.randomness !== 'string' || Number(body.round) !== round) {
          throw new Error('malformed beacon response from ' + base);
        }
        return body.randomness.toLowerCase();
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('could not reach the drand randomness beacon (' +
      (lastErr && lastErr.message ? lastErr.message : lastErr) + ')');
  }

  async function deriveSeed(randomnessHex, set, username, round) {
    const material = [
      'rev-sealed-v0',
      randomnessHex.toLowerCase(),
      set.toUpperCase(),
      username.trim().toLowerCase(),
      String(round),
    ].join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
    return new Uint8Array(digest);
  }

  class HashStream {
    constructor(seedBytes) {
      this.seed = seedBytes;
      this.counter = 0;
      this.buf = null;
      this.pos = 0;
    }
    async _refill() {
      const block = new Uint8Array(this.seed.length + 4);
      block.set(this.seed, 0);
      new DataView(block.buffer).setUint32(this.seed.length, this.counter++, false);
      this.buf = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
      this.pos = 0;
    }
    async nextUint32() {
      if (!this.buf || this.pos + 4 > this.buf.length) await this._refill();
      const v = new DataView(this.buf.buffer).getUint32(this.pos, false);
      this.pos += 4;
      return v;
    }
    async nextInt(n) {
      // rejection sampling keeps the draw uniform in [0, n)
      const limit = Math.floor(0x100000000 / n) * n;
      for (;;) {
        const v = await this.nextUint32();
        if (v < limit) return v % n;
      }
    }
  }

  async function sampleWithoutReplacement(arr, k, stream) {
    const a = arr.slice();
    for (let i = 0; i < k; i++) {
      const j = i + await stream.nextInt(a.length - i);
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a.slice(0, k);
  }

  function classifySetCards(cards, set) {
    const pools = { common: [], uncommon: [], rare: [], mythic: [], basicLand: [], commonLand: [] };
    const seenNames = new Set();
    for (const c of cards) {
      if (c.set !== set || seenNames.has(c.name)) continue;
      const isLand = Array.isArray(c.types)
        ? c.types.includes('Land')
        : /\bLand\b/.test(c.type || '');
      let bucket = null;
      if (c.rarity === 'basic' && isLand) bucket = 'basicLand';
      else if (c.rarity === 'common' && isLand) bucket = 'commonLand';
      else if (pools[c.rarity] && c.rarity !== 'basicLand' && c.rarity !== 'commonLand') bucket = c.rarity;
      if (!bucket || !pools[bucket]) continue;
      seenNames.add(c.name);
      pools[bucket].push(c);
    }
    // canonical order: codepoint compare on name — locale- and id-scheme-independent
    for (const k of Object.keys(pools)) {
      pools[k].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      pools[k] = pools[k].map(c => c.id);
    }
    return pools;
  }

  async function drawUnique(pool, picked, stream) {
    for (let tries = 0; tries < 50; tries++) {
      const id = pool[await stream.nextInt(pool.length)];
      if (!picked.has(id)) return id;
    }
    for (const id of pool) if (!picked.has(id)) return id;
    throw new Error('card pool exhausted');
  }

  async function drawRareMythic(pools, picked, stream) {
    // each mythic shows up half as often as each rare
    const useMythic = pools.mythic.length > 0 &&
      (await stream.nextInt(pools.mythic.length + 2 * pools.rare.length)) < pools.mythic.length;
    return drawUnique(useMythic ? pools.mythic : pools.rare, picked, stream);
  }

  async function generatePool(cards, set, stream, boosterType) {
    const type = boosterType || boosterTypeFor(set);
    const shape = BOOSTER_TYPES[type];
    if (!shape) throw new Error('unknown booster type: ' + type);
    const pools = classifySetCards(cards, set);
    if (pools.common.length < shape.commons || pools.uncommon.length < shape.uncommons ||
        pools.rare.length < 1) {
      throw new Error(set + ' does not have enough commons, uncommons, and rares to build boosters');
    }
    if (shape.lands > 0 && !pools.basicLand.length && !pools.commonLand.length) {
      throw new Error(set + ' has no basic or common lands for the land slot');
    }

    const pool = [];
    for (let p = 0; p < PACKS; p++) {
      const picked = new Set();
      const take = id => { picked.add(id); pool.push(id); };

      for (const id of await sampleWithoutReplacement(pools.common, shape.commons, stream)) take(id);
      for (const id of await sampleWithoutReplacement(pools.uncommon, shape.uncommons, stream)) take(id);
      for (let i = 0; i < shape.rareMythics; i++) take(await drawRareMythic(pools, picked, stream));
      for (const weights of shape.wildcards) {
        let roll = await stream.nextInt(
          weights.common + weights.uncommon + weights.rare + weights.mythic);
        let bucket = 'mythic';
        for (const k of ['common', 'uncommon', 'rare']) {
          if (roll < weights[k]) { bucket = k; break; }
          roll -= weights[k];
        }
        const from = pools[bucket].length ? pools[bucket] : pools.rare;
        take(await drawUnique(from, picked, stream));
      }
      for (let i = 0; i < shape.lands; i++) {
        const useNonbasic = pools.commonLand.length > 0 &&
          (!pools.basicLand.length || (await stream.nextInt(2)) === 0);
        take(await drawUnique(useNonbasic ? pools.commonLand : pools.basicLand, picked, stream));
      }
    }
    return pool;
  }

  function buildUrl(set, username, unlockMs) {
    const iso = new Date(unlockMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return location.origin + location.pathname + '#sealed=' +
      encodeURIComponent(set.toUpperCase()) + ':' + encodeURIComponent(username) + ':' + iso;
  }

  const api = {
    DRAND, PACKS, BOOSTER_TYPES, DRAFT_BOOSTER_SETS, boosterTypeFor,
    parseFragment, roundFor, roundTimeMs,
    fetchBeacon, deriveSeed, HashStream, generatePool, buildUrl,
  };
  (typeof window === 'undefined' ? globalThis : window).Sealed = api;
})();
