/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — vista dividida (el lado del cromo)
   El proceso principal apoya las dos vistas nativas; acá se ponen las hojas
   debajo, en los mismos píxeles, con la misma cuenta que hace él
   (tabs.cjs → slotRects): la izquierda mide round((ancho − aire) × ratio) y
   la derecha el resto. Si las cuentas no coincidieran, el vidrio asomaría
   por un costado de la vista.

   El divisor vive en el aire entre las dos. Al arrastrarlo, la hoja se mueve
   acá en el acto y el reparto viaja al proceso principal una vez por frame.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on } from './state.js';

let page;
let panes;
let divider;
let drag = null;

const ratio = () => (drag ? drag.ratio : S.split?.ratio ?? 0.5);

export function layout() {
  const sp = S.split;
  page.classList.toggle('is-split', !!sp);
  const [left, right] = panes;
  if (!sp) {
    left.style.removeProperty('width');
    left.classList.remove('is-active');
    right.classList.remove('is-active');
    return;
  }
  const w = Math.round(page.getBoundingClientRect().width);
  const lw = Math.round((w - sp.gap) * ratio());
  left.style.width = `${lw}px`;
  right.style.left = `${lw + sp.gap}px`;
  right.style.width = `${Math.max(0, w - sp.gap - lw)}px`;
  divider.style.left = `${lw}px`;
  divider.style.width = `${sp.gap}px`;
  left.classList.toggle('is-active', S.activeId === sp.a);
  right.classList.toggle('is-active', S.activeId === sp.b);
}

/* ── El divisor ──────────────────────────────────────────────────────────── */

let sendFrame = 0;
function sendRatio() {
  if (sendFrame) return;
  sendFrame = requestAnimationFrame(() => {
    sendFrame = 0;
    if (S.split) api.tabs.splitRatio(S.split.a, ratio());
  });
}

function onDown(e) {
  if (e.button !== 0 || !S.split) return;
  e.preventDefault();
  const r = page.getBoundingClientRect();
  drag = { ratio: ratio(), left: r.left, width: r.width };
  divider.classList.add('is-dragging');
  divider.setPointerCapture(e.pointerId);
}

function onMove(e) {
  if (!drag || !S.split) return;
  const x = e.clientX - drag.left - S.split.gap / 2;
  drag.ratio = Math.max(0.2, Math.min(0.8, x / (drag.width - S.split.gap)));
  layout();
  sendRatio();
}

function onUp() {
  if (!drag) return;
  if (S.split) S.split.ratio = drag.ratio;
  drag = null;
  divider.classList.remove('is-dragging');
  sendRatio();
  layout();
}

export function init() {
  page = document.getElementById('page');
  panes = [...page.querySelectorAll('.pr-pane')];
  divider = document.getElementById('divider');

  divider.addEventListener('pointerdown', onDown);
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', onUp);
  divider.addEventListener('pointercancel', onUp);
  // Doble clic: mitad y mitad.
  divider.addEventListener('dblclick', () => { if (S.split) { S.split.ratio = 0.5; layout(); api.tabs.splitRatio(S.split.a, 0.5); } });

  /* Una mitad con una página propia (o un aviso) es DOM: un clic ahí la
     vuelve la activa. Las mitades web avisan solas desde el proceso
     principal, porque la vista nativa se come el clic. */
  panes.forEach((pane, slot) => pane.addEventListener('pointerdown', () => {
    const sp = S.split;
    const id = sp && (slot ? sp.b : sp.a);
    if (id && id !== S.activeId) api.tabs.activate(id);
  }, true));

  new ResizeObserver(() => layout()).observe(page);
  on('tabs', layout);
  layout();
}
