'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la bóveda de contraseñas (la lógica, sin Electron)
   Lo que se guarda, cómo se decide a qué sitio pertenece cada contraseña y
   cómo se lee una exportación de Proton Pass. El cifrado entra de afuera
   (seal/unseal): en la app es DPAPI vía safeStorage (src/passwords.cjs), en
   los tests es texto plano. Así esto se prueba con node pelado.

   ── En disco ───────────────────────────────────────────────────────────────
   Un solo archivo, `vault.json`: { v, blob } donde blob es TODA la bóveda
   cifrada de una vez. Ni los sitios ni los usuarios quedan a la vista: un
   archivo con "estos son los 122 lugares donde tenés cuenta" ya es un dato.

   ── A qué sitio pertenece una contraseña ──────────────────────────────────
   Al "sitio" del host, no al host exacto: la de accounts.google.com sirve en
   mail.google.com. El sitio es el dominio registrable (google.com,
   mercadolibre.com.ar). Sin la lista pública de sufijos entera, se cubre lo
   que importa: los ccTLD de segundo nivel (com.ar, co.uk…) y los hostings
   donde cada subdominio es de otra persona (github.io, vercel.app…). Ahí el
   sitio es el subdominio: la contraseña de tu-blog.github.io NO se ofrece en
   el-de-otro.github.io.

   ── Tarjetas ───────────────────────────────────────────────────────────────
   Viven en la misma bóveda (kind: 'card'), así que van en el mismo blob
   cifrado. No son de ningún sitio: se ofrecen en cualquier checkout seguro,
   y por eso lo que las cuida está en otro lado (src/passwords.cjs). Lo
   secreto de una tarjeta es el número, el código y el PIN: nada de eso sale
   en la lista, que muestra la marca y los últimos cuatro.

   ── Códigos de doble factor ────────────────────────────────────────────────
   También en el mismo blob (kind: 'totp'), y por lo tanto en el mismo
   respaldo. Lo secreto es la clave: el código de seis dígitos se calcula en
   el proceso principal (src/totp.cjs) y es lo único que llega al cromo.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const zlib = require('zlib');
const T = require('./totp.cjs');

/* ── Sitios ──────────────────────────────────────────────────────────────── */

/** Segundo nivel de los ccTLD que venden dominios "adentro" (com.ar, co.uk…). */
const SLD = new Set(['com', 'net', 'org', 'gob', 'gov', 'edu', 'co', 'ac', 'mil', 'int', 'nom', 'ltd', 'plc', 'sch', 'or', 'ne', 'go', 'info', 'tur', 'blog', 'web']);

/** Hostings donde cada subdominio es de alguien distinto. */
const SHARED = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'appspot.com', 'azurewebsites.net',
  'cloudfront.net', 'glitch.me', 'onrender.com', 'fly.dev', 'ngrok-free.app', 'ngrok.io',
  'repl.co', 'replit.app', 'wordpress.com', 'tumblr.com', 'neocities.org', 's3.amazonaws.com',
];

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** El host de una dirección, con o sin esquema. '' si no es http(s). */
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** El dominio registrable de un host: accounts.google.com → google.com. */
function siteOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || isIp(h) || !h.includes('.')) return h;
  const shared = SHARED.find((s) => h === s || h.endsWith(`.${s}`));
  const labels = h.split('.');
  if (shared) return labels.slice(-(shared.split('.').length + 1)).join('.');
  const n = labels.length;
  if (n >= 3 && labels[n - 1].length === 2 && SLD.has(labels[n - 2])) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/** Lo que se muestra de un host: sin www. */
const prettyHost = (h) => String(h || '').replace(/^www\./, '');

/* ── Elementos ───────────────────────────────────────────────────────────── */

const clip = (v, max) => String(v ?? '').slice(0, max);
const cleanUrls = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\n,]\s*/))
  .map((u) => String(u).trim()).filter((u) => u && hostOf(u)))].slice(0, 20);

