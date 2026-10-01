/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la barra de favoritos
   Debajo de la barra de direcciones, como en Chrome: los favoritos en orden,
   con su ícono. Lo que no entra en el ancho se va al menú de la flecha de la
   punta. Clic abre en la pestaña actual; Ctrl+clic o el botón del medio, en
   una nueva de fondo; el clic derecho trae el resto.

   ── Aparecer sin que la página salte ───────────────────────────────────────
   La barra es una fila de la grilla que va de 0 a 30 px, y la página tiene
   que bajar o subir lo mismo. Pero la página es una vista nativa: moverla
   cuadro por cuadro la haría remaquetarse en cada uno. Se congela (la foto de
   freeze.js), la foto viaja con la hoja mientras la fila crece, y la vista
   vuelve ya en su lugar nuevo. La foto conserva su alto (is-shifting): se
   corre, no se estira.

   ── Arrastrar para reordenar ───────────────────────────────────────────────
   Los favoritos miden distinto, así que no se posicionan a mano como las
   pestañas: el que se arrastra sigue al mouse (transform) y los que quedan
   en el camino se corren su ancho para hacerle lugar, con transición. Al
   soltar, viaja a su hueco y recién ahí se guarda el orden: el repintado cae
   exactamente donde ya estaba todo, y no salta nada.

   ── Cuando la lista cambia ─────────────────────────────────────────────────
   La barra no se redibuja de cero: reusa los botones que ya están (así sus
   favicons no se recargan) y mueve cada uno de donde estaba a donde va, con
   FLIP: se mide antes, se acomoda, se mide después y se lo anima desde la
   diferencia. El nuevo entra desvaneciéndose; el que se va sale de la fila
   y se desvanece en su lugar mientras los demás cierran el hueco; el que ya
   no entra se desliza contra el borde y recién ahí se esconde.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on } from './state.js';
import { Icons } from './icons.js';
import { menu, pointAnchor, closePopover } from './layers.js';
import { Menu, Tooltip } from './overlays.js';
import * as Freeze from './freeze.js';
import { hover } from './status.js';
import { exit } from './motion.js';
import { esc } from './ui.js';
import { editBookmark, copyUrl } from './pages.js';
import { openPage } from './menus.js';

let app;
let bar;
let items;
let more;
let marks = [];
let cut = Infinity;   // desde qué favorito van al menú de la punta

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const labelOf = (b) => b.title || hostOf(b.url) || b.url;
export const isShown = () => S.settings?.bookmarksBar !== false;

/* ── Pintar ──────────────────────────────────────────────────────────────── */

const LIVE = '.pr-bm:not([data-state="closing"])';
const svgNode = (name) => {
  const t = document.createElement('template');
  t.innerHTML = Icons.svg(name).trim();
  return t.content.firstChild;
};

/** El ícono cambia solo si cambió el favicon: un <img> nuevo se recargaría. */
function setIcon(el, favicon) {
  const want = favicon || '';
  if (el.dataset.icon === want && el.firstElementChild?.matches('img, .op-icon')) return;
  el.dataset.icon = want;
  let node;
  if (want) {
    node = new Image();
    node.alt = '';
    node.referrerPolicy = 'no-referrer';
    node.draggable = false;
    node.src = want;
    // Un favicon que no carga vuelve al globo en vez de quedar roto.
    node.addEventListener('error', () => { el.dataset.icon = ''; node.replaceWith(svgNode('globe')); }, { once: true });
  } else {
    node = svgNode('globe');
  }
  const old = el.querySelector(':scope > img, :scope > .op-icon');
  if (old) old.replaceWith(node);
  else el.prepend(node);
}

function update(el, b) {
  setIcon(el, b.favicon);
  let l = el.querySelector('.pr-bm__label');
  if (!l) { l = document.createElement('span'); l.className = 'pr-bm__label'; el.appendChild(l); }
  if (l.textContent !== labelOf(b)) l.textContent = labelOf(b);
}

function makeItem(b) {
  const el = document.createElement('button');
  el.className = 'pr-bm';
  el.dataset.id = b.id;
  update(el, b);
  return el;
}

