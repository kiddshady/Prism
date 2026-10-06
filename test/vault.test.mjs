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

// El archivo está pero no se puede leer (un antivirus o un backup lo tiene tomado).
let tomado = true;
const lockedDoc = {
  read: async () => { if (tomado) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return mem.data; },
  write: async (d) => { mem.data = structuredClone(d); },
};
const enDisco = JSON.stringify(mem.data);
const vt = V.createVault({ doc: lockedDoc, ...plain });
await vt.load();
let pisó = false;
try { await vt.save({ title: 'nueva', password: 'x', urls: ['https://a.com'] }); pisó = true; } catch { /* esperado */ }
ok('si no se pudo LEER, tampoco escribe encima', !pisó && /EBUSY/.test(vt.broken || '') && JSON.stringify(mem.data) === enDisco, vt.broken);
tomado = false;
await vt.retryRead();
ok('y cuando se suelta, el reintento la abre entera', !vt.broken && vt.size === 4, `${vt.broken} · ${vt.size}`);
ok('con la bóveda abierta, guardar anda', !!(await vt.save({ title: 'nueva', password: 'x', urls: ['https://a.com'] })) && vt.size === 5);
await vt.remove(vt.list().find((it) => it.title === 'nueva').id);
const sana = V.createVault({ doc, ...plain });
await sana.load();
await sana.retryRead();
ok('reintentar una que se leyó bien no hace nada', sana.size === 4 && !sana.broken);

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

console.log('\n7. Tarjetas');
ok('Visa por el 4', V.brandOf('4242 4242 4242 4242') === 'visa');
ok('Mastercard, también la serie 2', V.brandOf('5555555555554444') === 'mastercard' && V.brandOf('2223003122003222') === 'mastercard');
ok('American Express', V.brandOf('378282246310005') === 'amex');
ok('Naranja antes que Maestro', V.brandOf('5895620000000002') === 'naranja');
const exp = (s, e) => ok(`vencimiento ${JSON.stringify(s)} → ${JSON.stringify(e)}`, V.parseExpiry(s) === e, V.parseExpiry(s));
exp('2029-08', '2029-08');
exp('082029', '2029-08');
exp('08/29', '2029-08');
exp('8 / 2029', '2029-08');
exp('13/29', '');
exp('mañana', '');
ok('el vencimiento corto es MM/AA', V.shortExpiry('2029-08') === '08/29');

const vc = V.createVault({ doc: { read: async () => null, write: async () => {} }, ...plain });
await vc.load();
await vc.save({ title: 'Google', email: 'fran@gmail.com', password: 'uno', urls: ['https://accounts.google.com/'] });
const tc = await vc.save({ kind: 'card', holder: 'Francisco Pavez', number: '4242 4242 4242 4242', expiry: '08/29', cvv: '123', pin: '' });
ok('el título sale de la marca y los últimos cuatro', tc.title === 'Visa terminada en 4242', tc.title);
ok('lo público no lleva número, código ni PIN', tc.kind === 'card' && !('number' in tc) && !('cvv' in tc) && !('pin' in tc) && tc.last4 === '4242' && tc.brand === 'visa' && tc.hasCvv && !tc.hasPin);
ok('ni la lista', vc.list().every((it) => !('number' in it) && !('cvv' in it) && !('password' in it)));
ok('el número se guarda sin espacios', vc.get(tc.id).number === '4242424242424242' && vc.get(tc.id).expiry === '2029-08');
ok('una tarjeta no se ofrece como contraseña', vc.findFor('https://accounts.google.com/').length === 1);
ok('cards() trae solo las tarjetas', vc.cards().length === 1 && vc.cards()[0].id === tc.id);
await vc.save({ id: tc.id, note: 'la de débito' });
ok('editar sin mandar lo secreto lo conserva', vc.get(tc.id).number === '4242424242424242' && vc.get(tc.id).cvv === '123' && vc.get(tc.id).note === 'la de débito');
await vc.save({ id: tc.id, kind: 'login', password: 'x' });
ok('editar no cambia la clase', vc.get(tc.id).kind === 'card' && !('password' in vc.get(tc.id)));

