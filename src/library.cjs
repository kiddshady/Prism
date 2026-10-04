'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — biblioteca: historial y favoritos
   Todo en memoria, espejado a dos JSON legibles. Se escribe con debounce
   porque navegar genera una ráfaga de eventos (commit, título, favicon…) y
   cada uno es una escritura si no se agrupan. Con tope: una pestaña con un
   reloj en el título cambia cada segundo, y un debounce sin tope no
   escribía nunca mientras estuviera abierta.

   El historial guarda VISITAS (lo que muestra la página de historial, en
   orden) y de ahí se deriva al vuelo el agregado por URL (lo que usa la
   omnibox para rankear). Guardar solo el agregado perdería el "cuándo"; solo
   las visitas obligaría a recorrer miles para cada tecla — por eso el índice
   se arma una vez en memoria y se mantiene a mano.
   ═══════════════════════════════════════════════════════════════════════════ */

const { bareHost } = require('./omni.cjs');

const MAX_VISITS = 12000;
const SAVE_DELAY = 1500;
/** Lo más que espera una visita nueva para llegar al disco. */
const SAVE_MAX_WAIT = 5000;

/* Qué NO entra al historial: las páginas propias, lo efímero y lo que no es
   una dirección que alguien quiera volver a abrir. */
function recordable(url) {
  return /^https?:\/\//i.test(String(url || '')) || /^file:\/\//i.test(String(url || ''));
}

