/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — las páginas propias
   Lo que se dibuja ADENTRO de la hoja de la página cuando la pestaña activa
   no es un sitio: la nueva pestaña, el historial, los favoritos, las
   descargas, los ajustes, y los avisos (no se pudo cargar, la pestaña se
   cayó). También la espera de una pestaña web que todavía no pintó.

   Cada página se monta una vez por pestaña y se re-dibuja solo cuando cambian
   SUS datos — no con cada foto de estado que llega mientras otra pestaña
   carga. Si se re-montara con cada una, el campo de búsqueda perdería el foco
   a mitad de palabra.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab } from './state.js';
import { Icons } from './icons.js';
import { exit, scrollFade, bindSwitcher, raf2 } from './motion.js';
import { esc, copy } from './ui.js';
import { fmtBytes, fmtDur, relTime, plural, locale } from './format.js';
import { menu, modal, confirm } from './layers.js';
import { Toast } from './overlays.js';
import { attachSuggest } from './suggest.js';

let key = null;
let current = null;       // { name, el, refresh? }
let cleanups = [];

const host = () => document.getElementById('internal');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const engineName = () => S.info?.engines?.[S.settings.searchEngine] || 'Google';

function favIcon(url, favicon, fallback = 'globe') {
  return favicon
    ? `<img src="${esc(favicon)}" alt="" referrerpolicy="no-referrer" data-fallback="${fallback}">`
    : Icons.svg(fallback);
}

/** Un <img> de favicon que no carga vuelve a su ícono en vez de quedar roto. */
function wireFallbacks(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => { img.outerHTML = Icons.svg(img.dataset.fallback); }, { once: true });
  });
}

function mount(html, name) {
  const el = document.createElement('div');
  el.className = 'pr-view';
  el.dataset.page = name;
  el.innerHTML = html;
  Icons.mount(el);
  wireFallbacks(el);
  const old = host().querySelectorAll('.pr-view:not([data-state="closing"])');
  old.forEach((o) => exit(o, { fallback: 160 }));
  host().appendChild(el);
  el.querySelectorAll('.op-scroll').forEach(scrollFade);
  /* La animación de entrada se saca al terminar (lección de Opal): una
     opacidad retenida deja al contenedor como frontera de backdrop. */
  setTimeout(() => { el.style.animation = 'none'; }, 520);
  return el;
}

function pageKey(t) {
  if (!t) return 'none';
  if (t.internal) return `internal:${t.internal}:${t.id}`;
  if (t.crashed) return `crashed:${t.id}`;
  if (t.error) return `error:${t.id}:${t.error.code}:${t.error.url}`;
  return `web:${t.id}`;
}

export function render() {
  const t = activeTab();
  const k = pageKey(t);
  if (k === key) {
    if (k.startsWith('web:')) syncWaiting(t);
    return;
  }
  key = k;
  cleanups.forEach((fn) => { try { fn(); } catch { /* nada */ } });
  cleanups = [];
  if (!t) { mount('', 'none'); current = null; return; }
  if (t.internal) { current = PAGES[t.internal]?.(t) || null; return; }
  if (t.crashed) { current = crashedPage(t); return; }
  if (t.error) { current = errorPage(t); return; }
  current = waitingPage(t);
}

/* ══ Espera ══════════════════════════════════════════════════════════════════ */

function waitingPage(t) {
  const el = mount(`<div class="pr-waiting"><div class="pr-waiting__dot">${favIcon(t.url, t.favicon)}</div></div>`, 'waiting');
  return { name: 'waiting', el };
}

function syncWaiting(t) {
  if (current?.name !== 'waiting') return;
  const dot = current.el.querySelector('.pr-waiting__dot');
  if (t.favicon && !dot.querySelector('img')) { dot.innerHTML = favIcon(t.url, t.favicon); wireFallbacks(dot); }
}

/* ══ Avisos ══════════════════════════════════════════════════════════════════ */

function errorInfo(code) {
  if (code === -106) return { icon: 'wifiOff', title: 'Sin conexión', text: 'La compu no está conectada a internet. Revisá el wifi o el cable y volvé a intentar.' };
  if (code === -105 || code === -137) return { icon: 'search', title: 'No se encontró el sitio', text: 'No existe un sitio con ese nombre, o la red no puede resolverlo. Revisá que la dirección esté bien escrita.' };
  if (code === -102) return { icon: 'alert', title: 'El sitio rechazó la conexión', text: 'El servidor está apagado o no acepta conexiones en esa dirección.' };
  if (code === -118 || code === -7) return { icon: 'clock', title: 'El sitio no respondió a tiempo', text: 'Puede estar sobrecargado o caído. Esperá un momento y volvé a intentar.' };
  if (code <= -200 && code > -300) return { icon: 'lock', title: 'El certificado no es válido', text: 'La conexión no es confiable: alguien podría estar haciéndose pasar por este sitio. Prism no lo abrió.', failed: true };
  if (code === -6) return { icon: 'file', title: 'No se encontró el archivo', text: 'Puede haberse movido o borrado.' };
  if (code === -300) return { icon: 'alert', title: 'La dirección no es válida', text: 'Revisá cómo está escrita.' };
  if (code === -21 || code === -100 || code === -101 || code === -109) return { icon: 'wifiOff', title: 'Se cortó la conexión', text: 'La red cambió o el servidor cerró la conexión a mitad de camino.' };
  return { icon: 'alert', title: 'No se pudo abrir la página', text: 'Algo falló en el camino hasta el sitio.' };
}

