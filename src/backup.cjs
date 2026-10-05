'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — el respaldo de la bóveda (la lógica, sin Electron)
   La bóveda vive en un solo archivo cifrado con DPAPI (src/passwords.cjs): la
   clave es la cuenta de Windows, así que una copia de vault.json no se abre
   en otra compu ni después de reinstalar Windows. Si se rompe el disco, se
   perdió todo. El respaldo es OTRO archivo, con su propia clave:

   ── La clave ───────────────────────────────────────────────────────────────
   Una frase que elige la persona. De ella sale la clave de cifrado con scrypt
   (lento a propósito: probar frases a mano cuesta) y una sal al azar. Para
   respaldar solo, sin preguntar cada vez, lo que se guarda en esta compu NO
   es la frase sino la clave ya derivada, y cifrada con DPAPI (lo hace quien
   llama: acá entra y sale como bytes). Para restaurar en otra compu hace
   falta la frase: la sal viaja adentro del archivo.

   ── El archivo ─────────────────────────────────────────────────────────────
   `Prism-boveda-AAAA-MM-DD.prismvault`: un JSON con la sal, y TODA la bóveda
   cifrada de una vez con AES-256-GCM. Nada a la vista: ni sitios ni cuántos
   son. Uno por día: los cambios del mismo día pisan el de hoy, y quedan los
   últimos KEEP días. Así, una bóveda que se vació por error no se lleva
   puestas las copias de ayer.

   Se escribe a un temporal y se renombra: un respaldo a medio escribir (se
   desenchufó el disco) no reemplaza al que estaba bien.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const path = require('path');

const EXT = '.prismvault';
const KEEP = 10;
const MIN_PASSPHRASE = 8;
/** scrypt: ~32 MB y ~100 ms por intento. */
const KDF = { N: 2 ** 15, r: 8, p: 1 };
const NAME = /^Prism-boveda-(\d{4}-\d{2}-\d{2})\.prismvault$/;

const pad = (n) => String(n).padStart(2, '0');
/** El archivo de un día (el día de acá, no el de UTC: «el de hoy» es el de la persona). */
function fileName(when = Date.now()) {
  const d = new Date(when);
  return `Prism-boveda-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${EXT}`;
}

/** De una lista de nombres, los respaldos viejos que sobran. Solo los nuestros: lo demás de la carpeta no se toca. */
function prune(names, keep = KEEP) {
  return names.filter((n) => NAME.test(n)).sort().reverse().slice(keep);
}

function deriveKey(passphrase, salt, kdf = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase).normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Lo que va atado al cifrado sin ir cifrado: cambiarlo a mano rompe el archivo. */
const aadOf = (h) => Buffer.from(`prism-boveda|${h.v}|${h.when}|${h.kdf.N}|${h.kdf.r}|${h.kdf.p}|${h.kdf.salt}`);

/** El texto del archivo: la bóveda entera cifrada con una clave ya derivada. */
function sealBackup(items, { key, salt, when = Date.now() }) {
  const head = { prism: 'boveda', v: 1, when, kdf: { name: 'scrypt', ...KDF, salt: Buffer.from(salt).toString('base64') } };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(head));
  const data = Buffer.concat([c.update(JSON.stringify({ items }), 'utf8'), c.final()]);
  return JSON.stringify({ ...head, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

/** Lo de arriba de un respaldo, sin abrirlo. Tira si no es uno. */
function readHead(text) {
  let h;
  try { h = JSON.parse(String(text)); } catch { h = null; }
  if (!h || h.prism !== 'boveda' || !h.kdf?.salt || !h.iv || !h.tag || !h.data) throw new Error('No es un respaldo de Prism.');
  if (h.v !== 1 || h.kdf.name !== 'scrypt') throw new Error('Este respaldo es de una versión más nueva de Prism.');
  // Un archivo armado a mano no puede pedir un scrypt de gigas.
  if (!(h.kdf.N >= 2 ** 14 && h.kdf.N <= 2 ** 18) || h.kdf.r !== 8 || h.kdf.p !== 1) throw new Error('No es un respaldo de Prism.');
  return h;
}

const isBackup = (name, buf) => String(name).toLowerCase().endsWith(EXT) || /^\s*\{\s*"prism"\s*:\s*"boveda"/.test(buf.subarray(0, 64).toString('utf8'));

/** Abre un respaldo con la frase, o con la clave ya derivada si es de esta misma configuración. */
async function openBackup(text, { passphrase, key } = {}) {
  const h = readHead(text);
  const salt = Buffer.from(h.kdf.salt, 'base64');
  const k = key || await deriveKey(passphrase, salt, h.kdf);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(h.iv, 'base64'));
    d.setAAD(aadOf(h));
    d.setAuthTag(Buffer.from(h.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(h.data, 'base64')), d.final()]).toString('utf8');
    const items = JSON.parse(plain).items;
    return { items: Array.isArray(items) ? items : [], when: h.when };
  } catch {
    throw new Error('Esa no es la clave de este respaldo.');
  }
}

/* ── El que respalda ─────────────────────────────────────────────────────────
   cfg (un doc de store.cjs): { v, dir, salt, key (cifrada por `seal`), lastAt }.
   `items()` devuelve la bóveda entera, con lo secreto. `fs` es fs/promises. */
