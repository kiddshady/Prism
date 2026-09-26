/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — contraseñas (el panel)
   Una hoja colgada de la llave de la barra, en dos columnas: la lista con su
   buscador a la izquierda y el elemento a la derecha (usuario, contraseña,
   sitios, nota y cuándo se usó). Editar, agregar, borrar e importar pasan
   adentro de la misma hoja: un menú o un modal de Opal la cerrarían.

   Las contraseñas no viven acá. La lista llega sin ellas; ver una es pedirla
   (y se olvida al cambiar de elemento), y copiar la copia el proceso
   principal, que además la saca del portapapeles a los 45 s.

   También vive acá el "¿guardar la contraseña?" que llega después de un login.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api } from './state.js';
import { Icons } from './icons.js';
import { esc } from './ui.js';
import { plural } from './format.js';
import { popover, popoverOpen, closePopover } from './layers.js';
import { say } from './status.js';
import { scrollFade } from './motion.js';

let btn;

const P = {
  items: [],
  broken: null,
  q: '',
  sel: null,
  mode: 'view',          // view · edit · new
  revealed: null,        // { id, value } mientras se ve una contraseña
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

function tile(it, big = false) {
  const cls = `pr-pass__tile${big ? ' pr-pass__tile--lg' : ''}`;
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

function filtered() {
  const q = P.q.trim().toLowerCase();
  if (!q) return P.items;
  return P.items.filter((it) => [it.title, it.host, it.username, it.email, it.note, ...(it.urls || [])]
    .some((s) => String(s || '').toLowerCase().includes(q)));
}

const selected = () => P.items.find((it) => it.id === P.sel) || null;

/* ── El panel ────────────────────────────────────────────────────────────── */

export async function openPanel() {
  if (popoverOpen(btn)) { closePopover(); return; }
  await load();
  if (!P.sel && P.items.length) P.sel = filtered()[0]?.id || null;
  P.mode = P.items.length ? 'view' : P.mode === 'new' ? 'new' : 'view';
  P.revealed = null;
  P.confirmDel = false;
  const width = Math.min(720, window.innerWidth - 24);
  popover(btn, (el) => {
    if (el.dataset.built) return;
    el.dataset.built = '1';
    el.classList.add('pr-pop--pass', 'pr-pop--solid');
    el.innerHTML = `
      <div class="pr-pass">
        <aside class="pr-pass__side">
          <div class="pr-pass__top">
            <div class="op-inputwrap pr-pass__search"><i data-icon="search"></i>
              <input class="op-input" id="pp-q" type="text" spellcheck="false" autocomplete="off" placeholder="Buscar" aria-label="Buscar en tus contraseñas"></div>
            <button class="op-iconbtn op-iconbtn--sm" id="pp-new" aria-label="Agregar" data-tip="Agregar una contraseña"><i data-icon="plus"></i></button>
          </div>
          <div class="pr-pass__list op-scroll op-scroll--line-bottom" id="pp-list" role="listbox"></div>
          <div class="pr-pass__foot">
            <span class="op-meta op-grow op-truncate" id="pp-count"></span>
            <button class="op-btn op-btn--ghost op-btn--sm" id="pp-import"><i data-icon="upload"></i> Importar</button>
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
  root.querySelector('#pp-count').textContent = P.items.length ? plural(P.items.length, 'elemento', 'elementos') : '';
  list.innerHTML = items.length
    ? items.map((it) => `
      <button class="pr-pass__row${it.id === P.sel ? ' is-selected' : ''}" data-id="${esc(it.id)}" role="option" aria-selected="${it.id === P.sel}">
        ${tile(it)}
        <span class="pr-pass__rowtext"><span class="pr-pass__rowtitle">${esc(it.title)}</span>
          <span class="pr-pass__rowsub">${esc(loginOf(it) || it.host || 'Sin usuario')}</span></span>
      </button>`).join('')
    : `<div class="pr-pass__none">${P.items.length ? 'Nada coincide con la búsqueda.' : 'Todavía no hay nada.'}</div>`;
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

  if (P.mode === 'new' || (P.mode === 'edit' && it)) html += formHTML(P.mode === 'edit' ? it : null);
  else if (!P.items.length) html += welcomeHTML();
  else if (it) html += detailHTML(it);
  else html += `<div class="pr-pass__empty"><i data-icon="key"></i><div>Elegí un elemento de la lista.</div></div>`;

  main.innerHTML = `<div class="pr-pass__view op-scroll" id="pp-view">${html}</div>`;
  Icons.mount(main);
  const view = main.querySelector('#pp-view');
  scrollFade(view);
  if (P.mode !== 'view') view.querySelector('input')?.focus();
  if (P.mode === 'edit' && it) fillPasswordField(it.id);
}

function welcomeHTML() {
  return `
    <div class="pr-pass__welcome">
      <div class="pr-pass__hero">${Icons.svg('key')}</div>
      <div class="pr-pass__welcometitle">Tus contraseñas, adentro de Prism</div>
      <div class="pr-pass__welcometext">Cuando entres a un sitio, Prism te ofrece guardarla, y la próxima vez la completa. Se guardan cifradas con tu cuenta de Windows.</div>
      <div class="pr-pass__welcomeactions">
        <button class="op-btn op-btn--primary" data-a="import"><i data-icon="upload"></i> Importar de Proton Pass</button>
        <button class="op-btn op-btn--secondary" data-a="new"><i data-icon="plus"></i> Agregar una</button>
      </div>
    </div>`;
}

function bannerHTML() {
  const b = P.banner;
  return `
    <div class="pr-pass__banner">
      <div class="pr-pass__bannerhead">${Icons.svg('check')}<span>${b.added ? `Se importaron ${plural(b.added, 'contraseña', 'contraseñas')}` : 'No había nada nuevo para importar'}${b.repeated ? ` · ${plural(b.repeated, 'ya estaba', 'ya estaban')}` : ''}</span></div>
      <div class="pr-pass__bannertext">El archivo <b>${esc(b.file)}</b> tiene tus contraseñas sin cifrar. Ya no hace falta: conviene borrarlo.</div>
      <div class="pr-pass__banneractions">
        <button class="op-btn op-btn--ghost op-btn--sm" data-a="banner-close">Lo borro yo</button>
        <button class="op-btn op-btn--secondary op-btn--sm" data-a="forget-import"><i data-icon="trash"></i> Borrar el archivo</button>
      </div>
    </div>`;
}

function field(label, icon, value, { copy = null, mono = false, secret = false, id = null } = {}) {
  return `
    <div class="pr-pass__field">
      <span class="pr-pass__fieldicon">${Icons.svg(icon)}</span>
      <div class="pr-pass__fieldbody">
        <div class="pr-pass__label">${esc(label)}</div>
        <div class="pr-pass__value${mono ? ' is-mono' : ''}${secret ? ' is-secret' : ''}"${id ? ` id="${id}"` : ''}>${value}</div>
      </div>
      ${secret ? `<button class="op-iconbtn op-iconbtn--sm pr-pass__eye${P.revealed?.id === P.sel ? ' is-on' : ''}" data-a="reveal" aria-label="Mostrar" data-tip="${P.revealed?.id === P.sel ? 'Ocultar' : 'Mostrar'}">${Icons.svg('eye', 'pr-eye__a')}${Icons.svg('eyeOff', 'pr-eye__b')}</button>` : ''}
      ${copy ? `<button class="op-iconbtn op-iconbtn--sm pr-pass__copy" data-copy="${copy}" aria-label="Copiar" data-tip="Copiar">${Icons.svg('copy', 'pr-copy__a')}${Icons.svg('check', 'pr-copy__b')}</button>` : ''}
    </div>`;
}

function detailHTML(it) {
  const shown = P.revealed?.id === it.id;
  const fields = [];
  if (it.username) fields.push(field('Usuario', 'user', esc(it.username), { copy: 'username' }));
  if (it.email) fields.push(field('Correo', 'mail', esc(it.email), { copy: 'email' }));
  fields.push(it.hasPassword
    ? field('Contraseña', 'lock', shown ? esc(P.revealed.value) : '<span class="pr-pass__dots"></span>', { copy: 'password', mono: shown, secret: true, id: 'pp-secret' })
    : field('Contraseña', 'lock', '<span class="pr-pass__muted">Ninguna</span>'));

  const meta = [
    it.lastUsedAt && ['wand', 'Último completado automático', when(it.lastUsedAt)],
    ['edit', 'Última modificación', when(it.modifiedAt)],
    ['zap', 'Creado', when(it.createdAt)],
  ].filter(Boolean);

  return `
    <div class="pr-pass__head">
      ${tile(it, true)}
      <div class="pr-pass__headtext">
        <div class="pr-pass__title op-copyable">${esc(it.title)}</div>
        ${it.host ? `<div class="pr-pass__sub">${esc(it.host)}</div>` : ''}
      </div>
      <button class="op-btn op-btn--secondary op-btn--sm" data-a="edit"><i data-icon="edit"></i> Editar</button>
      <button class="op-iconbtn op-iconbtn--sm pr-pass__del${P.confirmDel ? ' is-open' : ''}" data-a="delete" aria-label="Eliminar" data-tip="Eliminar"><i data-icon="trash"></i></button>
    </div>
    <div class="pr-pass__confirm${P.confirmDel ? ' is-open' : ''}"><div class="pr-pass__confirminner"><div class="pr-pass__confirmrow">
      <span class="op-grow">¿Eliminar <b>${esc(it.title)}</b>? No se puede deshacer.</span>
      <button class="op-btn op-btn--ghost op-btn--sm" data-a="delete-no">Cancelar</button>
      <button class="op-btn op-btn--danger-solid op-btn--sm" data-a="delete-yes">Eliminar</button>
    </div></div></div>

    <div class="pr-pass__card">${fields.join('')}</div>

    ${it.urls?.length ? `<div class="pr-pass__card"><div class="pr-pass__field pr-pass__field--top">
      <span class="pr-pass__fieldicon">${Icons.svg('globe')}</span>
      <div class="pr-pass__fieldbody"><div class="pr-pass__label">Sitios web</div>
        <div class="pr-pass__urls">${it.urls.map((u) => `<button class="pr-pass__url" data-open="${esc(u)}" data-tip="Abrir en una pestaña nueva">${esc(u)}</button>`).join('')}</div></div>
    </div></div>` : ''}

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
      <label class="op-field"><span class="op-field__label">Contraseña</span>
        <span class="pr-pass__pwwrap">
          <input class="op-input op-input--mono" name="password" type="password" spellcheck="false" autocomplete="new-password">
          <button type="button" class="op-iconbtn op-iconbtn--sm pr-pass__eye" data-a="form-eye" aria-label="Mostrar">${Icons.svg('eye', 'pr-eye__a')}${Icons.svg('eyeOff', 'pr-eye__b')}</button>
        </span></label>
      <label class="op-field"><span class="op-field__label">Sitios web</span>
        <textarea class="op-textarea pr-pass__urlsinput" name="urls" spellcheck="false" placeholder="https://ejemplo.com (uno por renglón)">${esc((it?.urls || []).join('\n'))}</textarea></label>
      <label class="op-field"><span class="op-field__label">Nota</span>
        <textarea class="op-textarea" name="note" placeholder="Lo que quieras recordar de esta cuenta">${v('note')}</textarea></label>
      <div class="pr-pass__formactions">
        <button type="button" class="op-btn op-btn--ghost op-btn--sm" data-a="cancel">Cancelar</button>
        <button type="submit" class="op-btn op-btn--primary op-btn--sm"><i data-icon="check"></i> Guardar</button>
      </div>
    </form>`;
}

/* Editando, la contraseña se pide recién al abrir el formulario. */
async function fillPasswordField(id) {
  const value = await api.pass.reveal(id).catch(() => '');
  const input = root?.querySelector('#pp-form [name=password]');
  if (input && P.sel === id) input.value = value;
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
  if (field === 'password') say('Contraseña copiada: se borra del portapapeles en 45 s', { icon: 'copy' });
  else say(`${field === 'email' ? 'Correo' : 'Usuario'} copiado`, { icon: 'copy' });
}

async function doImport() {
  let r;
  try {
    r = await api.pass.import();
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'danger', ms: 8000 });
    return;
  }
  if (!r) return;
  P.banner = r;
  await load();
  if (!P.sel) P.sel = filtered()[0]?.id || null;
  P.mode = 'view';
  paintList();
  paintMain();
}

async function submitForm(form) {
  const f = new FormData(form);
  const it = P.mode === 'edit' ? selected() : null;
  try {
    const saved = await api.pass.save({
      id: it?.id,
      title: f.get('title'), username: f.get('username'), email: f.get('email'),
      password: f.get('password'),
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
    say(it ? 'Cambios guardados' : 'Contraseña guardada', { icon: 'check' });
  } catch (err) {
    say(err.message, { icon: 'alert', tone: 'danger', ms: 8000 });
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
      copyField(selected().hasPassword ? 'password' : selected().username ? 'username' : 'email');
    }
  });

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
      const input = b.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.classList.toggle('is-on', show);
      return null;
    }
    if (!it) return null;
    if (a === 'reveal') {
      if (P.revealed?.id === it.id) P.revealed = null;
      else P.revealed = { id: it.id, value: await api.pass.reveal(it.id).catch(() => '') };
      const shown = P.revealed?.id === it.id;
      const v = main.querySelector('#pp-secret');
      if (v) {
        v.classList.toggle('is-mono', shown);
        v.innerHTML = shown ? esc(P.revealed.value) : '<span class="pr-pass__dots"></span>';
      }
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
    el.classList.add('pr-pop--solid');
    el.innerHTML = `
      <div class="pr-pop__head">
        <div class="op-grow">
          <div class="pr-pop__title">${update ? '¿Actualizar la contraseña?' : '¿Guardar la contraseña?'}</div>
          <div class="pr-pop__sub">${esc(o.host)}</div>
        </div>
        <i data-icon="key"></i>
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
