'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — cuentas y conversiones
   Lo que se tipea en la barra, si es una cuenta ("250/3", "15% de 300") o
   una conversión ("500 mg a g", "37 c a f"), se resuelve acá y aparece como
   la segunda fila de las sugerencias. La primera sigue siendo lo que hace
   Enter (buscar o ir): el resultado se ve, y elegirlo lo copia.

   Nunca eval: un parser propio que solo entiende números, + - * / ^ %,
   paréntesis, unas pocas funciones y dos constantes. Cualquier otra cosa
   (una palabra, un signo raro) y no hay respuesta: la fila no aparece.

   Escrito para cómo se escribe en Argentina:
   · La coma es decimal: "2,5" es dos y medio.
   · "1.500" es mil quinientos (un punto seguido de tres cifras es de miles),
     pero "0.5", "3.14" y "1.5" son decimales, como los escribe cualquiera.
   · "1000 + 21%" es 1210, como en la calculadora (el IVA, un descuento), y
     "15% de 300" es 45.
   · Los resultados salen con coma decimal y punto de miles (es-AR).

   Pura: ni Electron ni disco (npm test).
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Números ──────────────────────────────────────────────────────────────── */

/** Grupos de miles bien formados: "1", "12", "123", y después de a tres. */
function groupsOk(s, sep) {
  const parts = s.split(sep);
  return /^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/** "1,5" · "1.500" · "1.234,5" · "0.125" · "2e-3" → número, o null si no es uno. */
function parseNumber(raw) {
  let s = String(raw);
  let exp = '';
  const e = /^(.*?)(e[+-]?\d+)$/i.exec(s);
  if (e) { s = e[1]; exp = e[2]; }
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let norm;
  if (dots && commas) {
    // Los dos: el último que aparece es el decimal ("1.234,5" y "1,234.5").
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    const [int, frac, ...more] = s.split(dec);
    if (more.length || !groupsOk(int, grp)) return null;
    norm = `${int.split(grp).join('')}.${frac}`;
  } else if (dots > 1 || commas > 1) {
    // Varios del mismo: solo pueden ser de miles ("2.000.000").
    const sep = dots ? '.' : ',';
    if (!groupsOk(s, sep)) return null;
    norm = s.split(sep).join('');
  } else if (dots === 1) {
    // "1.500" (uno a tres dígitos, sin empezar en 0, y tres después) es de miles.
    const [a, b] = s.split('.');
    norm = /^[1-9]\d{0,2}$/.test(a) && /^\d{3}$/.test(b) ? a + b : s;
  } else if (commas === 1) {
    norm = s.replace(',', '.');
  } else {
    norm = s;
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(norm)) return null;
  const v = Number(norm + exp);
  return Number.isFinite(v) ? v : null;
}

/* ── Cuentas ──────────────────────────────────────────────────────────────── */

const FUNCS = {
  sqrt: Math.sqrt, raiz: Math.sqrt, 'raíz': Math.sqrt, '√': Math.sqrt,
  ln: Math.log, log: Math.log10, abs: Math.abs, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E };
const SYMBOLS = { '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '·': '*', '/': '/', '÷': '/', '^': '^', '%': '%', '(': '(', ')': ')' };

const NUM = /^(?:\d[\d.,]*|[.,]\d[\d.,]*)(?:e[+-]?\d+)?/i;
const WORD = /^[a-zñáéíóúü√π]+/i;

/** El texto en piezas, o null si hay algo que no es de una cuenta. */
function tokenize(text) {
  const out = [];
  let s = text;
  while (s.length) {
    const ws = /^\s+/.exec(s);
    if (ws) { s = s.slice(ws[0].length); continue; }
    const n = NUM.exec(s);
    if (n) {
      const v = parseNumber(n[0]);
      if (v == null) return null;
      out.push({ kind: 'num', v });
      s = s.slice(n[0].length);
      continue;
    }
    if (SYMBOLS[s[0]]) { out.push({ op: SYMBOLS[s[0]] }); s = s.slice(1); continue; }
    const w = WORD.exec(s);
    if (!w) return null;
    const word = w[0].toLowerCase();
    if (word === 'x') out.push({ op: '*' });
    else if (word === 'de' || word === 'of') out.push({ kind: 'of' });
    else if (word in FUNCS) out.push({ kind: 'fn', fn: FUNCS[word] });
    else if (word in CONSTS) out.push({ kind: 'const', v: CONSTS[word] });
    else return null;
    s = s.slice(w[0].length);
  }
  return out;
}

/**
 * Resuelve una cuenta. → { value, ops } (ops: cuántas operaciones hubo), o
 * null si no es una cuenta completa. Cada valor lleva `pct` si es un "N%"
 * suelto, para que "1000 + 21%" sume el 21 % de 1000.
 */
function evaluate(text) {
  const tokens = tokenize(text);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  let ops = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fail = () => { throw new Error('no es una cuenta'); };

  function expr() {
    let left = term();
    while (peek()?.op === '+' || peek()?.op === '-') {
      const op = next().op;
      ops++;
      const right = term();
      const r = right.pct ? left.v * right.v : right.v;
      left = { v: op === '+' ? left.v + r : left.v - r };
    }
    return left;
  }

  function term() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t?.op === '*' || t?.op === '/') {
        next();
        ops++;
        const r = unary().v;
        left = { v: t.op === '*' ? left.v * r : left.v / r };
      } else if (t && (t.op === '(' || t.kind === 'const' || t.kind === 'fn')) {
        // Multiplicación implícita: "2pi", "2(3+1)", "3 raiz 4". Dos números
        // pegados ("2 3") no: eso no es una cuenta.
        ops++;
        left = { v: left.v * unary().v };
      } else {
        return left;
      }
    }
  }

  function unary() {
    if (peek()?.op === '-') { next(); const r = unary(); return { v: -r.v, pct: r.pct }; }
    if (peek()?.op === '+') { next(); return unary(); }
    return power();
  }

  // -2^2 es -4 y 2^3^2 es 2^9: la potencia va antes que el signo, y a la derecha.
  function power() {
    const base = postfix();
    if (peek()?.op !== '^') return base;
    next();
    ops++;
    return { v: base.v ** unary().v };
  }

  function postfix() {
    let x = primary();
    while (peek()?.op === '%') {
      next();
      ops++;
      if (peek()?.kind === 'of') { next(); x = { v: (x.v / 100) * unary().v }; } else x = { v: x.v / 100, pct: true };
    }
    return x;
  }

  function primary() {
    const t = next();
    if (!t) fail();
    if (t.kind === 'num' || t.kind === 'const') return { v: t.v };
    if (t.kind === 'fn') { ops++; return { v: t.fn(unary().v) }; }
    if (t.op === '(') {
      const inside = expr();
      if (next()?.op !== ')') fail();
      return { v: inside.v };
    }
    return fail();
  }

  try {
    const out = expr();
    if (i !== tokens.length || !Number.isFinite(out.v)) return null;
    return { value: out.v, ops };
  } catch {
    return null;
  }
}

