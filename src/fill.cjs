'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la lista de contraseñas y tarjetas
   Al enfocar un campo de login o de tarjeta, la lista para completarlo. Antes
   vivía en el DOM de la página, en un shadow root cerrado: la página no leía
   las filas, pero podía volver invisible la lista o taparla, y hacerte elegir
   una tarjeta con un click que creías dar en otra cosa (y en un sitio
   cualquiera, no solo en el de la tarjeta). Desde adentro de la página eso no
   se puede evitar del todo.

   Ahora la dibuja Prism, como Chrome: una vista propia, transparente,
   apoyada ENCIMA de la página (la misma receta que la tarjeta de la esquina,
   card.cjs). La página no la ve, no la estila y no la tapa, y un click en
   ella es de la persona sí o sí.

   El reparto:
   · El preload de la página (pass-preload.cjs) sabe dónde está el campo y
     qué teclas se aprietan: pide la lista con el rectángulo del campo, la
     mueve si la página scrollea y la cierra. Las flechas y el Enter siguen
     siendo suyos (el foco está en el campo).
   · Acá se decide dónde va (abajo del campo, o arriba si no entra) y cuándo
     está. Lo que se elige con el mouse vuelve a la página como una elección
     de la persona.
   · Adentro dibuja renderer/fill.html.

   Un click en la lista le saca el foco a la página (es otra vista): el campo
   avisa que lo perdió, y acá se espera un momento a ver si fue eso antes de
   cerrarla. Elegir le devuelve el foco a la página y al campo.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const { WebContentsView, ipcMain } = require('electron');
const windows = require('./windows.cjs');

/** Aire transparente alrededor de la lista, donde cae su sombra. */
const MARGIN = 24;
/** Entre el campo y la lista, y contra los bordes de la página. */
const GAP = 4;
const EDGE = 4;
const HIDDEN_X = -30000;
/** Lo que tarda en irse (fill.css): recién después se corre la vista. */
const FADE_MS = 180;
/** Lo que se espera, después de que el campo pierde el foco, a ver si fue un click en la lista. */
const BLUR_MS = 150;
/** Apretada y sin soltar (o soltada afuera de una fila): se rinde. */
const PRESS_MS = 1500;
const MAX_ITEMS = 40;

/* Los canales se registran una sola vez; cada ventana anota acá su lista. */
const views = new Map();     // id del webContents de la lista → su fill
let channels = false;

/** La pestaña que habla (solo el documento principal) y la lista de su ventana. */
function ofPage(e) {
  if (!e.senderFrame || e.senderFrame.parent) return null;
  const at = windows.tabOf(e.sender.id);
  return at?.w.fill ? { fill: at.w.fill, wc: e.sender, tab: at.tab } : null;
}

const str = (v, n = 200) => String(v ?? '').slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rectOf = (r) => ({ x: num(r?.x), y: num(r?.y), w: Math.max(0, num(r?.w)), h: Math.max(0, num(r?.h)) });
/** Solo lo que se muestra: título y la línea de abajo. El id viaja aparte y lo vuelve a chequear passwords.cjs. */
const itemsOf = (list, kind) => (Array.isArray(list) ? list.slice(0, MAX_ITEMS) : []).map((it) => (kind === 'card'
  ? { title: str(it?.title), brand: str(it?.brand, 40), last4: str(it?.last4, 4), expiry: str(it?.expiry, 10) }
  : { title: str(it?.title), login: str(it?.login) }));

function listen() {
  if (channels) return;
  channels = true;
  /* De la página. */
  ipcMain.on('fill:show', (e, d = {}) => { const p = ofPage(e); p?.fill.show(p.wc, p.tab, d); });
  ipcMain.on('fill:move', (e, d = {}) => { ofPage(e)?.fill.move(e.sender, d); });
  ipcMain.on('fill:active', (e, d = {}) => { ofPage(e)?.fill.active(e.sender, d); });
  ipcMain.on('fill:hide', (e, d = {}) => { ofPage(e)?.fill.closed(e.sender, d); });
  ipcMain.on('fill:blur', (e, d = {}) => { ofPage(e)?.fill.blurred(e.sender, d); });
  /* De la lista. */
  const fromView = (e) => views.get(e.sender.id) || null;
  ipcMain.on('fill:size', (e, h) => fromView(e)?.sized(h));
  ipcMain.on('fill:hover', (e, i) => fromView(e)?.hovered(i));
  ipcMain.on('fill:press', (e) => fromView(e)?.pressed());
  ipcMain.on('fill:pick', (e, i) => fromView(e)?.picked(i));
}

