/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — tus equipos (la interfaz de src/link.cjs)
   La página prism://equipos: este equipo y su interruptor, lo que te mandaron
   y, de cada equipo emparejado, las pestañas que tiene abiertas. También el
   emparejado (mostrar un PIN acá, o escribir el del otro) y los ítems
   «Mandar a…» de los menús.

   La página se pone al día EN SU LUGAR: cada sección es una fila de un
   reconcile, y lo que cambia adentro (una pestaña que se abrió allá, el
   «visto hace…») se releva sin rehacer la sección.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, emit } from './state.js';
import { Icons } from './icons.js';
import { reconcile, swapText } from './motion.js';
import { esc, mark } from './ui.js';
import { relTime, plural } from './format.js';
import { menu, modal, confirm } from './layers.js';
import { say } from './status.js';
import { mountPage, favIcon, hostOf, wireFallbacks } from './pages.js';

export function init() {
  api.link.state().then(apply).catch(() => {});
  api.link.onState(apply);
  api.link.onArrived((it) => say(`${it.fromName} te mandó ${it.title || it.url}`, { icon: 'send', ms: 8000 }));
}

function apply(s) {
  S.link = s;
  emit('link');
}

const fail = (err) => say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '');

/* ── «Mandar a…» en los menús ────────────────────────────────────────────── */

