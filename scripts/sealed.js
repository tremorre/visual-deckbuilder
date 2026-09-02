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
  // tentative: sets before TWI use draft boosters (except ERR), TWI and later use play boosters
  const DRAFT_BOOSTER_SETS = new Set(['VST', 'SRC', 'MON', 'KUT', 'GQC', 'SVG', 'VRD',
    'KRS', 'KSV', 'BLR', 'DOV', 'POP', 'TRX', 'OLD', 'CYB', 'CNY', 'CCR', 'KDT',
    'REV', 'PLANE']);
  const DEFAULT_BOOSTER_TYPE = 'play';

  function boosterTypeFor(set) {
    return DRAFT_BOOSTER_SETS.has(set) ? 'draft' : DEFAULT_BOOSTER_TYPE;
  }

  function parseTimestamp(raw) {
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    // friendly form: 2026-08-20-18:00 → 2026-08-20T18:00
    let s = raw.replace(/^(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2}(?::\d{2})?)$/, '$1T$2');
    // times without a zone are pinned to UTC so every client maps to the same round
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

  function currentRound(nowMs) {
    return Math.max(1, Math.floor((Math.floor(nowMs / 1000) - DRAND.genesis) / DRAND.period) + 1);
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

  // per-set common land cycles: only these fill the non-basic half of the land slot.
  // Utility commons (Evolving Wilds, any-color, colorless-only) stay in the common slots.
  const LAND_CYCLES = {
    KUT: ['Bloodfell Caves', 'Blossoming Sands', 'Dismal Backwater', 'Jungle Hollow',
          'Rugged Highlands', 'Scoured Barrens', 'Swiftwater Cliffs', 'Thornwood Falls',
          'Tranquil Cove', 'Wind-Scarred Crag',
          'Alruq Veil-Boundary', 'Dhagiri Veil-Boundary', 'Narwa Veil-Boundary',
          'Neqanak Veil-Boundary', 'Tambara Veil-Boundary'],
    VRD: ['Benthic Bunker', "Biomancer's Workshop", "Cultist's Compound", 'Decadent Lobby',
          'Glacial Base', 'Inconspicuous Volcano', 'Midnight Square', 'Penthouse Office',
          'Remote Facility', 'Underground Lab'],
    POP: ['Abandoned Warehouse', 'Corgan Sprawl', 'Drizzling Cloister', 'Ozzen Headquarters',
          'Possibility Heights', 'Quantum Skycity', 'Rapturous Festival', 'Sunrise Lot',
          'Swanky Club', 'Tenuous Edge'],
    TRX: ['Temple of Abandon', 'Temple of Deceit', 'Temple of Enlightenment',
          'Temple of Epiphany', 'Temple of Malady', 'Temple of Malice', 'Temple of Mystery',
          'Temple of Plenty', 'Temple of Silence', 'Temple of Triumph'],
    CYB: ['Dark Horizon', 'Field Laboratory', 'Lunar Plateau', 'Nebulous Ring',
          'Steam Colony', 'Valley Village'],
    CNY: ['Bustling Motorway', 'Congressional Hall', 'Controlled Ecosystem',
          'Executive Office', 'Groupthink Tank', 'Interrogation Chamber',
          'Looming Skyscrapers', 'Neglected Slums', 'Open Air Boardwalk', 'Urban Sunscape'],
    CCR: ['Calmed Battleground', 'Cryptic Reef', 'Deeplife Cavern', 'Fortress Arena',
          'Frigid Highlands', 'Gleaming Hot Springs', 'Ominous Quag', 'Serpentine Woods',
          'Stunning Cascade', 'Sunlit Ruins'],
    ERR: ['Chimeric Soulspace', 'Eidetic Soulspace', 'Footloose Soulspace',
          'Hopeful Soulspace', 'Lonely Soulspace', 'Macabre Soulspace',
          'Nostalgic Soulspace', 'Soaring Soulspace', 'Vindictive Soulspace',
          'Zealous Soulspace',
          'Clearwater Grotto', 'Enigmatic Fen', 'Lucent Basin', 'Misty Peak',
          'Profane Grove', 'Sanguine Palace', 'Stark Expanse', 'Urban Jungle',
          'Verdant Sanctum', 'Windbeaten Stones'],
    TWI: ['Blossoming Sands', 'Dismal Backwater', 'Jungle Hollow', 'Swiftwater Cliffs',
          'Wind-Scarred Crag'],
    SOL: ['Bloodfell Caves', 'Blossoming Sands', 'Dismal Backwater', 'Jungle Hollow',
          'Rugged Highlands', 'Scoured Barrens', 'Swiftwater Cliffs', 'Thornwood Falls',
          'Tranquil Cove', 'Wind-Scarred Crag'],
    VLR: ['Flooded Morass', 'Flourishing Crevasse', 'Frostfire Geysers', 'Fungal Mire',
          'Gloomcover Steppe', 'Heart of the Glade', 'Lavatorn Fields', 'Lush Oasis',
          'Pool of Light', 'Spiraling Canyon'],
    SGP: ['Bronzeglade Peaks', 'Cataract Valley', 'Cliffrest Tributary', 'Dusk Vantage',
          "Keeper's Peninsula", 'Lakewatch Ruins', 'Lost Settlement', 'Outlands Hamlet',
          'Secluded Avenue', 'Village Steeples'],
  };

  // sets whose land slot has custom halves instead of cycle-lands-vs-basics
  const LAND_SLOT_GROUPS = {
    ERR: [
      LAND_CYCLES.ERR.slice(0, 10),   // soulspaces
      LAND_CYCLES.ERR.slice(10),      // shocks
    ],
  };

  function baseName(name) { return name.split('_')[0]; }

  function classifySetCards(cards, set) {
    const buckets = { common: [], uncommon: [], rare: [], mythic: [], basic: [], cycle: [] };
    const cycleNames = new Set(LAND_CYCLES[set] || []);
    const seenNames = new Set();
    for (const c of cards) {
      if (c.set !== set || seenNames.has(c.name) || c.rarity === 'special') continue;
      const isBasic = (Array.isArray(c.supertypes) && c.supertypes.includes('Basic'))
        || c.rarity === 'basic';
      let bucket = null;
      if (isBasic) bucket = 'basic';
      else if (cycleNames.has(baseName(c.name))) bucket = 'cycle';
      else if (buckets[c.rarity]) bucket = c.rarity;
      if (!bucket) continue;
      seenNames.add(c.name);
      buckets[bucket].push(c);
    }
    // canonical order: codepoint compare on name — locale- and id-scheme-independent
    const toIds = arr => arr
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(c => c.id);
    const custom = LAND_SLOT_GROUPS[set];
    let landGroups;
    if (custom) {
      landGroups = custom.map(names => {
        const wanted = new Set(names);
        return toIds(buckets.cycle.filter(c => wanted.has(baseName(c.name))));
      });
    } else {
      landGroups = [toIds(buckets.cycle.slice()), toIds(buckets.basic.slice())];
    }
    return {
      common: toIds(buckets.common),
      uncommon: toIds(buckets.uncommon),
      rare: toIds(buckets.rare),
      mythic: toIds(buckets.mythic),
      landGroups: landGroups.filter(g => g.length > 0),
    };
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
    if (shape.lands > 0 && !pools.landGroups.length) {
      throw new Error(set + ' has no lands for the land slot');
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
        const g = pools.landGroups.length === 1
          ? pools.landGroups[0]
          : pools.landGroups[await stream.nextInt(pools.landGroups.length)];
        take(await drawUnique(g, picked, stream));
      }
    }
    return pool;
  }

  function buildUrl(set, username, unlockMs) {
    const stamp = new Date(unlockMs).toISOString()
      .replace(/:\d{2}\.\d{3}Z$/, '').replace('T', '-');
    return location.origin + location.pathname + '#sealed=' +
      encodeURIComponent(set.toUpperCase()) + ':' + encodeURIComponent(username) + ':' + stamp;
  }

  const api = {
    DRAND, PACKS, BOOSTER_TYPES, DRAFT_BOOSTER_SETS, boosterTypeFor,
    LAND_CYCLES, LAND_SLOT_GROUPS,
    parseFragment, roundFor, roundTimeMs, currentRound,
    fetchBeacon, deriveSeed, HashStream, generatePool, buildUrl,
  };
  (typeof window === 'undefined' ? globalThis : window).Sealed = api;
})();
