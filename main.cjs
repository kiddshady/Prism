'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — proceso principal
   Un navegador sobre Electron. La ventana es el cromo (pestañas, omnibox,
   paneles), dibujado con Opal; cada página es un WebContentsView apoyado
   encima, en el rectángulo que el cromo le deja. El detalle de las pestañas
   está en src/tabs.cjs; acá se arma todo y se decide el orden de arranque.

   ── El arranque sin un frame blanco (heredado de Opal) ───────────────────
   Hay dos destellos distintos y se arreglan distinto:
     A) FOUC: antes de que el renderer pinte, Chromium muestra el fondo de la
        ventana. `show:false` + `backgroundColor` oscuro + el splash inline.
     B) DWM: al pasar de oculta a visible, el compositor de Windows pinta su
        backdrop encima de todo. No se evita: se provoca donde nadie lo vea.
        La ventana nace en x:-20000, hace su primer show() ahí, y 200 ms
        después se muda a su lugar. Con 120 ms el flash vuelve a veces.
   Y Electron ≥ 40: el frame fantasma de minimizar→restaurar se tiñe con el
   `backgroundColor`. En la 33 es blanco y no hay forma de taparlo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, screen, shell, nativeTheme, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./src/store.cjs');
const ipc = require('./src/ipc.cjs');
const shortcuts = require('./src/shortcuts.cjs');
const omni = require('./src/omni.cjs');
const { createLibrary } = require('./src/library.cjs');
const { createTabs } = require('./src/tabs.cjs');
const { createWeb } = require('./src/web.cjs');
const { createAdblock } = require('./src/adblock.cjs');
const { createDownloads } = require('./src/downloads.cjs');
const { createPrompts } = require('./src/prompts.cjs');
const updater = require('./src/updater.cjs');

/* Color base de arranque: el --op-bg de tokens.css, resuelto a hex. El
   renderer lo vuelve a mandar apenas carga (win.setBackground), así que este
   literal solo cubre los primeros milisegundos. `npm test` vigila que coincida. */
const BG = '#0a0a0a';

const DEFAULT_W = 1360;
const DEFAULT_H = 880;
const MIN_W = 720;
const MIN_H = 480;

/* ── Antes de `ready` ────────────────────────────────────────────────────────
   Lo que es switch de Chromium tiene que estar puesto antes de que arranque.
   Por eso "forzar oscuro" se lee del disco a mano, sincrónico: el store
   asíncrono todavía no puede correr. */
const early = (() => {
  try { return JSON.parse(fs.readFileSync(store.SETTINGS_FILE, 'utf8')); } catch { return {}; }
})();
if (early.forceDark) app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark');

/* Modo de verificación (tools/shot.ps1 y el humo): la ventana vive FUERA de
   pantalla, sin robar el foco, con su propio perfil. Así se la puede manejar y
   fotografiar mientras la persona sigue usando la compu, y sin tocar su
   Prism de verdad (ni su candado de instancia única). Una ventana tapada deja
   de pintar y la captura sale vieja: por eso también se apaga la oclusión. */
const SHOTS = !!process.env.PRISM_SHOTS;
if (SHOTS) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.setPath('userData', process.env.PRISM_PROFILE || path.join(require('os').tmpdir(), 'prism-shots'));
}

/* Las páginas ven prefers-color-scheme: dark. Los sitios con modo oscuro
   (GitHub, YouTube, Google…) arrancan en oscuro sin hacer nada. */
nativeTheme.themeSource = 'dark';

/* Una sola instancia: abrir Prism de nuevo (o un link con Prism) suma una
   pestaña a la ventana que ya está, en vez de levantar otro navegador. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** Las direcciones que llegan por la línea de comandos. */
function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => {
    if (/^https?:\/\//i.test(a)) return true;
    if (/\.(html?|pdf|svg|txt|xml|json)$/i.test(a) && fs.existsSync(a)) return true;
    return false;
  }).map((a) => (/^https?:/i.test(a) ? a : `file:///${path.resolve(a).replace(/\\/g, '/')}`));
}

