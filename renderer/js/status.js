/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la statusbar
   A la izquierda, a dónde lleva el link que tenés abajo del mouse (como la
   burbuja de Chrome, pero en su propio lugar: una burbuja sobre la página
   quedaría tapada por la vista nativa). Si no hay link, el último aviso.
   A la derecha, lo que está pasando de fondo: descargas, conexión.

   Los avisos de Prism van acá y no en un toast: un toast caería sobre la
   página, y habría que congelarla solo para decir "descarga completa".
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on } from './state.js';
import { Icons } from './icons.js';
import { exit, reconcile, roll, swapText } from './motion.js';
import { esc } from './ui.js';
import { plural } from './format.js';

let left;
let right;
let hoverUrl = '';
let msg = null;
let msgTimer = null;
let shownKey = '';

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

function paintLeft() {
  const key = hoverUrl ? `u:${hoverUrl}` : msg ? `m:${msg.text}` : '';
  if (key === shownKey) return;
  shownKey = key;
  const old = left.querySelectorAll('.pr-status__msg:not([data-state="closing"])');
  old.forEach((el) => exit(el, { fallback: 180 }));
  if (!key) return;
  const el = document.createElement('div');
  el.className = `pr-status__msg${msg?.tone === 'error' && !hoverUrl ? ' pr-status__msg--error' : ''}${old.length ? ' is-after' : ''}`;
  el.innerHTML = hoverUrl
    ? `${Icons.svg('link')}<span class="pr-status__url op-truncate">${esc(safeDecode(hoverUrl))}</span>`
    : `${Icons.svg(msg.icon || 'info')}<span class="op-truncate">${esc(msg.text)}</span>`;
  left.appendChild(el);
}

/** El link que tenés abajo del mouse, cuando no es de la página (un favorito de la barra). */
export function hover(url) {
  hoverUrl = url || '';
  paintLeft();
}

/** Un aviso corto en la statusbar. Se va solo. */
export function say(text, { icon = 'info', tone = 'default', ms = 4500 } = {}) {
  msg = { text, icon, tone };
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msg = null; paintLeft(); }, ms);
  paintLeft();
}

/* Lo de la derecha se pone al día pieza por pieza (reconcile): rehecho con
   cada dato de una descarga, el aviso volvía a aparecer desde cero varias
   veces por segundo. La cuenta se releva, el porcentaje corre. */
function paintRight() {
  const live = S.downloads.filter((d) => d.state === 'progressing');
  const known = live.filter((d) => d.total > 0);
  const pct = known.length ? (known.reduce((s, d) => s + d.received, 0) / known.reduce((s, d) => s + d.total, 0)) * 100 : null;
  const parts = [];
  if (!navigator.onLine) parts.push({ key: 'offline', html: `<span class="pr-status__item" style="color:var(--op-text-2)">${Icons.svg('wifiOff')} Sin conexión</span>` });
  if (live.length) {
    parts.push({
      key: 'downloads',
      count: plural(live.length, 'descarga', 'descargas'),
      pct,
      html: `<span class="pr-status__item">${Icons.svg('download')}<span class="pr-status__count">${plural(live.length, 'descarga', 'descargas')}</span><span class="pr-status__pct op-num${pct != null ? ' is-on' : ''}">· <span>${pct != null ? Math.round(pct) : 0} %</span></span></span>`,
    });
  }
  reconcile(right, parts, {
    update: (el, it) => {
      swapText(el.querySelector('.pr-status__count'), it.count);
      const p = el.querySelector('.pr-status__pct');
      p.classList.toggle('is-on', it.pct != null);
      if (it.pct != null) { const n = p.lastElementChild; roll(n, it.pct, (v) => { n.textContent = `${Math.round(v)} %`; }, { from: parseFloat(n.textContent) }); }
    },
  });
}

export function init() {
  left = document.getElementById('status-left');
  right = document.getElementById('status-right');

  api.page.onHover((url) => { hoverUrl = url || ''; paintLeft(); });
  api.onStatus((m) => say(m.text, { icon: m.icon, tone: m.tone, ...(m.ms ? { ms: m.ms } : {}) }));
  on('downloads', paintRight);
  window.addEventListener('online', paintRight);
  window.addEventListener('offline', paintRight);
  paintRight();
}
