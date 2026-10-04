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

const { app, BrowserWindow, ipcMain, screen, shell, nativeTheme, Tray, Menu, globalShortcut } = require('electron');
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
const { createPasswords } = require('./src/passwords.cjs');
const { createCerts } = require('./src/certs.cjs');
const { createCapture } = require('./src/capture.cjs');
const { createPrint } = require('./src/print.cjs');
const { createCard } = require('./src/card.cjs');
const { createFill } = require('./src/fill.cjs');
const ui = require('./src/ui-protocol.cjs');
const { createPip } = require('./src/pip.cjs');
const windows = require('./src/windows.cjs');
const updater = require('./src/updater.cjs');
const { createDefaultBrowser, targetsFromArgv } = require('./src/default-browser.cjs');
const { createAutostart, HIDDEN } = require('./src/autostart.cjs');

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
/* Scrollbars flotantes en las páginas, como Edge y Firefox en Windows 11: van
   ENCIMA del contenido y no ocupan lugar. Una clásica reserva su carril, y en
   sitios que pintan un <html> de otro color que su contenido (Instagram) por
   ahí asomaba una franja. Las de la ventana siguen siendo las propias: el CSS
   de base.css las dibuja, y una scrollbar con estilo nunca es flotante.
   Desde Electron 44 (Chromium 152) eso se decide ANTES de que corra este
   archivo: un appendSwitch('enable-features') llega tarde y no hace nada.
   Tiene que venir en la línea de comandos de verdad. Los scripts de
   package.json (start, dev, smoke) lo pasan; la app instalada, si no lo
   trae, se relanza una vez con él antes de abrir ninguna ventana (abajo,
   después del candado de instancia única: ~0,2 s, una vez por arranque).
   Lo de acá suma, no pisa: un segundo enable-features reemplaza al primero. */
const OVERLAY = '--enable-features=OverlayScrollbar';
const overlayFromLaunch = process.argv.some((a) => a.startsWith('--enable-features=') && a.slice(18).split(',').includes('OverlayScrollbar'));
const FEATURES = new Set(app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean));
FEATURES.add('OverlayScrollbar');
app.commandLine.appendSwitch('enable-features', [...FEATURES].join(','));

/* "Oscurecer todo": el modo oscuro forzado de Blink, para los sitios que no
   tienen uno propio. La feature WebContentsForceDark (la de Chrome) la lee
   la capa de Chrome, que Electron no trae: no hacía nada. Este switch es un
   ajuste de Blink y sí anda, puesto desde acá (Electron 44: una página blanca
   da 18,18,18). Vale para todos los renderers, también el cromo: lo que
   declara `color-scheme: dark` queda afuera (base.css), igual que los sitios
   que ya son oscuros. Los canvas y las imágenes no se tocan, así que las
   hojas de la vista previa de impresión siguen blancas. */
if (early.forceDark) app.commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=true');

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

// La interfaz se sirve por su propio esquema, no como file:// (ver src/ui-protocol.cjs).
ui.registerScheme();

/* Las páginas ven prefers-color-scheme: dark. Los sitios con modo oscuro
   (GitHub, YouTube, Google…) arrancan en oscuro sin hacer nada. */
nativeTheme.themeSource = 'dark';

/* Una sola instancia: abrir Prism de nuevo (o un link con Prism) suma una
   pestaña a la ventana que ya está, en vez de levantar otro navegador. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* La app instalada que arrancó sin las scrollbars flotantes (un acceso
   directo, Windows al iniciar sesión, un link) se relanza con ellas. El
   flag va PRIMERO: lo que viene después de -- (un link) Chromium ya no lo
   lee como opción. El proceso nuevo arranca cuando este terminó de irse,
   así que el candado lo toma él. */
if (app.isPackaged && !overlayFromLaunch) {
  app.relaunch({ args: [OVERLAY, ...process.argv.slice(1)] });
  app.exit(0);
}

/** La fila de los guardados de ajustes (ver ctx.updateSettings). */
let settingsQueue = Promise.resolve();

/* El contexto de la ventana normal, que es también la raíz: lo que se comparte
   (favoritos, ajustes, bloqueador, contraseñas) vive acá, y la ventana de
   incógnito lo hereda (ver openIncognito). Lo que es de cada ventana —enviarle
   algo, sus atajos— lo arma windowMethods. */
