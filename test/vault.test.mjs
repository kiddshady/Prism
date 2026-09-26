/* ═══════════════════════════════════════════════════════════════════════════
   La bóveda de contraseñas: a qué sitio pertenece cada una, y leer lo que
   exporta Proton Pass. Equivocarse con el sitio es ofrecerle tu contraseña a
   quien no es; equivocarse al importar es perder una.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import zlib from 'zlib';
const require = createRequire(import.meta.url);
const V = require('../src/vault.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

console.log('\n1. El sitio de cada host');
const site = (h, e) => ok(`${h} → ${e}`, V.siteOf(h) === e, V.siteOf(h));
site('accounts.google.com', 'google.com');
site('www.mercadolibre.com.ar', 'mercadolibre.com.ar');
site('campus.umaza.edu.ar', 'umaza.edu.ar');
site('bbc.co.uk', 'bbc.co.uk');
site('kiddshady.github.io', 'kiddshady.github.io');
site('otro.github.io', 'otro.github.io');
site('mi-app.vercel.app', 'mi-app.vercel.app');
site('192.168.1.1', '192.168.1.1');
site('localhost', 'localhost');
ok('una dirección sin esquema tiene host', V.hostOf('accounts.google.com/login') === 'accounts.google.com');
ok('un file:// no tiene host', V.hostOf('file:///C:/x.html') === '');

console.log('\n2. Qué se ofrece en cada página');
const mem = { data: null };
const doc = { read: async () => mem.data, write: async (d) => { mem.data = structuredClone(d); } };
const plain = { seal: (s) => Buffer.from(s, 'utf8'), unseal: (b) => b.toString('utf8') };
const v = V.createVault({ doc, ...plain });
await v.load();
const g = await v.save({ title: 'Google', email: 'fran@gmail.com', password: 'uno', urls: ['https://accounts.google.com/'] });
await v.save({ title: 'Mail', username: 'fran', password: 'dos', urls: ['https://mail.google.com'] });
await v.save({ title: 'Blog', username: 'fran', password: 'tres', urls: ['https://kiddshady.github.io'] });
const en = (url) => v.findFor(url).map((it) => it.title);
ok('el host exacto va primero', JSON.stringify(en('https://mail.google.com/x')) === '["Mail","Google"]', JSON.stringify(en('https://mail.google.com/x')));
ok('todo google.com sirve en accounts', en('https://accounts.google.com/signin').length === 2);
ok('nada en un sitio que termina parecido', en('https://evilgoogle.com').length === 0);
ok('ni en el github.io de otra persona', en('https://otro.github.io').length === 0);
ok('ni fuera de http(s)', en('file:///C:/google.com').length === 0);

console.log('\n3. Guardar, editar, cifrar');
ok('lo público no lleva la contraseña', !('password' in v.list()[0]) && v.list()[0].hasPassword === true);
ok('el título sale del sitio si no hay', (await v.save({ username: 'x', password: 'y', urls: ['https://www.netflix.com'] })).title === 'netflix.com');
const antes = v.get(g.id);
await new Promise((r) => setTimeout(r, 5));
await v.save({ id: g.id, note: 'Guardado automáticamente' });
const despues = v.get(g.id);
ok('editar conserva la contraseña y la fecha de creación', despues.password === 'uno' && despues.createdAt === antes.createdAt && despues.modifiedAt > antes.modifiedAt);
ok('y guarda la nota', despues.note === 'Guardado automáticamente');
ok('en disco va todo junto en el blob', Object.keys(mem.data).join() === 'v,blob' && !JSON.stringify(mem.data).includes('accounts.google.com'));
const v2 = V.createVault({ doc, ...plain });
await v2.load();
ok('se vuelve a leer igual', v2.size === 4 && v2.get(g.id)?.note === 'Guardado automáticamente');

const roto = V.createVault({ doc, seal: plain.seal, unseal: () => { throw new Error('otra cuenta'); } });
await roto.load();
let escribio = false;
try { await roto.save({ title: 'x' }); escribio = true; } catch { /* esperado */ }
ok('si no se pudo descifrar, NUNCA escribe encima', !escribio && !!roto.broken && v2.size === 4);

console.log('\n4. El CSV de Proton Pass');
const csv = [
  'type,name,url,email,username,password,note,totp,createTime,modifyTime,vault',
  'login,GitHub,https://github.com/,fpavez@proton.me,kiddshady,"con,coma y ""comillas""","dos\nrenglones",,1771789800,1771789900,Personal',
  'note,Una nota,,,,,texto,,,,Personal',
  'login,Google,"https://accounts.google.com/, https://mail.google.com/",franciscopavezlunati@gmail.com,,,,,,,Personal',
].join('\r\n');
const c = V.fromCsv(csv);
ok('lee los logins y saltea el resto', c.items.length === 2 && c.skipped === 1);
ok('respeta comas, comillas y saltos adentro de un campo', c.items[0].password === 'con,coma y "comillas"' && c.items[0].note === 'dos\nrenglones');
ok('usuario y correo por separado', c.items[0].username === 'kiddshady' && c.items[0].email === 'fpavez@proton.me');
ok('las fechas en segundos pasan a milisegundos', c.items[0].createdAt === 1771789800000);
ok('varias direcciones en un campo', V.normalize(c.items[1]).urls.length === 2);

console.log('\n5. El JSON y el ZIP de Proton Pass');
const proton = {
  version: '1.21.0', encrypted: false,
  vaults: { s1: { name: 'Personal', items: [
    { state: 1, createTime: 1771789800, modifyTime: 1771789800, lastUseTime: 1771900000,
      data: { type: 'login', metadata: { name: 'accounts.google.com', note: 'Guardado automáticamente en https://accounts.google.com/' },
        content: { itemEmail: 'franciscopavezlunati@gmail.com', itemUsername: '', password: '', urls: ['https://accounts.google.com/'], passkeys: [{}] } } },
    { state: 2, data: { type: 'login', metadata: { name: 'En la papelera' }, content: { password: 'x' } } },
    { state: 1, data: { type: 'alias', metadata: { name: 'Alias' }, content: {} } },
  ] } },
};
const j = V.fromProtonJson(proton);
ok('lee el login y saltea papelera y alias', j.items.length === 1 && j.skipped === 2);
ok('trae la nota y el último uso', j.items[0].note.startsWith('Guardado') && j.items[0].lastUsedAt === 1771900000000);
let cifrado = '';
try { V.fromProtonJson({ encrypted: true }); } catch (e) { cifrado = e.message; }
ok('una exportación cifrada explica qué hacer', cifrado.includes('sin cifrar'));

/** Un .zip mínimo, como el de Proton Pass: una carpeta con data.json comprimido. */
function zip(name, content) {
  const data = zlib.deflateRawSync(Buffer.from(content));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(n.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(0, 42);
  const cdStart = 30 + n.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, n, data, cen, n, end]);
}
const z = V.parseExport('Proton Pass_export.zip', zip('Proton Pass/data.json', JSON.stringify(proton)));
ok('abre el .zip y encuentra data.json', z.items.length === 1 && z.items[0].email === 'franciscopavezlunati@gmail.com');

console.log('\n6. Importar dos veces no duplica');
const v3 = V.createVault({ doc: { read: async () => null, write: async () => {} }, ...plain });
await v3.load();
const r1 = await v3.importItems(c.items);
const r2 = await v3.importItems(c.items);
ok('la primera suma todo', r1.added === 2 && r1.repeated === 0);
ok('la segunda no suma nada', r2.added === 0 && r2.repeated === 2 && v3.size === 2);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
