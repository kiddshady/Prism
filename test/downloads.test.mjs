/* ═══════════════════════════════════════════════════════════════════════════
   El nombre con que se guarda una descarga. Un nombre largo (el título entero
   de un apunte) se recortaba con extensión y todo: el .pdf se iba con el
   recorte y Windows no sabía con qué abrir el archivo.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { uniquePath } = require('../src/downloads.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dl-'));
const name = (f, reserved) => path.basename(uniquePath(DIR, f, reserved));

console.log('\n1. Nombres largos');
const largo = `Guía de trabajos prácticos de Farmacología y Toxicología I - Unidad 4 - ${'Fármacos del sistema nervioso autónomo '.repeat(3)}- versión corregida 2026 (cátedra).pdf`;
const n1 = name(largo);
ok('conserva la extensión', n1.endsWith('.pdf'), n1);
ok('y entra en el largo', n1.length <= 180, String(n1.length));
ok('183 letras + .pdf también', name(`${'A'.repeat(183)}.pdf`).endsWith('A.pdf'));
const corte = name(`${'a'.repeat(175)} b c.pdf`);
ok('el recorte no termina en espacio ni en punto', !/[ .]\.pdf$/.test(corte), corte.slice(-12));

console.log('\n2. Lo de siempre');
ok('un nombre corto queda igual', name('apunte.pdf') === 'apunte.pdf');
ok('los caracteres prohibidos se cambian', name('a<b>:c?.txt') === 'a_b__c_.txt', name('a<b>:c?.txt'));
ok('sin nombre, "descarga"', name('') === 'descarga');
ok('un punto suelto al final no queda', name('archivo.') === 'archivo', name('archivo.'));
fs.writeFileSync(path.join(DIR, 'apunte.pdf'), '');
ok('si ya existe, (1)', name('apunte.pdf') === 'apunte (1).pdf');
const reserved = new Set([path.join(DIR, 'apunte (1).pdf').toLowerCase()]);
ok('lo reservado por otra descarga en curso cuenta como ocupado', name('apunte.pdf', reserved) === 'apunte (2).pdf');
ok('una "extensión" absurda no es extensión', name(`informe.${'x'.repeat(40)}`).length <= 180);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
