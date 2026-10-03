/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — contraseñas (el panel)
   Una hoja colgada de la llave de la barra, en dos columnas: la lista con su
   buscador a la izquierda y el elemento a la derecha (usuario, contraseña,
   sitios, nota y cuándo se usó). Editar, agregar, borrar e importar pasan
   adentro de la misma hoja: un menú o un modal de Opal la cerrarían.

   Las contraseñas no viven acá. La lista llega sin ellas; ver una es pedirla
   (y se olvida al cambiar de elemento), y copiar la copia el proceso
   principal, que además la saca del portapapeles a los 45 s.

   Las tarjetas viven en la misma hoja, del otro lado del segmentado de
   arriba de la lista. Igual que con las contraseñas: la lista trae la marca
   y los últimos cuatro, y el número, el código y el PIN se piden de a uno.

   También vive acá el "¿guardar la contraseña?" que llega después de un login.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api } from './state.js';
import { Icons } from './icons.js';
import { esc } from './ui.js';
import { plural } from './format.js';
import { popover, popoverOpen, closePopover } from './layers.js';
import { say } from './status.js';
import { scrollFade, bindSwitcher, reconcile, swap, swapText, dissolve } from './motion.js';

let btn;

const P = {
  items: [],
  broken: null,
  kind: 'login',         // login · card: qué lado de la hoja se mira
  selBy: {},             // lo elegido en cada lado, para volver a encontrarlo
  q: '',
  sel: null,
  mode: 'view',          // view · edit · new
  revealed: null,        // { id, values: { campo: valor } } mientras se ve algo secreto
  confirmDel: false,
  banner: null,          // resultado de una importación
};

let root = null;         // el .pr-pass del panel abierto

