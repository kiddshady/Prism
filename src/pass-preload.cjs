'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: contraseñas y tarjetas
   Corre en cada frame de cada página, en el mundo aislado del preload: la
   página no ve este código ni `ipcRenderer`, aunque comparten el DOM. Hace
   tres cosas:

   · Completar contraseñas (solo el documento principal). Al enfocar un campo
     de login, si Prism tiene contraseñas para ESTE sitio, pide la lista
     debajo del campo. Elegir una completa usuario y contraseña. La contraseña
     recién viaja cuando se elige (y el proceso principal vuelve a chequear el
     sitio: acá no se decide nada).
     La lista no está en la página: la dibuja Prism en una vista propia,
     encima (src/fill.cjs), donde la página no la ve, no la estila ni la tapa.

   · Completar tarjetas (en cualquier frame). Un checkout suele poner el
     número en un iframe chiquito del procesador de pago: el iframe avisa
     hacia arriba dónde está su campo (postMessage, de frame en frame, cada
     uno sumando dónde está su iframe) y la lista la pide el documento
     principal. Las flechas y el Enter llegan desde el
     iframe por el proceso principal. Elegir hace que el proceso principal
     mande la tarjeta a los frames que corresponden, y cada uno completa los
     campos de tarjeta que tiene (src/passwords.cjs decide cuáles).

   · Ofrecer guardar contraseñas. Un envío (submit, Enter, un clic en un
     botón) anota lo que había en los campos; se ofrece guardar recién cuando
     la página se va o el campo de contraseña desaparece. Así un clic en
     "mostrar contraseña" no pregunta nada, y un login fallido (que deja el
     campo ahí) tampoco. Las tarjetas nunca se ofrecen guardar.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcRenderer } = require('electron');

const IS_TOP = window.top === window;

/* ── Los campos ────────────────────────────────────────────────────────── */

const TEXTY = new Set(['text', 'email', 'tel']);
const USERISH = /user|e-?mail|login|correo|usuario|identifier|account|cuenta|dni|cuit|documento/i;
const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;

