/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la lista de contraseñas y tarjetas, por dentro (ver src/fill.cjs)
   Muestra lo que le mandan, avisa su alto, y dice sobre qué fila está el
   mouse y cuál se eligió. Las flechas las maneja el campo de la página (el
   foco está ahí): acá solo se pinta cuál es la elegida.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import './prism-icons.js';

const box = document.getElementById('box');
let active = -1;
let current = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function rowHTML(it, i, kind) {
  const sub = kind === 'card'
    ? cap([it.brand, it.last4 && `termina en ${it.last4}`, it.expiry && `vence ${it.expiry}`].filter(Boolean).join(' · '))
    : it.login || 'Sin usuario';
  return `<div class="pr-fill__row" role="option" data-i="${i}">
      <span class="pr-fill__tile">${Icons.svg(kind === 'card' ? 'card' : 'passKey')}</span>
      <span class="pr-fill__text"><span class="pr-fill__title">${esc(it.title)}</span><span class="pr-fill__sub">${esc(sub)}</span></span>
    </div>`;
}

function setActive(i) {
  active = i;
  box.querySelectorAll('.pr-fill__row').forEach((row, n) => row.classList.toggle('is-active', n === i));
  box.querySelector('.pr-fill__row.is-active')?.scrollIntoView({ block: 'nearest' });
}

window.fill.onRender(({ kind, items, width }) => {
  box.style.width = `${width}px`;
  /* Pasar del usuario a la contraseña del mismo formulario pide la misma
     lista: si no cambió, se queda como está (rehecha, la fila elegida se
     perdía y todo volvía a entrar). */
  const key = JSON.stringify([kind, items]);
  if (key !== current) {
    current = key;
    active = -1;
    box.innerHTML = `<div class="pr-fill__rows">${items.map((it, i) => rowHTML(it, i, kind)).join('')}</div>
      <div class="pr-fill__foot">${kind === 'card' ? 'Tarjetas de Prism' : 'Contraseñas de Prism'}</div>`;
  } else setActive(-1);
  window.fill.size(box.offsetHeight);
});

new ResizeObserver(() => window.fill.size(box.offsetHeight)).observe(box);

window.fill.onDir((up) => box.classList.toggle('is-up', up));
// Aparece cuando ya está en su lugar: un cuadro antes se habría visto donde estaba la anterior.
window.fill.onOn(() => requestAnimationFrame(() => box.classList.add('is-on')));
window.fill.onOff(() => box.classList.remove('is-on'));
window.fill.onActive(setActive);

box.addEventListener('pointermove', (e) => {
  const row = e.target.closest('.pr-fill__row');
  if (!row || Number(row.dataset.i) === active) return;
  setActive(Number(row.dataset.i));
  window.fill.hover(active);
});
box.addEventListener('pointerdown', (e) => {
  if (e.button === 0) window.fill.press();
});
box.addEventListener('click', (e) => {
  const row = e.target.closest('.pr-fill__row');
  if (e.isTrusted && row) window.fill.pick(Number(row.dataset.i));
});