/* ── Formato ─────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** "Hoy a las 06:53" · "Ayer a las 06:53" · "22 feb 2026, 17:50". */
function when(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return `Hoy a las ${hm}`;
  if (diff === 1) return `Ayer a las ${hm}`;
  return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}, ${hm}`;
}

const loginOf = (it) => it.username || it.email || '';
const letter = (it) => (it.host || it.title || '?').replace(/^www\./, '').charAt(0).toUpperCase();

const BRANDS = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', naranja: 'Naranja', cabal: 'Cabal',
  maestro: 'Maestro', diners: 'Diners Club', discover: 'Discover',
};
const isCard = (it) => it?.kind === 'card';
/** "2029-08" → "08/29". */
const shortExpiry = (e) => (e ? `${e.slice(5, 7)}/${e.slice(2, 4)}` : '');
/** De a cuatro, y la American Express en 4-6-5, como viene impresa. */
function groupNumber(n) {
  const s = String(n || '');
  if (/^3[47]/.test(s) && s.length === 15) return `${s.slice(0, 4)} ${s.slice(4, 10)} ${s.slice(10)}`;
  return s.replace(/(\d{4})(?=\d)/g, '$1 ');
}
/** "Visa · termina en 4242", lo que identifica una tarjeta sin mostrarla. */
const cardLine = (it) => [BRANDS[it.brand], it.last4 && `termina en ${it.last4}`].filter(Boolean).join(' · ') || 'Sin número';

function tile(it, big = false) {
  const cls = `pr-pass__tile${big ? ' pr-pass__tile--lg' : ''}`;
  if (isCard(it)) return `<span class="${cls} pr-pass__tile--card">${Icons.svg('card')}</span>`;
  return it.favicon
    ? `<span class="${cls}"><img src="${esc(it.favicon)}" alt="" draggable="false"></span>`
    : `<span class="${cls}"><span class="pr-pass__letter">${esc(letter(it))}</span></span>`;
}

/* ── Datos ───────────────────────────────────────────────────────────────── */

async function load() {
  const r = await api.pass.list().catch(() => ({ items: [], broken: null }));
  P.items = r.items || [];
  P.broken = r.broken || null;
  if (P.sel && !P.items.some((it) => it.id === P.sel)) P.sel = null;
}

const ofKind = () => P.items.filter((it) => (P.kind === 'card') === isCard(it));

function filtered() {
  const q = P.q.trim().toLowerCase();
  const list = ofKind();
  if (!q) return list;
  return list.filter((it) => [it.title, it.host, it.username, it.email, it.holder, BRANDS[it.brand], it.last4, it.note, ...(it.urls || [])]
    .some((s) => String(s || '').toLowerCase().includes(q)));
}

const selected = () => P.items.find((it) => it.id === P.sel) || null;

/* ── El panel ────────────────────────────────────────────────────────────── */

export async function openPanel() {
  if (popoverOpen(btn)) { closePopover(); return; }
  await load();
  if (!filtered().some((it) => it.id === P.sel)) P.sel = filtered()[0]?.id || null;
  P.mode = ofKind().length ? 'view' : P.mode === 'new' ? 'new' : 'view';
  P.revealed = null;
  P.confirmDel = false;
  const width = Math.min(720, window.innerWidth - 24);
  popover(btn, (el) => {
    if (el.dataset.built) return;
    el.dataset.built = '1';
    el.classList.add('pr-pop--pass');
    const card = P.kind === 'card';
    el.innerHTML = `
      <div class="pr-pass">
        <aside class="pr-pass__side">
          <div class="pr-pass__kinds"><div class="op-segmented" id="pp-kind">
            <button class="op-segmented__opt${card ? '' : ' is-active'}" data-value="login">${Icons.svg('passKey')} Contraseñas</button>
            <button class="op-segmented__opt${card ? ' is-active' : ''}" data-value="card">${Icons.svg('card')} Tarjetas</button>
          </div></div>
          <div class="pr-pass__top">
            <div class="op-inputwrap pr-pass__search"><i data-icon="search"></i>
              <input class="op-input" id="pp-q" type="text" spellcheck="false" autocomplete="off" placeholder="Buscar" aria-label="Buscar"></div>
            <button class="op-iconbtn op-iconbtn--sm" id="pp-new" aria-label="Agregar" data-tip="${card ? 'Agregar una tarjeta' : 'Agregar una contraseña'}"><i data-icon="plus"></i></button>
          </div>
          <div class="pr-pass__list op-scroll op-scroll--line-bottom" id="pp-list" role="listbox"></div>
          <div class="pr-pass__foot">
            <span class="op-meta op-grow op-truncate" id="pp-count"></span>
            <button class="op-btn op-btn--ghost op-btn--sm" id="pp-import"><i data-icon="download"></i> Importar</button>
          </div>
        </aside>
        <section class="pr-pass__main" id="pp-main"></section>
      </div>`;
    root = el.querySelector('.pr-pass');
    // Un ícono que no carga (el sitio no tiene, o devuelve otra cosa) cede su lugar a la inicial.
    root.addEventListener('error', (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG' || !img.parentElement?.classList.contains('pr-pass__tile')) return;
      const it = P.items.find((x) => x.favicon === img.getAttribute('src'));
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'pr-pass__letter', textContent: it ? letter(it) : '' }));
    }, true);
    wire(el);
    paintList();
    paintMain();
    const q = el.querySelector('#pp-q');
    q.value = P.q;
    setTimeout(() => q.focus(), 0);
  }, { width, onClose: () => { root = null; P.revealed = null; } });
}

function paintList() {
  if (!root) return;
  const list = root.querySelector('#pp-list');
  const items = filtered();
  const all = ofKind().length;
  swapText(root.querySelector('#pp-count'), all ? (P.kind === 'card' ? plural(all, 'tarjeta', 'tarjetas') : plural(all, 'contraseña', 'contraseñas')) : '');
  /* Fila por fila (motion.js): al buscar, las que siguen coincidiendo se
     quedan y se acomodan, las otras se van; rehecha entera, la lista
     parpadeaba con cada letra. */
  reconcile(list, items.length
    ? items.map((it) => ({ key: it.id, html: `
      <button class="pr-pass__row${it.id === P.sel ? ' is-selected' : ''}" data-id="${esc(it.id)}" role="option" aria-selected="${it.id === P.sel}">
        ${tile(it)}
        <span class="pr-pass__rowtext"><span class="pr-pass__rowtitle">${esc(it.title)}</span>
          <span class="pr-pass__rowsub">${esc(isCard(it) ? cardLine(it) : loginOf(it) || it.host || 'Sin usuario')}</span></span>
      </button>` }))
    : [{ key: `none:${all ? 'q' : 'empty'}`, html: `<div class="pr-pass__none">${all ? 'Nada coincide con la búsqueda.' : 'Todavía no hay nada.'}</div>` }]);
}

/** Marca la fila elegida sin repintar la lista (así no salta el scroll). */
function markSelected() {
  root?.querySelectorAll('.pr-pass__row').forEach((r) => {
    const on = r.dataset.id === P.sel;
    r.classList.toggle('is-selected', on);
    r.setAttribute('aria-selected', String(on));
    if (on) r.scrollIntoView({ block: 'nearest' });
  });
}

function paintMain() {
  if (!root) return;
  const main = root.querySelector('#pp-main');
  const it = selected();
  let html = '';
  if (P.banner) html += bannerHTML();
  if (P.broken) html += `<div class="pr-pass__warn">${Icons.svg('alert')}<div>No se pudo abrir la bóveda guardada (${esc(P.broken)}). Para no pisarla, Prism no guarda cambios hasta que se resuelva.</div></div>`;

  const card = P.kind === 'card';
  if (P.mode === 'new' || (P.mode === 'edit' && it)) html += (card ? cardFormHTML : formHTML)(P.mode === 'edit' ? it : null);
  else if (!ofKind().length) html += welcomeHTML();
  else if (it) html += (card ? cardHTML : detailHTML)(it);
  else html += `<div class="pr-pass__empty"><i data-icon="${card ? 'card' : 'passKey'}"></i><div>Elegí un elemento de la lista.</div></div>`;

  /* Un fundido (motion.js): lo nuevo ya está quieto debajo y lo de antes,
     opaco y encima, se esfuma. Cambiado de un cuadro al otro, elegir otro
     elemento, editar o cancelar era un corte. */
  const old = main.querySelector('.pr-pass__view:not([data-state="closing"])');
  const view = document.createElement('div');
  view.className = `pr-pass__view op-scroll${old ? ' is-quiet' : ''}`;
  view.id = 'pp-view';
  view.innerHTML = html;
  Icons.mount(view);
  if (old) dissolve(old);
  main.prepend(view);
  scrollFade(view);
  if (P.mode !== 'view') view.querySelector('input')?.focus();
  if (P.mode === 'edit' && it) fillSecrets(it);
}

function welcomeHTML() {
  const card = P.kind === 'card';
  return `
    <div class="pr-pass__welcome">
      <div class="pr-pass__hero">${Icons.svg(card ? 'card' : 'passKey')}</div>
      <div class="pr-pass__welcometitle">${card ? 'Tus tarjetas, adentro de Prism' : 'Tus contraseñas, adentro de Prism'}</div>
      <div class="pr-pass__welcometext">${card
        ? 'Al pagar, Prism completa el número, el vencimiento y el código, también adentro del recuadro de Mercado Pago o de Stripe. Se guardan cifradas con tu cuenta de Windows.'
        : 'Cuando entres a un sitio, Prism te ofrece guardarla, y la próxima vez la completa. Se guardan cifradas con tu cuenta de Windows.'}</div>
      <div class="pr-pass__welcomeactions">
        <button class="op-btn op-btn--primary" data-a="import"><i data-icon="download"></i> Importar de Proton Pass</button>
        <button class="op-btn op-btn--secondary" data-a="new"><i data-icon="plus"></i> Agregar una</button>
      </div>
    </div>`;
}

function bannerHTML() {
  const b = P.banner;
  const logins = b.added - (b.cards || 0);
  const parts = [logins && plural(logins, 'contraseña', 'contraseñas'), b.cards && plural(b.cards, 'tarjeta', 'tarjetas')].filter(Boolean);
  return `
    <div class="pr-pass__banner">
      <div class="pr-pass__bannerhead">${Icons.svg('check')}<span>${b.added ? `Se importaron ${parts.join(' y ')}` : 'No había nada nuevo para importar'}${b.repeated ? ` · ${plural(b.repeated, 'ya estaba', 'ya estaban')}` : ''}</span></div>
      <div class="pr-pass__bannertext">El archivo <b>${esc(b.file)}</b> tiene tus datos sin cifrar. Ya no hace falta: conviene borrarlo.</div>
      <div class="pr-pass__banneractions">
        <button class="op-btn op-btn--ghost op-btn--sm" data-a="banner-close">Lo borro yo</button>
        <button class="op-btn op-btn--secondary op-btn--sm" data-a="forget-import"><i data-icon="trash"></i> Borrar el archivo</button>
      </div>
    </div>`;
}

/** Lo que se ve de un secreto: tapado (los puntos dibujados, y en el número los últimos cuatro) o él. */
function secretHTML(it, f) {
  const v = P.revealed?.id === it.id ? P.revealed.values[f] : null;
  if (v != null) return `<span class="pr-pass__secret">${esc(f === 'number' ? groupNumber(v) : v)}</span>`;
  if (f === 'number') return `<span class="pr-pass__dots pr-pass__dots--4"></span> ${esc(it.last4)}`;
  return `<span class="pr-pass__dots${f === 'password' ? '' : ' pr-pass__dots--4'}"></span>`;
}

function field(label, icon, value, { copy = null, mono = false, secret = null } = {}) {
  const shown = !!secret && P.revealed?.id === P.sel && P.revealed.values[secret] != null;
  return `
    <div class="pr-pass__field">
      <span class="pr-pass__fieldicon">${Icons.svg(icon)}</span>
      <div class="pr-pass__fieldbody">
        <div class="pr-pass__label">${esc(label)}</div>
        <div class="pr-pass__value${mono ? ' is-mono' : ''}${secret ? ' is-secret' : ''}"${secret ? ` id="pp-secret-${secret}"` : ''}>${value}</div>
      </div>
      ${secret ? `<button class="op-iconbtn op-iconbtn--sm pr-pass__eye${shown ? ' is-on' : ''}" data-a="reveal" data-f="${secret}" aria-label="Mostrar" data-tip="${shown ? 'Ocultar' : 'Mostrar'}">${Icons.svg('eye', 'pr-eye__a')}${Icons.svg('eyeOff', 'pr-eye__b')}</button>` : ''}
      ${copy ? `<button class="op-iconbtn op-iconbtn--sm pr-pass__copy" data-copy="${copy}" aria-label="Copiar" data-tip="Copiar">${Icons.svg('copy', 'pr-copy__a')}${Icons.svg('check', 'pr-copy__b')}</button>` : ''}
    </div>`;
}

/** La cabecera de un elemento: baldosa, título, editar y borrar (con su confirmación). */
function headHTML(it, sub) {
  return `
    <div class="pr-pass__head">
      ${tile(it, true)}
      <div class="pr-pass__headtext">
        <div class="pr-pass__title op-copyable">${esc(it.title)}</div>
        ${sub ? `<div class="pr-pass__sub">${esc(sub)}</div>` : ''}
      </div>
      <button class="op-btn op-btn--secondary op-btn--sm" data-a="edit"><i data-icon="edit"></i> Editar</button>
      <button class="op-iconbtn op-iconbtn--sm pr-pass__del${P.confirmDel ? ' is-open' : ''}" data-a="delete" aria-label="Eliminar" data-tip="Eliminar"><i data-icon="trash"></i></button>
    </div>
    <div class="pr-pass__confirm${P.confirmDel ? ' is-open' : ''}"><div class="pr-pass__confirminner"><div class="pr-pass__confirmrow">
      <span class="op-grow">¿Eliminar <b>${esc(it.title)}</b>? No se puede deshacer.</span>
      <button class="op-btn op-btn--ghost op-btn--sm" data-a="delete-no">Cancelar</button>
      <button class="op-btn op-btn--danger-solid op-btn--sm" data-a="delete-yes">Eliminar</button>
    </div></div></div>`;
}

/** La nota y las fechas, iguales en las dos clases. */
function tailHTML(it, usedLabel) {
  const meta = [
    it.lastUsedAt && ['wand', usedLabel, when(it.lastUsedAt)],
    ['edit', 'Última modificación', when(it.modifiedAt)],
    ['zap', 'Creado', when(it.createdAt)],
  ].filter(Boolean);
  return `
    ${it.note ? `<div class="pr-pass__card"><div class="pr-pass__field pr-pass__field--top">
      <span class="pr-pass__fieldicon">${Icons.svg('note')}</span>
      <div class="pr-pass__fieldbody"><div class="pr-pass__label">Nota</div>
        <div class="pr-pass__note op-copyable">${esc(it.note)}</div></div>
    </div></div>` : ''}

    <div class="pr-pass__card pr-pass__card--meta">${meta.map(([icon, label, v]) => `
      <div class="pr-pass__field pr-pass__field--meta">
        <span class="pr-pass__fieldicon">${Icons.svg(icon)}</span>
        <div class="pr-pass__fieldbody"><div class="pr-pass__metalabel">${esc(label)}</div><div class="pr-pass__metavalue op-copyable">${esc(v)}</div></div>
      </div>`).join('')}</div>`;
}

function detailHTML(it) {
  const fields = [];
  if (it.username) fields.push(field('Usuario', 'user', esc(it.username), { copy: 'username' }));
  if (it.email) fields.push(field('Correo', 'mail', esc(it.email), { copy: 'email' }));
  fields.push(it.hasPassword
    ? field('Contraseña', 'passKey', secretHTML(it, 'password'), { copy: 'password', secret: 'password' })
    : field('Contraseña', 'passKey', '<span class="pr-pass__muted">Ninguna</span>'));

  return `
    ${headHTML(it, it.host)}
    <div class="pr-pass__card">${fields.join('')}</div>

    ${it.urls?.length ? `<div class="pr-pass__card"><div class="pr-pass__field pr-pass__field--top">
      <span class="pr-pass__fieldicon">${Icons.svg('globe')}</span>
      <div class="pr-pass__fieldbody"><div class="pr-pass__label">Sitios web</div>
        <div class="pr-pass__urls">${it.urls.map((u) => `<button class="pr-pass__url" data-open="${esc(u)}" data-tip="Abrir en una pestaña nueva">${esc(u)}</button>`).join('')}</div></div>
    </div></div>` : ''}
    ${tailHTML(it, 'Último completado automático')}`;
}

function cardHTML(it) {
  const none = '<span class="pr-pass__muted">Ninguno</span>';
  const fields = [
    field('Titular', 'user', it.holder ? esc(it.holder) : none, { copy: it.holder ? 'holder' : null }),
    it.hasNumber
      ? field('Número', 'card', secretHTML(it, 'number'), { copy: 'number', secret: 'number', mono: true })
      : field('Número', 'card', none),
    field('Vencimiento', 'calendar', it.expiry ? esc(shortExpiry(it.expiry)) : none, { copy: it.expiry ? 'expiry' : null, mono: !!it.expiry }),
    it.hasCvv
      ? field('Código de seguridad', 'lock', secretHTML(it, 'cvv'), { copy: 'cvv', secret: 'cvv' })
      : field('Código de seguridad', 'lock', none),
  ];
  if (it.hasPin) fields.push(field('PIN', 'hash', secretHTML(it, 'pin'), { copy: 'pin', secret: 'pin' }));
  return `
    ${headHTML(it, BRANDS[it.brand] || '')}
    <div class="pr-pass__card">${fields.join('')}</div>
    ${tailHTML(it, 'Último pago completado')}`;
}

/** Un campo secreto del formulario, con su ojo. */
const secretInput = (name, { label, mono = true, attrs = '' }) => `
  <label class="op-field"><span class="op-field__label">${label}</span>
    <span class="pr-pass__pwwrap">
      <input class="op-input${mono ? ' op-input--mono' : ''}" name="${name}" type="password" spellcheck="false" autocomplete="new-password" ${attrs}>
      <button type="button" class="op-iconbtn op-iconbtn--sm pr-pass__eye" data-a="form-eye" aria-label="Mostrar">${Icons.svg('eye', 'pr-eye__a')}${Icons.svg('eyeOff', 'pr-eye__b')}</button>
    </span></label>`;

const formActions = `
  <div class="pr-pass__formactions">
    <button type="button" class="op-btn op-btn--ghost op-btn--sm" data-a="cancel">Cancelar</button>
    <button type="submit" class="op-btn op-btn--primary op-btn--sm"><i data-icon="check"></i> Guardar</button>
  </div>`;

function formHTML(it) {
  const v = (k) => esc(it?.[k] || '');
  return `
    <form class="pr-pass__form" id="pp-form" autocomplete="off">
      <div class="pr-pass__formtitle">${it ? 'Editar' : 'Nueva contraseña'}</div>
      <label class="op-field"><span class="op-field__label">Título</span>
        <input class="op-input" name="title" value="${v('title')}" placeholder="Se completa con el sitio si lo dejás vacío" spellcheck="false"></label>
      <div class="pr-pass__formrow">
        <label class="op-field"><span class="op-field__label">Usuario</span>
          <input class="op-input" name="username" value="${v('username')}" spellcheck="false"></label>
        <label class="op-field"><span class="op-field__label">Correo</span>
          <input class="op-input" name="email" value="${v('email')}" spellcheck="false"></label>
      </div>
      ${secretInput('password', { label: 'Contraseña' })}
      <label class="op-field"><span class="op-field__label">Sitios web</span>
        <textarea class="op-textarea pr-pass__urlsinput" name="urls" spellcheck="false" placeholder="https://ejemplo.com (uno por renglón)">${esc((it?.urls || []).join('\n'))}</textarea></label>
      <label class="op-field"><span class="op-field__label">Nota</span>
        <textarea class="op-textarea" name="note" placeholder="Lo que quieras recordar de esta cuenta">${v('note')}</textarea></label>
      ${formActions}
    </form>`;
}

function cardFormHTML(it) {
  const v = (k) => esc(it?.[k] || '');
  const digits = 'inputmode="numeric"';
  return `
    <form class="pr-pass__form" id="pp-form" autocomplete="off">
      <div class="pr-pass__formtitle">${it ? 'Editar' : 'Nueva tarjeta'}</div>
      <label class="op-field"><span class="op-field__label">Título</span>
        <input class="op-input" name="title" value="${v('title')}" placeholder="Se completa con la marca si lo dejás vacío" spellcheck="false"></label>
      <label class="op-field"><span class="op-field__label">Titular</span>
        <input class="op-input" name="holder" value="${v('holder')}" placeholder="Como figura en la tarjeta" spellcheck="false"></label>
      ${secretInput('number', { label: 'Número', attrs: `${digits} maxlength="23"` })}
      <div class="pr-pass__formrow pr-pass__formrow--3">
        <label class="op-field"><span class="op-field__label">Vencimiento</span>
          <input class="op-input op-input--mono" name="expiry" value="${esc(shortExpiry(it?.expiry))}" placeholder="MM/AA" ${digits} maxlength="7" spellcheck="false"></label>
        ${secretInput('cvv', { label: 'Código', attrs: `${digits} maxlength="4"` })}
        ${secretInput('pin', { label: 'PIN', attrs: 'maxlength="12"' })}
      </div>
      <label class="op-field"><span class="op-field__label">Nota</span>
        <textarea class="op-textarea" name="note" placeholder="Lo que quieras recordar de esta tarjeta">${v('note')}</textarea></label>
      ${formActions}
    </form>`;
}

/* Editando, los secretos se piden recién al abrir el formulario. Un campo se
   manda al guardar solo si ya llegó: guardar antes no lo borra. */
async function fillSecrets(it) {
  for (const f of isCard(it) ? ['number', 'cvv', 'pin'] : ['password']) {
    const value = await api.pass.reveal(it.id, f).catch(() => null);
    const input = root?.querySelector(`#pp-form [name=${f}]`);
    if (!input || P.sel !== it.id || value == null) return;
    if (!input.value) input.value = value;
    input.dataset.loaded = '1';
  }
}