/** Lo que entra (del panel, de una importación): siempre saneado acá. */
function normalize(raw = {}, now = Date.now()) {
  const urls = cleanUrls(raw.urls);
  const title = clip(raw.title, 200).trim() || prettyHost(hostOf(urls[0])) || 'Sin título';
  const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    kind: 'login',
    title,
    username: clip(raw.username, 300).trim(),
    email: clip(raw.email, 300).trim(),
    password: clip(raw.password, 4000),
    urls,
    note: clip(raw.note, 20000),
    createdAt: time(raw.createdAt) || now,
    modifiedAt: time(raw.modifiedAt) || time(raw.createdAt) || now,
    lastUsedAt: time(raw.lastUsedAt),
  };
}

/* ── Tarjetas ────────────────────────────────────────────────────────────── */

const isCard = (it) => it?.kind === 'card';
const digits = (v, max) => String(v ?? '').replace(/\D/g, '').slice(0, max);

/** La marca por los primeros dígitos. '' si no se reconoce. */
function brandOf(number) {
  const n = digits(number, 19);
  if (/^4/.test(n)) return 'visa';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^589562/.test(n)) return 'naranja';
  if (/^(589657|60420[1-3]|6271(70|71))/.test(n)) return 'cabal';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'mastercard';
  if (/^(5018|5020|5038|5893|6304|6759|676[1-3])/.test(n)) return 'maestro';
  if (/^3(0[0-5]|[689])/.test(n)) return 'diners';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  return '';
}
const BRANDS = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', naranja: 'Naranja', cabal: 'Cabal',
  maestro: 'Maestro', diners: 'Diners Club', discover: 'Discover',
};
const brandName = (b) => BRANDS[b] || '';

/** Un vencimiento como venga ("2029-08", "082029", "08/29", "8/2029") → "2029-08". '' si no se entiende. */
function parseExpiry(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let r = s.match(/^(\d{4})-(\d{1,2})$/);
  let m; let y;
  if (r) [, y, m] = r;
  else if ((r = s.match(/^(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})$/) || s.match(/^(\d{2})(\d{4}|\d{2})$/))) [, m, y] = r;
  else return '';
  const mm = Number(m);
  const yy = Number(y) + (y.length === 2 ? 2000 : 0);
  if (!(mm >= 1 && mm <= 12) || yy < 2000 || yy > 2099) return '';
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

/** "2029-08" → "08/29". */
const shortExpiry = (e) => (e ? `${e.slice(5, 7)}/${e.slice(2, 4)}` : '');

/** Una tarjeta que entra (del panel, de una importación), saneada. */
function normalizeCard(raw = {}, now = Date.now()) {
  const number = digits(raw.number, 19);
  const brand = brandOf(number);
  const last4 = number.slice(-4);
  const end = last4 ? ` terminada en ${last4}` : '';
  const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    kind: 'card',
    title: clip(raw.title, 200).trim() || `${brandName(brand) || 'Tarjeta'}${end}`,
    holder: clip(raw.holder, 200).trim(),
    number,
    expiry: parseExpiry(raw.expiry),
    cvv: digits(raw.cvv, 4),
    pin: clip(raw.pin, 12).trim(),
    note: clip(raw.note, 20000),
    createdAt: time(raw.createdAt) || now,
    modifiedAt: time(raw.modifiedAt) || time(raw.createdAt) || now,
    lastUsedAt: time(raw.lastUsedAt),
  };
}

/* ── Códigos ─────────────────────────────────────────────────────────────── */

const isCode = (it) => it?.kind === 'totp';
/** Solo los logins pertenecen a un sitio: ni las tarjetas ni los códigos se ofrecen en una página. */
const isLogin = (it) => !isCard(it) && !isCode(it);

