'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — puente IPC
   Lo único que la interfaz puede pedirle al sistema. El renderer de la ventana
   no tiene fs, ni require, ni red: `contextIsolation` está activo. Es la
   superficie de ataque de la app, así que cada canal valida lo que recibe.

   Convención heredada de Opal: cada handler devuelve {ok:true, data} o
   {ok:false, error}; el preload lo desenvuelve en una excepción real.

   Las páginas web NO ven nada de esto: viven en otra sesión y sin preload.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app, dialog, shell, net } = require('electron');
const store = require('./store.cjs');
const omni = require('./omni.cjs');
const { TABLE } = require('./shortcuts.cjs');

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/** Solo el renderer de la ventana manda comandos. Una página no puede. */
function on(ctx, channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!ctx.win || e.sender !== ctx.win.webContents) return;
    try { fn(...args); } catch (err) { console.error(`[ipc] ${channel}:`, err); }
  });
}

const num = (v) => Number(v);
const str = (v, max = 8192) => String(v ?? '').slice(0, max);

/* Las sugerencias remotas se cancelan si llega otra tecla: una respuesta vieja
   que llega tarde pisaría a la nueva y la lista "saltaría" hacia atrás. */
let suggestAbort = null;

function register(ctx) {
  const T = () => ctx.tabs;

  /* ── Pestañas ──────────────────────────────────────────────────────────── */
  handle('tabs:state', () => T().snapshot());
  on(ctx, 'tabs:new', (url, opts = {}) => T().create({ url: str(url), active: opts.active !== false, index: Number.isInteger(opts.index) ? opts.index : undefined }));
  on(ctx, 'tabs:close', (id) => T().close(num(id)));
  on(ctx, 'tabs:activate', (id) => T().activate(num(id)));
  on(ctx, 'tabs:move', (id, to) => T().move(num(id), num(to)));
  on(ctx, 'tabs:duplicate', (id) => T().duplicate(num(id)));
  on(ctx, 'tabs:mute', (id) => T().mute(num(id)));
  on(ctx, 'tabs:reopen', () => T().reopen());
  on(ctx, 'tabs:close-others', (id) => T().closeOthers(num(id)));
  on(ctx, 'tabs:close-right', (id) => T().closeRight(num(id)));
  handle('tabs:navigate', (id, input) => T().navigate(id == null ? null : num(id), str(input)));

  on(ctx, 'nav:back', () => T().back());
  on(ctx, 'nav:forward', () => T().forward());
  on(ctx, 'nav:reload', (hard) => T().reload(!!hard));
  on(ctx, 'nav:stop', () => T().stop());
  on(ctx, 'page:zoom', (dir) => T().zoom(['in', 'out', 'reset'].includes(dir) ? dir : 'reset'));
  on(ctx, 'page:devtools', () => T().devtools());
  on(ctx, 'page:print', () => T().contextAction('print'));

  /* ── La página y los overlays ──────────────────────────────────────────── */
  on(ctx, 'page:insets', (i) => T().setInsets(i));
  handle('page:snapshot', () => T().snapshotPage());
  handle('page:hold', (onOff) => { T().hold(!!onOff); return true; });
  on(ctx, 'page:focus', () => T().focusPage());
  on(ctx, 'page:find', (text, opts = {}) => T().find(str(text, 500), { forward: opts.forward !== false, newSession: !!opts.newSession }));
  on(ctx, 'page:find-stop', () => T().stopFind());
  on(ctx, 'page:context', (action, p = {}) => T().contextAction(str(action, 40), {
    url: p.url ? str(p.url) : '', text: p.text ? str(p.text, 2000) : '', word: p.word ? str(p.word, 200) : '',
    x: Number(p.x) || 0, y: Number(p.y) || 0,
  }));
  on(ctx, 'page:exit-fullscreen', () => {
    const wc = T().active?.view?.webContents;
    if (wc) wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    T().setFullscreen(false);
  });

  /* ── Omnibox ───────────────────────────────────────────────────────────── */
  handle('omni:suggest', (q) => {
    const r = ctx.library.suggest(str(q, 500));
    return { ...r, classified: omni.classify(str(q, 500), ctx.settings.searchEngine) };
  });

  handle('omni:remote', async (q) => {
    const query = str(q, 300).trim();
    if (!query || !ctx.settings.remoteSuggest) return [];
    suggestAbort?.abort();
    const abort = new AbortController();
    suggestAbort = abort;
    const timer = setTimeout(() => abort.abort(), 2500);
    try {
      const url = omni.engine(ctx.settings.searchEngine).suggest.replace('%s', encodeURIComponent(query));
      // net.fetch: la pila de Chromium (con happy eyeballs), en la sesión de las
      // páginas para que lleve sus cookies/idioma como una búsqueda normal.
      const res = await ctx.web.fetch(url, { signal: abort.signal });
      if (!res.ok) return [];
      return omni.parseRemoteSuggest(await res.json());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  });

  /* ── Historial y favoritos ─────────────────────────────────────────────── */
  const L = () => ctx.library;
  const changed = () => { T().emit(); ctx.send('library:changed'); };

  handle('history:list', (opts = {}) => L().listVisits({
    query: str(opts.query, 300),
    before: Number(opts.before) || Infinity,
    limit: Math.min(500, Number(opts.limit) || 200),
  }));
  handle('history:remove', (ids) => { const n = L().removeVisits((ids || []).map(Number)); changed(); return n; });
  handle('history:clear', (since) => { const n = L().clearHistory(Number(since) || 0); changed(); return n; });
  handle('history:top', (n) => L().topSites(Math.min(24, Number(n) || 8)));

  handle('bookmarks:list', () => L().listBookmarks());
  handle('bookmarks:toggle', (info = {}) => {
    const t = T().active;
    const url = str(info.url || t?.url);
    if (!/^(https?|file):/i.test(url)) return false;
    const on = L().toggleBookmark({ url, title: str(info.title ?? t?.title, 300), favicon: info.favicon ?? t?.favicon ?? null });
    changed();
    return on;
  });
  handle('bookmarks:add', (info = {}) => { const b = L().addBookmark({ url: str(info.url), title: str(info.title, 300), favicon: info.favicon || null }); changed(); return b; });
  handle('bookmarks:update', (id, patch = {}) => { const b = L().updateBookmark(str(id, 64), { title: patch.title != null ? str(patch.title, 300) : undefined, url: patch.url != null ? str(patch.url) : undefined }); changed(); return b; });
  handle('bookmarks:remove', (id) => { const r = L().removeBookmark(str(id)); changed(); return r; });
  handle('bookmarks:move', (id, to) => { const r = L().moveBookmark(str(id, 64), Number(to)); changed(); return r; });

  /* ── Descargas ─────────────────────────────────────────────────────────── */
  const D = () => ctx.downloads;
  handle('downloads:list', () => D().list());
  for (const a of ['open', 'show', 'cancel', 'pause', 'resume', 'retry', 'remove']) {
    handle(`downloads:${a}`, (id) => D()[a](num(id)));
  }
  handle('downloads:clear', () => D().clear());
  handle('downloads:folder', () => D().openFolder());
  handle('downloads:dir', () => D().dir());

  /* ── Ajustes ───────────────────────────────────────────────────────────── */
  handle('settings:get', () => ctx.settings);
  handle('settings:save', (patch) => ctx.saveSettings(patch || {}));

  handle('adblock:toggle-site', (url) => {
    const host = ctx.adblock.hostOf(str(url || T().active?.url));
    if (!host) return null;
    const list = new Set(ctx.settings.adblockAllow || []);
    const allowed = !list.has(host);
    allowed ? list.add(host) : list.delete(host);
    return ctx.saveSettings({ adblockAllow: [...list] }).then(() => {
      T().reload();
      return { host, allowed };
    });
  });
  handle('adblock:stats', () => ({ ready: ctx.adblock.ready, total: ctx.adblock.total }));

  handle('permissions:revoke', async (origin, key) => {
    const all = { ...(ctx.settings.permissions || {}) };
    const o = str(origin, 400);
    if (!all[o]) return false;
    if (key) { all[o] = { ...all[o] }; delete all[o][str(key, 60)]; if (!Object.keys(all[o]).length) delete all[o]; } else delete all[o];
    await ctx.saveSettings({ permissions: all });
    return true;
  });

  handle('data:clear', async (what = {}) => {
    const done = [];
    if (what.history) { L().clearHistory(Number(what.since) || 0); done.push('historial'); changed(); }
    if (what.cookies) {
      await ctx.web.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'websql', 'shadercache'] });
      done.push('cookies y datos de sitios');
    }
    if (what.cache) { await ctx.web.clearCache(); await ctx.web.clearCodeCaches({}).catch(() => {}); done.push('caché'); }
    return done;
  });

  handle('dialog:folder', async (current) => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Carpeta de descargas',
      defaultPath: current ? str(current, 1000) : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    userData: app.getPath('userData'),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    engines: Object.fromEntries(Object.entries(omni.ENGINES).map(([k, v]) => [k, v.label])),
    shortcuts: TABLE,
  }));
  handle('app:relaunch', () => { app.relaunch(); app.quit(); return true; });
  handle('app:open-data', () => shell.openPath(store.ROOT));

  handle('net:online', () => net.isOnline());
}

module.exports = { register };
