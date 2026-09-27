'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: la ventanita
   Corre en cada frame de cada página (también en los iframes: el video de
   YouTube metido en el aula del campus vive en uno), en el mundo aislado del
   preload. La página no ve este código ni `ipcRenderer`, aunque comparten el
   DOM y los <video>. Hace tres cosas:

   · El botón. Con el mouse sobre un video que se pueda sacar, cuelga una
     pastillita en su borde derecho; al tocarla, el video se va a la
     ventanita. Vive en un shadow root cerrado: los estilos de la página no
     la deforman y sus scripts no la leen.

   · Entrar y salir. La ventanita (src/pip.cjs) muda la página ENTERA a una
     ventana chica; acá el video pasa a pantalla completa DENTRO de esa
     página, así la llena sin importar cómo esté armado el sitio (la capa de
     pantalla completa de Chromium esquiva los transform, los overflow y los
     z-index de sus contenedores). La ventana de Prism no se agranda: esa
     pantalla completa queda adentro de la ventanita.

   · El control. Cuenta el estado del video (reproduciendo, tiempo, duración,
     silencio) y obedece lo que piden los botones de la ventanita.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcRenderer, webFrame } = require('electron');

/** Un video más chico que esto es un ícono animado o una publicidad, no algo para mirar. */
const MIN_W = 200;
const MIN_H = 112;
/** Sin mover el mouse, el botón se va a este tiempo (salvo que esté encima). */
const IDLE = 2600;

let target = null;     // el video que está en la ventanita
let hovered = null;    // el video bajo el mouse (el del botón)
let picked = null;     // el que se eligió con el botón
let fromContext = null;