const ctx = {
  win: null,
  web: null,
  settings: {},
  shortcuts,
  sessionDoc: store.doc('session', null),
  library: createLibrary({ historyDoc: store.doc('history', null), bookmarksDoc: store.doc('bookmarks', null) }),
  tabs: null,
  downloads: null,
  adblock: null,
  prompts: null,

  send(channel, payload) {
    const w = ctx.win;
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  },

  async saveSettings(patch) {
    const before = ctx.settings;
    ctx.settings = await store.saveSettings(patch);
    ctx.send('settings:changed', ctx.settings);
    // Lo que tiene efecto inmediato sobre las pestañas abiertas.
    if (before.adblock !== ctx.settings.adblock) ctx.tabs?.reload();
    if (before.pageScrollbars !== ctx.settings.pageScrollbars) ctx.setPageScrollbars?.(ctx.settings.pageScrollbars);
    ctx.tabs?.emit();
    return ctx.settings;
  },

  /** Enfoca la ventana (el cromo) para que la interfaz reciba el teclado. */
  focusChrome() {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.focus();
  },

  /* Los atajos llegan acá desde los dos lados (ver shortcuts.cjs). Lo que es
     de las pestañas se resuelve en el acto; lo que es de la interfaz se le
     pasa al renderer como comando. */
  command(name) {
    const T = ctx.tabs;
    const list = T.list;
    const i = list.findIndex((t) => t.id === T.active?.id);
    const ui = (cmd, focus = true) => { if (focus) ctx.focusChrome(); ctx.send('cmd', cmd); };

    if (name === 'tab:new') { T.create({}); return ui('omni:focus'); }
    // Una fijada no se va con Ctrl+W: se cierra desde su menú, a propósito.
    if (name === 'tab:close') return T.active && !T.active.pinned && T.close(T.active.id);
    if (name === 'tab:reopen') return T.reopen();
    if (name === 'tab:next') return list.length > 1 && T.activate(list[(i + 1) % list.length].id);
    if (name === 'tab:prev') return list.length > 1 && T.activate(list[(i - 1 + list.length) % list.length].id);
    if (name === 'tab:last') return list.length && T.activate(list[list.length - 1].id);
    if (name.startsWith('tab:goto:')) {
      const t = list[Number(name.slice(9)) - 1];
      return t && T.activate(t.id);
    }
    if (name === 'nav:back') return T.back();
    if (name === 'nav:forward') return T.forward();
    if (name === 'nav:home') return T.active && T.navigate(T.active.id, 'prism://nueva');
    if (name === 'page:reload') return T.reload(false);
    if (name === 'page:hard-reload') return T.reload(true);
    if (name === 'page:print') return T.contextAction('print');
    if (name === 'page:source') return T.contextAction('source');
    if (name === 'page:devtools') return T.devtools();
    if (name.startsWith('zoom:')) return T.zoom(name.slice(5));
    if (name.startsWith('open:')) return T.openInternal(name.slice(5));
    if (name === 'app:quit') return ctx.quit();
    if (name === 'win:fullscreen') return ctx.win.setFullScreen(!ctx.win.isFullScreen());
    if (name === 'bookmark:toggle') {
      const t = T.active;
      if (!t || t.internal) return null;
      ctx.library.toggleBookmark({ url: t.url, title: t.title, favicon: t.favicon });
      ctx.send('library:changed');
      return T.emit();
    }
    if (name === 'omni:focus') return ui('omni:focus');
    if (name === 'find:open') return T.active?.view && ui('find:open');
    if (name === 'find:next' || name === 'find:prev') return ui(name, false);
    return null;
  },
};

/* ── Estado de la ventana ────────────────────────────────────────────────────
   Tamaño y posición entre sesiones, validados contra las pantallas de hoy:
   si el monitor donde estaba ya no existe, la ventana quedaría en la nada. */
const winState = store.doc('window', null);

function visibleOn(x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + w > a.x + 40 && x < a.x + a.width - 40 && y + h > a.y && y < a.y + a.height - 40;
  });
}

function centered(w, h) {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2) };
}

async function loadWindowState() {
  const s = await winState.read().catch(() => null);
  const w = Math.max(MIN_W, Number(s?.width) || DEFAULT_W);
  const h = Math.max(MIN_H, Number(s?.height) || DEFAULT_H);
  const hasPos = Number.isFinite(s?.x) && Number.isFinite(s?.y) && visibleOn(s.x, s.y, w, h);
  return { width: w, height: h, maximized: !!s?.maximized, ...(hasPos ? { x: s.x, y: s.y } : centered(w, h)) };
}

let saveTimer = null;
function saveWindowState() {
  const win = ctx.win;
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    winState.write({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
      .catch((err) => console.error('[window] no se pudo guardar el estado:', err.message));
  }, 400);
}

