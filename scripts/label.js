(async function () {
  'use strict';

  const IMG_BASE = 'https://raw.githubusercontent.com/cajunwritescode/Revolution/refs/heads/main/img';
  const NEW_SETS = ['IWH', 'VLR'];

  const [cardsResp, staplesResp, unplayableResp] = await Promise.all([
    fetch('cards.json'),
    fetch('staples.txt'),
    fetch('unplayable.txt'),
  ]);
  const cardsJson = await cardsResp.json();
  const data = cardsJson.data || {};

  function parseList(text) {
    const out = new Set();
    if (!text) return out;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      out.add(line);
    }
    return out;
  }
  const staples = parseList(staplesResp.ok ? await staplesResp.text() : '');
  const unplayable = parseList(unplayableResp.ok ? await unplayableResp.text() : '');
  const staplesHeader = (staplesResp.ok ? await refetchHeader('staples.txt') : '');
  const unplayableHeader = (unplayableResp.ok ? await refetchHeader('unplayable.txt') : '');
  async function refetchHeader(path) {
    const r = await fetch(path);
    if (!r.ok) return '';
    const t = await r.text();
    const lines = t.split('\n');
    const out = [];
    for (const ln of lines) {
      const s = ln.trim();
      if (s === '' || s.startsWith('#')) { out.push(ln); continue; }
      break;
    }
    return out.join('\n') + (out.length ? '\n' : '');
  }

  function numKey(n) {
    const s = String(n || '');
    const m = /^(\d+)([A-Za-z]*)$/.exec(s);
    if (m) return m[1].padStart(8, '0') + m[2];
    return '￿' + s;
  }
  const BASIC = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

  const info = new Map();
  for (const s of Object.keys(data).sort()) {
    if (s === 'REV') continue;
    const cards = (data[s] && data[s].cards) || [];
    cards.sort((a, b) => numKey(a.number).localeCompare(numKey(b.number)));
    for (const c of cards) {
      const side = (c.side || '').toLowerCase();
      if (side === 'b' || side === 'back') continue;
      const full = (c.name || '').split(' // ', 2)[0];
      const m = /^(.*)_([A-Z0-9]+)$/.exec(full);
      const bare = m ? m[1] : full;
      if (BASIC.has(bare)) continue;
      const isLegalPrinting = ((c.legalities || {}).revolution === 'Legal');
      if (!info.has(bare)) {
        info.set(bare, {
          set: s,
          num: String(c.number || ''),
          manaCost: c.manaCost || '',
          type: c.type || (Array.isArray(c.types) ? c.types.join(' ') : ''),
          text: c.text || '',
          legal: isLegalPrinting,
          fullName: full,
          rarity: c.rarity || '',
        });
      } else {
        const e = info.get(bare);
        e.legal = e.legal || isLegalPrinting;
      }
    }
  }
  const allBare = Array.from(info.keys()).sort((a, b) => {
    const ia = info.get(a), ib = info.get(b);
    if (ia.set !== ib.set) return ia.set < ib.set ? -1 : 1;
    return numKey(ia.num).localeCompare(numKey(ib.num));
  });

  const allSets = [];
  {
    const seen = new Set();
    for (const b of allBare) {
      const s = info.get(b).set;
      if (!seen.has(s)) { seen.add(s); allSets.push(s); }
    }
  }
  {
    const sel = document.getElementById('set-filter');
    for (const s of allSets) {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      sel.appendChild(o);
    }
  }

  const state = {
    mode: 'unplayable',
    setFilter: '',
    statusFilter: 'all',
    cursor: 0,
    dirty: false,
  };

  function selectFiltered() {
    let candidates;
    if (state.mode === 'unplayable') {
      candidates = allBare.filter(b => info.get(b).legal);
    } else if (state.mode === 'staples-new') {
      candidates = allBare.filter(b => NEW_SETS.includes(info.get(b).set) && info.get(b).legal);
    } else {
      candidates = allBare.filter(b => info.get(b).legal);
    }
    if (state.setFilter) {
      candidates = candidates.filter(b => info.get(b).set === state.setFilter);
    }
    if (state.statusFilter === 'unmarked') {
      candidates = candidates.filter(b => !staples.has(b) && !unplayable.has(b));
    } else if (state.statusFilter === 'staple') {
      candidates = candidates.filter(b => staples.has(b));
    } else if (state.statusFilter === 'unplayable') {
      candidates = candidates.filter(b => unplayable.has(b));
    }
    return candidates;
  }

  function statusOf(bare) {
    if (staples.has(bare)) return 'staple';
    if (unplayable.has(bare)) return 'unplayable';
    return 'rest';
  }

  function render() {
    const list = selectFiltered();
    if (state.cursor >= list.length) state.cursor = Math.max(0, list.length - 1);
    document.getElementById('progress').textContent =
      list.length ? `${state.cursor + 1} / ${list.length}` : '0 / 0';
    document.getElementById('save-status').textContent =
      state.dirty ? 'unsaved' : 'no changes';
    document.getElementById('save-status').className =
      'save-status' + (state.dirty ? ' dirty' : '');

    const listEl = document.getElementById('label-list');
    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.forEach((bare, i) => {
      const row = document.createElement('div');
      row.className = 'card-row' + (i === state.cursor ? ' current' : '');
      const c = info.get(bare);
      const status = statusOf(bare);
      row.innerHTML = `
        <span class="name">${escapeHtml(bare)} <span style="color:#888;font-size:11px">${c.set}/${escapeHtml(c.num)}</span></span>
        ${status !== 'rest' ? `<span class="badge badge-${status}">${status}</span>` : ''}
      `;
      row.addEventListener('click', () => { state.cursor = i; render(); });
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
    const cur = listEl.querySelector('.card-row.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });

    if (!list.length) {
      document.getElementById('card-name').textContent = '(no cards in filter)';
      document.getElementById('card-meta').textContent = '';
      document.getElementById('card-text').textContent = '';
      document.getElementById('card-img').src = '';
      return;
    }
    const bare = list[state.cursor];
    const c = info.get(bare);
    document.getElementById('card-name').textContent = bare;
    document.getElementById('card-meta').textContent =
      [c.set + '/' + c.num, c.manaCost, c.type, c.rarity].filter(Boolean).join('  ·  ');
    document.getElementById('card-text').textContent = c.text;
    const img = document.getElementById('card-img');
    img.src = `${IMG_BASE}/${c.set}/${encodeURIComponent(c.num)}.jpg`;
    img.onerror = () => { img.style.opacity = 0.3; };
    img.onload = () => { img.style.opacity = 1; };

    const sBtn = document.getElementById('btn-staple');
    const uBtn = document.getElementById('btn-unplayable');
    sBtn.classList.toggle('on', staples.has(bare));
    uBtn.classList.toggle('on', unplayable.has(bare));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function currentBare() {
    const list = selectFiltered();
    return list[state.cursor];
  }

  function toggleStaple() {
    const b = currentBare(); if (!b) return;
    if (staples.has(b)) {
      staples.delete(b);
    } else {
      staples.add(b);
      unplayable.delete(b);
    }
    state.dirty = true;
    render();
  }
  function toggleUnplayable() {
    const b = currentBare(); if (!b) return;
    if (unplayable.has(b)) {
      unplayable.delete(b);
    } else {
      unplayable.add(b);
      staples.delete(b);
    }
    state.dirty = true;
    render();
  }
  function next() {
    const list = selectFiltered();
    if (state.cursor < list.length - 1) { state.cursor++; render(); }
  }
  function prev() {
    if (state.cursor > 0) { state.cursor--; render(); }
  }

  async function save() {
    const status = document.getElementById('save-status');
    status.textContent = 'saving...';
    status.className = 'save-status';

    function listToBody(set, header) {
      const sorted = Array.from(set);
      sorted.sort((a, b) => {
        const ia = info.get(a), ib = info.get(b);
        if (!ia || !ib) return a < b ? -1 : 1;
        if (ia.set !== ib.set) return ia.set < ib.set ? -1 : 1;
        return numKey(ia.num).localeCompare(numKey(ib.num));
      });
      return (header || '') + sorted.join('\n') + '\n';
    }
    const stapleBody = listToBody(staples, staplesHeader);
    const unplayableBody = listToBody(unplayable, unplayableHeader);
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/staples', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: stapleBody }),
        fetch('/api/unplayable', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: unplayableBody }),
      ]);
      if (!r1.ok || !r2.ok) {
        status.textContent = `save error (staples: ${r1.status}, unplayable: ${r2.status})`;
        status.className = 'save-status dirty';
        return;
      }
      state.dirty = false;
      status.textContent = `saved (${staples.size} staples, ${unplayable.size} unplayable)`;
      status.className = 'save-status saved';
    } catch (e) {
      status.textContent = 'save failed: ' + e.message;
      status.className = 'save-status dirty';
    }
  }

  document.getElementById('mode').addEventListener('change', (e) => {
    state.mode = e.target.value; state.cursor = 0; render();
  });
  document.getElementById('set-filter').addEventListener('change', (e) => {
    state.setFilter = e.target.value; state.cursor = 0; render();
  });
  document.getElementById('status-filter').addEventListener('change', (e) => {
    state.statusFilter = e.target.value; state.cursor = 0; render();
  });
  document.getElementById('btn-staple').addEventListener('click', toggleStaple);
  document.getElementById('btn-unplayable').addEventListener('click', toggleUnplayable);
  document.getElementById('btn-prev').addEventListener('click', prev);
  document.getElementById('btn-next').addEventListener('click', next);
  document.getElementById('save').addEventListener('click', save);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); return; }
    if (e.key === 's' || e.key === 'S') { toggleStaple(); }
    else if (e.key === 'u' || e.key === 'U') { toggleUnplayable(); }
    else if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') { next(); }
    else if (e.key === 'ArrowLeft'  || e.key === 'k' || e.key === 'K') { prev(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  render();
})();