/** Entra desvaneciéndose. La clase se va al terminar: una animación con fill
    retenido le ganaría al transform del FLIP y del arrastre. */
function enter(el, delay = 0) {
  el.style.setProperty('--d', `${delay}ms`);
  el.classList.add('is-entering');
  el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
}

/** Sale de la fila (así los demás pueden cerrar el hueco) y se desvanece en su lugar. */
function leave(el, left) {
  el.style.position = 'absolute';
  el.style.left = `${left}px`;
  el.style.transform = '';
  exit(el, { fallback: 260 });
}

function showEmpty() {
  items.querySelectorAll(LIVE).forEach((el) => leave(el, el.offsetLeft));
  more.hidden = true;
  if (items.querySelector('.pr-bmbar__empty:not([data-state="closing"])')) return;
  items.insertAdjacentHTML('beforeend', `<div class="pr-bmbar__empty">${Icons.svg('star')}
    <span>Para tener un sitio a mano acá, tocá la estrella de la barra.</span>
    <button class="pr-bmbar__link" data-import>Importar favoritos</button></div>`);
}

let painted = false;
let pendingPaint = false;

function paint() {
  // En medio de un arrastre (de la barra o del menú) no se reacomoda nada: se hace al soltar.
  if (drag || mdrag) { pendingPaint = true; return; }
  if (!marks.length) { showEmpty(); painted = true; return; }
  items.querySelectorAll('.pr-bmbar__empty:not([data-state="closing"])').forEach((el) => exit(el, { fallback: 200 }));

  // Primero: dónde está cada uno ahora, tal como se ve (con lo que haya quedado de un arrastre).
  const byId = new Map();
  const before = new Map();   // botón → { x en pantalla, left en la fila }
  for (const el of items.querySelectorAll(LIVE)) {
    byId.set(el.dataset.id, el);
    if (!el.hidden) before.set(el, { x: el.getBoundingClientRect().left, left: el.offsetLeft });
  }
  items.querySelectorAll(LIVE).forEach((el) => {
    el.classList.remove('is-dropping', 'is-flipping');
    el.style.transform = '';
  });

  // La fila nueva, reusando lo que ya estaba.
  const order = marks.map((b, i) => {
    const had = byId.get(b.id);
    const el = had || makeItem(b);
    if (had) { update(el, b); byId.delete(b.id); }
    el.dataset.i = i;
    return el;
  });
  for (const el of byId.values()) leave(el, before.get(el)?.left ?? el.offsetLeft);
  for (const el of order) items.appendChild(el);

  const later = fit(painted ? before : null);

  // Último e invertir: cada uno arranca donde estaba y viaja a su lugar.
  const flipping = [];
  order.forEach((el, i) => {
    if (el.hidden) return;
    const was = before.get(el);
    if (!was) { enter(el, painted ? 60 : Math.min(i, 12) * 18); return; }
    const dx = was.x - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) return;
    el.style.transform = `translateX(${dx}px)`;
    flipping.push(el);
  });
  if (flipping.length) {
    void items.offsetWidth;
    for (const el of flipping) {
      el.classList.add('is-flipping');
      el.style.transform = '';
    }
  }
  // Los que ya no entran se deslizaron contra el borde: recién ahora se esconden.
  setTimeout(() => {
    for (const el of flipping) el.classList.remove('is-flipping');
    for (const el of later) el.hidden = true;
  }, 320);
  painted = true;
}

/**
 * Los que no entran se esconden y quedan en el menú de la punta.
 * Con `before` (un repintado), los que se veían y ya no entran no se esconden
 * todavía: se devuelven, para esconderlos cuando terminen de deslizarse.
 */