const conTarjeta = structuredClone(proton);
conTarjeta.vaults.s1.items.push(
  { state: 1, createTime: 1771789800, modifyTime: 1771789800,
    data: { type: 'creditCard', metadata: { name: 'Débito Galicia', note: '' },
      content: { cardholderName: 'FRANCISCO PAVEZ', cardType: 0, number: '5555555555554444', verificationNumber: '321', expirationDate: '2030-11', pin: '1234' } } },
  { state: 2, data: { type: 'creditCard', metadata: { name: 'Vieja' }, content: { number: '4000056655665556' } } },
);
const jc = V.fromProtonJson(conTarjeta);
const jcard = jc.items.find((it) => it.kind === 'card');
ok('de Proton trae la tarjeta y saltea la de la papelera', jc.items.length === 2 && jc.skipped === 3 && !!jcard);
ok('con titular, número, código, vencimiento y PIN', jcard.holder === 'FRANCISCO PAVEZ' && jcard.number === '5555555555554444' && jcard.cvv === '321' && jcard.expiry === '2030-11' && jcard.pin === '1234');
const ri1 = await vc.importItems(jc.items);
const ri2 = await vc.importItems(jc.items);
ok('importar cuenta las tarjetas aparte', ri1.added === 2 && ri1.cards === 1, JSON.stringify(ri1));
ok('y la misma tarjeta no entra dos veces', ri2.added === 0 && ri2.repeated === 2 && vc.cards().length === 2);

console.log('\n8. Códigos de doble factor');
const T = require('../src/totp.cjs');
const b32 = (ascii) => T.base32Encode(Buffer.from(ascii));
// Los vectores del RFC 6238 (apéndice B): una clave por algoritmo, 8 dígitos.
const RFC = {
  SHA1: b32('12345678901234567890'),
  SHA256: b32('12345678901234567890123456789012'),
  SHA512: b32('1234567890123456789012345678901234567890123456789012345678901234'),
};
for (const [t, want] of [[59, ['94287082', '46119246', '90693936']], [1111111109, ['07081804', '68084774', '25091201']], [20000000000, ['65353130', '77737706', '47863826']]]) {
  const got = ['SHA1', 'SHA256', 'SHA512'].map((a) => T.totp(RFC[a], { digits: 8, algorithm: a, now: t * 1000 }).code);
  ok(`RFC 6238 en t=${t}`, got.join() === want.join(), got.join());
}
ok('base32 ida y vuelta', T.base32Decode(T.base32Encode(Buffer.from('hola mundo'))).toString() === 'hola mundo');
ok('la clave se acepta con espacios y en minúsculas', T.isValidSecret('jbsw y3dp ehpk 3pxp') && !T.isValidSecret('JBSW1') && !T.isValidSecret(''));
ok('cuánto le queda al código', T.msLeft(61_000, 30) === 29_000);

const u = T.parseOtpauth('otpauth://totp/GitHub:kiddshady?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
ok('un enlace otpauth trae emisor, cuenta y clave', u.issuer === 'GitHub' && u.account === 'kiddshady' && u.secret === 'JBSWY3DPEHPK3PXP' && u.digits === 6 && u.period === 30 && u.algorithm === 'SHA1');
const u2 = T.parseOtpauth('otpauth://totp/Proton%3Afran%40proton.me?secret=jbswy3dpehpk3pxp&digits=8&period=60&algorithm=SHA256');
ok('el emisor puede venir solo en la etiqueta, y con sus opciones', u2.issuer === 'Proton' && u2.account === 'fran@proton.me' && u2.digits === 8 && u2.period === 60 && u2.algorithm === 'SHA256');
ok('ida y vuelta por buildOtpauth', JSON.stringify(T.parseOtpauth(T.buildOtpauth(u2))) === JSON.stringify(u2));
const tira = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };
ok('un HOTP se rechaza diciendo por qué', /HOTP/.test(tira(() => T.parseOtpauth('otpauth://hotp/x?secret=JBSWY3DP&counter=1'))));
ok('sin clave válida, también', /base32/.test(tira(() => T.parseOtpauth('otpauth://totp/x?secret=hola!'))));

// Un QR de "Transferir cuentas" de Google Authenticator, armado a mano.
const varint = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const fld = (f, v) => (typeof v === 'number' ? [...varint(f * 8), ...varint(v)] : [...varint(f * 8 + 2), ...varint(v.length), ...v]);
const param = (o) => Buffer.from([...fld(1, [...Buffer.from(o.secret)]), ...fld(2, [...Buffer.from(o.name)]), ...fld(3, [...Buffer.from(o.issuer)]), ...fld(4, o.alg), ...fld(5, o.dig), ...fld(6, o.type)]);
const payload = Buffer.from([
  ...fld(1, [...param({ secret: 'Hello!\xde\xad', name: 'fran@gmail.com', issuer: 'Google', alg: 1, dig: 1, type: 2 })]),
  ...fld(1, [...param({ secret: 'otra-clave', name: 'Steam:fran', issuer: '', alg: 1, dig: 2, type: 2 })]),
  ...fld(1, [...param({ secret: 'contador', name: 'viejo', issuer: 'Banco', alg: 1, dig: 1, type: 1 })]),
  ...fld(2, 1), ...fld(3, 2), ...fld(4, 1),
]);
const mig = T.parseMigration(`otpauth-migration://offline?data=${encodeURIComponent(payload.toString('base64'))}`);
ok('el QR de Google trae las cuentas por tiempo', mig.accounts.length === 2 && mig.accounts[0].issuer === 'Google' && mig.accounts[0].account === 'fran@gmail.com', JSON.stringify(mig.accounts));
ok('con la clave intacta y los 8 dígitos', T.base32Decode(mig.accounts[1].secret).toString() === 'otra-clave' && mig.accounts[1].digits === 8 && mig.accounts[1].issuer === 'Steam' && mig.accounts[1].account === 'fran');
ok('saltea la de contador y dice de qué lote es', mig.skipped.length === 1 && /contador/.test(mig.skipped[0]) && mig.batch.index === 1 && mig.batch.size === 2);

