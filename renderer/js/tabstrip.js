/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la tira de pestañas
   Cada pestaña se posiciona a mano (--x, --w) en vez de por flexbox: así
   abrir, cerrar y reordenar se animan con transform, y arrastrar una pestaña
   es mover UNA propiedad. Las demás se corren solas porque sus --x cambian
   y tienen transición.

   Dos detalles de Chrome que se copian porque son los que hacen que se sienta
   bien:
   · Al cerrar con el mouse, el ancho se CONGELA hasta que el puntero sale de
     la tira: la cruz de la pestaña siguiente queda justo debajo del cursor y
     se puede cerrar una fila de pestañas sin mover la mano.
   · Una pestaña abierta desde otra se encola a su derecha (eso lo decide el
     proceso principal).

   Las fijadas van primero, angostas (solo el ícono), y se arrastran solo
   entre ellas; el resto reparte el ancho que queda. Las dos de una vista
   dividida van juntas, con un contorno que las une, y se arrastran en bloque.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on } from './state.js';
import { Icons } from './icons.js';
import { exit, swap, swapText } from './motion.js';
import { esc } from './ui.js';
import { tabMenu } from './menus.js';

const MAX_W = 236;
const MIN_W = 40;
const NEWTAB_SPACE = 40;
const PIN_W = 40;
/** Lo que se esfuma del lado con pestañas escondidas (el mismo número que prism.css). */
const FADE = 32;

const INTERNAL_ICON = {
  nueva: 'prism',
  historial: 'history',
  favoritos: 'star',
  descargas: 'download',
  ajustes: 'settings',
};

const els = new Map();
let order = [];
let pinned = 0;            // las primeras `pinned` de `order` son las fijadas
let frozenW = null;
let drag = null;
let scroll = 0;
let strip;
let host;
let newBtn;

/* ── Geometría ─────────────────────────────────────────────────────────── */

/** El ancho de las que no están fijadas: reparten lo que dejan las fijadas. */
function tabWidth() {
  const avail = strip.clientWidth - NEWTAB_SPACE - pinned * PIN_W;
  const n = Math.max(1, order.length - pinned);
  return frozenW ?? Math.max(MIN_W, Math.min(MAX_W, Math.floor(avail / n)));
}

/** Dónde empieza la pestaña i (sin el desplazamiento de la tira). */
function xAt(i, w = tabWidth()) {
  return i <= pinned ? i * PIN_W : pinned * PIN_W + (i - pinned) * w;
}

function layout() {
  if (!strip) return;
  const w = tabWidth();
  const avail = strip.clientWidth - NEWTAB_SPACE;
  const total = xAt(order.length, w);
  // Si no entran ni al mínimo, la tira se desplaza (rueda del mouse).
  scroll = Math.max(0, Math.min(scroll, total - avail));
  order.forEach((id, i) => {
    const el = els.get(id);
    if (!el) return;
    const pin = i < pinned;
    el.style.setProperty('--w', `${pin ? PIN_W : w}px`);
    if (!(drag && drag.id === id && drag.moved)) el.style.setProperty('--x', `${xAt(i, w) - scroll}px`);
    el.classList.toggle('is-narrow', !pin && w < 100);
    el.classList.toggle('is-tiny', !pin && w < 58);
  });
  newBtn.style.setProperty('--x', `${Math.min(total - scroll, avail) + 4}px`);
  /* Si no entran ni al mínimo, la capa de pestañas termina antes del «+» (la
     que caía debajo se dibujaba con la cruz encima, como una mira) y el lado
     que tiene pestañas escondidas se esfuma: el corte seco no decía que había
     más. */
  const over = total > avail;
  host.classList.toggle('is-over', over);
  host.classList.toggle('has-before', over && scroll > 0);
  host.classList.toggle('has-after', over && scroll < total - avail);
  host.style.setProperty('--avail', `${avail}px`);
}

function revealActive() {
  const i = order.indexOf(S.activeId);
  if (i < 0) return;
  const w = tabWidth();
  const avail = strip.clientWidth - NEWTAB_SPACE;
  const x0 = xAt(i, w);
  const x1 = x0 + (i < pinned ? PIN_W : w);
  // Fuera de lo esfumado: la activa no queda medio apagada contra un borde.
  if (x0 < scroll + FADE) scroll = Math.max(0, x0 - FADE);
  else if (x1 > scroll + avail - FADE) scroll = x1 - avail + FADE;
}

/* ── Contenido de una pestaña ──────────────────────────────────────────── */

