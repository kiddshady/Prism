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
import { esc } from './ui.js';
import { popover } from './layers.js';
import { attachSuggest, splitUrl } from './suggest.js';

let box;
let input;
let display;
let site;
let star;
let zoomChip;
let sugg;

let edited = false;        // hay texto de la persona que no es la dirección de la pestaña
let shownFor = null;       // id de la pestaña cuyo valor está mostrando

/* ── Direcciones ─────────────────────────────────────────────────────────── */

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
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
  if (switched) { edited = false; sugg.close(); }
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
  if (initial != null) sugg.typeText(initial);
  else input.select();
}

function onFocus() {
  box.classList.add('is-focused');
  justFocused = true;
  setTimeout(() => { if (document.activeElement === input && !edited) input.select(); }, 0);
}

function onBlur() {
  box.classList.remove('is-focused');
  if (edited) {
    edited = false;
    input.value = fullText(activeTab());
  }
  paintSite(activeTab());
}

/* ── Escribir, ir, soltar ────────────────────────────────────────────────── */

function onType() {
  edited = true;
  // Mientras se escribe, el candado no dice nada de lo que va a pasar: lupa.
  if (site.dataset.key !== 'search') { site.dataset.key = 'search'; site.innerHTML = Icons.svg('search'); site.classList.remove('is-insecure'); }
}

async function onGo(value, { newTab }) {
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

/* Escape, ya sin lista: primero vuelve a la dirección, después suelta el foco
   a la página. */
function onEscape() {
  const url = fullText(activeTab());
  if (edited && input.value !== url) { edited = false; input.value = url; input.select(); paintSite(activeTab()); return; }
  input.blur();
  api.page.focus();
}

export function closeDropdown() { sugg?.close(); }

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

  sugg = attachSuggest(input, { anchor: box, onType, onGo, onEscape });
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  // El mouseup del click que dio el foco deseleccionaría lo recién seleccionado.
  input.addEventListener('mouseup', (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });

  star.addEventListener('click', async () => {
    await api.bookmarks.toggle({}).catch(() => null);
  });
  zoomChip.addEventListener('click', () => api.page.zoom('reset'));
  site.addEventListener('click', siteInfo);

  on('tabs', sync);
  on('settings', () => sugg.refresh());
  sync();
}

export const isFocused = () => document.activeElement === input;
