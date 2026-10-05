/* ═══════════════════════════════════════════════════════════════════════════
   El enlace a un texto: qué se escribe en el fragmento `#:~:text=…` para que
   quien lo abra caiga en lo que se eligió, y no en otra parte de la página.
   Un enlace que resalta el párrafo equivocado es peor que uno que no resalta.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const T = require('../src/textlink.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `\n      ${JSON.stringify(a)}\n      ${JSON.stringify(b)}`);

console.log('\n1. Qué términos lleva');
const PAGINA = 'La absorción oral es lenta en ayunas. Farmacocinética en niños. Sin embargo, en niños la absorción oral es más rápida que en adultos.';
eq('un texto corto y único va entero, sin contexto',
  T.terms({ text: 'es lenta en ayunas', before: 'La absorción oral ', after: '.', page: PAGINA }),
  { prefix: '', start: 'es lenta en ayunas', end: '', suffix: '' });
eq('si se repite en la página, lleva lo de antes y lo de después',
  T.terms({ text: 'la absorción oral', before: 'Sin embargo, en niños ', after: ' es más rápida que en adultos.', page: PAGINA }),
  { prefix: 'embargo, en niños', start: 'la absorción oral', end: '', suffix: 'es más rápida' });
ok('repetido con otra mayúscula también cuenta (Chromium compara sin mayúsculas)',
  T.terms({ text: 'la absorción oral', before: 'en niños ', after: ' es', page: PAGINA }).prefix !== '');
eq('sin el texto de la página no se inventa contexto',
  T.terms({ text: 'la absorción oral', before: 'en niños ', after: ' es más' }),
  { prefix: '', start: 'la absorción oral', end: '', suffix: '' });
eq('los espacios y saltos de más no cuentan', T.terms({ text: '  es   lenta\t en ayunas ' }).start, 'es lenta en ayunas');
ok('nada elegido, nada que enlazar', T.terms({ text: '  \n ' }) === null && T.terms({}) === null);

const dos = T.terms({ text: 'Farmacocinética en niños\nSin embargo, en niños la absorción oral es más rápida que en adultos', page: PAGINA });
eq('lo que cruza de un bloque a otro va con inicio y fin', [dos.start, dos.end], ['Farmacocinética en niños', 'más rápida que en adultos']);
const largo = Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(' ');
const tl = T.terms({ text: largo });
eq('uno largo en un solo bloque, también: las primeras y las últimas palabras', [tl.start, tl.end], ['palabra0 palabra1 palabra2 palabra3 palabra4', 'palabra75 palabra76 palabra77 palabra78 palabra79']);
const eco = T.terms({ text: `uno dos tres cuatro cinco ${'relleno '.repeat(50)}la dosis total es muy alta y la dosis total es muy alta` });
ok('si el fin ya aparece antes, adentro de lo elegido, se alarga hasta ser el último', eco.end === 'y la dosis total es muy alta', eco.end);
const corto2 = T.terms({ text: 'Uno\nDos' });
eq('dos bloques de una palabra', [corto2.start, corto2.end], ['Uno', 'Dos']);

console.log('\n2. Cómo se escribe');
const d = (t) => T.directive({ prefix: '', end: '', suffix: '', ...t });
ok('los acentos van escapados', d({ start: 'absorción oral' }) === 'text=absorci%C3%B3n%20oral');
ok('el guion, la coma y el & de adentro también: son los separadores', d({ start: 'anti-inflamatorio, no esteroide & co' }) === 'text=anti%2Dinflamatorio%2C%20no%20esteroide%20%26%20co');
ok('el contexto va con su guion y sus comas', d({ prefix: 'en niños', start: 'la absorción', suffix: 'es más' }) === 'text=en%20ni%C3%B1os-,la%20absorci%C3%B3n,-es%20m%C3%A1s');
ok('inicio y fin, separados por una coma', d({ start: 'Uno', end: 'Dos' }) === 'text=Uno,Dos');

console.log('\n3. La dirección');
const t1 = { prefix: '', start: 'hola', end: '', suffix: '' };
ok('se suma a la dirección de la página', T.linkFor('https://ejemplo.com/apunte?p=2', t1) === 'https://ejemplo.com/apunte?p=2#:~:text=hola');
ok('conserva el ancla que tuviera', T.linkFor('https://ejemplo.com/apunte#seccion-3', t1) === 'https://ejemplo.com/apunte#seccion-3:~:text=hola');
ok('reemplaza un enlace a texto anterior, no lo apila', T.linkFor('https://ejemplo.com/a#s:~:text=viejo', t1) === 'https://ejemplo.com/a#s:~:text=hola');
ok('un archivo de la compu también', T.linkFor('file:///C:/Apuntes/tp.html', t1) === 'file:///C:/Apuntes/tp.html#:~:text=hola');
ok('una página de Prism o cualquier otro esquema, no', T.linkFor('prism://ajustes', t1) === null && T.linkFor('view-source:https://x.com', t1) === null && T.linkFor('no es una dirección', t1) === null);
ok('sin términos, no hay enlace', T.linkFor('https://ejemplo.com/', null) === null);

console.log('\n4. Lo que llega de la página');
ok('se queda con los cuatro textos, recortados', (() => { const c = T.clean({ text: 'a'.repeat(30000), before: 'b', after: 'c', page: 'p', otro: 1 }); return c.text.length === 20000 && c.before === 'b' && !('otro' in c); })());
ok('algo que no es lo esperado se descarta', T.clean(null) === null && T.clean('texto') === null && T.clean({ text: 5 }) === null);
ok('lo que corre en la página no usa nada de afuera (se manda como texto)', !/\b(norm|words|low|times|enc|require)\(/.test(T.collect.toString()));

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
