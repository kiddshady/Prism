/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — las páginas propias
   Lo que se dibuja ADENTRO de la hoja de la página cuando la pestaña activa
   no es un sitio: la nueva pestaña, el historial, los favoritos, las
   descargas, los ajustes, y los avisos (no se pudo cargar, la pestaña se
   cayó, el video está en la ventanita). También la espera de una pestaña
   web que todavía no pintó.

   Cada página se monta una vez por pestaña y se re-dibuja solo cuando cambian
   SUS datos — no con cada foto de estado que llega mientras otra pestaña
   carga. Si se re-montara con cada una, el campo de búsqueda perdería el foco
   a mitad de palabra.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab } from './state.js';
import { Icons } from './icons.js';
import { exit, scrollFade, bindSwitcher, raf2, reconcile, roll, swap, swapText, glideSize } from './motion.js';
import { esc } from './ui.js';
import { fmtBytes, fmtDur, relTime, plural, locale } from './format.js';
import { menu, modal, confirm } from './layers.js';
import { say } from './status.js';
import { attachSuggest } from './suggest.js';
import { openPanel as openPasswords } from './passwords.js';

/* Una superficie por mitad de la hoja: sin vista dividida se usa solo la
   primera; con un par, cada mitad dibuja lo suyo (una página propia, un
   aviso o la espera debajo de la vista). `surf` es la que se está dibujando
   ahora: mount() y las limpiezas van a esa. */
const surface = (hostId) => ({ hostId, key: null, current: null, cleanups: [] });   // current: { name, el, refresh? }
const surfaces = [surface('internal'), surface('internal-2')];
let surf = surfaces[0];

const host = () => document.getElementById(surf.hostId);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function favIcon(url, favicon, fallback = 'globe') {
  return favicon
    ? `<img src="${esc(favicon)}" alt="" referrerpolicy="no-referrer" data-fallback="${fallback}">`
    : Icons.svg(fallback);
}

/** Un <img> de favicon que no carga vuelve a su ícono (que aparece, no salta) en vez de quedar roto. */
function wireFallbacks(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      const t = document.createElement('template');
      t.innerHTML = Icons.svg(img.dataset.fallback);
      const icon = t.content.firstElementChild;
      icon.classList.add('op-in-fade');
      img.replaceWith(icon);
    }, { once: true });
  });
}

/* Los avisos de Prism van en la statusbar, no en un toast: con la vista
   dividida, un toast cae sobre la mitad que es una página y queda tapado. */
