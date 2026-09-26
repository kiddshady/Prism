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
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const zlib = require('zlib');

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

/** Con qué se entra: el usuario si hay, si no el correo. */
const loginOf = (it) => it.username || it.email || '';

/** Un elemento para mostrar: todo menos la contraseña. */
function publicItem(it) {
  const { password, ...rest } = it;
  return { ...rest, hasPassword: !!password, host: prettyHost(hostOf(it.urls[0])) };
}

/* ── La bóveda ───────────────────────────────────────────────────────────── */

function createVault({ doc, seal, unseal, now = () => Date.now() }) {
  let items = [];
  /* Si el archivo existe pero no se pudo descifrar (otra cuenta de Windows,
     un archivo roto), NO se escribe nunca: guardar encima de una bóveda que
     no se pudo leer la borraría. */
  let broken = null;
  let chain = Promise.resolve();

  async function load() {
    const data = await doc.read();
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
    return chain;
  }

  const get = (id) => items.find((it) => it.id === id) || null;
  const newId = () => `p-${crypto.randomBytes(6).toString('hex')}`;

  /** Crea (sin id) o edita (con id). Devuelve el elemento público. */
  async function save(raw = {}) {
    const prev = raw.id ? get(String(raw.id)) : null;
    if (raw.id && !prev) throw new Error('Ese elemento ya no existe.');
    const t = now();
    const it = { ...normalize({ ...prev, ...raw }, t), id: prev?.id || newId() };
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

  async function remove(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    await persist();
    return true;
  }

  /** Los elementos de un sitio, primero los del host exacto y los usados hace poco. */
  function findFor(url) {
    const host = hostOf(url);
    if (!host) return [];
    const site = siteOf(host);
    const scored = [];
    for (const it of items) {
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

  async function markUsed(id) {
    const it = get(id);
    if (!it) return;
    it.lastUsedAt = now();
    await persist().catch(() => {});
  }

  /** Suma lo importado, salteando lo que ya está igual (mismo sitio, login y contraseña). */
  async function importItems(list) {
    const key = (it) => `${siteOf(hostOf(it.urls[0]))}|${loginOf(it).toLowerCase()}|${it.password}`;
    const seen = new Set(items.map(key));
    let added = 0; let repeated = 0;
    for (const raw of list) {
      const it = { ...normalize(raw, now()), id: newId() };
      const k = key(it);
      if (seen.has(k)) { repeated++; continue; }
      seen.add(k);
      items.push(it);
      added++;
    }
    if (added) await persist();
    return { added, repeated };
  }

  return {
    load,
    get broken() { return broken; },
    get size() { return items.length; },
    list: () => items.map(publicItem).sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' })),
    get,
    save,
    remove,
    findFor,
    markUsed,
    importItems,
  };
}

/* ── Importar ────────────────────────────────────────────────────────────── */

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
    out.push({
      title: at(r, 'title'), username: at(r, 'username'), email: at(r, 'email'), password: at(r, 'password'),
      urls: at(r, 'url'), note: at(r, 'note'),
      createdAt: timeOf(at(r, 'createdAt')), modifiedAt: timeOf(at(r, 'modifiedAt')), lastUsedAt: timeOf(at(r, 'lastUsedAt')),
    });
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
      // state 2 es la papelera de Proton Pass.
      if (d.type !== 'login' || item.state === 2) { skipped++; continue; }
      const c = d.content || {};
      out.push({
        title: d.metadata?.name,
        username: c.itemUsername ?? (c.itemEmail == null ? c.username : ''),
        email: c.itemEmail ?? '',
        password: c.password,
        urls: c.urls || [],
        note: d.metadata?.note,
        createdAt: timeOf(item.createTime),
        modifiedAt: timeOf(item.modifyTime),
        lastUsedAt: timeOf(item.lastUseTime),
      });
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

/** Lee lo que la persona eligió: .csv, .json o el .zip de Proton Pass. */
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
  const text = buf.toString('utf8');
  if (lower.endsWith('.json') || /^\s*\{/.test(text)) return fromProtonJson(JSON.parse(text));
  return fromCsv(text);
}

module.exports = {
  createVault, hostOf, siteOf, prettyHost, loginOf, publicItem, normalize,
  parseCsv, fromCsv, fromProtonJson, unzip, parseExport, timeOf,
};