/* ── Acciones ────────────────────────────────────────────────────────────── */

function select(id) {
  if (P.sel === id && P.mode === 'view') return;
  P.sel = id;
  P.mode = 'view';
  P.revealed = null;
  P.confirmDel = false;
  markSelected();
  paintMain();
}

function flashCopied(b) {
  b.classList.add('is-done');
  clearTimeout(b.__t);
  b.__t = setTimeout(() => b.classList.remove('is-done'), 1400);
}

async function copyField(field, b = null) {
  const it = selected();
  if (!it) return;
  const done = await api.pass.copy(it.id, field).catch(() => false);
  if (!done) return;
  if (b) flashCopied(b);
  const SECRET = { password: 'Contraseña copiada', number: 'Número copiado', cvv: 'Código copiado', pin: 'PIN copiado' };
  const PLAIN = { username: 'Usuario copiado', email: 'Correo copiado', holder: 'Titular copiado', expiry: 'Vencimiento copiado' };
  if (SECRET[field]) say(`${SECRET[field]}: se borra del portapapeles en 45 s`, { icon: 'copy' });
  else say(PLAIN[field] || 'Copiado', { icon: 'copy' });
}

/** Pasa al otro lado de la hoja (contraseñas o tarjetas), volviendo a lo que se miraba ahí. */
function setKind(kind) {
  if (kind === P.kind) return;
  P.selBy[P.kind] = P.sel;
  P.kind = kind;
  const list = filtered();
  P.sel = list.some((it) => it.id === P.selBy[kind]) ? P.selBy[kind] : list[0]?.id || null;
  P.mode = 'view';
  P.revealed = null;
  P.confirmDel = false;
  if (!root) return;
  const seg = root.querySelector('#pp-kind');
  seg.querySelectorAll('.op-segmented__opt').forEach((o) => o.classList.toggle('is-active', o.dataset.value === kind));
  root.querySelector('#pp-new').dataset.tip = kind === 'card' ? 'Agregar una tarjeta' : 'Agregar una contraseña';
  paintList();
  markSelected();
  paintMain();
}

