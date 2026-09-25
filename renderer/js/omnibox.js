/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la omnibox
   Dirección y búsqueda en un solo campo. Lo que decide qué es cada cosa vive
   en el proceso principal (src/omni.cjs, con tests); acá está la conducta:

   · Sin foco muestra la dirección PARTIDA: el host claro y el resto
     atenuado. Es lo que permite ver de un vistazo en qué sitio estás.
   · Con foco, la primera vez se selecciona todo: tipear reemplaza.
   · Autocompleta en línea el host de un sitio que ya visitaste, con lo
     agregado seleccionado: seguir tipeando lo pisa, Enter lo acepta.
   · La primera fila de sugerencias es SIEMPRE lo que va a hacer Enter.
   · Escape en tres tiempos: cierra la lista → vuelve a la dirección → suelta
     el foco a la página.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab } from './state.js';
import { Icons } from './icons.js';
import { exit } from './motion.js';
import { esc } from './ui.js';
import * as Freeze from './freeze.js';
import { popover } from './layers.js';

let box;
let input;
let display;
let site;
let star;
let zoomChip;

let edited = false;        // hay texto de la persona que no es la dirección de la pestaña
let typed = '';            // lo tipeado, sin el autocompletado
let rows = [];
let sel = 0;
let local = { items: [], inline: null, classified: null };
let remote = [];
let seq = 0;
let remoteTimer = null;
let dd = null;             // { el, release }
let opening = null;
let shownFor = null;       // id de la pestaña cuyo valor está mostrando

/* ── Direcciones ─────────────────────────────────────────────────────────── */

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

