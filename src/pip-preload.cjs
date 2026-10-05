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
let found = null;      // el que más convenía al preguntar (pip:find)

function usable(v) {
  if (!(v instanceof HTMLVideoElement) || !v.isConnected) return false;
  // El sitio pidió que ese video no salga en una ventanita.
  if (v.disablePictureInPicture || v.hasAttribute('disablepictureinpicture')) return false;
  if (!(v.readyState > 0 || v.currentSrc || v.srcObject)) return false;
  const r = v.getBoundingClientRect();
  if (r.width < MIN_W || r.height < MIN_H) return false;
  const cs = getComputedStyle(v);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  /* Transparente y quieto es un resto escondido. Transparente y sonando es el
     que se está mirando: TikTok tiene así el que pasa (el de abajo, cargado
     para cuando bajes, sí se ve), y la ventanita sacaba ese otro. */
  return Number(cs.opacity) > 0.05 || (!v.paused && !v.ended);
}

const videos = () => document.getElementsByTagName('video');

/** Lo que se ve de un elemento: su rectángulo, recortado por la ventana y por
    los que lo contienen sin dejarlo asomar (overflow). Un carrusel (los
    posteos de varios videos de Instagram) esconde así los de los costados:
    siguen ahí, al lado, pero no se ven. null si no se ve nada.
    Recorta solo quien contiene: algo absoluto asoma por encima de las cajas
    que no están posicionadas, y algo fijo, de todas (salvo las que tienen un
    transform o un filtro). TikTok arma así el video que se está viendo: con
    cualquier caja de por medio recortando, parecía que no se veía. */
const holdsFixed = (cs) => cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain);
function shownRect(el) {
  const r = el.getBoundingClientRect();
  let left = Math.max(r.left, 0);
  let top = Math.max(r.top, 0);
  let right = Math.min(r.right, innerWidth);
  let bottom = Math.min(r.bottom, innerHeight);
  // Cómo está ubicado el último que se miró: dice quién lo puede recortar.
  let pos = getComputedStyle(el).position;
  for (let a = el.parentElement || el.getRootNode()?.host; a && a !== document.body && a !== document.documentElement; a = a.parentElement || a.getRootNode()?.host) {
    const cs = getComputedStyle(a);
    if (pos === 'fixed' && !holdsFixed(cs)) continue;
    if (pos === 'absolute' && cs.position === 'static' && !holdsFixed(cs)) continue;
    pos = cs.position;
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const ar = a.getBoundingClientRect();
    if (cs.overflowX !== 'visible') {
      left = Math.max(left, ar.left + a.clientLeft);
      right = Math.min(right, ar.left + a.clientLeft + a.clientWidth);
    }
    if (cs.overflowY !== 'visible') {
      top = Math.max(top, ar.top + a.clientTop);
      bottom = Math.min(bottom, ar.top + a.clientTop + a.clientHeight);
    }
    if (right <= left || bottom <= top) return null;
  }
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

/* Los reproductores suelen tapar el video con una capa transparente (la de
   sus controles): el que está "debajo del mouse" se busca por rectángulo,
   no por el elemento que recibe el evento. Por lo que se ve de él: uno
   escondido en un carrusel no está debajo del mouse aunque su caja sí. */
function videoAt(x, y) {
  let best = null;
  let area = 0;
  for (const v of videos()) {
    const r = v.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const s = shownRect(v);
    if (!s || x < s.left || x > s.right || y < s.top || y > s.bottom) continue;
    if (s.width * s.height > area && usable(v)) { best = v; area = s.width * s.height; }
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
    const shown = shownRect(v);
    const seen = shown ? shown.width * shown.height : 0;
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
  const r = usable(shownFor) && shownRect(shownFor);
  if (!r) { hideButton(); return; }
  const right = Math.max(8, Math.round(innerWidth - r.right + 10));
  const top = Math.round(r.top + r.height / 2 - 15);
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

/* Mientras hay un video en la ventanita, la página entera está tapada por
   él: otro video suyo que arranca no se ve, solo se oye. Un feed (Instagram)
   pone a andar el que cree que está a la vista y pausa el resto; acá se
   queda callado el otro. */
function hush(e) {
  const m = e.target;
  if (target && m !== target && m instanceof HTMLMediaElement) m.pause();
}

function release() {
  if (!target) return;
  for (const t of EVENTS) target.removeEventListener(t, push);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('play', hush, true);
  if (cssKey) { try { webFrame.removeInsertedCSS(cssKey); } catch { /* ya no estaba */ } cssKey = null; }
  target = null;
}

function onFullscreenChange() {
  // La página salió sola de la pantalla completa (o cambió de video): el
  // proceso principal se entera por su lado y trae la página de vuelta.
  if (target && !leaving && document.fullscreenElement !== target) release();
}

async function enter(pick) {
  const v = pick === 'picked' ? picked : pick === 'context' ? fromContext : found?.isConnected ? found : bestVideo().video;
  picked = null;
  found = null;
  if (!usable(v)) return { ok: false, error: 'none' };
  hideButton();
  // Los controles propios de Chromium no aparecen: los de la ventanita son de Prism.
  cssKey = webFrame.insertCSS('video::-webkit-media-controls { display: none !important; } video:fullscreen { cursor: default !important; opacity: 1 !important; }');
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
  // Los eventos de un video no burbujean, pero pasan por el documento en la captura.
  document.addEventListener('play', hush, true);
  for (const m of document.querySelectorAll('video, audio')) if (m !== v && !m.paused) m.pause();
  return { ok: true, ...state() };
}

/* Después de la pantalla completa, muchos reproductores se reacomodan solos y
   un rato más tarde: YouTube corre el video ~170 ms después de salir. Si la
   foto del regreso se sacaba antes, la página aparecía y el video saltaba a
   su lugar. Se espera a que la página quede quieta un rato (con un tope). */
const STILL_MS = 220;
const SETTLE_MAX = 900;
function settled(v) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = '';
    let since = t0;
    const tick = (now) => {
      const r = v.isConnected ? v.getBoundingClientRect() : null;
      const key = [scrollX, scrollY, innerWidth, innerHeight, r && [r.x, r.y, r.width, r.height].map(Math.round)].join();
      if (key !== last) { last = key; since = now; }
      if (now - since >= STILL_MS || now - t0 >= SETTLE_MAX) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function leave(pause) {
  if (!target) return { ok: true };
  leaving = true;
  const v = target;
  if (pause) v.pause();
  release();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  await settled(v);
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

/* El que más conviene se elige al preguntar, con la página todavía en su
   pestaña: al mudarse a la ventanita queda oculta un instante, y TikTok pausa
   el que suena. Elegido después, ya no sonaba ninguno y salía el de abajo
   (el que tiene cargado para cuando bajes). */
ipcRenderer.on('pip:find', (_e, nonce) => {
  const best = bestVideo();
  found = best.video;
  ipcRenderer.send('pip:found', nonce, best.score);
});
ipcRenderer.on('pip:enter', async (_e, nonce, pick) => {
  ipcRenderer.send('pip:reply', nonce, await enter(pick));
});
ipcRenderer.on('pip:leave', async (_e, nonce, pause) => {
  ipcRenderer.send('pip:reply', nonce, await leave(!!pause));
});
ipcRenderer.on('pip:cmd', (_e, op, arg) => command(String(op), arg));