/** Un ítem por equipo emparejado. Vacío si no hay ninguno o no es una página web. */
export function sendItems(url, title = '', what = '') {
  const L = S.link;
  if (!L?.enabled || !L.peers?.length || !/^https?:\/\//i.test(url || '')) return [];
  return L.peers.map((p) => ({
    label: `Mandar${what ? ` ${what}` : ''} a ${p.name}`,
    icon: 'send',
    onSelect: () => sendTo(p, url, title),
  }));
}

async function sendTo(p, url, title) {
  try {
    const r = await api.link.send(p.id, { url, title });
    say(r.queued ? `${p.name} no está conectado: le llega apenas se conecte` : `Se la mandaste a ${p.name}`, { icon: 'send', ms: 6000 });
  } catch (err) { fail(err); }
}

/** Abrir lo que te mandaron: una sola, directo; varias, la página. */
export function openInbox() {
  const inbox = S.link?.inbox || [];
  if (inbox.length === 1) api.link.open(inbox[0].id).catch(fail);
  else openDevicesPage();
}

function openDevicesPage() {
  const t = S.tabs.find((x) => x.internal === 'equipos');
  if (t) api.tabs.activate(t.id);
  else api.tabs.create('prism://equipos');
}

/* ── La página ───────────────────────────────────────────────────────────── */

const HINT_ON = 'Prism escucha en tu red de casa (y en Tailscale) para que tus otros Prism lo encuentren. Hay que prenderlo en los dos. La primera vez, Windows pregunta si lo deja pasar por el firewall: decile que sí en redes privadas.';

function meHTML(s) {
  const on = !!s.enabled;
  const where = s.error || (s.addresses?.length ? `En la red como ${s.addresses.join(' · ')}` : 'Sin red de casa a la vista');
  return `<section class="pr-set">
    <div class="pr-set__head">${Icons.svg('devices')}<span class="pr-set__title">Este equipo</span></div>
    <div class="pr-opt"><div class="pr-opt__text"><div class="pr-opt__label">Conectar con tus otros equipos</div>
      <div class="pr-opt__hint">${esc(HINT_ON)}</div></div>
      <div class="pr-opt__ctl"><button class="op-switch${on ? ' is-on' : ''}" data-act="toggle" aria-label="Conectar con tus otros equipos"></button></div></div>
    <div class="op-reveal${on ? ' is-open' : ''}" data-part="named"><div>
      <div class="pr-opt pr-opt--item"><div class="pr-opt__text"><div class="pr-opt__label" data-part="name">${esc(s.me?.name || '')}</div>
        <div class="pr-opt__hint${s.error ? ' op-field__hint--error' : ''}" data-part="where">${esc(where)}</div></div>
        <div class="pr-opt__ctl"><button class="op-btn op-btn--secondary op-btn--sm" data-act="rename"><i data-icon="edit"></i> Renombrar</button></div></div>
    </div></div>
  </section>`;
}

function updateMe(el, s) {
  const on = !!s.enabled;
  el.querySelector('[data-act="toggle"]').classList.toggle('is-on', on);
  el.querySelector('[data-part="named"]').classList.toggle('is-open', on);
  const name = el.querySelector('[data-part="name"]');
  if (name.textContent !== s.me?.name) swapText(name, s.me?.name || '');
  const where = el.querySelector('[data-part="where"]');
  const text = s.error || (s.addresses?.length ? `En la red como ${s.addresses.join(' · ')}` : 'Sin red de casa a la vista');
  where.classList.toggle('op-field__hint--error', !!s.error);
  if (where.textContent !== text) swapText(where, text);
}

/* Las filas de una lista: la clave es la dirección y cuántas veces vino
   antes (dos pestañas en el mismo sitio son dos filas). */
function keyed(list, keyOf) {
  const seen = new Map();
  return list.map((x) => {
    const k = keyOf(x);
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return { k: n ? `${k}#${n}` : k, x };
  });
}

function rowsOfInbox(s) {
  return s.inbox.map((it) => ({ key: it.id, html: `
    <div class="pr-row" data-inbox="${esc(it.id)}">
      <span class="pr-row__fav">${favIcon(it.url, null)}</span>
      <span class="pr-row__title">${esc(it.title || hostOf(it.url) || it.url)}</span>
      <span class="pr-row__host">${esc(`de ${it.fromName} · ${relTime(it.at)}`)}</span>
      <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-dismiss data-tip="Descartar">${Icons.svg('close')}</button></div>
    </div>` }));
}

function inboxHTML(s) {
  return `<section class="pr-set">
    <div class="pr-set__head">${Icons.svg('send')}<span class="pr-set__title">Te mandaron</span>
      <button class="op-btn op-btn--ghost op-btn--sm pr-set__end" data-act="clear">Descartar todas</button></div>
    <div class="pr-list pr-dev__list"></div>
  </section>`;
}

function peerState(p) {
  if (p.online) return `conectado · ${plural(p.tabs.length, 'pestaña abierta', 'pestañas abiertas')}`;
  return p.lastSeen ? `desconectado · visto ${relTime(p.lastSeen)}` : 'todavía no se conectó';
}

function rowsOfPeer(p) {
  if (!p.tabs.length) {
    return [{ key: 'empty', html: `<div class="pr-dev__empty">${p.online ? 'No tiene páginas abiertas.' : p.lastSeen ? 'No tenía páginas abiertas.' : 'Cuando se conecte, acá vas a ver lo que tiene abierto.'}</div>` }];
  }
  return keyed(p.tabs, (t) => t.url).map(({ k, x: t }) => ({ key: k, html: `
    <div class="pr-row" data-url="${esc(t.url)}" data-title="${esc(t.title)}">
      <span class="pr-row__fav">${favIcon(t.url, t.favicon)}</span>
      <span class="pr-row__title">${esc(t.title || hostOf(t.url) || t.url)}</span>
      <span class="pr-row__host">${esc(shortUrl(t.url))}</span>
    </div>` }));
}

function peerHTML(p) {
  return `<section class="pr-set" data-peer="${esc(p.id)}">
    <div class="pr-set__head">${mark(p.online ? 'running' : 'idle')}<span class="pr-set__title" data-part="name">${esc(p.name)}</span>
      <span class="pr-set__state" data-part="state">${esc(peerState(p))}</span>
      <button class="op-iconbtn op-iconbtn--sm pr-set__end" data-act="peer-more" aria-label="Más">${Icons.svg('more')}</button></div>
    <div class="op-reveal${p.pending ? ' is-open' : ''}" data-part="pending"><div><div class="pr-dev__note">${esc(pendingText(p))}</div></div></div>
    <div class="pr-list pr-dev__list"></div>
  </section>`;
}

const pendingText = (p) => (p.pending ? `${plural(p.pending, 'página espera', 'páginas esperan')} a que se conecte para llegarle` : '');

function updatePeer(el, p) {
  el.querySelector('.op-mark').dataset.state = p.online ? 'running' : 'idle';
  const name = el.querySelector('[data-part="name"]');
  if (name.textContent !== p.name) swapText(name, p.name);
  const st = el.querySelector('[data-part="state"]');
  if (st.textContent !== peerState(p)) swapText(st, peerState(p));
  const pend = el.querySelector('[data-part="pending"]');
  pend.classList.toggle('is-open', !!p.pending);
  if (p.pending) {
    const note = pend.querySelector('.pr-dev__note');
    if (note.textContent !== pendingText(p)) swapText(note, pendingText(p));
  }
  reconcile(el.querySelector('.pr-dev__list'), rowsOfPeer(p), { created: wireFallbacks, height: true });
}

const NONE_HTML = `<div class="op-empty pr-dev__none">${Icons.svg('laptop')}
  <div class="op-empty__title">Todavía no emparejaste ningún equipo</div>
  <div class="op-empty__text">Prendé la conexión también en el otro Prism y tocá «Emparejar un equipo»: uno muestra un PIN y el otro lo escribe.</div></div>`;

/* reconcile pone al día una sección cuando cambia su html. Lo de adentro
   (las filas) no está en ese html: la huella de sus datos va como atributo,
   así un cambio en las pestañas del otro equipo también la despierta. */
function print(data) {
  const str = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const signed = (html, data) => html.replace('<section ', `<section data-sig="${print(data)}" `);

function sections(s) {
  const out = [{ key: 'me', kind: 'me', html: signed(meHTML(s), [s.enabled, s.me, s.addresses, s.error]) }];
  if (!s.enabled) return out;
  if (s.inbox.length) out.push({ key: 'inbox', kind: 'inbox', html: signed(inboxHTML(s), s.inbox) });
  for (const p of s.peers) out.push({ key: `peer:${p.id}`, kind: 'peer', peer: p, html: signed(peerHTML(p), p) });
  if (!s.peers.length) out.push({ key: 'none', kind: 'none', html: NONE_HTML });
  return out;
}

export function devicesPage() {
  const el = mountPage(`
    <div class="op-scroll op-scroll--line-top op-scroll--line-bottom pr-view__scroll"><div class="pr-view__col">
      <div class="pr-head">
        <div class="pr-head__text"><div class="pr-head__title">Tus equipos</div><div class="pr-head__sub" id="d-sub"></div></div>
        <div class="pr-head__actions">
          <button class="op-btn op-btn--secondary op-flashable" id="d-pair"><i data-icon="plus"></i> Emparejar un equipo</button>
        </div>
      </div>
      <div class="pr-dev" id="d-body"></div>
    </div></div>`, 'equipos');

  const body = el.querySelector('#d-body');
  const sub = el.querySelector('#d-sub');
  const pairBtn = el.querySelector('#d-pair');
  let painted = false;

  /* Cada sección, después de nacer o de cambiar, pone al día sus partes. */
  function fill(sec, it, s) {
    if (it.kind === 'me') updateMe(sec, s);
    else if (it.kind === 'inbox') reconcile(sec.querySelector('.pr-dev__list'), rowsOfInbox(s), { created: wireFallbacks, height: true });
    else if (it.kind === 'peer') updatePeer(sec, it.peer);
  }

  function paint() {
    const s = S.link;
    if (!s?.ready) return;
    const subText = s.enabled
      ? `Este equipo es ${s.me.name} · ${s.peers.length ? plural(s.peers.length, 'equipo emparejado', 'equipos emparejados') : 'sin equipos emparejados'}`
      : 'Mandá pestañas, mirá las abiertas en tus otros Prism y compartí los favoritos';
    if (painted) { if (sub.textContent !== subText) swapText(sub, subText); } else sub.textContent = subText;
    pairBtn.disabled = !s.enabled;
    if (s.enabled) pairBtn.removeAttribute('data-tip'); else pairBtn.dataset.tip = 'Prendé la conexión primero';
    const items = sections(s);
    reconcile(body, items, {
      enter: painted,
      update: (sec, it) => fill(sec, it, s),
      created: (sec, it) => fill(sec, it, s),
    });
    painted = true;
  }

  pairBtn.addEventListener('click', () => menu(pairBtn, [
    { label: 'Mostrar un PIN en este equipo', icon: 'devices', onSelect: showPinModal },
    { label: 'Escribir el PIN de otro equipo', icon: 'laptop', onSelect: enterPinModal },
  ], { align: 'end' }));

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') { api.link.enable(!S.link?.enabled).catch(fail); return; }
    if (act === 'rename') { renameModal(); return; }
    if (act === 'clear') { api.link.clear().catch(fail); return; }
    if (act === 'peer-more') {
      e.stopPropagation();
      const id = e.target.closest('[data-peer]')?.dataset.peer;
      const p = S.link?.peers.find((x) => x.id === id);
      if (!p) return;
      menu(e.target.closest('[data-act]'), [
        { label: 'Olvidar este equipo', icon: 'trash', danger: true, onSelect: () => forget(p) },
      ], { align: 'end' });
      return;
    }
    const inbox = e.target.closest('[data-inbox]');
    if (inbox) {
      const id = inbox.dataset.inbox;
      (e.target.closest('[data-dismiss]') ? api.link.dismiss(id) : api.link.open(id)).catch(fail);
      return;
    }
    const row = e.target.closest('.pr-row[data-url]');
    if (row) api.tabs.create(row.dataset.url, { active: !e.ctrlKey });
  });
  el.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.pr-row[data-url]');
    if (row && e.button === 1) api.tabs.create(row.dataset.url, { active: false });
  });
  // Una pestaña de otro equipo también se puede mandar a un tercero, o copiar.
  el.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.pr-row[data-url]');
    if (!row) return;
    e.preventDefault();
    menu(row, [
      { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: () => api.tabs.create(row.dataset.url) },
      { label: 'Abrir en segundo plano', icon: 'tabs', onSelect: () => api.tabs.create(row.dataset.url, { active: false }) },
    ], { align: 'start' });
  });

  paint();
  return { name: 'equipos', el, refresh: paint };
}