function fit(before = null) {
  const btns = [...items.querySelectorAll(LIVE)];
  if (!btns.length) return [];
  const was = new Map(btns.map((b) => [b, b.hidden]));
  btns.forEach((b) => { b.hidden = false; });
  more.hidden = true;
  const over = () => btns.findIndex((b) => b.offsetLeft + b.offsetWidth > items.clientWidth);
  let i = over();
  const later = [];
  if (i >= 0) {
    more.hidden = false;       // la flecha le quita ancho a la fila: se mide de nuevo
    i = over();
    for (const b of btns.slice(i)) {
      if (before?.has(b)) later.push(b);
      else b.hidden = true;
    }
  }
  cut = i >= 0 ? i : Infinity;
  // Al agrandar la ventana, los que vuelven a entrar no aparecen de golpe.
  if (!before && painted) for (const b of btns) if (was.get(b) && !b.hidden) enter(b);
  // El nombre completo como tooltip, solo si no se lee entero.
  for (const b of btns) {
    const l = b.querySelector('.pr-bm__label');
    if (l.scrollWidth > l.clientWidth + 1) b.dataset.tip = l.textContent;
    else delete b.dataset.tip;
  }
  return later;
}

async function load() {
  marks = await api.bookmarks.list().catch(() => marks);
  paint();
  fillMore();
}

/** Lo que quedó esperando a que terminara un arrastre. */
function flushPaint() {
  if (!pendingPaint) return;
  pendingPaint = false;
  paint();
  fillMore();
}

/* ── Arrastrar ───────────────────────────────────────────────────────────── */

let drag = null;
let swallowClick = false;
const GAP = 2;   // el gap de .pr-bmbar__items

function onPointerDown(e) {
  const el = e.target.closest('.pr-bm');
  if (!el || e.button !== 0) return;
  drag = { el, startX: e.clientX, moved: false, pointer: e.pointerId };
}

function startDrag() {
  const btns = [...items.querySelectorAll(`${LIVE}:not([hidden])`)];
  // Lo que estuviera entrando o viajando termina ya: el arrastre toma el control
  // (una entrada con fill retenido le ganaría al transform que sigue al mouse).
  for (const b of btns) {
    b.classList.remove('is-entering', 'is-flipping');
    if (b !== drag.el) b.style.transform = '';
  }
  const from = btns.indexOf(drag.el);
  Object.assign(drag, {
    moved: true,
    btns,
    from,
    to: from,
    left: drag.el.offsetLeft,
    w: drag.el.offsetWidth,
    max: items.clientWidth - drag.el.offsetWidth,
  });
  drag.el.setPointerCapture(drag.pointer);
  drag.el.classList.add('is-dragging');
  bar.classList.add('is-sorting');
  hover('');
}

/** Adónde caería: tantos lugares como favoritos tenga a la izquierda de su centro. */
function targetOf(x) {
  const mid = x + drag.w / 2;
  let t = 0;
  drag.btns.forEach((b, i) => {
    if (i !== drag.from && b.offsetLeft + b.offsetWidth / 2 < mid) t += 1;
  });
  return t;
}

/** Los que quedan entre el lugar de antes y el nuevo se corren un ancho. */
function shift(to) {
  const step = drag.w + GAP;
  drag.btns.forEach((b, i) => {
    if (i === drag.from) return;
    const dx = drag.from < i && i <= to ? -step : to <= i && i < drag.from ? step : 0;
    b.style.transform = dx ? `translateX(${dx}px)` : '';
  });
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  if (!drag.moved) {
    if (Math.abs(dx) < 5) return;
    startDrag();
  }
  const x = Math.max(0, Math.min(drag.max, drag.left + dx));
  drag.el.style.transform = `translateX(${x - drag.left}px)`;
  const to = targetOf(x);
  if (to !== drag.to) { drag.to = to; shift(to); }
}

function onPointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) { if (pendingPaint) { pendingPaint = false; paint(); } return; }
  swallowClick = true;   // soltar no es hacer clic: no abre el favorito
  setTimeout(() => { swallowClick = false; }, 0);
  const { el, btns, from, to } = d;
  // Su hueco: donde empieza el que ocupaba ese lugar (o donde termina, si fue a la derecha).
  const slot = to === from ? d.left : to > from ? btns[to].offsetLeft + btns[to].offsetWidth - d.w : btns[to].offsetLeft;
  el.classList.remove('is-dragging');
  el.classList.add('is-dropping');
  el.style.transform = `translateX(${slot - d.left}px)`;
  const settle = () => {
    clearTimeout(timer);
    el.removeEventListener('transitionend', onEnd);
    bar.classList.remove('is-sorting');
    if (to === from) {
      el.classList.remove('is-dropping');
      el.style.transform = '';
      return;
    }
    // Guardado: el repintado de 'library' pone todo en su lugar sin transforms.
    api.bookmarks.move(marks[from].id, to).catch(() => paint());
  };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'transform') settle(); };
  const timer = setTimeout(settle, 320);
  el.addEventListener('transitionend', onEnd);
}