/** Un código que entra (del panel, de un QR, de una importación), saneado. */
function normalizeCode(raw = {}, now = Date.now()) {
  const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const algorithm = String(raw.algorithm || 'SHA1').toUpperCase().replace('-', '');
  const digits = Number(raw.digits);
  const period = Number(raw.period);
  const account = clip(raw.account, 300).trim();
  return {
    kind: 'totp',
    title: clip(raw.title || raw.issuer, 200).trim() || account || 'Sin título',
    account,
    secret: T.normalizeSecret(raw.secret).slice(0, 512),
    algorithm: T.ALGORITHMS.includes(algorithm) ? algorithm : 'SHA1',
    digits: [6, 7, 8].includes(digits) ? digits : 6,
    period: Number.isInteger(period) && period >= 5 && period <= 300 ? period : 30,
    note: clip(raw.note, 20000),
    createdAt: time(raw.createdAt) || now,
    modifiedAt: time(raw.modifiedAt) || time(raw.createdAt) || now,
    lastUsedAt: time(raw.lastUsedAt),
  };
}

const NORMALIZE = { login: normalize, card: normalizeCard, totp: normalizeCode };
const kindOf = (it) => (isCard(it) ? 'card' : isCode(it) ? 'totp' : 'login');

/** Con qué se entra: el usuario si hay, si no el correo. */
const loginOf = (it) => it.username || it.email || '';

/** Un elemento para mostrar: todo menos lo secreto (la contraseña; el número, el código y el PIN; la clave de un código). */
function publicItem(it) {
  if (isCode(it)) {
    const { secret, ...rest } = it;
    return { ...rest, hasSecret: !!secret };
  }
  if (isCard(it)) {
    const { number, cvv, pin, ...rest } = it;
    return { ...rest, brand: brandOf(number), last4: number.slice(-4), hasNumber: !!number, hasCvv: !!cvv, hasPin: !!pin };
  }
  const { password, ...rest } = it;
  return { ...rest, kind: 'login', hasPassword: !!password, host: prettyHost(hostOf(it.urls[0])) };
}

/* ── La bóveda ───────────────────────────────────────────────────────────── */

