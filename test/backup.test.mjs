/* ═══════════════════════════════════════════════════════════════════════════
   El respaldo de la bóveda: que se abra con su clave y con ninguna otra, que
   un archivo tocado no se abra, que no deje nada a la vista, y que las copias
   viejas se vayan sin llevarse lo que no es nuestro. Equivocarse acá es
   descubrirlo el día que se rompió el disco.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const B = require('../src/backup.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const tira = async (fn) => { try { await fn(); return ''; } catch (err) { return err.message; } };

const ITEMS = [
  { id: 'p-1', kind: 'login', title: 'Campus', username: 'fran', password: 'secretísima', urls: ['https://campus.umaza.edu.ar'], note: 'una notita' },
  { id: 'p-2', kind: 'card', title: 'Mastercard', holder: 'Fran', number: '5555555555554444', expiry: '2028-09', cvv: '123', pin: '' },
];

console.log('\n1. El archivo');
const salt = Buffer.from('0123456789abcdef');
const key = await B.deriveKey('la clave de fran', salt);
const text = B.sealBackup(ITEMS, { key, salt, when: 1_700_000_000_000 });
ok('no deja nada a la vista: ni sitios, ni usuarios, ni contraseñas, ni números', !/campus|umaza|fran|secret|notita|5555|Mastercard/i.test(text));
ok('es de Prism y dice cómo se deriva la clave', (() => { const h = B.readHead(text); return h.prism === 'boveda' && h.kdf.name === 'scrypt' && h.kdf.salt === salt.toString('base64'); })());
ok('se abre con su frase', JSON.stringify((await B.openBackup(text, { passphrase: 'la clave de fran' })).items) === JSON.stringify(ITEMS));
ok('y con la clave ya derivada', (await B.openBackup(text, { key })).items.length === 2);
ok('trae cuándo se hizo', (await B.openBackup(text, { key })).when === 1_700_000_000_000);
ok('con otra frase no se abre', (await tira(() => B.openBackup(text, { passphrase: 'la clave de fram' }))).includes('no es la clave'));
ok('una frase con otra forma del mismo carácter (ñ compuesta) es la misma', (await B.openBackup(B.sealBackup(ITEMS, { key: await B.deriveKey('contraseña', salt), salt }), { passphrase: 'contraseña' })).items.length === 2);
const tocado = JSON.parse(text); tocado.when = 1_800_000_000_000;
ok('un archivo con la fecha cambiada a mano no se abre', (await tira(() => B.openBackup(JSON.stringify(tocado), { key }))).includes('no es la clave'));
const roto = JSON.parse(text); roto.data = roto.data.slice(0, -8) + 'AAAAAAA=';
ok('ni uno con los datos tocados', !!(await tira(() => B.openBackup(JSON.stringify(roto), { key }))));
ok('dos respaldos de lo mismo no son iguales (el vector cambia)', B.sealBackup(ITEMS, { key, salt, when: 1 }) !== B.sealBackup(ITEMS, { key, salt, when: 1 }));
ok('un JSON cualquiera no es un respaldo', (await tira(() => B.openBackup('{"vaults":{}}', { key }))).includes('No es un respaldo'));
ok('un archivo que pide un scrypt enorme se rechaza sin probarlo', (await tira(() => B.openBackup(JSON.stringify({ ...JSON.parse(text), kdf: { ...JSON.parse(text).kdf, N: 2 ** 30 } }), { passphrase: 'x' }))).includes('No es un respaldo'));
ok('se reconoce por la extensión', B.isBackup('Algo.PRISMVAULT', Buffer.from('')));
ok('y por adentro, aunque le cambien el nombre', B.isBackup('copia.json', Buffer.from(text)));
ok('una exportación de Proton no es un respaldo', !B.isBackup('data.json', Buffer.from('{"vaults":{}}')));

console.log('\n2. Los nombres y las copias viejas');
ok('uno por día, con la fecha de acá', B.fileName(new Date(2026, 9, 5, 23, 59)) === 'Prism-boveda-2026-10-05.prismvault');
const dias = Array.from({ length: 14 }, (_, i) => B.fileName(new Date(2026, 9, 1 + i)));
ok('quedan los 10 más nuevos', JSON.stringify(B.prune(dias).sort()) === JSON.stringify(dias.slice(0, 4)));
ok('lo que no es un respaldo de Prism no se toca', B.prune([...dias, 'fotos.zip', 'Prism-boveda-2020-01-01.prismvault.bak', 'Prism-boveda-viejo.prismvault']).every((n) => dias.includes(n)));
ok('con pocas copias no se borra ninguna', B.prune(dias.slice(0, 10)).length === 0);

console.log('\n3. El que respalda');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-respaldo-'));
const mem = { data: null };
const doc = { read: async () => mem.data, write: async (d) => { mem.data = structuredClone(d); }, remove: async () => { mem.data = null; } };
let boveda = structuredClone(ITEMS);
let reloj = new Date(2026, 9, 5, 10).getTime();
let avisos = 0;
const nuevo = () => B.createBackup({
  doc, items: () => boveda, fs, now: () => reloj, delay: 20, onChange: () => { avisos++; },
  // En la app es DPAPI; acá, algo que se nota si no se usa.
  seal: (s) => Buffer.from(`sellado:${s}`), unseal: (b) => b.toString().replace(/^sellado:/, ''),
});
let R = nuevo();
await R.load();
ok('arranca apagado', R.state().on === false);
ok('una clave corta no se acepta', (await tira(() => R.setup(dir, 'corta'))).includes('al menos 8'));
ok('y no deja nada prendido', R.state().on === false && mem.data === null);
const destino = path.join(dir, 'respaldos');
await R.setup(destino, 'una clave larga');
const hoy = path.join(destino, 'Prism-boveda-2026-10-05.prismvault');
ok('prenderlo escribe el primero, creando la carpeta', !!(await fs.stat(hoy).catch(() => null)) && R.state().on && R.state().dir === destino);
ok('lo que queda en la compu no es la frase, y la clave va sellada', !JSON.stringify(mem.data).includes('una clave larga') && Buffer.from(mem.data.key, 'base64').toString().startsWith('sellado:'));
ok('el archivo se abre con la frase', (await B.openBackup(await fs.readFile(hoy, 'utf8'), { passphrase: 'una clave larga' })).items.length === 2);
ok('y sin frase, con la clave de acá', (await R.open(await fs.readFile(hoy, 'utf8'))).items.length === 2);
ok('un respaldo de otra configuración pide su frase (no lo abre la clave de acá)', (await R.open(text)) === null);
ok('que con su frase sí abre', (await R.open(text, 'la clave de fran')).items.length === 2);

boveda = [...boveda, { id: 'p-3', kind: 'login', title: 'Nuevo', username: 'x', password: 'y', urls: [], note: '' }];
R.schedule(); R.schedule(); R.schedule();
await new Promise((r) => setTimeout(r, 120));
await R.flush();
ok('un cambio lo actualiza solo, y los cambios seguidos se juntan en uno', (await R.open(await fs.readFile(hoy, 'utf8'))).items.length === 3 && (await fs.readdir(destino)).length === 1);
ok('no quedan temporales', (await fs.readdir(destino)).every((n) => n.endsWith('.prismvault')));

reloj = new Date(2026, 9, 6, 9).getTime();
await R.run();
ok('al otro día va en otro archivo: el de ayer queda', (await fs.readdir(destino)).sort().join() === 'Prism-boveda-2026-10-05.prismvault,Prism-boveda-2026-10-06.prismvault');
ok('y anota cuándo fue el último', R.state().lastAt === reloj && mem.data.lastAt === reloj);

const guardado = boveda;
boveda = [];
await R.run();
ok('una bóveda vacía no pisa el respaldo de hoy', (await R.open(await fs.readFile(path.join(destino, 'Prism-boveda-2026-10-06.prismvault'), 'utf8'))).items.length === 3);
boveda = guardado;

await fs.writeFile(path.join(destino, 'apuntes.txt'), 'no es mío');
for (let d = 7; d <= 20; d++) { reloj = new Date(2026, 9, d, 9).getTime(); await R.run(); }
const quedan = await fs.readdir(destino);
ok('quedan los últimos 10 días, y lo ajeno no se toca', quedan.filter((n) => n.endsWith('.prismvault')).length === 10 && quedan.includes('apuntes.txt') && !quedan.includes('Prism-boveda-2026-10-05.prismvault') && quedan.includes('Prism-boveda-2026-10-20.prismvault'));

R = nuevo();
await R.load();
ok('al volver a abrir Prism sigue prendido', R.state().on && R.state().dir === destino);
reloj = new Date(2026, 9, 21, 9).getTime();
await R.catchUp();
ok('si no cambió nada desde el último, al arrancar no escribe otro', !(await fs.readdir(destino)).includes('Prism-boveda-2026-10-21.prismvault'));
boveda = boveda.slice(0, 2);
await R.catchUp();
ok('si quedó un cambio sin respaldar, al arrancar lo respalda', (await fs.readdir(destino)).includes('Prism-boveda-2026-10-21.prismvault'));

const otra = path.join(dir, 'otra');
await R.move(otra);
ok('cambiar de carpeta escribe ahí con la misma clave, y no borra la anterior', (await R.open(await fs.readFile(path.join(otra, 'Prism-boveda-2026-10-21.prismvault'), 'utf8'))).items.length === 2 && (await fs.readdir(destino)).length > 0);

await fs.writeFile(path.join(dir, 'unarchivo'), 'x');
avisos = 0;
ok('una carpeta que no sirve: el error dice por qué', (await tira(() => R.move(path.join(dir, 'unarchivo', 'adentro')))).includes('No se pudo escribir en esa carpeta'));
ok('y el respaldo sigue donde estaba', R.state().dir === otra && !R.state().error);
await fs.rm(otra, { recursive: true, force: true });
await fs.writeFile(otra, 'ahora es un archivo');
ok('si la carpeta deja de servir, respaldar falla', (await tira(() => R.run())).includes('No se pudo escribir el respaldo'));
ok('queda anotado para avisar, y avisa', !!R.state().error && avisos > 0);
await fs.rm(otra, { force: true });
await R.run();
ok('cuando vuelve, se recupera solo y el error se va', R.state().error === null);

await R.off();
ok('apagarlo olvida la clave y no borra los archivos', R.state().on === false && mem.data === null && (await fs.readdir(otra)).length === 1);
R.schedule();
await new Promise((r) => setTimeout(r, 80));
ok('apagado, un cambio no escribe nada', (await fs.readdir(otra)).length === 1);

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
