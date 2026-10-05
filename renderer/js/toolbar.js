/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la barra de herramientas
   Atrás / adelante / recargar, el buscador en la página, el escudo del
   bloqueador, las descargas y el menú. Cada botón refleja el estado de la
   pestaña activa y nada más: el estado vive en el proceso principal.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab, isWebActive } from './state.js';
import { Icons } from './icons.js';
import { esc } from './ui.js';
import { fmtBytes, fmtNum, plural } from './format.js';
import { popover, currentPopover, popoverOpen } from './layers.js';
import { mainMenu, openPage } from './menus.js';
import { dlItem, dlUpdate, dlCreated } from './pages.js';
import { reconcile, roll, swapText } from './motion.js';

let back; let fwd; let reload; let shield; let shieldCount; let dl; let menuBtn; let loadbar;
let find; let findInput; let findCount;

/* ── Navegación ──────────────────────────────────────────────────────────── */

function sync() {
  const t = activeTab();
  back.disabled = !t?.canGoBack;
  fwd.disabled = !t?.canGoForward;
  const loading = !!t?.loading && !t.internal;
  reload.classList.toggle('is-loading', loading);
  reload.classList.toggle('is-b', loading);   // recargar ↔ detener se cruzan (.op-iconswap)
  reload.dataset.tip = loading ? 'Detener' : 'Recargar';
  // Detener no tiene tecla: Escape es de la página (cierra SUS modales), no de Prism.
  if (loading) delete reload.dataset.tipKey;
  else reload.dataset.tipKey = 'F5';
  reload.disabled = !t || (t.internal && !t.error);
  loadbar.classList.toggle('is-on', loading);

  // El escudo: cuenta lo bloqueado en ESTA página.
  const off = !!t?.adblockOff;
  const n = t && !t.internal ? t.blocked || 0 : 0;
  // Escudo ↔ escudo tachado: los dos íconos están encimados y se cruzan (.op-iconswap).
  shield.classList.toggle('is-off', off);
  shield.classList.toggle('is-b', off);
  // El número se queda puesto mientras la insignia se apaga: si se vaciara
  // primero, se vería encogerse una pastilla vacía. Y corre: mientras una
  // página carga, sube de a varios.
  if (n && !off) roll(shieldCount, n, (v) => { const r = Math.round(v); shieldCount.textContent = r > 99 ? '99+' : String(r); });
  shieldCount.classList.toggle('is-on', !!n && !off);
  shield.dataset.tip = off ? 'Bloqueador apagado en este sitio' : n ? `${plural(n, 'elemento bloqueado', 'elementos bloqueados')}` : 'Bloqueador';

  if (!isWebActive()) closeFind();
}

/* ── Buscar en la página ─────────────────────────────────────────────────── */

let findOpen = false;

export function openFind() {
  if (!isWebActive()) return;
  findOpen = true;
  findDir = 0;
  // Lo de la vez anterior se quedó para plegarse con la barra: ahora se va.
  if (!findInput.value) paintCount('');
  find.classList.add('is-open');
  find.inert = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) api.page.find(findInput.value, { newSession: true });
}

/* La cuenta se releva en su lugar: al ir a la siguiente sube, a la anterior
   baja, como un contador. Escribiendo, solo se cruza. Al cerrar no se borra:
   la barra se pliega con lo último que decía. */
let findDir = 0;
const paintCount = (text) => swapText(findCount, text, { dir: findDir });

export function closeFind({ focusPage = false } = {}) {
  if (!findOpen) return;
  findOpen = false;
  /* Cerrada, inerte: ni el Tab ni el mouse llegan a lo que no se ve. Con
     aria-hidden solo, sus botones seguían en el recorrido del Tab, sin
     anillo a la vista y con su tooltip flotando al lado de la ventana. */
  find.classList.remove('is-open', 'is-miss');
  find.inert = true;
  api.page.findStop();
  if (focusPage) api.page.focus();
}

export function findStep(forward = true) {
  if (!findOpen) { openFind(); return; }
  findDir = forward ? 1 : -1;
  if (findInput.value) api.page.find(findInput.value, { forward, newSession: false });
}

function onFindResult(r) {
  if (!findOpen) return;
  paintCount(r.matches ? `${r.ordinal}/${r.matches}` : findInput.value ? '0/0' : '');
  find.classList.toggle('is-miss', !!findInput.value && r.final && !r.matches);
}

/* ── El escudo ───────────────────────────────────────────────────────────── */