function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (pendingPaint) { pendingPaint = false; paint(); }
  if (!d.moved) return;
  bar.classList.remove('is-sorting');
  d.el.classList.remove('is-dragging');
  d.btns.forEach((b) => { b.style.transform = ''; });
}

/* ── Abrir ───────────────────────────────────────────────────────────────── */

function open(url, { background = false } = {}) {
  if (background) api.tabs.create(url, { active: false });
  else api.tabs.navigate(S.activeId, url).catch(() => {});
}

function itemMenu(e, b, btn) {
  btn.classList.add('is-open');
  menu(pointAnchor(e.clientX, e.clientY), [
    { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => open(b.url, { background: true }) },
    { label: 'Copiar la dirección', icon: 'link', onSelect: () => copyUrl(b.url) },
    { label: 'Editar…', icon: 'edit', onSelect: () => editBookmark(b.id) },
    { sep: true },
    { label: 'Quitar de favoritos', icon: 'trash', danger: true, onSelect: () => api.bookmarks.remove(b.id) },
  ], { align: 'start', onClose: () => btn.classList.remove('is-open') });
}

function barMenu(e) {
  menu(pointAnchor(e.clientX, e.clientY), [
    { label: 'Administrar favoritos', icon: 'star', onSelect: () => openPage('favoritos') },
    { label: 'Ocultar la barra de favoritos', icon: 'close', key: 'Ctrl+Mayús+B', onSelect: () => toggle() },
  ], { align: 'start' });
}

/* ── El menú de la punta ─────────────────────────────────────────────────────
   Los que no entran en la barra. Es propio y no el Menu de Opal porque sus
   favoritos se arrastran, como en la barra:
   · Arriba o abajo, adentro del menú, para cambiarlos de lugar entre ellos.
   · Afuera, hasta la barra: un fantasma con su ícono y su nombre sigue al
     mouse, la barra abre el hueco donde caería, y al soltarlo ahí queda a la
     vista (el último que se veía pasa al menú).
   Soltado en cualquier otro lado, el fantasma vuelve a su fila.
   Se ve como un menú de Opal (usa sus clases), con los favicons de la barra.
   Clic abre en la pestaña actual; Ctrl+clic o el botón del medio, en una
   nueva de fondo. */

const EDGE = 10;
const ROW = '.pr-bmmenu__item';
let pan = null;       // { el, release, onKey, onDown }
let opening = false;
let mdrag = null;     // el arrastre de una fila del menú
let swallowRowClick = false;

const iconHTML = (b) => (b.favicon
  ? `<img src="${esc(b.favicon)}" alt="" referrerpolicy="no-referrer" draggable="false">`
  : Icons.svg('globe'));

function makeRow(b) {
  const el = document.createElement('button');
  el.className = 'op-menuitem pr-bmmenu__item';
  el.setAttribute('role', 'menuitem');
  el.innerHTML = `${iconHTML(b)}<span class="op-truncate"></span>`;
  el.querySelector('.op-truncate').textContent = labelOf(b);
  el.querySelector('img')?.addEventListener('error', (e) => { e.target.outerHTML = Icons.svg('globe'); }, { once: true });
  return el;
}

/**
 * Las filas, en el orden de ahora. Reusa las que ya están (un <img> nuevo
 * recargaría su favicon) y las pone en su lugar de una vez, sin transforms:
 * después de soltar, cada una ya estaba visualmente donde queda.
 */
function fillMore() {
  if (!pan || mdrag) return;
  if (cut >= marks.length) { closeMore(); return; }   // ya entran todos
  const had = new Map([...pan.el.querySelectorAll(ROW)].map((r) => [r.dataset.id, r]));
  marks.slice(cut).forEach((b, j) => {
    const row = had.get(b.id) || makeRow(b);
    had.delete(b.id);
    row.dataset.id = b.id;
    row.dataset.i = cut + j;
    row.classList.remove('is-dragging', 'is-dropping', 'is-away');
    row.style.transform = '';
    pan.el.appendChild(row);
  });
  for (const r of had.values()) r.remove();
}

