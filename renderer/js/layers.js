/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — overlays sobre la página
   Los mismos Menu y Modal de Opal, envueltos para que congelen la página
   antes de aparecer (ver freeze.js), más un popover propio: un panel de
   vidrio anclado a un botón (escudo, descargas).
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Menu, Modal, Tooltip } from './overlays.js';
import { exit, scrollFade, dissolve, glideSize } from './motion.js';
import * as Freeze from './freeze.js';

const EDGE = 10;
const layer = () => document.getElementById('op-layer');

/* ══ Menú ════════════════════════════════════════════════════════════════════ */

let menuAnchor = null;

/** Menu.show de Opal, con la página congelada mientras está abierto. */
export async function menu(anchor, items, opts = {}) {
  // Pedir el menú del mismo ancla es cerrarlo (el toggle de Opal).
  if (Menu.isOpen && menuAnchor === anchor) { Menu.close(); return; }
  closePopover(true);
  Tooltip.hide(true);
  const release = await Freeze.hold();
  menuAnchor = anchor;
  const shown = Menu.show(anchor, items, {
    ...opts,
    onClose: () => {
      if (menuAnchor === anchor) menuAnchor = null;
      Freeze.releaseAfter(release);
      opts.onClose?.();
    },
  });
  if (!shown) release();
}

/** Un ancla invisible en un punto de la ventana (para el click derecho). */
export function pointAnchor(x, y) {
  let el = document.getElementById('pr-anchor');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pr-anchor';
    el.className = 'pr-anchor';
    document.body.appendChild(el);
  }
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y) - 6}px`;
  return el;
}

/* ══ Modal ═══════════════════════════════════════════════════════════════════ */

export async function modal(opts) {
  closePopover(true);
  Menu.close(true);
  const release = await Freeze.hold();
  try {
    return await Modal.show(opts);
  } finally {
    Freeze.releaseAfter(release, 240);
  }
}

export async function confirm(opts) {
  closePopover(true);
  const release = await Freeze.hold();
  try {
    return await Modal.confirm(opts);
  } finally {
    Freeze.releaseAfter(release, 240);
  }
}

/* ══ Popover ═════════════════════════════════════════════════════════════════
   build(el, ctl) llena el panel; ctl.refresh() lo vuelve a llenar con datos
   nuevos sin cerrarlo (las descargas avanzan mientras está abierto). */

let pop = null;

export function closePopover(immediate = false) {
  if (!pop) return;
  const { el, anchor, release, onKey, onDown, onClose } = pop;
  pop = null;
  anchor?.classList.remove('is-open');
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onDown, true);
  // Reemplazado por otro overlay también se va con su salida: no de golpe.
  exit(el, { fallback: 160 });
  Freeze.releaseAfter(release, immediate ? 0 : 140);
  onClose?.();
}

export const popoverOpen = (anchor) => !!pop && (!anchor || pop.anchor === anchor);

export async function popover(anchor, build, { width = 340, align = 'end', onClose } = {}) {
  if (pop && pop.anchor === anchor) { closePopover(); return null; }
  closePopover(true);
  Menu.close(true);
  Tooltip.hide(true);

  const release = await Freeze.hold();
  const el = document.createElement('div');
  el.className = 'pr-pop';
  el.style.width = `${width}px`;
  layer().appendChild(el);

  const ctl = {
    el,
    close: () => { if (pop?.el === el) closePopover(); },
    /* Con `fade`, el panel se rehace debajo de un calco de lo que mostraba,
       que se esfuma (dissolve), y el alto va de uno al otro: es para los que
       se arman enteros de nuevo (el escudo, el sitio). Los que se ponen al
       día solos (descargas, contraseñas) refrescan sin calco. */
    refresh: async ({ fade = false } = {}) => {
      if (!fade || !el.isConnected) return render();
      const snapshot = el.innerHTML;
      const from = { w: el.offsetWidth, h: el.offsetHeight };
      await render();
      const calco = document.createElement('div');
      calco.className = 'pr-pop__calco';
      calco.innerHTML = snapshot;
      el.appendChild(calco);
      dissolve(calco);
      glideSize(el, from, { width: false, ignore: [calco] });
    },
  };
  /* Un panel puede armarse asíncrono (el del escudo pide sus números antes
     de escribir): los íconos se montan cuando ya escribió. Montados antes,
     caían sobre el contenido VIEJO, que en un refresco mostraba un instante
     el ícono del estado anterior. */
  const render = () => {
    const keepScroll = el.querySelector('.op-scroll')?.scrollTop || 0;
    const settle = () => {
      Icons.mount(el);
      el.querySelectorAll('.op-scroll').forEach((s) => { scrollFade(s); s.scrollTop = keepScroll; });
    };
    const built = build(el, ctl);
    if (built && typeof built.then === 'function') return built.then(settle, settle);
    settle();
    return Promise.resolve();
  };
  render();

  // Posición: debajo del botón, alineado a su borde derecho (o izquierdo).
  const a = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  let x = align === 'end' ? a.right - m.width : a.left;
  x = Math.min(Math.max(EDGE, x), window.innerWidth - m.width - EDGE);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(a.bottom + 6)}px`;
  el.style.transformOrigin = align === 'end' ? 'top right' : 'top left';
  anchor.classList.add('is-open');

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  // Click afuera cierra. En captura, y dejando pasar al ancla: su propio
  // handler es el que alterna (si no, cerrar y reabrir competirían).
  const onDown = (e) => {
    if (!pop) return;
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    if (e.target.closest?.('.op-menu, .op-modal__anim, .op-scrim')) return;
    closePopover();
  };
  pop = { el, anchor, release, onKey, onDown, onClose, ctl };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  return ctl;
}

/** El popover abierto, para refrescarlo desde afuera. */
export const currentPopover = () => pop?.ctl || null;