/* ── Unidades ─────────────────────────────────────────────────────────────── */

/* Cada unidad: su magnitud, cuánto vale en la unidad base de esa magnitud, y
   cómo se escribe al mostrarla. Los nombres en castellano van con y sin
   tilde, en singular y plural. */
const UNITS = {};
function unit(dim, f, sym, ...aliases) {
  for (const a of aliases) UNITS[a] = { dim, f, sym };
}
unit('masa', 1e3, 'kg', 'kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos');
unit('masa', 1, 'g', 'g', 'gr', 'gramo', 'gramos');
unit('masa', 1e-3, 'mg', 'mg', 'miligramo', 'miligramos');
unit('masa', 1e-6, 'µg', 'µg', 'ug', 'mcg', 'microgramo', 'microgramos');
unit('masa', 1e-9, 'ng', 'ng', 'nanogramo', 'nanogramos');
unit('masa', 1e6, 't', 't', 'tonelada', 'toneladas');
unit('masa', 453.59237, 'lb', 'lb', 'lbs', 'libra', 'libras');
unit('masa', 28.349523125, 'oz', 'oz', 'onza', 'onzas');
unit('volumen', 1, 'L', 'l', 'lt', 'litro', 'litros');
unit('volumen', 0.1, 'dL', 'dl', 'decilitro', 'decilitros');
unit('volumen', 0.01, 'cL', 'cl', 'centilitro', 'centilitros');
unit('volumen', 1e-3, 'mL', 'ml', 'mililitro', 'mililitros');
unit('volumen', 1e-3, 'cm³', 'cc', 'cm3', 'cm³');
unit('volumen', 1e-6, 'µL', 'µl', 'ul', 'microlitro', 'microlitros');
unit('volumen', 1e3, 'm³', 'm3', 'm³');
unit('volumen', 3.785411784, 'gal', 'gal', 'galon', 'galón', 'galones');
unit('longitud', 1e3, 'km', 'km', 'kilometro', 'kilómetro', 'kilometros', 'kilómetros');
unit('longitud', 1, 'm', 'm', 'metro', 'metros');
unit('longitud', 1e-2, 'cm', 'cm', 'centimetro', 'centímetro', 'centimetros', 'centímetros');
unit('longitud', 1e-3, 'mm', 'mm', 'milimetro', 'milímetro', 'milimetros', 'milímetros');
unit('longitud', 1e-6, 'µm', 'µm', 'um', 'micra', 'micras', 'micron', 'micrones', 'micrometro', 'micrómetro', 'micrometros', 'micrómetros');
unit('longitud', 1e-9, 'nm', 'nm', 'nanometro', 'nanómetro', 'nanometros', 'nanómetros');
unit('longitud', 0.0254, 'in', 'in', 'pulgada', 'pulgadas');
unit('longitud', 0.3048, 'ft', 'ft', 'pie', 'pies');
unit('longitud', 0.9144, 'yd', 'yd', 'yarda', 'yardas');
unit('longitud', 1609.344, 'mi', 'mi', 'milla', 'millas');
unit('tiempo', 1e-3, 'ms', 'ms', 'milisegundo', 'milisegundos');
unit('tiempo', 1, 's', 's', 'seg', 'segundo', 'segundos');
unit('tiempo', 60, 'min', 'min', 'minuto', 'minutos');
unit('tiempo', 3600, 'h', 'h', 'hr', 'hs', 'hora', 'horas');
unit('tiempo', 86400, 'd', 'd', 'dia', 'día', 'dias', 'días');
unit('tiempo', 604800, 'sem', 'sem', 'semana', 'semanas');
unit('energía', 1, 'J', 'j', 'joule', 'joules', 'julio', 'julios');
unit('energía', 1e3, 'kJ', 'kj', 'kilojoule', 'kilojoules', 'kilojulio', 'kilojulios');
unit('energía', 4.184, 'cal', 'cal', 'caloria', 'caloría', 'calorias', 'calorías');
unit('energía', 4184, 'kcal', 'kcal', 'kilocaloria', 'kilocaloría', 'kilocalorias', 'kilocalorías');
unit('presión', 1, 'Pa', 'pa', 'pascal', 'pascales');
unit('presión', 100, 'hPa', 'hpa');
unit('presión', 1e3, 'kPa', 'kpa');
unit('presión', 100, 'mbar', 'mbar');
unit('presión', 1e5, 'bar', 'bar');
unit('presión', 101325, 'atm', 'atm', 'atmosfera', 'atmósfera', 'atmosferas', 'atmósferas');
unit('presión', 133.322387415, 'mmHg', 'mmhg');
unit('presión', 98.0665, 'cmH2O', 'cmh2o');
unit('presión', 6894.757293168, 'psi', 'psi');
unit('cantidad', 1, 'mol', 'mol', 'moles');
unit('cantidad', 1e-3, 'mmol', 'mmol');
unit('cantidad', 1e-6, 'µmol', 'µmol', 'umol');
unit('cantidad', 1e-9, 'nmol', 'nmol');

