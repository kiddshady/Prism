'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la ventanita (picture-in-picture propio)
   Un video afuera, en una ventana chica que queda siempre arriba mientras se
   usa otra cosa. No es la de Chromium: es una ventana de Prism, con sus
   controles, y adentro está la página de verdad.

   ── Cómo funciona ──────────────────────────────────────────────────────────
   La vista de la pestaña (su WebContentsView) se MUDA a la ventanita, y ahí
   el video se pone en pantalla completa dentro de su página (el preload de
   las páginas, src/pip-preload.cjs). Así no se copia ningún cuadro: el video
   sigue siendo el mismo, con su sonido, sus subtítulos y su reproductor, y
   la ventana grande no se entera de esa pantalla completa (la ventanita no
   se puede poner en pantalla completa, así que se queda adentro).
   Encima de la página va otra vista, transparente, con los controles
   (renderer/pip.html): pausa, adelantar, silencio, volver a la pestaña y
   cerrar. La tapa entera: la página ya no recibe el mouse.

   Mientras el video está afuera, la pestaña muestra que se está viendo en la
   ventanita (pages.js), con un botón para traerlo de vuelta.

   ── Una sola ──────────────────────────────────────────────────────────────
   Como en Chrome, hay una ventanita a la vez, para todas las ventanas de
   Prism. Sacar otro video devuelve el anterior a su pestaña (sigue sonando).

   ── Cuándo vuelve sola ────────────────────────────────────────────────────
   Si la página sale de la pantalla completa por su cuenta, navega a otra
   página, o se cae, la página vuelve a su pestaña. Si la pestaña se cierra,
   la ventanita se va con ella.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const { BaseWindow, WebContentsView, ipcMain, screen } = require('electron');
const { uiUrl } = require('./ui-protocol.cjs');
const windows = require('./windows.cjs');
const shortcuts = require('./shortcuts.cjs');

const MIN_W = 240;
const DEFAULT_W = 420;
/** Separación de los bordes de la pantalla. */
const EDGE = 24;
const FADE_IN = 180;
const FADE_OUT = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una foto de la página, para el fundido de su hoja (tabs.showPhoto). */
async function shoot(view) {
  try {
    const img = await view.webContents.capturePage();
    return img.isEmpty() ? null : `data:image/jpeg;base64,${img.toJPEG(88).toString('base64')}`;
  } catch { return null; }
}
const alive = (f) => { try { return !!f && !f.isDestroyed?.() && f.url !== undefined; } catch { return false; } };
const sameFrame = (a, b) => {
  try { return !!a && !!b && a.processId === b.processId && a.routingId === b.routingId; } catch { return false; }
};

