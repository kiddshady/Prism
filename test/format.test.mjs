/* ═══════════════════════════════════════════════════════════════════════════
   Formato de números.

   Existe por un detalle chico y contagioso: `toFixed()` escribe siempre con
   punto, sin mirar el locale. La app terminaba diciendo "2.1 MB" al lado de
   "209,9 mm" — dos separadores decimales distintos en la misma pantalla.

   Lo importante de este test no es que salga coma: es que salga **lo que diga
   el locale**. Por eso la última sección lo cambia a en-US y espera puntos. Un
   arreglo que hardcodeara la coma pasaría todo lo de arriba y fallaría ahí.
   ═══════════════════════════════════════════════════════════════════════════ */

import { locale, fmtBytes, fmtNum, fmtDur, fmtMoney } from '../renderer/js/format.js';

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const es = (nombre, real, esperado) => ok(`${nombre} → ${esperado}`, real === esperado, `dio ${real}`);

console.log('\n1. Tamaños de archivo');
es('fmtBytes(0)', fmtBytes(0), '0 B');
es('fmtBytes(512)', fmtBytes(512), '512 B');
es('fmtBytes(2202009)', fmtBytes(2202009), '2,1 MB');
es('fmtBytes(98388075)', fmtBytes(98388075), '94 MB');
/* Bajo 10 va con un decimal y arriba sin ninguno: es la regla vieja, que este
   cambio no tiene que tocar. */
es('fmtBytes(1536) — bajo 10, un decimal', fmtBytes(1536), '1,5 kB');
es('fmtBytes(51200) — sobre 10, entero', fmtBytes(51200), '50 kB');
es('los bytes pelados no llevan decimales', fmtBytes(999), '999 B');

console.log('\n2. Números grandes');
es('fmtNum(0)', fmtNum(0), '0');
es('fmtNum(842)', fmtNum(842), '842');
es('fmtNum(4200)', fmtNum(4200), '4,2k');
es('fmtNum(61000)', fmtNum(61000), '61k');
es('fmtNum(1300000)', fmtNum(1300000), '1,3M');
es('fmtNum(-4200)', fmtNum(-4200), '-4,2k');
/* Bajo mil salía por String(n), que también escribe punto. */
es('fmtNum(12.5) — bajo mil, con decimales', fmtNum(12.5), '12,5');

console.log('\n3. Duraciones y dinero');
es('fmtDur(840)', fmtDur(840), '840ms');
es('fmtDur(2400)', fmtDur(2400), '2,4s');
es('fmtDur(187000)', fmtDur(187000), '3m 07s');
es('fmtMoney(1.5)', fmtMoney(1.5), 'USD 1,50');
es('fmtMoney(0)', fmtMoney(0), 'USD 0,00');
es('fmtMoney chico lleva 4 decimales', fmtMoney(0.0012), 'USD 0,0012');

console.log('\n4. Sin agrupación de miles');
/* En es-AR el separador de miles es el PUNTO. Agrupar traería de vuelta justo
   el carácter que este arreglo saca: "5.000 TB" se lee como 5 con decimales. */
ok('un tamaño de cuatro cifras no se agrupa',
  !fmtBytes(5000 * 1024 ** 4).includes('.'), fmtBytes(5000 * 1024 ** 4));

console.log('\n5. Manda el locale, no la coma');
const original = locale.tag;
try {
  locale.tag = 'en-US';
  es('en-US: fmtBytes', fmtBytes(2202009), '2.1 MB');
  es('en-US: fmtNum', fmtNum(4200), '4.2k');
  es('en-US: fmtDur', fmtDur(2400), '2.4s');
  es('en-US: fmtMoney', fmtMoney(1.5), 'USD 1.50');
} finally {
  locale.tag = original;
}
/* Y volver atrás tiene que funcionar: el caché de formateadores se indexa por
   locale, así que un caché mal armado dejaría la app pegada al idioma anterior. */
es('vuelve a es-AR', fmtBytes(2202009), '2,1 MB');

console.log('\n6. Los bordes: la unidad y los decimales con el valor ya redondeado');
/* Elegían la unidad con el número sin redondear y después redondeaban: justo
   debajo de un límite, el valor subía sin cambiar de sufijo. En Prism se ve
   en las descargas: «1024 kB» un instante antes de «1,0 MB». */
es('fmtNum(999999) no dice 1000k', fmtNum(999999), '1,0M');
es('fmtNum(9999) no dice 10,0k', fmtNum(9999), '10k');
es('fmtNum(9940) sigue con un decimal', fmtNum(9940), '9,9k');
es('fmtNum(10000)', fmtNum(10000), '10k');
es('fmtNum(999499) todavía es k', fmtNum(999499), '999k');
es('fmtBytes(1048575) no dice 1024 kB', fmtBytes(1048575), '1,0 MB');
es('fmtBytes(10239) no dice 10,0 kB', fmtBytes(10239), '10 kB');
es('fmtBytes(1023) sigue en bytes', fmtBytes(1023), '1023 B');
es('fmtBytes(1023.6) redondea a 1,0 kB', fmtBytes(1023.6), '1,0 kB');

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══\n`);
process.exit(fail ? 1 : 0);