function createVault({ doc, seal, unseal, now = () => Date.now(), onPersist = null }) {
  let items = [];
  /* Si el archivo existe pero no se pudo leer (tomado por otro programa, sin
     permiso) o descifrar (otra cuenta de Windows, un archivo roto), NO se
     escribe nunca: guardar encima de una bóveda que no se pudo leer la
     borraría. */
  let broken = null;
  /** No se pudo leer el archivo (no es que no se pudo descifrar): otro intento puede andar. */
  let unread = false;
  /** Si estaba ilegible y se apartó (store.cjs), adónde: la bóveda arrancó vacía. */
  let aside = null;
  let chain = Promise.resolve();

  async function load() {
    let data;
    try {
      data = await doc.read();
      unread = false;
      broken = null;
    } catch (err) {
      items = [];
      unread = true;
      broken = `no se pudo leer el archivo${err?.code ? ` (${err.code})` : ''}`;
      return;
    }
    aside = doc.aside || null;
    if (!data) { items = []; return; }
    try {
      const parsed = JSON.parse(unseal(Buffer.from(String(data.blob || ''), 'base64')));
      items = Array.isArray(parsed.items) ? parsed.items : [];
      broken = null;
    } catch (err) {
      items = [];
      broken = err?.message || 'no se pudo descifrar';
    }
  }

  function persist() {
    if (broken) return Promise.reject(new Error('La bóveda no se pudo abrir: no se guarda nada para no pisarla.'));
    const blob = seal(JSON.stringify({ items })).toString('base64');
    chain = chain.then(() => doc.write({ v: 1, blob }), () => doc.write({ v: 1, blob }));
    // Lo que quedó en disco es lo que se respalda (src/backup.cjs).
    if (onPersist) chain.then(() => onPersist(), () => {});
    return chain;
  }

  const get = (id) => items.find((it) => it.id === id) || null;
  const newId = () => `p-${crypto.randomBytes(6).toString('hex')}`;

  /** Crea (sin id) o edita (con id). Devuelve el elemento público. */
  async function save(raw = {}) {
    const prev = raw.id ? get(String(raw.id)) : null;
    if (raw.id && !prev) throw new Error('Ese elemento ya no existe.');
    const t = now();
    // Editar no cambia la clase: una contraseña no se vuelve tarjeta.
    const kind = prev ? kindOf(prev) : kindOf(raw);
    const it = { ...NORMALIZE[kind]({ ...prev, ...raw }, t), id: prev?.id || newId() };
    if (prev) {
      it.createdAt = prev.createdAt;
      it.lastUsedAt = prev.lastUsedAt;
      it.modifiedAt = t;
      items[items.indexOf(prev)] = it;
    } else {
      items.unshift(it);
    }
    await persist();
    return publicItem(it);
  }

  /* Borrar no pregunta (desde 1.12.1): a cambio, el último borrado se puede
     traer de vuelta entero, con su id, su secreto y su lugar. */
  let trash = null;
  async function remove(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    const [it] = items.splice(i, 1);
    trash = { it, i };
    await persist();
    return true;
  }

  async function undoRemove() {
    if (!trash || get(trash.it.id)) return null;
    const { it, i } = trash;
    trash = null;
    items.splice(Math.min(i, items.length), 0, it);
    await persist();
    return publicItem(it);
  }

  /** Los elementos de un sitio, primero los del host exacto y los usados hace poco. */
  function findFor(url) {
    const host = hostOf(url);
    if (!host) return [];
    const site = siteOf(host);
    const scored = [];
    for (const it of items) {
      if (!isLogin(it)) continue;
      let score = 0;
      for (const u of it.urls) {
        const h = hostOf(u);
        if (h === host) { score = 2; break; }
        if (h && siteOf(h) === site) score = Math.max(score, 1);
      }
      if (score) scored.push({ it, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || (b.it.lastUsedAt || 0) - (a.it.lastUsedAt || 0))
      .map((x) => x.it);
  }

  /** Las tarjetas, primero las usadas hace poco. */
  const cards = () => items.filter(isCard)
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));

  async function markUsed(id) {
    const it = get(id);
    if (!it) return;
    it.lastUsedAt = now();
    await persist().catch(() => {});
  }

  /** Suma lo importado, salteando lo que ya está igual (mismo sitio, login y
      contraseña; en una tarjeta, el mismo número; en un código, la misma clave). */
  async function importItems(list) {
    const seen = new Set(items.map(keyOf));
    let added = 0; let repeated = 0; let cardsAdded = 0; let codesAdded = 0;
    for (const raw of list) {
      const kind = kindOf(raw);
      const it = { ...NORMALIZE[kind](raw, now()), id: newId() };
      // Un código sin clave no sirve para nada: no es un elemento, es un error de la exportación.
      if (kind === 'totp' && !T.isValidSecret(it.secret)) continue;
      const k = keyOf(it);
      if (seen.has(k)) { repeated++; continue; }
      seen.add(k);
      items.push(it);
      added++;
      if (kind === 'card') cardsAdded++;
      if (kind === 'totp') codesAdded++;
    }
    if (added) await persist();
    return { added, repeated, cards: cardsAdded, codes: codesAdded };
  }

  /** El código que ya tiene esta clave (para no agregar dos veces el mismo QR). */
  const codeWith = (secret) => {
    const s = T.normalizeSecret(secret);
    return items.find((it) => isCode(it) && it.secret === s) || null;
  };

  /** El código vigente de un elemento, sin la clave. */
  function code(id, at = now()) {
    const it = get(id);
    if (!isCode(it) || !it.secret) return null;
    const c = T.totp(it.secret, { digits: it.digits, period: it.period, algorithm: it.algorithm, now: at });
    return { code: c.code, counter: c.counter, msLeft: c.msLeft, period: c.period };
  }

  return {
    load,
    get broken() { return broken; },
    get aside() { return aside; },
    /** Si al arrancar no se pudo leer, lo intenta de nuevo (no pisa nada: no había nada cargado). */
    retryRead: () => (unread ? load() : Promise.resolve()),
    get size() { return items.length; },
    list: () => items.map(publicItem).sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' })),
    get,
    save,
    remove,
    undoRemove,
    findFor,
    cards,
    markUsed,
    importItems,
    codeWith,
    code,
    /** La bóveda entera, con lo secreto: solo para respaldarla (src/backup.cjs). */
    dump: () => structuredClone(items),
  };
}