function createWindow(state) {
  const win = new BrowserWindow({
    x: -20000,
    y: -20000,
    width: state.width,
    height: state.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: BG,
    title: 'Prism',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  ctx.win = win;

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (SHOTS) { win.showInactive(); return; }
    win.show();
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setPosition(state.x, state.y);
      if (state.maximized) win.maximize();
    }, 200);
  });

  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (e) => {
      const level = ['debug', 'info', 'warn', 'error'][e.level] ?? e.level;
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] no cargó (${code} ${desc}) → ${url}`);
    });
  }

  // El cromo no hace zoom: Ctrl+rueda o Ctrl++ son de la página.
  win.webContents.setVisualZoomLevelLimits(1, 1);

  const pushMaximized = () => ctx.send('win:maximized', win.isMaximized());
  win.on('maximize', () => { pushMaximized(); saveWindowState(); });
  win.on('unmaximize', () => { pushMaximized(); saveWindowState(); });
  win.on('resize', () => { ctx.tabs?.layout(); saveWindowState(); });
  win.on('move', saveWindowState);
  win.on('leave-full-screen', () => { if (ctx.tabs?.fullscreen) ctx.tabs.setFullscreen(false); });

  // Los botones de atrás/adelante del mouse llegan como app-command en Windows.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') ctx.tabs?.back();
    if (cmd === 'browser-forward') ctx.tabs?.forward();
  });

  // La ventana misma nunca navega ni abre nada: es el cromo, no una página.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) ctx.tabs?.create({ url });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  /* Volver a la ventana devuelve el teclado adonde estaba. Al reactivarse,
     Chromium se lo da al cromo aunque antes lo tuviera la página: el cursor
     seguía titilando en el campo, pero lo que se tipeaba (o lo que insertaba
     Moji, que devuelve la ventana con SetForegroundWindow) caía en la nada.
     El último que tuvo el foco se anota al perderlo la ventana. */
  let focusWas = 'chrome';
  let focusAtBlur = 'chrome';
  ctx.notePageFocus = () => { focusWas = 'page'; };
  win.webContents.on('focus', () => { focusWas = 'chrome'; });
  win.on('blur', () => { focusAtBlur = focusWas; });
  win.on('focus', () => { if (focusAtBlur === 'page') ctx.tabs?.focusPage(); });

  win.webContents.on('before-input-event', (e, input) => {
    const cmd = shortcuts.match(input);
    if (!cmd) return;
    e.preventDefault();
    ctx.command(cmd);
  });

  // Si la interfaz se recarga, lo que esperaba respuesta se niega.
  win.webContents.on('did-start-loading', () => ctx.prompts?.cancelAll());

  /* Cerrar no cierra: Prism se va a la bandeja con sus pestañas vivas (la
     música sigue sonando, las descargas siguen bajando). Salir de verdad es
     "Salir de Prism" — en la bandeja, en el menú, o Ctrl+Mayús+Q. */
  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.hide();
    ctx.tabs?.writeSession();
  });

  win.on('closed', () => { ctx.win = null; });
  return win;
}

/* ── Bandeja ─────────────────────────────────────────────────────────────── */

let tray = null;
let quitting = false;

function showMain() {
  const win = ctx.win;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  quitting = true;
  app.quit();
}
ctx.quit = quit;
ctx.showMain = showMain;

/* El ítem de actualización cambia con el estado: con Prism en la bandeja,
   ese menú puede ser lo único que se ve de él. */
function updateMenuItem() {
  const u = updater.get();
  if (u.phase === 'ready') return { label: `Reiniciar para actualizar a la ${u.version}`, click: () => updater.install(() => { quitting = true; }) };
  if (u.phase === 'available') return { label: `Descargar la ${u.version}`, click: () => { showMain(); updater.download(); } };
  if (u.phase === 'downloading') return { label: `Descargando la ${u.version}… ${Math.round(u.pct * 100)} %`, enabled: false };
  if (u.phase === 'unsupported') return null;
  return { label: 'Buscar actualizaciones', enabled: u.phase !== 'checking', click: () => updater.check({ manual: true }) };
}

let lastMenuKey = '';
function refreshTray() {
  if (!tray) return;
  const item = updateMenuItem();
  const key = item?.label || '';
  if (key === lastMenuKey) return;       // el progreso llega muchas veces por segundo
  lastMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Prism', click: showMain },
    { label: 'Nueva pestaña', click: () => { showMain(); ctx.command('tab:new'); } },
    ...(item ? [{ type: 'separator' }, item] : []),
    { type: 'separator' },
    { label: 'Salir de Prism', click: quit },
  ]));
  tray.setToolTip(updater.get().phase === 'ready' ? 'Prism · actualización lista' : 'Prism');
}

function createTray() {
  const ico = path.join(__dirname, 'build', 'tray.ico');
  if (!fs.existsSync(ico)) return;       // sin `npm run icons`, cerrar vuelve a cerrar
  tray = new Tray(ico);
  refreshTray();
  tray.on('click', showMain);
}

/* ── Controles de ventana ────────────────────────────────────────────────── */
ipcMain.on('win:minimize', () => ctx.win?.minimize());
ipcMain.on('win:toggle-maximize', () => {
  const win = ctx.win;
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  else win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => ctx.win?.close());
ipcMain.on('app:quit', () => quit());

ipcMain.handle('update:state', () => updater.get());
ipcMain.handle('update:check', () => updater.check({ manual: true }));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install(() => { quitting = true; }));
ipcMain.handle('win:is-maximized', () => !!ctx.win?.isMaximized());
ipcMain.on('win:set-bg', (_e, hex) => {
  if (ctx.win && !ctx.win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(String(hex))) ctx.win.setBackgroundColor(hex);
});

/* ── Arranque ────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  ctx.settings = await store.loadSettings();

  const { session, userAgent, setPageScrollbars } = createWeb(Object.assign(ctx, { prompts: createPrompts(ctx) }));
  ctx.web = session;
  ctx.setPageScrollbars = setPageScrollbars;
  app.userAgentFallback = userAgent;

  ctx.adblock = createAdblock(ctx, { cacheFile: path.join(store.ROOT, 'adblock-engine.bin') });
  ctx.downloads = createDownloads(ctx, { doc: store.doc('downloads', null) });
  ctx.downloads.attach(session);

  await Promise.all([
    ctx.library.load().catch((err) => console.error('[library]', err.message)),
    ctx.downloads.load().catch((err) => console.error('[downloads]', err.message)),
  ]);

  ipc.register(ctx);
  ctx.tabs = createTabs(ctx);
  createWindow(await loadWindowState());
  // La bandeja no se crea en modo verificación: no tiene por qué aparecer un
  // ícono en la barra de la persona mientras corren las pruebas.
  if (!SHOTS || process.env.PRISM_TRAY) createTray();
  updater.init({ onChange: (u) => { ctx.send('update:state', u); refreshTray(); } });

  // El bloqueador baja listas la primera vez: no puede demorar la ventana.
  ctx.adblock.load().catch((err) => console.error('[adblock] no cargó:', err.message));

  const fromArgv = urlsFromArgv(process.argv);
  let restored = false;
  if (ctx.settings.startup === 'restore') {
    restored = ctx.tabs.restore(await ctx.sessionDoc.read().catch(() => null));
  }
  for (const url of fromArgv) ctx.tabs.create({ url });
  if (!restored && !fromArgv.length) ctx.tabs.create({});
});

app.on('second-instance', (_e, argv) => {
  if (!ctx.win) return;
  // Abrir Prism otra vez (o un link con Prism) lo trae de la bandeja.
  showMain();
  const urls = urlsFromArgv(argv);
  if (urls.length) urls.forEach((url) => ctx.tabs.create({ url }));
  else ctx.command('tab:new');
});

/* Antes de salir, lo pendiente se escribe: el historial y las pestañas viven
   en memoria con escritura diferida, y salir sin esperar perdería lo último. */
let flushed = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (flushed) return;
  e.preventDefault();
  flushed = true;
  const pend = [ctx.library.flushAll(), ctx.tabs?.writeSession()].filter(Boolean);
  Promise.race([Promise.all(pend), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

/* Captura de verificación: la foto del cromo y, aparte, la de la página
   activa con su rectángulo. tools/shot.mjs las compone. (PrintWindow devuelve
   composición vieja de DWM para las zonas que la vista nativa no repintó.) */
if (SHOTS) {
  globalThis.__prismCtx = ctx;
  globalThis.__prismShot = async (dir) => {
    const fsp = require('fs/promises');
    await fsp.mkdir(dir, { recursive: true });
    const chrome = await ctx.win.webContents.capturePage();
    await fsp.writeFile(path.join(dir, 'chrome.png'), chrome.toPNG());
    const t = ctx.tabs.active;
    // Una vista congelada está corrida afuera de la ventana: no se ve, no se pega.
    const view = t?.view && ctx.win.contentView.children.includes(t.view) && t.view.getBounds().x >= 0 ? t.view : null;
    let bounds = null;
    if (view) {
      const img = await view.webContents.capturePage();
      await fsp.writeFile(path.join(dir, 'view.png'), img.toPNG());
      bounds = view.getBounds();
    }
    return JSON.stringify({ bounds, scale: ctx.win.webContents.getZoomFactor() });
  };
}

/* Endurecimiento: ninguna página puede adjuntar un <webview> (tendría su
   propio preload) ni abrir un esquema raro fuera del navegador sin permiso. */
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});

module.exports = { ctx, omni, shell };