async function doImport() {
  let r;
  try {
    r = await api.pass.import();
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
    return;
  }
  if (!r) return;
  P.banner = r;
  await load();
  // Si lo único que entró fueron tarjetas, se muestran las tarjetas.
  if (r.cards && r.cards === r.added && P.kind !== 'card') setKind('card');
  if (!filtered().some((it) => it.id === P.sel)) P.sel = filtered()[0]?.id || null;
  P.mode = 'view';
  paintList();
  paintMain();
}

async function submitForm(form) {
  const f = new FormData(form);
  const it = P.mode === 'edit' ? selected() : null;
  const card = P.kind === 'card';
  // Un secreto que todavía no llegó (editando) no se manda: undefined es "dejalo como está".
  const secret = (name) => {
    const input = form.querySelector(`[name=${name}]`);
    return !it || input.dataset.loaded || input.value ? input.value : undefined;
  };
  try {
    const saved = await api.pass.save(card
      ? {
        id: it?.id, kind: 'card',
        title: f.get('title'), holder: f.get('holder'), expiry: f.get('expiry'), note: f.get('note'),
        number: secret('number'), cvv: secret('cvv'), pin: secret('pin'),
      }
      : {
        id: it?.id,
        title: f.get('title'), username: f.get('username'), email: f.get('email'),
        password: secret('password'),
        urls: String(f.get('urls') || '').split('\n'),
        note: f.get('note'),
      });
    await load();
    P.sel = saved.id;
    P.mode = 'view';
    P.revealed = null;
    paintList();
    markSelected();
    paintMain();
    say(it ? 'Cambios guardados' : card ? 'Tarjeta guardada' : 'Contraseña guardada', { icon: 'check' });
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
  }
}