const isInput = (el) => el instanceof HTMLInputElement;
function visible(el) {
  if (!el?.isConnected || el.disabled) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

function setValue(el, v) {
  if (!el || v == null) return;
  // El setter del prototipo, no `el.value =`: si la página es React, su
  // rastreador de valor tiene que ver la diferencia y disparar onChange.
  (el instanceof HTMLSelectElement ? selectSetter : inputSetter).call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ── Qué campo de tarjeta es cada uno ──────────────────────────────────── */

/** Lo que dice el autocomplete estándar, que es lo primero que se mira. */
const CC_AC = {
  'cc-number': 'number', 'cc-csc': 'cvv', 'cc-exp': 'exp', 'cc-exp-month': 'month', 'cc-exp-year': 'year',
  'cc-name': 'name', 'cc-given-name': 'given', 'cc-family-name': 'family', 'cc-type': 'type',
};
/** Si no lo dice: el nombre, el id, la etiqueta y el placeholder, en castellano y en inglés. */
const CC_RX = [
  ['number', /card.?num|cardnumber|cc.?num|num(ero)?.?(de.?la.?)?tarj|tarjeta.?num|card.?no\b|cardno|credit.?card|debit.?card/i],
  ['cvv', /cvv|cvc|\bcsc\b|cvn|security.?code|c[oó]d(igo)?.?(de.?)?seg|card.?code|securitycode|verification.?(code|number)/i],
  ['month', /(exp|venc|valid).{0,12}(month|mes|\bmm\b)|(month|mes).{0,12}(exp|venc)|cc.?month|card.?month/i],
  ['year', /(exp|venc|valid).{0,12}(year|a[nñ]i?o|\byy\b|\baa\b)|(year|a[nñ]i?o).{0,12}(exp|venc)|cc.?year|card.?year/i],
  ['exp', /expir|exp.?date|\bexp\b|venc|valid.?(thru|until|hasta)|caducidad|\bmm\s*\/\s*(aa|yy)/i],
  ['name', /card.?holder|holder.?name|titular|name.?on.?card|nombre.{0,20}tarjeta|cc.?name/i],
];
/** Lo que se parece pero no es: el DNI del titular, su correo, su dirección. */
const NOT_CC = /doc|dni|cuit|cuil|identif|e-?mail|correo|phone|tel[eé]fono|celular|zip|postal|address|direcci|calle|ciudad|city/i;
const CC_TYPES = new Set(['text', 'tel', 'number', 'password', 'month', 'search']);

function describe(el) {
  const label = el.labels?.[0]?.textContent || el.closest?.('label')?.textContent || '';
  return `${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-testid') || ''} ${label}`.slice(0, 400);
}

/** Qué campo de tarjeta es (number, cvv, exp, month, year, name, given, family, type) o null. */
function ccKind(el) {
  const select = el instanceof HTMLSelectElement;
  if (!select && !(isInput(el) && CC_TYPES.has(el.type) && !el.readOnly)) return null;
  if (el.disabled) return null;
  for (const t of (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/)) if (CC_AC[t]) return CC_AC[t];
  const text = describe(el);
  if (NOT_CC.test(text)) return null;
  for (const [k, rx] of CC_RX) if (rx.test(text)) return k;
  const ph = el.getAttribute('placeholder') || '';
  if (/^\s*(\d{4}[\s-]?){3}\d{1,4}\s*$/.test(ph)) return 'number';
  if (/^\s*mm\s*\/\s*(aa|yy|aaaa|yyyy)\s*$/i.test(ph)) return 'exp';
  return null;
}
const isCardField = (el) => !!el && !!ccKind(el) && visible(el);

/* ── Completar una tarjeta ─────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');
const maxLen = (el) => (isInput(el) && el.maxLength > 0 ? el.maxLength : 0);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Elige en un <select> la opción que coincide con alguna de las pruebas. */
function pick(el, test) {
  const opt = [...el.options].find((o) => !o.disabled && test(o.value.trim().toLowerCase(), o.textContent.trim().toLowerCase()));
  if (opt) setValue(el, opt.value);
}
const leadNum = (s) => Number((s.match(/^\d+/) || [])[0]);

function putMonth(el, m) {
  if (el instanceof HTMLSelectElement) {
    pick(el, (v, t) => Number(v) === m || leadNum(t) === m || t.startsWith(MESES[m - 1]) || t.startsWith(MONTHS[m - 1]));
  } else setValue(el, maxLen(el) === 1 ? String(m) : pad2(m));
}
function putYear(el, y) {
  const yy = String(y).slice(2);
  if (el instanceof HTMLSelectElement) {
    pick(el, (v, t) => v === String(y) || v === yy || t === String(y) || t === yy);
  } else {
    const short = maxLen(el) === 2 || /^\s*(aa|yy)\s*$/i.test(el.placeholder || '');
    setValue(el, short ? yy : String(y));
  }
}
/** Vencimiento en un solo campo, con el formato que el campo espera. */
function expText(el, m, y) {
  const yyyy = String(y);
  if (el.type === 'month') return `${yyyy}-${pad2(m)}`;
  const ph = (el.placeholder || '').toLowerCase();
  const ml = maxLen(el);
  const spaced = / \/ /.test(ph);
  const long = /aaaa|yyyy/.test(ph) || (ml >= 7 && !spaced) || ml >= 9;
  const sep = ml === 4 || (ml === 6 && long) ? '' : spaced ? ' / ' : '/';
  return `${pad2(m)}${sep}${long ? yyyy : yyyy.slice(2)}`;
}

let cardEl = null;      // el último campo de tarjeta enfocado en este frame
/* La lista de un campo de un iframe, en el documento principal (se define
   abajo, adentro de su bloque: en modo estricto una función de bloque no se
   ve desde afuera). */
let openRemote = () => {};

function fillCard(card, mine) {
  // En el frame donde se eligió, el formulario de ese campo; en los demás, todo.
  const scope = (mine && cardEl?.isConnected && (cardEl.form || cardEl.closest('form'))) || document;
  const fields = [...scope.querySelectorAll('input, select')].filter(visible).map((el) => ({ el, k: ccKind(el) })).filter((f) => f.k);
  const [given, ...rest] = String(card.holder || '').split(/\s+/);
  const nums = fields.filter((f) => f.k === 'number');
  // El número partido en cuatro cajitas de a cuatro.
  if (nums.length > 1 && nums.every((f) => maxLen(f.el) > 0 && maxLen(f.el) <= 6)) {
    let at = 0;
    for (const f of nums) { setValue(f.el, card.number.slice(at, at + maxLen(f.el))); at += maxLen(f.el); }
  } else nums.forEach((f) => setValue(f.el, card.number));
  for (const { el, k } of fields) {
    if (k === 'cvv' && card.cvv) setValue(el, card.cvv);
    else if (k === 'name' && card.holder) setValue(el, card.holder);
    else if (k === 'given' && given) setValue(el, given);
    else if (k === 'family' && rest.length) setValue(el, rest.join(' '));
    else if (card.month && k === 'month') putMonth(el, card.month);
    else if (card.year && k === 'year') putYear(el, card.year);
    else if (card.month && k === 'exp') {
      if (el instanceof HTMLSelectElement) pick(el, (v, t) => [v, t].some((s) => s.replace(/\s/g, '') === expText({ placeholder: '' }, card.month, card.year)));
      else setValue(el, expText(el, card.month, card.year));
    } else if (k === 'type' && card.brand && el instanceof HTMLSelectElement) {
      const b = card.brand.toLowerCase().split(' ')[0];
      pick(el, (v, t) => v.includes(b) || t.includes(b));
    }
  }
}
ipcRenderer.on('pay:put', (_e, card, mine) => { if (card?.number) fillCard(card, mine); });

/* ── Tarjetas en un iframe: la lista se cuelga arriba ──────────────────── */

/* El rectángulo de un campo, pasado de iframe en iframe hasta el documento
   principal. Cada frame suma dónde está, adentro suyo, el iframe que le
   habló. El mensaje lo ve también la página (solo trae un rectángulo): lo que
   importa viaja por el proceso principal. */
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.prismPay !== 'anchor' || !e.source || e.source === window) return;
  const r = d.rect || {};
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return;
  const frameEl = [...document.querySelectorAll('iframe, frame')].find((f) => f.contentWindow === e.source);
  if (!frameEl) return;
  const fr = frameEl.getBoundingClientRect();
  const cs = getComputedStyle(frameEl);
  const rect = {
    x: r.x + fr.left + frameEl.clientLeft + parseFloat(cs.paddingLeft || 0),
    y: r.y + fr.top + frameEl.clientTop + parseFloat(cs.paddingTop || 0),
    w: r.w, h: r.h,
  };
  if (IS_TOP) openRemote(rect);
  else parent.postMessage({ prismPay: 'anchor', rect }, '*');
});

