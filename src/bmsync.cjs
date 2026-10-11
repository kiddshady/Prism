'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — favoritos entre equipos: la mezcla
   Dos Prism emparejados (link.cjs) se mandan su lista entera de favoritos y
   cada uno la mezcla con la suya. La mezcla es una función pura y simétrica:
   mezclar A con B da lo mismo que B con A, y mezclar algo consigo mismo no lo
   cambia. Por eso los dos lados llegan a la misma lista sin ponerse de acuerdo
   en nada, y alcanza con mandar la propia después de cada cambio.

   La llave es la DIRECCIÓN, no el id: los ids nacen en cada máquina, y el
   mismo sitio guardado en las dos es un solo favorito.

   · Cada favorito lleva `at`, cuándo se tocó por última vez. Si los dos lados
     lo tienen distinto, gana el más nuevo.
   · Quitar uno deja una lápida (`gone`: dirección → cuándo). Sin ella, el
     otro lado lo volvería a mandar y el favorito resucitaría. Una lápida le
     gana a un favorito más viejo y pierde contra uno guardado después.
   · El orden es de la lista entera: gana el del lado que reordenó último
     (`orderAt`). Lo que ese lado no conocía va arriba, el más nuevo primero,
     que es donde cae un favorito recién guardado.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Cuánto se recuerda que un favorito se quitó. */
const KEEP_GONE = 180 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 5000;

const okUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^(https?|file):\/\//i.test(u);
/* Solo íconos que son una dirección corta: un data: de un favicon puede pesar
   decenas de KB por favorito, y el otro lado lo saca solo cuando lo visite. */
const okIcon = (f) => (typeof f === 'string' && f.length <= 1024 && /^https?:\/\//i.test(f) ? f : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Lo que llega se valida y se normaliza: viene de otra máquina. */
function clean(state, now = Date.now()) {
  const items = [];
  const seen = new Set();
  for (const x of Array.isArray(state?.items) ? state.items : []) {
    if (items.length >= MAX_ITEMS) break;
    if (!x || !okUrl(x.url) || seen.has(x.url)) continue;
    seen.add(x.url);
    const createdAt = Math.max(0, Number(x.createdAt) || 0);
    items.push({
      url: x.url,
      title: String(x.title || '').slice(0, 300),
      favicon: okIcon(x.favicon),
      createdAt,
      at: Math.max(0, Number(x.at) || createdAt),
    });
  }
  const gone = {};
  const g = state?.gone && typeof state.gone === 'object' ? state.gone : {};
  for (const url of Object.keys(g).sort().slice(0, MAX_ITEMS)) {
    const t = Number(g[url]);
    if (okUrl(url) && t > 0 && now - t < KEEP_GONE) gone[url] = t;
  }
  return { items, gone, orderAt: Math.max(0, Number(state?.orderAt) || 0) };
}

/** Entre dos versiones vivas del mismo favorito: la tocada después. Si las dos
    son del mismo instante, decide el contenido, igual de los dos lados. */
function newer(x, y) {
  if (x.at !== y.at) return x.at > y.at ? x : y;
  return (cmp(x.title, y.title) || cmp(x.favicon || '', y.favicon || '')) >= 0 ? x : y;
}

const urlsOf = (s) => s.items.map((x) => x.url);

function merge(a, b, now = Date.now()) {
  const A = clean(a, now);
  const B = clean(b, now);
  const inA = new Map(A.items.map((x) => [x.url, x]));
  const inB = new Map(B.items.map((x) => [x.url, x]));
  const all = new Set([...inA.keys(), ...inB.keys(), ...Object.keys(A.gone), ...Object.keys(B.gone)]);

  const alive = new Map();
  const gone = {};
  for (const url of [...all].sort()) {
    const x = inA.get(url);
    const y = inB.get(url);
    let w = x && y ? newer(x, y) : x || y;
    // Guardado hace tiempo en una y hace poco en la otra: la fecha es la primera.
    if (x && y) {
      const born = [x.createdAt, y.createdAt].filter((n) => n > 0);
      w = { ...w, createdAt: born.length ? Math.min(...born) : 0 };
    }
    const dead = Math.max(A.gone[url] || 0, B.gone[url] || 0);
    if (w && w.at > dead) alive.set(url, w);
    else if (dead) gone[url] = dead;
  }

  // El orden del que reordenó último; empatados, el de la lista más larga.
  const aWins = A.orderAt !== B.orderAt ? A.orderAt > B.orderAt
    : A.items.length !== B.items.length ? A.items.length > B.items.length
      : cmp(urlsOf(A).join('\n'), urlsOf(B).join('\n')) >= 0;
  const base = urlsOf(aWins ? A : B).filter((u) => alive.has(u));
  const known = new Set(base);
  const fresh = [...alive.keys()].filter((u) => !known.has(u))
    .sort((u, v) => (alive.get(v).createdAt - alive.get(u).createdAt) || cmp(u, v));

  return {
    items: [...fresh, ...base].map((u) => alive.get(u)),
    gone,
    orderAt: Math.max(A.orderAt, B.orderAt),
  };
}

/** Una huella de la lista: dos estados con la misma huella son la misma lista. */
const digest = (state, now = Date.now()) => JSON.stringify(clean(state, now));

module.exports = { merge, clean, digest, KEEP_GONE };
