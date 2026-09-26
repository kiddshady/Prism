/* ═══════════════════════════════════════════════════════════════════════════
   Historial y favoritos: lo que la omnibox sugiere y lo que queda guardado.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createLibrary, recordable } = require('../src/library.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

/* Un disco en memoria: lo que se escribe se puede volver a leer. */
function memDoc() {
  let data = null;
  return { read: async () => structuredClone(data), write: async (d) => { data = structuredClone(d); }, get data() { return data; } };
}

let clock = Date.UTC(2026, 8, 24, 12);
const DAY = 86_400_000;
const hist = memDoc();
const books = memDoc();
const lib = createLibrary({ historyDoc: hist, bookmarksDoc: books, now: () => clock });
await lib.load();

console.log('\n1. Qué se registra');
ok('http y https sí', recordable('https://a.com') && recordable('http://a.com'));
ok('las páginas propias no', !recordable('prism://nueva'));
ok('about:blank no', !recordable('about:blank'));
ok('data: no', !recordable('data:text/html,hola'));

console.log('\n2. Visitas');
lib.visit('https://www.youtube.com/watch?v=1', 'Video uno');
clock += 5000;
lib.visit('https://www.youtube.com/watch?v=1', 'Video uno');
ok('un reload no duplica la visita', lib.listVisits().length === 1, String(lib.listVisits().length));
clock += 2 * 60_000;
lib.visit('https://www.youtube.com/watch?v=1');
ok('pasado un minuto, sí es otra visita', lib.listVisits().length === 2);
lib.visit('https://github.com/kiddshady/Prism', '');
lib.setTitle('https://github.com/kiddshady/Prism', 'kiddshady/Prism');
ok('el título llega después y se asienta', lib.listVisits()[0].title === 'kiddshady/Prism', lib.listVisits()[0].title);
const antes = lib.listVisits().length;
lib.visit('https://www.youtube.com/', 'YouTube');
lib.visit('https://github.com/otra', 'Otra');
clock += 3000;
lib.visit('https://www.youtube.com/', 'YouTube');
ok('visitas intercaladas de otra pestaña no duplican', lib.listVisits().length === antes + 2, String(lib.listVisits().length - antes));
ok('y la repetida sube al primer lugar', lib.listVisits()[0].url === 'https://www.youtube.com/');
lib.visit('prism://historial', 'Historial');
ok('las internas no entran', lib.listVisits().every((v) => !v.url.startsWith('prism:')));

console.log('\n3. Sugerencias');
clock -= 40 * DAY;
lib.visit('https://www.reddit.com/r/argentina', 'r/argentina');
clock += 40 * DAY;
for (let i = 0; i < 3; i++) { clock += 61_000; lib.visit('https://redline.local.test/', 'Redline'); }
lib.visit('https://es.wikipedia.org/wiki/Ibuprofeno', 'Ibuprofeno - Wikipedia');

let r = lib.suggest('you');
ok('el host que empieza así va primero', r.items[0]?.url.includes('youtube.com'), JSON.stringify(r.items[0]));
ok('autocompleta el host en línea', r.inline === 'youtube.com', String(r.inline));
r = lib.suggest('red');
ok('reciente y frecuente le gana a viejo', r.inline === 'redline.local.test', String(r.inline));
r = lib.suggest('ibupro');
ok('matchea por palabra del título', r.items.some((i) => i.url.includes('Ibuprofeno')));
ok('pero no autocompleta sobre el título', r.inline === null, String(r.inline));
ok('vacío no sugiere nada', lib.suggest('  ').items.length === 0);
ok('con espacios no autocompleta', lib.suggest('you tube').inline === null);

console.log('\n4. Favoritos');
const added = lib.toggleBookmark({ url: 'https://umaza.edu.ar/', title: 'UMaza' });
ok('toggle agrega', added === true && lib.isBookmarked('https://umaza.edu.ar/'));
r = lib.suggest('umaza');
ok('un favorito se sugiere aunque no esté en el historial', r.items[0]?.kind === 'bookmark', JSON.stringify(r.items));
lib.toggleBookmark({ url: 'https://www.youtube.com/', title: 'YouTube' });
const sinHist = { history: false };
r = lib.suggest('you', 6, sinHist);
ok('sin historial: el favorito sigue apareciendo', r.items.length === 1 && r.items[0].kind === 'bookmark', JSON.stringify(r.items));
ok('sin historial: no aparece el video visitado', !r.items.some((i) => i.url.includes('watch')));
ok('sin historial: completa con el host del favorito', r.inline === 'youtube.com', String(r.inline));
r = lib.suggest('red', 6, sinHist);
ok('sin historial: lo visitado no se sugiere', r.items.length === 0, JSON.stringify(r.items));
ok('sin historial: ni se autocompleta', r.inline === null, String(r.inline));
ok('con historial vuelve a aparecer', lib.suggest('red').inline === 'redline.local.test');
lib.toggleBookmark({ url: 'https://www.youtube.com/' });
ok('toggle de nuevo lo saca', lib.toggleBookmark({ url: 'https://umaza.edu.ar/' }) === false && !lib.isBookmarked('https://umaza.edu.ar/'));
const b1 = lib.addBookmark({ url: 'https://a.com/', title: 'A' });
const b2 = lib.addBookmark({ url: 'https://b.com/', title: 'B' });
ok('los nuevos van primero', lib.listBookmarks()[0].id === b2.id);
lib.moveBookmark(b2.id, 1);
ok('se pueden reordenar', lib.listBookmarks()[0].id === b1.id);
lib.updateBookmark(b1.id, { title: '  Ahora  ' });
ok('se pueden renombrar', lib.listBookmarks()[0].title === 'Ahora');

console.log('\n5. Sitios frecuentes');
const top = lib.topSites(3);
ok('agrupa por host', new Set(top.map((t) => new URL(t.url).hostname)).size === top.length);
ok('el más usado va primero', top[0].url.includes('redline') || top[0].url.includes('youtube'), JSON.stringify(top.map((t) => t.url)));

console.log('\n6. Borrar');
const ids = lib.listVisits({ query: 'wikipedia' }).map((v) => v.id);
ok('buscar filtra', ids.length === 1);
lib.removeVisits(ids);
ok('borrar una visita la saca de las sugerencias', !lib.suggest('ibupro').items.length);
const n = lib.clearHistory(clock - 10 * DAY);
ok('borrar un rango deja lo viejo', n > 0 && lib.listVisits().some((v) => v.url.includes('reddit')), String(n));

console.log('\n7. Disco');
await lib.flushAll();
ok('se escribió el historial', Array.isArray(hist.data?.visits) && hist.data.visits.length > 0);
ok('se escribieron los favoritos', books.data?.bookmarks?.length === 2);
const lib2 = createLibrary({ historyDoc: hist, bookmarksDoc: books, now: () => clock });
await lib2.load();
ok('vuelve a cargar igual', lib2.listVisits().length === lib.listVisits().length && lib2.listBookmarks().length === 2);
ok('y el índice se reconstruye', lib2.suggest('red').inline === 'reddit.com', String(lib2.suggest('red').inline));

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
