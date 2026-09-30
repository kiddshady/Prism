/* ═══════════════════════════════════════════════════════════════════════════
   Cuentas y conversiones en la barra.
   Cada caso es algo que se tipea de verdad. Equivocarse para un lado muestra
   un número que no es; para el otro, una fila de más con algo que nadie pidió
   (una fecha resuelta como resta). Los dos se ven mal.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const calc = require('../src/calc.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

/** Lo que muestra la fila, como texto: "83,33333333", "1,5 × 10^-7", "0,5 g". */
const shown = (a) => (a ? `${a.num}${a.exp ? `^${a.exp}` : ''}${a.unit ? ` ${a.unit}` : ''}` : null);
const is = (input, want) => {
  const a = calc.answer(input);
  ok(`"${input}" → ${want}`, shown(a) === want, JSON.stringify(a));
};
const none = (input, why = '') => {
  const a = calc.answer(input);
  ok(`"${input}" → nada${why ? ` (${why})` : ''}`, a === null, JSON.stringify(a));
};

console.log('\n1. Cuentas');
is('2+2', '4');
is('250/3', '83,33333333');
is('250 / 3', '83,33333333');
is('(1+2)*3', '9');
is('2^10', '1.024');
is('2^3^2', '512');
is('-2^2', '-4');
is('2x3', '6');
is('3 × 4 ÷ 2', '6');
is('0,1+0,2', '0,3');
is('0.1+0.2', '0,3');
is('1,5*2', '3');
is('7*1,1', '7,7');
is('1.500/3', '500');
is('1.234,5*2', '2.469');
is('2.000.000/4', '500.000');
is('123456789012*1', '123.456.789.012');
is('sqrt(16)', '4');
is('raíz(2)', '1,414213562');
is('√9', '3');
is('2pi', '6,283185307');
is('-log(1e-7)', '7');
is('ln(e)', '1');
is('10^-7', '1 × 10^-7');
is('3*10^20', '3 × 10^20');
is('1/3*3', '1');
is('10-12', '-2');

console.log('\n2. Porcentajes');
is('15% de 300', '45');
is('300*15%', '45');
is('1000 + 21%', '1.210');
is('1500 - 15%', '1.275');
is('50%', '0,5');

console.log('\n3. Lo que no es una cuenta');
none('2026', 'un número solo');
none('pi', 'una constante sola');
none('hola', 'palabras');
none('2*(3', 'paréntesis sin cerrar');
none('2 3', 'dos números pegados');
none('1/0', 'infinito');
none('2024-01-05', 'una fecha');
none('5/10/2026', 'una fecha');
none('261-455-5555', 'un teléfono');
none('192.168.0.1', 'una IP');
none('google.com', 'una dirección');
none('covid-19', 'una búsqueda');
none('1,2,3', 'no es un número');
none('', 'vacío');

console.log('\n4. Conversiones');
is('500 mg a g', '0,5 g');
is('500mg a g', '0,5 g');
is('2,5 g en mg', '2.500 mg');
is('100 mcg a mg', '0,1 mg');
is('100 µg a mg', '0,1 mg');
is('1 kg a lb', '2,204622622 lb');
is('0,5 l a ml', '500 mL');
is('5 cc a ml', '5 mL');
is('37 c a f', '98,6 °F');
is('98.6 f a c', '37 °C');
is('37 °C a K', '310,15 K');
is('0 k a c', '-273,15 °C');
is('5 mg/ml a g/l', '5 g/L');
is('90 km/h a m/s', '25 m/s');
is('120 mmhg a kpa', '15,99868649 kPa');
is('250 kcal a kj', '1.046 kJ');
is('2 h a min', '120 min');
is('1,5 días a horas', '36 h');
is('3 mmol a mol', '0,003 mol');
is('1/2 kg a g', '500 g');

console.log('\n5. Conversiones que no van');
none('1 m a s', 'longitud contra tiempo');
none('37 c a kg', 'temperatura contra masa');
none('10 foo a g', 'unidad que no existe');
none('5 a 3', 'sin unidades');
none('mg a g', 'sin cantidad');

console.log('\n6. El portapapeles');
ok('lo copiado no lleva puntos de miles', calc.answer('1000 + 21%').copy === '1210');
ok('con coma decimal', calc.answer('250/3').copy === '83,33333333');
ok('lo muy chico va con e', calc.answer('10^-7').copy === '1e-7');
ok('la conversión copia solo el número', calc.answer('500 mg a g').copy === '0,5');

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
