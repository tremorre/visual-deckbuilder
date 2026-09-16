const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_BIT = { W: 1, U: 2, B: 4, R: 8, G: 16 };
const BASIC_NAMES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

export { MANA_COLORS, COLOR_BIT, BASIC_NAMES };

export function parseManaCost(cost) {
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

export function producibleColors(text) {
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

export function buildPool(data, staples, unplayable, version) {
  const info = new Map();
  const lookup = new Map();
  const bareBySetNum = new Map();
  const basicOf = new Map();
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
  // v3+: an alt-art printing ("Foo (Label)", "Foo ★", "Forest Pixel") shares
  // its base card's slot when the stripped stem names a card with the same
  // gameplay structure, so URLs carry no art information
  let foldOf = null;
  if (version >= 3) {
    const structOf = new Map();
    const rows = [];
    for (const s of sets) {
      if (s === 'REV') continue;
      for (const c of ((data[s] && data[s].cards) || [])) {
        const side = (c.side || '').toLowerCase();
        if (side === 'b' || side === 'back') continue;
        const bare0 = stripBare((c.name || '').split(' // ', 2)[0]);
        const key = structKey(c);
        if (!structOf.has(bare0)) structOf.set(bare0, key);
        rows.push([bare0, key]);
      }
    }
    foldOf = new Map();
    for (const [bare0, key] of rows) {
      if (foldOf.has(bare0)) continue;
      let cur = bare0;
      for (let step = stripNameOnce(cur); step; step = stripNameOnce(cur)) {
        if (structOf.get(step.stem) !== key) break;
        cur = step.stem;
      }
      foldOf.set(bare0, cur);
    }
  }
  for (const s of sets) {
    if (s === 'REV') continue;
    const cards = (data[s] && data[s].cards) || [];
    const sortedCards = cards.slice().sort((a, b) => numKey(a.number).localeCompare(numKey(b.number)));
    for (const c of sortedCards) {
      const side = (c.side || '').toLowerCase();
      if (side === 'b' || side === 'back') continue;
      const full = (c.name || '').split(' // ', 2)[0];
      const bare0 = stripBare(full);
      const bare = foldOf ? foldOf.get(bare0) : bare0;
      if (BASIC_NAMES.indexOf(bare) >= 0) {
        if (foldOf) { basicOf.set(full, bare); basicOf.set(bare0, bare); }
        continue;
      }
      if (foldOf && !lookup.has(bare0)) lookup.set(bare0, bare);
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
        if (foldOf && stripBare(e.firstName) !== bare && bare0 === bare) e.firstName = full;
      }
    }
  }
  const fullCanonical = Array.from(info.keys()).sort((a, b) => {
    const ia = info.get(a), ib = info.get(b);
    if (ia.set !== ib.set) return ia.set < ib.set ? -1 : 1;
    return numKey(ia.num).localeCompare(numKey(ib.num));
  });
  const nonBasicFullLen = fullCanonical.length;
  if (version >= 2) {
    for (const b of BASIC_NAMES) fullCanonical.push(b);
  }
  const fullNameIndex = new Map();
  fullCanonical.forEach((b, i) => fullNameIndex.set(b, i));
  const legalCanonical = fullCanonical.slice(0, nonBasicFullLen).filter(
    b => info.get(b).legal && !unplayable.has(b));
  const legalNameIndex = new Map();
  legalCanonical.forEach((b, i) => legalNameIndex.set(b, i));
  const appIdxBits = version >= 3
    ? Math.max(13, Math.ceil(Math.log2(fullCanonical.length))) : 13;
  return { fullCanonical, fullNameIndex, legalCanonical, legalNameIndex,
           info, lookup, staples, nonBasicFullLen, bareBySetNum, allSetCodes, appIdxBits, basicOf };
}

export function buildLiveBridge(data) {
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

export function parseStaples(text) {
  const out = new Set();
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

export function parseRenames(text) {
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

export function renameToLive(name, fwd, liveByName) {
  let cur = name; const seen = new Set([cur]);
  while (fwd.has(cur)) {
    cur = fwd.get(cur);
    if (seen.has(cur)) break;
    seen.add(cur);
    if (liveByName && liveByName.has(cur)) return cur;
  }
  return null;
}

export function renameToFrozen(name, back, lookup) {
  let cur = name; const seen = new Set([cur]);
  while (back.has(cur)) {
    cur = back.get(cur);
    if (seen.has(cur)) break;
    seen.add(cur);
    if (lookup.has(cur)) return lookup.get(cur);
  }
  return null;
}

export function stripNameOnce(name) {
  const paren = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[1]) return { stem: paren[1], variant: paren[2] };
  const under = name.match(/^(.*)_([A-Za-z0-9]+)$/);
  if (under && under[1]) return { stem: under[1], variant: under[2] };
  const word = name.match(/^(.*\S)\s+(\S+)$/);
  if (word && word[1]) return { stem: word[1], variant: word[2] };
  return null;
}

export function structText(text) {
  return String(text || '')
    .replace(/\([^()]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9+/{}]+/g, ' ')
    .trim();
}

export function structKey(c) {
  return JSON.stringify([
    structText(c.text), c.type || '', c.manaCost || '',
    (c.colors || []).join(''), (c.colorIdentity || []).join(''),
    c.power != null ? String(c.power) : '', c.toughness != null ? String(c.toughness) : '',
  ]);
}

export function numKey(n) {
  const s = String(n || '');
  const m = /^(\d+)([A-Za-z]*)$/.exec(s);
  if (m) return m[1].padStart(8, '0') + m[2];
  return '￿' + s;
}

export function isBasic(name) {
  const i = (name || '').indexOf('_');
  const head = i >= 0 ? name.slice(0, i) : name;
  return BASIC_NAMES.indexOf(head) >= 0 ? head : null;
}

export function computeDeckMask(deckCards, info, lookup) {
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

export function playable(cost, mask) {
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

export function resolveCanon(name, pool) {
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
