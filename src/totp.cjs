'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — códigos de doble factor (TOTP, RFC 6238), sin Electron
   El motor de Tessera traído a la bóveda: el código se calcula en el proceso
   principal, así la clave no viaja nunca al cromo (igual que una contraseña).
   Con el crypto de Node es sincrónico y se prueba con node pelado.

   ── Lo que entra ───────────────────────────────────────────────────────────
     otpauth://totp/Emisor:cuenta?secret=BASE32&issuer=Emisor&digits=6&period=30
   y el QR de "Transferir cuentas" de Google Authenticator,
     otpauth-migration://offline?data=<protobuf en base64>
   que trae varias cuentas juntas. Solo TOTP (por tiempo): HOTP por contador
   casi no existe y el error lo dice con todas las letras.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HASH = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
const ALGORITHMS = Object.keys(HASH);

/** El secreto como lo entiende base32: mayúsculas, sin espacios, guiones ni `=`. */
const normalizeSecret = (s) => String(s || '').toUpperCase().replace(/[\s\-=]/g, '');
const isValidSecret = (s) => /^[A-Z2-7]+$/.test(normalizeSecret(s));

function base32Decode(s) {
  const n = normalizeSecret(s);
  if (!isValidSecret(n)) throw new Error('La clave no es base32 válida (letras A–Z y dígitos 2–7).');
  const out = Buffer.alloc(Math.floor((n.length * 5) / 8));
  let bits = 0; let acc = 0; let i = 0;
  for (const ch of n) {
    acc = ((acc << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

function base32Encode(bytes) {
  let bits = 0; let acc = 0; let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** HOTP (RFC 4226): el código para un contador, ya con ceros a la izquierda. */
function hotp(secret, counter, { digits = 6, algorithm = 'SHA1' } = {}) {
  const hash = HASH[algorithm];
  if (!hash) throw new Error(`Algoritmo no soportado: ${algorithm}.`);
  const key = base32Decode(secret);
  if (!key.length) throw new Error('La clave está vacía.');
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac(hash, key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const counterAt = (now, period = 30) => Math.floor(now / 1000 / period);
const msLeft = (now, period = 30) => period * 1000 - (now % (period * 1000));

/** El código vigente en `now`, con su contador y cuánto le queda. */
function totp(secret, { digits = 6, period = 30, algorithm = 'SHA1', now = Date.now() } = {}) {
  const counter = counterAt(now, period);
  return { code: hotp(secret, counter, { digits, algorithm }), counter, msLeft: msLeft(now, period), period };
}

/* ── otpauth:// ──────────────────────────────────────────────────────────── */

const isOtpauth = (s) => /^otpauth:\/\//i.test(String(s || '').trim());
const isMigration = (s) => /^otpauth-migration:\/\//i.test(String(s || '').trim());

/** Una URI → { issuer, account, secret, algorithm, digits, period }. Tira con un mensaje legible. */
function parseOtpauth(input) {
  const uri = String(input || '').trim();
  if (!isOtpauth(uri)) throw new Error('No es un enlace otpauth://.');
  let url;
  try { url = new URL(uri); } catch { throw new Error('El enlace otpauth:// está malformado.'); }

  const type = url.hostname.toLowerCase();
  if (type !== 'totp') throw new Error(type === 'hotp' ? 'Es un código HOTP (por contador): Prism solo maneja códigos por tiempo (TOTP).' : `Tipo de código desconocido: ${type}.`);

  let label = url.pathname.replace(/^\/+/, '');
  try { label = decodeURIComponent(label); } catch { /* queda como vino */ }

  const q = url.searchParams;
  const secret = normalizeSecret(q.get('secret'));
  if (!isValidSecret(secret)) throw new Error('El enlace no trae una clave base32 válida.');

  // El emisor puede venir en el parámetro, en la etiqueta ("Emisor:cuenta"), o en los dos.
  let issuer = (q.get('issuer') || '').trim();
  let account = label.trim();
  const colon = label.indexOf(':');
  if (colon >= 0) {
    if (!issuer) issuer = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
  }

  const algorithm = (q.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`Algoritmo no soportado: ${algorithm}.`);
  const digits = q.has('digits') ? Number(q.get('digits')) : 6;
  if (![6, 7, 8].includes(digits)) throw new Error(`Cantidad de dígitos no soportada: ${q.get('digits')}.`);
  const period = q.has('period') ? Number(q.get('period')) : 30;
  if (!Number.isInteger(period) || period < 5 || period > 300) throw new Error(`Período no válido: ${q.get('period')}.`);

  return { issuer, account, secret, algorithm, digits, period };
}

/** El inverso: para el respaldo de texto (el de Tessera) y para llevarse una cuenta. */
function buildOtpauth({ issuer = '', account = '', secret, algorithm = 'SHA1', digits = 6, period = 30 }) {
  const label = issuer ? `${issuer}:${account}` : account;
  const p = new URLSearchParams();
  p.set('secret', normalizeSecret(secret));
  if (issuer) p.set('issuer', issuer);
  if (algorithm !== 'SHA1') p.set('algorithm', algorithm);
  if (digits !== 6) p.set('digits', String(digits));
  if (period !== 30) p.set('period', String(period));
  return `otpauth://totp/${encodeURIComponent(label)}?${p.toString()}`;
}

/* ── Google Authenticator: otpauth-migration:// ─────────────────────────────
   Un protobuf chico (google_auth.proto), decodificado a mano como en Tessera:

     MigrationPayload { repeated OtpParameters otp_parameters = 1;
                        int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; }
     OtpParameters    { bytes secret = 1; string name = 2; string issuer = 3;
                        Algorithm algorithm = 4;   // 1 SHA1 · 2 SHA256 · 3 SHA512 · 4 MD5
                        DigitCount digits = 5;     // 1 seis · 2 ocho
                        OtpType type = 6; }        // 1 HOTP · 2 TOTP                       */

function readVarint(buf, pos) {
  let value = 0; let shift = 0; let b;
  do {
    if (pos >= buf.length) throw new Error('protobuf truncado');
    b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [value, pos];
}

function readMessage(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v; [v, pos] = readVarint(buf, pos);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('protobuf truncado');
      out.push({ field, wire, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error(`protobuf: tipo de campo desconocido (${wire})`);
  }
  return out;
}

const GA_ALGORITHM = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
const GA_DIGITS = { 0: 6, 1: 6, 2: 8 };

/** Un QR de migración → { accounts, skipped, batch: { index, size } }. */
function parseMigration(input) {
  const uri = String(input || '').trim();
  if (!isMigration(uri)) throw new Error('No es un QR de migración de Google Authenticator.');
  let url;
  try { url = new URL(uri); } catch { throw new Error('El enlace otpauth-migration:// está malformado.'); }
  const data = url.searchParams.get('data');
  if (!data) throw new Error('El QR de migración no trae datos.');

  let fields;
  try {
    fields = readMessage(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''), 'base64'));
  } catch (err) {
    throw new Error(`No se pudo leer el QR de migración: ${err.message}.`);
  }

  const accounts = []; const skipped = [];
  const batch = { index: 0, size: 1 };
  for (const f of fields) {
    if (f.field === 3 && f.wire === 0) batch.size = f.value || 1;
    if (f.field === 4 && f.wire === 0) batch.index = f.value;
    if (f.field !== 1 || f.wire !== 2) continue;
    const p = {};
    for (const q of readMessage(f.value)) {
      if (q.field === 1 && q.wire === 2) p.secret = q.value;
      else if (q.field === 2 && q.wire === 2) p.name = q.value.toString('utf8');
      else if (q.field === 3 && q.wire === 2) p.issuer = q.value.toString('utf8');
      else if (q.field === 4) p.algorithm = q.value;
      else if (q.field === 5) p.digits = q.value;
      else if (q.field === 6) p.type = q.value;
    }
    const label = [p.issuer, p.name].filter(Boolean).join(' · ') || 'Sin nombre';
    if (p.type === 1) { skipped.push(`${label}: es por contador (HOTP)`); continue; }
    if (!(p.algorithm in GA_ALGORITHM) && p.algorithm != null) { skipped.push(`${label}: algoritmo no soportado (MD5)`); continue; }
    if (!p.secret?.length) { skipped.push(`${label}: viene sin clave`); continue; }

    let issuer = (p.issuer || '').trim();
    let account = (p.name || '').trim();
    const colon = account.indexOf(':');
    if (colon >= 0) {
      if (!issuer) issuer = account.slice(0, colon).trim();
      account = account.slice(colon + 1).trim();
    }
    accounts.push({
      issuer, account,
      secret: base32Encode(p.secret),
      algorithm: GA_ALGORITHM[p.algorithm ?? 1],
      digits: GA_DIGITS[p.digits] ?? 6,
      period: 30,
    });
  }
  return { accounts, skipped, batch };
}

/** Lo que dice un QR o un texto pegado: una cuenta o un lote de migración. */
function parseAny(text) {
  const s = String(text || '').trim();
  if (isMigration(s)) return parseMigration(s);
  return { accounts: [parseOtpauth(s)], skipped: [], batch: { index: 0, size: 1 } };
}

/** Un archivo de texto con una URI por renglón (el respaldo de Tessera). */
function parseList(text) {
  const accounts = []; const skipped = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!isOtpauth(line) && !isMigration(line)) continue;
    try {
      const r = parseAny(line);
      accounts.push(...r.accounts);
      skipped.push(...r.skipped);
    } catch (err) {
      skipped.push(err.message);
    }
  }
  return { accounts, skipped };
}

module.exports = {
  ALGORITHMS, normalizeSecret, isValidSecret, base32Decode, base32Encode,
  hotp, totp, counterAt, msLeft,
  isOtpauth, isMigration, parseOtpauth, buildOtpauth, parseMigration, parseAny, parseList,
};