/* La temperatura no es un factor: tiene cero propio. Va aparte. */
const TEMP = {
  c: { sym: '°C', toK: (v) => v + 273.15, fromK: (k) => k - 273.15 },
  f: { sym: '°F', toK: (v) => ((v - 32) * 5) / 9 + 273.15, fromK: (k) => ((k - 273.15) * 9) / 5 + 32 },
  k: { sym: 'K', toK: (v) => v, fromK: (k) => k },
};
const TEMP_ALIAS = {
  c: 'c', '°c': 'c', celsius: 'c', centigrados: 'c', 'centígrados': 'c',
  f: 'f', '°f': 'f', fahrenheit: 'f',
  k: 'k', kelvin: 'k',
};

/** "mg" · "µg" · "mg/ml" · "km/h" → { dim, f, sym } · "°C" → { temp } · null. */
function readUnit(raw) {
  const u = String(raw).trim().toLowerCase().replace(/μ/g, 'µ').replace(/º/g, '°').replace(/\.$/, '');
  if (TEMP_ALIAS[u]) return { temp: TEMP_ALIAS[u] };
  if (UNITS[u]) return UNITS[u];
  const parts = u.split('/');
  if (parts.length !== 2) return null;
  const [a, b] = parts.map((p) => UNITS[p]);
  if (!a || !b) return null;
  return { dim: `${a.dim}/${b.dim}`, f: a.f / b.f, sym: `${a.sym}/${b.sym}` };
}