function shieldPanel() {
  popover(shield, async (el, ctl) => {
    const t = activeTab();
    const host = (() => { try { return new URL(t?.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const web = !!t && !t.internal && !!host;
    const global = !!S.settings.adblock;
    const siteOn = global && !t?.adblockOff;
    const n = web ? t.blocked || 0 : 0;
    const stats = await api.adblock.stats().catch(() => ({ total: 0, ready: false }));
    el.innerHTML = `
      <div class="pr-pop__head">
        <div class="op-grow">
          <div class="pr-pop__title">Bloqueador</div>
          <div class="pr-pop__sub">${!stats.ready && global ? (stats.error ? 'No se pudieron bajar las listas: Prism vuelve a probar solo' : 'Bajando las listas de filtros…') : 'Anuncios, rastreadores y carteles de cookies'}</div>
        </div>
      </div>
      <div class="pr-shieldpop__stat">
        <span class="pr-shieldpop__num">${web ? fmtNum(n) : '—'}</span>
        <span class="pr-shieldpop__label">${web ? (n === 1 ? 'bloqueado en esta página' : 'bloqueados en esta página') : 'Abrí un sitio para ver qué bloquea'}</span>
      </div>
      ${web ? `<div class="pr-shieldpop__row">
          <div class="op-grow">Activo en <span class="pr-shieldpop__host">${esc(host)}</span></div>
          <button class="op-switch${siteOn ? ' is-on' : ''}" id="sh-site" ${global ? '' : 'disabled'} aria-label="Activo en este sitio"></button>
        </div>` : ''}
      <div class="pr-shieldpop__row">
        <div class="op-grow">Bloquear en todos los sitios</div>
        <button class="op-switch${global ? ' is-on' : ''}" id="sh-global" aria-label="Bloquear en todos los sitios"></button>
      </div>
      <div class="pr-pop__foot">
        <span class="op-meta op-grow">${fmtNum(stats.total)} en esta sesión</span>
        <button class="op-btn op-btn--ghost op-btn--sm" id="sh-settings">Ajustes</button>
      </div>`;
    el.querySelector('#sh-site')?.addEventListener('click', async (e) => {
      e.currentTarget.classList.toggle('is-on');
      await api.adblock.toggleSite(t.url).catch(() => null);
      S.settings = await api.settings.get();
      setTimeout(() => ctl.refresh({ fade: true }), 200);
    });
    el.querySelector('#sh-global').addEventListener('click', async (e) => {
      // Lo que muestra el switch, no "lo contrario" de lo que había al abrir:
      // un doble clic mandaba dos veces lo mismo.
      const on = e.currentTarget.classList.toggle('is-on');
      S.settings = await api.settings.save({ adblock: on });
      setTimeout(() => ctl.refresh({ fade: true }), 200);
    });
    el.querySelector('#sh-settings').addEventListener('click', () => { ctl.close(); openPage('ajustes'); });
  }, { width: 320 });
}

/* ── Descargas ───────────────────────────────────────────────────────────── */

function syncDownloads(justFinished = false) {
  const live = S.downloads.filter((d) => d.state === 'progressing');
  dl.classList.toggle('is-active', live.length > 0);
  const known = live.filter((d) => d.total > 0);
  const total = known.reduce((s, d) => s + d.total, 0);
  const got = known.reduce((s, d) => s + d.received, 0);
  dl.classList.toggle('is-indeterminate', live.length > 0 && !total);
  const wasActive = dl.dataset.active === '1';
  dl.dataset.active = live.length ? '1' : '';
  const p = String(total ? Math.round((got / total) * 100) : 0);
  if (live.length && !wasActive) {
    // Arranca de su valor sin desenrollarse desde el lleno de la vez anterior.
    dl.classList.add('is-fresh');
    dl.style.setProperty('--p', p);
    void dl.getBoundingClientRect();
    dl.classList.remove('is-fresh');
  } else if (live.length) {
    dl.style.setProperty('--p', p);
  } else if (wasActive) {
    // Terminó: el arco se completa mientras el anillo se apaga, no se desenrolla.
    dl.style.setProperty('--p', '100');
  }
  dl.dataset.tip = live.length ? `${plural(live.length, 'descarga', 'descargas')} en curso` : 'Descargas';
  if (justFinished) {
    dl.classList.remove('is-done');
    void dl.offsetWidth;
    dl.classList.add('is-done');
  }
  if (popoverOpen(dl)) currentPopover()?.refresh();
}

/* El panel se arma una vez; cada dato que llega lo pone al día fila por fila
   (reconcile + dlUpdate, de pages.js). Rehecho entero con cada uno, la barra
   saltaba, los íconos cambiaban de golpe y se perdía el hover. */
function downloadsPanel() {
  popover(dl, (el, ctl) => {
    if (!el.dataset.built) {
      el.dataset.built = '1';
      el.innerHTML = `
        <div class="pr-pop__head">
          <div class="op-grow"><div class="pr-pop__title">Descargas</div></div>
          <button class="op-iconbtn op-iconbtn--sm" data-a="folder" data-tip="Abrir la carpeta"><i data-icon="folderOpen"></i></button>
        </div>
        <div class="pr-pop__body op-scroll pr-dlpop__list"></div>
        <div class="pr-pop__foot">
          <span class="op-meta op-grow op-truncate pr-dlpop__dir"></span>
          <button class="op-btn op-btn--ghost op-btn--sm" data-a="all">Ver todas</button>
        </div>`;
    }
    const list = S.downloads.slice(0, 30);
    reconcile(el.querySelector('.pr-dlpop__list'), list.length
      ? list.map((d) => dlItem(d, true))
      : [{ key: '__empty', html: '<div class="pr-pop__empty">Todavía no bajaste nada.</div>' }], { update: dlUpdate, created: dlCreated, height: true });
    swapText(el.querySelector('.pr-dlpop__dir'), S.downloadsDir || '');
    el.onclick = async (e) => {
      const b = e.target.closest('[data-a]');
      const row = e.target.closest('.pr-dlrow');
      if (!b) {
        // Click en la fila de una terminada: la abre.
        if (row) { const d = S.downloads.find((x) => x.id === Number(row.dataset.id)); if (d?.state === 'completed' && !d.missing) api.downloads.open(d.id).catch(() => null); }
        return;
      }
      const a = b.dataset.a;
      if (a === 'folder') return api.downloads.folder();
      if (a === 'all') { ctl.close(); return openPage('descargas'); }
      const id = Number(row?.dataset.id);
      if (id) await api.downloads[a](id).catch(() => null);
    };
  }, { width: 360 });
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

export function init() {
  back = document.getElementById('btn-back');
  fwd = document.getElementById('btn-forward');
  reload = document.getElementById('btn-reload');
  shield = document.getElementById('btn-shield');
  shieldCount = document.getElementById('shield-count');
  dl = document.getElementById('btn-downloads');
  menuBtn = document.getElementById('btn-menu');
  loadbar = document.getElementById('loadbar');
  find = document.getElementById('find');
  findInput = document.getElementById('find-input');
  findCount = document.getElementById('find-count');

  back.addEventListener('click', () => api.nav.back());
  fwd.addEventListener('click', () => api.nav.forward());
  reload.addEventListener('click', (e) => {
    if (reload.classList.contains('is-loading')) api.nav.stop();
    else api.nav.reload(e.shiftKey || e.ctrlKey);
  });
  shield.addEventListener('click', shieldPanel);
  dl.addEventListener('click', downloadsPanel);
  menuBtn.addEventListener('click', () => mainMenu(menuBtn, { openFind }));

  findInput.addEventListener('input', () => {
    if (findInput.value) api.page.find(findInput.value, { newSession: true });
    else { api.page.findStop(); findCount.textContent = ''; find.classList.remove('is-miss'); }
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind({ focusPage: true }); }
  });
  document.getElementById('find-next').addEventListener('click', () => findStep(true));
  document.getElementById('find-prev').addEventListener('click', () => findStep(false));
  document.getElementById('find-close').addEventListener('click', () => closeFind({ focusPage: true }));
  api.page.onFind(onFindResult);

  // Al cambiar de pestaña, lo buscado en la anterior no tiene sentido acá.
  let lastActive = null;
  on('tabs', () => {
    if (lastActive !== S.activeId) { lastActive = S.activeId; closeFind(); }
    sync();
  });
  on('settings', sync);
  on('downloads', syncDownloads);
  // Un punto en el menú cuando hay una actualización esperando.
  const syncUpdate = () => {
    const p = S.update?.phase;
    menuBtn.classList.toggle('has-update', p === 'available' || p === 'ready');
    menuBtn.dataset.tip = p === 'ready' ? 'Menú · actualización lista' : p === 'available' ? 'Menú · hay una versión nueva' : 'Menú';
  };
  on('update', syncUpdate);
  syncUpdate();
  sync();
}