export async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(String(url));
    say('Dirección copiada', { icon: 'copy' });
  } catch (err) {
    say(`No se pudo copiar: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
}

function mount(html, name) {
  const el = document.createElement('div');
  el.className = 'pr-view';
  el.dataset.page = name;
  el.innerHTML = html;
  Icons.mount(el);
  wireFallbacks(el);
  const old = host().querySelectorAll('.pr-view:not([data-state="closing"])');
  old.forEach((o) => exit(o, { fallback: 240 }));
  /* Si hay una que se va, la nueva espera a que casi no se vea: sale y
     después entra. Entrando las dos a la vez quedaban encimadas. */
  if (old.length) el.classList.add('is-after');
  host().appendChild(el);
  el.querySelectorAll('.op-scroll').forEach(scrollFade);
  /* La animación de entrada se saca al terminar (lección de Opal): una
     opacidad retenida deja al contenedor como frontera de backdrop. Con una
     clase y no con style.animation: un estilo en línea le ganaba a la regla
     de salida, y la página vieja no se desvanecía — quedaba entera encima
     de la nueva hasta desaparecer de golpe. */
  setTimeout(() => el.classList.add('is-settled'), 620);
  return el;
}

function pageKey(t) {
  if (!t) return 'none';
  if (t.internal) return `internal:${t.internal}:${t.id}`;
  if (t.pip) return `pip:${t.id}`;
  if (t.crashed) return `crashed:${t.id}`;
  if (t.error) return `error:${t.id}:${t.error.code}:${t.error.url}`;
  return `web:${t.id}`;
}

export function render() {
  const sp = S.split;
  const byId = (id) => S.tabs.find((x) => x.id === id) || null;
  const list = sp ? [byId(sp.a), byId(sp.b)] : [activeTab()];
  // Sin par, la segunda mitad se desvanece con lo que tenía: no se redibuja.
  list.forEach((t, i) => { surf = surfaces[i]; renderSurface(t); });
  surf = surfaces[0];
}

function renderSurface(t) {
  const k = pageKey(t);
  if (k === surf.key) {
    if (k.startsWith('web:')) syncWaiting(t);
    return;
  }
  surf.key = k;
  surf.cleanups.forEach((fn) => { try { fn(); } catch { /* nada */ } });
  surf.cleanups = [];
  if (!t) { mount('', 'none'); surf.current = null; return; }
  if (t.internal) { surf.current = PAGES[t.internal]?.(t) || null; return; }
  if (t.pip) { surf.current = pipPage(t); return; }
  if (t.crashed) { surf.current = crashedPage(t); return; }
  if (t.error) { surf.current = errorPage(t); return; }
  surf.current = waitingPage(t);
}

/** Refresca las páginas propias que estén a la vista con alguno de esos nombres. */
function refresh(names, when = () => true) {
  for (const sf of surfaces) {
    if (!names.includes(sf.current?.name) || !when()) continue;
    surf = sf;
    sf.current.refresh?.();
  }
  surf = surfaces[0];
}

/* ══ Espera ══════════════════════════════════════════════════════════════════ */

function waitingPage(t) {
  const el = mount(`<div class="pr-waiting"><div class="pr-waiting__dot">${favIcon(t.url, t.favicon)}</div></div>`, 'waiting');
  return { name: 'waiting', el };
}

function syncWaiting(t) {
  if (surf.current?.name !== 'waiting') return;
  const dot = surf.current.el.querySelector('.pr-waiting__dot');
  // El globo se releva por el favicon apenas llega (swap), sin cortar la respiración.
  if (t.favicon && !dot.querySelector('img')) { swap(dot, favIcon(t.url, t.favicon)); wireFallbacks(dot); }
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
  /* Un certificado inválido en la red de casa (router, NAS, impresora) es lo
     normal: se lo fabricaron ellos. Solo ahí se puede confiar en él; en
     internet la página sigue sin salida (certs.cjs). */
  const local = t.error.cert?.local;
  const text = local
    ? `${t.error.cert.host} es una dirección de tu red. Los routers, los NAS y las impresoras suelen usar un certificado que se fabricaron ellos mismos, y Chromium no lo puede verificar. Si es un aparato tuyo, podés confiar en este certificado: Prism lo recuerda, y si alguna vez cambia vuelve a preguntar.`
    : info.text;
  const el = mount(`
    <div class="pr-notice"><div class="pr-notice__box${info.failed ? ' is-failed' : ''}">
      ${Icons.svg(info.icon, 'pr-notice__icon')}
      <div class="pr-notice__title">${esc(info.title)}</div>
      <div class="pr-notice__text">${esc(text)}</div>
      <div class="pr-notice__url">${esc(t.error.url || t.url)}</div>
      <span class="pr-notice__code">${esc(t.error.desc || 'ERROR')} · ${t.error.code}</span>
      <div class="pr-notice__actions">
        <button class="op-btn op-btn--primary op-flashable" data-a="retry"><i data-icon="reload"></i> Reintentar</button>
        ${local ? '<button class="op-btn op-btn--secondary" data-a="trust"><i data-icon="shieldCheck"></i> Confiar en este certificado</button>' : ''}
        ${t.canGoBack ? '<button class="op-btn op-btn--ghost" data-a="back"><i data-icon="arrowLeft"></i> Volver</button>' : ''}
      </div>
    </div></div>`, 'error');
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'retry') api.nav.reload();
    if (a === 'back') api.nav.back();
    if (a === 'trust') api.certs.allow(t.id).catch((err) => console.error('[certs]', err?.message || err));
  });
  return { name: 'error', el };
}

/* La página se mudó a la ventanita (src/pip.cjs): su lugar lo dice, y la trae. */
function pipPage(t) {
  const el = mount(`
    <div class="pr-notice"><div class="pr-notice__box">
      ${Icons.svg('pip', 'pr-notice__icon')}
      <div class="pr-notice__title">El video está en la ventanita</div>
      <div class="pr-notice__text">Sigue a la vista. Traelo de vuelta para seguir con la página.</div>
      <div class="pr-notice__actions"><button class="op-btn op-btn--primary op-flashable" data-a="back"><i data-icon="pipBack"></i> Traer de vuelta</button></div>
    </div></div>`, 'pip');
  el.querySelector('[data-a]').addEventListener('click', () => api.page.pipBack(t.id));
  return { name: 'pip', el };
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

/* En incógnito no hay accesos: los más visitados saldrían del historial. En
   su lugar, qué se guarda y qué no — dicho sin prometer de más. */
function incognitoHTML() {
  return `<div class="pr-incog">
      <div class="pr-incog__title">Estás en incógnito</div>
      <div class="pr-incog__text">Lo que hagas en esta ventana no queda en Prism. Al cerrarla se borran sus pestañas, cookies e inicios de sesión.</div>
      <div class="pr-incog__cols">
        <div class="pr-incog__col"><div class="pr-incog__head">${Icons.svg('ghost')}No se guarda</div>
          <ul class="pr-incog__list"><li>El historial</li><li>Cookies y datos de los sitios</li><li>Los permisos que des</li><li>Contraseñas nuevas</li></ul></div>
        <div class="pr-incog__col"><div class="pr-incog__head">${Icons.svg('star')}Sí queda</div>
          <ul class="pr-incog__list"><li>Los favoritos que agregues</li><li>Los archivos que bajes</li><li>Las capturas</li></ul></div>
      </div>
      <div class="pr-incog__text">Los sitios que visitás, tu proveedor de internet y quien administre la red igual pueden ver tu actividad.</div>
    </div>`;
}

function ntpPage(t) {
  const priv = !!S.info?.private;
  const el = mount(`
    <div class="pr-ntp" id="ntp">
      <div class="pr-ntp__mark">${Icons.svg('prism')}</div>
      <label class="pr-fakebox" id="fakebox">${Icons.svg('search')}
        <input class="pr-fakebox__input" id="ntp-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="Buscá o escribí una dirección" aria-label="Buscar o ir a una dirección"></label>
      ${priv ? incognitoHTML() : '<div class="pr-ntp__tiles" id="ntp-tiles"></div>'}
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
      await api.tabs.navigate(t.id, value).catch(() => null);
    },
    onEscape: () => {
      if (ntpInput.value) { ntpInput.value = ''; return; }
      ntpInput.blur();
    },
  });
  surf.cleanups.push(() => sugg.detach());

  const topOn = () => S.settings?.ntpTopSites !== false;
  let shownTop = topOn();
  async function fill() {
    if (priv) return;
    shownTop = topOn();
    const [bm, top] = await Promise.all([api.bookmarks.list().catch(() => []), shownTop ? api.history.top(12).catch(() => []) : []]);
    const marks = bm.slice(0, 8);
    const seen = new Set(marks.map((b) => hostOf(b.url)));
    const freq = top.filter((t) => !seen.has(hostOf(t.url))).slice(0, 8);
    /* Por piezas (reconcile, motion.js): quitar un favorito saca SU baldosa y
       las demás se corren a llenar el hueco; prender o apagar "los que más
       visitás" despliega o retira ese bloque. Antes se rehacía todo, y todas
       las baldosas volvían a entrar. */
    const box = el.querySelector('#ntp-tiles');
    const sections = [];
    if (marks.length) sections.push({ key: 'label:fav', html: '<div class="pr-tiles__label op-eyebrow">Favoritos</div>' }, { key: 'grid:fav', html: '<div class="pr-tiles"></div>' });
    if (freq.length) sections.push({ key: 'label:top', html: '<div class="pr-tiles__label op-eyebrow">Los que más visitás</div>' }, { key: 'grid:top', html: '<div class="pr-tiles"></div>' });
    if (!marks.length && !freq.length) sections.push({ key: `empty:${shownTop}`, html: `<div class="pr-tiles__label op-meta" style="margin-top:28px">${shownTop ? 'Tus favoritos y los sitios que más visitás van a aparecer acá.' : 'Tus favoritos van a aparecer acá.'}</div>` });
    reconcile(box, sections);
    const wire = (t) => t.querySelectorAll('img[data-letter]').forEach((img) => img.addEventListener('error', () => {
      const s = document.createElement('span');
      s.className = 'op-in-fade';
      s.textContent = img.dataset.letter;
      img.replaceWith(s);
    }, { once: true }));
    const grid = (k) => box.querySelector(`[data-key="grid:${k}"]:not([data-state="closing"])`);
    if (grid('fav')) reconcile(grid('fav'), marks.map((b, i) => ({ key: `b:${b.id}`, html: tileHTML(b, i, 'bookmark') })), { created: wire });
    if (grid('top')) reconcile(grid('top'), freq.map((b, i) => ({ key: `t:${b.url}`, html: tileHTML(b, i + marks.length, 'top') })), { created: wire });
  }
  fill();

  el.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    const tile = e.target.closest('.pr-tile');
    if (!tile) return;
    if (more) { e.stopPropagation(); tileMenu(more, tile); return; }
    if (e.ctrlKey) api.tabs.create(tile.dataset.url, { active: false });
    else api.tabs.navigate(t.id, tile.dataset.url);
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

  // Solo se rearma si cambió este ajuste: con cualquier otro (el escudo del
  // bloqueador, la barra de favoritos) las baldosas volverían a entrar.
  return { name: 'nueva', el, refresh: fill, onSettings: () => { if (topOn() !== shownTop) fill(); } };
}