const CONNECT = /\s+(?:a|en|to|->|→|=)\s+/i;
const LEFT = /^(.*?)\s*([°º]?[\p{L}µμ][\p{L}\dµμ°º²³]*(?:\/[\p{L}µμ][\p{L}\dµμ²³]*)?)$/u;

/** "500 mg a g" → { value, sym } · null si no es una conversión que se entienda. */
function convert(text) {
  const parts = text.split(CONNECT);
  if (parts.length !== 2) return null;
  const m = LEFT.exec(parts[0].trim());
  if (!m || !m[1]) return null;
  const amount = evaluate(m[1]);
  const from = readUnit(m[2]);
  const to = readUnit(parts[1]);
  if (!amount || !from || !to) return null;
  if (from.temp || to.temp) {
    if (!from.temp || !to.temp) return null;
    return { value: TEMP[to.temp].fromK(TEMP[from.temp].toK(amount.value)), sym: TEMP[to.temp].sym };
  }
  if (from.dim !== to.dim) return null;
  return { value: (amount.value * from.f) / to.f, sym: to.sym };
}

/* ── Mostrar ──────────────────────────────────────────────────────────────── */

const EXACT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const SIG = new Intl.NumberFormat('es-AR', { maximumSignificantDigits: 10 });
const SIG6 = new Intl.NumberFormat('es-AR', { maximumSignificantDigits: 6 });

/**
 * Un número para leer, en castellano. Los enteros van enteros (con diez
 * cifras significativas, 123456789012 salía 123.456.789.000); lo demás con
 * diez cifras, que se comen el ruido de la coma flotante (0,1 + 0,2 da 0,3).
 * Lo muy grande o muy chico va como "1,5 × 10" con el exponente aparte, para
 * que la fila lo escriba arriba.
 * → { num, exp, copy }: copy es lo que va al portapapeles, sin puntos de miles.
 */
function format(value) {
  if (!Number.isFinite(value)) return null;
  const v = Object.is(value, -0) ? 0 : value;
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e15 || a < 1e-6)) {
    let exp = Math.floor(Math.log10(a));
    let m = Number((v / 10 ** exp).toPrecision(6));
    if (Math.abs(m) >= 10) { m /= 10; exp += 1; }
    const mant = SIG6.format(m);
    return { num: `${mant} × 10`, exp: String(exp), copy: `${mant}e${exp}` };
  }
  const num = Number.isInteger(v) ? EXACT.format(v) : SIG.format(v);
  return { num, exp: null, copy: num.replace(/\./g, '') };
}

/* ── Lo que usa la barra ──────────────────────────────────────────────────── */

/* Una fecha ("2024-01-05", "5/10/2026") o un teléfono ("261-455-5555") tienen
   forma de cuenta, pero nadie quiere saber cuánto da. */
const LOOKS_LIKE_DATE = /^\d+([-/.])\d+(?:\1\d+)+$/;

/**
 * La respuesta para lo tipeado, o null.
 * → { kind: 'math' | 'convert', num, exp, unit, copy }
 */
function answer(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 200 || LOOKS_LIKE_DATE.test(text)) return null;
  const c = convert(text);
  if (c) {
    const f = format(c.value);
    return f && { kind: 'convert', ...f, unit: c.sym };
  }
  const r = evaluate(text);
  // Un número solo ("2026") o una constante sola ("pi") no son una cuenta.
  if (!r || r.ops < 1) return null;
  const f = format(r.value);
  return f && { kind: 'math', ...f, unit: '' };
}

module.exports = { answer, evaluate, convert, parseNumber, format, readUnit };