const ctx = {
  private: false,
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
  passwords: null,
  certs: null,

  saveSettings(patch) {
    return ctx.updateSettings(() => patch);
  },

  /* Los ajustes se guardan de a uno, en fila. Guardar es leer el archivo,
     mezclar y escribir: dos guardados a la vez leían el mismo archivo viejo
     y el segundo pisaba al primero (dos "Olvidar" seguidos dejaban uno sin
     olvidar). Y el cambio se calcula recién cuando le toca, con `fn` sobre
     los ajustes ya al día: quien agrega o saca algo de una lista (permisos,
     sitios del bloqueador, "nunca guardar") no la pisa con una copia vieja.
     `fn` devuelve el parche, o null para no guardar nada. */
  updateSettings(fn) {
    const run = settingsQueue.then(async () => {
      const before = ctx.settings;
      const patch = fn(before);
      if (!patch) return ctx.settings;
      ctx.settings = await store.saveSettings(patch);
      windows.broadcast('settings:changed', ctx.settings);
      // Lo que tiene efecto inmediato sobre las pestañas abiertas (de todas las ventanas).
      if (before.adblock !== ctx.settings.adblock) windows.all().forEach((w) => w.tabs?.reload());
      if (before.passwords !== ctx.settings.passwords) ctx.passwords?.setEnabled(ctx.settings.passwords !== false);
      windows.all().forEach((w) => w.tabs?.emit());
      return ctx.settings;
    });
    settingsQueue = run.catch(() => {});
    return run;
  },
};

/** Lo que es de cada ventana: mandarle algo a su cromo, darle el teclado, sus atajos. */
function windowMethods(w) {
  w.send = (channel, payload) => {
    const win = w.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };
  /** Enfoca la ventana (el cromo) para que la interfaz reciba el teclado. */
  w.focusChrome = () => { if (w.win && !w.win.isDestroyed()) w.win.webContents.focus(); };
  w.command = (name) => command(w, name);
  return w;
}

/* Los atajos llegan acá desde los dos lados (ver shortcuts.cjs), de la
   ventana que sea. Lo que es de las pestañas se resuelve en el acto; lo que
   es de la interfaz se le pasa al renderer como comando. */
function command(w, name) {
  const T = w.tabs;
  const list = T.list;
  const i = list.findIndex((t) => t.id === T.active?.id);
  const ui = (cmd, focus = true) => { if (focus) w.focusChrome(); w.send('cmd', cmd); };

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
  if (name === 'page:capture-full') return w.capture.run('full');
  if (name === 'page:pip') return ctx.pip.toggle(w);
  if (name === 'page:source') return T.contextAction('source');
  if (name === 'page:devtools') return T.devtools();
  if (name.startsWith('zoom:')) return T.zoom(name.slice(5));
  if (name.startsWith('open:')) return T.openInternal(name.slice(5));
  if (name === 'app:quit') return quit();
  if (name === 'win:incognito') return openIncognito();
  if (name === 'win:fullscreen') return w.win.setFullScreen(!w.win.isFullScreen());
  if (name === 'bookmark:toggle') {
    const t = T.active;
    if (!t || t.internal) return null;
    ctx.library.toggleBookmark({ url: t.url, title: t.title, favicon: t.favicon });
    windows.broadcast('library:changed');
    return windows.all().forEach((x) => x.tabs?.emit());
  }
  if (name === 'bookmarks:bar') return ctx.updateSettings((s) => ({ bookmarksBar: s.bookmarksBar === false }));
  if (name === 'omni:focus') return ui('omni:focus');
  if (name === 'find:open') return T.active?.view && ui('find:open');
  if (name === 'find:next' || name === 'find:prev') return ui(name, false);
  return null;
}
windowMethods(ctx);

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

/* El primer show() de una ventana: nace FUERA de pantalla (x/y -20000) y se
   muestra ahí, donde el destello del compositor no lo ve nadie; recién
   después va a su lugar. */
function place(win, state) {
  win.show();
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setPosition(state.x, state.y);
    if (state.maximized) win.maximize();
  }, 200);
}

/* La misma ventana para las dos: la normal (que recuerda dónde estaba y se va
   a la bandeja al cerrarla) y la de incógnito (que se cierra de verdad). */
