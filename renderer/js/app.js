/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — arranque del cromo
   Monta las piezas, las conecta con el proceso principal y se quita el
   splash de encima cuando ya hay algo pintado debajo.
   ═══════════════════════════════════════════════════════════════════════════ */

import './prism-icons.js';
import { Icons } from './icons.js';
import { Tooltip } from './overlays.js';
import { initClickFlash, initScrollFades, raf2 } from './motion.js';
import { colorToken } from './ui.js';
import { api, S, emit } from './state.js';
import * as Freeze from './freeze.js';
import * as Tabstrip from './tabstrip.js';
import * as Omnibox from './omnibox.js';
import * as Toolbar from './toolbar.js';
import * as Pages from './pages.js';
import * as Status from './status.js';
import * as Prompts from './prompts.js';
import { pageMenu } from './menus.js';

/* ── Ventana ─────────────────────────────────────────────────────────────── */

function wireWindow() {
  const w = api.win;
  document.getElementById('win-min').addEventListener('click', () => w.minimize());
  document.getElementById('win-close').addEventListener('click', () => w.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn.addEventListener('click', () => w.toggleMaximize());
  const paintMax = (isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  };
  w.onMaximized(paintMax);
  w.isMaximized().then(paintMax);
}

/* El color base en oklch, resuelto a hex con un canvas (ver ui.js: parsearlo
   con un regex le mandaba VERDE a la ventana) y pasado a Electron para que el
   frame fantasma de minimizar→restaurar quede del mismo color. */
function syncWindowColor() {
  const hex = colorToken('--op-bg');
  if (hex) api.win.setBackground(hex);
}

/* ── La página: dónde apoyar la vista nativa ───────────────────────────────
   El rectángulo de #page se le pasa al proceso principal como márgenes
   respecto de la ventana. Con márgenes (y no con el rectángulo) el proceso
   principal puede recolocar la vista él solo mientras la ventana se
   redimensiona, sin esperar un viaje de ida y vuelta por cada frame. */
function watchPage() {
  const page = document.getElementById('page');
  const send = () => {
    const r = page.getBoundingClientRect();
    api.page.setInsets({
      top: r.top,
      left: r.left,
      right: window.innerWidth - r.right,
      bottom: window.innerHeight - r.bottom,
    });
  };
  new ResizeObserver(send).observe(page);
  window.addEventListener('resize', send);
  send();
}

/* ── Estado que llega del proceso principal ──────────────────────────────── */

function applyTabs(snap) {
  if (!snap) return;
  S.tabs = snap.tabs || [];
  S.activeId = snap.activeId;
  S.canReopen = !!snap.canReopen;
  S.fullscreen = !!snap.fullscreen;
  document.getElementById('app').classList.toggle('is-fullscreen', S.fullscreen);
  emit('tabs');
}

function applyDownloads(list) {
  const was = new Map(S.downloads.map((d) => [d.id, d.state]));
  S.downloads = list || [];
  const finished = S.downloads.some((d) => d.state === 'completed' && was.get(d.id) === 'progressing');
  emit('downloads', finished);
}

/* Las actualizaciones avisan en la statusbar, y solo cuando hay algo que
   hacer: un "estás al día" en cada arranque es ruido. Si la búsqueda la
   pediste vos, sí se contesta. */
function onUpdate(u) {
  const prev = S.update?.phase;
  S.update = u;
  emit('update', u);
  if (u.phase === prev) return;
  if (u.phase === 'available') Status.say(`Hay una versión nueva de Prism: ${u.version}. Está en el menú.`, { icon: 'download', ms: 9000 });
  else if (u.phase === 'ready') Status.say(`La ${u.version} está lista: reiniciá desde el menú para instalarla.`, { icon: 'check', ms: 9000 });
  else if (u.manual && u.phase === 'current') Status.say('Prism está al día.', { icon: 'check' });
  else if (u.manual && u.phase === 'error') Status.say(u.error, { icon: 'alert', tone: 'error' });
}

function onCommand(cmd) {
  if (cmd === 'omni:focus') Omnibox.focus();
  else if (cmd === 'find:open') Toolbar.openFind();
  else if (cmd === 'find:next') Toolbar.findStep(true);
  else if (cmd === 'find:prev') Toolbar.findStep(false);
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  initClickFlash();
  initScrollFades();
  wireWindow();
  syncWindowColor();
  Freeze.reset();

  const [info, settings, state, downloads, dir, update] = await Promise.all([
    api.info(),
    api.settings.get(),
    api.tabs.state(),
    api.downloads.list(),
    api.downloads.dir(),
    api.update.state(),
  ]);
  S.update = update || S.update;
  S.info = info;
  S.settings = settings;
  S.downloads = downloads;
  S.downloadsDir = dir;

  Tabstrip.init();
  Omnibox.init();
  Toolbar.init();
  Pages.init();
  Status.init();
  Prompts.init();
  Pages.setStatusFn((text) => Status.say(text, { icon: 'check' }));

  api.tabs.onState(applyTabs);
  api.settings.onChange(async (s) => {
    S.settings = s;
    S.downloadsDir = await api.downloads.dir().catch(() => S.downloadsDir);
    emit('settings');
  });
  api.downloads.onState(applyDownloads);
  api.onLibraryChanged(() => emit('library'));
  api.page.onContext((p) => pageMenu(p));
  api.page.onFullscreen((on) => document.getElementById('app').classList.toggle('is-fullscreen', on));
  api.onCommand(onCommand);
  api.update.onState(onUpdate);

  applyTabs(state);
  emit('downloads', false);
  window.__prism = { freeze: Freeze.debug, S };
  watchPage();

  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });
}

boot().catch((err) => {
  console.error('[boot]', err);
  document.getElementById('internal').innerHTML = `<div class="pr-notice"><div class="pr-notice__box is-failed">
    <div class="pr-notice__title">Prism no pudo arrancar</div><div class="pr-notice__text"></div></div></div>`;
  document.querySelector('#internal .pr-notice__text').textContent = err?.message || String(err);
  document.getElementById('boot-splash')?.remove();
});
