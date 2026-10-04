/* ═══════════════════════════════════════════════════════════════════════════
   Escritura atómica bajo concurrencia.

   Existe porque en una app real dos guardados del mismo archivo se solaparon y
   el segundo murió con ENOENT: el `.tmp` tenía nombre fijo y el primero en
   renombrar se lo llevaba. La escritura perdida no dio ningún error visible —
   solo un registro que quedó congelado a mitad. Un test secuencial nunca lo
   habría encontrado, por eso acá se dispara todo a la vez.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opal-store-'));
process.env.PRISM_DATA = DIR;
const store = require('../src/store.cjs');

console.log('\n1. Escrituras simultáneas del mismo archivo');
const file = path.join(DIR, 'concurrente.json');

// 40 escrituras a la vez: el escenario que rompía antes.
const resultados = await Promise.allSettled(
  Array.from({ length: 40 }, (_, i) => store.writeJSON(file, { n: i })),
);
const fallidas = resultados.filter((r) => r.status === 'rejected');
ok('ninguna escritura falla', fallidas.length === 0,
  fallidas.slice(0, 2).map((f) => f.reason?.message).join(' · '));

ok('el archivo final es JSON válido y completo', (() => {
  try { return typeof JSON.parse(fs.readFileSync(file, 'utf8')).n === 'number'; } catch { return false; }
})());

ok('gana la última en encolarse', JSON.parse(fs.readFileSync(file, 'utf8')).n === 39);

const sobrantes = fs.readdirSync(DIR).filter((f) => f.includes('.tmp'));
ok('no quedan temporales tirados', sobrantes.length === 0, sobrantes.join(', '));

console.log('\n2. Bloqueo transitorio del destino (lo que pasa en Windows)');
const lockFile = path.join(DIR, 'bloqueado.json');
await store.writeJSON(lockFile, { v: 0 });
// Mantener el archivo abierto un rato simula el EPERM del rename en Windows.
const fh = fs.openSync(lockFile, 'r+');
const escritura = store.writeJSON(lockFile, { v: 99 });
setTimeout(() => fs.closeSync(fh), 120);
let sobrevivio = true;
try { await escritura; } catch (err) { sobrevivio = false; console.log('    →', err.message); }
ok('la escritura sobrevive al bloqueo', sobrevivio);
ok('y el valor nuevo quedó', JSON.parse(fs.readFileSync(lockFile, 'utf8')).v === 99);

console.log('\n3. Un JSON corrupto no borra los datos');
const roto = path.join(DIR, 'roto.json');
fs.writeFileSync(roto, '{ esto no es json');
const leido = await store.readJSON(roto, { fallback: true });
ok('devuelve el fallback', leido?.fallback === true);
ok('y aparta el archivo ilegible en vez de perderlo',
  fs.readdirSync(DIR).some((f) => f.startsWith('roto.json.corrupto-')),
  fs.readdirSync(DIR).join(', '));

console.log('\n4. Ajustes');
const base = await store.loadSettings();
ok('el primer arranque escribe los defaults', base.schema === store.SCHEMA && fs.existsSync(store.SETTINGS_FILE));
const parche = await store.saveSettings({ searchEngine: 'duckduckgo' });
ok('guardar un parche no pisa el resto', parche.searchEngine === 'duckduckgo' && parche.adblock === store.DEFAULT_SETTINGS.adblock);
// Una clave nueva del código tiene que aparecer en un archivo viejo.
await store.writeJSON(store.SETTINGS_FILE, { schema: store.SCHEMA, searchEngine: 'bing' });
const completado = await store.loadSettings();
ok('las claves nuevas se completan solas', 'historySuggest' in completado && completado.searchEngine === 'bing');

console.log('\n5. Colección');
const col = store.collection('items');
const id = await col.nextId('n');
ok('el primer id es n-0001', id === 'n-0001', id);
await Promise.all([
  col.save({ id, name: 'uno' }),
  col.save({ id: 'n-0002', name: 'dos' }),
  col.save({ id: 'n-0003', name: 'tres' }),
]);
const lista = await col.list();
ok('lista los tres', lista.length === 3, String(lista.length));
ok('se pueden releer', (await col.get('n-0002'))?.name === 'dos');
ok('el id siguiente sigue la cuenta', (await col.nextId('n')) === 'n-0004');
await col.remove('n-0002');
ok('borrar saca de la lista', (await col.list()).length === 2);

console.log('\n6. Un id no puede escapar de la carpeta de datos');
for (const malo of ['../fuera', 'a/b', '..\\..\\x', '', 'con espacio', '.oculto']) {
  let tiro = false;
  try { store.assertId(malo); } catch { tiro = true; }
  ok(`rechaza ${JSON.stringify(malo)}`, tiro);
}

console.log('\n7. Lo que se aparta queda anotado, para avisar');
fs.writeFileSync(path.join(DIR, 'roto2.json'), '{ "a": ');
const d2 = store.doc('roto2');
ok('antes de leer, nada apartado', d2.aside === null);
await d2.read();
ok('el documento sabe adónde fue a parar', /roto2\.json\.corrupto-\d+$/.test(d2.aside || '') && fs.existsSync(d2.aside), String(d2.aside));
ok('y la lista de la corrida lo tiene', store.asides().some((a) => a.file.endsWith('roto2.json')));

console.log('\n8. Escritura sincrónica (el apagado de Windows)');
const sf = path.join(DIR, 'apagado.json');
store.writeJSONSync(sf, { n: 1 });
ok('vuelve con el archivo ya en el disco', JSON.parse(fs.readFileSync(sf, 'utf8')).n === 1);
const vieja = store.writeJSON(sf, { n: 'vieja' });   // encolada ANTES de la sincrónica
store.writeJSONSync(sf, { n: 2 });
await vieja;
ok('una asíncrona encolada antes no la pisa después', JSON.parse(fs.readFileSync(sf, 'utf8')).n === 2, fs.readFileSync(sf, 'utf8'));
await store.writeJSON(sf, { n: 3 });
ok('las que se encolan después escriben normal', JSON.parse(fs.readFileSync(sf, 'utf8')).n === 3);
ok('sin temporales tirados', !fs.readdirSync(DIR).some((f) => f.includes('.tmp')));

console.log('\n9. Un archivo tomado al leer no es un archivo vacío');
if (process.platform === 'win32') {
  const { spawn } = await import('child_process');
  const tomado = path.join(DIR, 'tomado.json');
  fs.writeFileSync(tomado, JSON.stringify({ v: 1 }));
  // Otro programa lo abre sin compartir nada (lo que hace un backup o un antivirus).
  const hold = (ms) => new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${tomado}', 'Open', 'ReadWrite', 'None'); 'listo'; Start-Sleep -Milliseconds ${ms}; $f.Close()`]);
    ps.stdout.once('data', () => resolve(ps));
  });
  const exited = (ps) => new Promise((r) => (ps.exitCode !== null ? r() : ps.on('exit', r)));
  let ps = await hold(200);
  const leido = await store.readJSON(tomado, null).catch((e) => e);
  ok('si se suelta enseguida, el reintento lo lee', leido?.v === 1, leido?.code || JSON.stringify(leido));
  await exited(ps);
  ps = await hold(4000);
  const err = await store.readJSON(tomado, null).then((v) => v, (e) => e);
  ok('si sigue tomado, el error sube (no es "no hay nada")', ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code), String(err?.code ?? JSON.stringify(err)));
  ps.kill();
  await exited(ps);
} else {
  console.log('  (solo en Windows)');
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