function createWindow(w, state) {
  const main = !w.private;
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
    title: main ? 'Prism' : 'Prism · Incógnito',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.win = win;
  const offList = windows.add(w);

  win.loadURL(ui.uiUrl('index.html'));

  win.once('ready-to-show', () => {
    if (SHOTS) { win.showInactive(); return; }
    /* Arrancó con Windows: carga escondida en la bandeja. El primer show()
       (fuera de pantalla, y recién después a su lugar) queda para cuando la
       persona la llame — ver showMain. */
    if (state.hidden) return;
    place(win, state);
  });
  if (state.hidden) w.unplaced = state;

  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (e) => {
      const level = ['debug', 'info', 'warn', 'error'][e.level] ?? e.level;
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] no cargó (${code} ${desc}) → ${url}`);
    });
  }

  // El título lo pone tabs.cjs (la pestaña activa): el <title> del cromo no lo pisa.
  win.on('page-title-updated', (e) => e.preventDefault());

  // El cromo no hace zoom: Ctrl+rueda o Ctrl++ son de la página.
  win.webContents.setVisualZoomLevelLimits(1, 1);

  // Solo la normal recuerda su tamaño y su lugar.
  const saveState = () => { if (main) saveWindowState(); };
  const pushMaximized = () => w.send('win:maximized', win.isMaximized());
  win.on('maximize', () => { pushMaximized(); saveState(); });
  win.on('unmaximize', () => { pushMaximized(); saveState(); });
  win.on('resize', () => { w.tabs?.layout(); saveState(); });
  win.on('move', saveState);
  win.on('leave-full-screen', () => { if (w.tabs?.fullscreen) w.tabs.setFullscreen(false); });

  // Los botones de atrás/adelante del mouse llegan como app-command en Windows.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') w.tabs?.back();
    if (cmd === 'browser-forward') w.tabs?.forward();
  });

  // La ventana misma nunca navega ni abre nada: es el cromo, no una página.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) w.tabs?.create({ url });
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
  w.notePageFocus = () => { focusWas = 'page'; };
  win.webContents.on('focus', () => { focusWas = 'chrome'; });
  win.on('blur', () => { focusAtBlur = focusWas; });
  win.on('focus', () => { if (focusAtBlur === 'page') w.tabs?.focusPage(); });

  win.webContents.on('before-input-event', (e, input) => {
    const cmd = shortcuts.match(input);
    if (!cmd) return;
    e.preventDefault();
    w.command(cmd);
  });

  // Si la interfaz se recarga, lo que esperaba respuesta se niega.
  win.webContents.on('did-start-loading', () => w.prompts?.cancelAll());

  /* Cerrar la normal no cierra: Prism se va a la bandeja con sus pestañas
     vivas (la música sigue sonando, las descargas siguen bajando). Salir de
     verdad es "Salir de Prism" — en la bandeja, en el menú, o Ctrl+Mayús+Q.
     La de incógnito sí se cierra: cerrarla es terminar la sesión. */
  win.on('close', (e) => {
    if (!main || quitting || !tray) return;
    e.preventDefault();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.hide();
    w.tabs?.writeSession();
  });

  /* Apagar o reiniciar Windows (o cerrar la sesión) no pasa por before-quit:
     Windows le avisa a cada ventana —también a la escondida en la bandeja— y
     después puede matar el proceso en cualquier momento. Lo pendiente se
     escribe en el aviso mismo, sin soltar el hilo (store.cjs, trampa 4). El
     primero puede no terminar en apagado (otra app lo frena): las descargas
     se cortan recién con el segundo. */
  if (main) {
    win.on('query-session-end', () => flushSync());
    win.on('session-end', () => { quitting = true; flushSync({ downloads: true }); });
  }

  win.on('closed', () => {
    offList();
    w.win = null;
    w.onClosed?.();
  });
  return win;
}

/* ── Bandeja ─────────────────────────────────────────────────────────────── */

let tray = null;
let quitting = false;

function showMain() {
  const win = ctx.win;
  if (!win || win.isDestroyed()) return;
  // Escondida desde el arranque con Windows: este es su primer show().
  if (ctx.unplaced) {
    const state = ctx.unplaced;
    ctx.unplaced = null;
    place(win, state);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Ctrl+Alt+P: si Prism es lo que estás mirando, se va a la bandeja (igual
    que al cerrarlo); si está tapado, minimizado o en la bandeja, viene. */
function toggleMain() {
  const win = ctx.win;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible() || win.isMinimized() || !win.isFocused()) return showMain();
  if (!tray) return win.minimize();       // sin bandeja, ocultarla la dejaría inalcanzable
  if (win.isFullScreen()) win.setFullScreen(false);
  win.hide();
  ctx.tabs?.writeSession();
}

/* Salir corta lo que se está bajando, y Chromium no lo retoma: antes se
   pregunta, como Chrome. Vale para salir, reiniciar y actualizar. */
let leaving = null;
function confirmLeave(kind = 'quit') {
  const active = [...new Set(windows.all().map((w) => w.downloads).filter(Boolean))].flatMap((d) => d.active());
  if (!active.length) return Promise.resolve(true);
  if (leaving) return leaving;
  // En las pruebas ya está a la vista (sin foco): traerla le robaría el foco a la persona.
  if (!SHOTS) showMain();
  const one = active.length === 1 ? active[0] : null;
  const verb = kind === 'quit' ? ['Salir', 'salís'] : ['Reiniciar', 'reiniciás'];
  leaving = ctx.prompts.confirm({
    title: one ? 'Hay una descarga en curso' : `Hay ${active.length} descargas en curso`,
    sub: one
      ? `«${one.filename}» todavía está bajando${one.pct != null ? ` (va por el ${one.pct} %)` : ''}. Si ${verb[1]} ahora, se corta y queda en la lista para bajarla de nuevo.`
      : `Si ${verb[1]} ahora, se cortan y quedan en la lista para bajarlas de nuevo.`,
    confirmLabel: `${verb[0]} igual`,
    cancelLabel: 'Seguir bajando',
  }).finally(() => { leaving = null; });
  return leaving;
}

async function quit() {
  if (!(await confirmLeave('quit'))) return;
  quitting = true;
  app.quit();
}

async function installUpdate() {
  if (updater.get().phase !== 'ready' || !(await confirmLeave('update'))) return false;
  return updater.install(() => { quitting = true; });
}

/** Lo pendiente al disco YA, sin soltar el hilo: Windows se está apagando. */
function flushSync({ downloads = false } = {}) {
  ctx.library.flushAllSync();
  ctx.tabs?.writeSessionSync();
  if (downloads) ctx.downloads?.flushSync();
}

/* Un archivo de datos ilegible se aparta (store.cjs) y Prism arranca sin
   él: que no pase callado. Se avisa cuando la ventana está a la vista (puede
   haber arrancado escondida en la bandeja). La bóveda, además, lo dice en
   Contraseñas. */
function tellAsides() {
  const files = [...new Set(store.asides().map((a) => path.basename(a.file)))];
  const win = ctx.win;
  if (!files.length || !win || win.isDestroyed()) return;
  const text = files.length === 1
    ? `${files[0]} estaba dañado: quedó aparte en la carpeta de datos y Prism arrancó sin él`
    : `${files.join(', ')} estaban dañados: quedaron aparte en la carpeta de datos y Prism arrancó sin ellos`;
  const say = () => setTimeout(() => ctx.send('status:msg', { text, icon: 'alert', tone: 'error', ms: 15000 }), 900);
  const whenShown = () => (win.isVisible() ? say() : win.once('show', say));
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', whenShown);
  else whenShown();
}

ctx.quit = quit;
ctx.confirmLeave = confirmLeave;
ctx.showMain = showMain;
ctx.toggleMain = toggleMain;

/** Una página propia (historial, ajustes…) en la ventana normal, al frente. */
ctx.openPage = (page) => {
  showMain();
  ctx.tabs?.openInternal(page);
};

/* ── Incógnito ───────────────────────────────────────────────────────────────
   Una sola ventana de incógnito a la vez: Ctrl+Mayús+N la abre, o la trae si
   ya está. Es un contexto que hereda del normal (favoritos, ajustes,
   bloqueador, contraseñas) y tiene lo suyo:
   · Su sesión de páginas, en memoria y en una partición NUEVA cada vez: las
     cookies y los logins de la ventana anterior no existen para esta.
   · Sus pestañas, que no anotan historial ni se guardan para el reinicio
     (tabs.cjs), y sus permisos, que no se recuerdan (web.cjs).
   · Su lista de descargas, que no se escribe nunca: los archivos quedan en la
     carpeta, pero la lista se olvida al cerrar.
   · El gestor completa, pero nunca ofrece guardar (passwords.cjs).
   Cerrarla la termina: se cierran sus pestañas y se borra su sesión. */
let ghost = null;
let ghostSeq = 0;
const memoryDoc = () => ({ read: async () => null, write: async () => {}, remove: async () => {} });

function openIncognito(url = '') {
  if (ghost?.win && !ghost.win.isDestroyed()) {
    const win = ghost.win;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (url) ghost.tabs.create({ url });
    return ghost;
  }

  const g = windowMethods(Object.create(ctx));
  g.private = true;
  g.prompts = createPrompts(g);
  const web = createWeb(g, { partition: `prism-incognito-${Date.now()}-${++ghostSeq}`, private: true });
  g.web = web.session;
  g.downloads = createDownloads(g, { doc: memoryDoc() });
  g.downloads.attach(g.web);
  ctx.adblock.addSession(g.web);
  ctx.passwords.addSession(g.web);
  g.capture = createCapture(g);
  g.print = createPrint(g);
  g.card = createCard(g);
  g.fill = createFill(g);
  g.tabs = createTabs(g);

  g.onClosed = () => {
    g.tabs.destroyAll();
    web.dispose();
    ctx.adblock.removeSession(g.web);
    ctx.passwords.forgetSession(g.web);
    // En memoria igual, pero que no quede nada al alcance mientras Prism siga abierto.
    g.web.clearStorageData().catch(() => {});
    g.web.clearCache().catch(() => {});
    if (ghost === g) ghost = null;
  };

  // Al lado de la normal, un poco corrida, como una ventana nueva de Chrome.
  const b = ctx.win && !ctx.win.isDestroyed() ? ctx.win.getNormalBounds() : null;
  const width = b?.width || DEFAULT_W;
  const height = b?.height || DEFAULT_H;
  const pos = b && visibleOn(b.x + 32, b.y + 32, width, height) ? { x: b.x + 32, y: b.y + 32 } : centered(width, height);
  createWindow(g, { width, height, ...pos, maximized: false });
  g.tabs.create({ url });
  ghost = g;
  return g;
}
ctx.openIncognito = openIncognito;

/* El ítem de actualización cambia con el estado: con Prism en la bandeja,
   ese menú puede ser lo único que se ve de él. */
function updateMenuItem() {
  const u = updater.get();
  if (u.phase === 'ready') return { label: `Reiniciar para actualizar a la ${u.version}`, click: installUpdate };
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
    { label: 'Nueva ventana de incógnito', click: () => openIncognito() },
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

/* ── Controles de ventana ──────────────────────────────────────────────────
   Como en src/ipc.cjs: solo el cromo de una ventana de Prism manda esto, nunca
   una página, y cada pedido es sobre la ventana que lo mandó. */
const chromeOn = (channel, fn) => ipcMain.on(channel, (e, ...args) => { const w = windows.ofSender(e); if (w) fn(w, ...args); });
const chromeHandle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  const w = windows.ofSender(e);
  if (!w) throw new Error('No autorizado.');
  return fn(w, ...args);
});

chromeOn('win:minimize', (w) => w.win?.minimize());
chromeOn('win:toggle-maximize', (w) => {
  const win = w.win;
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  else win.isMaximized() ? win.unmaximize() : win.maximize();
});
chromeOn('win:close', (w) => w.win?.close());
chromeOn('win:incognito', () => openIncognito());
chromeOn('app:quit', () => quit());

chromeHandle('update:state', () => updater.get());
chromeHandle('update:check', () => updater.check({ manual: true }));
chromeHandle('update:download', () => updater.download());
chromeHandle('update:install', () => installUpdate());
chromeHandle('win:is-maximized', (w) => !!w.win?.isMaximized());
chromeOn('win:set-bg', (w, hex) => {
  if (w.win && !w.win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(String(hex))) w.win.setBackgroundColor(hex);
});

/* ── Arranque ────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  ui.serve();
  ctx.settings = await store.loadSettings();

  const { session, userAgent } = createWeb(Object.assign(ctx, { prompts: createPrompts(ctx) }));
  ctx.web = session;
  app.userAgentFallback = userAgent;

  ctx.adblock = createAdblock(ctx, { cacheFile: path.join(store.ROOT, 'adblock-engine.bin') });
  ctx.downloads = createDownloads(ctx, { doc: store.doc('downloads', null) });
  ctx.downloads.attach(session);
  ctx.passwords = createPasswords(ctx);
  ctx.certs = createCerts(ctx);
  ctx.capture = createCapture(ctx);
  ctx.print = createPrint(ctx);
  ctx.card = createCard(ctx);
  ctx.fill = createFill(ctx);
  // Una sola ventanita para todas las ventanas (la de incógnito la hereda).
  ctx.pip = createPip({ store, icon: path.join(__dirname, 'build', 'icon.png') });
  ctx.defaultBrowser = createDefaultBrowser({ app, shell });
  ctx.autostart = createAutostart({ app });

  await Promise.all([
    ctx.library.load().catch((err) => console.error('[library]', err.message)),
    ctx.downloads.load().catch((err) => console.error('[downloads]', err.message)),
    ctx.passwords.load().catch((err) => console.error('[pass]', err.message)),
  ]);

  ipc.register();
  ctx.tabs = createTabs(ctx);
  /* Lanzado por el arranque con Windows (autostart.cjs): carga escondido. */
  const hidden = !SHOTS && process.argv.includes(HIDDEN);
  createWindow(ctx, { ...(await loadWindowState()), hidden });
  tellAsides();
  // La bandeja no se crea en modo verificación: no tiene por qué aparecer un
  // ícono en la barra de la persona mientras corren las pruebas.
  if (!SHOTS || process.env.PRISM_TRAY) createTray();
  // Sin bandeja no habría de dónde sacarlo: se muestra igual.
  if (hidden && !tray) showMain();
  /* Ctrl+Alt+P desde cualquier lado de Windows: muestra u oculta Prism (ver
     toggleMain). Global de verdad, así que en las pruebas no: le robaría el
     atajo al Prism de todos los días. */
  if (!SHOTS && !globalShortcut.register(shortcuts.GLOBAL_TOGGLE, toggleMain)) {
    console.error(`[atajos] ${shortcuts.GLOBAL_TOGGLE} ya lo tiene otra app`);
  }
  updater.init({ onChange: (u) => { windows.broadcast('update:state', u); refreshTray(); } });

  // El bloqueador baja listas la primera vez: no puede demorar la ventana.
  ctx.adblock.load().catch((err) => console.error('[adblock] no cargó:', err.message));

  const fromArgv = targetsFromArgv(process.argv);
  let restored = false;
  if (ctx.settings.startup === 'restore') {
    restored = ctx.tabs.restore(await ctx.sessionDoc.read().catch(() => null));
  }
  for (const url of fromArgv) ctx.tabs.create({ url });
  if (!restored && !fromArgv.length) ctx.tabs.create({});

  /* Prism se anota como navegador de Windows (default-browser.cjs): así
     aparece en Aplicaciones predeterminadas y en "Abrir con", y si la
     carpeta de Prism cambió, el registro se corrige solo. Es un `reg import`
     de fondo, un rato después de arrancar: no le roba nada a la ventana. */
  if (ctx.defaultBrowser.supported && !SHOTS) {
    setTimeout(() => ctx.defaultBrowser.register().catch((err) => console.error('[predeterminado]', err.message)), 5000);
  }
  if (!SHOTS) {
    try { ctx.autostart.refresh(); } catch (err) { console.error('[arranque]', err.message); }
  }
});

app.on('second-instance', (_e, argv, cwd) => {
  if (!ctx.win) return;
  // Abrir Prism otra vez (o un link con Prism) lo trae de la bandeja.
  showMain();
  const urls = targetsFromArgv(argv, { cwd });
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
  const pend = [ctx.library.flushAll(), ctx.tabs?.writeSession(), ctx.downloads?.flush()].filter(Boolean);
  Promise.race([Promise.all(pend), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

/* Captura de verificación: la foto del cromo y, aparte, la de la página
   activa con su rectángulo. tools/shot.mjs las compone. (PrintWindow devuelve
   composición vieja de DWM para las zonas que la vista nativa no repintó.) */
if (SHOTS) {
  globalThis.__prismCtx = ctx;
  globalThis.__prismGhost = () => ghost;
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
  const id = wc.id;
  wc.once('destroyed', () => {
    // El primer paso de un login en dos pasos se recuerda por pestaña: se va con ella.
    ctx.passwords?.forgetTab(id);
    // Lo que esa pestaña preguntaba (la cámara, la ubicación) ya no tiene a quién
    // concedérselo: se niega y el diálogo se cierra, en vez de quedar esperando.
    windows.all().forEach((w) => w.prompts?.cancelAll(id));
  });
});

module.exports = { ctx, omni, shell };