function tileMenu(anchor, tile) {
  const { url, id, kind } = tile.dataset;
  menu(anchor, [
    { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => api.tabs.create(url, { active: false }) },
    { label: 'Copiar la dirección', icon: 'link', onSelect: () => copyUrl(url) },
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

function historyPage(t) {
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

  /* Filas y títulos de día como piezas de reconcile() (motion.js): al buscar,
     lo que sigue coincidiendo se queda y se acomoda, lo demás se va y lo
     nuevo entra. Antes la lista se rehacía entera con cada búsqueda. */
  function rowItems() {
    const out = [];
    let lastDay = null;
    for (const v of items) {
      const day = dayLabel(v.t);
      if (day !== lastDay) { out.push({ key: `day:${day}`, html: `<div class="pr-day op-eyebrow">${esc(day)}</div>` }); lastDay = day; }
      out.push({ key: `v:${v.id}`, html: `<div class="pr-row" data-id="${v.id}" data-url="${esc(v.url)}">
          <span class="pr-row__time">${clock(v.t)}</span>
          <span class="pr-row__fav">${favIcon(v.url, v.favicon)}</span>
          <span class="pr-row__title">${esc(v.title || v.url)}</span>
          <span class="pr-row__host">${esc(hostOf(v.url))}</span>
          <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-more aria-label="Más">${Icons.svg('more')}</button></div>
        </div>` });
    }
    return out.length ? out : [{ key: `empty:${query}`, html: `<div class="op-empty">${Icons.svg(query ? 'search' : 'history')}
          <div class="op-empty__title">${query ? 'Nada coincide' : 'El historial está vacío'}</div>
          <div class="op-empty__text">${query ? `No visitaste nada que diga «${esc(query)}».` : 'Lo que visites va a aparecer acá, ordenado por día.'}</div></div>` }];
  }

  const paint = () => reconcile(list, rowItems(), { created: wireFallbacks });

  let seq = 0;
  async function load(reset = false, keepScroll = false) {
    // Una búsqueda nueva no espera a la página que estaba bajando: la deja vieja.
    if (!reset && (loading || done)) return;
    const my = ++seq;
    loading = true;
    const before = !reset && items.length ? items[items.length - 1].t : undefined;
    const page = await api.history.list({ query, before, limit: 150 }).catch(() => []);
    if (my !== seq) return;
    items = reset ? page : items.concat(page);
    done = page.length < 150;
    paint();
    // Arriba de todo, pero deslizándose: el salto se leía como otra página.
    if (reset && !keepScroll && scroller.scrollTop > 0) scroller.scrollTo({ top: 0, behavior: 'smooth' });
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
  surf.cleanups.push(() => io.disconnect());

  // La fila se va con su salida y las de abajo suben; un día que quedó sin
  // filas se va con ella.
  async function removeRow(row) {
    const id = Number(row.dataset.id);
    items = items.filter((v) => v.id !== id);
    paint();
    await api.history.remove([id]).catch(() => null);
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
        { label: 'Copiar la dirección', icon: 'link', onSelect: () => copyUrl(url) },
        { label: 'Más de este sitio', icon: 'filter', onSelect: () => { q.value = hostOf(url); query = q.value; load(true); } },
        { sep: true },
        { label: 'Borrar del historial', icon: 'trash', danger: true, onSelect: () => removeRow(row) },
      ], { align: 'end' });
      return;
    }
    if (e.ctrlKey) api.tabs.create(row.dataset.url, { active: false });
    else api.tabs.navigate(t.id, row.dataset.url);
  });
  el.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.pr-row');
    if (row && e.button === 1) api.tabs.create(row.dataset.url, { active: false });
  });
  el.querySelector('#h-clear').addEventListener('click', () => clearDataModal());

  load(true);
  // Un cambio de afuera (una visita nueva) no te saca de donde estabas leyendo.
  return { name: 'historial', el, refresh: () => load(true, true) };
}

/* ══ Favoritos ═══════════════════════════════════════════════════════════════ */

export async function editBookmark(id) {
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
  await api.bookmarks.update(id, { title: body.querySelector('#b-title').value, url: body.querySelector('#b-url').value })
    .catch((err) => say(err.message, { icon: 'alert', tone: 'error' }));
}

/** Cómo salió una importación, en la statusbar. */
function sayImported(r, from) {
  if (!r) return;
  const rep = r.repeated ? ` · ${plural(r.repeated, 'ya estaba', 'ya estaban')}` : '';
  say(r.added ? `Se sumaron ${plural(r.added, 'favorito', 'favoritos')} de ${from}${rep}` : `No había favoritos nuevos en ${from}${rep}`, { icon: 'star', ms: 7000 });
}

/** De dónde importar: los perfiles de los navegadores instalados, o un archivo exportado. */
async function importMenu(btn) {
  const sources = await api.bookmarks.sources().catch(() => []);
  const run = (p, from) => p.then((r) => sayImported(r, from)).catch((err) => say(err.message, { icon: 'alert', tone: 'error' }));
  menu(btn, [
    { groupLabel: 'Importar de' },
    ...(sources.length
      ? sources.map((s) => ({ label: `${s.browser} · ${s.profile}`, icon: 'star', key: String(s.count), onSelect: () => run(api.bookmarks.import(s.id), s.browser) }))
      : [{ label: 'No encontré Chrome, Edge ni Brave', icon: 'info', disabled: true }]),
    { sep: true },
    { label: 'Un archivo HTML exportado…', icon: 'folderOpen', onSelect: () => run(api.bookmarks.importFile(), 'el archivo') },
  ], { align: 'end' });
}

function bookmarksPage(t) {
  const el = mount(`
    <div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll"><div class="pr-view__col">
      <div class="pr-head">
        <div class="pr-head__text"><div class="pr-head__title">Favoritos</div><div class="pr-head__sub" id="b-sub"></div></div>
        <div class="pr-head__actions">
          <div class="op-inputwrap pr-search">${Icons.svg('search')}<input class="op-input" id="b-q" placeholder="Buscar en favoritos" spellcheck="false"></div>
          <button class="op-btn op-btn--secondary op-flashable" id="b-import"><i data-icon="download"></i> Importar…</button>
        </div>
      </div>
      <div class="pr-list" id="b-list"></div>
    </div></div>`, 'favoritos');

  const list = el.querySelector('#b-list');
  const q = el.querySelector('#b-q');
  let all = [];
  let painted = false;

  /* Fila por fila (reconcile): filtrar deja las que siguen coincidiendo en su
     lugar y las acomoda; mover, editar o quitar un favorito también viaja. */
  function paint() {
    const f = q.value.trim().toLowerCase();
    const shown = f ? all.filter((b) => `${b.title} ${b.url}`.toLowerCase().includes(f)) : all;
    const sub = el.querySelector('#b-sub');
    const subText = all.length ? plural(all.length, 'sitio guardado', 'sitios guardados') : 'Los sitios que guardás para volver';
    if (painted) swapText(sub, subText); else sub.textContent = subText;
    painted = true;
    reconcile(list, shown.length ? shown.map((b) => ({ key: b.id, html: `
      <div class="pr-row" data-id="${esc(b.id)}" data-url="${esc(b.url)}">
        <span class="pr-row__fav">${favIcon(b.url, b.favicon, 'star')}</span>
        <span class="pr-row__title">${esc(b.title || hostOf(b.url) || b.url)}</span>
        <span class="pr-row__host">${esc(b.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>
        <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-more aria-label="Más">${Icons.svg('more')}</button></div>
      </div>` }))
      : [{ key: f ? 'empty:q' : 'empty', html: `<div class="op-empty">${Icons.svg(f ? 'search' : 'star')}
          <div class="op-empty__title">${f ? 'Nada coincide' : 'Todavía no guardaste favoritos'}</div>
          <div class="op-empty__text">${f ? '' : 'Tocá la estrella de la barra de direcciones, apretá Ctrl+D en cualquier sitio, o traé los de Chrome con Importar.'}</div></div>` }], { created: wireFallbacks });
  }

  async function fill() {
    all = await api.bookmarks.list().catch(() => []);
    paint();
  }

  q.addEventListener('input', paint);
  const importBtn = el.querySelector('#b-import');
  importBtn.addEventListener('click', () => importMenu(importBtn));
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
        { label: 'Copiar la dirección', icon: 'link', onSelect: () => copyUrl(url) },
        { label: 'Editar', icon: 'edit', onSelect: () => editBookmark(id) },
        { sep: true },
        { label: 'Subir', icon: 'chevronUp', disabled: i <= 0, onSelect: () => api.bookmarks.move(id, i - 1) },
        { label: 'Bajar', icon: 'chevronDown', disabled: i >= all.length - 1, onSelect: () => api.bookmarks.move(id, i + 1) },
        { sep: true },
        // La lista que vuelve la saca con su salida (reconcile) y las de abajo suben.
        { label: 'Quitar de favoritos', icon: 'trash', danger: true, onSelect: () => api.bookmarks.remove(id) },
      ], { align: 'end' });
      return;
    }
    if (e.ctrlKey) api.tabs.create(url, { active: false });
    else api.tabs.navigate(t.id, url);
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