/** Lo que identifica a un elemento al importar: dos iguales no se suman. */
function keyOf(it) {
  if (isCard(it)) return `card|${it.number}`;
  if (isCode(it)) return `totp|${it.secret}`;
  return `${siteOf(hostOf(it.urls[0]))}|${loginOf(it).toLowerCase()}|${it.password}`;
}

/* ── Importar ────────────────────────────────────────────────────────────── */

/** El código de doble factor de un login exportado (Proton Pass lo guarda adentro del login). */
function codeFromUri(uri, raw) {
  const s = String(uri || '').trim();
  if (!s) return null;
  let acc;
  try {
    if (T.isOtpauth(s)) acc = T.parseOtpauth(s);
    else if (T.isValidSecret(s)) acc = { secret: T.normalizeSecret(s) };   // a veces es la clave sola
    else return null;
  } catch {
    return null;
  }
  return {
    kind: 'totp',
    ...acc,
    title: raw.title || acc.issuer || '',
    account: acc.account || raw.username || raw.email || '',
    createdAt: raw.createdAt,
    modifiedAt: raw.modifiedAt,
  };
}

/** Las cuentas de un QR o de un respaldo de Tessera, como elementos de la bóveda. */
const codeItems = (accounts) => accounts.map((a) => ({ kind: 'totp', ...a, title: a.issuer }));

/** CSV de RFC 4180: comillas, comillas dobladas, saltos de línea adentro de un campo. */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Una fecha de exportación: segundos, milisegundos o ISO. */
function timeOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
}

/* Los nombres de columna de Proton Pass, y de paso los de Chrome, Bitwarden y
   compañía: una exportación de otro lado entra igual. */
const COLS = {
  type: ['type'],
  title: ['name', 'title'],
  url: ['url', 'urls', 'website', 'login_uri', 'origin'],
  email: ['email'],
  username: ['username', 'login_username', 'login'],
  password: ['password', 'login_password'],
  note: ['note', 'notes', 'extra'],
  totp: ['totp', 'login_totp', 'otpauth'],
  createdAt: ['createtime', 'created'],
  modifiedAt: ['modifytime', 'modified'],
  lastUsedAt: ['lastusetime', 'last_used'],
};

