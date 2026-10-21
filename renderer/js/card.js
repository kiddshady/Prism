/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la tarjeta de la esquina, por dentro (ver src/card.cjs)
   Una sola tarjeta. Si llega otro aviso mientras está (capturando → listo),
   no se va y vuelve: releva su contenido en el lugar. Se va sola cuando se
   le termina la vida (con el mouse encima, la vida se frena), con la cruz,
   o cuando el sistema la manda a irse.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import './prism-icons.js';
import { exit } from './motion.js';

const MARGIN = 28;
const slot = document.getElementById('slot');
let card = null;
let life = { timer: null, left: 0, since: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* El alto que ocupa, con el aire de la sombra: la vista se ajusta a eso. */
const report = () => window.card.size(slot.offsetHeight + MARGIN * 2);
new ResizeObserver(report).observe(slot);

function contentHTML(d) {
  const lead = d.thumb
    ? `<button class="pr-card__thumb" data-act="thumb" aria-label="Abrir"><img src="${esc(d.thumb)}" alt=""></button>`
    : `<span class="pr-card__well">${d.kind === 'busy' ? Icons.spinner() : Icons.svg(d.kind === 'error' ? 'alert' : d.icon || 'capture')}</span>`;
  const buttons = (d.buttons || []).map((b) =>
    `<button class="op-btn op-btn--ghost op-btn--sm" data-act="${esc(b.id)}">${b.icon ? Icons.svg(b.icon) : ''}${esc(b.label)}</button>`).join('');
  /* La misma estructura en todas las fases (oct 2026): el texto guarda dos
     renglones y la fila de botones está siempre (vacía, un hueco invisible),
     así capturando → lista no cambia el alto de la tarjeta. Antes el alto
     viajaba de uno al otro. */
  const hueco = '<button class="op-btn op-btn--ghost op-btn--sm pr-card__hueco" tabindex="-1" aria-hidden="true">&nbsp;</button>';
  return `${lead}
    <div class="pr-card__main">
      <div class="pr-card__title">${esc(d.title)}</div>
      <div class="pr-card__text">${esc(d.text || '')}</div>
      <div class="pr-card__actions">${buttons || hueco}</div>
    </div>`;
}

/* La barra de vida se apaga en vez de desaparecer: con un relevo, la vieja a
   medio consumir se esfuma mientras la nueva entra llena. Por la API y no por
   CSS: la animación de CSS es la que la achica, y cambiarla la rellenaría. */
function stopLife() {
  clearTimeout(life.timer);
  life.timer = null;
  card?.querySelectorAll('.pr-card__life:not([data-gone])').forEach((bar) => {
    bar.dataset.gone = '1';
    const a = bar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.65, 0, .35, 1)', fill: 'forwards' });
    a.finished.then(() => bar.remove(), () => {});
    setTimeout(() => bar.remove(), 400);
  });
}

function startLife(ms) {
  stopLife();
  if (!ms || !card) return;
  const bar = document.createElement('div');
  bar.className = 'pr-card__life';
  bar.style.setProperty('--life', `${ms}ms`);
  card.appendChild(bar);
  life = { timer: setTimeout(leave, ms), left: ms, since: Date.now() };
}

function leave() {
  if (!card) return;
  stopLife();
  const el = card;
  card = null;
  exit(el, { fallback: 260, onDone: () => { if (!card) window.card.gone(); } });
}

function build(d) {
  const el = document.createElement('div');
  el.className = 'pr-card';
  el.innerHTML = `<div class="pr-card__stage"></div>
    <button class="op-iconbtn op-iconbtn--sm pr-card__close" data-act="close" aria-label="Cerrar">${Icons.svg('close')}</button>`;
  el.addEventListener('animationend', (e) => { if (e.target === el && el.dataset.state !== 'closing') el.classList.add('is-settled'); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') return leave();
    window.card.act(b.dataset.act);
    leave();
  });
  // Con el mouse encima, la vida se frena (la barra también, por CSS).
  el.addEventListener('mouseenter', () => {
    if (!life.timer) return;
    clearTimeout(life.timer);
    life.left -= Date.now() - life.since;
    life.timer = -1;
  });
  el.addEventListener('mouseleave', () => {
    if (life.timer !== -1) return;
    life.since = Date.now();
    life.timer = setTimeout(leave, Math.max(600, life.left));
  });
  return el;
}

function show(d) {
  const fresh = !card;
  if (fresh) {
    card = build(d);
    slot.appendChild(card);
  }
  // Se rearma la clase sin perder lo que está en curso (asentada).
  card.className = `pr-card pr-card--${d.kind || 'done'}${card.classList.contains('is-settled') ? ' is-settled' : ''}`;
  const stage = card.querySelector('.pr-card__stage');
  const old = stage.querySelectorAll('.pr-card__content:not([data-state="closing"])');
  const c = document.createElement('div');
  c.className = `pr-card__content${fresh ? ' is-first' : old.length ? ' is-after' : ''}`;
  c.innerHTML = contentHTML(d);
  old.forEach((o) => exit(o, { fallback: 220 }));
  stage.appendChild(c);
  startLife(d.life || 0);
}

window.card.onShow(show);
window.card.onHide(leave);