export function splitUrl(url = '') {
  if (/^prism:\/\//i.test(url)) return { scheme: 'prism://', host: url.slice(8), rest: '', kind: 'internal' };
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return { scheme: u.protocol === 'http:' ? 'http://' : '', host: u.host, rest: safeDecode(rest), kind: u.protocol.slice(0, -1) };
    }
    if (u.protocol === 'file:') return { scheme: 'file:///', host: '', rest: safeDecode(u.pathname.replace(/^\//, '')), kind: 'file' };
    return { scheme: '', host: '', rest: url, kind: 'other' };
  } catch {
    return { scheme: '', host: '', rest: url, kind: 'other' };
  }
}

/** Lo que se ve en el campo con foco: la dirección entera, legible. */
function fullText(t) {
  if (!t || t.internal === 'nueva') return '';
  return safeDecode(t.url || '');
}

function paintDisplay(t) {
  if (!t || t.internal === 'nueva') { display.innerHTML = ''; return; }
  const p = splitUrl(t.url);
  display.innerHTML = p.host
    ? `${p.scheme ? `<span class="is-scheme">${esc(p.scheme)}</span>` : ''}<b>${esc(p.host)}</b>${esc(p.rest)}`
    : `${p.scheme ? `<span class="is-scheme">${esc(p.scheme)}</span>` : ''}${esc(p.rest)}`;
}

function paintSite(t) {
  let key = 'globe';
  let tip = '';
  if (!t || t.internal) { key = 'prism'; tip = 'Página de Prism'; }
  else if (t.error || t.crashed) { key = 'alert'; tip = 'No se pudo cargar'; }
  else {
    const kind = splitUrl(t.url).kind;
    if (kind === 'https') { key = 'lock'; tip = 'Conexión segura'; }
    else if (kind === 'http') { key = 'alert'; tip = 'Conexión no segura'; }
    else if (kind === 'file') { key = 'file'; tip = 'Archivo de tu compu'; }
  }
  if (site.dataset.key !== key) { site.dataset.key = key; site.innerHTML = Icons.svg(key); }
  site.classList.toggle('is-insecure', key === 'alert');
  site.dataset.tip = tip;
}

/** Sincroniza la barra con la pestaña activa (si la persona no está escribiendo). */
function sync() {
  const t = activeTab();
  const switched = shownFor !== t?.id;
  if (switched) { edited = false; closeDropdown(); }
  shownFor = t?.id ?? null;

  if (!edited) {
    const v = fullText(t);
    if (input.value !== v) input.value = v;
  }
  paintDisplay(t);
  paintSite(t);

  const canStar = !!t && !t.internal && !t.error && !t.crashed && /^(https?|file):/i.test(t.url || '');
  star.hidden = !canStar;
  star.classList.toggle('is-on', !!t?.bookmarked);
  star.dataset.tip = t?.bookmarked ? 'Quitar de favoritos' : 'Agregar a favoritos';

  const z = Math.round((t?.zoom || 1) * 100);
  zoomChip.hidden = !t || !!t.internal || z === 100;
  zoomChip.textContent = `${z} %`;

  if (S.focusOmniOnNext && t?.internal === 'nueva') {
    S.focusOmniOnNext = false;
    focus();
  }
}

/* ── Foco ────────────────────────────────────────────────────────────────── */

let justFocused = false;

export function focus(initial = null) {
  input.focus();
  if (initial != null) {
    input.value = initial;
    edited = true;
    onType({ inputType: 'insertText' });
  } else {
    input.select();
  }
}

function onFocus() {
  box.classList.add('is-focused');
  justFocused = true;
  setTimeout(() => { if (document.activeElement === input && !edited) input.select(); }, 0);
}

function onBlur() {
  box.classList.remove('is-focused');
  closeDropdown();
  if (edited) {
    edited = false;
    input.value = fullText(activeTab());
  }
  paintSite(activeTab());
}

/* ── Sugerencias ─────────────────────────────────────────────────────────── */

const engineName = () => S.info?.engines?.[S.settings.searchEngine] || 'Google';

function buildRows() {
  const text = input.value.trim();
  if (!text) { rows = []; return; }
  const out = [];
  const c = local.classified;
  if (c?.type === 'url') {
    const p = splitUrl(c.url);
    out.push({ kind: 'go', icon: 'globe', main: (p.host || '') + p.rest || c.url, sub: 'Ir al sitio', value: text, url: c.url });
  } else {
    out.push({ kind: 'search', icon: 'search', main: text, sub: `Buscar en ${engineName()}`, value: text });
  }
  const seen = new Set([c?.url]);
  for (const it of local.items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    const p = splitUrl(it.url);
    out.push({
      kind: it.kind,
      icon: it.kind === 'bookmark' ? 'star' : 'history',
      favicon: it.favicon,
      main: it.title || (p.host + p.rest),
      sub: p.host ? p.host + p.rest : it.url,
      value: it.url,
      url: it.url,
    });
    if (out.length >= 6) break;
  }
  const typedLow = typed.trim().toLowerCase();
  for (const r of remote) {
    if (r.toLowerCase() === typedLow || out.some((o) => o.kind === 'remote' && o.value === r)) continue;
    out.push({ kind: 'remote', icon: 'search', main: r, sub: '', value: r });
    if (out.length >= 10) break;
  }
  rows = out;
  sel = Math.min(sel, rows.length - 1);
}

function highlight(text, q) {
  const s = String(text);
  const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0 || !q) return esc(s);
  return `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
}

function rowHTML(r, i) {
  const icon = r.favicon
    ? `<img src="${esc(r.favicon)}" alt="" referrerpolicy="no-referrer" data-fallback="${r.icon}">`
    : Icons.svg(r.icon);
  const q = typed.trim();
  return `<button class="pr-sugg${i === sel ? ' is-active' : ''}" data-i="${i}" tabindex="-1">
      <span class="pr-sugg__icon">${icon}</span>
      <span class="pr-sugg__main">${r.kind === 'remote' ? highlightRest(r.main, q) : highlight(r.main, q)}</span>
      ${r.sub ? `<span class="pr-sugg__sub">${highlight(r.sub, r.kind === 'search' || r.kind === 'go' ? '' : q)}</span>` : ''}
    </button>${i === 0 && rows.length > 1 ? '<div class="pr-suggest__sep"></div>' : ''}`;
}

/* En una sugerencia remota lo que aporta es lo que FALTA de lo tipeado: se
   resalta el resto, no el prefijo que ya escribiste (como Google). */
function highlightRest(text, q) {
  const s = String(text);
  if (q && s.toLowerCase().startsWith(q.toLowerCase())) return `${esc(s.slice(0, q.length))}<mark>${esc(s.slice(q.length))}</mark>`;
  return esc(s);
}

function paintDropdown() {
  if (!dd) return;
  dd.el.innerHTML = rows.map(rowHTML).join('');
  dd.el.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => { img.outerHTML = Icons.svg(img.dataset.fallback); }, { once: true });
  });
  place();
}

function place() {
  if (!dd) return;
  const r = box.getBoundingClientRect();
  dd.el.style.left = `${Math.round(r.left)}px`;
  dd.el.style.top = `${Math.round(r.bottom + 6)}px`;
  dd.el.style.width = `${Math.round(r.width)}px`;
}

async function openDropdown() {
  if (dd || opening) { paintDropdown(); return; }
  opening = (async () => {
    const release = await Freeze.hold();
    // Mientras se sacaba la foto pudo haberse ido el foco o vaciado el campo.
    if (document.activeElement !== input || !rows.length) { release(); return; }
    const el = document.createElement('div');
    el.className = 'pr-suggest';
    el.setAttribute('role', 'listbox');
    // Tocar la lista no le saca el foco al campo.
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.pr-sugg');
      if (b) go(Number(b.dataset.i), { newTab: e.ctrlKey || e.button === 1 });
    });
    el.addEventListener('pointermove', (e) => {
      const b = e.target.closest('.pr-sugg');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (i === sel) return;
      sel = i;
      el.querySelectorAll('.pr-sugg').forEach((x, j) => x.classList.toggle('is-active', j === sel));
    });
    document.getElementById('op-layer').appendChild(el);
    dd = { el, release };
    paintDropdown();
  })();
  await opening;
  opening = null;
}

export function closeDropdown() {
  clearTimeout(remoteTimer);
  seq++;
  if (!dd) return;
  const { el, release } = dd;
  dd = null;
  exit(el, { fallback: 140 });
  Freeze.releaseAfter(release, 120);
}

async function onType(e) {
  typed = input.value;
  edited = true;
  // Mientras se escribe, el candado no dice nada de lo que va a pasar: lupa.
  if (site.dataset.key !== 'search') { site.dataset.key = 'search'; site.innerHTML = Icons.svg('search'); site.classList.remove('is-insecure'); }
  sel = 0;
  const q = typed;
  if (!q.trim()) { rows = []; local = { items: [], inline: null, classified: null }; remote = []; closeDropdown(); return; }

  const my = ++seq;
  const r = await api.omni.suggest(q).catch(() => null);
  if (my !== seq || !r) return;
  local = r;

  // Autocompletar en línea: solo tipeando hacia adelante y con el cursor al final.
  const forward = e?.inputType === 'insertText' || e?.inputType === 'insertFromPaste';
  const atEnd = input.selectionStart === input.value.length;
  if (forward && atEnd && r.inline && r.inline.toLowerCase().startsWith(q.toLowerCase()) && input.value === q) {
    input.value = q + r.inline.slice(q.length);
    input.setSelectionRange(q.length, input.value.length);
    const again = await api.omni.suggest(input.value).catch(() => null);
    if (my !== seq) return;
    if (again) local = { ...again, items: r.items };
  }

  buildRows();
  if (rows.length) openDropdown(); else closeDropdown();

  clearTimeout(remoteTimer);
  if (S.settings.remoteSuggest && !/^[a-z]+:\/\//i.test(q)) {
    remoteTimer = setTimeout(async () => {
      const list = await api.omni.remote(q.trim()).catch(() => []);
      if (my !== seq) return;
      remote = list;
      buildRows();
      if (dd) paintDropdown();
    }, 120);
  } else remote = [];
}

function move(dir) {
  if (!rows.length) return;
  sel = (sel + dir + rows.length) % rows.length;
  const r = rows[sel];
  // Moverse por la lista muestra en el campo a dónde lleva cada fila.
  if (sel === 0) input.value = typed + (local.inline && local.inline.toLowerCase().startsWith(typed.toLowerCase()) ? local.inline.slice(typed.length) : '');
  else input.value = r.kind === 'remote' || r.kind === 'search' ? r.value : safeDecode(r.url || r.value);
  input.setSelectionRange(input.value.length, input.value.length);
  paintDropdown();
}

async function go(i = sel, { newTab = false } = {}) {
  const r = rows[i];
  const value = i === 0 || !r ? input.value.trim() : (r.url || r.value);
  if (!value) return;
  closeDropdown();
  edited = false;
  if (newTab) {
    const res = await api.omni.suggest(value).catch(() => null);
    if (res?.classified?.url) api.tabs.create(res.classified.url);
    input.value = fullText(activeTab());
    return;
  }
  input.blur();
  await api.tabs.navigate(S.activeId, value).catch(() => null);
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!dd && input.value.trim()) onType({}); else move(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
  if (e.key === 'Enter') { e.preventDefault(); go(sel, { newTab: e.altKey }); return; }
  if (e.key === 'Tab' && !e.shiftKey && input.selectionEnd > input.selectionStart && input.selectionEnd === input.value.length && dd) {
    // Tab acepta el autocompletado en vez de saltar de campo.
    e.preventDefault();
    input.setSelectionRange(input.value.length, input.value.length);
    typed = input.value;
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (dd) {
      closeDropdown();
      if (input.selectionEnd > input.selectionStart && input.selectionEnd === input.value.length) input.value = typed;
      return;
    }
    const url = fullText(activeTab());
    if (edited && input.value !== url) { edited = false; input.value = url; input.select(); paintSite(activeTab()); return; }
    input.blur();
    api.page.focus();
  }
}

/* ── El sitio: seguridad y permisos ──────────────────────────────────────── */

const PERM_LABEL = {
  camera: ['camera', 'Cámara'],
  microphone: ['mic', 'Micrófono'],
  geolocation: ['location', 'Ubicación'],
  notifications: ['bell', 'Notificaciones'],
  'clipboard-read': ['copy', 'Portapapeles'],
  midi: ['music', 'MIDI'],
  midiSysex: ['music', 'MIDI (control)'],
  'idle-detection': ['clock', 'Detección de actividad'],
  'window-management': ['window', 'Ventanas'],
  openExternal: ['external', 'Abrir aplicaciones'],
  'storage-access': ['key', 'Cookies de terceros'],
  'top-level-storage-access': ['key', 'Cookies de terceros'],
};

function siteInfo() {
  const t = activeTab();
  if (!t || t.internal) return;
  const p = splitUrl(t.url);
  let origin = '';
  try { origin = new URL(t.url).origin; } catch { /* no es http */ }
  popover(site, (el, ctl) => {
    const perms = Object.entries(S.settings.permissions?.[origin] || {});
    const secure = p.kind === 'https';
    el.innerHTML = `
      <div class="pr-pop__head">
        <div class="op-grow">
          <div class="pr-pop__title op-truncate op-copyable">${esc(p.host || t.url)}</div>
          <div class="pr-pop__sub">${secure ? 'Conexión segura: lo que mandás viaja cifrado.' : p.kind === 'http' ? 'Conexión no segura: no escribas contraseñas acá.' : p.kind === 'file' ? 'Un archivo de tu compu.' : ''}</div>
        </div>
        <i data-icon="${secure ? 'lock' : p.kind === 'http' ? 'alert' : 'file'}"></i>
      </div>
      <div class="pr-pop__body">
        <div class="op-eyebrow" style="padding:10px 8px 6px">Permisos</div>
        ${perms.length ? perms.map(([k, v]) => {
          const [icon, label] = PERM_LABEL[k] || ['key', k];
          return `<div class="pr-dlrow" style="padding:6px 8px">
              <i data-icon="${icon}"></i>
              <div class="pr-dlrow__main"><div class="pr-dlrow__name">${esc(label)}</div>
                <div class="pr-dlrow__meta">${v === 'allow' ? 'Permitido' : 'Bloqueado'}</div></div>
              <button class="op-btn op-btn--ghost op-btn--sm" data-revoke="${esc(k)}">Olvidar</button>
            </div>`;
        }).join('') : '<div class="pr-pop__empty" style="padding:10px 8px 16px;text-align:left">Este sitio no pidió nada todavía.</div>'}
      </div>`;
    el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      await api.permissions.revoke(origin, b.dataset.revoke);
      S.settings = await api.settings.get();
      ctl.refresh();
    }));
  }, { width: 320, align: 'start' });
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

export function init() {
  box = document.getElementById('omni');
  input = document.getElementById('omni-input');
  display = document.getElementById('omni-display');
  site = document.getElementById('omni-site');
  star = document.getElementById('omni-star');
  zoomChip = document.getElementById('omni-zoom');

  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  input.addEventListener('input', onType);
  input.addEventListener('keydown', onKey);
  // El mouseup del click que dio el foco deseleccionaría lo recién seleccionado.
  input.addEventListener('mouseup', (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });

  star.addEventListener('click', async () => {
    await api.bookmarks.toggle({}).catch(() => null);
  });
  zoomChip.addEventListener('click', () => api.page.zoom('reset'));
  site.addEventListener('click', siteInfo);

  window.addEventListener('resize', place);
  on('tabs', sync);
  on('settings', () => { if (dd) { buildRows(); paintDropdown(); } });
  sync();
}

export const isFocused = () => document.activeElement === input;