function errorPage(t) {
  const info = errorInfo(t.error.code);
  const el = mount(`
    <div class="pr-notice"><div class="pr-notice__box${info.failed ? ' is-failed' : ''}">
      ${Icons.svg(info.icon, 'pr-notice__icon')}
      <div class="pr-notice__title">${esc(info.title)}</div>
      <div class="pr-notice__text">${esc(info.text)}</div>
      <div class="pr-notice__url">${esc(t.error.url || t.url)}</div>
      <span class="pr-notice__code">${esc(t.error.desc || 'ERROR')} · ${t.error.code}</span>
      <div class="pr-notice__actions">
        <button class="op-btn op-btn--primary op-flashable" data-a="retry"><i data-icon="reload"></i> Reintentar</button>
        ${t.canGoBack ? '<button class="op-btn op-btn--ghost" data-a="back"><i data-icon="arrowLeft"></i> Volver</button>' : ''}
      </div>
    </div></div>`, 'error');
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'retry') api.nav.reload();
    if (a === 'back') api.nav.back();
  });
  return { name: 'error', el };
}

function crashedPage() {
  const el = mount(`
    <div class="pr-notice"><div class="pr-notice__box is-failed">
      ${Icons.svg('broken', 'pr-notice__icon')}
      <div class="pr-notice__title">La pestaña se cayó</div>
      <div class="pr-notice__text">El proceso de esta página se cerró de golpe: se quedó sin memoria o Chromium tuvo un error. Las demás pestañas siguen andando.</div>
      <div class="pr-notice__actions"><button class="op-btn op-btn--primary op-flashable" data-a="retry"><i data-icon="reload"></i> Recargar</button></div>
    </div></div>`, 'crashed');
  el.querySelector('[data-a]').addEventListener('click', () => api.nav.reload());
  return { name: 'crashed', el };
}

/* ══ Nueva pestaña ═══════════════════════════════════════════════════════════ */

function tileHTML(it, i, kind) {
  const h = hostOf(it.url);
  const icon = it.favicon
    ? `<img src="${esc(it.favicon)}" alt="" referrerpolicy="no-referrer" data-letter="${esc((h[0] || '?'))}">`
    : esc(h[0] || '?');
  return `<button class="pr-tile" style="--i:${i}" data-url="${esc(it.url)}" data-kind="${kind}"${it.id ? ` data-id="${esc(it.id)}"` : ''}>
      <span class="pr-tile__icon">${icon}</span>
      <span class="pr-tile__label">${esc(it.title || h || it.url)}</span>
      ${kind === 'bookmark' ? `<span class="op-iconbtn op-iconbtn--sm pr-tile__more" role="button" data-more>${Icons.svg('more')}</span>` : ''}
    </button>`;
}

function ntpPage() {
  const el = mount(`
    <div class="pr-ntp" id="ntp">
      <div class="pr-ntp__mark">${Icons.svg('prism')}</div>
      <label class="pr-fakebox" id="fakebox">${Icons.svg('search')}
        <input class="pr-fakebox__input" id="ntp-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="Buscá en ${esc(engineName())} o escribí una dirección" aria-label="Buscar o ir a una dirección"></label>
      <div id="ntp-tiles" style="display:contents"></div>
    </div>`, 'nueva');

  /* La barra grande es un campo de verdad, con sus propias sugerencias
     colgando debajo (antes le pasaba la posta a la omnibox de arriba, y
     Fran esperaba escribir acá). Ir desde acá navega esta misma pestaña. */
  const ntpInput = el.querySelector('#ntp-input');
  const sugg = attachSuggest(ntpInput, {
    anchor: el.querySelector('#fakebox'),
    onGo: async (value, { newTab }) => {
      if (newTab) {
        const res = await api.omni.suggest(value).catch(() => null);
        if (res?.classified?.url) api.tabs.create(res.classified.url);
        return;
      }
      ntpInput.blur();
      await api.tabs.navigate(S.activeId, value).catch(() => null);
    },
    onEscape: () => {
      if (ntpInput.value) { ntpInput.value = ''; return; }
      ntpInput.blur();
    },
  });
  cleanups.push(() => sugg.detach());

  async function fill() {
    const [bm, top] = await Promise.all([api.bookmarks.list().catch(() => []), api.history.top(12).catch(() => [])]);
    const marks = bm.slice(0, 8);
    const seen = new Set(marks.map((b) => hostOf(b.url)));
    const freq = top.filter((t) => !seen.has(hostOf(t.url))).slice(0, 8);
    const box = el.querySelector('#ntp-tiles');
    box.innerHTML = `
      ${marks.length ? `<div class="pr-tiles__label op-eyebrow">Favoritos</div><div class="pr-tiles">${marks.map((b, i) => tileHTML(b, i, 'bookmark')).join('')}</div>` : ''}
      ${freq.length ? `<div class="pr-tiles__label op-eyebrow">Los que más visitás</div><div class="pr-tiles">${freq.map((b, i) => tileHTML(b, i + marks.length, 'top')).join('')}</div>` : ''}
      ${!marks.length && !freq.length ? '<div class="pr-tiles__label op-meta" style="margin-top:28px">Tus favoritos y los sitios que más visitás van a aparecer acá.</div>' : ''}`;
    box.querySelectorAll('img[data-letter]').forEach((img) => img.addEventListener('error', () => { img.replaceWith(document.createTextNode(img.dataset.letter)); }, { once: true }));
  }
  fill();

  el.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    const tile = e.target.closest('.pr-tile');
    if (!tile) return;
    if (more) { e.stopPropagation(); tileMenu(more, tile); return; }
    if (e.ctrlKey) api.tabs.create(tile.dataset.url, { active: false });
    else api.tabs.navigate(S.activeId, tile.dataset.url);
  });
  el.addEventListener('auxclick', (e) => {
    const tile = e.target.closest('.pr-tile');
    if (tile && e.button === 1) api.tabs.create(tile.dataset.url, { active: false });
  });
  el.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.pr-tile');
    if (!tile) return;
    e.preventDefault();
    tileMenu(tile.querySelector('[data-more]') || tile, tile);
  });

  return { name: 'nueva', el, refresh: fill };
}