function wire(el) {
  const q = el.querySelector('#pp-q');
  q.addEventListener('input', () => {
    P.q = q.value;
    const items = filtered();
    if (!items.some((it) => it.id === P.sel) && P.mode === 'view') { P.sel = items[0]?.id || null; paintMain(); }
    paintList();
  });
  q.addEventListener('keydown', (e) => {
    const items = filtered();
    const i = items.findIndex((it) => it.id === P.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) select(next.id);
    } else if (e.key === 'Enter' && selected()) {
      e.preventDefault();
      const it = selected();
      if (isCard(it)) copyField('number');
      else copyField(it.hasPassword ? 'password' : it.username ? 'username' : 'email');
    }
  });
  bindSwitcher(el.querySelector('#pp-kind'), setKind);

  el.querySelector('#pp-new').addEventListener('click', () => {
    P.mode = 'new';
    P.revealed = null;
    P.confirmDel = false;
    paintMain();
  });
  el.querySelector('#pp-import').addEventListener('click', doImport);
  el.querySelector('#pp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.pr-pass__row');
    if (row) select(row.dataset.id);
  });

  const main = el.querySelector('#pp-main');
  main.addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target); });
  main.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) return copyField(cp.dataset.copy, cp);
    const open = e.target.closest('[data-open]');
    if (open) { closePopover(); api.tabs.create(/^[a-z][a-z0-9+.-]*:/i.test(open.dataset.open) ? open.dataset.open : `https://${open.dataset.open}`); return null; }
    const b = e.target.closest('[data-a]');
    if (!b) return null;
    const a = b.dataset.a;
    const it = selected();
    if (a === 'import') return doImport();
    if (a === 'new') { P.mode = 'new'; return paintMain(); }
    if (a === 'edit') { P.mode = 'edit'; P.confirmDel = false; return paintMain(); }
    if (a === 'cancel') { P.mode = 'view'; return paintMain(); }
    if (a === 'banner-close') { P.banner = null; return paintMain(); }
    if (a === 'forget-import') {
      await api.pass.forgetImport().catch(() => false);
      P.banner = null;
      say('Archivo exportado borrado', { icon: 'trash' });
      return paintMain();
    }
    if (a === 'form-eye') {
      /* Los puntos de un campo no se pueden cruzar con el texto: el campo se
         vela, cambia de tipo cuando no se ve y vuelve. Lo que manda es el
         ojo, así un doble clic termina donde quedó él. */
      const input = b.parentElement.querySelector('input');
      b.classList.toggle('is-on');
      input.classList.add('is-veiled');
      clearTimeout(input.__veil);
      input.__veil = setTimeout(() => {
        input.type = b.classList.contains('is-on') ? 'text' : 'password';
        input.classList.remove('is-veiled');
      }, 110);
      return null;
    }
    if (!it) return null;
    if (a === 'reveal') {
      const f = b.dataset.f;
      if (P.revealed?.id !== it.id) P.revealed = { id: it.id, values: {} };
      if (P.revealed.values[f] != null) delete P.revealed.values[f];
      else P.revealed.values[f] = await api.pass.reveal(it.id, f).catch(() => '');
      if (P.revealed?.id !== it.id) return null;    // se cambió de elemento mientras llegaba
      const shown = P.revealed.values[f] != null;
      // Los puntos y lo escrito se relevan en su lugar, y el alto acompaña
      // (una contraseña larga ocupa más de un renglón).
      swap(main.querySelector(`#pp-secret-${f}`), secretHTML(it, f), { size: true });
      b.classList.toggle('is-on', shown);
      b.dataset.tip = shown ? 'Ocultar' : 'Mostrar';
      return null;
    }
    if (a === 'delete' || a === 'delete-no') {
      P.confirmDel = a === 'delete' ? !P.confirmDel : false;
      main.querySelector('.pr-pass__confirm')?.classList.toggle('is-open', P.confirmDel);
      main.querySelector('.pr-pass__del')?.classList.toggle('is-open', P.confirmDel);
      return null;
    }
    if (a === 'delete-yes') {
      const list = filtered();
      const i = list.findIndex((x) => x.id === it.id);
      await api.pass.remove(it.id).catch(() => false);
      await load();
      const rest = filtered();
      P.sel = rest[Math.min(i, rest.length - 1)]?.id || null;
      P.confirmDel = false;
      paintList();
      markSelected();
      paintMain();
      say('Elemento eliminado', { icon: 'trash' });
    }
    return null;
  });
}

