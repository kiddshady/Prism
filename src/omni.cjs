'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — omnibox
   Qué quiso decir el que tipeó. Es lógica pura (ni Electron ni disco) para
   poder probarla entera desde node: `npm test` la recorre caso por caso.

   La decisión central es URL o búsqueda, y equivocarse duele distinto de cada
   lado: tratar "hola.txt" como dirección lleva a una página de error, y tratar
   "localhost:3000" como búsqueda manda a Google a alguien que quería su dev
   server. Por eso las reglas van de lo inequívoco a lo dudoso, y ante la duda
   gana la búsqueda (que siempre llega a algún lado).
   ═══════════════════════════════════════════════════════════════════════════ */

/** Los buscadores. `%s` es la consulta ya codificada. */
const ENGINES = {
  google: {
    label: 'Google',
    search: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    search: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?type=list&q=%s',
  },
  bing: {
    label: 'Bing',
    search: 'https://www.bing.com/search?q=%s',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s',
  },
  brave: {
    label: 'Brave',
    search: 'https://search.brave.com/search?q=%s',
    suggest: 'https://search.brave.com/api/suggest?q=%s',
  },
};

const engine = (id) => ENGINES[id] || ENGINES.google;

/* Las páginas propias del navegador. Viven en el DOM de la ventana, no en una
   vista de Chromium: por eso pueden ser vidrio de verdad sobre la niebla. */
const INTERNAL = {
  nueva: 'Nueva pestaña',
  historial: 'Historial',
  favoritos: 'Favoritos',
  descargas: 'Descargas',
  ajustes: 'Ajustes',
};

/** 'prism://historial' → 'historial'. Cualquier otra cosa → null. */
function internalPage(url) {
  const m = /^prism:\/\/([a-z]+)\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  return INTERNAL[name] ? name : null;
}

const internalUrl = (name) => `prism://${name}`;

/* Los esquemas que se abren tal cual. `javascript:` NO está: tipearlo en la
   barra no puede ejecutar código en la página abierta (es un vector clásico
   de ingeniería social: "pegá esto en la barra de direcciones"). */
const SCHEMES = new Set(['http', 'https', 'file', 'about', 'view-source', 'data', 'prism', 'blob']);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_PORT_PATH = /^([^\s/?#:]+)(:\d{1,5})?([/?#].*)?$/;

function isIPv4(host) {
  const m = IPV4.exec(host);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

/* Un dominio "de verdad": etiquetas separadas por punto y un TLD de letras.
   "hola.txt" pasa esta forma — por eso además hay una lista corta de
   extensiones de archivo que casi nunca son TLD en lo que tipea una persona. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i;
const FILE_EXT = new Set(['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'exe', 'js', 'json', 'md', 'py', 'zip', 'mp3', 'mp4', 'csv', 'html', 'htm', 'css']);

/**
 * Clasifica lo tipeado.
 * → { type: 'url', url } | { type: 'search', url, query } | null (vacío)
 */
function classify(input, engineId = 'google') {
  const text = String(input ?? '').trim();
  if (!text) return null;

  const search = () => ({
    type: 'search',
    query: text,
    url: engine(engineId).search.replace('%s', encodeURIComponent(text)),
  });

  // Con espacios nunca es una dirección (salvo una ruta de Windows, abajo).
  const winPath = /^[a-z]:[\\/]/i.test(text);
  if (/\s/.test(text) && !winPath) return search();

  // Ruta de Windows: C:\algo → file:///C:/algo
  if (winPath) return { type: 'url', url: `file:///${text.replace(/\\/g, '/')}` };

  // Esquema explícito. `localhost:3000` también tiene forma de esquema — por
  // eso se exige que el esquema sea uno conocido.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme && SCHEMES.has(scheme[1].toLowerCase())) {
    const s = scheme[1].toLowerCase();
    if (s === 'prism') return internalPage(text) ? { type: 'url', url: internalUrl(internalPage(text)) } : search();
    if ((s === 'http' || s === 'https') && !/^https?:\/\/[^/]/i.test(text)) return search();
    return { type: 'url', url: text };
  }

  const m = HOST_PORT_PATH.exec(text);
  if (!m) return search();
  const [, host, port = '', rest = ''] = m;
  const lower = host.toLowerCase();

  // Lo local va por http: un dev server casi nunca tiene certificado.
  if (lower === 'localhost' || lower.endsWith('.localhost') || isIPv4(lower)) {
    return { type: 'url', url: `http://${lower}${port}${rest}` };
  }

  if (DOMAIN.test(lower)) {
    const tld = lower.split('.').pop();
    // "notas.txt" solo, sin ruta ni puerto, es más probable un nombre de
    // archivo que un sitio. Con ruta ("algo.md/x") ya no hay duda.
    if (FILE_EXT.has(tld) && !port && !rest) return search();
    return { type: 'url', url: `https://${lower}${port}${rest}` };
  }

  return search();
}

/* ── Mostrar una URL ─────────────────────────────────────────────────────────
   La barra muestra la dirección partida: el host se lee, el resto se atenúa.
   Es lo que permite ver de un vistazo en qué sitio estás de verdad —
   "paypal.com.estafa.ru" se delata solo cuando el host resalta entero. */
function splitForDisplay(url) {
  const page = internalPage(url);
  if (page) return { scheme: 'prism://', host: page, rest: '', secure: 'internal' };
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return {
        scheme: u.protocol === 'http:' ? 'http://' : '',
        host: u.host,
        rest: safeDecode(rest),
        secure: u.protocol === 'https:' ? 'https' : 'http',
      };
    }
    if (u.protocol === 'file:') return { scheme: '', host: '', rest: safeDecode(u.pathname.replace(/^\//, '')), secure: 'file' };
  } catch { /* no es una URL parseable: se muestra tal cual */ }
  return { scheme: '', host: '', rest: String(url || ''), secure: 'other' };
}

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

/** El host "de persona": sin www. Es lo que se compara al autocompletar. */
function bareHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** El origen para recordar permisos: esquema + host + puerto. */
function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/* ── Sugerencias remotas ─────────────────────────────────────────────────────
   Los cuatro buscadores devuelven el formato OpenSearch: [consulta, [a, b…]].
   Se valida la forma porque la respuesta viene de la red: cualquier cosa que
   no sea una lista de strings se descarta entera. */
function parseRemoteSuggest(json) {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
  return json[1].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 6);
}

module.exports = {
  ENGINES, engine, INTERNAL, internalPage, internalUrl,
  classify, splitForDisplay, bareHost, originOf, parseRemoteSuggest,
};