function tileMenu(anchor, tile) {
  const { url, id, kind } = tile.dataset;
  menu(anchor, [
    { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => api.tabs.create(url, { active: false }) },
    { label: 'Copiar la dirección', icon: 'link', onSelect: () => copy(url, { label: 'Dirección copiada' }) },
    ...(kind === 'bookmark' ? [
      { sep: true },
      { label: 'Editar', icon: 'edit', onSelect: () => editBookmark(id) },
      { label: 'Quitar de favoritos', icon: 'trash', danger: true, onSelect: () => api.bookmarks.remove(id) },
    ] : []),
  ], { align: 'end' });
}

/* ══ Historial ═══════════════════════════════════════════════════════════════ */

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  const s = d.toLocaleDateString(locale.tag, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const clock = (ts) => new Date(ts).toLocaleTimeString(locale.tag, { hour: '2-digit', minute: '2-digit', hour12: false });

function historyPage() {
  const el = mount(`
    <div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll" id="h-scroll"><div class="pr-view__col">
      <div class="pr-head">
        <div class="pr-head__text"><div class="pr-head__title">Historial</div>
          <div class="pr-head__sub">Lo que visitaste, del más nuevo al más viejo</div></div>
        <div class="pr-head__actions">
          <div class="op-inputwrap pr-search">${Icons.svg('search')}<input class="op-input" id="h-q" placeholder="Buscar en el historial" spellcheck="false"></div>
          <button class="op-btn op-btn--secondary op-flashable" id="h-clear"><i data-icon="trash"></i> Borrar…</button>
        </div>
      </div>
      <div class="pr-list" id="h-list"></div>
      <div id="h-more" style="height:1px"></div>
    </div></div>`, 'historial');

  const list = el.querySelector('#h-list');
  const scroller = el.querySelector('#h-scroll');
  const q = el.querySelector('#h-q');
  let items = [];
  let done = false;
  let loading = false;
  let query = '';

  function rowsHTML(from) {
    let html = '';
    let lastDay = from > 0 ? dayLabel(items[from - 1].t) : null;
    items.slice(from).forEach((v, j) => {
      const day = dayLabel(v.t);
      if (day !== lastDay) { html += `<div class="pr-day op-eyebrow">${esc(day)}</div>`; lastDay = day; }
      html += `<div class="pr-row" style="--i:${Math.min(j, 24)}" data-id="${v.id}" data-url="${esc(v.url)}">
          <span class="pr-row__time">${clock(v.t)}</span>
          <span class="pr-row__fav">${favIcon(v.url, v.favicon)}</span>
          <span class="pr-row__title">${esc(v.title || v.url)}</span>
          <span class="pr-row__host">${esc(hostOf(v.url))}</span>
          <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-more aria-label="Más">${Icons.svg('more')}</button></div>
        </div>`;
    });
    return html;
  }

  async function load(reset = false) {
    if (loading || (done && !reset)) return;
    loading = true;
    if (reset) { items = []; done = false; }
    const before = items.length ? items[items.length - 1].t : undefined;
    const page = await api.history.list({ query, before, limit: 150 }).catch(() => []);
    const from = items.length;
    items = items.concat(page);
    done = page.length < 150;
    if (reset) {
      list.classList.remove('is-settled');
      list.innerHTML = items.length ? rowsHTML(0) : `<div class="op-empty">${Icons.svg(query ? 'search' : 'history')}
          <div class="op-empty__title">${query ? 'Nada coincide' : 'El historial está vacío'}</div>
          <div class="op-empty__text">${query ? `No visitaste nada que diga «${esc(query)}».` : 'Lo que visites va a aparecer acá, ordenado por día.'}</div></div>`;
      scroller.scrollTop = 0;
      setTimeout(() => list.classList.add('is-settled'), 600);
    } else list.insertAdjacentHTML('beforeend', rowsHTML(from));
    wireFallbacks(list);
    loading = false;
  }

  let qTimer = null;
  q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { query = q.value.trim(); load(true); }, 160);
  });

  // Carga más al acercarse al final.
  const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) load(); }, { root: scroller, rootMargin: '400px' });
  io.observe(el.querySelector('#h-more'));
  cleanups.push(() => io.disconnect());

  async function removeRow(row) {
    const id = Number(row.dataset.id);
    await exit(row, { fallback: 200 });
    items = items.filter((v) => v.id !== id);
    await api.history.remove([id]).catch(() => null);
    // Un día que quedó sin filas no deja su título colgando.
    list.querySelectorAll('.pr-day').forEach((d) => { if (!d.nextElementSibling || d.nextElementSibling.classList.contains('pr-day')) exit(d, { fallback: 160 }); });
  }

  el.addEventListener('click', (e) => {
    const row = e.target.closest('.pr-row');
    if (!row) return;
    const more = e.target.closest('[data-more]');
    if (more) {
      e.stopPropagation();
      const url = row.dataset.url;
      menu(more, [
        { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => api.tabs.create(url, { active: false }) },
        { label: 'Copiar la dirección', icon: 'link', onSelect: () => copy(url, { label: 'Dirección copiada' }) },
        { label: 'Más de este sitio', icon: 'filter', onSelect: () => { q.value = hostOf(url); query = q.value; load(true); } },
        { sep: true },
        { label: 'Borrar del historial', icon: 'trash', danger: true, onSelect: () => removeRow(row) },
      ], { align: 'end' });
      return;
    }
    if (e.ctrlKey) api.tabs.create(row.dataset.url, { active: false });
    else api.tabs.navigate(S.activeId, row.dataset.url);
  });
  el.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.pr-row');
    if (row && e.button === 1) api.tabs.create(row.dataset.url, { active: false });
  });
  el.querySelector('#h-clear').addEventListener('click', () => clearDataModal());

  load(true);
  return { name: 'historial', el, refresh: () => load(true) };
}

