/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — sugerencias
   El motor de las sugerencias, separado de la omnibox para que lo use
   cualquier campo donde se escribe una dirección: la barra de arriba y la
   barra grande de la nueva pestaña. Cada campo se engancha con
   attachSuggest() y decide solo lo que es suyo (qué hacer al ir, qué hacer
   con Escape cuando ya no hay lista).

   La conducta es la misma en los dos:
   · Autocompleta en línea el host de un sitio que ya visitaste, con lo
     agregado seleccionado: seguir tipeando lo pisa, Enter lo acepta.
   · La primera fila es SIEMPRE lo que va a hacer Enter.
   · Flechas recorren la lista y muestran en el campo a dónde lleva cada fila.
   · Tab acepta el autocompletado; Escape cierra la lista primero.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S } from './state.js';
import { Icons } from './icons.js';
import { exit } from './motion.js';
import { esc } from './ui.js';
import * as Freeze from './freeze.js';

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

/** Una dirección partida para mostrar: esquema, host y el resto. */
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

const engineName = () => S.info?.engines?.[S.settings.searchEngine] || 'Google';

function highlight(text, q) {
  const s = String(text);
  const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0 || !q) return esc(s);
  return `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
}

/* En una sugerencia remota lo que aporta es lo que FALTA de lo tipeado: se
   resalta el resto, no el prefijo que ya escribiste (como Google). */
function highlightRest(text, q) {
  const s = String(text);
  if (q && s.toLowerCase().startsWith(q.toLowerCase())) return `${esc(s.slice(0, q.length))}<mark>${esc(s.slice(q.length))}</mark>`;
  return esc(s);
}

/**
 * Engancha las sugerencias a un campo.
 *   anchor        el elemento bajo el que cuelga la lista (y del que toma el ancho)
 *   onType()      avisa que la persona escribió algo
 *   onGo(value, { newTab })   ir: `value` es texto crudo (lo clasifica el proceso principal)
 *   onEscape()    Escape cuando ya no hay lista abierta
 */
export function attachSuggest(input, { anchor, onType, onGo, onEscape } = {}) {
  let typed = '';
  let rows = [];
  let sel = 0;
  let local = { items: [], inline: null, classified: null };
  let remote = [];
  let seq = 0;
  let remoteTimer = null;
  let dd = null;             // { el, release }
  let opening = null;

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
    sel = Math.max(0, Math.min(sel, rows.length - 1));
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

  function place() {
    if (!dd) return;
    const r = anchor.getBoundingClientRect();
    dd.el.style.left = `${Math.round(r.left)}px`;
    dd.el.style.top = `${Math.round(r.bottom + 6)}px`;
    dd.el.style.width = `${Math.round(r.width)}px`;
  }

  function paint() {
    if (!dd) return;
    dd.el.innerHTML = rows.map(rowHTML).join('');
    dd.el.querySelectorAll('img[data-fallback]').forEach((img) => {
      img.addEventListener('error', () => { img.outerHTML = Icons.svg(img.dataset.fallback); }, { once: true });
    });
    place();
  }

  async function open() {
    if (dd || opening) { paint(); return; }
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
      paint();
    })();
    await opening;
    opening = null;
  }

  function close() {
    clearTimeout(remoteTimer);
    seq++;
    if (!dd) return;
    const { el, release } = dd;
    dd = null;
    exit(el, { fallback: 140 });
    Freeze.releaseAfter(release, 120);
  }

  async function type(e) {
    typed = input.value;
    onType?.();
    sel = 0;
    const q = typed;
    if (!q.trim()) { rows = []; local = { items: [], inline: null, classified: null }; remote = []; close(); return; }

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
    if (rows.length) open(); else close();

    clearTimeout(remoteTimer);
    if (S.settings.remoteSuggest && !/^[a-z]+:\/\//i.test(q)) {
      remoteTimer = setTimeout(async () => {
        const list = await api.omni.remote(q.trim()).catch(() => []);
        if (my !== seq) return;
        remote = list;
        buildRows();
        if (dd) paint();
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
    paint();
  }

  function go(i = sel, { newTab = false } = {}) {
    const r = rows[i];
    const value = i === 0 || !r ? input.value.trim() : (r.url || r.value);
    if (!value) return;
    close();
    onGo?.(value, { newTab });
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!dd && input.value.trim()) type({}); else move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); go(sel, { newTab: e.altKey }); return; }
    if (e.key === 'Tab' && !e.shiftKey && dd && input.selectionEnd > input.selectionStart && input.selectionEnd === input.value.length) {
      // Tab acepta el autocompletado en vez de saltar de campo.
      e.preventDefault();
      input.setSelectionRange(input.value.length, input.value.length);
      typed = input.value;
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (dd) {
        close();
        if (input.selectionEnd > input.selectionStart && input.selectionEnd === input.value.length) input.value = typed;
        return;
      }
      onEscape?.();
    }
  }

  const onInput = (e) => type(e);
  const onBlur = () => close();
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
  window.addEventListener('resize', place);

  return {
    close,
    /** Escribe algo como si lo hubiera tipeado la persona (y sugiere). */
    typeText(text) { input.value = text; type({ inputType: 'insertText' }); },
    refresh() { if (dd) { buildRows(); paint(); } },
    get isOpen() { return !!dd; },
    detach() {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', place);
    },
  };
}
