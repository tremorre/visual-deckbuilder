(function () {
  'use strict';

  const scriptUrl = document.currentScript.src;
  const root = new URL('..', scriptUrl);
  const asset = (path) => fetch(new URL(path, root), { cache: 'force-cache' });

  async function loadModel(version) {
    const resp = await asset(`share/v${version}/model.json`);
    if (!resp.ok) throw new Error('Unknown share URL version ' + version);
    return resp.json();
  }

  const ready = (async () => {
    const lib = await import(new URL('share/index.js', scriptUrl));
    const [model, renames] = await Promise.all([
      loadModel(lib.VERSION),
      asset('renames.txt').then(r => (r.ok ? r.text() : '')).catch(() => ''),
    ]);
    return lib.createDeckUrl(lib.expandModel(model), { renames, loadModel });
  })();
  ready.catch(e => console.error('share codec failed to load:', e));

  window.DeckUrl = {
    encode: async (entries) => (await ready).encode(entries),
    decode: async (payload) => (await ready).decode(payload),
    ready,
  };
})();