function createPip({ store, icon = null }) {
  const boundsDoc = store.doc('pip', null);
  let cur = null;          // { w, t, frame, win, ui, aspect, state, closing, ready }
  let opening = null;
  let nonceSeq = 0;
  const replies = new Map();   // nonce → resolve
  const finds = new Map();     // nonce → (frame, score) → void

  const nonce = () => `${Date.now().toString(36)}.${++nonceSeq}.${Math.random().toString(36).slice(2, 8)}`;

  /** Le pide algo a un frame y espera su respuesta (o nada, al vencer el plazo). */
  function ask(frame, channel, payload, ms) {
    return new Promise((resolve) => {
      const n = nonce();
      const timer = setTimeout(() => { replies.delete(n); resolve(null); }, ms);
      replies.set(n, (data) => { clearTimeout(timer); replies.delete(n); resolve(data); });
      try { frame.send(channel, n, payload); } catch { clearTimeout(timer); replies.delete(n); resolve(null); }
    });
  }

  /* ── Lo que dicen las páginas ─────────────────────────────────────────── */

  // El botón sobre un video.
  ipcMain.on('pip:open', (e) => {
    const hit = windows.tabOf(e.sender.id);
    if (hit) open(hit.w, hit.tab, { frame: e.senderFrame, pick: 'picked' });
  });
  ipcMain.on('pip:found', (e, n, score) => finds.get(String(n))?.(e.senderFrame, Number(score) || 0));
  ipcMain.on('pip:reply', (_e, n, data) => replies.get(String(n))?.(data && typeof data === 'object' ? data : null));
  ipcMain.on('pip:state', (e, s) => {
    if (!cur || !sameFrame(e.senderFrame, cur.frame) || !s || typeof s !== 'object') return;
    setState(s);
  });

  /* ── Lo que dicen los controles ───────────────────────────────────────── */

  const fromUi = (e) => cur && !cur.closing && e.sender === cur.ui.webContents;
  ipcMain.on('pipui:act', (e, op, arg) => {
    if (!fromUi(e)) return;
    op = String(op);
    if (op === 'back') return close('back');
    if (op === 'close') return close('close');
    if (['toggle', 'seek', 'skip', 'mute'].includes(op)) {
      try { cur.frame.send('pip:cmd', op, Number(arg) || 0); } catch { /* el frame se fue */ }
    }
    return null;
  });

  /* Arrastrar se hace a mano (y no con app-region: drag): con una región de
     arrastre, Windows se queda con el mouse y los controles no se enteran de
     que está encima. Las posiciones salen del cursor real, en DIP. */
  let drag = null;
  ipcMain.on('pipui:drag', (e, phase) => {
    if (!fromUi(e)) return;
    const win = cur.win;
    const p = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const [x, y] = win.getPosition();
      drag = { x, y, cx: p.x, cy: p.y };
    } else if (phase === 'move' && drag) {
      win.setPosition(Math.round(drag.x + p.x - drag.cx), Math.round(drag.y + p.y - drag.cy));
    } else if (phase === 'end' && drag) {
      drag = null;
      keepOnScreen(win);
      save();
    }
  });

  function setState(s) {
    const st = {
      paused: !!s.paused,
      time: Math.max(0, Number(s.time) || 0),
      duration: Number(s.duration) || 0,
      muted: !!s.muted,
      w: Math.max(0, Number(s.w) || 0),
      h: Math.max(0, Number(s.h) || 0),
    };
    cur.state = st;
    // El video cambió de forma (otro video en la misma página): la ventanita también.
    if (st.w && st.h) {
      const a = st.w / st.h;
      if (Math.abs(a - cur.aspect) > 0.01) { cur.aspect = a; reshape(); }
    }
    if (cur.ready) cur.ui.webContents.send('pipui:state', st);
  }

  /* ── Dónde va ─────────────────────────────────────────────────────────── */

  function displayFor(w) {
    const b = w?.win && !w.win.isDestroyed() ? w.win.getBounds() : null;
    return b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay();
  }

  const sizeFor = (width, aspect) => {
    const wd = Math.max(MIN_W, Math.round(width));
    return { width: wd, height: Math.round(wd / aspect) };
  };

  /** Donde quedó la última vez (si esa pantalla sigue estando), o abajo a la derecha. */
  async function placement(w, aspect) {
    const saved = await boundsDoc.read().catch(() => null);
    const size = sizeFor(Number(saved?.width) || DEFAULT_W, aspect);
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
      const r = { x: saved.x, y: saved.y, ...size };
      const d = screen.getDisplayMatching(r);
      const a = d.workArea;
      if (r.x >= a.x - 8 && r.y >= a.y - 8 && r.x + r.width <= a.x + a.width + 8 && r.y + r.height <= a.y + a.height + 8) return r;
    }
    const a = displayFor(w).workArea;
    return { x: a.x + a.width - size.width - EDGE, y: a.y + a.height - size.height - EDGE, ...size };
  }

  function keepOnScreen(win) {
    const b = win.getBounds();
    const a = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, a.x), a.x + a.width - b.width);
    const y = Math.min(Math.max(b.y, a.y), a.y + a.height - b.height);
    if (x !== b.x || y !== b.y) win.setPosition(Math.round(x), Math.round(y));
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!cur || cur.closing || cur.win.isDestroyed()) return;
      const b = cur.win.getBounds();
      boundsDoc.write({ x: b.x, y: b.y, width: b.width }).catch(() => {});
    }, 400);
  }

  /** Las dos vistas llenan la ventanita. */
  function fit() {
    if (!cur || cur.win.isDestroyed()) return;
    const [width, height] = cur.win.getContentSize();
    const r = { x: 0, y: 0, width, height };
    if (!cur.closing) { cur.t.view?.setBounds(r); emulate(width); }
    cur.ui.setBounds(r);
  }

  /* La página no se entera de que la achicaron: sigue con el ancho que tenía
     en su pestaña, y se dibuja en escala adentro de la ventanita. Achicada de
     verdad, un sitio como Instagram pasa a su diseño de celular, rearma la
     página y tira el video que estaba afuera: ponía otro (se oía ese) y los
     controles quedaban hablándole a uno que ya no existía. Solo el alto sigue
     la forma del video, para que su pantalla completa llene la ventanita. */
  function emulate(width) {
    const { t, base, aspect } = cur;
    if (!t.view || !base) return;
    try {
      t.view.webContents.enableDeviceEmulation({
        screenPosition: 'desktop',
        viewSize: { width: base.width, height: Math.round(base.width / aspect) },
        scale: width / base.width,
      });
    } catch { /* la página se fue */ }
  }
  function unemulate(t) {
    try { t.view?.webContents.disableDeviceEmulation(); } catch { /* la página se fue */ }
  }

  /** Otra proporción: se conserva el ancho y cambia el alto. */
  function reshape() {
    const win = cur.win;
    win.setAspectRatio(cur.aspect);
    win.setMinimumSize(MIN_W, Math.round(MIN_W / cur.aspect));
    const b = win.getBounds();
    const size = sizeFor(b.width, cur.aspect);
    if (size.height !== b.height) {
      // Crece hacia arriba si está apoyada abajo: la base queda donde estaba.
      win.setBounds({ x: b.x, y: b.y + b.height - size.height, ...size });
      keepOnScreen(win);
    }
    fit();
  }

  /** Opacidad de la ventana en unos pocos pasos (Windows no la anima solo). */
  function fade(win, from, to, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const ease = to > from ? (x) => 1 - (1 - x) ** 3 : (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
      const step = () => {
        if (win.isDestroyed()) return resolve();
        const k = Math.min(1, (Date.now() - t0) / ms);
        win.setOpacity(from + (to - from) * ease(k));
        if (k < 1) setTimeout(step, 12);
        else resolve();
      };
      step();
    });
  }

  /* ── Cuál frame tiene el video ────────────────────────────────────────── */

  /** Se le pregunta a cada frame de la página; gana el mejor candidato. */
  function findFrame(wc) {
    return new Promise((resolve) => {
      const n = nonce();
      let best = null;
      let score = 0;
      finds.set(n, (frame, s) => { if (s > score) { best = frame; score = s; } });
      let frames = [];
      try { frames = wc.mainFrame.framesInSubtree; } catch { /* nada */ }
      for (const f of frames) { try { f.send('pip:find', n); } catch { /* frame muerto */ } }
      setTimeout(() => { finds.delete(n); resolve(best); }, 200);
    });
  }

  /* ── Abrir ────────────────────────────────────────────────────────────── */

  async function open(w, t, how = {}) {
    if (opening) return opening;
    opening = doOpen(w, t, how).finally(() => { opening = null; });
    return opening;
  }

  function fail(w, error) {
    const none = !error || error === 'none';
    w.card?.show({
      kind: 'error',
      title: none ? 'No hay un video para sacar' : 'Este video no se deja sacar',
      text: none
        ? 'La ventanita es para un video que se esté viendo en esta página.'
        : 'El sitio no lo deja salir de su lugar.',
      life: 5000,
    });
  }

  async function doOpen(w, t, { frame = null, pick = 'best' } = {}) {
    if (!w?.tabs || !t) return false;
    if (cur?.t === t) return true;
    if (!t.view || t.internal || t.error || t.crashed) { fail(w, 'none'); return false; }
    const wc = t.view.webContents;
    if (!frame) frame = await findFrame(wc);
    if (!alive(frame)) { fail(w, 'none'); return false; }
    if (cur) await close('return');

    // Si el video estaba en pantalla completa en la ventana grande, primero sale.
    if (w.tabs.fullscreen) {
      await wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      w.tabs.setFullscreen(false);
      await sleep(250);
    }
    // Mientras tanto la pestaña se pudo cerrar o ir a otra página.
    if (!t.view || t.view.webContents !== wc || !alive(frame)) return false;

    /* Nace YA en su lugar (transparente), nunca fuera de la pantalla: afuera,
       Windows la da por tapada, la página pasa a oculta justo cuando pide la
       pantalla completa, y al aparecer Chromium se la saca (la ventanita
       se abría y a los 100 ms volvía sola). Las pruebas no lo veían porque
       apagan ese cálculo de Windows (main.cjs → SHOTS). */
    const first = await placement(w, 16 / 9);
    if (!t.view || t.view.webContents !== wc || !alive(frame)) return false;
    const win = new BaseWindow({
      ...first,
      frame: false,
      show: false,
      backgroundColor: '#000000',
      // Nace transparente: aparece con un fundido cuando ya está en su lugar.
      opacity: 0,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: 'Prism · Ventanita',
      ...(icon ? { icon } : {}),
    });
    win.setAlwaysOnTop(true, 'floating');
    const ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'pip-ui-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        spellcheck: false,
      },
    });
    ui.setBackgroundColor('#00000000');
    ui.webContents.on('will-navigate', (e) => e.preventDefault());
    // Tocar los controles le da el teclado a la ventanita: el atajo sigue andando.
    ui.webContents.on('before-input-event', (e, input) => {
      if (shortcuts.match(input) !== 'page:pip') return;
      e.preventDefault();
      if (cur?.ui === ui) close('back');
    });
    ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const uiReady = ui.webContents.loadURL(uiUrl('pip.html')).catch(() => {});

    // El ancho que la página tiene en su pestaña: en la ventanita lo conserva (emulate).
    const home = w.tabs.rectFor(t);
    const base = home?.width > 0 ? { width: home.width, height: home.height } : null;
    cur = { w, t, frame, win, ui, aspect: 16 / 9, base, state: null, closing: false, ready: false };
    const c = cur;

    /* Primero una foto de la página tapa su hoja, y abajo aparece el aviso de
       que el video está en la ventanita (pages.js). Recién entonces se va la
       vista, y la foto se desvanece sobre el aviso: nunca queda un hueco ni
       un corte. */
    const shot = await shoot(t.view);
    if (cur !== c) return false;
    t.pip = true;
    w.tabs.emit();
    await w.tabs.showPhoto(t, shot);
    // Si la pestaña se cerró en el medio, drop() ya se llevó la ventanita.
    if (cur !== c || !t.view) return false;
    w.tabs.setAway(t, true);
    w.tabs.hidePhoto(t, { fade: true });
    win.contentView.addChildView(t.view);
    win.contentView.addChildView(ui);
    t.view.setBorderRadius(0);
    fit();
    win.showInactive();

    // La pantalla completa pide un gesto de la persona: el botón ya lo trae; el menú y el atajo, no.
    await frame.executeJavaScript('void 0', true).catch(() => {});
    const r = await ask(frame, 'pip:enter', pick, 1500);
    if (cur !== c) return false;
    if (!r?.ok) {
      await close('undo');
      fail(w, r?.error);
      return false;
    }
    setState(r);
    c.aspect = r.w && r.h ? r.w / r.h : 16 / 9;
    win.setAspectRatio(c.aspect);
    win.setMinimumSize(MIN_W, Math.round(MIN_W / c.aspect));

    // Con su forma final pero todavía transparente: la página se acomoda sin que se vea.
    win.setBounds(await placement(w, c.aspect));
    fit();
    await uiReady;
    c.ready = true;
    ui.webContents.send('pipui:state', c.state);
    await sleep(120);
    if (cur !== c) return false;

    win.on('resize', () => { fit(); save(); });
    win.on('move', () => { if (!drag) save(); });
    // Alt+F4 sobre la ventanita es su cruz.
    win.on('close', (e) => { if (cur === c && !c.closing) { e.preventDefault(); close('close'); } });
    win.on('closed', () => { if (cur === c) drop(t); });
    await fade(win, 0, 1, FADE_IN);
    return true;
  }

  /* ── Cerrar ───────────────────────────────────────────────────────────────
     back:   vuelve a la pestaña, que pasa al frente, y sigue sonando.
     close:  vuelve a la pestaña, en pausa (la cruz).
     return: vuelve a la pestaña y sigue sonando (se abrió otra ventanita).
     lost:   la página salió sola de la pantalla completa, navegó o se cayó.
     undo:   no se pudo abrir.                                               */

  async function close(mode = 'close') {
    const c = cur;
    if (!c || c.closing) return;
    c.closing = true;
    const { w, t, win, ui, frame } = c;
    if (!win.isDestroyed()) await fade(win, win.getOpacity(), 0, FADE_OUT);

    /* Antes de volver, la página ya toma el tamaño de su lugar en la ventana
       grande (sigue en la ventanita, invisible): así no se ve un cuadro con
       el tamaño viejo. */
    const home = w.tabs && w.win && !w.win.isDestroyed();
    unemulate(t);
    if (t.view && home) t.view.setBounds(w.tabs.rectFor(t));
    // La página contesta cuando ya quedó quieta (pip-preload.cjs → settled).
    if (alive(frame)) await ask(frame, 'pip:leave', mode === 'close', 1600);
    await sleep(60);

    if (home && mode === 'back') {
      w.tabs.activate(t.id);
      if (w.win.isMinimized()) w.win.restore();
      w.win.show();
      w.win.focus();
    }
    /* Al revés que al irse: la foto de la página aparece sobre el aviso, la
       vista vuelve encima de la foto, y recién ahí se saca la foto. */
    const shot = home && t.view ? await shoot(t.view) : null;
    const photo = shot ? await w.tabs.showPhoto(t, shot, { fade: true }) : false;

    try { if (!win.isDestroyed() && t.view) win.contentView.removeChildView(t.view); } catch { /* ya no estaba */ }
    if (cur === c) cur = null;
    t.pip = false;
    if (home) {
      w.tabs.setAway(t, false);
      if (photo) setTimeout(() => w.tabs.hidePhoto(t), 90);
    }
    destroy(win, ui);
  }

  /** La pestaña se cierra: la ventanita se va sin devolver nada. Se desvanece
      con el video todavía adentro (callado) en vez de desaparecer de golpe; la
      promesa avisa cuándo ya se puede cerrar la página. */
  function drop(t) {
    const c = cur;
    if (!c || c.t !== t) return null;
    cur = null;
    c.closing = true;
    t.pip = false;
    t.away = false;
    const view = t.view;
    try { view?.webContents.setAudioMuted(true); } catch { /* nada */ }
    unemulate(t);
    return (async () => {
      if (!c.win.isDestroyed()) await fade(c.win, c.win.getOpacity(), 0, FADE_OUT);
      try { if (!c.win.isDestroyed() && view) c.win.contentView.removeChildView(view); } catch { /* nada */ }
      destroy(c.win, c.ui);
    })();
  }

  function destroy(win, ui) {
    try { if (!ui.webContents.isDestroyed()) ui.webContents.close(); } catch { /* nada */ }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* nada */ }
  }

  return {
    open,
    close,
    drop,
    /** Ctrl+Mayús+P y el menú: con la ventanita abierta la trae de vuelta,
        desde la pestaña que sea (mientras mirás el video afuera, estás en
        otra); si no, saca el video de la pestaña activa. */
    toggle(w) {
      if (cur) return close('back');
      const t = w.tabs?.active;
      return t ? open(w, t) : null;
    },
    /** El menú del clic derecho, sobre un video. */
    fromContext(w, t, frame) { return open(w, t, { frame, pick: 'context' }); },
    /** "Traer de vuelta" desde la hoja de la pestaña. */
    back(w, id) { if (cur && cur.w === w && (id == null || cur.t.id === Number(id))) close('back'); },
    lost(t) { if (cur?.t === t && !cur.closing) close('lost'); },
    isClosing(t) { return cur?.t === t && cur.closing; },
    get current() { return cur ? { tabId: cur.t.id, state: cur.state, bounds: cur.win.isDestroyed() ? null : cur.win.getBounds() } : null; },
  };
}

module.exports = { createPip };