async function forget(p) {
  const si = await confirm({
    title: `¿Olvidar ${p.name}?`,
    sub: 'Dejan de verse y de compartir favoritos, de los dos lados. Para volver a conectarlos, hay que emparejarlos de nuevo.',
    confirmLabel: 'Olvidar',
    danger: true,
  });
  if (si) api.link.forget(p.id).then(() => say(`${p.name} quedó olvidado`, { icon: 'check' })).catch(fail);
}

async function renameModal() {
  const body = document.createElement('div');
  body.className = 'op-col';
  body.innerHTML = `<div class="op-field"><label class="op-field__label">Nombre de este equipo</label>
    <input class="op-input" id="d-name" spellcheck="false" maxlength="40">
    <div class="op-field__hint" id="d-name-msg">Así lo ven tus otros equipos en sus menús.</div></div>`;
  const input = body.querySelector('#d-name');
  input.value = S.link?.me?.name || '';
  const msg = body.querySelector('#d-name-msg');
  await modal({
    title: 'Renombrar este equipo',
    body,
    width: 420,
    actions: [{ label: 'Cancelar', value: false }, {
      label: 'Guardar', value: true, variant: 'primary',
      guard: async () => {
        try { await api.link.rename(input.value); return true; } catch (err) {
          msg.classList.add('op-field__hint--error');
          swapText(msg, err.message);
          return false;
        }
      },
    }],
  });
}

