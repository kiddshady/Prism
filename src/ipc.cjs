'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — puente IPC
   Lo único que la interfaz puede pedirle al sistema. El renderer de la ventana
   no tiene fs, ni require, ni red: `contextIsolation` está activo. Es la
   superficie de ataque de la app, así que cada canal valida lo que recibe.

   Convención heredada de Opal: cada handler devuelve {ok:true, data} o
   {ok:false, error}; el preload lo desenvuelve en una excepción real.

   Las páginas web tienen ipcRenderer en el mundo aislado de sus preloads de
   sesión (scrollbars, contraseñas, bloqueador): cada canal de acá verifica que
   quien habla sea una ventana de Prism y no una página.

   Hay más de una ventana (la normal y la de incógnito): cada handler recibe
   el contexto de la que preguntó (windows.cjs), con sus pestañas y su sesión.
   Lo que es de todas (favoritos, ajustes) se avisa a todas.
   ═══════════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const { ipcMain, app, dialog, shell, net } = require('electron');
const store = require('./store.cjs');
const omni = require('./omni.cjs');
const { TABLE } = require('./shortcuts.cjs');
const windows = require('./windows.cjs');
const importer = require('./bookmarks-import.cjs');

/** La ventana que habla, si es una ventana de Prism (y no una página). */
const fromChrome = (e) => windows.ofSender(e);

/** Envuelve un handler para que un throw viaje como error y no como crash.
    Solo contesta a una ventana: una página (que tiene ipcRenderer en el mundo
    aislado de sus preloads) recibe "No autorizado." sin que corra nada. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    const ctx = fromChrome(e);
    if (!ctx) return { ok: false, error: 'No autorizado.' };
    try {
      return { ok: true, data: await fn(ctx, ...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/** Solo el renderer de una ventana manda comandos. Una página no puede. */
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    const ctx = fromChrome(e);
    if (!ctx) return;
    try { fn(ctx, ...args); } catch (err) { console.error(`[ipc] ${channel}:`, err); }
  });
}

const num = (v) => Number(v);
const str = (v, max = 8192) => String(v ?? '').slice(0, max);

/* Las sugerencias remotas se cancelan si llega otra tecla: una respuesta vieja
   que llega tarde pisaría a la nueva y la lista "saltaría" hacia atrás. */
let suggestAbort = null;

