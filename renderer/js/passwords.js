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

   Y los códigos de doble factor (los de Tessera), en el tercer lado. La
   clave tampoco vive acá: el proceso principal calcula el código y manda los
   dígitos. El anillo y los segundos corren acá, una vez por segundo y
   alineados al reloj; cuando el período se da vuelta se pide el código nuevo
   y se releva en su lugar.

   También vive acá el "¿guardar la contraseña?" que llega después de un login.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api } from './state.js';
import { Icons } from './icons.js';
import { esc } from './ui.js';
import { plural } from './format.js';
import { popover, popoverOpen, closePopover } from './layers.js';
import { say } from './status.js';
import { scrollFade, bindSwitcher, reconcile, swap, swapText, dissolve, toggleReveal } from './motion.js';

let btn;

const P = {
  items: [],
  broken: null,
  aside: null,           // la copia apartada de una bóveda dañada (nombre del archivo)
  asideSeen: false,
  kind: 'login',         // login · card · totp: qué lado de la hoja se mira
  code: null,            // { id, code, counter } el código a la vista (o { id, error })
  more: false,           // el formulario de un código con sus opciones a la vista
  selBy: {},             // lo elegido en cada lado, para volver a encontrarlo
  q: '',
  sel: null,
  mode: 'view',          // view · edit · new · restore
  restore: null,         // { file }: el respaldo elegido en Importar que espera su clave
  revealed: null,        // { id, values: { campo: valor } } mientras se ve algo secreto
  banner: null,          // resultado de una importación
};

let root = null;         // el .pr-pass del panel abierto

/* Lo que hace el panel mismo (borrar, deshacer, guardar, leer un QR,
   importar) también avisa "cambió la bóveda" a todas las ventanas, y ese
   aviso llega ANTES que la respuesta. Atendido, repintaba en el medio: al
   borrar, el elemento ya no estaba y se pintaba un instante el vacío, que
   quedaba como un segundo calco esfumándose junto al primero (entre los dos
   tapaban el 75 % del siguiente: un pestañeo). Mientras corre algo propio,
   el aviso se ignora: lo propio repinta solo, una vez. */
let localOps = 0;
const local = (fn) => async (...args) => {
  localOps++;
  try { return await fn(...args); } finally { localOps--; }
};

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

const isCode = (it) => it?.kind === 'totp';
/** "893892" → "893 892"; con 8 dígitos, "1234 5678". */
const groupDigits = (c) => (c.length <= 4 ? c : `${c.slice(0, Math.ceil(c.length / 2))} ${c.slice(Math.ceil(c.length / 2))}`);
const ALGO = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
/** El contador del período en curso: cuando cambia, hay código nuevo. */
const counterOf = (period, now = Date.now()) => Math.floor(now / 1000 / period);
const msLeftOf = (period, now = Date.now()) => period * 1000 - (now % (period * 1000));

/** Lo que cambia de un lado de la hoja al otro. */
const KINDS = {
  login: { icon: 'passKey', add: 'Agregar una contraseña', one: 'contraseña', many: 'contraseñas' },
  card: { icon: 'card', add: 'Agregar una tarjeta', one: 'tarjeta', many: 'tarjetas' },
  totp: { icon: 'otp', add: 'Agregar un código', one: 'código', many: 'códigos' },
};

function tile(it, big = false) {
  const cls = `pr-pass__tile${big ? ' pr-pass__tile--lg' : ''}`;
  if (isCard(it)) return `<span class="${cls} pr-pass__tile--card">${Icons.svg('card')}</span>`;
  if (isCode(it)) return `<span class="${cls} pr-pass__tile--card">${Icons.svg('otp')}</span>`;
  return it.favicon
    ? `<span class="${cls}"><img src="${esc(it.favicon)}" alt="" draggable="false"></span>`
    : `<span class="${cls}"><span class="pr-pass__letter">${esc(letter(it))}</span></span>`;
}

/* ── Datos ───────────────────────────────────────────────────────────────── */

async function load() {
  const r = await api.pass.list().catch(() => ({ items: [], broken: null }));
  P.items = r.items || [];
  P.broken = r.broken || null;
  P.aside = r.aside || null;
  if (P.sel && !P.items.some((it) => it.id === P.sel)) P.sel = null;
}

const kindOf = (it) => (isCard(it) ? 'card' : isCode(it) ? 'totp' : 'login');
const ofKind = () => P.items.filter((it) => kindOf(it) === P.kind);