/* ── Emparejar ───────────────────────────────────────────────────────────── */

/** Este equipo muestra un PIN; se cierra solo cuando el otro lo manda bien. */
async function showPinModal() {
  const before = new Set((S.link?.peers || []).map((p) => p.id));
  const body = document.createElement('div');
  body.className = 'op-col pr-pinbox';
  body.innerHTML = `
    <div class="pr-pin" id="d-pin" aria-live="polite"></div>
    <div class="pr-pin__bar"><div class="pr-pin__fill" id="d-pin-fill"></div></div>
    <div class="op-field__hint pr-pin__hint" id="d-pin-msg"></div>`;
  const pinEl = body.querySelector('#d-pin');
  const fillEl = body.querySelector('#d-pin-fill');
  const msg = body.querySelector('#d-pin-msg');
  const ctl = new AbortController();
  let pinned = null;
  let done = false;
  let off = null;

  /* La barra se vacía sola hasta que vence: una sola transición lineal, no un
     contador que cambia cada segundo. */
  function drain(until) {
    const left = Math.max(0, until - Date.now());
    fillEl.style.transition = 'none';
    fillEl.style.transform = `scaleX(${Math.min(1, left / 120000)})`;
    void fillEl.offsetWidth;
    fillEl.style.transition = `transform ${left}ms linear`;
    fillEl.style.transform = 'scaleX(0)';
  }

  async function fresh() {
    try {
      pinned = await api.link.openPairing();
    } catch (err) { fail(err); ctl.abort(); return; }
    const text = `${pinned.pin.slice(0, 3)} ${pinned.pin.slice(3)}`;
    if (pinEl.textContent) swapText(pinEl, text); else pinEl.textContent = text;
    body.classList.remove('is-expired');
    const where = S.link?.addresses?.length ? ` (${S.link.addresses[0]})` : '';
    swapText(msg, `En el otro equipo elegí ${S.link?.me?.name || 'este equipo'}${where} y escribí este PIN. Vence a los 2 minutos.`, { size: true });
    drain(pinned.until);
  }

  const watch = () => {
    const s = S.link;
    const nuevo = s?.peers.find((p) => !before.has(p.id));
    if (nuevo) {
      say(`Emparejado con ${nuevo.name}`, { icon: 'check', ms: 6000 });
      done = true;
      ctl.abort();
      return;
    }
    // Venció, o se gastaron los intentos: se ofrece otro.
    if (pinned && !s?.pairing && !body.classList.contains('is-expired')) {
      body.classList.add('is-expired');
      swapText(msg, 'El PIN venció (o se equivocaron cinco veces). Pedí otro para seguir.', { size: true });
    }
  };

  fresh();
  off = on('link', watch);
  const r = await modal({
    title: 'Mostrar un PIN',
    sub: 'Para emparejar otro Prism con este. Mientras se ve, este equipo espera.',
    body,
    width: 440,
    signal: ctl.signal,
    actions: [
      { label: 'Cancelar', value: false },
      { label: 'Otro PIN', value: 'again', variant: 'secondary', guard: async () => { await fresh(); return false; } },
    ],
  });
  off?.();
  if (!done && r !== 'again') api.link.closePairing().catch(() => {});
}