function iconKey(t) {
  if (t.loading && !t.internal) return 'loading';
  if (t.crashed) return 'crashed';
  if (t.error) return 'error';
  if (t.internal) return `internal:${t.internal}`;
  if (t.favicon) return `fav:${t.favicon}`;
  return 'globe';
}

/* El ícono se releva en su lugar (swap, motion.js): globo → ruedita →
   favicon se cruzan en la misma celda en vez de cambiar de un cuadro al otro. */
function paintIcon(slot, t, key) {
  let html;
  if (key === 'loading') html = Icons.spinner('op-icon--sm');
  else if (key === 'crashed') html = Icons.svg('broken');
  else if (key === 'error') html = Icons.svg('alert');
  // En incógnito, la pestaña nueva lleva el fantasmita en vez del prisma.
  else if (key.startsWith('internal:')) html = Icons.svg(t.internal === 'nueva' && S.info?.private ? 'ghost' : INTERNAL_ICON[t.internal] || 'globe');
  else if (key.startsWith('fav:')) html = `<img alt="" draggable="false" referrerpolicy="no-referrer" src="${esc(t.favicon)}">`;
  else html = Icons.svg('globe');
  const item = swap(slot, html);
  // Un favicon que no carga no deja un hueco: vuelve al globo.
  item?.querySelector('img')?.addEventListener('error', () => {
    if (slot.dataset.key !== key) return;
    slot.dataset.key = 'globe';
    swap(slot, Icons.svg('globe'));
  }, { once: true });
}

function create(t) {
  const el = document.createElement('div');
  el.className = 'pr-tab';
  el.dataset.id = String(t.id);
  el.setAttribute('role', 'tab');
  el.dataset.tipSide = 'bottom';
  el.innerHTML = `
    <div class="pr-tab__body">
      <span class="pr-tab__icon"></span>
      <span class="pr-tab__title"></span>
      <button class="op-iconbtn pr-tab__btn pr-tab__close" tabindex="-1" aria-label="Cerrar pestaña">${Icons.svg('close')}</button>
    </div>`;
  /* La entrada se apaga al terminar (con una clase, que la salida le gana):
     retenida, su transform pisaba el levantarse de la que se arrastra. */
  const body = el.querySelector('.pr-tab__body');
  setTimeout(() => body.classList.add('is-settled'), 420);
  // Nace en su lugar, no deslizándose desde el borde izquierdo.
  const i = S.tabs.findIndex((x) => x.id === t.id);
  el.style.setProperty('--x', `${xAt(Math.max(0, i)) - scroll}px`);
  el.style.setProperty('--w', `${t.pinned ? PIN_W : tabWidth()}px`);
  return el;
}

function update(el, t) {
  el.classList.toggle('is-active', t.id === S.activeId);
  el.classList.toggle('is-error', !!(t.error || t.crashed));
  el.classList.toggle('is-pinned', !!t.pinned);
  el.classList.toggle('is-split-a', t.split === 'a');
  el.classList.toggle('is-split-b', t.split === 'b');
  el.classList.toggle('is-split-shown', !!S.split && (S.split.a === t.id || S.split.b === t.id));
  el.classList.toggle('is-dormant', !!t.dormant);
  el.setAttribute('aria-selected', String(t.id === S.activeId));

  // El título se releva: mientras carga pasa de la dirección al nombre del sitio.
  const title = t.title || (t.internal ? '' : t.url) || 'Nueva pestaña';
  const titleEl = el.querySelector('.pr-tab__title');
  if (titleEl.dataset.text !== title) {
    const born = titleEl.dataset.text == null;
    titleEl.dataset.text = title;
    if (born) titleEl.textContent = title; else swapText(titleEl, title);
  }
  el.dataset.tip = title;

  const key = iconKey(t);
  const slot = el.querySelector('.pr-tab__icon');
  if (slot.dataset.key !== key) { slot.dataset.key = key; paintIcon(slot, t, key); }
}

export function render() {
  const ids = S.tabs.map((t) => t.id);
  for (const [id, el] of els) {
    if (!ids.includes(id)) {
      els.delete(id);
      el.style.pointerEvents = 'none';
      /* Se pliega a lo ancho con la misma curva con que las de la derecha se
         corren: su borde sigue al de la vecina y nunca se enciman (quieta en
         su ancho, la vecina se le metía encima mientras todavía se veía). */
      el.style.setProperty('--w', '0px');
      exit(el, { fallback: 170 });
    }
  }
  for (const t of S.tabs) {
    let el = els.get(t.id);
    if (!el) {
      el = create(t);
      els.set(t.id, el);
      host.appendChild(el);
    }
    update(el, t);
  }
  if (!drag) order = ids;
  pinned = S.tabs.filter((t) => t.pinned).length;
  revealActive();
  layout();
}

