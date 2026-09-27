/* ═══════════════════════════════════════════════════════════════════════════
   Capturas: el nombre del archivo y los tramos en que se pide una página larga.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fileName, tiles, stamp, TILE } = require('../src/capture.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const when = new Date(2026, 8, 27, 9, 5, 3);

console.log('\n1. Nombre');
ok('la hora sin dos puntos (Windows no los acepta)', stamp(when) === '2026-09-27 09.05.03', stamp(when));
ok('el sitio sin www', fileName('https://www.youtube.com/watch?v=1', when) === 'youtube.com 2026-09-27 09.05.03.png', fileName('https://www.youtube.com/watch?v=1', when));
ok('la entera se distingue', fileName('https://a.com/', when, true).endsWith(' (entera).png'));
ok('sin host, Prism', fileName('file:///C:/x.html', when).startsWith('Prism '));
ok('una url rota no rompe', fileName('esto no es una url', when).startsWith('Prism '));
ok('nada que Windows rechace', !/[<>:"/\\|?*]/.test(fileName('https://[::1]:8080/', when)), fileName('https://[::1]:8080/', when));

console.log('\n2. Tramos');
const sum = (t) => t.reduce((s, [, h]) => s + h, 0);
const contiguous = (t) => t.every(([y], i) => (i === 0 ? y === 0 : y === t[i - 1][0] + t[i - 1][1]));
ok('una página corta es un solo tramo', tiles(900).length === 1 && tiles(900)[0][1] === 900);
ok('justo un tramo', tiles(TILE).length === 1);
ok('un píxel más, dos', tiles(TILE + 1).length === 2 && tiles(TILE + 1)[1][1] === 1);
const big = tiles(45123);
ok('cubren la página entera, sin huecos ni encimados', sum(big) === 45123 && contiguous(big));
ok('ninguno pasa del máximo', big.every(([, h]) => h <= TILE));
ok('alto cero, nada', tiles(0).length === 0);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