const vo = V.createVault({ doc: { read: async () => null, write: async () => {} }, ...plain, now: () => 59_000 });
await vo.load();
await vo.save({ title: 'GitHub', username: 'kiddshady', password: 'x', urls: ['https://github.com'] });
const code = await vo.save({ kind: 'totp', issuer: 'GitHub', account: 'kiddshady', secret: RFC.SHA1.toLowerCase(), digits: 8 });
ok('lo público de un código no lleva la clave', code.kind === 'totp' && !('secret' in code) && code.hasSecret && code.title === 'GitHub');
ok('ni la lista', vo.list().every((it) => !('secret' in it)));
ok('la clave se guarda normalizada', vo.get(code.id).secret === RFC.SHA1);
ok('el código se calcula en la bóveda', vo.code(code.id, 59_000)?.code === '94287082' && vo.code(code.id, 59_000).msLeft === 1000);
ok('un código no se ofrece como contraseña', vo.findFor('https://github.com/login').length === 1);
await vo.save({ id: code.id, note: 'el de la compu' });
ok('editar sin mandar la clave la conserva, y sus 8 dígitos', vo.get(code.id).secret === RFC.SHA1 && vo.get(code.id).digits === 8 && vo.get(code.id).note === 'el de la compu');
ok('codeWith encuentra la clave escrita de otra forma', vo.codeWith(RFC.SHA1.toLowerCase().replace(/(.{4})/g, '$1 '))?.id === code.id);
const lugar = vo.list().findIndex((x) => x.id === code.id);
await vo.remove(code.id);
ok('borrar lo saca', !vo.get(code.id));
const vuelto = await vo.undoRemove();
ok('deshacer lo trae entero: mismo id, misma clave, mismo lugar', vuelto?.id === code.id && vo.get(code.id)?.secret === RFC.SHA1 && vo.list().findIndex((x) => x.id === code.id) === lugar);
ok('y deshacer dos veces no lo duplica', (await vo.undoRemove()) === null && vo.list().filter((x) => x.id === code.id).length === 1);

const tessera = Buffer.from(`# Respaldo de Tessera\notpauth://totp/GitHub:kiddshady?secret=${RFC.SHA1}&issuer=GitHub\notpauth://totp/Proton:fran?secret=JBSWY3DPEHPK3PXP&issuer=Proton\notpauth://hotp/x?secret=JBSWY3DP\nno es un enlace\n`);
const tx = V.parseExport('tessera-respaldo.txt', tessera);
ok('el respaldo de Tessera entra como códigos', tx.items.length === 2 && tx.items.every((it) => it.kind === 'totp') && tx.skipped === 1);
const ri3 = await vo.importItems(tx.items);
ok('importar cuenta los códigos y saltea el que ya estaba', ri3.added === 1 && ri3.codes === 1 && ri3.repeated === 1, JSON.stringify(ri3));
ok('un archivo sin enlaces avisa', /otpauth/.test(tira(() => V.parseExport('vacio.txt', Buffer.from('nada\n')))));

const conTotp = structuredClone(proton);
conTotp.vaults.s1.items[0].data.content.totpUri = 'otpauth://totp/Google:fran%40gmail.com?secret=JBSWY3DPEHPK3PXQ&issuer=Google';
const jt = V.fromProtonJson(conTotp);
const jcode = jt.items.find((it) => it.kind === 'totp');
ok('de Proton, el código de doble factor del login viene aparte', !!jcode && jcode.secret === 'JBSWY3DPEHPK3PXQ' && jcode.account === 'fran@gmail.com');
const ct = V.fromCsv('type,name,url,email,username,password,note,totp\nlogin,Steam,https://steampowered.com,,fran,x,,JBSWY3DPEHPK3PXR\n');
ok('y del CSV, aunque traiga la clave sola', ct.items.length === 2 && ct.items[1].kind === 'totp' && ct.items[1].title === 'Steam' && ct.items[1].account === 'fran');

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