/* ══ Favoritos ═══════════════════════════════════════════════════════════════ */

async function editBookmark(id) {
  const list = await api.bookmarks.list();
  const b = list.find((x) => x.id === id);
  if (!b) return;
  const body = document.createElement('div');
  body.className = 'op-col';
  body.style.gap = '14px';
  body.innerHTML = `
    <div class="op-field"><label class="op-field__label">Nombre</label><input class="op-input" id="b-title" spellcheck="false"></div>
    <div class="op-field"><label class="op-field__label">Dirección</label><input class="op-input op-input--mono" id="b-url" spellcheck="false"></div>`;
  body.querySelector('#b-title').value = b.title || '';
  body.querySelector('#b-url').value = b.url;
  const ok = await modal({
    title: 'Editar favorito',
    body,
    width: 460,
    actions: [{ label: 'Cancelar', value: false }, { label: 'Guardar', value: true, variant: 'primary', autofocus: true }],
  });
  if (!ok) return;
  await api.bookmarks.update(id, { title: body.querySelector('#b-title').value, url: body.querySelector('#b-url').value });
}

function bookmarksPage() {
  const el = mount(`
    <div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll"><div class="pr-view__col">
      <div class="pr-head">
        <div class="pr-head__text"><div class="pr-head__title">Favoritos</div><div class="pr-head__sub" id="b-sub"></div></div>
        <div class="pr-head__actions">
          <div class="op-inputwrap pr-search">${Icons.svg('search')}<input class="op-input" id="b-q" placeholder="Buscar en favoritos" spellcheck="false"></div>
        </div>
      </div>
      <div class="pr-list" id="b-list"></div>
    </div></div>`, 'favoritos');

  const list = el.querySelector('#b-list');
  const q = el.querySelector('#b-q');
  let all = [];
  let first = true;

  function paint() {
    const f = q.value.trim().toLowerCase();
    const shown = f ? all.filter((b) => `${b.title} ${b.url}`.toLowerCase().includes(f)) : all;
    el.querySelector('#b-sub').textContent = all.length ? plural(all.length, 'sitio guardado', 'sitios guardados') : 'Los sitios que guardás para volver';
    list.classList.toggle('is-settled', !first);
    list.innerHTML = shown.length ? shown.map((b, i) => `
      <div class="pr-row" style="--i:${Math.min(i, 24)}" data-id="${esc(b.id)}" data-url="${esc(b.url)}">
        <span class="pr-row__fav">${favIcon(b.url, b.favicon, 'star')}</span>
        <span class="pr-row__title">${esc(b.title || hostOf(b.url) || b.url)}</span>
        <span class="pr-row__host">${esc(b.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>
        <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-more aria-label="Más">${Icons.svg('more')}</button></div>
      </div>`).join('')
      : `<div class="op-empty">${Icons.svg(f ? 'search' : 'star')}
          <div class="op-empty__title">${f ? 'Nada coincide' : 'Todavía no guardaste favoritos'}</div>
          <div class="op-empty__text">${f ? '' : 'Tocá la estrella de la barra de direcciones, o apretá Ctrl+D en cualquier sitio.'}</div></div>`;
    wireFallbacks(list);
    first = false;
  }

  async function fill() {
    all = await api.bookmarks.list().catch(() => []);
    paint();
  }

  q.addEventListener('input', paint);
  el.addEventListener('click', (e) => {
    const row = e.target.closest('.pr-row');
    if (!row) return;
    const more = e.target.closest('[data-more]');
    const { id, url } = row.dataset;
    if (more) {
      e.stopPropagation();
      const i = all.findIndex((b) => b.id === id);
      menu(more, [
        { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => api.tabs.create(url, { active: false }) },
        { label: 'Copiar la dirección', icon: 'link', onSelect: () => copy(url, { label: 'Dirección copiada' }) },
        { label: 'Editar', icon: 'edit', onSelect: () => editBookmark(id) },
        { sep: true },
        { label: 'Subir', icon: 'chevronUp', disabled: i <= 0, onSelect: () => api.bookmarks.move(id, i - 1) },
        { label: 'Bajar', icon: 'chevronDown', disabled: i >= all.length - 1, onSelect: () => api.bookmarks.move(id, i + 1) },
        { sep: true },
        { label: 'Quitar de favoritos', icon: 'trash', danger: true, onSelect: async () => { await exit(row, { fallback: 200 }); api.bookmarks.remove(id); } },
      ], { align: 'end' });
      return;
    }
    if (e.ctrlKey) api.tabs.create(url, { active: false });
    else api.tabs.navigate(S.activeId, url);
  });
  el.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.pr-row');
    if (row && e.button === 1) api.tabs.create(row.dataset.url, { active: false });
  });

  fill();
  return { name: 'favoritos', el, refresh: fill };
}

