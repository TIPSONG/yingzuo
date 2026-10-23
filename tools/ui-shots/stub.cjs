'use strict';
// Explicit preload contracts shared by screenshot capture and browser regressions.
// No real backend, credentials, GPU jobs, or filesystem mutations are used here.
function installFixture(fx, opts) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = window.__yzFixture = {pending: 0, completed: [], errors: [], calls: [], maxUpdatesInFlight: 0};
  window.__yzCalls = state.calls;
  Object.defineProperty(state, 'savedSettings', {get: () => clone(fx['settings.get'])});
  const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) { a[k] ??= {}; merge(a[k], v); } else a[k] = v; } return a; };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms || 0));
  let updates = 0, updatesInFlight = 0, settingsReads = 0;
  const asset = id => { const a = fx['assets.list'].items.find(a => a.id === id); if (!a) throw new Error(`Unknown fixture asset: ${id}`); return a; };
  const handlers = {
    'settings.get': async () => {
      if (opts.pauseSettingsGets?.includes(++settingsReads)) {
        await new Promise(resolve => { state.resumeSettingsGet = resolve; });
        delete state.resumeSettingsGet;
      }
      return fx['settings.get'];
    },
    'settings.update': async patch => {
      const plan = opts.updatePlan?.[updates++] ?? {};
      state.maxUpdatesInFlight = Math.max(state.maxUpdatesInFlight, ++updatesInFlight);
      try {
        await delay(plan.delayMs ?? opts.updateDelayMs);
        if (plan.fail ?? opts.failUpdate) throw new Error('模拟保存失败');
        merge(fx['settings.get'].config, patch);
        return {config: clone(fx['settings.get'].config), issues: []};
      } finally { updatesInFlight--; }
    },
    'settings.pickPath': async key => { await delay(opts.pickDelayMs); const [g, k] = key.split('.'); fx['settings.get'].config[g][k] = 'D:\\picked\\' + k; return {config: clone(fx['settings.get'].config), issues: []}; },
    'settings.setCredential': async n => { fx['settings.get'].credentials.configured[n] = true; return fx['settings.get'].credentials; },
    'settings.removeCredential': async n => { fx['settings.get'].credentials.configured[n] = false; return fx['settings.get'].credentials; },
    'assets.get': id => asset(id),
    'assets.thumbnail': id => ({dataUrl: asset(id).fixtureImage}),
    'assets.favoriteLayout': ({width, gap = 8, rowHeight = 220}) => {
      const items = fx['assets.favorites'].items; let x = 0, y = 0;
      const cells = items.map(f => { const w = Math.min(width, rowHeight * f.width / f.height); if (x && x + w > width) { x = 0; y += rowHeight + gap; } const c = {id: f.id, x, y, width: w, height: rowHeight}; x += w + gap; return c; });
      return {cells, height: cells.length ? y + rowHeight : 220};
    },
  };
  async function invoke(key, args) {
    state.calls.push([key, clone(args)]); state.pending++;
    try {
      await delay(opts.delays?.[key]);
      if (opts.omit?.includes(key)) throw new Error(`Unsupported fixture API: ${key}`);
      let data;
      if (handlers[key]) data = await handlers[key](...args);
      else if (Object.hasOwn(fx, key)) data = fx[key];
      else throw new Error(`Unsupported fixture API: ${key}`);
      return {ok: true, data: clone(data)};
    } catch (error) {
      state.errors.push({key, message: error.message});
      return {ok: false, error: {code: 'FIXTURE_ERROR', message: error.message}};
    } finally { state.pending--; state.completed.push(key); }
  }
  window.yingzuo = new Proxy({}, {get: (_, group) => {
    if (group === 'events') return {subscribe() {}};
    return new Proxy({}, {get: (_, method) => (...args) => invoke(group + '.' + String(method), args)});
  }});
  const desktopState = () => clone(fx['desktop.boot']);
  window.yingzuoDesktop = {
    setOverlay() {}, setBounds() {}, onStatus() {}, onWindowState() {},
    boot: async () => { const r = await invoke('desktop.boot', []); if (!r.ok) throw new Error(r.error.message); return r.data; },
    showEditor: async () => desktopState(),
    windowIsMaximized: async () => ({ok: true, maximized: false}),
  };
}
module.exports = function stubSource(fixtures, options = {}) {
  const fx = JSON.parse(JSON.stringify(fixtures));
  fx['settings.get'].config.ui = {theme: options.theme ?? 'dark', skin: options.skin ?? 'default'};
  if (options.assetMode === 'empty') { fx['assets.list'] = {items: [], total: 0, nextOffset: null}; fx['assets.favorites'] = {items: [], total: 0}; }
  return `(${installFixture.toString()})(${JSON.stringify(fx)}, ${JSON.stringify(options)});`;
};
