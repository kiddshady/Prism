/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preguntas de los sitios (y alguna de Prism)
   Un sitio pide la cámara, la ubicación, compartir la pantalla… y el proceso
   principal espera la respuesta. Acá se pregunta, de a una por vez (dos
   modales encimados no se entienden), y se contesta. Prism usa la misma fila
   para lo que pregunta desde el proceso principal ("hay descargas en curso,
   ¿salir igual?").

   Cerrar el diálogo sin elegir (Escape, click afuera) es NO, y no se recuerda:
   la próxima vez el sitio vuelve a preguntar.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api } from './state.js';
import { Icons } from './icons.js';
import { Modal } from './overlays.js';
import { esc } from './ui.js';
import { modal } from './layers.js';

let queue = Promise.resolve();
/** La que está preguntando ahora, con lo que retira SU diálogo. */
let current = null;
/** Las que el proceso principal canceló antes de que les tocara el turno. */
const cancelled = new Set();

const ICON = {
  camera: 'camera', microphone: 'mic', geolocation: 'location', notifications: 'bell',
  'clipboard-read': 'copy', midi: 'music', midiSysex: 'music', 'idle-detection': 'clock',
  'window-management': 'window', openExternal: 'external', 'storage-access': 'passKey', 'top-level-storage-access': 'passKey',
};

const pretty = (origin) => String(origin || '').replace(/^https:\/\//, '');

/* Estas preguntas las abre un sitio cuando quiere, no la persona: el sitio
   puede elegir el instante en que estás por hacer un segundo click o por
   apretar Enter en la barra. Los primeros 600 ms el diálogo no toma clicks en
   sus botones, y ningún botón arranca con el foco (Chrome hace lo mismo). */
const ARM = 600;

async function askPermission(req, signal) {
  const body = document.createElement('div');
  // «openExternal:zoommtg» usa el ícono de openExternal.
  const icon = req.keys?.length === 2 ? 'camera' : ICON[String(req.keys?.[0]).split(':')[0]] || 'passKey';
  body.innerHTML = `
    <div class="pr-ask">
      <div class="pr-ask__icon">${Icons.svg(icon)}</div>
      <div class="pr-ask__text"><span class="pr-ask__origin">${esc(pretty(req.origin))}</span> quiere ${esc(req.what)}.</div>
    </div>
    <label class="pr-remember"><button class="op-check is-on" id="p-remember" aria-label="Recordar">${Icons.svg('check')}</button> Recordar la respuesta para este sitio</label>`;
  const check = body.querySelector('#p-remember');
  body.querySelector('.pr-remember').addEventListener('click', (e) => { e.preventDefault(); check.classList.toggle('is-on'); });

  const v = await modal({
    title: 'Permiso',
    body,
    width: 440,
    signal,
    arm: ARM,
    actions: [
      { label: 'Bloquear', value: 'deny' },
      { label: 'Permitir', value: 'allow', variant: 'primary' },
    ],
  });
  if (!v) return { allow: false, remember: false };
  return { allow: v === 'allow', remember: check.classList.contains('is-on') };
}

async function askDisplay(req, signal) {
  const screens = req.sources.filter((s) => s.kind === 'screen');
  const windows = req.sources.filter((s) => s.kind === 'window');
  let pick = screens[0]?.id || windows[0]?.id || null;

  const body = document.createElement('div');
  const card = (s) => `
    <button class="pr-source${s.id === pick ? ' is-selected' : ''}" data-id="${esc(s.id)}">
      ${s.thumb ? `<img class="pr-source__thumb" src="${esc(s.thumb)}" alt="">` : '<div class="pr-source__thumb"></div>'}
      <span class="pr-source__name">${s.icon ? `<img src="${esc(s.icon)}" alt="">` : Icons.svg(s.kind === 'screen' ? 'screen' : 'window', 'op-icon--sm')}<span>${esc(s.name)}</span></span>
    </button>`;
  body.innerHTML = `
    <div class="pr-ask__text" style="margin-bottom:14px"><span class="pr-ask__origin">${esc(pretty(req.origin))}</span> quiere ver tu pantalla. Elegí qué compartir.</div>
    ${screens.length ? `<div class="op-eyebrow" style="margin:4px 0 8px">Pantallas</div><div class="pr-sources">${screens.map(card).join('')}</div>` : ''}
    ${windows.length ? `<div class="op-eyebrow" style="margin:18px 0 8px">Ventanas</div><div class="pr-sources">${windows.map(card).join('')}</div>` : ''}
    <label class="pr-remember" id="d-audio-row"><button class="op-check" id="d-audio" aria-label="Audio">${Icons.svg('check')}</button> Compartir también el sonido de la compu</label>`;

  const audioRow = body.querySelector('#d-audio-row');
  const syncAudio = () => { audioRow.classList.toggle('is-dim', !pick?.startsWith('screen')); };
  syncAudio();
  audioRow.addEventListener('click', (e) => {
    e.preventDefault();
    if (pick?.startsWith('screen')) body.querySelector('#d-audio').classList.toggle('is-on');
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('.pr-source');
    if (!b) return;
    pick = b.dataset.id;
    body.querySelectorAll('.pr-source').forEach((x) => x.classList.toggle('is-selected', x === b));
    syncAudio();
  });
  // Doble click comparte directo (pasado el armado: el doble click no puede venir de antes).
  body.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.pr-source');
    if (b && !body.closest('.is-arming')) { pick = b.dataset.id; Modal.close('share'); }
  });

  const v = await modal({
    title: 'Compartir pantalla',
    body,
    width: 640,
    signal,
    arm: ARM,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Compartir', value: 'share', variant: 'primary' },
    ],
  });
  if (v !== 'share' || !pick) return null;
  return { id: pick, audio: pick.startsWith('screen') && body.querySelector('#d-audio').classList.contains('is-on') };
}

/* La pide la persona (salir, reiniciar): sin armado, y el foco en la salida
   segura, porque un Enter de más no puede cortar una descarga. */
async function askConfirm(req, signal) {
  const v = await modal({
    title: req.title,
    sub: req.sub,
    width: 420,
    signal,
    actions: [
      { label: req.cancelLabel || 'Cancelar', value: false, autofocus: true },
      { label: req.confirmLabel || 'Confirmar', value: true, variant: 'danger-solid' },
    ],
  });
  return v === true;
}

const ASK = { permission: askPermission, display: askDisplay, confirm: askConfirm };

export function init() {
  api.prompts.onAsk((req) => {
    queue = queue.then(async () => {
      // La pestaña que preguntaba se cerró mientras esperaba en la fila: ni se muestra.
      if (cancelled.delete(req.id)) return;
      current = { id: req.id, ctl: new AbortController() };
      const { signal } = current.ctl;
      let answer = null;
      try {
        answer = await ASK[req.kind](req, signal);
      } catch (err) {
        console.error('[prompt]', err);
      }
      current = null;
      api.prompts.answer(req.id, answer);
    });
  });
  /* El proceso principal lo dio por perdido (se cerró la pestaña): se retira
     SU diálogo —aunque todavía esté esperando detrás de otro modal—, o si no
     le tocaba el turno, se saltea. Un Modal.close() a ciegas cerraba el que
     estuviera a la vista, que podía ser otro (Imprimir, Borrar datos). */
  api.prompts.onCancel((id) => {
    if (current?.id === id) current.ctl.abort();
    else cancelled.add(id);
  });
}
