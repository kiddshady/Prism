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
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on } from './state.js';
import { Icons } from './icons.js';
import { esc } from './ui.js';
import { menu, pointAnchor } from './layers.js';
import * as Freeze from './freeze.js';
import { hover } from './status.js';
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

function itemHTML(b, i) {
  const icon = b.favicon
    ? `<img src="${esc(b.favicon)}" alt="" referrerpolicy="no-referrer" draggable="false">`
    : Icons.svg('globe');
  return `<button class="pr-bm" data-i="${i}">${icon}<span class="pr-bm__label">${esc(labelOf(b))}</span></button>`;
}

function paint() {
  if (!marks.length) {
    items.innerHTML = `<div class="pr-bmbar__empty">${Icons.svg('star')}
      <span>Para tener un sitio a mano acá, tocá la estrella de la barra.</span>
      <button class="pr-bmbar__link" data-import>Importar favoritos</button></div>`;
    more.hidden = true;
    return;
  }
  items.innerHTML = marks.map(itemHTML).join('');
  // Un favicon que no carga vuelve al globo en vez de quedar roto.
  items.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = Icons.svg('globe'); }, { once: true }));
  fit();
}

/** Los que no entran se esconden y quedan en el menú de la punta. */
function fit() {
  const btns = [...items.querySelectorAll('.pr-bm')];
  if (!btns.length) return;
  btns.forEach((b) => { b.hidden = false; });
  more.hidden = true;
  const over = () => btns.findIndex((b) => b.offsetLeft + b.offsetWidth > items.clientWidth);
  let i = over();
  if (i >= 0) {
    more.hidden = false;       // la flecha le quita ancho a la fila: se mide de nuevo
    i = over();
    btns.slice(i).forEach((b) => { b.hidden = true; });
  }
  cut = i >= 0 ? i : Infinity;
  // El nombre completo como tooltip, solo si no se lee entero.
  for (const b of btns) {
    const l = b.querySelector('.pr-bm__label');
    if (l.scrollWidth > l.clientWidth + 1) b.dataset.tip = l.textContent;
    else delete b.dataset.tip;
  }
}

async function load() {
  marks = await api.bookmarks.list().catch(() => marks);
  paint();
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
  const btns = [...items.querySelectorAll('.pr-bm:not([hidden])')];
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
  if (!d.moved) return;
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

function moreMenu() {
  menu(more, marks.slice(cut).map((b) => ({ label: labelOf(b), icon: 'globe', onSelect: () => open(b.url) })), { align: 'end' });
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
  more.addEventListener('click', moreMenu);

  new ResizeObserver(() => { if (!drag) fit(); }).observe(items);
  on('library', load);
  on('settings', () => setShown(isShown()));
  load();
}