if (!IS_TOP) {
  let state = 0;        // la lista de arriba: 0 cerrada · 1 abierta · 2 abierta con una elegida
  let seq = 0;
  ipcRenderer.on('pay:open', (_e, s) => { state = Number(s) || 0; });

  async function openCard(el) {
    const n = ++seq;
    cardEl = el;
    const found = await ipcRenderer.invoke('pay:query').catch(() => []);
    if (n !== seq || document.activeElement !== el || !found.length) return;
    const r = el.getBoundingClientRect();
    parent.postMessage({ prismPay: 'anchor', rect: { x: r.left, y: r.top, w: r.width, h: r.height } }, '*');
  }

  document.addEventListener('focusin', (e) => { if (isCardField(e.target)) openCard(e.target); }, true);
  document.addEventListener('focusout', (e) => {
    if (e.target !== cardEl) return;
    seq++;
    state = 0;
    ipcRenderer.send('pay:blur');
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.isTrusted && e.target === document.activeElement && !state && isCardField(e.target)) openCard(e.target);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !state || e.target !== cardEl) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) return;
    // El Enter es de la lista si hay una fila elegida; si no, sigue siendo del formulario.
    if (e.key.startsWith('Arrow') || (e.key === 'Enter' && state === 2)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    ipcRenderer.send('pay:key', e.key);
  }, true);
}

/* ═══ El documento principal ═══════════════════════════════════════════════ */