function fromCsv(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error('El archivo está vacío.');
  const names = head.map((h) => h.trim().toLowerCase());
  const col = (k) => COLS[k].map((n) => names.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idx = Object.fromEntries(Object.keys(COLS).map((k) => [k, col(k)]));
  if (idx.password < 0 && idx.username < 0 && idx.email < 0) throw new Error('No parece una exportación de contraseñas: no tiene columnas de usuario ni de contraseña.');
  const at = (r, k) => (idx[k] >= 0 ? r[idx[k]] ?? '' : '');
  const out = []; let skipped = 0;
  for (const r of rows) {
    const type = at(r, 'type').trim().toLowerCase();
    if (type && type !== 'login') { skipped++; continue; }
    const it = {
      title: at(r, 'title'), username: at(r, 'username'), email: at(r, 'email'), password: at(r, 'password'),
      urls: at(r, 'url'), note: at(r, 'note'),
      createdAt: timeOf(at(r, 'createdAt')), modifiedAt: timeOf(at(r, 'modifiedAt')), lastUsedAt: timeOf(at(r, 'lastUsedAt')),
    };
    out.push(it);
    const code = codeFromUri(at(r, 'totp'), it);
    if (code) out.push(code);
  }
  return { items: out, skipped };
}

/** El data.json de Proton Pass (el de adentro del .zip sin cifrar). */
function fromProtonJson(data) {
  if (data?.encrypted) throw new Error('Esa exportación está cifrada con PGP. Exportá de nuevo eligiendo el formato sin cifrar (ZIP o CSV).');
  if (!data?.vaults || typeof data.vaults !== 'object') throw new Error('No parece una exportación de Proton Pass.');
  const out = []; let skipped = 0;
  for (const vault of Object.values(data.vaults)) {
    for (const item of vault?.items || []) {
      const d = item?.data || {};
      const c = d.content || {};
      // state 2 es la papelera de Proton Pass.
      if (item.state === 2 || (d.type !== 'login' && d.type !== 'creditCard')) { skipped++; continue; }
      if (d.type === 'creditCard') {
        out.push({
          kind: 'card',
          title: d.metadata?.name,
          holder: c.cardholderName,
          number: c.number,
          expiry: c.expirationDate,
          cvv: c.verificationNumber,
          pin: c.pin,
          note: d.metadata?.note,
          createdAt: timeOf(item.createTime),
          modifiedAt: timeOf(item.modifyTime),
          lastUsedAt: timeOf(item.lastUseTime),
        });
        continue;
      }
      const it = {
        title: d.metadata?.name,
        username: c.itemUsername ?? (c.itemEmail == null ? c.username : ''),
        email: c.itemEmail ?? '',
        password: c.password,
        urls: c.urls || [],
        note: d.metadata?.note,
        createdAt: timeOf(item.createTime),
        modifiedAt: timeOf(item.modifyTime),
        lastUsedAt: timeOf(item.lastUseTime),
      };
      out.push(it);
      const code = codeFromUri(c.totpUri, it);
      if (code) out.push(code);
    }
  }
  return { items: out, skipped };
}

/** Los archivos de un .zip (solo lo que hace falta: guardados o deflate). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El .zip está roto.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Lee lo que la persona eligió: .csv, .json o el .zip de Proton Pass, o el .txt de Tessera. */
function parseExport(name, buf) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.pgp') || lower.endsWith('.gpg')) {
    throw new Error('Esa exportación está cifrada con PGP. Exportá de nuevo eligiendo el formato sin cifrar (ZIP o CSV).');
  }
  if (lower.endsWith('.zip')) {
    const files = unzip(buf);
    const json = Object.keys(files).find((f) => /(^|\/)data\.json$/i.test(f)) || Object.keys(files).find((f) => f.toLowerCase().endsWith('.json'));
    const csv = Object.keys(files).find((f) => f.toLowerCase().endsWith('.csv'));
    if (json) return fromProtonJson(JSON.parse(files[json].toString('utf8')));
    if (csv) return fromCsv(files[csv].toString('utf8'));
    throw new Error('El .zip no tiene un data.json ni un .csv adentro.');
  }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (lower.endsWith('.json') || /^\s*\{/.test(text)) return fromProtonJson(JSON.parse(text));
  // El respaldo de Tessera: un enlace otpauth:// por renglón (los # son comentarios).
  if (lower.endsWith('.txt') || /^\s*(#.*\n\s*)*otpauth(-migration)?:\/\//i.test(text)) {
    const r = T.parseList(text);
    if (!r.accounts.length) throw new Error('El archivo no tiene ningún enlace otpauth:// (los códigos de doble factor que exporta Tessera).');
    return { items: codeItems(r.accounts), skipped: r.skipped.length };
  }
  return fromCsv(text);
}

module.exports = {
  createVault, hostOf, siteOf, prettyHost, loginOf, publicItem, normalize,
  isCard, brandOf, brandName, parseExpiry, shortExpiry, normalizeCard,
  isCode, isLogin, kindOf, normalizeCode, codeItems,
  parseCsv, fromCsv, fromProtonJson, unzip, parseExport, timeOf,
};