/** Este equipo escribe el PIN que muestra el otro. */
async function enterPinModal() {
  const body = document.createElement('div');
  body.className = 'op-col';
  body.style.gap = '14px';
  body.innerHTML = `
    <div class="op-field"><div class="op-row pr-found__head"><label class="op-field__label op-grow">Equipo</label>
        <button class="op-btn op-btn--ghost op-btn--sm" id="d-seek"><i data-icon="reload"></i> Buscar de nuevo</button></div>
      <div class="pr-found" id="d-found"></div>
      <div class="op-reveal" id="d-other"><div><input class="op-input op-input--mono" id="d-addr" placeholder="192.168.1.20 o 100.64.0.5" spellcheck="false"></div></div></div>
    <div class="op-field"><label class="op-field__label">PIN</label>
      <input class="op-input op-input--mono pr-pin__input" id="d-code" inputmode="numeric" maxlength="7" placeholder="000 000" spellcheck="false" autocomplete="off">
      <div class="op-field__hint" id="d-msg">El que muestra el otro equipo en «Mostrar un PIN en este equipo».</div></div>`;
  const list = body.querySelector('#d-found');
  const other = body.querySelector('#d-other');
  const addr = body.querySelector('#d-addr');
  const code = body.querySelector('#d-code');
  const msg = body.querySelector('#d-msg');
  const seekBtn = body.querySelector('#d-seek');
  let found = [];
  let chosen = 'other';
  let searching = false;

  const say2 = (t, error) => { msg.classList.toggle('op-field__hint--error', !!error); swapText(msg, t, { size: true }); };

  function paintFound() {
    const opts = found.map((f) => ({ key: f.id, html: `
      <button class="pr-found__opt${chosen === f.id ? ' is-selected' : ''}" data-pick="${esc(f.id)}">
        ${Icons.svg('laptop')}<span class="pr-found__name">${esc(f.name)}</span>
        <span class="pr-found__addr">${esc(f.paired ? 'ya emparejado' : f.address)}</span></button>` }));
    opts.push({ key: 'other', html: `
      <button class="pr-found__opt${chosen === 'other' ? ' is-selected' : ''}" data-pick="other">
        ${Icons.svg('edit')}<span class="pr-found__name">${searching && !found.length ? 'Buscando en tu red…' : found.length ? 'Otra dirección' : 'No apareció ninguno: escribí la dirección'}</span></button>` });
    reconcile(list, opts, { height: true });
    other.classList.toggle('is-open', chosen === 'other');
  }

  async function seek() {
    searching = true;
    seekBtn.disabled = true;
    paintFound();
    found = await api.link.discover().catch(() => []);
    searching = false;
    seekBtn.disabled = false;
    // Si apareció uno solo sin emparejar, queda elegido.
    const free = found.filter((f) => !f.paired);
    if (chosen === 'other' && !addr.value && free.length === 1) chosen = free[0].id;
    paintFound();
  }

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    chosen = b.dataset.pick;
    paintFound();
    (chosen === 'other' ? addr : code).focus();
  });
  seekBtn.addEventListener('click', seek);
  // Se escribe como se lee: 123 456.
  code.addEventListener('input', () => {
    const d = code.value.replace(/\D/g, '').slice(0, 6);
    const v = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    if (code.value !== v) code.value = v;
  });
  body.addEventListener('input', () => { if (msg.classList.contains('op-field__hint--error')) say2('El que muestra el otro equipo en «Mostrar un PIN en este equipo».', false); });

  paintFound();
  seek();
  let paired = null;
  const ok = await modal({
    title: 'Escribir el PIN de otro equipo',
    sub: 'Antes, en el otro Prism, andá a Tus equipos, tocá «Emparejar un equipo» y elegí «Mostrar un PIN en este equipo».',
    body,
    width: 460,
    actions: [{ label: 'Cancelar', value: false }, {
      label: 'Emparejar', value: true, variant: 'primary',
      guard: async () => {
        const pin = code.value.replace(/\D/g, '');
        const f = found.find((x) => x.id === chosen);
        const address = f ? f.address : addr.value.trim();
        if (!address) { say2('Elegí el equipo, o escribí su dirección.', true); return false; }
        if (pin.length !== 6) { say2('El PIN son 6 números.', true); return false; }
        try {
          paired = await api.link.pair(address, pin, f?.port);
          return true;
        } catch (err) { say2(err.message, true); return false; }
      },
    }],
  });
  if (ok && paired) say(`Emparejado con ${paired.name}`, { icon: 'check', ms: 6000 });
}
