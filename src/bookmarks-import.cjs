'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — importar favoritos
   De dos lados:
   · Los navegadores Chromium instalados (Chrome, Edge, Brave): cada perfil
     guarda sus favoritos en `User Data/<perfil>/Bookmarks`, un JSON que se
     puede leer con el navegador abierto. El nombre del perfil sale de
     `User Data/Local State`.
   · Un archivo HTML exportado (el formato de Netscape que exportan todos,
     Firefox incluido).

   Los favoritos de Prism son una lista sin carpetas: lo importado se aplana
   en el orden en que se ve en el otro navegador (la barra primero), y lo que
   no es una dirección que se pueda visitar (bookmarklets, chrome://) se
   saltea. Los parsers son puros, con tests.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fsp = require('fs/promises');

const visitable = (url) => /^(https?|file):\/\//i.test(String(url || ''));

/** Chrome cuenta el tiempo en microsegundos desde 1601. */
const EPOCH_1601 = 11644473600000;
function chromeTime(v) {
  const us = Number(v);
  if (!Number.isFinite(us) || us <= 0) return null;
  const ms = Math.round(us / 1000 - EPOCH_1601);
  return ms > 0 ? ms : null;
}

/** El JSON de `Bookmarks` → [{ url, title, createdAt }], en orden y sin carpetas. */
function flattenChrome(json) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') {
      if (visitable(node.url)) out.push({ url: node.url, title: String(node.name || '').trim(), createdAt: chromeTime(node.date_added) });
      return;
    }
    for (const c of Array.isArray(node.children) ? node.children : []) walk(c);
  };
  const roots = json?.roots || {};
  for (const k of ['bookmark_bar', 'other', 'synced']) walk(roots[k]);
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** Un HTML de favoritos exportado → [{ url, title, createdAt }]. */
function parseNetscape(html) {
  const out = [];
  const re = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const attrs = m[1];
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    const url = href ? decode(href).trim() : '';
    if (!visitable(url)) continue;
    const added = Number(/add_date\s*=\s*"(\d+)"/i.exec(attrs)?.[1]);
    const title = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    out.push({ url, title, createdAt: added > 0 ? added * 1000 : null });
  }
  return out;
}

/* ── Dónde buscar ──────────────────────────────────────────────────────────── */

const BROWSERS = [
  { id: 'chrome', label: 'Chrome', dir: ['Google', 'Chrome', 'User Data'] },
  { id: 'edge', label: 'Edge', dir: ['Microsoft', 'Edge', 'User Data'] },
  { id: 'brave', label: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
];

const readJSON = async (file) => JSON.parse(await fsp.readFile(file, 'utf8'));

/**
 * Los perfiles con favoritos de los navegadores instalados:
 * [{ id: 'chrome/Default', browser: 'Chrome', profile: 'Fran', count }].
 * `localAppData` se inyecta para poder probarlo.
 */
async function findSources(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return [];
  const found = [];
  for (const b of BROWSERS) {
    const root = path.join(localAppData, ...b.dir);
    const names = (await readJSON(path.join(root, 'Local State')).catch(() => null))?.profile?.info_cache || {};
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const json = await readJSON(path.join(root, e.name, 'Bookmarks')).catch(() => null);
      if (!json) continue;
      const count = flattenChrome(json).length;
      if (!count) continue;
      found.push({ id: `${b.id}/${e.name}`, browser: b.label, profile: names[e.name]?.name || e.name, count });
    }
  }
  return found;
}

/** Los favoritos de una fuente de findSources, por su id. */
async function readSource(id, localAppData = process.env.LOCALAPPDATA) {
  const [bid, profile] = String(id).split('/');
  const b = BROWSERS.find((x) => x.id === bid);
  // El perfil es el nombre de una carpeta: nada de subir o saltar de directorio.
  if (!b || !profile || /[\\/]|^\.\.?$/.test(profile) || !localAppData) throw new Error('Esa fuente no existe.');
  const json = await readJSON(path.join(localAppData, ...b.dir, profile, 'Bookmarks'));
  return flattenChrome(json);
}

module.exports = { flattenChrome, parseNetscape, chromeTime, findSources, readSource, BROWSERS };
