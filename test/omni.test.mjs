/* ═══════════════════════════════════════════════════════════════════════════
   La omnibox: qué es dirección y qué es búsqueda.
   Cada caso es algo que una persona tipea de verdad. Equivocarse para un lado
   lleva a una página de error; para el otro, a Google cuando querías tu dev
   server. Los dos duelen.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const omni = require('../src/omni.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const url = (input) => omni.classify(input);
const isUrl = (input, expected) => {
  const r = url(input);
  ok(`"${input}" → ${expected}`, r?.type === 'url' && r.url === expected, JSON.stringify(r));
};
const isSearch = (input) => {
  const r = url(input);
  ok(`"${input}" → búsqueda`, r?.type === 'search', JSON.stringify(r));
};

console.log('\n1. Direcciones');
isUrl('google.com', 'https://google.com');
isUrl('  github.com/kiddshady  ', 'https://github.com/kiddshady');
isUrl('es.wikipedia.org/wiki/Paracetamol', 'https://es.wikipedia.org/wiki/Paracetamol');
isUrl('https://ejemplo.com/a?b=c', 'https://ejemplo.com/a?b=c');
isUrl('http://neverssl.com', 'http://neverssl.com');
isUrl('localhost:3000', 'http://localhost:3000');
isUrl('localhost', 'http://localhost');
isUrl('192.168.0.10:4747/estado', 'http://192.168.0.10:4747/estado');
isUrl('app.localhost:5173', 'http://app.localhost:5173');
isUrl('umaza.edu.ar', 'https://umaza.edu.ar');
isUrl('about:blank', 'about:blank');
isUrl('view-source:https://ejemplo.com', 'view-source:https://ejemplo.com');
isUrl('C:\\tools\\Nexus\\README.md', 'file:///C:/tools/Nexus/README.md');
isUrl('prism://historial', 'prism://historial');
isUrl('notas.md/x', 'https://notas.md/x');

console.log('\n2. Búsquedas');
isSearch('paracetamol dosis pediatrica');
isSearch('hola');
isSearch('notas.txt');
isSearch('999.1.1.1');
isSearch('javascript:alert(1)');
isSearch('prism://noexiste');
isSearch('https://');
isSearch('qué es un AINE');

console.log('\n3. Buscadores');
const g = omni.classify('a b', 'google');
ok('Google codifica la consulta', g.url === 'https://www.google.com/search?q=a%20b', g.url);
const d = omni.classify('ñandú', 'duckduckgo');
ok('DuckDuckGo con eñe', d.url === 'https://duckduckgo.com/?q=%C3%B1and%C3%BA', d.url);
ok('un buscador desconocido cae a Google', omni.classify('x y', 'nada').url.startsWith('https://www.google.com/'));
ok('vacío → null', omni.classify('   ') === null);

console.log('\n4. Páginas propias');
ok('internalPage reconoce las propias', omni.internalPage('prism://ajustes') === 'ajustes');
ok('y rechaza las ajenas', omni.internalPage('prism://../etc') === null && omni.internalPage('https://x.com') === null);

console.log('\n5. Mostrar una URL');
const s = omni.splitForDisplay('https://www.ejemplo.com/ruta/%C3%B1?q=1');
ok('https no muestra esquema', s.scheme === '' && s.secure === 'https', JSON.stringify(s));
ok('el host va aparte', s.host === 'www.ejemplo.com');
ok('el resto se decodifica', s.rest === '/ruta/ñ?q=1', s.rest);
ok('http sí muestra el esquema (no es seguro)', omni.splitForDisplay('http://a.com/').scheme === 'http://');
ok('la raíz no deja una barra suelta', omni.splitForDisplay('https://a.com/').rest === '');
ok('bareHost saca el www', omni.bareHost('https://www.youtube.com/watch') === 'youtube.com');
ok('originOf', omni.originOf('https://meet.google.com/abc') === 'https://meet.google.com');

console.log('\n6. Sugerencias remotas');
ok('formato OpenSearch', JSON.stringify(omni.parseRemoteSuggest(['q', ['a', ' b ', 3, '']])) === '["a","b"]');
ok('basura → vacío', omni.parseRemoteSuggest({ x: 1 }).length === 0 && omni.parseRemoteSuggest(null).length === 0);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