/* Una descarga como fila de reconcile() (motion.js), para la página y para el
   panel de la barra (`compact`: acciones de solo ícono). La fila se crea una
   vez y después se pone al día EN SU LUGAR (dlUpdate): rehecha con cada dato
   que llega, la barra saltaba en vez de avanzar y los números cambiaban de
   un cuadro al otro. */
const dlMode = (d) => `${d.state}:${!!d.paused}:${!!d.missing}`;
const dlPct = (d) => (d.total ? Math.round((d.received / d.total) * 100) : 0);

function dlActionsHTML(d, compact) {
  const ib = (a, icon, tip) => `<button class="op-iconbtn op-iconbtn--sm" data-a="${a}" data-tip="${tip}">${Icons.svg(icon)}</button>`;
  const tb = (a, icon, label) => `<button class="op-btn op-btn--ghost op-btn--sm" data-a="${a}">${Icons.svg(icon)} ${label}</button>`;
  if (d.state === 'progressing') {
    const [a, icon, label] = d.paused ? ['resume', 'resume', 'Seguir'] : ['pause', 'pause', 'Pausar'];
    return compact ? `${ib(a, icon, label)}${ib('cancel', 'close', 'Cancelar')}` : `${tb(a, icon, label)}${tb('cancel', 'close', 'Cancelar')}`;
  }
  const done = d.state === 'completed' && !d.missing;
  if (compact) return done ? ib('show', 'folder', 'Mostrar en la carpeta') : ib('retry', 'retry', 'Reintentar');
  return `${done ? `${tb('open', 'external', 'Abrir')}${ib('show', 'folder', 'Mostrar en la carpeta')}` : tb('retry', 'retry', 'Reintentar')}${ib('remove', 'close', 'Quitar de la lista')}`;
}

export function dlItem(d, compact = false) {
  const live = d.state === 'progressing';
  return {
    key: String(d.id),
    d,
    compact,
    html: `<div class="pr-dlrow${d.state === 'interrupted' ? ' is-failed' : ''}${d.state === 'cancelled' || d.missing ? ' is-muted' : ''}" data-id="${d.id}">
        <div class="pr-dlrow__icon">${Icons.svg(dlIcon(d))}</div>
        <div class="pr-dlrow__main">
          <div class="pr-dlrow__name op-copyable">${esc(d.filename)}</div>
          <div class="pr-dlrow__meta"><span class="pr-dlrow__metatext">${esc(dlMeta(d))}</span></div>
          <div class="pr-dlrow__bar op-reveal${live ? ' is-open' : ''}"><div><div class="op-meter${live && !d.total ? ' op-meter--indeterminate' : ''}"><div class="op-meter__fill" style="--op-pct:${dlPct(d)}%"></div></div></div></div>
        </div>
        <div class="pr-dlrow__actions op-swap--row">${dlActionsHTML(d, compact)}</div>
      </div>`,
  };
}

export function dlUpdate(el, { d, compact }) {
  const live = d.state === 'progressing';
  el.classList.toggle('is-failed', d.state === 'interrupted');
  el.classList.toggle('is-muted', d.state === 'cancelled' || !!d.missing);
  swap(el.querySelector('.pr-dlrow__icon'), Icons.svg(dlIcon(d)));
  const name = el.querySelector('.pr-dlrow__name');
  if (name.textContent.trim() !== d.filename) swapText(name, d.filename);
  // El dato cambia de forma (bajando → terminada): se releva. Mientras baja, corre.
  const meta = el.querySelector('.pr-dlrow__meta');
  if (el.dataset.mode !== dlMode(d)) {
    el.dataset.mode = dlMode(d);
    const next = swap(meta, `<span class="pr-dlrow__metatext">${esc(dlMeta(d))}</span>`);
    seedRoll(next?.querySelector('.pr-dlrow__metatext'), d);
  } else {
    const spans = meta.querySelectorAll('.pr-dlrow__metatext');
    const text = spans[spans.length - 1];
    if (live) roll(text, { received: d.received || 0, speed: d.speed || 0 }, (v) => { text.textContent = dlMeta({ ...d, received: Math.round(v.received), speed: v.speed }); });
    else text.textContent = dlMeta(d);
  }
  el.querySelector('.pr-dlrow__bar').classList.toggle('is-open', live);
  if (live) {
    el.querySelector('.op-meter').classList.toggle('op-meter--indeterminate', !d.total);
    el.querySelector('.op-meter__fill').style.setProperty('--op-pct', `${dlPct(d)}%`);
  }
  swap(el.querySelector('.pr-dlrow__actions'), dlActionsHTML(d, compact), { size: true });
}

/* Lo que dice el texto al nacer es de donde arranca a correr el próximo dato. */
function seedRoll(text, d) {
  if (text) text.__roll = { cur: { received: d.received || 0, speed: d.speed || 0 }, to: null, raf: 0 };
}

/** Una fila recién creada nace en el modo de su dato. La del vacío no tiene dato. */
export const dlCreated = (el, it) => {
  if (!it.d) return;
  el.dataset.mode = dlMode(it.d);
  seedRoll(el.querySelector('.pr-dlrow__metatext'), it.d);
};

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

  function paint() {
    swapText(el.querySelector('#d-sub'), S.downloadsDir ? `Se guardan en ${S.downloadsDir}` : '');
    el.querySelector('#d-clear').disabled = !S.downloads.some((d) => d.state !== 'progressing');
    reconcile(list, S.downloads.length ? S.downloads.map((d) => dlItem(d)) : [{ key: '__empty', html: `<div class="op-empty">${Icons.svg('download')}<div class="op-empty__title">Todavía no bajaste nada</div>
          <div class="op-empty__text">Lo que descargues va a aparecer acá, con su progreso.</div></div>` }], { update: dlUpdate, created: dlCreated });
  }

  // Quitar una fila es avisarle al proceso principal: la lista que vuelve la
  // saca con su salida, y las de abajo suben en vez de saltar.
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = Number(b.closest('.pr-dlrow')?.dataset.id);
    await api.downloads[b.dataset.a](id).catch((err) => say(err.message, { icon: 'alert', tone: 'error' }));
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
// Abrir aplicaciones se recuerda por esquema (src/web.cjs): «openExternal:zoommtg».
const permName = (k) => PERM_NAMES[k] || (k.startsWith('openExternal:') ? `Abrir «${k.slice(13)}:»` : k);

let launchForceDark = null;
/* Un cambio hecho DESDE esta página vuelve como aviso de "ajustes cambiaron".
   Repintar con ese aviso cortaría la transición del switch que se acaba de
   tocar (el nodo nuevo nace ya encendido): durante un rato se ignora. */