/* ══ Descargas ═══════════════════════════════════════════════════════════════ */

export function dlIcon(d) {
  if (d.state === 'interrupted') return 'alert';
  const ext = (d.filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'gz', 'tar', 'xz'].includes(ext)) return 'zipFile';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'music';
  if (['exe', 'msi', 'appx', 'msix'].includes(ext)) return 'appFile';
  return 'file';
}

export function dlMeta(d) {
  const from = hostOf(d.url);
  if (d.state === 'progressing') {
    const got = fmtBytes(d.received);
    if (d.paused) return `En pausa · ${got}${d.total ? ` de ${fmtBytes(d.total)}` : ''}`;
    const left = d.total && d.speed > 0 ? ` · quedan ${fmtDur(((d.total - d.received) / d.speed) * 1000)}` : '';
    return `${got}${d.total ? ` de ${fmtBytes(d.total)}` : ''}${d.speed ? ` · ${fmtBytes(d.speed)}/s` : ''}${left}`;
  }
  if (d.state === 'cancelled') return `Cancelada · ${from}`;
  if (d.state === 'interrupted') return `Se cortó · ${from}`;
  if (d.missing) return 'Ya no está en la carpeta';
  return `${fmtBytes(d.total || d.received)} · ${from} · ${relTime(d.endedAt)}`;
}

function downloadsPage() {
  const el = mount(`
    <div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll"><div class="pr-view__col">
      <div class="pr-head">
        <div class="pr-head__text"><div class="pr-head__title">Descargas</div><div class="pr-head__sub op-truncate" id="d-sub"></div></div>
        <div class="pr-head__actions">
          <button class="op-btn op-btn--ghost op-flashable" id="d-folder"><i data-icon="folderOpen"></i> Abrir la carpeta</button>
          <button class="op-btn op-btn--secondary op-flashable" id="d-clear"><i data-icon="archive"></i> Limpiar la lista</button>
        </div>
      </div>
      <div class="pr-list" id="d-list"></div>
    </div></div>`, 'descargas');

  const list = el.querySelector('#d-list');
  let first = true;

  function paint() {
    el.querySelector('#d-sub').textContent = S.downloadsDir ? `Se guardan en ${S.downloadsDir}` : '';
    el.querySelector('#d-clear').disabled = !S.downloads.some((d) => d.state !== 'progressing');
    list.classList.toggle('is-settled', !first);
    list.innerHTML = S.downloads.length ? S.downloads.map((d, i) => `
      <div class="pr-dlrow${d.state === 'interrupted' ? ' is-failed' : ''}${d.state === 'cancelled' || d.missing ? ' is-muted' : ''}" style="animation-delay:${Math.min(i, 20) * 14}ms" data-id="${d.id}">
        <div class="pr-dlrow__icon">${Icons.svg(dlIcon(d))}</div>
        <div class="pr-dlrow__main">
          <div class="pr-dlrow__name op-copyable">${esc(d.filename)}</div>
          <div class="pr-dlrow__meta">${esc(dlMeta(d))}</div>
          ${d.state === 'progressing' ? `<div class="op-meter${d.total ? '' : ' op-meter--indeterminate'}"><div class="op-meter__fill" style="--op-pct:${d.total ? Math.round((d.received / d.total) * 100) : 0}%"></div></div>` : ''}
        </div>
        <div class="pr-dlrow__actions">
          ${d.state === 'progressing' ? `
            <button class="op-btn op-btn--ghost op-btn--sm" data-a="${d.paused ? 'resume' : 'pause'}"><i data-icon="${d.paused ? 'resume' : 'pause'}"></i> ${d.paused ? 'Seguir' : 'Pausar'}</button>
            <button class="op-btn op-btn--ghost op-btn--sm" data-a="cancel"><i data-icon="close"></i> Cancelar</button>`
            : d.state === 'completed' && !d.missing ? `
            <button class="op-btn op-btn--ghost op-btn--sm" data-a="open"><i data-icon="external"></i> Abrir</button>
            <button class="op-iconbtn op-iconbtn--sm" data-a="show" data-tip="Mostrar en la carpeta"><i data-icon="folder"></i></button>`
            : `<button class="op-btn op-btn--ghost op-btn--sm" data-a="retry"><i data-icon="retry"></i> Reintentar</button>`}
          ${d.state !== 'progressing' ? `<button class="op-iconbtn op-iconbtn--sm" data-a="remove" data-tip="Quitar de la lista"><i data-icon="close"></i></button>` : ''}
        </div>
      </div>`).join('')
      : `<div class="op-empty">${Icons.svg('download')}<div class="op-empty__title">Todavía no bajaste nada</div>
          <div class="op-empty__text">Lo que descargues va a aparecer acá, con su progreso.</div></div>`;
    Icons.mount(list);
    first = false;
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = Number(b.closest('.pr-dlrow')?.dataset.id);
    const a = b.dataset.a;
    if (a === 'remove') { await exit(b.closest('.pr-dlrow'), { fallback: 200 }); }
    await api.downloads[a](id).catch((err) => Toast.error('No se pudo', err.message));
  });
  el.querySelector('#d-folder').addEventListener('click', () => api.downloads.folder());
  el.querySelector('#d-clear').addEventListener('click', () => api.downloads.clear());

  paint();
  return { name: 'descargas', el, refresh: paint };
}