/* ── "¿Guardar la contraseña?" ───────────────────────────────────────────── */

function showOffer(o) {
  let answered = false;
  const answer = (action, patch) => {
    if (answered) return;
    answered = true;
    api.pass.answer(o.id, action, patch).catch(() => false).then((ok) => {
      if (ok && action === 'save') say(o.kind === 'update' ? 'Contraseña actualizada' : 'Contraseña guardada', { icon: 'check' });
    });
  };
  if (popoverOpen()) closePopover(true);
  popover(btn, (el, ctl) => {
    if (el.dataset.built) return;
    el.dataset.built = '1';
    const update = o.kind === 'update';
    el.innerHTML = `
      <div class="pr-pop__head">
        <div class="op-grow">
          <div class="pr-pop__title">${update ? '¿Actualizar la contraseña?' : '¿Guardar la contraseña?'}</div>
          <div class="pr-pop__sub">${esc(o.host)}</div>
        </div>
        <i data-icon="passKey"></i>
      </div>
      <div class="pr-offer">
        ${update
          ? `<div class="pr-offer__text">Ya tenés guardado <b>${esc(o.login || o.title || o.host)}</b> en este sitio. La contraseña nueva reemplaza a la anterior.</div>`
          : `<label class="op-field"><span class="op-field__label">Usuario</span>
               <input class="op-input" id="po-login" value="${esc(o.login)}" spellcheck="false" placeholder="Sin usuario"></label>
             <div class="op-field"><span class="op-field__label">Contraseña</span>
               <div class="pr-offer__pw"><span class="pr-pass__dots"></span></div></div>`}
      </div>
      <div class="pr-pop__foot">
        ${update ? '' : '<button class="op-btn op-btn--ghost op-btn--sm" data-o="never">Nunca en este sitio</button>'}
        <span class="op-grow"></span>
        <button class="op-btn op-btn--ghost op-btn--sm" data-o="dismiss">Ahora no</button>
        <button class="op-btn op-btn--primary op-btn--sm" data-o="save">${update ? 'Actualizar' : 'Guardar'}</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-o]');
      if (!b) return;
      const login = el.querySelector('#po-login')?.value;
      answer(b.dataset.o, login != null ? { login } : {});
      ctl.close();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'po-login') { e.preventDefault(); el.querySelector('[data-o=save]').click(); }
    });
  }, { width: 340, onClose: () => answer('dismiss') });
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

export function init() {
  btn = document.getElementById('btn-pass');
  btn.addEventListener('click', openPanel);
  api.pass.onOffer(showOffer);
  // Algo cambió afuera del panel (se guardó un login, se completó uno): la
  // lista abierta se pone al día sin perder lo que se está mirando.
  api.pass.onChanged(async () => {
    if (!root) return;
    await load();
    paintList();
    if (P.mode === 'view') paintMain();
  });
}
