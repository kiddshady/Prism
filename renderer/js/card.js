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
/** Mientras la tarjeta cambia de alto, la vista ya tiene el alto final: crece
    adentro de su lugar y ningún cuadro sale recortado. */
let reserve = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* El alto que ocupa, con el aire de la sombra: la vista se ajusta a eso. */
const report = () => window.card.size(Math.max(slot.offsetHeight, reserve) + MARGIN * 2);
new ResizeObserver(report).observe(slot);

function contentHTML(d) {
  const lead = d.thumb
    ? `<button class="pr-card__thumb" data-act="thumb" aria-label="Abrir"><img src="${esc(d.thumb)}" alt=""></button>`
    : `<span class="pr-card__well">${d.kind === 'busy' ? Icons.spinner() : Icons.svg(d.kind === 'error' ? 'alert' : d.icon || 'capture')}</span>`;
  const buttons = (d.buttons || []).map((b) =>
    `<button class="op-btn op-btn--ghost op-btn--sm" data-act="${esc(b.id)}">${b.icon ? Icons.svg(b.icon) : ''}${esc(b.label)}</button>`).join('');
  return `${lead}
    <div class="pr-card__main">
      <div class="pr-card__title">${esc(d.title)}</div>
      ${d.text ? `<div class="pr-card__text">${esc(d.text)}</div>` : ''}
      ${buttons ? `<div class="pr-card__actions">${buttons}</div>` : ''}
    </div>`;
}

function stopLife() {
  clearTimeout(life.timer);
  life.timer = null;
  card?.querySelector('.pr-card__life')?.remove();
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
  card.className = `pr-card pr-card--${d.kind || 'done'}${card.classList.contains('is-settled') ? ' is-settled' : ''}`;
  const stage = card.querySelector('.pr-card__stage');
  const old = stage.querySelectorAll('.pr-card__content:not([data-state="closing"])');
  const c = document.createElement('div');
  c.className = `pr-card__content${fresh ? ' is-first' : old.length ? ' is-after' : ''}`;
  c.innerHTML = contentHTML(d);
  const from = fresh ? 0 : card.offsetHeight;
  old.forEach((o) => exit(o, { fallback: 220 }));
  stage.appendChild(c);
  if (!fresh) resize(from, c);
  startLife(d.life || 0);
}

/* Capturando → lista: el contenido nuevo es más alto (o más bajo). La tarjeta
   no salta: va de su alto de antes al del contenido nuevo, con la base fija. */
function resize(from, content) {
  const el = card;
  const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
  const to = Math.ceil(content.offsetHeight + pad);
  if (Math.abs(to - from) < 2) return;
  reserve = Math.max(from, to);
  report();
  el.style.height = `${from}px`;
  void el.offsetHeight;
  el.classList.add('is-resizing');
  el.style.height = `${to}px`;
  const done = () => {
    clearTimeout(timer);
    el.removeEventListener('transitionend', onEnd);
    el.classList.remove('is-resizing');
    el.style.height = '';
    reserve = 0;
    report();
  };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'height') done(); };
  const timer = setTimeout(done, 500);
  el.addEventListener('transitionend', onEnd);
}

window.card.onShow(show);
window.card.onHide(leave);