function register() {

  /* ── Pestañas ──────────────────────────────────────────────────────────── */
  handle('tabs:state', (ctx) => ctx.tabs.snapshot());
  on('tabs:new', (ctx, url, opts = {}) => ctx.tabs.create({ url: str(url), active: opts.active !== false, index: Number.isInteger(opts.index) ? opts.index : undefined }));
  on('tabs:close', (ctx, id) => ctx.tabs.close(num(id)));
  on('tabs:activate', (ctx, id) => ctx.tabs.activate(num(id)));
  on('tabs:move', (ctx, id, to) => ctx.tabs.move(num(id), num(to)));
  on('tabs:duplicate', (ctx, id) => ctx.tabs.duplicate(num(id)));
  on('tabs:mute', (ctx, id) => ctx.tabs.mute(num(id)));
  on('tabs:pin', (ctx, id, pinned) => ctx.tabs.pin(num(id), !!pinned));
  on('tabs:split', (ctx, id, other) => ctx.tabs.split(num(id), other == null ? null : num(other)));
  on('tabs:unsplit', (ctx, id) => ctx.tabs.unsplit(num(id)));
  on('tabs:swap-split', (ctx, id) => ctx.tabs.swapSplit(num(id)));
  on('tabs:split-ratio', (ctx, id, ratio) => ctx.tabs.setSplitRatio(num(id), num(ratio)));
  on('tabs:reopen', (ctx) => ctx.tabs.reopen());
  on('tabs:close-others', (ctx, id) => ctx.tabs.closeOthers(num(id)));
  on('tabs:close-right', (ctx, id) => ctx.tabs.closeRight(num(id)));
  handle('tabs:navigate', (ctx, id, input) => ctx.tabs.navigate(id == null ? null : num(id), str(input)));

  on('nav:back', (ctx) => ctx.tabs.back());
  on('nav:forward', (ctx) => ctx.tabs.forward());
  on('nav:reload', (ctx, hard) => ctx.tabs.reload(!!hard));
  on('nav:stop', (ctx) => ctx.tabs.stop());
  on('page:zoom', (ctx, dir) => ctx.tabs.zoom(['in', 'out', 'reset'].includes(dir) ? dir : 'reset'));
  on('page:devtools', (ctx) => ctx.tabs.devtools());
  on('page:print', (ctx) => ctx.tabs.contextAction('print'));
  /* La pantalla de impresión (src/print.cjs). Las opciones las acota print.cjs. */
  handle('print:printers', (ctx) => ctx.print.printers());
  handle('print:preview', (ctx, id, opts) => ctx.print.preview(num(id), opts));
  handle('print:run', (ctx, id, opts) => ctx.print.run(num(id), opts));
  handle('print:save', (ctx, id, opts) => ctx.print.save(num(id), opts));
  on('print:system', (ctx, id, opts) => ctx.print.system(num(id), opts));
  /* El window.print() de una página (src/print-preload.cjs): la pantalla de
     impresión en su ventana, si es una pestaña. Un popup (el comprobante que
     un sitio abre solo para imprimir) no tiene pantalla: diálogo de Windows. */
  ipcMain.on('page:print-request', (e) => {
    const hit = windows.tabOf(e.sender.id);
    if (!hit) { try { e.sender.print(); } catch { /* ya no estaba */ } return; }
    hit.w.tabs.activate(hit.tab.id);
    hit.w.focusChrome?.();
    hit.w.send('cmd', 'print:page');
  });
  on('page:capture', (ctx, kind) => ctx.capture.run(kind === 'full' ? 'full' : 'visible'));
  on('page:pip', (ctx) => ctx.pip.toggle(ctx));
  on('pip:back', (ctx, id) => ctx.pip.back(ctx, id == null ? null : num(id)));
  on('page:photo-ready', (ctx, nonce) => ctx.tabs.photoReady(num(nonce)));

  /* ── La página y los overlays ──────────────────────────────────────────── */
  on('page:insets', (ctx, i) => ctx.tabs.setInsets(i));
  handle('page:snapshot', (ctx) => ctx.tabs.snapshotPage());
  handle('page:hold', (ctx, onOff) => { ctx.tabs.hold(!!onOff); return true; });
  on('page:focus', (ctx) => ctx.tabs.focusPage());
  on('page:find', (ctx, text, opts = {}) => ctx.tabs.find(str(text, 500), { forward: opts.forward !== false, newSession: !!opts.newSession }));
  on('page:find-stop', (ctx) => ctx.tabs.stopFind());
  on('page:context', (ctx, action, p = {}) => ctx.tabs.contextAction(str(action, 40), {
    url: p.url ? str(p.url) : '', text: p.text ? str(p.text, 2000) : '', word: p.word ? str(p.word, 200) : '',
    x: Number(p.x) || 0, y: Number(p.y) || 0,
  }));
  on('page:exit-fullscreen', (ctx) => {
    const wc = ctx.tabs.active?.view?.webContents;
    if (wc) wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    ctx.tabs.setFullscreen(false);
  });

  /* ── Omnibox ───────────────────────────────────────────────────────────── */
  handle('omni:suggest', (ctx, q) => {
    const r = ctx.library.suggest(str(q, 500), 6, { history: ctx.settings.historySuggest !== false });
    return { ...r, classified: omni.classify(str(q, 500), ctx.settings.searchEngine) };
  });

  handle('omni:remote', async (ctx, q) => {
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
  // Los favoritos son de todas las ventanas: la estrella y la barra de cada una.
  const changed = () => { windows.all().forEach((w) => w.tabs?.emit()); windows.broadcast('library:changed'); };

  handle('history:list', (ctx, opts = {}) => ctx.library.listVisits({
    query: str(opts.query, 300),
    before: Number(opts.before) || Infinity,
    limit: Math.min(500, Number(opts.limit) || 200),
  }));
  handle('history:remove', (ctx, ids) => { const n = ctx.library.removeVisits((ids || []).map(Number)); changed(); return n; });
  handle('history:clear', (ctx, since) => { const n = ctx.library.clearHistory(Number(since) || 0); changed(); return n; });
  handle('history:top', (ctx, n) => ctx.library.topSites(Math.min(24, Number(n) || 8)));

  handle('bookmarks:list', (ctx) => ctx.library.listBookmarks());
  handle('bookmarks:toggle', (ctx, info = {}) => {
    const t = ctx.tabs.active;
    const url = str(info.url || t?.url);
    if (!/^(https?|file):/i.test(url)) return false;
    const on = ctx.library.toggleBookmark({ url, title: str(info.title ?? t?.title, 300), favicon: info.favicon ?? t?.favicon ?? null });
    changed();
    return on;
  });
  handle('bookmarks:add', (ctx, info = {}) => { const b = ctx.library.addBookmark({ url: str(info.url), title: str(info.title, 300), favicon: info.favicon || null }); changed(); return b; });
  /* La dirección editada a mano pasa por la omnibox: "google.com" se guarda
     como https://google.com (abierta en una pestaña nueva va directo a
     Chromium, que sin esquema no la entiende), y lo que no es una dirección
     que se pueda visitar no se guarda. */
  const bookmarkUrl = (ctx, raw) => {
    const r = omni.classify(str(raw), ctx.settings.searchEngine);
    if (r?.type !== 'url' || !/^(https?|file):/i.test(r.url)) throw new Error('Esa dirección no es válida.');
    return r.url;
  };
  handle('bookmarks:update', (ctx, id, patch = {}) => {
    const url = patch.url != null && str(patch.url).trim() ? bookmarkUrl(ctx, patch.url) : undefined;
    const b = ctx.library.updateBookmark(str(id, 64), { title: patch.title != null ? str(patch.title, 300) : undefined, url });
    changed();
    return b;
  });
  handle('bookmarks:remove', (ctx, id) => { const r = ctx.library.removeBookmark(str(id)); changed(); return r; });
  handle('bookmarks:move', (ctx, id, to) => { const r = ctx.library.moveBookmark(str(id, 64), Number(to)); changed(); return r; });

  /* Importar: la ventana elige una fuente de la lista (no manda rutas), o un
     archivo HTML que elige la persona en el diálogo. */
  handle('bookmarks:sources', (ctx) => importer.findSources());
  handle('bookmarks:import', async (ctx, id) => {
    const r = ctx.library.importBookmarks(await importer.readSource(str(id, 200)));
    changed();
    return r;
  });
  handle('bookmarks:import-file', async (ctx) => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Importar favoritos',
      buttonLabel: 'Importar',
      filters: [{ name: 'Favoritos exportados', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const list = importer.parseNetscape(await fsp.readFile(r.filePaths[0], 'utf8'));
    const res = ctx.library.importBookmarks(list);
    changed();
    return { ...res, found: list.length };
  });

  /* ── Descargas ─────────────────────────────────────────────────────────── */
  handle('downloads:list', (ctx) => ctx.downloads.list());
  for (const a of ['open', 'show', 'cancel', 'pause', 'resume', 'retry', 'remove']) {
    handle(`downloads:${a}`, (ctx, id) => ctx.downloads[a](num(id)));
  }
  handle('downloads:clear', (ctx) => ctx.downloads.clear());
  handle('downloads:folder', (ctx) => ctx.downloads.openFolder());
  handle('downloads:dir', (ctx) => ctx.downloads.dir());

  /* ── Ajustes ───────────────────────────────────────────────────────────── */
  handle('settings:get', (ctx) => ctx.settings);
  handle('settings:save', (ctx, patch) => ctx.saveSettings(patch || {}));
  /* Sacar uno de una lista se calcula en la fila de guardados, no con la copia
     de la ventana: dos chips quitados rápido no se pisan. */
  const LISTS = new Set(['adblockAllow', 'passNever']);
  handle('settings:remove', (ctx, key, value) => {
    const k = str(key, 40);
    if (!LISTS.has(k)) throw new Error('Esa lista no existe.');
    const v = str(value, 400);
    return ctx.updateSettings((s) => ({ [k]: (s[k] || []).filter((x) => x !== v) }));
  });

  handle('adblock:toggle-site', (ctx, url) => {
    const host = ctx.adblock.hostOf(str(url || ctx.tabs.active?.url));
    if (!host) return null;
    let allowed = false;
    return ctx.updateSettings((s) => {
      const list = new Set(s.adblockAllow || []);
      allowed = !list.has(host);
      allowed ? list.add(host) : list.delete(host);
      return { adblockAllow: [...list] };
    }).then(() => {
      ctx.tabs.reload();
      return { host, allowed };
    });
  });
  handle('adblock:stats', (ctx) => ({ ready: ctx.adblock.ready, total: ctx.adblock.total }));

  /* Certificados de la red local (certs.cjs). Aceptar es aceptar el que se
     rechazó en ESA pestaña: la ventana no manda huellas, solo dice cuál. */
  handle('certs:allow', async (ctx, id) => {
    const t = ctx.tabs.list.find((x) => x.id === num(id));
    if (!t?.view || !t.error) throw new Error('Esa pestaña no tiene un certificado para aceptar.');
    const url = t.error.url || t.url;
    const host = await ctx.certs.allow(t.view.webContents.id, url);
    ctx.tabs.navigate(t.id, url);
    return host;
  });
  handle('certs:forget', (ctx, host) => ctx.certs.forget(str(host, 300)));

  handle('permissions:revoke', async (ctx, origin, key) => {
    const o = str(origin, 400);
    ctx.forgetOnce?.(o);
    let had = false;
    await ctx.updateSettings((s) => {
      const all = { ...(s.permissions || {}) };
      if (!all[o]) return null;
      had = true;
      if (key) { all[o] = { ...all[o] }; delete all[o][str(key, 60)]; if (!Object.keys(all[o]).length) delete all[o]; } else delete all[o];
      return { permissions: all };
    });
    return had;
  });

  handle('data:clear', async (ctx, what = {}) => {
    const done = [];
    if (what.history) { ctx.library.clearHistory(Number(what.since) || 0); done.push('historial'); changed(); }
    if (what.cookies) {
      await ctx.web.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'websql', 'shadercache'] });
      done.push('cookies y datos de sitios');
    }
    if (what.cache) { await ctx.web.clearCache(); await ctx.web.clearCodeCaches({}).catch(() => {}); done.push('caché'); }
    return done;
  });

  handle('dialog:folder', async (ctx, current) => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Carpeta de descargas',
      defaultPath: current ? str(current, 1000) : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('app:info', (ctx) => ({
    private: !!ctx.private,
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
  handle('app:relaunch', (ctx) => { app.relaunch(); app.quit(); return true; });
  handle('app:open-data', (ctx) => shell.openPath(store.ROOT));

  handle('net:online', (ctx) => net.isOnline());
}

module.exports = { register, fromChrome };