function filtered() {
  const q = P.q.trim().toLowerCase();
  const list = ofKind();
  if (!q) return list;
  return list.filter((it) => [it.title, it.host, it.username, it.email, it.account, it.holder, BRANDS[it.brand], it.last4, it.note, ...(it.urls || [])]
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
  const width = Math.min(720, window.innerWidth - 24);
  popover(btn, (el) => {
    if (el.dataset.built) return;
    el.dataset.built = '1';
    el.classList.add('pr-pop--pass');
    const opt = (kind, label) => `<button class="op-segmented__opt${P.kind === kind ? ' is-active' : ''}" data-value="${kind}">${label}</button>`;
    el.innerHTML = `
      <div class="pr-pass">
        <aside class="pr-pass__side">
          <div class="pr-pass__kinds"><div class="op-segmented" id="pp-kind">
            ${opt('login', 'Contraseñas')}${opt('card', 'Tarjetas')}${opt('totp', 'Códigos')}
          </div></div>
          <div class="pr-pass__top">
            <div class="op-inputwrap pr-pass__search"><i data-icon="search"></i>
              <input class="op-input" id="pp-q" type="text" spellcheck="false" autocomplete="off" placeholder="Buscar" aria-label="Buscar"></div>
            <button class="op-iconbtn op-iconbtn--sm" id="pp-new" aria-label="Agregar" data-tip="${KINDS[P.kind].add}"><i data-icon="plus"></i></button>
          </div>
          <div class="pr-pass__list op-scroll op-scroll--line-bottom" id="pp-list" role="listbox"></div>
          <div class="pr-pass__foot">
            <span class="op-meta op-grow op-truncate" id="pp-count"></span>
            <button class="op-btn op-btn--ghost op-btn--sm" id="pp-import"><span class="op-swap--row" id="pp-foot">${footHTML()}</span></button>
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
  }, { width, onClose: () => { root = null; P.revealed = null; stopTicking(); } });
}

function paintList() {
  if (!root) return;
  const list = root.querySelector('#pp-list');
  const items = filtered();
  const all = ofKind().length;
  swapText(root.querySelector('#pp-count'), P.undo ? `${P.undo.title} eliminado` : all ? plural(all, KINDS[P.kind].one, KINDS[P.kind].many) : '');
  /* Fila por fila (motion.js): al buscar, las que siguen coincidiendo se
     quedan y se acomodan, las otras se van; rehecha entera, la lista
     parpadeaba con cada letra. */
  reconcile(list, items.length
    ? items.map((it) => ({ key: it.id, html: `
      <button class="pr-pass__row${it.id === P.sel ? ' is-selected' : ''}" data-id="${esc(it.id)}" role="option" aria-selected="${it.id === P.sel}">
        ${tile(it)}
        <span class="pr-pass__rowtext"><span class="pr-pass__rowtitle">${esc(it.title)}</span>
          <span class="pr-pass__rowsub">${esc(isCard(it) ? cardLine(it) : isCode(it) ? it.account || 'Sin cuenta' : loginOf(it) || it.host || 'Sin usuario')}</span></span>
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

/* Un código se pinta con sus dígitos desde el primer cuadro: si llegaran
   después, se vería el hueco y después el número. Se piden antes de pintar
   (es un viaje corto al proceso principal), y si mientras tanto se pidió
   otro repintado, gana el último. */
let paintSeq = 0;
function paintMain() {
  const seq = ++paintSeq;
  const it = selected();
  if (root && P.mode === 'view' && isCode(it) && !(P.code?.id === it.id && (P.code.error || P.code.counter === counterOf(it.period)))) {
    fetchCode(it).finally(() => { if (seq === paintSeq) paintNow(); });
    return;
  }
  paintNow();
}

async function fetchCode(it) {
  const c = await api.pass.code(it.id).catch((err) => ({ error: err.message }));
  P.code = c?.error || !c ? { id: it.id, error: c?.error || 'Este código no tiene clave.' } : { id: it.id, code: c.code, counter: c.counter };
  return P.code;
}

function paintNow() {
  if (!root) return;
  const main = root.querySelector('#pp-main');
  const it = selected();
  let html = '';
  if (P.banner) html += bannerHTML();
  if (P.aside && !P.asideSeen) html += asideHTML();
  if (P.broken) html += `<div class="pr-pass__warn">${Icons.svg('alert')}<div>No se pudo abrir la bóveda guardada (${esc(P.broken)}). Para no pisarla, Prism no guarda cambios hasta que se resuelva.</div></div>`;

  const FORM = { login: formHTML, card: cardFormHTML, totp: codeFormHTML };
  const DETAIL = { login: detailHTML, card: cardHTML, totp: codeHTML };
  if (P.mode === 'restore' && P.restore) html += restoreHTML();
  else if (P.mode === 'new' || (P.mode === 'edit' && it)) html += FORM[P.kind](P.mode === 'edit' ? it : null);
  else if (!ofKind().length) html += welcomeHTML();
  else if (it) html += DETAIL[P.kind](it);
  else html += `<div class="pr-pass__empty"><i data-icon="${KINDS[P.kind].icon}"></i><div>Elegí un elemento de la lista.</div></div>`;

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
  view.querySelectorAll('.op-segmented').forEach((s) => bindSwitcher(s));
  if (P.mode !== 'view') view.querySelector('input')?.focus();
  if (P.mode === 'edit' && it) fillSecrets(it);
  if (view.querySelector('.pr-otp')) startTicking(); else stopTicking();
}

function welcomeHTML() {
  const card = P.kind === 'card';
  if (P.kind === 'totp') {
    return `
    <div class="pr-pass__welcome">
      <div class="pr-pass__hero">${Icons.svg('otp')}</div>
      <div class="pr-pass__welcometitle">Tus códigos de doble factor, adentro de Prism</div>
      <div class="pr-pass__welcometext">Dejá a la vista el QR que muestra el sitio (en una pestaña, en otra ventana o en el teléfono espejado) y Prism lo lee solo. También sirve una captura en el portapapeles o una imagen, y entran el respaldo de Tessera y el QR de «Transferir cuentas» de Google Authenticator. Las claves se guardan cifradas con tu cuenta de Windows.</div>
      <div class="pr-pass__welcomeactions">
        <button class="op-btn op-btn--primary" data-a="qr-screen"><i data-icon="screen"></i> Escanear la pantalla</button>
        <button class="op-btn op-btn--secondary" data-a="qr-clip"><i data-icon="clipboard"></i> Del portapapeles</button>
        <button class="op-btn op-btn--secondary" data-a="qr-file"><i data-icon="image"></i> Desde una imagen</button>
        <button class="op-btn op-btn--ghost" data-a="new"><i data-icon="edit"></i> A mano</button>
      </div>
    </div>`;
  }
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
  const logins = b.added - (b.cards || 0) - (b.codes || 0);
  const parts = [logins && plural(logins, 'contraseña', 'contraseñas'), b.cards && plural(b.cards, 'tarjeta', 'tarjetas'), b.codes && plural(b.codes, 'código', 'códigos')].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0];
  const head = `
      <div class="pr-pass__bannerhead">${Icons.svg('check')}<span>${b.added ? `Se ${b.backup ? (b.added === 1 ? 'restauró' : 'restauraron') : (b.added === 1 ? 'importó' : 'importaron')} ${list}` : `No había nada nuevo para ${b.backup ? 'restaurar' : 'importar'}`}${b.repeated ? ` · ${plural(b.repeated, 'ya estaba', 'ya estaban')}` : ''}</span></div>`;
  /* El QR de "Transferir cuentas" de Google Authenticator: no hay archivo que
     borrar, pero si eran varios QR falta leer los otros. */
  if (b.qr) {
    const { index = 0, size = 1 } = b.batch || {};
    const more = size > 1 ? `Era el QR ${index + 1} de ${size}: copiá el siguiente y leelo igual para traer el resto.` : 'Del QR de «Transferir cuentas» de Google Authenticator.';
    const off = b.skipped ? ` ${plural(b.skipped, 'cuenta no se pudo traer', 'cuentas no se pudieron traer')}: son por contador o usan MD5, y Prism maneja solo códigos por tiempo.` : '';
    return `
    <div class="pr-pass__banner">${head}
      <div class="pr-pass__bannertext">${more}${off}</div>
      <div class="pr-pass__banneractions"><button class="op-btn op-btn--ghost op-btn--sm" data-a="banner-close">Entendido</button></div>
    </div>`;
  }
  return `
    <div class="pr-pass__banner">${head}
      ${b.backup
    /* Un respaldo está cifrado: no hay nada que borrar. */
    ? `<div class="pr-pass__bannertext">Del respaldo <b>${esc(b.file)}</b>. Sigue cifrado en su carpeta: no hace falta borrarlo.</div>
      <div class="pr-pass__banneractions"><button class="op-btn op-btn--ghost op-btn--sm" data-a="banner-close">Entendido</button></div>`
    : `<div class="pr-pass__bannertext">El archivo <b>${esc(b.file)}</b> tiene tus datos sin cifrar. Ya no hace falta: conviene borrarlo.</div>
      <div class="pr-pass__banneractions">
        <button class="op-btn op-btn--ghost op-btn--sm" data-a="banner-close">Lo borro yo</button>
        <button class="op-btn op-btn--secondary op-btn--sm" data-a="forget-import"><i data-icon="trash"></i> Borrar el archivo</button>
      </div>`}
    </div>`;
}

/* La bóveda en disco estaba rota y quedó aparte (store.cjs): la de ahora
   arrancó vacía. Sin este aviso, las contraseñas simplemente no estaban. */
function asideHTML() {
  return `
    <div class="pr-pass__banner">
      <div class="pr-pass__bannerhead">${Icons.svg('alert')}<span>La bóveda guardada estaba dañada</span></div>
      <div class="pr-pass__bannertext">Prism no la pudo leer y arrancó con una vacía. No la borró: quedó aparte como <b>${esc(P.aside)}</b>, en la carpeta de datos.</div>
      <div class="pr-pass__banneractions">
        <button class="op-btn op-btn--ghost op-btn--sm" data-a="aside-close">Entendido</button>
        <button class="op-btn op-btn--secondary op-btn--sm" data-a="show-aside"><i data-icon="folder"></i> Mostrar el archivo</button>
      </div>
    </div>`;
}

/** Lo que se ve de un secreto: tapado (los puntos dibujados, y en el número los últimos cuatro) o él. */
function secretHTML(it, f) {
  const v = P.revealed?.id === it.id ? P.revealed.values[f] : null;
  // La clave de un código, de a cuatro como la muestran los sitios (copiarla la lleva entera).
  const shown = f === 'number' ? groupNumber(v) : f === 'secret' ? String(v ?? '').replace(/(.{4})(?=.)/g, '$1 ') : v;
  if (v != null) return `<span class="pr-pass__secret">${esc(shown)}</span>`;
  if (f === 'number') return `<span class="pr-pass__dots pr-pass__dots--4"></span> ${esc(it.last4)}`;
  return `<span class="pr-pass__dots${f === 'password' || f === 'secret' ? '' : ' pr-pass__dots--4'}"></span>`;
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
      ${secret ? `<button class="op-iconbtn op-iconbtn--sm op-iconswap pr-pass__eye${shown ? ' is-on is-b' : ''}" data-a="reveal" data-f="${secret}" aria-label="Mostrar" data-tip="${shown ? 'Ocultar' : 'Mostrar'}">${Icons.svg('eye')}${Icons.svg('eyeOff')}</button>` : ''}
      ${copy ? `<button class="op-iconbtn op-iconbtn--sm op-iconswap pr-pass__copy" data-copy="${copy}" aria-label="Copiar" data-tip="Copiar">${Icons.svg('copy')}${Icons.svg('check')}</button>` : ''}
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
      <button class="op-iconbtn op-iconbtn--sm pr-pass__del" data-a="delete" aria-label="Eliminar" data-tip="Eliminar"><i data-icon="trash"></i></button>
    </div>`;
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

/* ── Un código de doble factor ───────────────────────────────────────────── */

const RING_C = 2 * Math.PI * 15.5;   // la circunferencia del anillo (r 15,5 en un viewBox de 36)
/* El anillo apunta a donde va a estar DENTRO de un segundo, y llega justo
   cuando vuelve a correr el reloj: se ve continuo y nunca atrasado. */
const ringOffset = (left, period) => RING_C * (1 - Math.max(0, left - 1000) / (period * 1000));

function codeHTML(it) {
  const c = P.code?.id === it.id ? P.code : null;
  const left = msLeftOf(it.period);
  const body = c && !c.error
    ? `
      <div class="pr-otp${left <= 5000 ? ' is-expiring' : ''}" data-id="${esc(it.id)}" data-counter="${c.counter}">
        <div class="pr-otp__text">
          <div class="pr-pass__label">Código</div>
          <div class="pr-otp__code op-copyable" id="pp-code">${esc(groupDigits(c.code))}</div>
        </div>
        <svg class="pr-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="pr-ring__track" cx="18" cy="18" r="15.5"/>
          <circle class="pr-ring__arc" cx="18" cy="18" r="15.5" stroke-dasharray="${RING_C}" style="stroke-dashoffset:${ringOffset(left, it.period)}"/>
          <text class="pr-ring__sec" x="18" y="18">${Math.ceil(left / 1000)}</text>
        </svg>
        <button class="op-iconbtn op-iconswap pr-pass__copy pr-otp__copy" data-copy="code" aria-label="Copiar el código" data-tip="Copiar el código">${Icons.svg('copy')}${Icons.svg('check')}</button>
      </div>`
    : `<div class="pr-pass__field"><span class="pr-pass__fieldicon">${Icons.svg('alert')}</span>
        <div class="pr-pass__fieldbody"><div class="pr-pass__label">Código</div><div class="pr-pass__value pr-otp__broken">${esc(c?.error || 'No se pudo calcular.')}</div></div></div>`;
  const none = '<span class="pr-pass__muted">Ninguna</span>';
  const fields = [
    field('Cuenta', 'user', it.account ? esc(it.account) : none, { copy: it.account ? 'account' : null }),
    it.hasSecret
      ? field('Clave', 'passKey', secretHTML(it, 'secret'), { copy: 'secret', secret: 'secret', mono: true })
      : field('Clave', 'passKey', none),
    field('Formato', 'hash', esc(`${it.digits} dígitos · cada ${it.period} s · ${ALGO[it.algorithm] || it.algorithm}`)),
  ];
  return `
    ${headHTML(it, it.account || '')}
    <div class="pr-pass__card pr-otp__card">${body}</div>
    <div class="pr-pass__card">${fields.join('')}</div>
    ${tailHTML(it, 'Último código copiado')}`;
}

/* ── El reloj ────────────────────────────────────────────────────────────────
   Uno solo, mientras haya un código a la vista. Mueve el anillo y los
   segundos; cuando el período se da vuelta pide el código nuevo y lo releva
   en su lugar, subiendo (el que viene reemplaza al que se va). */
let tickTimer = null;
function stopTicking() { clearTimeout(tickTimer); tickTimer = null; }
function startTicking() {
  stopTicking();
  const loop = async () => {
    const box = root?.querySelector('#pp-main .pr-pass__view:not([data-state="closing"]) .pr-otp');
    const it = box && P.items.find((x) => x.id === box.dataset.id);
    if (!it) { tickTimer = null; return; }
    let now = Date.now();
    if (Number(box.dataset.counter) !== counterOf(it.period, now)) {
      const c = await fetchCode(it);
      if (!box.isConnected) return;    // se cambió de elemento mientras llegaba: el que pintó sigue
      if (!c.error) {
        box.dataset.counter = c.counter;
        swap(box.querySelector('#pp-code'), esc(groupDigits(c.code)), { dir: 1 });
      }
      now = Date.now();
    }
    moveRing(box, msLeftOf(it.period, now), it.period);
    tickTimer = setTimeout(loop, 1000 - (now % 1000) + 8);
  };
  /* El primer paso, al segundo siguiente: el anillo nació en su lugar con el
     pintado, y moverlo ya lo haría viajar un segundo antes de tiempo. */
  tickTimer = setTimeout(loop, 1000 - (Date.now() % 1000) + 8);
}

function moveRing(box, left, period) {
  const arc = box.querySelector('.pr-ring__arc');
  const target = ringOffset(left, period);
  /* Al darse vuelta el período, el arco se llenaría "hacia atrás" en un
     segundo. Es un reinicio, no un movimiento: se apoya lleno, sin
     transición, donde está ahora, y desde ahí sigue su segundo como siempre.
     Puesto directo en el destino, se quedaba quieto el primer segundo. */
  if (target < Number(arc.dataset.offset ?? parseFloat(arc.style.strokeDashoffset))) {
    arc.classList.add('is-reset');
    arc.style.strokeDashoffset = RING_C * (1 - left / (period * 1000));
    void arc.getBoundingClientRect();
    arc.classList.remove('is-reset');
  }
  arc.style.strokeDashoffset = target;
  arc.dataset.offset = target;
  box.querySelector('.pr-ring__sec').textContent = Math.ceil(left / 1000);
  box.classList.toggle('is-expiring', left <= 5000);
}

function codeFormHTML(it) {
  const v = (k) => esc(it?.[k] || '');
  const seg = (name, value, opts) => `<div class="op-segmented pr-pass__seg" data-name="${name}">${opts.map(([val, label]) => `
    <button type="button" class="op-segmented__opt${String(val) === String(value) ? ' is-active' : ''}" data-value="${val}">${label}</button>`).join('')}</div>`;
  // Editando uno que no es el de fábrica, las opciones arrancan a la vista.
  const open = P.more || (it && (it.digits !== 6 || it.period !== 30 || it.algorithm !== 'SHA1'));
  return `
    <form class="pr-pass__form" id="pp-form" autocomplete="off">
      <div class="pr-pass__formtitle">${it ? 'Editar' : 'Nuevo código'}</div>
      ${it ? '' : `
      <div class="pr-pass__qr">
        <div class="pr-pass__qrtext"><b>Leé el QR del sitio.</b> Dejalo a la vista y escaneá la pantalla, o traé una captura del portapapeles o una imagen.</div>
        <div class="pr-pass__qractions">
          <button type="button" class="op-btn op-btn--primary op-btn--sm" data-a="qr-screen"><i data-icon="screen"></i> Escanear la pantalla</button>
          <button type="button" class="op-btn op-btn--secondary op-btn--sm" data-a="qr-clip"><i data-icon="clipboard"></i> Del portapapeles</button>
          <button type="button" class="op-btn op-btn--secondary op-btn--sm" data-a="qr-file"><i data-icon="image"></i> Desde una imagen</button>
        </div>
      </div>
      <div class="pr-pass__or"><span>o escribí la clave</span></div>`}
      <div class="pr-pass__formrow">
        <label class="op-field"><span class="op-field__label">Título</span>
          <input class="op-input" name="title" value="${v('title')}" placeholder="El sitio o la app" spellcheck="false"></label>
        <label class="op-field"><span class="op-field__label">Cuenta</span>
          <input class="op-input" name="account" value="${v('account')}" placeholder="Tu usuario o correo ahí" spellcheck="false"></label>
      </div>
      ${secretInput('secret', { label: 'Clave', attrs: 'placeholder="La que muestra el sitio, o el enlace otpauth://"' })}
      <button type="button" class="pr-pass__more${open ? ' is-open' : ''}" data-a="more" aria-expanded="${!!open}"><i data-icon="chevronDown"></i> Más opciones</button>
      <div class="op-reveal pr-pass__moreopts${open ? ' is-open' : ''}"><div><div class="pr-pass__morein">
        <div class="pr-pass__formrow">
          <div class="op-field"><span class="op-field__label">Dígitos</span>${seg('digits', it?.digits ?? 6, [[6, '6'], [7, '7'], [8, '8']])}</div>
          <label class="op-field"><span class="op-field__label">Cada cuántos segundos cambia</span>
            <input class="op-input op-input--mono" name="period" value="${it?.period ?? 30}" inputmode="numeric" maxlength="3" spellcheck="false"></label>
        </div>
        <div class="op-field"><span class="op-field__label">Algoritmo</span>${seg('algorithm', it?.algorithm ?? 'SHA1', Object.entries(ALGO))}</div>
        <div class="op-field__hint">Casi todos los sitios usan 6 dígitos, 30 segundos y SHA-1. Si el sitio dice otra cosa, va acá; con el enlace otpauth:// se completa solo.</div>
      </div></div></div>
      <label class="op-field"><span class="op-field__label">Nota</span>
        <textarea class="op-textarea" name="note" placeholder="Lo que quieras recordar de este código">${v('note')}</textarea></label>
      ${formActions}
    </form>`;
}

/** Un campo secreto del formulario, con su ojo. */
const secretInput = (name, { label, mono = true, attrs = '' }) => `
  <label class="op-field"><span class="op-field__label">${label}</span>
    <span class="pr-pass__pwwrap">
      <input class="op-input${mono ? ' op-input--mono' : ''}" name="${name}" type="password" spellcheck="false" autocomplete="new-password" ${attrs}>
      <button type="button" class="op-iconbtn op-iconbtn--sm op-iconswap pr-pass__eye" data-a="form-eye" aria-label="Mostrar">${Icons.svg('eye')}${Icons.svg('eyeOff')}</button>
    </span></label>`;

const formActions = `
  <div class="pr-pass__formactions">
    <button type="button" class="op-btn op-btn--ghost op-btn--sm" data-a="cancel">Cancelar</button>
    <button type="submit" class="op-btn op-btn--primary op-btn--sm"><i data-icon="check"></i> Guardar</button>
  </div>`;

/** La clave de un respaldo que se eligió en Importar. */
function restoreHTML() {
  return `
    <form class="pr-pass__form" id="pp-restore" autocomplete="off">
      <div class="pr-pass__formtitle">Restaurar un respaldo</div>
      <label class="op-field"><span class="op-field__label">Clave del respaldo</span>
        <input class="op-input" name="key" type="password" spellcheck="false" autocomplete="off">
        <span class="op-field__hint" id="pp-restore-msg">La que elegiste al prender el respaldo, para <b>${esc(P.restore.file)}</b>. Se suma lo que falte: nada de lo que ya tenés se pisa.</span></label>
      <div class="pr-pass__formactions">
        <button type="button" class="op-btn op-btn--ghost op-btn--sm" data-a="cancel">Cancelar</button>
        <button type="submit" class="op-btn op-btn--primary op-btn--sm"><i data-icon="check"></i> Restaurar</button>
      </div>
    </form>`;
}

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
  for (const f of isCard(it) ? ['number', 'cvv', 'pin'] : isCode(it) ? ['secret'] : ['password']) {
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
  markSelected();
  paintMain();
}

function flashCopied(b) {
  b.classList.add('is-done', 'is-b');
  clearTimeout(b.__t);
  b.__t = setTimeout(() => b.classList.remove('is-done', 'is-b'), 1400);
}

async function copyField(field, b = null) {
  const it = selected();
  if (!it) return;
  const done = await api.pass.copy(it.id, field).catch(() => false);
  if (!done) return;
  if (b) flashCopied(b);
  /* Copiar un código lo anota como usado, pero no repinta la vista: el fundido
     se llevaría el tilde del botón. La fecha se ve la próxima vez. */
  if (field === 'code') it.lastUsedAt = Date.now();
  const SECRET = { password: 'Contraseña copiada', number: 'Número copiado', cvv: 'Código copiado', pin: 'PIN copiado', secret: 'Clave copiada', code: 'Código copiado' };
  const PLAIN = { username: 'Usuario copiado', email: 'Correo copiado', holder: 'Titular copiado', expiry: 'Vencimiento copiado', account: 'Cuenta copiada' };
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
  if (!root) return;
  const seg = root.querySelector('#pp-kind');
  seg.querySelectorAll('.op-segmented__opt').forEach((o) => o.classList.toggle('is-active', o.dataset.value === kind));
  root.querySelector('#pp-new').dataset.tip = KINDS[kind].add;
  paintList();
  markSelected();
  paintMain();
}

const doImport = local(async () => {
  let r;
  try {
    r = await api.pass.import();
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
    return;
  }
  if (!r) return;
  /* Un respaldo de Prism que no es el de acá: hace falta su clave. Se pide en
     el panel mismo (un modal lo cerraría), y sigue en submitRestore(). */
  if (r.needsKey) {
    P.restore = { file: r.file };
    P.mode = 'restore';
    return paintMain();
  }
  await imported(r);
});

/** Lo que entró (de una exportación o de un respaldo), a la vista. */
async function imported(r) {
  P.banner = r;
  await load();
  // Si lo único que entró fueron tarjetas (o códigos), se muestran ellas.
  if (r.cards && r.cards === r.added && P.kind !== 'card') setKind('card');
  if (r.codes && r.codes === r.added && P.kind !== 'totp') setKind('totp');
  if (!filtered().some((it) => it.id === P.sel)) P.sel = filtered()[0]?.id || null;
  P.mode = 'view';
  paintList();
  paintMain();
}

/* Un QR del portapapeles o de una imagen. El de un sitio entra en el acto y
   queda a la vista; el de Google Authenticator trae varios y es una
   importación, con su aviso. */
const readQr = local(async (source, b) => {
  if (b?.disabled) return;
  if (b) b.disabled = true;
  // Mirar todas las ventanas puede tardar un par de segundos: que se sepa que está buscando.
  if (source === 'screen') say('Buscando un código QR a la vista…', { icon: 'search', ms: 20000 });
  let r;
  try {
    r = await api.pass.qr(source);
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
    return;
  } finally {
    if (b) b.disabled = false;
  }
  if (!r) return;
  if (r.imported) { await imported({ ...r.imported, qr: true }); return; }
  await load();
  if (P.kind !== 'totp') setKind('totp');
  P.sel = r.item.id;
  P.mode = 'view';
  P.revealed = null;
  paintList();
  markSelected();
  paintMain();
  say(r.existed ? 'Ese código ya estaba guardado' : `Código de ${r.item.title} agregado`, { icon: 'check' });
});

const submitRestore = local(async (form) => {
  const input = form.querySelector('[name=key]');
  const btn = form.querySelector('[type=submit]');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await api.pass.restore(input.value);
    P.restore = null;
    if (r) await imported(r);
    else { P.mode = 'view'; paintMain(); }
  } catch (err) {
    // La clave no era: el archivo sigue elegido, se prueba de nuevo.
    btn.disabled = false;
    const msg = form.querySelector('#pp-restore-msg');
    msg.classList.add('op-field__hint--error');
    swapText(msg, err.message, { size: true });
    input.select();
  }
});

const submitForm = local(async (form) => {
  const f = new FormData(form);
  const it = P.mode === 'edit' ? selected() : null;
  const card = P.kind === 'card';
  // Un secreto que todavía no llegó (editando) no se manda: undefined es "dejalo como está".
  const secret = (name) => {
    const input = form.querySelector(`[name=${name}]`);
    return !it || input.dataset.loaded || input.value ? input.value : undefined;
  };
  const segOf = (name) => form.querySelector(`.pr-pass__seg[data-name=${name}] .is-active`)?.dataset.value;
  try {
    const saved = await api.pass.save(P.kind === 'totp'
      ? {
        id: it?.id, kind: 'totp',
        title: f.get('title'), account: f.get('account'), note: f.get('note'),
        digits: Number(segOf('digits')), period: Number(f.get('period')) || 30, algorithm: segOf('algorithm'),
        secret: secret('secret'),
      }
      : card
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
    say(it ? 'Cambios guardados' : card ? 'Tarjeta guardada' : P.kind === 'totp' ? 'Código guardado' : 'Contraseña guardada', { icon: 'check' });
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'error', ms: 8000 });
  }
});

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
      else if (isCode(it)) copyField('code', root.querySelector('.pr-otp__copy'));
      else copyField(it.hasPassword ? 'password' : it.username ? 'username' : 'email');
    }
  });
  bindSwitcher(el.querySelector('#pp-kind'), setKind);

  el.querySelector('#pp-new').addEventListener('click', () => {
    P.mode = 'new';
    P.revealed = null;
    paintMain();
  });
  el.querySelector('#pp-import').addEventListener('click', () => (P.undo ? undoRemove() : doImport()));
  el.querySelector('#pp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.pr-pass__row');
    if (row) select(row.dataset.id);
  });

  const main = el.querySelector('#pp-main');
  main.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.id === 'pp-restore') submitRestore(e.target); else submitForm(e.target); });
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
    if (a === 'qr-screen' || a === 'qr-clip' || a === 'qr-file') return readQr({ 'qr-screen': 'screen', 'qr-file': 'file', 'qr-clip': 'clipboard' }[a], b);
    if (a === 'more') {
      P.more = toggleReveal(main.querySelector('.pr-pass__moreopts'));
      b.classList.toggle('is-open', P.more);
      b.setAttribute('aria-expanded', String(P.more));
      return null;
    }
    if (a === 'new') { P.mode = 'new'; return paintMain(); }
    if (a === 'edit') { P.mode = 'edit'; return paintMain(); }
    if (a === 'cancel') { P.mode = 'view'; return paintMain(); }
    if (a === 'banner-close') { P.banner = null; return paintMain(); }
    if (a === 'aside-close') { P.asideSeen = true; return paintMain(); }
    if (a === 'show-aside') return api.pass.showAside().catch(() => false);
    if (a === 'forget-import') {
      // Si no se pudo (abierto en Excel), el aviso se queda: el archivo sigue ahí.
      let gone;
      try {
        gone = await api.pass.forgetImport();
      } catch (err) {
        say(err.message, { icon: 'alert', tone: 'error' });
        return null;
      }
      P.banner = null;
      if (gone) say('Archivo exportado borrado', { icon: 'trash' });
      return paintMain();
    }
    if (a === 'form-eye') {
      /* Los puntos de un campo no se pueden cruzar con el texto: el campo se
         vela, cambia de tipo cuando no se ve y vuelve. Lo que manda es el
         ojo, así un doble clic termina donde quedó él. */
      const input = b.parentElement.querySelector('input');
      b.classList.toggle('is-b', b.classList.toggle('is-on'));
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
      b.classList.toggle('is-b', shown);   // el ojo ↔ el ojo tachado (.op-iconswap)
      b.dataset.tip = shown ? 'Ocultar' : 'Mostrar';
      return null;
    }
    if (a === 'delete') return removeItem(it);
    return null;
  });
}

/* ── Borrar, sin preguntar ───────────────────────────────────────────────────
   El tacho borra en el acto (pedido de Fran, 1.12.1). A cambio, durante unos
   segundos el pie de la lista dice qué se fue y el botón de Importar se
   vuelve Deshacer: lo trae de vuelta entero, con su clave y en su lugar. El
   aviso vive en el panel y no en la statusbar: un clic allá abajo cerraría
   el panel. */
const UNDO_MS = 6000;
const footHTML = () => (P.undo ? `${Icons.svg('undo')} Deshacer` : `${Icons.svg('download')} Importar`);

function paintFoot() {
  if (!root) return;
  const b = root.querySelector('#pp-import');
  b.dataset.tip = P.undo ? `Traer de vuelta ${P.undo.title}` : '';
  if (!P.undo) delete b.dataset.tip;
  swap(root.querySelector('#pp-foot'), footHTML(), { size: true });
}

function endUndo() {
  if (!P.undo) return;
  clearTimeout(P.undo.timer);
  P.undo = null;
  paintList();
  paintFoot();
}

const removeItem = local(async (it) => {
  const list = filtered();
  const i = list.findIndex((x) => x.id === it.id);
  if (!(await api.pass.remove(it.id).catch(() => false))) return;
  clearTimeout(P.undo?.timer);
  P.undo = { title: it.title, timer: setTimeout(endUndo, UNDO_MS) };
  await load();
  const rest = filtered();
  P.sel = rest[Math.min(i, rest.length - 1)]?.id || null;
  P.mode = 'view';
  P.revealed = null;
  paintList();
  markSelected();
  paintMain();
  paintFoot();
});

const undoRemove = local(async () => {
  const it = await api.pass.undoRemove().catch(() => null);
  clearTimeout(P.undo?.timer);
  P.undo = null;
  if (!it) { paintList(); paintFoot(); return; }
  await load();
  if (kindOf(it) !== P.kind) setKind(kindOf(it));
  P.sel = it.id;
  P.mode = 'view';
  P.revealed = null;
  paintList();
  markSelected();
  paintMain();
  paintFoot();
});

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
    if (!root || localOps) return;
    await load();
    if (!root || localOps) return;
    paintList();
    if (P.mode === 'view') paintMain();
  });
}