function usable(v) {
  if (!(v instanceof HTMLVideoElement) || !v.isConnected) return false;
  // El sitio pidió que ese video no salga en una ventanita.
  if (v.disablePictureInPicture || v.hasAttribute('disablepictureinpicture')) return false;
  if (!(v.readyState > 0 || v.currentSrc || v.srcObject)) return false;
  const r = v.getBoundingClientRect();
  if (r.width < MIN_W || r.height < MIN_H) return false;
  const cs = getComputedStyle(v);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

const videos = () => document.getElementsByTagName('video');

/* Los reproductores suelen tapar el video con una capa transparente (la de
   sus controles): el que está "debajo del mouse" se busca por rectángulo,
   no por el elemento que recibe el evento. */
function videoAt(x, y) {
  let best = null;
  let area = 0;
  for (const v of videos()) {
    const r = v.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    if (r.width * r.height > area && usable(v)) { best = v; area = r.width * r.height; }
  }
  return best;
}

/** El que más probablemente quiera ver la persona: el que suena, el que ya
    arrancó, y entre esos el que más se ve. */
function bestVideo() {
  let best = null;
  let score = 0;
  for (const v of videos()) {
    if (!usable(v)) continue;
    const r = v.getBoundingClientRect();
    const seen = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
      * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const s = (!v.paused && !v.ended ? 4e8 : 0) + (v.currentTime > 0 ? 2e8 : 0) + seen + 1;
    if (s > score) { best = v; score = s; }
  }
  return { video: best, score };
}

/* ── El botón ──────────────────────────────────────────────────────────── */

const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><rect x="7.9" y="7.9" width="4.3" height="3.3" rx=".8" fill="currentColor" stroke="none"/></svg>';
const CSS = `
  :host { all: initial; }
  .b {
    position: fixed; z-index: 2147483647; box-sizing: border-box;
    display: flex; align-items: center; height: 30px; padding: 0 8px;
    border: 0; border-radius: 999px; margin: 0;
    background: rgb(20 20 22 / .88); color: #ececec;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / .1), 0 6px 18px rgb(0 0 0 / .35), 0 1px 3px rgb(0 0 0 / .3);
    font: 500 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    cursor: pointer; user-select: none; -webkit-user-select: none;
    opacity: 0; transform: translateX(6px); pointer-events: none;
    transition: opacity .16s cubic-bezier(.65,0,.35,1), transform .18s cubic-bezier(.16,1,.3,1), background-color .11s cubic-bezier(.33,1,.68,1);
  }
  .b.is-on { opacity: 1; transform: none; pointer-events: auto; }
  .b:hover { background: rgb(40 40 44 / .94); }
  .b:focus-visible { outline: 2px solid rgb(130 170 255 / .8); outline-offset: 2px; }
  .b svg { width: 16px; height: 16px; flex: none; }
  /* La etiqueta se despliega al pasar por encima (0fr → 1fr). */
  .l { display: grid; grid-template-columns: 0fr; transition: grid-template-columns .2s cubic-bezier(.16,1,.3,1); }
  .l > span { min-width: 0; overflow: hidden; white-space: nowrap; }
  .l > span > i { font-style: normal; display: inline-block; padding-left: 6px; }
  .b:hover .l { grid-template-columns: 1fr; }
`;

let host = null;
let btn = null;
let shownFor = null;
let idleTimer = 0;
let raf = 0;
let lastXY = null;

function ensureButton() {
  if (host?.isConnected) return;
  if (!host) {
    host = document.createElement('prism-pip');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><button class="b" type="button" aria-label="Ver en una ventanita">${ICON}<span class="l"><span><i>Ventanita</i></span></span></button>`;
    btn = root.querySelector('.b');
    // Lo que se toca acá no le llega a la página (no pausa el video de abajo).
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick']) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!e.isTrusted || !shownFor) return;
      picked = shownFor;
      hideButton();
      ipcRenderer.send('pip:open');
    });
    btn.addEventListener('pointerenter', () => clearTimeout(idleTimer));
    btn.addEventListener('pointerleave', () => armIdle());
  }
  (document.documentElement || document).appendChild(host);
}

function placeButton() {
  if (!shownFor || !btn) return;
  if (!usable(shownFor)) { hideButton(); return; }
  const r = shownFor.getBoundingClientRect();
  const right = Math.max(8, Math.round(innerWidth - Math.min(r.right, innerWidth) + 10));
  const top = Math.round(Math.max(r.top, 0) + (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / 2 - 15);
  btn.style.right = `${right}px`;
  btn.style.top = `${Math.max(8, Math.min(innerHeight - 38, top))}px`;
}

function showButton(v) {
  ensureButton();
  shownFor = v;
  placeButton();
  btn.classList.add('is-on');
  armIdle();
}

function hideButton() {
  shownFor = null;
  clearTimeout(idleTimer);
  btn?.classList.remove('is-on');
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!btn?.matches(':hover')) hideButton(); }, IDLE);
}

function onMove(e) {
  lastXY = [e.clientX, e.clientY];
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (target || document.fullscreenElement || !lastXY) { hideButton(); return; }
    if (btn?.matches(':hover')) return;
    hovered = videoAt(lastXY[0], lastXY[1]);
    if (hovered) showButton(hovered);
    else hideButton();
  });
}

addEventListener('pointermove', onMove, { capture: true, passive: true });
addEventListener('scroll', () => { if (shownFor) placeButton(); }, { capture: true, passive: true });
addEventListener('resize', () => { if (shownFor) placeButton(); }, { passive: true });
// El mouse se fue de la página (a la barra de Prism, a otra ventana).
addEventListener('mouseout', (e) => { if (!e.relatedTarget) hideButton(); }, { passive: true });
addEventListener('blur', () => hideButton());

// El clic derecho sobre un video: "Ver en una ventanita" del menú lo usa.
addEventListener('contextmenu', (e) => {
  fromContext = videoAt(e.clientX, e.clientY) || (e.target instanceof HTMLVideoElement && usable(e.target) ? e.target : null);
}, { capture: true, passive: true });

/* ── Entrar, salir y el estado ─────────────────────────────────────────── */

let cssKey = null;
let leaving = false;
let pushQueued = false;
const EVENTS = ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'volumechange', 'resize', 'loadedmetadata', 'emptied', 'seeked', 'ratechange'];

function state() {
  const v = target;
  const d = v.duration;
  return {
    paused: v.paused || v.ended,
    time: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    // -1: en vivo (no tiene final).
    duration: Number.isFinite(d) ? d : d === Infinity ? -1 : 0,
    muted: v.muted || v.volume === 0,
    w: v.videoWidth || 0,
    h: v.videoHeight || 0,
  };
}

function push() {
  if (pushQueued || !target) return;
  pushQueued = true;
  queueMicrotask(() => {
    pushQueued = false;
    if (target) ipcRenderer.send('pip:state', state());
  });
}

function release() {
  if (!target) return;
  for (const t of EVENTS) target.removeEventListener(t, push);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (cssKey) { try { webFrame.removeInsertedCSS(cssKey); } catch { /* ya no estaba */ } cssKey = null; }
  target = null;
}

function onFullscreenChange() {
  // La página salió sola de la pantalla completa (o cambió de video): el
  // proceso principal se entera por su lado y trae la página de vuelta.
  if (target && !leaving && document.fullscreenElement !== target) release();
}

async function enter(pick) {
  const v = pick === 'picked' ? picked : pick === 'context' ? fromContext : bestVideo().video;
  picked = null;
  if (!usable(v)) return { ok: false, error: 'none' };
  hideButton();
  // Los controles propios de Chromium no aparecen: los de la ventanita son de Prism.
  cssKey = webFrame.insertCSS('video::-webkit-media-controls { display: none !important; } video:fullscreen { cursor: default !important; }');
  try {
    await v.requestFullscreen({ navigationUI: 'hide' });
  } catch (err) {
    try { webFrame.removeInsertedCSS(cssKey); } catch { /* nada */ }
    cssKey = null;
    return { ok: false, error: String(err?.message || err) };
  }
  target = v;
  leaving = false;
  for (const t of EVENTS) v.addEventListener(t, push);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  return { ok: true, ...state() };
}

async function leave(pause) {
  if (!target) return { ok: true };
  leaving = true;
  const v = target;
  if (pause) v.pause();
  release();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  leaving = false;
  return { ok: true };
}

function command(op, arg) {
  const v = target;
  if (!v) return;
  const n = Number(arg) || 0;
  if (op === 'toggle') {
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  } else if (op === 'seek' && Number.isFinite(v.duration)) {
    v.currentTime = Math.max(0, Math.min(v.duration, n));
  } else if (op === 'skip') {
    const end = Number.isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.max(0, Math.min(end, v.currentTime + n));
  } else if (op === 'mute') {
    if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; } else v.muted = true;
  }
  push();
}

ipcRenderer.on('pip:find', (_e, nonce) => {
  ipcRenderer.send('pip:found', nonce, bestVideo().score);
});
ipcRenderer.on('pip:enter', async (_e, nonce, pick) => {
  ipcRenderer.send('pip:reply', nonce, await enter(pick));
});
ipcRenderer.on('pip:leave', async (_e, nonce, pause) => {
  ipcRenderer.send('pip:reply', nonce, await leave(!!pause));
});
ipcRenderer.on('pip:cmd', (_e, op, arg) => command(String(op), arg));
