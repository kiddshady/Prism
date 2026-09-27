/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — los controles de la ventanita, por dentro (ver src/pip.cjs)
   El estado del video llega del preload de la página (reproduciendo, tiempo,
   duración, silencio) unas cuatro veces por segundo; entre medio, la barra y
   el reloj avanzan solos con requestAnimationFrame para no ir a saltos.

   Tocar el video pausa o sigue; arrastrarlo mueve la ventanita. El arrastre
   es a mano (pip.cjs explica por qué no es una región de arrastre).
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import './prism-icons.js';

const root = document.getElementById('pip');
const bar = document.getElementById('bar');
const timeEl = document.getElementById('time');
Icons.mount(root);

/** Sin mover el mouse, los controles se van a este tiempo (el video sigue). */
const IDLE = 2400;
/** Menos que esto no es un arrastre: es un toque. */
const SLOP = 4;

let st = { paused: true, time: 0, duration: 0, muted: false };
let at = performance.now();
let hover = false;
let idleTimer = 0;
let scrub = null;       // { frac } mientras se arrastra la barra
let drag = null;        // { x, y, moved }
let raf = 0;

const act = (op, arg) => window.pip.act(op, arg);

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** El tiempo de ahora: el último que dijo la página, más lo que pasó desde entonces. */
function now() {
  if (st.paused || st.duration <= 0) return st.time;
  return Math.min(st.duration, st.time + (performance.now() - at) / 1000);
}

function paintTime() {
  const d = st.duration;
  const t = scrub ? scrub.frac * d : now();
  timeEl.textContent = d > 0 ? `${fmt(t)} / ${fmt(d)}` : '';
  bar.style.setProperty('--p', d > 0 ? String(Math.min(1, t / d)) : '0');
}

function loop() {
  raf = 0;
  paintTime();
  if (!st.paused && root.classList.contains('is-shown')) raf = requestAnimationFrame(loop);
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

function paint() {
  root.classList.toggle('is-paused', st.paused);
  root.classList.toggle('is-muted', st.muted);
  root.classList.toggle('is-live', st.duration < 0);
  root.querySelector('[data-act="toggle"]').setAttribute('aria-label', st.paused ? 'Reproducir' : 'Pausar');
  root.querySelector('[data-act="mute"]').setAttribute('aria-label', st.muted ? 'Activar el sonido' : 'Silenciar');
  shown();
  paintTime();
  kick();
}

/** Se ven con el mouse encima, en pausa, o mientras se arrastra algo. */
function shown() {
  const on = hover || st.paused || !!scrub || !!drag?.moved;
  root.classList.toggle('is-shown', on);
  if (on) kick();
}

function wake() {
  hover = true;
  root.classList.remove('is-idle');
  shown();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Con el mouse sobre un botón, se quedan.
    if (root.querySelector('.pip-btn:hover, .pip-bar:hover') || scrub || drag) return;
    hover = false;
    root.classList.toggle('is-idle', !st.paused);
    shown();
  }, IDLE);
}

window.pip.onState((s) => {
  st = s;
  at = performance.now();
  // Recién soltada la barra: el video ya está donde se soltó, no donde estaba.
  paint();
});

document.addEventListener('mousemove', wake);
document.documentElement.addEventListener('mouseleave', () => {
  if (scrub || drag) return;
  hover = false;
  clearTimeout(idleTimer);
  shown();
});

/* ── Botones ──────────────────────────────────────────────────────────── */

root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const op = b.dataset.act;
  act(op, Number(b.dataset.arg) || 0);
  // Se responde en el acto; la página confirma un instante después.
  if (op === 'toggle') { st = { ...st, time: now(), paused: !st.paused }; at = performance.now(); paint(); }
  if (op === 'mute') { st = { ...st, muted: !st.muted }; paint(); }
});

/* ── Tocar y arrastrar el video ───────────────────────────────────────── */

root.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.pip-btn, .pip-bar')) return;
  drag = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId };
  root.setPointerCapture(e.pointerId);
  window.pip.drag('start');
});
root.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < SLOP) return;
  drag.moved = true;
  window.pip.drag('move');
});
function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  window.pip.drag('end');
  if (!d.moved && !cancelled) {
    act('toggle');
    st = { ...st, time: now(), paused: !st.paused };
    at = performance.now();
    paint();
  }
  shown();
}
root.addEventListener('pointerup', (e) => endDrag(e, false));
root.addEventListener('pointercancel', (e) => endDrag(e, true));

/* ── La barra ─────────────────────────────────────────────────────────── */

const fracAt = (x) => {
  const r = bar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (x - r.left) / r.width));
};
let seekTimer = 0;

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || st.duration <= 0) return;
  e.stopPropagation();
  bar.setPointerCapture(e.pointerId);
  scrub = { frac: fracAt(e.clientX) };
  root.classList.add('is-scrubbing');
  paint();
});
bar.addEventListener('pointermove', (e) => {
  if (!scrub) return;
  scrub.frac = fracAt(e.clientX);
  paintTime();
  // Mientras se arrastra, el video va mostrando por dónde anda (sin inundarlo de pedidos).
  if (!seekTimer) seekTimer = setTimeout(() => { seekTimer = 0; if (scrub) act('seek', scrub.frac * st.duration); }, 120);
});
function endScrub(apply) {
  if (!scrub) return;
  const t = scrub.frac * st.duration;
  scrub = null;
  clearTimeout(seekTimer);
  seekTimer = 0;
  root.classList.remove('is-scrubbing');
  if (apply) { act('seek', t); st = { ...st, time: t }; at = performance.now(); }
  paint();
}
bar.addEventListener('pointerup', () => endScrub(true));
bar.addEventListener('pointercancel', () => endScrub(false));

/* ── Teclado (con la ventanita enfocada) ──────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { e.preventDefault(); root.querySelector('[data-act="toggle"]').click(); }
  else if (k === 'arrowleft') { e.preventDefault(); act('skip', -5); }
  else if (k === 'arrowright') { e.preventDefault(); act('skip', 5); }
  else if (k === 'm') { e.preventDefault(); root.querySelector('[data-act="mute"]').click(); }
  else return;
  wake();
});

paint();
