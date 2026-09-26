/* ═══════════════════════════════════════════════════════════════════════════
   Certificados: qué cuenta como "red local".
   Es la única puerta para confiar en un certificado que Chromium no valida,
   así que se prueba de los dos lados: lo de casa entra, y lo de internet —
   incluidos los casos que se PARECEN a lo de casa— no.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isLocalHost, hostOf } = require('../src/certs.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

console.log('\n1. De la red de casa');
for (const h of ['192.168.1.1', '192.168.0.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254',
  '127.0.0.1', '169.254.10.20', 'localhost', 'app.localhost', 'nas.local', 'router.home.arpa',
  '::1', 'fe80::1', 'fd12:3456::1', 'ROUTER.LOCAL']) {
  ok(`${h} es local`, isLocalHost(h));
}

console.log('\n2. De internet (aunque se parezcan)');
for (const h of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '1.192.168.1',
  'google.com', 'local', 'localhost.com', 'router.local.evil.com', 'home.arpa.com', '192.168.1.1.nip.io',
  '256.168.1.1', '192.168.1', '2001:4860:4860::8888', '']) {
  ok(`${h || '(vacío)'} no es local`, !isLocalHost(h));
}

console.log('\n3. El host sale de la URL');
ok('https://192.168.1.1/ → 192.168.1.1', hostOf('https://192.168.1.1/') === '192.168.1.1');
ok('con puerto y ruta', hostOf('https://192.168.1.1:8443/login?x=1') === '192.168.1.1');
ok('IPv6 sin corchetes', hostOf('https://[fe80::1]/') === 'fe80::1');
ok('mayúsculas', hostOf('https://NAS.LOCAL/') === 'nas.local');
ok('basura → vacío', hostOf('no es una url') === '');

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