async function openMore() {
  if (pan) { closeMore(); return; }
  if (opening) return;
  opening = true;
  Menu.close(true);
  closePopover(true);
  Tooltip.hide(true);
  const release = await Freeze.hold();
  opening = false;
  // Mientras se sacaba la foto pudo agrandarse la ventana: si ya entran todos, no hay menú.
  if (cut >= marks.length) { release(); return; }
  const el = document.createElement('div');
  el.className = 'op-menu op-scroll pr-bmmenu';
  el.setAttribute('role', 'menu');
  pan = { el, release };
  fillMore();
  document.getElementById('op-layer').appendChild(el);

  // Debajo de la flecha, alineado a su borde derecho, como el menú de antes.
  const a = more.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const x = Math.max(EDGE, Math.min(a.right - m.width, window.innerWidth - m.width - EDGE));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(a.bottom + 6)}px`;
  el.style.setProperty('--origin', 'top right');
  more.classList.add('is-open');

  el.addEventListener('pointerdown', onRowDown);
  el.addEventListener('pointermove', onRowMove);
  el.addEventListener('pointerup', onRowUp);
  el.addEventListener('pointercancel', () => cancelRowDrag());
  el.addEventListener('click', onRowClick);
  el.addEventListener('auxclick', onRowAux);
  // No se lleva el foco (como un menú), y el botón del medio no arranca el autoscroll.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('mouseover', (e) => {
    if (mdrag?.moved) return;
    const row = e.target.closest(ROW);
    const b = row && marks[Number(row.dataset.i)];
    hover(b ? b.url : '');
  });
  el.addEventListener('mouseleave', () => { if (!mdrag?.moved) hover(''); });

  pan.onKey = (e) => {
    if (!pan || mdrag?.moved) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeMore(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const rows = [...el.querySelectorAll(ROW)];
      const i = rows.findIndex((r) => r.classList.contains('is-active'));
      const next = rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length] || rows[0];
      rows.forEach((r) => r.classList.toggle('is-active', r === next));
      next.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      const active = el.querySelector(`${ROW}.is-active`);
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      active.click();
    }
  };
  // Click afuera cierra. La flecha se deja pasar: su propio click alterna.
  pan.onDown = (e) => {
    if (!pan || mdrag) return;
    if (el.contains(e.target) || more.contains(e.target)) return;
    closeMore();
  };
  document.addEventListener('keydown', pan.onKey, true);
  setTimeout(() => { if (pan?.el === el) document.addEventListener('pointerdown', pan.onDown, true); }, 0);
}

function closeMore(immediate = false) {
  if (!pan) return;
  if (mdrag) cancelRowDrag();
  const { el, release, onKey, onDown } = pan;
  pan = null;
  more.classList.remove('is-open');
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onDown, true);
  hover('');
  immediate ? el.remove() : exit(el, { fallback: 200 });
  Freeze.releaseAfter(release);
}

function rowOf(e) {
  const row = e.target.closest(ROW);
  return row ? { row, b: marks[Number(row.dataset.i)] } : null;
}

function onRowClick(e) {
  if (swallowRowClick) return;
  const hit = rowOf(e);
  if (!hit?.b) return;
  closeMore();
  open(hit.b.url, { background: e.ctrlKey || e.metaKey });
}

function onRowAux(e) {
  const hit = rowOf(e);
  if (!hit?.b || e.button !== 1) return;
  closeMore();
  open(hit.b.url, { background: true });
}

/* ── Arrastrar una fila del menú ─────────────────────────────────────────── */

function onRowDown(e) {
  const hit = rowOf(e);
  if (!hit?.b || e.button !== 0) return;
  const r = hit.row.getBoundingClientRect();
  mdrag = { row: hit.row, b: hit.b, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, grabY: e.clientY - r.top, moved: false, mode: 'list', slot: null };
  /* El puntero se toma ya, no al primer movimiento: un tirón rápido hacia la
     barra caía afuera del menú en el primer evento, el menú no se enteraba y
     el arrastre nunca arrancaba. Un clic igual llega: va a la misma fila. */
  hit.row.setPointerCapture(e.pointerId);
}

function startRowDrag() {
  const d = mdrag;
  const rows = [...pan.el.querySelectorAll(ROW)];
  Object.assign(d, {
    moved: true,
    rows,
    from: rows.indexOf(d.row),
    to: rows.indexOf(d.row),
    top: d.row.offsetTop,
    // Las filas miden lo mismo y van pegadas: un lugar es la distancia entre dos.
    step: rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : d.row.offsetHeight,
    first: rows[0].offsetTop,
    last: rows[rows.length - 1].offsetTop,
  });
  d.row.classList.add('is-dragging');
  pan.el.classList.add('is-sorting');
  rows.forEach((r) => r.classList.remove('is-active'));
  hover('');
  Tooltip.hide(true);
}

/** Dónde está el mouse: sobre el menú, sobre la barra, o en ningún lado útil. */
function zoneAt(x, y) {
  const inside = (r, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  if (inside(pan.el.getBoundingClientRect(), 4)) return 'list';
  const ir = items.getBoundingClientRect();
  if (x >= ir.left && x <= ir.right + 8 && y >= ir.top - 8 && y <= ir.bottom + 8) return 'bar';
  return 'none';
}

function onRowMove(e) {
  const d = mdrag;
  if (!d || !pan) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    startRowDrag();
  }
  const zone = zoneAt(e.clientX, e.clientY);
  if (zone === 'list') dragInList(e);
  else dragOutside(zone, e);
}

/** Adentro del menú: la fila sigue al mouse y las del camino le hacen lugar. */
function dragInList(e) {
  const d = mdrag;
  if (d.mode !== 'list') {
    // Volvió de afuera: el fantasma se va y la fila vuelve a ser la que se arrastra.
    d.mode = 'list';
    dropGhost();
    setSlot(null);
    d.row.classList.remove('is-away');
    d.row.classList.add('is-dragging');
  }
  const pr = pan.el.getBoundingClientRect();
  const y = Math.max(d.first, Math.min(d.last, e.clientY - pr.top + pan.el.scrollTop - d.grabY));
  d.row.style.transform = `translateY(${y - d.top}px)`;
  const to = Math.max(0, Math.min(d.rows.length - 1, Math.round((y - d.first) / d.step)));
  if (to === d.to) return;
  d.to = to;
  d.rows.forEach((r, i) => {
    if (i === d.from) return;
    const dy = d.from < i && i <= to ? -d.step : to <= i && i < d.from ? d.step : 0;
    r.style.transform = dy ? `translateY(${dy}px)` : '';
  });
}

/** Afuera: la fila queda como un hueco tenue y un fantasma sigue al mouse. */
function dragOutside(zone, e) {
  const d = mdrag;
  if (d.mode === 'list') {
    d.mode = 'out';
    d.to = d.from;
    d.rows.forEach((r) => { r.style.transform = ''; });
    d.row.classList.remove('is-dragging');
    d.row.classList.add('is-away');
    showGhost();
  }
  d.ghost.style.transform = `translate(${Math.round(e.clientX - 14)}px, ${Math.round(e.clientY - d.gh / 2)}px)`;
  setSlot(zone === 'bar' ? barSlot(e.clientX) : null);
}

function showGhost() {
  const d = mdrag;
  const g = document.createElement('div');
  g.className = 'pr-bm pr-bm--ghost';
  g.innerHTML = `${iconHTML(d.b)}<span class="pr-bm__label"></span>`;
  g.querySelector('.pr-bm__label').textContent = labelOf(d.b);
  document.getElementById('op-layer').appendChild(g);
  d.ghost = g;
  d.gw = g.offsetWidth;
  d.gh = g.offsetHeight;
}

function dropGhost() {
  const d = mdrag;
  if (!d?.ghost) return;
  exit(d.ghost, { fallback: 200 });
  d.ghost = null;
}

const shownBtns = () => [...items.querySelectorAll(`${LIVE}:not([hidden])`)];

/** El lugar de la barra donde caería: tantos como tenga a la izquierda de su centro. */
function barSlot(x) {
  const left = items.getBoundingClientRect().left;
  return shownBtns().filter((b) => left + b.offsetLeft + b.offsetWidth / 2 < x).length;
}

/* El hueco en la barra: desde ese lugar, los de la derecha se corren el ancho
   del fantasma. Sin lugar (null), vuelven. La transición es la del arrastre
   de la barra (is-sorting), que se va cuando terminaron de volver. */
let unsortTimer = null;
function setSlot(t) {
  const d = mdrag;
  if (d && d.slot === t) return;
  if (d) d.slot = t;
  clearTimeout(unsortTimer);
  if (t != null) bar.classList.add('is-sorting');
  shownBtns().forEach((b, i) => { b.style.transform = t != null && i >= t ? `translateX(${(d?.gw || 0) + GAP}px)` : ''; });
  if (t == null) unsortTimer = setTimeout(() => bar.classList.remove('is-sorting'), 240);
}

function onRowUp() {
  const d = mdrag;
  if (!d) return;
  if (!d.moved) { mdrag = null; flushPaint(); return; }   // un clic: lo atiende onRowClick
  swallowRowClick = true;
  setTimeout(() => { swallowRowClick = false; }, 0);
  if (d.mode === 'list') dropInList(d);
  else if (d.slot != null) dropInBar(d);
  else returnGhost(d);
}

/** Soltado en el menú: viaja a su hueco, y recién ahí se guarda el orden. */
function dropInList(d) {
  const slot = d.first + d.to * d.step;
  d.row.classList.remove('is-dragging');
  d.row.classList.add('is-dropping');
  d.row.style.transform = `translateY(${slot - d.top}px)`;
  whenMoved(d.row, () => {
    mdrag = null;
    pan?.el.classList.remove('is-sorting');
    if (d.to === d.from) {
      d.row.classList.remove('is-dropping');
      d.row.style.transform = '';
      flushPaint();
      return;
    }
    // El repintado de 'library' (fillMore) acomoda las filas sin transforms.
    api.bookmarks.move(d.b.id, cut + d.to).catch(() => { pendingPaint = true; flushPaint(); });
  });
}

/** Soltado en la barra: el fantasma va a su hueco, y ahí aparece el favorito de verdad. */
function dropInBar(d) {
  const btns = shownBtns();
  const ir = items.getBoundingClientRect();
  const at = btns[d.slot];
  const prev = btns[d.slot - 1];
  const x = ir.left + (at ? at.offsetLeft : prev ? prev.offsetLeft + prev.offsetWidth + GAP : 0);
  const y = ir.top + (btns[0] ? btns[0].offsetTop : 0);
  const g = d.ghost;
  g.classList.add('is-landing');
  g.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  whenMoved(g, () => {
    mdrag = null;
    d.ghost = null;
    /* Sin la transición del arrastre, los corridos quedan donde están; el
       repintado los lleva a su lugar nuevo desde ahí (FLIP), y el que entra
       se desvanece justo donde el fantasma se desvanece. */
    clearTimeout(unsortTimer);
    bar.classList.remove('is-sorting');
    exit(g, { fallback: 200 });
    closeMore();
    api.bookmarks.move(d.b.id, d.slot).catch(() => { pendingPaint = true; flushPaint(); });
  });
}

/** Soltado en ningún lado: el fantasma vuelve a su fila y la fila reaparece. */
function returnGhost(d) {
  const r = d.row.getBoundingClientRect();
  const g = d.ghost;
  setSlot(null);
  g.classList.add('is-landing');
  g.style.transform = `translate(${Math.round(r.left + 8)}px, ${Math.round(r.top + (r.height - d.gh) / 2)}px)`;
  whenMoved(g, () => {
    mdrag = null;
    exit(g, { fallback: 200 });
    d.row.classList.remove('is-away');
    pan?.el.classList.remove('is-sorting');
    flushPaint();
  });
}

/** Cuando termina de viajar (con un tope, por si la transición no corre). */
function whenMoved(el, fn) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.removeEventListener('transitionend', onEnd);
    fn();
  };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'transform') finish(); };
  const timer = setTimeout(finish, 320);
  el.addEventListener('transitionend', onEnd);
}

/** Se cortó (el menú se cerró, Windows canceló el puntero): todo vuelve ya. */
function cancelRowDrag() {
  const d = mdrag;
  if (!d) return;
  mdrag = null;
  if (d.ghost) { d.ghost.remove(); d.ghost = null; }
  if (d.moved) {
    d.rows?.forEach((r) => { r.style.transform = ''; r.classList.remove('is-dragging', 'is-dropping', 'is-away'); });
    shownBtns().forEach((b) => { b.style.transform = ''; });
    bar.classList.remove('is-sorting');
    pan?.el.classList.remove('is-sorting');
  }
  flushPaint();
}

/** Mostrar u ocultar: se guarda, y el cambio de ajustes la mueve. */
export function toggle() {
  return api.settings.save({ bookmarksBar: !isShown() }).catch(() => {});
}

/* ── Aparecer y desaparecer ─────────────────────────────────────────────── */

let moving = Promise.resolve();

function setShown(want, animate = true) {
  moving = moving.then(async () => {
    if (app.classList.contains('has-bmbar') === want) return;
    if (!animate || S.fullscreen) { app.classList.toggle('has-bmbar', want); return; }
    const page = document.getElementById('page');
    const release = await Freeze.hold();
    page.style.setProperty('--shot-h', `${page.clientHeight}px`);
    page.classList.add('is-shifting');
    app.classList.add('is-bmbar-moving');
    app.classList.toggle('has-bmbar', want);
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); app.removeEventListener('transitionend', onEnd); resolve(); };
      const onEnd = (e) => { if (e.target === app && e.propertyName === 'grid-template-rows') done(); };
      const timer = setTimeout(done, 450);
      app.addEventListener('transitionend', onEnd);
    });
    app.classList.remove('is-bmbar-moving');
    // La vista vuelve ya en su lugar nuevo; recién ahí la foto deja de ir pegada arriba.
    await release();
    page.classList.remove('is-shifting');
    page.style.removeProperty('--shot-h');
    fit();
  });
  return moving;
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

export function init() {
  app = document.getElementById('app');
  bar = document.getElementById('bmbar');
  items = document.getElementById('bmbar-items');
  more = document.getElementById('bmbar-more');
  setShown(isShown(), false);

  items.addEventListener('pointerdown', onPointerDown);
  items.addEventListener('pointermove', onPointerMove);
  items.addEventListener('pointerup', onPointerUp);
  items.addEventListener('pointercancel', cancelDrag);
  items.addEventListener('click', (e) => {
    if (swallowClick) return;
    if (e.target.closest('[data-import]')) return openPage('favoritos');
    const btn = e.target.closest('.pr-bm');
    if (!btn) return;
    const b = marks[Number(btn.dataset.i)];
    if (b) open(b.url, { background: e.ctrlKey || e.metaKey });
  });
  items.addEventListener('auxclick', (e) => {
    const btn = e.target.closest('.pr-bm');
    const b = btn && marks[Number(btn.dataset.i)];
    if (b && e.button === 1) open(b.url, { background: true });
  });
  // El botón del medio no tiene que arrancar el autoscroll de Chromium.
  items.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest('.pr-bm')) e.preventDefault(); });
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const btn = e.target.closest('.pr-bm');
    const b = btn && marks[Number(btn.dataset.i)];
    if (b) itemMenu(e, b, btn);
    else barMenu(e);
  });
  // Adónde lleva, en la statusbar (como el link de una página).
  items.addEventListener('mouseover', (e) => {
    if (drag?.moved) return;
    const btn = e.target.closest('.pr-bm');
    const b = btn && marks[Number(btn.dataset.i)];
    hover(b ? b.url : '');
  });
  items.addEventListener('mouseleave', () => hover(''));
  more.addEventListener('click', openMore);

  new ResizeObserver(() => {
    if (drag || mdrag) return;
    fit();
    fillMore();
  }).observe(items);
  on('library', load);
  on('settings', () => setShown(isShown()));
  load();
}