let quietUntil = 0;

function kbdHTML(combo) {
  return combo.split(' · ').map((c) => c.split(/\+(?!$)/).map((k) => `<span class="op-kbd">${esc(k)}</span>`).join('')).join('<span class="pr-or">o</span>');
}

/* Ajustes se arma UNA vez (build) y después se pone al día en su lugar
   (sync): los switches se mueven, la cápsula de los segmentados viaja, las
   listas (sitios apagados, permisos, certificados) suman y sacan filas con
   su entrada y su salida, y lo que aparece o se va según otro ajuste se
   despliega. Antes cada cambio rehacía la página entera: los chips volvían a
   aparecer, una fila olvidada desaparecía de golpe y las de abajo saltaban. */
const isOn = (s, k) => (['historySuggest', 'bookmarksBar', 'ntpTopSites', 'passwords'].includes(k) ? s[k] !== false : !!s[k]);

const chipHTML = (h, attr, label) => `<span class="pr-chip-x">${esc(h)}<button class="op-iconbtn" ${attr}="${esc(h)}" aria-label="${label}">${Icons.svg('close')}</button></span>`;

function permRowHTML(origin, map) {
  return `<div class="pr-opt pr-opt--item">
      <div class="pr-opt__text"><div class="pr-opt__path" style="color:var(--op-text-2)">${esc(origin.replace(/^https:\/\//, ''))}</div>
        <div class="pr-opt__hint">${Object.entries(map).map(([k, v]) => `${esc(permName(k))}: ${v === 'allow' ? 'permitido' : 'bloqueado'}`).join(' · ')}</div></div>
      <div class="pr-opt__ctl"><button class="op-btn op-btn--ghost op-btn--sm" data-forget="${esc(origin)}">Olvidar</button></div></div>`;
}

function certRowHTML(c) {
  return `<div class="pr-opt pr-opt--item">
      <div class="pr-opt__text"><div class="pr-opt__path" style="color:var(--op-text-2)">${esc(c.host)}</div>
        <div class="pr-opt__hint">Aceptado el ${esc(new Date(c.at || Date.now()).toLocaleDateString(locale.tag, { day: 'numeric', month: 'short', year: 'numeric' }))}</div></div>
      <div class="pr-opt__ctl"><button class="op-btn op-btn--ghost op-btn--sm" data-uncert="${esc(c.host)}">Olvidar</button></div></div>`;
}