/* ══ Ajustes ═════════════════════════════════════════════════════════════════ */

const PERM_NAMES = {
  camera: 'Cámara', microphone: 'Micrófono', geolocation: 'Ubicación', notifications: 'Notificaciones',
  'clipboard-read': 'Portapapeles', midi: 'MIDI', midiSysex: 'MIDI (control)', 'idle-detection': 'Actividad',
  'window-management': 'Ventanas', openExternal: 'Abrir aplicaciones', 'storage-access': 'Cookies de terceros',
  'top-level-storage-access': 'Cookies de terceros',
};

let launchForceDark = null;
/* Un cambio hecho DESDE esta página vuelve como aviso de "ajustes cambiaron".
   Repintar con ese aviso cortaría la transición del switch que se acaba de
   tocar (el nodo nuevo nace ya encendido): durante un rato se ignora. */
let quietUntil = 0;

function kbdHTML(combo) {
  return combo.split(' · ').map((c) => c.split(/\+(?!$)/).map((k) => `<span class="op-kbd">${esc(k)}</span>`).join('')).join('<span class="pr-or">o</span>');
}

function settingsPage() {
  if (launchForceDark == null) launchForceDark = !!S.settings.forceDark;
  const el = mount('<div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll" id="set-scroll"><div class="pr-view__col" id="set-col"></div></div>', 'ajustes');
  const col = el.querySelector('#set-col');

  function paint() {
    const s = S.settings;
    const engines = S.info?.engines || { google: 'Google' };
    const perms = Object.entries(s.permissions || {});
    const keepScroll = el.querySelector('#set-scroll').scrollTop;
    col.innerHTML = `
      <div class="pr-head"><div class="pr-head__text"><div class="pr-head__title">Ajustes</div>
        <div class="pr-head__sub">Se guardan solos, apenas los cambiás</div></div></div>

      <section class="pr-set" style="--i:0">
        <div class="pr-set__head">${Icons.svg('search')}<span class="pr-set__title">Búsqueda</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Buscador</div>
          <div class="pr-opt__hint">El que usa la barra de direcciones cuando lo que escribís no es una dirección.</div></div>
          <div class="pr-opt__ctl"><div class="op-segmented" id="s-engine">${Object.entries(engines).map(([k, v]) => `<button class="op-segmented__opt${s.searchEngine === k ? ' is-active' : ''}" data-value="${k}">${esc(v)}</button>`).join('')}</div></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Sugerencias mientras escribís</div>
          <div class="pr-opt__hint">Le manda al buscador lo que vas tipeando para completar. Apagado, solo sugiere de tu historial y tus favoritos.</div></div>
          <div class="pr-opt__ctl"><button class="op-switch${s.remoteSuggest ? ' is-on' : ''}" data-toggle="remoteSuggest" aria-label="Sugerencias"></button></div></div>
      </section>

      <section class="pr-set" style="--i:1">
        <div class="pr-set__head">${Icons.svg('tabs')}<span class="pr-set__title">Al abrir Prism</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Empezar con</div>
          <div class="pr-opt__hint">Las pestañas de la última vez cargan recién cuando las mirás: abrir veinte no levanta veinte páginas.</div></div>
          <div class="pr-opt__ctl"><div class="op-segmented" id="s-startup">
            <button class="op-segmented__opt${s.startup === 'restore' ? ' is-active' : ''}" data-value="restore">Las pestañas de antes</button>
            <button class="op-segmented__opt${s.startup === 'newtab' ? ' is-active' : ''}" data-value="newtab">Una pestaña nueva</button></div></div></div>
      </section>

      <section class="pr-set" style="--i:2">
        <div class="pr-set__head">${Icons.svg('shield')}<span class="pr-set__title">Bloqueador</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Bloquear anuncios y rastreadores</div>
          <div class="pr-opt__hint">Con las listas de EasyList, EasyPrivacy y uBlock Origin. También saca los carteles de cookies.</div></div>
          <div class="pr-opt__ctl"><button class="op-switch${s.adblock ? ' is-on' : ''}" data-toggle="adblock" aria-label="Bloqueador"></button></div></div>
        ${(s.adblockAllow || []).length ? `<div class="pr-opt" style="min-height:0;padding-bottom:6px"><div class="pr-opt__text"><div class="pr-opt__label">Apagado en</div></div></div>` : ''}
        <div class="pr-chips">${(s.adblockAllow || []).map((h) => `<span class="pr-chip-x">${esc(h)}<button class="op-iconbtn" data-unallow="${esc(h)}" aria-label="Volver a bloquear">${Icons.svg('close')}</button></span>`).join('')}</div>
      </section>

      <section class="pr-set" style="--i:3">
        <div class="pr-set__head">${Icons.svg('moon')}<span class="pr-set__title">Páginas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Oscurecer todos los sitios</div>
          <div class="pr-opt__hint">Los sitios con modo oscuro propio ya lo usan solos. Esto oscurece también los que no lo tienen (a veces con colores raros).${s.forceDark !== launchForceDark ? ' <b style="color:var(--op-text-2);font-weight:500">Se aplica al reiniciar.</b>' : ''}</div></div>
          <div class="pr-opt__ctl">${s.forceDark !== launchForceDark ? '<button class="op-btn op-btn--secondary op-btn--sm" id="s-relaunch"><i data-icon="reload"></i> Reiniciar</button>' : ''}
            <button class="op-switch${s.forceDark ? ' is-on' : ''}" data-toggle="forceDark" aria-label="Oscurecer todo"></button></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Scrollbars finas en las páginas</div>
          <div class="pr-opt__hint">Las mismas de Prism, adentro de cada sitio (salvo que el sitio tenga las suyas). Vale para lo que abras después.</div></div>
          <div class="pr-opt__ctl"><button class="op-switch${s.pageScrollbars ? ' is-on' : ''}" data-toggle="pageScrollbars" aria-label="Scrollbars"></button></div></div>
      </section>

      <section class="pr-set" style="--i:4">
        <div class="pr-set__head">${Icons.svg('download')}<span class="pr-set__title">Descargas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Carpeta</div>
          <div class="pr-opt__path">${esc(S.downloadsDir || '')}</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-dldir"><i data-icon="folder"></i> Cambiar</button></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Preguntar dónde guardar cada archivo</div></div>
          <div class="pr-opt__ctl"><button class="op-switch${s.askDownload ? ' is-on' : ''}" data-toggle="askDownload" aria-label="Preguntar"></button></div></div>
      </section>

      <section class="pr-set" style="--i:5">
        <div class="pr-set__head">${Icons.svg('lock')}<span class="pr-set__title">Privacidad</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Borrar datos de navegación</div>
          <div class="pr-opt__hint">Historial, cookies y sesiones iniciadas, caché.</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-clear"><i data-icon="trash"></i> Borrar…</button></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Permisos de los sitios</div>
          <div class="pr-opt__hint">${perms.length ? 'Lo que ya contestaste. Olvidarlo hace que el sitio vuelva a preguntar.' : 'Ningún sitio pidió permisos todavía. Cuando uno pida la cámara, el micrófono o tu ubicación, Prism te pregunta.'}</div></div></div>
        ${perms.map(([origin, map]) => `<div class="pr-opt" style="min-height:44px">
            <div class="pr-opt__text"><div class="pr-opt__path" style="color:var(--op-text-2)">${esc(origin.replace(/^https:\/\//, ''))}</div>
              <div class="pr-opt__hint">${Object.entries(map).map(([k, v]) => `${esc(PERM_NAMES[k] || k)}: ${v === 'allow' ? 'permitido' : 'bloqueado'}`).join(' · ')}</div></div>
            <div class="pr-opt__ctl"><button class="op-btn op-btn--ghost op-btn--sm" data-forget="${esc(origin)}">Olvidar</button></div></div>`).join('')}
      </section>

      <section class="pr-set" style="--i:6">
        <div class="pr-set__head">${Icons.svg('keyboard')}<span class="pr-set__title">Atajos de teclado</span></div>
        <div class="pr-keys">${(S.info?.shortcuts || []).map(([what, combo]) => `<div>${esc(what)}</div><div>${kbdHTML(combo)}</div>`).join('')}</div>
      </section>

      <section class="pr-set" style="--i:7">
        <div class="pr-set__head">${Icons.svg('prism')}<span class="pr-set__title">Acerca de Prism</span></div>
        <dl class="pr-about">
          <dt>Versión</dt><dd>${esc(S.info?.version || '')}</dd>
          <dt>Chromium</dt><dd>${esc(S.info?.chrome || '')}</dd>
          <dt>Electron</dt><dd>${esc(S.info?.electron || '')}</dd>
          <dt>Datos</dt><dd>${esc(S.info?.dataDir || '')}</dd>
        </dl>
        ${updateRow()}
        <div class="pr-opt" style="min-height:0;padding-top:0"><div class="pr-opt__text"><div class="pr-opt__hint">Kidd Shady · Umbrovex Systems</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--ghost op-btn--sm" id="s-data"><i data-icon="folderOpen"></i> Abrir la carpeta de datos</button></div></div>
      </section>`;
    Icons.mount(col);
    el.querySelector('#set-scroll').scrollTop = keepScroll;
    col.querySelectorAll('.pr-set').forEach((sec, i) => { if (!first) sec.style.animation = 'none'; else sec.style.setProperty('--i', i); });
    first = false;

    bindSwitcher(col.querySelector('#s-engine'), (v) => save({ searchEngine: v }, false));
    bindSwitcher(col.querySelector('#s-startup'), (v) => save({ startup: v }, false));
  }

  let first = true;
  async function save(patch, repaint = true) {
    quietUntil = Date.now() + 600;
    S.settings = await api.settings.save(patch);
    if (repaint) paint();
  }

  col.addEventListener('click', async (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      tg.classList.toggle('is-on');
      const k = tg.dataset.toggle;
      // El switch se mueve ya; el repintado espera a que termine su transición.
      quietUntil = Date.now() + 600;
      S.settings = await api.settings.save({ [k]: !S.settings[k] });
      if (k === 'forceDark' || k === 'adblock') setTimeout(paint, 220);
      return;
    }
    const un = e.target.closest('[data-unallow]');
    if (un) {
      const h = un.dataset.unallow;
      await exit(un.closest('.pr-chip-x'), { fallback: 150 });
      return save({ adblockAllow: (S.settings.adblockAllow || []).filter((x) => x !== h) });
    }
    const fg = e.target.closest('[data-forget]');
    if (fg) { await api.permissions.revoke(fg.dataset.forget); S.settings = await api.settings.get(); return paint(); }
    const id = e.target.closest('button')?.id;
    if (id === 's-update') {
      const p = S.update?.phase;
      if (p === 'available') return api.update.download();
      if (p === 'ready') return api.update.install();
      return api.update.check();
    }
    if (id === 's-relaunch') return api.relaunch();
    if (id === 's-clear') return clearDataModal();
    if (id === 's-data') return api.openData();
    if (id === 's-dldir') {
      const dir = await api.data.chooseFolder(S.downloadsDir).catch(() => null);
      if (dir) { await save({ downloadDir: dir }, false); S.downloadsDir = await api.downloads.dir(); paint(); }
    }
  });

  paint();
  return { name: 'ajustes', el, refresh: paint };
}

/* La fila de actualizaciones de "Acerca de". */
function updateRow() {
  const u = S.update || {};
  const mb = u.bytes ? ` · ${fmtBytes(u.bytes)}` : '';
  const text = {
    unsupported: u.reason,
    idle: 'Se busca sola al abrir Prism y cada seis horas.',
    checking: 'Buscando…',
    current: `Estás en la última (${esc(u.current || '')}).`,
    available: `Hay una nueva: ${esc(u.name || u.version || '')}${mb}.`,
    downloading: `Descargando la ${esc(u.version || '')}… ${Math.round((u.pct || 0) * 100)} %`,
    ready: `La ${esc(u.version || '')} está lista para instalarse.`,
    error: esc(u.error || 'No se pudo buscar.'),
  }[u.phase] || '';
  const btn = {
    available: '<i data-icon="download"></i> Descargar',
    ready: '<i data-icon="reload"></i> Reiniciar y actualizar',
  }[u.phase] || '<i data-icon="reload"></i> Buscar';
  const disabled = ['unsupported', 'checking', 'downloading'].includes(u.phase);
  return `<div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Actualizaciones</div>
      <div class="pr-opt__hint">${text}</div></div>
      <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-update" ${disabled ? 'disabled' : ''}>${btn}</button></div></div>`;
}

/* ══ Borrar datos ════════════════════════════════════════════════════════════ */

export async function clearDataModal() {
  const body = document.createElement('div');
  body.className = 'op-col';
  body.style.gap = '12px';
  const opt = (k, label, hint, on) => `<label class="op-row" style="gap:12px;align-items:flex-start;cursor:default" data-k="${k}">
      <button class="op-check${on ? ' is-on' : ''}" style="margin-top:2px" aria-label="${esc(label)}">${Icons.svg('check')}</button>
      <span><span style="font-size:13px">${esc(label)}</span><br><span class="op-meta">${esc(hint)}</span></span></label>`;
  body.innerHTML = `
    <div class="op-row" style="justify-content:space-between;margin-bottom:6px"><span class="op-label">Del historial, borrar</span>
      <div class="op-segmented" id="cd-range">
        <button class="op-segmented__opt" data-value="hour">La última hora</button>
        <button class="op-segmented__opt" data-value="day">Hoy</button>
        <button class="op-segmented__opt is-active" data-value="all">Todo</button></div></div>
    ${opt('history', 'Historial', 'Las páginas que visitaste. Los favoritos no se tocan.', true)}
    ${opt('cookies', 'Cookies y datos de sitios', 'Te cierra la sesión en casi todos los sitios.', false)}
    ${opt('cache', 'Caché', 'Imágenes y archivos guardados para cargar más rápido.', true)}`;
  let range = 'all';
  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-k]');
    if (row) { e.preventDefault(); row.querySelector('.op-check').classList.toggle('is-on'); }
  });
  raf2(() => bindSwitcher(body.querySelector('#cd-range'), (v) => { range = v; }));

  const ok = await modal({
    title: 'Borrar datos de navegación',
    sub: 'Lo que borres no se puede recuperar.',
    body,
    width: 500,
    actions: [{ label: 'Cancelar', value: false }, { label: 'Borrar', value: true, variant: 'danger-solid' }],
  });
  if (!ok) return;
  const pick = (k) => body.querySelector(`[data-k="${k}"] .op-check`).classList.contains('is-on');
  const since = range === 'hour' ? Date.now() - 3_600_000 : range === 'day' ? new Date().setHours(0, 0, 0, 0) : 0;
  const done = await api.data.clear({ history: pick('history'), since, cookies: pick('cookies'), cache: pick('cache') }).catch((err) => { Toast.error('No se pudo borrar', err.message); return null; });
  if (done?.length) status?.(`Borrado: ${done.join(', ')}`);
}

let status = null;
export function setStatusFn(fn) { status = fn; }

/* ══ Registro ════════════════════════════════════════════════════════════════ */

const PAGES = {
  nueva: ntpPage,
  historial: historyPage,
  favoritos: bookmarksPage,
  descargas: downloadsPage,
  ajustes: settingsPage,
};

export function init() {
  on('tabs', render);
  on('library', () => { if (['nueva', 'historial', 'favoritos'].includes(current?.name)) current.refresh?.(); });
  on('downloads', () => { if (current?.name === 'descargas') current.refresh?.(); });
  on('settings', () => { if (current?.name === 'ajustes' && Date.now() > quietUntil) current.refresh?.(); });
  on('update', () => { if (current?.name === 'ajustes') current.refresh?.(); });
  render();
}

export { confirm };