function createLibrary({ historyDoc, bookmarksDoc, now = () => Date.now(), saveDelay = SAVE_DELAY, maxWait = SAVE_MAX_WAIT } = {}) {
  let visits = [];          // [{ id, url, title, t }] — más nueva al final
  let favicons = {};        // host → url del favicon
  let bookmarks = [];       // [{ id, url, title, favicon, createdAt }]
  let seq = 0;

  /* url → { url, title, visits, last } */
  const index = new Map();

  function indexVisit(v) {
    const e = index.get(v.url);
    if (e) {
      e.visits += 1;
      if (v.t >= e.last) { e.last = v.t; if (v.title) e.title = v.title; }
    } else {
      index.set(v.url, { url: v.url, title: v.title || '', visits: 1, last: v.t });
    }
  }

  function rebuildIndex() {
    index.clear();
    for (const v of visits) indexVisit(v);
  }

  /* ── Persistencia ──────────────────────────────────────────────────────── */
  const timers = {};
  const due = {};           // para cuándo se prometió escribir lo pendiente
  /* Un archivo que existe pero no se pudo leer (tomado, sin permiso) no se
     escribe en toda la corrida: arrancó vacío, y guardar lo pisaría. */
  const unread = new Set();
  const docOf = (which) => (which === 'history' ? historyDoc : bookmarksDoc);
  const dataOf = (which) => (which === 'history' ? { visits, favicons, seq } : { bookmarks });

  /** `lazy`: un cambio que puede esperar (el título de una visita que ya está)
      corre la escritura pero no la apura. Si no, un reloj en el título
      reescribiría el historial entero cada pocos segundos todo el día. */
  function schedule(which, { lazy = false } = {}) {
    clearTimeout(timers[which]);
    if (!lazy && !due[which]) due[which] = Date.now() + maxWait;
    const wait = due[which] ? Math.max(0, Math.min(saveDelay, due[which] - Date.now())) : saveDelay;
    timers[which] = setTimeout(() => flush(which), wait);
  }

  function take(which) {
    clearTimeout(timers[which]);
    timers[which] = null;
    due[which] = null;
    return docOf(which) && !unread.has(which);
  }

  async function flush(which) {
    if (!take(which)) return;
    try {
      await docOf(which).write(dataOf(which));
    } catch (err) {
      console.error(`[library] no se pudo guardar ${which}:`, err.message);
    }
  }

  /** Lo que está pendiente se escribe YA. Se llama al cerrar la app. */
  async function flushAll() {
    const pend = Object.keys(timers).filter((k) => timers[k]);
    await Promise.all(pend.map(flush));
  }

  /** Igual, sin soltar el hilo: Windows se está apagando (ver store.cjs). */
  function flushAllSync() {
    for (const which of Object.keys(timers).filter((k) => timers[k])) {
      if (!take(which)) continue;
      try { docOf(which).writeSync(dataOf(which)); } catch (err) { console.error(`[library] no se pudo guardar ${which}:`, err.message); }
    }
  }

  async function read(which) {
    try {
      return (docOf(which) && await docOf(which).read()) || {};
    } catch (err) {
      unread.add(which);
      console.error(`[library] no se pudo leer ${which}, no se va a escribir:`, err.message);
      return {};
    }
  }

  async function load() {
    const h = await read('history');
    visits = Array.isArray(h.visits) ? h.visits.filter((v) => v && recordable(v.url)) : [];
    favicons = h.favicons && typeof h.favicons === 'object' ? h.favicons : {};
    seq = Number(h.seq) || visits.reduce((m, v) => Math.max(m, Number(v.id) || 0), 0);
    rebuildIndex();

    const b = await read('bookmarks');
    bookmarks = Array.isArray(b.bookmarks) ? b.bookmarks.filter((x) => x && x.url) : [];
  }

  /* ── Historial ─────────────────────────────────────────────────────────── */

  /**
   * Registra una visita. Si la última visita es a la MISMA url y hace menos de
   * un minuto (un reload, un hash que cambia, un redirect de vuelta), se
   * actualiza en vez de duplicar: el historial no es un log de eventos.
   */
  function visit(url, title = '') {
    if (!recordable(url)) return null;
    const t = now();
    /* Se mira el último minuto entero y no solo la última visita: con varias
       pestañas cargando a la vez, las visitas de una se intercalan con las de
       otra, y un sitio que redirige o reescribe su URL (YouTube) quedaba tres
       veces seguidas en el historial. */
    for (let i = visits.length - 1; i >= 0 && t - visits[i].t < 60_000; i--) {
      const v = visits[i];
      if (v.url !== url) continue;
      v.t = t;
      // El índice también se entera: si no, la omnibox rankea con la hora vieja.
      const e = index.get(url);
      if (e && t > e.last) e.last = t;
      if (i !== visits.length - 1) { visits.splice(i, 1); visits.push(v); }
      if (title) setTitle(url, title);
      schedule('history');
      return v;
    }
    const v = { id: ++seq, url, title: title || '', t };
    visits.push(v);
    indexVisit(v);
    if (visits.length > MAX_VISITS) {
      visits.splice(0, visits.length - MAX_VISITS);
      rebuildIndex();
    }
    schedule('history');
    return v;
  }

  /** El título llega DESPUÉS del commit: se lo pone a la visita más reciente. */
  function setTitle(url, title) {
    if (!title || !recordable(url)) return;
    for (let i = visits.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      if (visits[i].url === url) {
        if (visits[i].title === title) return;
        visits[i].title = title;
        break;
      }
    }
    const e = index.get(url);
    if (e) e.title = title;
    let named = false;
    for (const b of bookmarks) if (b.url === url && !b.title) { b.title = title; named = true; }
    if (named) schedule('bookmarks');
    schedule('history', { lazy: true });
  }

  function setFavicon(url, icon) {
    const host = bareHost(url);
    if (!host || !icon || favicons[host] === icon) return;
    favicons[host] = icon;
    schedule('history');
  }

  const faviconFor = (url) => favicons[bareHost(url)] || null;

  /** Las visitas, de la más nueva a la más vieja, filtradas y paginadas. */
  function listVisits({ query = '', before = Infinity, limit = 200 } = {}) {
    const q = String(query).trim().toLowerCase();
    const out = [];
    for (let i = visits.length - 1; i >= 0 && out.length < limit; i--) {
      const v = visits[i];
      if (v.t >= before) continue;
      if (q && !(`${v.title} ${v.url}`.toLowerCase().includes(q))) continue;
      out.push({ ...v, favicon: faviconFor(v.url) });
    }
    return out;
  }

  function removeVisits(ids) {
    const set = new Set(ids.map(Number));
    const before = visits.length;
    visits = visits.filter((v) => !set.has(v.id));
    if (visits.length !== before) { rebuildIndex(); schedule('history'); }
    return before - visits.length;
  }

  /** Borra desde `since` (ms epoch) hasta ahora; sin `since`, todo. */
  function clearHistory(since = 0) {
    const before = visits.length;
    visits = since ? visits.filter((v) => v.t < since) : [];
    if (!since) favicons = {};
    rebuildIndex();
    schedule('history');
    return before - visits.length;
  }

  /** Los más visitados, para la página de nueva pestaña. */
  function topSites(limit = 8) {
    const byHost = new Map();
    for (const e of index.values()) {
      const host = bareHost(e.url);
      if (!host) continue;
      const cur = byHost.get(host);
      // Por host y no por URL: diez artículos de un mismo diario son UN sitio.
      if (!cur) byHost.set(host, { ...e, score: frecency(e) });
      else {
        cur.score += frecency(e);
        if (e.visits > cur.visits) Object.assign(cur, { url: e.url, title: e.title, visits: e.visits });
      }
    }
    return [...byHost.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({ url: e.url, title: e.title, favicon: faviconFor(e.url) }));
  }

  /* ── Frecuencia × recencia ─────────────────────────────────────────────────
   Lo que se visita mucho y hace poco sube. La recencia decae por escalones
   (como el "frecency" de Firefox): una página de ayer pesa más que una del
   mes pasado aunque esta tenga más visitas acumuladas. */
  function frecency(e) {
    const age = (now() - e.last) / 86_400_000;
    const w = age < 1 ? 100 : age < 4 ? 70 : age < 14 ? 50 : age < 31 ? 30 : age < 90 ? 10 : 4;
    return w * Math.log2(1 + e.visits);
  }

  /* ── Sugerencias ───────────────────────────────────────────────────────────
   Qué tan bien matchea: que el host EMPIECE por lo tipeado es lo más fuerte
   (es lo que autocompleta la barra); después, que alguna palabra del título
   empiece así; al final, que aparezca en cualquier parte de la URL. */
  function matchScore(e, q) {
    const host = bareHost(e.url);
    const urlLow = e.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    const title = (e.title || '').toLowerCase();
    if (host.startsWith(q)) return 3;
    if (urlLow.startsWith(q)) return 2.6;
    if (title.split(/[\s\-–—|:·,.]+/).some((w) => w.startsWith(q))) return 2;
    if (urlLow.includes(q) || title.includes(q)) return 1;
    return 0;
  }

  /**
   * Sugerencias locales para lo tipeado.
   * → { items: [{ kind:'bookmark'|'history', url, title, favicon }], inline }
   * `inline` es el host a completar adentro de la barra (o null).
   * Con `history: false` solo mira los favoritos: el historial no aparece ni
   * en la lista ni en el autocompletado (ni siquiera para ordenar).
   */
  function suggest(query, limit = 6, { history = true } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { items: [], inline: null };

    const scored = new Map();
    const consider = (e, kind, boost) => {
      const m = matchScore(e, q);
      if (!m) return;
      const s = m * 100 + frecency(e) + boost;
      const prev = scored.get(e.url);
      if (!prev || prev.s < s) scored.set(e.url, { kind: prev?.kind === 'bookmark' ? 'bookmark' : kind, url: e.url, title: e.title, s });
    };
    if (history) for (const e of index.values()) consider(e, 'history', 0);
    for (const b of bookmarks) {
      const e = (history && index.get(b.url)) || { url: b.url, title: b.title, visits: 1, last: b.createdAt || 0 };
      consider({ ...e, title: b.title || e.title }, 'bookmark', 60);
    }

    const items = [...scored.values()]
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ s, ...it }) => ({ ...it, favicon: faviconFor(it.url) }));

    /* Autocompletar en línea: solo si lo tipeado es el PRINCIPIO de un host
       conocido. Completar sobre un título ("red" → "reddit.com" está bien,
       "noti" → "La Nación" no) reescribiría lo que la persona escribe. */
    let inline = null;
    if (!/[\s/]/.test(q)) {
      let best = null;
      if (history) {
        for (const e of index.values()) {
          const host = bareHost(e.url);
          if (host.startsWith(q) && host !== q) {
            const f = frecency(e);
            if (!best || f > best.f) best = { host, f };
          }
        }
      } else {
        // Sin historial completa con el host del primer favorito que empiece así.
        const host = bookmarks.map((b) => bareHost(b.url)).find((h) => h.startsWith(q) && h !== q);
        if (host) best = { host };
      }
      inline = best ? best.host : null;
    }
    return { items, inline };
  }

  /* ── Favoritos ─────────────────────────────────────────────────────────── */

  const isBookmarked = (url) => bookmarks.some((b) => b.url === url);
  const listBookmarks = () => bookmarks.map((b) => ({ ...b, favicon: b.favicon || faviconFor(b.url) }));

  function addBookmark({ url, title = '', favicon = null }) {
    if (!url || isBookmarked(url)) return bookmarks.find((b) => b.url === url) || null;
    const b = { id: `b${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, url, title, favicon, createdAt: now() };
    bookmarks.unshift(b);
    schedule('bookmarks');
    return b;
  }

  function removeBookmark(idOrUrl) {
    const before = bookmarks.length;
    bookmarks = bookmarks.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    if (bookmarks.length !== before) schedule('bookmarks');
    return before !== bookmarks.length;
  }

  function updateBookmark(id, patch = {}) {
    const b = bookmarks.find((x) => x.id === id);
    if (!b) return null;
    if (typeof patch.title === 'string') b.title = patch.title.trim();
    if (typeof patch.url === 'string' && patch.url.trim()) b.url = patch.url.trim();
    schedule('bookmarks');
    return { ...b };
  }

  /** Mueve un favorito a otra posición (los accesos de la nueva pestaña siguen este orden). */
  function moveBookmark(id, toIndex) {
    const i = bookmarks.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const [b] = bookmarks.splice(i, 1);
    bookmarks.splice(Math.max(0, Math.min(bookmarks.length, toIndex)), 0, b);
    schedule('bookmarks');
    return true;
  }

  /** Suma lo importado de otro navegador AL FINAL (el orden que ya tenías queda
      arriba), salteando lo que ya estaba o viene repetido. → { added, repeated } */
  function importBookmarks(list = []) {
    const have = new Set(bookmarks.map((b) => b.url));
    let added = 0;
    let repeated = 0;
    const base = now().toString(36);
    for (const x of list) {
      const url = String(x?.url || '').trim();
      if (!recordable(url)) continue;
      if (have.has(url)) { repeated += 1; continue; }
      have.add(url);
      const t = Number(x.createdAt) > 0 ? Number(x.createdAt) : now();
      bookmarks.push({ id: `b${base}i${added.toString(36)}${Math.random().toString(36).slice(2, 5)}`, url, title: String(x.title || '').slice(0, 300), favicon: null, createdAt: t });
      added += 1;
    }
    if (added) schedule('bookmarks');
    return { added, repeated };
  }

  /** Alterna: si estaba, lo saca; si no, lo agrega. Devuelve el estado final. */
  function toggleBookmark(info) {
    if (isBookmarked(info.url)) { removeBookmark(info.url); return false; }
    addBookmark(info);
    return true;
  }

  return {
    load, flushAll, flushAllSync,
    visit, setTitle, setFavicon, faviconFor, listVisits, removeVisits, clearHistory, topSites, suggest,
    isBookmarked, listBookmarks, addBookmark, removeBookmark, updateBookmark, moveBookmark, toggleBookmark, importBookmarks,
    get visitCount() { return visits.length; },
  };
}

module.exports = { createLibrary, recordable, MAX_VISITS };