function createFill(ctx) {
  listen();
  let view = null;
  let ready = null;
  /** La lista pedida: { wc, tab, seq, kind, rect, width, count }. */
  let owner = null;
  let shown = false;
  let height = 0;
  let up = false;
  let pressing = false;
  let relaying = false;
  let hideTimer = null; let blurTimer = null; let pressTimer = null;
  const watched = new WeakSet();

  function ensure() {
    if (ready) return ready;
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'fill-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setBounds({ x: HIDDEN_X, y: 0, width: 300, height: 100 });
    ctx.win.contentView.addChildView(view);
    const wc = view.webContents;
    /* La vista se queda con el teclado al crearse y con cada click: el campo
       de la página lo pierde y la lista se cerraría. Se lo devuelve en el
       acto; el click igual llega a la fila (el mouse ya está capturado). */
    wc.on('focus', () => {
      // En la tarea siguiente: adentro del mismo evento, Chromium todavía está moviendo el foco y lo pisa.
      setTimeout(() => { const o = owner; if (o && !o.wc.isDestroyed() && wc.isFocused()) o.wc.focus(); }, 0);
    });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    views.set(wc.id, api);
    wc.once('destroyed', () => views.delete(wc.id));
    ready = wc.loadFile(path.join(__dirname, '..', 'renderer', 'fill.html')).then(() => view);
    return ready;
  }

  const mine = (wc, d) => !!owner && owner.wc === wc && owner.seq === num(d.seq);
  const send = (ch, payload) => { if (view && !view.webContents.isDestroyed()) view.webContents.send(ch, payload); };

  async function show(wc, tab, d) {
    const kind = d.kind === 'card' ? 'card' : 'login';
    const items = itemsOf(d.items, kind);
    if (!items.length) return;
    const rect = rectOf(d.rect);
    const z = wc.getZoomFactor() || 1;
    // Una tarjeta dice más (marca, últimos cuatro, vencimiento), y su campo suele ser angosto.
    const width = Math.round(Math.min(380, Math.max(kind === 'card' ? 300 : 240, rect.w * z)));
    clearTimeout(blurTimer); clearTimeout(pressTimer); pressing = false;
    owner = { wc, tab, seq: num(d.seq), kind, rect, width, count: items.length };
    if (!watched.has(wc)) {
      watched.add(wc);
      // La pestaña que se va (o navega) se lleva su lista.
      wc.once('destroyed', () => { if (owner?.wc === wc) hide({ tell: false }); });
      wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument && owner?.wc === wc) hide(); });
    }
    await ensure();
    const still = () => owner?.wc === wc && owner.seq === num(d.seq);
    if (!still()) return;
    // El alto vuelve por fill:size; recién ahí se ubica y aparece.
    const render = () => { relaying = false; if (still()) send('fill:render', { kind, items, width }); };
    /* Ya estaba a la vista (del usuario a la contraseña del mismo formulario):
       no salta de un campo al otro. Se va, y entra en su lugar nuevo cuando
       la vieja ya casi no se ve. Mientras tanto nadie la reubica. */
    if (shown) {
      shown = false;
      relaying = true;
      send('fill:off');
      setTimeout(render, FADE_MS - 40);
    } else render();
  }

  /** Abajo del campo, o arriba si abajo no entra y arriba sí. Siempre dentro de la página. */
  function place() {
    if (!view || !owner || !height || relaying) return;
    const { wc, tab, rect, width } = owner;
    if (wc.isDestroyed() || !tab.view || tab.view.webContents !== wc || !ctx.win.contentView.children.includes(tab.view)) { hide(); return; }
    const b = tab.view.getBounds();
    // Congelada (un menú del cromo encima), la vista se corre afuera: la lista se va con ella.
    if (b.x < -1000) { hide(); return; }
    const z = wc.getZoomFactor() || 1;
    const top = b.y + rect.y * z;
    const bottom = b.y + (rect.y + rect.h) * z;
    const wantUp = bottom + GAP + height > b.y + b.height && top - GAP - height >= b.y;
    const x = Math.min(Math.max(b.x + EDGE, b.x + rect.x * z), b.x + b.width - width - EDGE);
    const y = wantUp ? top - GAP - height : bottom + GAP;
    view.setBounds({ x: Math.round(x - MARGIN), y: Math.round(y - MARGIN), width: width + MARGIN * 2, height: height + MARGIN * 2 });
    raise();
    if (wantUp !== up || !shown) {
      up = wantUp;
      send('fill:dir', up);
    }
    if (!shown) {
      shown = true;
      clearTimeout(hideTimer);
      send('fill:on');
    }
  }

  /** Arriba de todo: una pestaña o la tarjeta que entran se apilan encima. */
  function raise() {
    const kids = ctx.win.contentView.children;
    if (kids[kids.length - 1] !== view) ctx.win.contentView.addChildView(view);
  }

  /** `tell`: avisarle a la página que se cerró (cuando la cierra Prism y no ella). */
  function hide({ tell = true } = {}) {
    clearTimeout(blurTimer); clearTimeout(pressTimer); pressing = false; relaying = false;
    const o = owner;
    owner = null;
    if (tell && o && !o.wc.isDestroyed()) {
      try { o.wc.mainFrame.send('fill:gone', o.seq); } catch { /* el frame ya no está */ }
    }
    if (!view || !shown) return;
    shown = false;
    send('fill:off');
    clearTimeout(hideTimer);
    // Se corre afuera recién cuando terminó de irse: sacada antes, se cortaba de golpe.
    hideTimer = setTimeout(() => {
      if (!shown && view) view.setBounds({ x: HIDDEN_X, y: 0, width: 300, height: 100 });
    }, FADE_MS);
  }

  const api = {
    show,
    place,
    hide: () => hide(),
    get shown() { return shown; },
    /** La vista de la lista (para las pruebas: clickear una fila como una persona). */
    get webContents() { return view?.webContents || null; },
    move(wc, d) {
      if (!mine(wc, d)) return;
      owner.rect = rectOf(d.rect);
      place();
    },
    active(wc, d) {
      if (mine(wc, d)) send('fill:active', num(d.i));
    },
    closed(wc, d) {
      if (mine(wc, d)) hide({ tell: false });
    },
    blurred(wc, d) {
      if (!mine(wc, d)) return;
      clearTimeout(blurTimer);
      const o = owner;
      // Si la página ya recuperó el teclado (lo devuelve la vista, arriba), sigue abierta.
      blurTimer = setTimeout(() => { if (owner === o && !pressing && !o.wc.isFocused()) hide(); }, BLUR_MS);
    },
    sized(h) {
      height = Math.max(20, Math.min(600, Math.round(num(h))));
      place();
    },
    hovered(i) {
      if (!owner || owner.wc.isDestroyed()) return;
      try { owner.wc.mainFrame.send('fill:hover', { seq: owner.seq, i: num(i) }); } catch { /* ya no está */ }
    },
    pressed() {
      if (!owner) return;
      pressing = true;
      clearTimeout(blurTimer);
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressing = false; if (owner && !owner.wc.isFocused()) hide(); }, PRESS_MS);
    },
    picked(i) {
      const o = owner;
      const n = num(i);
      if (!o || o.wc.isDestroyed() || n < 0 || n >= o.count) return;
      clearTimeout(pressTimer);
      pressing = false;
      // El click fue en la lista de Prism: es la persona eligiendo, en esa pestaña.
      ctx.passwords?.markGesture?.(o.wc);
      o.wc.focus();
      try { o.wc.mainFrame.send('fill:choose', { seq: o.seq, i: n }); } catch { hide(); }
    },
  };
  return api;
}

module.exports = { createFill };