function settingsPage() {
  if (launchForceDark == null) launchForceDark = !!S.settings.forceDark;
  const el = mount('<div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll" id="set-scroll"><div class="pr-view__col" id="set-col"></div></div>', 'ajustes');
  const col = el.querySelector('#set-col');
  const toggle = (k, label) => `<button class="op-switch${isOn(S.settings, k) ? ' is-on' : ''}" data-toggle="${k}" aria-label="${label}"></button>`;
  const segs = {};

  function build() {
    const s = S.settings;
    const engines = S.info?.engines || { google: 'Google' };
    col.innerHTML = `
      <div class="pr-head"><div class="pr-head__text"><div class="pr-head__title">Ajustes</div>
        <div class="pr-head__sub">Se guardan solos, apenas los cambiás</div></div></div>

      <section class="pr-set" style="--i:0">
        <div class="pr-set__head">${Icons.svg('search')}<span class="pr-set__title">Búsqueda</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Buscador</div>
          <div class="pr-opt__hint">El que usa la barra de direcciones cuando lo que escribís no es una dirección.</div></div>
          <div class="pr-opt__ctl"><div class="op-segmented" id="s-engine">${Object.entries(engines).map(([k, v]) => `<button class="op-segmented__opt${s.searchEngine === k ? ' is-active' : ''}" data-value="${k}">${esc(v)}</button>`).join('')}</div></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Sugerencias mientras escribís</div>
          <div class="pr-opt__hint">Le manda al buscador lo que vas tipeando para completar. Apagado, solo sugiere lo que ya tenés en Prism.</div></div>
          <div class="pr-opt__ctl">${toggle('remoteSuggest', 'Sugerencias')}</div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Sugerir sitios del historial</div>
          <div class="pr-opt__hint">Apagado, la barra no te muestra ni completa lo que visitaste: solo tus favoritos. El historial se sigue guardando.</div></div>
          <div class="pr-opt__ctl">${toggle('historySuggest', 'Sugerir del historial')}</div></div>
      </section>

      <section class="pr-set" style="--i:1">
        <div class="pr-set__head">${Icons.svg('window')}<span class="pr-set__title">Windows</span></div>
        <div class="pr-dflt">${defaultStateHTML(' is-first')}</div>
        <div class="pr-auto" data-key="${autostartKey()}">${autostartHTML()}</div>
      </section>

      <section class="pr-set" style="--i:2">
        <div class="pr-set__head">${Icons.svg('tabs')}<span class="pr-set__title">Pestañas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Al abrir Prism, empezar con</div>
          <div class="pr-opt__hint">Las pestañas de la última vez cargan recién cuando las mirás: abrir veinte no levanta veinte páginas.</div></div>
          <div class="pr-opt__ctl"><div class="op-segmented" id="s-startup">
            <button class="op-segmented__opt${s.startup === 'restore' ? ' is-active' : ''}" data-value="restore">Las pestañas de antes</button>
            <button class="op-segmented__opt${s.startup === 'newtab' ? ' is-active' : ''}" data-value="newtab">Una pestaña nueva</button></div></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Dormir las pestañas que no mirás</div>
          <div class="pr-opt__hint">Liberan memoria y, al volver, siguen donde estaban. Nunca se duermen las fijadas ni las que suenan.</div></div>
          <div class="pr-opt__ctl"><div class="op-segmented" id="s-sleep">${[[0, 'Nunca'], [15, '15 min'], [30, '30 min'], [60, '1 h']].map(([v, l]) => `<button class="op-segmented__opt${Number(s.sleepTabs) === v ? ' is-active' : ''}" data-value="${v}">${l}</button>`).join('')}</div></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Barra de favoritos</div>
          <div class="pr-opt__hint">Tus favoritos a un clic, debajo de la barra de direcciones. Lo que no entra queda en la flecha de la punta. También con Ctrl+Mayús+B.</div></div>
          <div class="pr-opt__ctl">${toggle('bookmarksBar', 'Barra de favoritos')}</div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Los que más visitás en la pestaña nueva</div>
          <div class="pr-opt__hint">Apagado, la pestaña nueva solo muestra tus favoritos. El historial se sigue guardando.</div></div>
          <div class="pr-opt__ctl">${toggle('ntpTopSites', 'Los que más visitás')}</div></div>
      </section>

      <section class="pr-set" style="--i:3">
        <div class="pr-set__head">${Icons.svg('shield')}<span class="pr-set__title">Bloqueador</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Bloquear anuncios y rastreadores</div>
          <div class="pr-opt__hint">Con las listas de EasyList, EasyPrivacy y uBlock Origin. También saca los carteles de cookies.</div></div>
          <div class="pr-opt__ctl">${toggle('adblock', 'Bloqueador')}</div></div>
        <div class="op-reveal pr-chipset" id="s-allow"><div>
          <div class="pr-opt pr-opt--label"><div class="pr-opt__text"><div class="pr-opt__label">Apagado en</div></div></div>
          <div class="pr-chips"></div>
        </div></div>
      </section>

      <section class="pr-set" style="--i:4">
        <div class="pr-set__head">${Icons.svg('moon')}<span class="pr-set__title">Páginas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Oscurecer todos los sitios</div>
          <div class="pr-opt__hint">Los sitios con modo oscuro propio ya lo usan solos. Esto oscurece también los que no lo tienen (a veces con colores raros).</div>
          <div class="op-reveal pr-relaunch-note" id="s-relaunch-note"><div><div class="pr-opt__hint"><b>Se aplica al reiniciar.</b></div></div></div></div>
          <div class="pr-opt__ctl"><div class="pr-hreveal" id="s-relaunch-wrap"><div><button class="op-btn op-btn--secondary op-btn--sm" id="s-relaunch" tabindex="-1"><i data-icon="reload"></i> Reiniciar</button></div></div>
            ${toggle('forceDark', 'Oscurecer todo')}</div></div>
      </section>

      <section class="pr-set" style="--i:5">
        <div class="pr-set__head">${Icons.svg('download')}<span class="pr-set__title">Descargas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Carpeta</div>
          <div class="pr-opt__path" id="s-dlpath">${esc(S.downloadsDir || '')}</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-dldir"><i data-icon="folder"></i> Cambiar</button></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Preguntar dónde guardar cada archivo</div></div>
          <div class="pr-opt__ctl">${toggle('askDownload', 'Preguntar')}</div></div>
      </section>

      <section class="pr-set" style="--i:6">
        <div class="pr-set__head">${Icons.svg('passKey')}<span class="pr-set__title">Contraseñas y tarjetas</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Completar contraseñas y tarjetas</div>
          <div class="pr-opt__hint">También ofrece guardar las contraseñas después de entrar. Todo se guarda cifrado con tu cuenta de Windows: el archivo copiado a otra compu, o leído desde otra cuenta, no se abre. Una página solo recibe las contraseñas de su propio sitio, y una tarjeta se completa solo en páginas seguras y cuando la elegís vos.</div></div>
          <div class="pr-opt__ctl">${toggle('passwords', 'Contraseñas')}</div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Tus contraseñas y tarjetas</div>
          <div class="pr-opt__hint">Buscar, editar, agregar notas o importar de Proton Pass. También desde la llave de la barra.</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-pass"><i data-icon="passKey"></i> Abrir</button></div></div>
        <div class="op-reveal pr-chipset" id="s-never"><div>
          <div class="pr-opt pr-opt--label"><div class="pr-opt__text"><div class="pr-opt__label">Nunca ofrecer guardar en</div></div></div>
          <div class="pr-chips"></div>
        </div></div>
      </section>

      <section class="pr-set" style="--i:7">
        <div class="pr-set__head">${Icons.svg('lock')}<span class="pr-set__title">Privacidad</span></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Borrar datos de navegación</div>
          <div class="pr-opt__hint">Historial, cookies y sesiones iniciadas, caché.</div></div>
          <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-clear"><i data-icon="trash"></i> Borrar…</button></div></div>
        <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Permisos de los sitios</div>
          <div class="pr-opt__hint" id="s-perms-hint"></div></div></div>
        <div class="pr-optlist" id="s-perms"></div>
        <div class="op-reveal" id="s-certs-head"><div><div class="pr-opt pr-opt--item"><div class="pr-opt__text"><div class="pr-opt__label">Certificados de tu red</div>
          <div class="pr-opt__hint">Aparatos de tu red (el router, un NAS) cuyo certificado aceptaste. Si el certificado cambia, Prism vuelve a preguntar. Olvidarlo hace que el sitio vuelva a dar error.</div></div></div></div></div>
        <div class="pr-optlist" id="s-certs"></div>
      </section>

      <section class="pr-set" style="--i:8">
        <div class="pr-set__head">${Icons.svg('keyboard')}<span class="pr-set__title">Atajos de teclado</span></div>
        <div class="pr-keys">${(S.info?.shortcuts || []).map(([what, combo]) => `<div>${esc(what)}</div><div>${kbdHTML(combo)}</div>`).join('')}</div>
      </section>

      <section class="pr-set" style="--i:9">
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
    segs.engine = bindSwitcher(col.querySelector('#s-engine'), (v) => save({ searchEngine: v }));
    segs.startup = bindSwitcher(col.querySelector('#s-startup'), (v) => save({ startup: v }));
    segs.sleep = bindSwitcher(col.querySelector('#s-sleep'), (v) => save({ sleepTabs: Number(v) }));
    sync({ first: true });
  }

  /** Un segmentado que cambió desde afuera: la cápsula viaja a la opción nueva. */
  function syncSeg(id, value, resync) {
    const seg = col.querySelector(id);
    let moved = false;
    seg.querySelectorAll('.op-segmented__opt').forEach((o) => {
      const on = o.dataset.value === String(value);
      if (o.classList.contains('is-active') !== on) moved = true;
      o.classList.toggle('is-active', on);
    });
    if (moved) resync?.();
  }

  /** Una lista de chips (sitios): se despliega si tiene alguno, y suma y saca de a uno. */
  function syncChips(id, list, attr, label, enter) {
    const set = col.querySelector(id);
    set.classList.toggle('is-open', list.length > 0);
    reconcile(set.querySelector('.pr-chips'), list.map((h) => ({ key: h, html: chipHTML(h, attr, label) })), { enter });
  }

  function sync({ first = false } = {}) {
    const s = S.settings;
    const enter = !first;   // la primera vez entra la página entera: las piezas no se anuncian solas
    col.querySelectorAll('[data-toggle]').forEach((b) => b.classList.toggle('is-on', isOn(s, b.dataset.toggle)));
    syncSeg('#s-engine', s.searchEngine, segs.engine);
    syncSeg('#s-startup', s.startup, segs.startup);
    syncSeg('#s-sleep', Number(s.sleepTabs), segs.sleep);

    syncChips('#s-allow', s.adblockAllow || [], 'data-unallow', 'Volver a bloquear', enter);
    syncChips('#s-never', s.passNever || [], 'data-unnever', 'Volver a ofrecer', enter);

    const relaunch = s.forceDark !== launchForceDark;
    col.querySelector('#s-relaunch-note').classList.toggle('is-open', relaunch);
    col.querySelector('#s-relaunch-wrap').classList.toggle('is-open', relaunch);
    col.querySelector('#s-relaunch').tabIndex = relaunch ? 0 : -1;

    const path = col.querySelector('#s-dlpath');
    if (first) path.textContent = S.downloadsDir || '';
    else swapText(path, S.downloadsDir || '');

    const perms = Object.entries(s.permissions || {});
    const hint = perms.length ? 'Lo que ya contestaste. Olvidarlo hace que el sitio vuelva a preguntar.' : 'Ningún sitio pidió permisos todavía. Cuando uno pida la cámara, el micrófono o tu ubicación, Prism te pregunta.';
    const hintEl = col.querySelector('#s-perms-hint');
    if (first) hintEl.textContent = hint;
    else swapText(hintEl, hint, { size: true });
    reconcile(col.querySelector('#s-perms'), perms.map(([origin, map]) => ({ key: origin, html: permRowHTML(origin, map) })), { enter });
    const certs = s.certAllow || [];
    col.querySelector('#s-certs-head').classList.toggle('is-open', certs.length > 0);
    reconcile(col.querySelector('#s-certs'), certs.map((c) => ({ key: c.host, html: certRowHTML(c) })), { enter });

    // Arrancar con Windows cambia de forma solo si cambia lo que Windows deja hacer.
    const auto = col.querySelector('.pr-auto');
    if (auto.dataset.key !== autostartKey()) {
      auto.dataset.key = autostartKey();
      swap(auto, autostartHTML(), { size: true });
    } else {
      auto.querySelectorAll('[data-autostart]').forEach((b) => b.classList.toggle('is-on', !!S.autostart?.on));
    }
    relayAllUpdate();
  }

  const toggleSeq = {};   // clave → número del último clic en su switch
  async function save(patch) {
    quietUntil = Date.now() + 600;
    S.settings = await api.settings.save(patch);
    sync();
  }
  /* Quitar un chip lo calcula el sistema sobre los ajustes al día: con la
     copia de acá, dos chips quitados rápido devolvían el primero. */
  async function removeFrom(key, value) {
    quietUntil = Date.now() + 600;
    S.settings = await api.settings.remove(key, value);
    sync();
  }

  col.addEventListener('click', async (e) => {
    const as = e.target.closest('[data-autostart]');
    if (as) {
      // Como los otros switches: se mueve ya, y solo la última respuesta lo acomoda.
      const on = as.classList.toggle('is-on');
      const seq = ++autostartSeq;
      try {
        S.autostart = await api.autostart.set(on);
      } catch (err) {
        say(`No se pudo cambiar el arranque con Windows: ${err.message}`, { icon: 'alert', tone: 'error' });
        S.autostart = await api.autostart.state().catch(() => S.autostart);
      }
      if (seq === autostartSeq) as.classList.toggle('is-on', !!S.autostart?.on);
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      // Se guarda lo que muestra el switch, no "lo contrario de S.settings":
      // en un doble clic la copia de acá todavía no cambió, y los dos clics
      // mandaban lo mismo — el switch quedaba al revés de lo guardado.
      const on = tg.classList.toggle('is-on');
      const k = tg.dataset.toggle;
      const seq = (toggleSeq[k] = (toggleSeq[k] || 0) + 1);
      quietUntil = Date.now() + 600;
      S.settings = await api.settings.save({ [k]: on });
      // Solo la respuesta del último clic acomoda la página: una vieja la haría parpadear.
      if (seq === toggleSeq[k]) sync();
      return;
    }
    const un = e.target.closest('[data-unallow]');
    if (un) return removeFrom('adblockAllow', un.dataset.unallow);
    const nv = e.target.closest('[data-unnever]');
    if (nv) return removeFrom('passNever', nv.dataset.unnever);
    const fg = e.target.closest('[data-forget]');
    if (fg) { await api.permissions.revoke(fg.dataset.forget); S.settings = await api.settings.get(); return sync(); }
    const uc = e.target.closest('[data-uncert]');
    if (uc) { await api.certs.forget(uc.dataset.uncert); S.settings = await api.settings.get(); return sync(); }
    const mk = e.target.closest('[data-dflt="make"]');
    if (mk && !mk.closest('[data-state="closing"]')) return makeDefault(mk);
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
    if (id === 's-pass') return openPasswords();
    if (id === 's-dldir') {
      const dir = await api.data.chooseFolder(S.downloadsDir).catch(() => null);
      if (dir) { quietUntil = Date.now() + 600; S.settings = await api.settings.save({ downloadDir: dir }); S.downloadsDir = await api.downloads.dir(); sync(); }
    }
  });

  build();
  refreshDefault();
  return { name: 'ajustes', el, refresh: () => sync() };
}

/* ══ Navegador predeterminado ════════════════════════════════════════════════
   Quién abre los links se le pregunta a Windows (default-browser.cjs). Se
   elige en una pantalla de Windows, fuera de Prism, y nadie avisa cuando
   cambia: por eso se vuelve a preguntar cuando la ventana recupera el foco.
   La fila cambia de estado EN SU LUGAR, con un relevo (la vieja se va, la
   nueva entra en la misma celda) y el alto yendo de uno al otro: un repintado
   de toda la página la haría saltar. */

/** Se tocó el botón y Windows todavía no dice que es Prism. */
let dfltWaiting = false;
let dfltAsking = null;

function defaultKey() {
  const d = S.defaultBrowser;
  if (!d) return 'unknown';
  if (!d.supported) return 'dev';
  if (d.isDefault) return 'default';
  return dfltWaiting ? 'waiting' : `not:${d.current || ''}`;
}

function defaultStateHTML(extra = '') {
  const d = S.defaultBrowser;
  const key = defaultKey();
  const btn = (label) => `<button class="op-btn op-btn--secondary op-btn--sm" data-dflt="make"><i data-icon="external"></i> ${label}</button>`;
  const others = 'los links que tocás en otras apps (WhatsApp, Discord, el mail)';
  let label = 'Abrir los links con Prism';
  let hint;
  let ctl = '';
  if (key === 'unknown') hint = 'Preguntándole a Windows…';
  else if (key === 'dev') hint = 'Se elige desde Prism instalado: esta copia corre desde el código, y Windows no tiene cómo abrirla.';
  else if (key === 'default') {
    label = 'Prism abre tus links';
    hint = 'Ahora los links que tocás en otras apps se abren acá.';
    ctl = `<span class="pr-dflt__ok">${Icons.svg('check')}Predeterminado</span>`;
  } else if (key === 'waiting') {
    /* Windows anota los navegadores nuevos en un índice que no se actualiza
       en el momento (default-browser.cjs): recién registrado, abre la lista
       general en vez de la página de Prism. */
    hint = 'En la pantalla de Windows, tocá «Establecer como predeterminado» arriba de todo. Si se abrió la lista general sin Prism, Windows todavía no lo anotó: probá de nuevo después de reiniciar la compu.';
    ctl = btn('Abrir de nuevo');
  } else {
    hint = `${d.current ? `Hoy ${others} se abren en ${esc(d.current)}.` : `Hoy ${others} no se abren en Prism.`} Windows no deja que un navegador se elija solo: el botón te lleva a la pantalla donde se elige.`;
    ctl = btn('Hacer predeterminado');
  }
  return `<div class="pr-opt pr-dflt__state${extra}" data-key="${esc(key)}">
      <div class="pr-opt__text"><div class="pr-opt__label">${label}</div><div class="pr-opt__hint">${hint}</div></div>
      ${ctl ? `<div class="pr-opt__ctl">${ctl}</div>` : ''}</div>`;
}

/** Lleva la fila al estado de ahora, si cambió. */
function relayDefault(stage) {
  const key = defaultKey();
  const cur = stage.querySelector('.pr-dflt__state:not([data-state="closing"])');
  if (cur?.dataset.key === key) return;
  const from = stage.offsetHeight;
  const tmp = document.createElement('div');
  tmp.innerHTML = defaultStateHTML(cur ? ' is-after' : '');
  const next = tmp.firstElementChild;
  Icons.mount(next);
  if (cur) exit(cur, { fallback: 220 });
  stage.appendChild(next);
  setTimeout(() => next.classList.add('is-settled'), 420);
  if (cur) resizeStage(stage, from, next);
}

/* De un alto al otro: con las dos filas en la celda, el alto es el de la más
   alta, y al irse la vieja saltaría al de la nueva. */
function resizeStage(stage, from, next) {
  const to = next.offsetHeight;
  if (Math.abs(to - from) < 2) return;
  stage.style.height = `${from}px`;
  void stage.offsetHeight;
  stage.classList.add('is-resizing');
  stage.style.height = `${to}px`;
  const done = () => {
    clearTimeout(timer);
    stage.removeEventListener('transitionend', onEnd);
    stage.classList.remove('is-resizing');
    stage.style.height = '';
  };
  const onEnd = (e) => { if (e.target === stage && e.propertyName === 'height') done(); };
  const timer = setTimeout(done, 500);
  stage.addEventListener('transitionend', onEnd);
}

const relayAllDefault = () => document.querySelectorAll('.pr-dflt').forEach(relayDefault);

/** Le pregunta a Windows quién abre los links y acomoda las filas a la vista. */
function refreshDefault() {
  if (dfltAsking) return dfltAsking;
  dfltAsking = api.defaultBrowser.state().then((d) => {
    S.defaultBrowser = d;
    if (d.isDefault && dfltWaiting) {
      dfltWaiting = false;
      say('Listo: Prism es tu navegador predeterminado.', { icon: 'check' });
    }
    relayAllDefault();
  }).catch((err) => console.error('[predeterminado]', err)).finally(() => { dfltAsking = null; });
  return dfltAsking;
}

async function makeDefault(btn) {
  btn.disabled = true;
  try {
    S.defaultBrowser = await api.defaultBrowser.make();
    dfltWaiting = !S.defaultBrowser.isDefault;
  } catch (err) {
    say(`No se pudo abrir la pantalla de Windows: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
  btn.disabled = false;
  relayAllDefault();
}

/* ══ Arrancar con Windows ═══════════════════════════════════════════════════
   Lo sabe Windows, no un ajuste (autostart.cjs): se puede apagar también
   desde Configuración → Aplicaciones → Inicio. Por eso se pregunta al abrir
   y cada vez que la ventana vuelve con Ajustes a la vista. */

let autostartSeq = 0;

const autostartKey = () => (S.autostart && !S.autostart.supported ? 'dev' : 'ok');

function autostartHTML() {
  const a = S.autostart;
  const hint = a && !a.supported
    ? 'Se prende desde Prism instalado: esta copia corre desde el código, y Windows no tiene cómo abrirla.'
    : 'Al iniciar sesión, Prism carga escondido en la bandeja: aparece al instante con un clic en su ícono o con Ctrl+Alt+P.';
  const ctl = a && !a.supported ? '' : `<div class="pr-opt__ctl"><button class="op-switch${a?.on ? ' is-on' : ''}" data-autostart aria-label="Arrancar con Windows"></button></div>`;
  return `<div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Arrancar con Windows</div>
      <div class="pr-opt__hint">${hint}</div></div>${ctl}</div>`;
}

/** Le pregunta a Windows y mueve el switch en su lugar (con su transición). */
function refreshAutostart() {
  return api.autostart.state().then((a) => {
    const was = S.autostart;
    S.autostart = a;
    if (was?.supported !== a.supported) return refresh(['ajustes']);
    document.querySelectorAll('[data-autostart]').forEach((b) => b.classList.toggle('is-on', a.on));
  }).catch((err) => console.error('[arranque]', err));
}

const settingsVisible = () => surfaces.some((sf) => sf.current?.name === 'ajustes');

/* La vuelta desde la pantalla de Windows. Si se esperaba el cambio, se
   pregunta otra vez un rato después: Windows puede anotarlo un instante
   después de que la persona ya volvió. */
function onWindowFocus() {
  if (settingsVisible()) refreshAutostart();
  if (!dfltWaiting && !settingsVisible()) return;
  refreshDefault().then(() => { if (dfltWaiting) setTimeout(refreshDefault, 1200); });
}

/* La fila de actualizaciones de "Acerca de". Se pone al día EN SU LUGAR
   (relayUpdate): el texto y el botón se relevan cuando cambia la fase, y el
   porcentaje de la descarga corre en vez de saltar de un número al otro. */
const updatePct = (u) => Math.max(0, Math.min(100, (u.pct || 0) * 100));

function updateHint(u) {
  const mb = u.bytes ? ` · ${fmtBytes(u.bytes)}` : '';
  const html = {
    unsupported: esc(u.reason || ''),
    idle: 'Se busca sola al abrir Prism y cada seis horas.',
    checking: 'Buscando…',
    current: `Estás en la última (${esc(u.current || '')}).`,
    available: `Hay una nueva: ${esc(u.name || u.version || '')}${mb}.`,
    downloading: `Descargando la ${esc(u.version || '')}… <span class="pr-upd__pct op-num">${Math.round(updatePct(u))} %</span>`,
    ready: `La ${esc(u.version || '')} está lista para instalarse.`,
    error: esc(u.error || 'No se pudo buscar.'),
  }[u.phase] || '';
  // La clave deja afuera el porcentaje: mientras baja, solo corre el número.
  return { key: u.phase === 'downloading' ? `downloading:${u.version}` : `${u.phase}:${html}`, html };
}

function updateBtn(u) {
  return {
    available: `${Icons.svg('download')} Descargar`,
    ready: `${Icons.svg('reload')} Reiniciar y actualizar`,
  }[u.phase] || `${Icons.svg('reload')} Buscar`;
}

const updateLocked = (u) => ['unsupported', 'checking', 'downloading'].includes(u.phase);

function updateRow() {
  const u = S.update || {};
  const hint = updateHint(u);
  return `<div class="pr-opt pr-upd" data-key="${esc(hint.key)}"><div class="pr-opt__text"><div class="pr-opt__label">Actualizaciones</div>
      <div class="pr-opt__hint pr-upd__hint">${hint.html}</div></div>
      <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" id="s-update" ${updateLocked(u) ? 'disabled' : ''}><span class="pr-upd__btn op-swap--row">${updateBtn(u)}</span></button></div></div>`;
}

function relayUpdate(row) {
  const u = S.update || {};
  const hint = updateHint(u);
  const box = row.querySelector('.pr-upd__hint');
  if (row.dataset.key !== hint.key) {
    row.dataset.key = hint.key;
    swap(box, hint.html, { size: true });
  } else if (u.phase === 'downloading') {
    const all = box.querySelectorAll('.pr-upd__pct');
    const n = all[all.length - 1];
    if (n) roll(n, updatePct(u), (v) => { n.textContent = `${Math.round(v)} %`; }, { from: parseFloat(n.textContent) });
  }
  row.querySelector('#s-update').disabled = updateLocked(u);
  swap(row.querySelector('.pr-upd__btn'), updateBtn(u), { size: true });
}

const relayAllUpdate = () => document.querySelectorAll('.pr-upd').forEach(relayUpdate);

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
  const done = await api.data.clear({ history: pick('history'), since, cookies: pick('cookies'), cache: pick('cache') }).catch((err) => { say(`No se pudo borrar: ${err.message}`, { icon: 'alert', tone: 'error' }); return null; });
  if (done?.length) say(`Borrado: ${done.join(', ')}`, { icon: 'check' });
}

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
  on('library', () => refresh(['nueva', 'historial', 'favoritos']));
  on('downloads', () => refresh(['descargas']));
  on('settings', () => {
    refresh(['ajustes'], () => Date.now() > quietUntil);
    for (const sf of surfaces) sf.current?.onSettings?.();
  });
  on('update', relayAllUpdate);
  render();
  refreshDefault();
  refreshAutostart();
  window.addEventListener('focus', onWindowFocus);
}

export { confirm };