function createBackup({ doc, items, seal, unseal, fs, now = () => Date.now(), onChange = () => {}, delay = 2000 }) {
  let cfg = null;
  let error = null;
  let timer = null;
  let chain = Promise.resolve();

  const state = () => ({ on: !!cfg, dir: cfg?.dir || '', lastAt: cfg?.lastAt || null, error });
  const keyOf = () => Buffer.from(unseal(Buffer.from(cfg.key, 'base64')), 'base64');
  /** La huella de lo que se respaldó: para saber, al arrancar, si quedó algo sin respaldar. */
  const sumOf = (list, key) => crypto.createHmac('sha256', key).update(JSON.stringify(list)).digest('base64');

  async function load() {
    const data = await doc.read().catch(() => null);
    cfg = data?.dir && data.salt && data.key ? data : null;
  }

  /** Escribe el de hoy en una carpeta con una clave, y saca los que sobran. */
  async function writeTo(dir, key, salt) {
    const when = now();
    const list = items();
    const text = sealBackup(list, { key, salt, when });
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, fileName(when));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const fh = await fs.open(tmp, 'w');
      try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    // Sacar los viejos es de yapa: si falla, el respaldo de hoy igual quedó.
    const names = await fs.readdir(dir).catch(() => []);
    for (const old of prune(names)) await fs.unlink(path.join(dir, old)).catch(() => {});
    return { when, file, sum: sumOf(list, key) };
  }

  const explain = (err) => ({
    ENOENT: 'no se encuentra la carpeta', EACCES: 'no hay permiso para escribir ahí', EPERM: 'no hay permiso para escribir ahí',
    ENOSPC: 'no queda espacio', EBUSY: 'el archivo está tomado por otro programa', EROFS: 'el disco es de solo lectura',
    EEXIST: 'esa ruta no es una carpeta', ENOTDIR: 'esa ruta no es una carpeta',
  }[err?.code] || err?.message || String(err));

  /** Respalda ahora. De a uno: dos a la vez pisarían el mismo temporal. */
  function run() {
    const job = chain.then(async () => {
      if (!cfg) return null;
      try {
        /* Una bóveda vacía no pisa el respaldo de hoy: si se vació por error
           (un archivo roto que se apartó), las copias que hay son lo que queda. */
        if (!items().length) return null;
        const { when, sum } = await writeTo(cfg.dir, keyOf(), Buffer.from(cfg.salt, 'base64'));
        cfg = { ...cfg, lastAt: when, sum };
        error = null;
        await doc.write(cfg);
        return when;
      } catch (err) {
        error = explain(err);
        throw new Error(`No se pudo escribir el respaldo: ${error}.`);
      } finally {
        onChange();
      }
    });
    chain = job.catch(() => {});
    return job;
  }

  /** La bóveda cambió: se respalda en un rato, juntando los cambios seguidos. */
  function schedule() {
    if (!cfg) return;
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((err) => console.error('[respaldo]', err.message)), delay);
  }

  /** Al arrancar: si la bóveda no es la del último respaldo (Prism se cerró
      antes de que saliera, o el disco no estaba), se respalda ahora. */
  async function catchUp() {
    if (!cfg) return;
    let same = false;
    try { const list = items(); same = !list.length || sumOf(list, keyOf()) === cfg.sum; } catch { return; }   // una bóveda que no abrió no se respalda
    if (!same) await run().catch((err) => console.error('[respaldo]', err.message));
  }

  /** Prende el respaldo (o le cambia la carpeta o la frase). Antes de guardar
      nada escribe el primero: si la carpeta no sirve, se sabe acá. */
  async function setup(dir, passphrase) {
    const d = String(dir || '').trim();
    const p = String(passphrase || '');
    if (!d) throw new Error('Elegí una carpeta para el respaldo.');
    if (p.length < MIN_PASSPHRASE) throw new Error(`La clave del respaldo tiene que tener al menos ${MIN_PASSPHRASE} caracteres.`);
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(p, salt);
    let when; let sum;
    try {
      ({ when, sum } = await writeTo(d, key, salt));
    } catch (err) {
      throw new Error(`No se pudo escribir en esa carpeta: ${explain(err)}.`);
    }
    cfg = { v: 1, dir: d, salt: salt.toString('base64'), key: seal(key.toString('base64')).toString('base64'), lastAt: when, sum };
    error = null;
    await doc.write(cfg);
    onChange();
    return state();
  }

  /** Cambia solo la carpeta: la clave sigue siendo la misma. */
  async function move(dir) {
    if (!cfg) throw new Error('El respaldo está apagado.');
    const d = String(dir || '').trim();
    if (!d) throw new Error('Elegí una carpeta para el respaldo.');
    let when; let sum;
    try {
      ({ when, sum } = await writeTo(d, keyOf(), Buffer.from(cfg.salt, 'base64')));
    } catch (err) {
      throw new Error(`No se pudo escribir en esa carpeta: ${explain(err)}.`);
    }
    cfg = { ...cfg, dir: d, lastAt: when, sum };
    error = null;
    await doc.write(cfg);
    onChange();
    return state();
  }

  /** Apaga el respaldo. Los archivos que ya están en la carpeta no se tocan. */
  async function off() {
    clearTimeout(timer);
    cfg = null;
    error = null;
    await doc.remove();
    onChange();
    return state();
  }

  /** Abre un respaldo. Sin frase prueba con la clave de acá (el respaldo de
      esta misma configuración); si no es, devuelve null: hace falta la frase. */
  async function open(text, passphrase) {
    if (passphrase != null) return openBackup(text, { passphrase });
    const h = readHead(text);
    if (!cfg || h.kdf.salt !== cfg.salt) return null;
    return openBackup(text, { key: keyOf() }).catch(() => null);
  }

  return { load, state, setup, move, off, run, schedule, catchUp, open, flush: () => chain };
}

module.exports = { createBackup, sealBackup, openBackup, readHead, isBackup, deriveKey, fileName, prune, EXT, KEEP, MIN_PASSPHRASE };