/* ── Interacción ───────────────────────────────────────────────────────── */

/** Lo que se arrastra: la pestaña sola, o su par entero en orden (a, b). */
function blockOf(id) {
  const t = S.tabs.find((x) => x.id === id);
  const i = order.indexOf(id);
  if (t?.split === 'a' && order[i + 1] != null) return [id, order[i + 1]];
  if (t?.split === 'b' && order[i - 1] != null) return [order[i - 1], id];
  return [id];
}

const tabOf = (target) => target.closest?.('.pr-tab:not([data-state="closing"])');
const idOf = (el) => Number(el.dataset.id);

function onPointerDown(e) {
  const el = tabOf(e.target);
  if (!el) return;
  if (e.button === 1) { e.preventDefault(); return; }   // sin el autoscroll de Chromium
  if (e.button !== 0 || e.target.closest('button')) return;
  const id = idOf(el);
  if (id !== S.activeId) api.tabs.activate(id);         // como Chrome: activa al apretar, no al soltar
  drag = { id, el, startX: e.clientX, originX: xAt(order.indexOf(id)), moved: false, block: blockOf(id) };
  el.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  if (!drag.moved) {
    if (Math.abs(dx) < 5) return;
    drag.moved = true;
    drag.el.classList.add('is-dragging');
  }
  // Una fijada se mueve entre las fijadas; las demás, entre las demás.
  const w = tabWidth();
  const cur = order.indexOf(drag.id);
  const isPin = cur < pinned;
  const lo = isPin ? 0 : pinned;
  const hi = isPin ? pinned - 1 : order.length - 1;
  const x = Math.max(xAt(lo, w), Math.min(xAt(hi, w), drag.originX + dx));
  drag.el.style.setProperty('--x', `${x - scroll}px`);
  const target = Math.max(lo, Math.min(hi, lo + Math.round((x - xAt(lo, w)) / (isPin ? PIN_W : w))));
  if (target === cur) return;
  // El par viaja entero, y nunca cae adentro de otro par.
  const { block } = drag;
  const rest = order.filter((id) => !block.includes(id));
  const clamp = (i) => Math.max(lo, Math.min(rest.length, i));
  let at = clamp(target - block.indexOf(drag.id));
  if (S.tabs.find((t) => t.id === rest[at - 1])?.split === 'a') at = clamp(at + (target > cur ? 1 : -1));
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  if (next.join() === order.join()) return;
  order = next;
  layout();
}

function onPointerUp() {
  if (!drag) return;
  const { id, el, moved } = drag;
  drag = null;
  if (moved) {
    el.classList.remove('is-dragging');
    api.tabs.move(id, order.indexOf(id));
  }
  layout();
}

function closeTab(id) {
  // Congela el ancho mientras el mouse siga en la tira (ver el encabezado).
  frozenW = tabWidth();
  api.tabs.close(id);
}

export function init() {
  strip = document.getElementById('strip');
  host = document.getElementById('tabs');
  newBtn = document.getElementById('btn-newtab');

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);

  host.addEventListener('click', (e) => {
    const el = tabOf(e.target);
    if (!el) return;
    if (e.target.closest('.pr-tab__close')) { e.stopPropagation(); closeTab(idOf(el)); }
  });

  // Click del medio cierra.
  host.addEventListener('auxclick', (e) => {
    const el = tabOf(e.target);
    if (el && e.button === 1) { e.preventDefault(); closeTab(idOf(el)); }
  });

  host.addEventListener('contextmenu', (e) => {
    const el = tabOf(e.target);
    if (!el) return;
    e.preventDefault();
    tabMenu(el, idOf(el));
  });

  strip.addEventListener('pointerleave', () => {
    if (frozenW == null) return;
    frozenW = null;
    layout();
  });

  strip.addEventListener('wheel', (e) => {
    if (xAt(order.length) <= strip.clientWidth - NEWTAB_SPACE) return;
    scroll += (e.deltaY || e.deltaX);
    layout();
  }, { passive: true });

  newBtn.addEventListener('click', () => newTab());

  new ResizeObserver(() => layout()).observe(strip);
  on('tabs', render);
}

/** Nueva pestaña desde la interfaz: al llegar, la omnibox toma el foco. */
export function newTab(url = '') {
  S.focusOmniOnNext = !url;
  api.tabs.create(url);
}