if (IS_TOP) {
  /* ── Los campos de login ─────────────────────────────────────────────── */

  // Un código de seguridad en un campo de contraseña no es una contraseña.
  const isPw = (el) => isInput(el) && el.type === 'password' && visible(el) && !ccKind(el);
  const isTexty = (el) => isInput(el) && TEXTY.has(el.type) && !el.readOnly && visible(el);
  function isUserish(el) {
    if (!isTexty(el)) return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.includes('username') || ac === 'email' || el.type === 'email') return true;
    return USERISH.test(`${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`);
  }
  const pwFields = () => [...document.querySelectorAll('input[type=password]')].filter(isPw);
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  /** El campo de usuario de una contraseña: el último de texto antes de ella, en su formulario. */
  function userFieldFor(pw) {
    const scope = pw.form || document;
    const cands = [...scope.querySelectorAll('input')].filter((el) => isTexty(el) && before(el, pw));
    return cands.filter(isUserish).pop() || cands.pop() || null;
  }

  /** Usuario y contraseña alrededor de un campo de login (cualquiera puede faltar). */
  function around(el) {
    if (isPw(el)) return { user: userFieldFor(el), pw: el };
    const pw = pwFields().find((p) => before(el, p) && (!el.form || p.form === el.form)) || null;
    return { user: el, pw };
  }

  /** Si un campo es de login: una contraseña, su usuario, o el correo solo del primer paso. */
  function isLoginField(el) {
    if (isPw(el)) return true;
    if (!isTexty(el) || ccKind(el)) return false;
    const pws = pwFields();
    if (pws.length) return pws.some((p) => userFieldFor(p) === el);
    return isUserish(el);
  }
  const kindFor = (el) => (isCardField(el) ? 'card' : isLoginField(el) ? 'login' : null);

  /* ── La lista ────────────────────────────────────────────────────────── */

  /* La dibuja Prism en una vista propia, encima de la página (src/fill.cjs):
     acá ya no se pinta nada. Vivía en el DOM de la página, en un shadow root
     cerrado: la página no leía las filas, pero podía volver invisible la
     lista o taparla y hacerte elegir una tarjeta con un click que creías dar
     en otra cosa. Acá queda lo que solo la página sabe: dónde está el campo
     y qué teclas se aprietan. */

  /* anchor: dónde se cuelga. { el, rect, remote } — remote es un campo de un
     iframe: no hay elemento acá, solo su rectángulo. */
  let anchor = null; let items = []; let active = -1; let openSeq = 0; let rafId = 0;
  /** El número con que se pidió la lista que está a la vista: lo que vuelve de Prism tiene que traerlo. */
  let shownSeq = 0;

  const rectOf = (a) => { const r = a.rect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

  function place() {
    if (!anchor) return;
    if (anchor.el && (!anchor.el.isConnected || !visible(anchor.el))) { close(); return; }
    ipcRenderer.send('fill:move', { seq: shownSeq, rect: rectOf(anchor) });
  }
  const schedule = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(place); };

  /** Al iframe que tiene el foco: si la lista está abierta y si hay una fila elegida. */
  const tellRemote = () => { if (anchor?.remote) ipcRenderer.send('pay:open', active >= 0 ? 2 : 1); };

  /** `echo`: avisarle a la lista (no hace falta si el cambio vino de ella, del mouse). */
  function setActive(i, { echo = true } = {}) {
    active = i;
    if (echo) ipcRenderer.send('fill:active', { seq: shownSeq, i });
    tellRemote();
  }

  function show(where, found, k) {
    anchor = where;
    items = found;
    active = -1;
    shownSeq = openSeq;
    ipcRenderer.send('fill:show', { seq: shownSeq, kind: k, rect: rectOf(where), items: found });
    tellRemote();
  }

  async function open(el, k) {
    const seq = ++openSeq;
    if (k === 'card') cardEl = el;
    const found = await ipcRenderer.invoke(k === 'card' ? 'pay:query' : 'pass:page-query').catch(() => []);
    if (seq !== openSeq || document.activeElement !== el || !found.length) return;
    show({ el, rect: () => el.getBoundingClientRect(), remote: false, kind: k }, found, k);
  }

  /* Un campo de tarjeta de un iframe: la lista la pide este documento (el
     proceso principal la da solo si un iframe acaba de pedirla). */
  openRemote = async (rect) => {
    const seq = ++openSeq;
    const found = await ipcRenderer.invoke('pay:menu').catch(() => []);
    if (seq !== openSeq || !found.length) return;
    const r = new DOMRect(rect.x, rect.y, rect.w, rect.h);
    show({ el: null, rect: () => r, remote: true, kind: 'card' }, found, 'card');
  };

  function close() {
    openSeq++;
    if (anchor?.remote) ipcRenderer.send('pay:open', 0);
    if (anchor) ipcRenderer.send('fill:hide', { seq: shownSeq });
    anchor = null;
  }

  const isOpen = () => !!anchor;

  async function choose(i) {
    const it = items[i];
    const a = anchor;
    if (!it || !a) return;
    close();
    if (a.kind === 'card') {
      await ipcRenderer.invoke('pay:fill', it.id).catch(() => false);
      a.el?.focus();
      return;
    }
    const cred = await ipcRenderer.invoke('pass:page-fill', it.id).catch(() => null);
    if (!cred) return;
    const { user, pw } = around(a.el);
    if (user && cred.login) setValue(user, cred.login);
    if (pw && cred.password) setValue(pw, cred.password);
    a.el.focus();
  }

  /** Flechas, Enter, Escape y Tab sobre la lista abierta. true si la tecla fue de la lista. */
  function onKey(key) {
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const n = items.length;
      setActive(key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
      return true;
    }
    if (key === 'Enter' && active >= 0) { choose(active); return true; }
    if (key === 'Escape' || key === 'Tab' || key === 'Enter') close();
    return false;
  }

  /* Lo que vuelve de la lista de Prism. */
  // La cerró Prism (otra pestaña, un menú del cromo, un click afuera): sin avisar de vuelta.
  ipcRenderer.on('fill:gone', (_e, seq) => {
    if (!anchor || seq !== shownSeq) return;
    if (anchor.remote) ipcRenderer.send('pay:open', 0);
    anchor = null;
    openSeq++;
  });
  // El mouse sobre una fila: un Enter después elige esa.
  ipcRenderer.on('fill:hover', (_e, d) => { if (anchor && d?.seq === shownSeq) setActive(Number(d.i), { echo: false }); });
  // Un click en una fila.
  ipcRenderer.on('fill:choose', (_e, d) => { if (anchor && d?.seq === shownSeq) choose(Number(d.i)); });

  /* ── Cuándo aparece ──────────────────────────────────────────────────── */

  document.addEventListener('focusin', (e) => {
    // El mismo campo que vuelve a tener el foco (la página lo recuperó de la lista): la lista sigue.
    if (anchor?.el && e.target === anchor.el) return;
    const k = kindFor(e.target);
    if (k) open(e.target, k);
    // Pasar a otro iframe no la cierra: si era de un iframe, la cierra su pay:blur.
    else if (anchor && !(anchor.remote && /^i?frame$/i.test(e.target?.tagName || ''))) close();
  }, true);
  /* El campo perdió el foco. Puede ser un click en la lista de Prism, que es
     otra vista y se lleva el foco: Prism espera un momento antes de cerrarla
     (src/fill.cjs). */
  document.addEventListener('focusout', (e) => {
    if (anchor?.el && e.target === anchor.el) ipcRenderer.send('fill:blur', { seq: shownSeq });
  }, true);
  // Un clic en el campo que ya tenía el foco (y cuya lista se cerró) la vuelve a abrir.
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.target !== document.activeElement || isOpen()) return;
    const k = kindFor(e.target);
    if (k) open(e.target, k);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!isOpen() || !anchor.el || e.target !== anchor.el) return;
    // Las teclas que mueven y eligen son de la persona: las que inventa la página no cuentan.
    if (!e.isTrusted) return;
    if (e.key === 'Enter' && active < 0) { close(); return; }
    if (onKey(e.key) && e.key !== 'Escape' && e.key !== 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  ipcRenderer.on('pay:key', (_e, key) => { if (isOpen() && anchor.remote) onKey(key); });
  // El iframe perdió el foco: como el focusout de arriba, Prism decide si fue un click en la lista.
  ipcRenderer.on('pay:blur', () => { if (anchor?.remote) ipcRenderer.send('fill:blur', { seq: shownSeq }); });
  addEventListener('scroll', () => { if (anchor?.remote) close(); else if (anchor) schedule(); }, true);
  addEventListener('resize', () => { if (anchor?.remote) close(); else if (anchor) schedule(); });

  /* ── Ofrecer guardar ─────────────────────────────────────────────────── */

  let pending = null;       // { login, password, pw }
  let watch = 0;
  let lastSent = '';

  function send() {
    clearInterval(watch);
    const p = pending;
    pending = null;
    if (!p) return;
    const key = `${p.login}\n${p.password}`;
    if (key === lastSent) return;
    lastSent = key;
    ipcRenderer.send('pass:page-capture', { login: p.login, password: p.password });
  }

  /** Anota lo que hay en los campos en el momento del envío. */
  function note(target) {
    const pws = pwFields().filter((p) => p.value);
    if (!pws.length) {
      // El primer paso de un login en dos pasos: solo el usuario.
      const scope = target?.form || target?.closest?.('form') || document;
      const u = [...scope.querySelectorAll('input')].find((el) => isUserish(el) && el.value.trim());
      if (u) ipcRenderer.send('pass:page-step', u.value.trim());
      return;
    }
    // En un cambio de contraseña (actual, nueva, repetir) la que vale es la última.
    const pw = pws[pws.length - 1];
    pending = { login: userFieldFor(pws[0])?.value.trim() || '', password: pw.value, pw };
    clearInterval(watch);
    const t0 = Date.now();
    // Una SPA no navega: se nota que entró porque el campo desaparece.
    watch = setInterval(() => {
      if (!pending) { clearInterval(watch); return; }
      if (!isPw(pending.pw)) send();
      else if (Date.now() - t0 > 10000) { clearInterval(watch); pending = null; }
    }, 400);
  }

  document.addEventListener('submit', (e) => {
    if (e.isTrusted || navigator.userActivation?.isActive) note(e.target);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && isInput(e.target)) note(e.target);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest?.('button, input[type=submit], input[type=image], [role=button]');
    if (b) note(b);
  }, true);
  addEventListener('pagehide', () => { if (pending) send(); close(); });
}
