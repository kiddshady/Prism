/* ═══════════════════════════════════════════════════════════════════════════
   El navegador de Windows: lo que Prism anota en el registro y lo que lee de
   la línea de comandos cuando Windows le pasa un link o un archivo.
   El registro mal escrito no avisa: Prism simplemente no aparece en
   Aplicaciones predeterminadas. Y la línea de comandos es la puerta por la
   que entra cualquier link de cualquier app: la pisa gente que no conocemos.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const db = require('../src/default-browser.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const EXE = 'C:\\Users\\francisco\\AppData\\Local\\Programs\\Prism\\Prism.exe';
const find = (entries, key) => entries.find((e) => e.key === key);
const HK = 'HKEY_CURRENT_USER\\Software';

console.log('\n1. Lo que se anota');
{
  const L = db.layout(EXE);
  const client = `${HK}\\Clients\\StartMenuInternet\\Prism`;
  ok('el comando de los links lleva -- antes de la dirección', db.command(EXE) === `"${EXE}" -- "%1"`, db.command(EXE));
  ok('la clase abre con ese comando', find(L, `${HK}\\Classes\\PrismHTML\\shell\\open\\command`)?.values[''] === db.command(EXE));
  ok('se lista como navegador con su nombre', find(L, client)?.values[''] === 'Prism');
  ok('capacidades con nombre e ícono', find(L, `${client}\\Capabilities`)?.values.ApplicationIcon === `${EXE},0`);
  const urls = find(L, `${client}\\Capabilities\\URLAssociations`)?.values || {};
  ok('http y https van a PrismHTML', urls.http === 'PrismHTML' && urls.https === 'PrismHTML', JSON.stringify(urls));
  const files = find(L, `${client}\\Capabilities\\FileAssociations`)?.values || {};
  ok('los tipos de archivo de Chrome, todos a PrismHTML', db.FILE_TYPES.every((t) => files[t] === 'PrismHTML') && Object.keys(files).length === db.FILE_TYPES.length);
  ok('RegisteredApplications apunta a las capacidades (ruta relativa a HKCU)',
    find(L, `${HK}\\RegisteredApplications`)?.values.Prism === 'Software\\Clients\\StartMenuInternet\\Prism\\Capabilities');
  ok('cada tipo suma a Prism en su "abrir con" (REG_NONE)', db.FILE_TYPES.every((t) => find(L, `${HK}\\Classes\\${t}\\OpenWithProgids`)?.values.PrismHTML === null));
  ok('abrir el navegador a secas, sin -- ni %1', find(L, `${client}\\shell\\open\\command`)?.values[''] === `"${EXE}"`);
  ok('la página de Windows es la de Prism', db.SETTINGS_URL === 'ms-settings:defaultapps?registeredAppUser=Prism');

  const box = `${HK}\\PrismPruebaRegistro`;
  const S = db.layout(EXE, box);
  ok('con otra raíz, todo cae adentro de ella', S.every((e) => e.key.startsWith(`${box}\\`)));
  ok('y RegisteredApplications sigue siendo relativa a su raíz',
    find(S, `${box}\\RegisteredApplications`)?.values.Prism === 'Software\\PrismPruebaRegistro\\Clients\\StartMenuInternet\\Prism\\Capabilities');
}

console.log('\n2. El archivo .reg');
{
  const t = db.regText([
    { key: 'HKEY_CURRENT_USER\\Software\\A', values: { '': '"C:\\x y\\P.exe" -- "%1"', N: 'v', Z: null, Q: undefined } },
    { key: 'HKEY_CURRENT_USER\\Software\\B', drop: true },
  ]);
  const lines = t.split('\r\n');
  ok('encabezado de la versión 5', lines[0] === 'Windows Registry Editor Version 5.00');
  ok('fin de línea de Windows', !/[^\r]\n/.test(t));
  ok('el predeterminado es @ y escapa barras y comillas', lines.includes('@="\\"C:\\\\x y\\\\P.exe\\" -- \\"%1\\""'), lines[3]);
  ok('un valor con nombre', lines.includes('"N"="v"'));
  ok('REG_NONE vacío', lines.includes('"Z"=hex(0):'));
  ok('borrar un valor', lines.includes('"Q"=-'));
  ok('borrar una clave entera', lines.includes('[-HKEY_CURRENT_USER\\Software\\B]'));
  let threw = false;
  try { db.regText([{ key: 'HKEY_CURRENT_USER\\Software\\A', values: { N: 'a\r\nb' } }]); } catch { threw = true; }
  ok('un salto de línea en un valor no se escribe', threw);
}

console.log('\n3. Lo que se borra al desinstalar');
{
  const L = db.layout(EXE);
  const R = db.removal();
  const dropped = R.filter((e) => e.drop).map((e) => e.key);
  const covered = (key, name) => dropped.some((d) => key === d || key.startsWith(`${d}\\`))
    || R.some((e) => e.key === key && e.values && name in e.values);
  const leftovers = L.flatMap((e) => Object.keys(e.values).map((n) => [e.key, n])).filter(([k, n]) => !covered(k, n));
  ok('todo lo que se anota tiene quién lo borre', !leftovers.length, JSON.stringify(leftovers));
  ok('lo compartido no se borra entero', !dropped.some((k) => /RegisteredApplications|OpenWithProgids/.test(k)));

  // El desinstalador (NSIS) borra lo mismo, clave por clave.
  const nsh = fs.readFileSync(path.join(here, '..', 'build', 'installer.nsh'), 'utf8');
  const nsis = new Set([...nsh.matchAll(/^\s*DeleteRegKey HKCU "([^"]+)"/gm)].map((m) => `key:${m[1]}`)
    .concat([...nsh.matchAll(/^\s*DeleteRegValue HKCU "([^"]+)" "([^"]+)"/gm)].map((m) => `val:${m[1]}|${m[2]}`)));
  const rel = (k) => k.replace('HKEY_CURRENT_USER\\', '');
  const want = new Set(R.flatMap((e) => (e.drop ? [`key:${rel(e.key)}`] : Object.keys(e.values).map((n) => `val:${rel(e.key)}|${n}`))));
  const missing = [...want].filter((x) => !nsis.has(x));
  const extra = [...nsis].filter((x) => !want.has(x));
  ok('installer.nsh borra lo mismo que removal()', !missing.length && !extra.length, JSON.stringify({ missing, extra }));
  ok('y solo si no es una actualización', /\$\{ifNot\} \$\{isUpdated\}/.test(nsh));
}

console.log('\n4. Lo que llega por la línea de comandos');
{
  const yes = () => true;
  const no = () => false;
  const T = (argv, opts = {}) => db.targetsFromArgv(argv, { exists: no, ...opts });
  const same = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

  same('como lo lanza Windows', T([EXE, '--', 'https://example.com/a b?q=1']), ['https://example.com/a b?q=1']);
  same('en la segunda instancia (Chromium mete switches antes del --)',
    T([EXE, '--allow-file-access-from-files', '--', 'https://ejemplo.com/']), ['https://ejemplo.com/']);
  same('en desarrollo, con la carpeta de la app y --dev', T(['electron.exe', '.', '--dev', '--', 'https://x.com']), ['https://x.com']);
  same('a mano, sin --', T([EXE, 'https://x.com']), ['https://x.com']);
  same('a mano, los switches se ignoran', T([EXE, '--original-process-start-time=1', 'HTTPS://X.COM/']), ['HTTPS://X.COM/']);
  same('un switch colado detrás del link no pasa', T([EXE, '--', 'https://x.com/"', '--gpu-launcher=calc']), ['https://x.com/"']);
  same('javascript: y otros esquemas, no', T([EXE, '--', 'javascript:alert(1)', 'file:///C:/x.html', 'prism://ajustes']), []);
  same('https:// sin host, no', T([EXE, '--', 'https://', 'https:// espacio']), []);
  same('sin nada, nada', T([EXE]), []);
  same('la carpeta de la app en desarrollo no es un archivo', T(['electron.exe', '.'], { exists: yes }), []);

  const pdf = 'C:\\Users\\francisco\\Documents\\Apuntes #3 de Tecnia.pdf';
  same('un archivo con # y espacios llega entero', T([EXE, '--', pdf], { exists: yes }),
    ['file:///C:/Users/francisco/Documents/Apuntes%20%233%20de%20Tecnia.pdf']);
  same('un archivo que no existe, no', T([EXE, '--', pdf]), []);
  same('un .exe, aunque exista, no', T([EXE, '--', 'C:\\Windows\\System32\\calc.exe'], { exists: yes }), []);
  same('una ruta relativa, contra la carpeta de quien lo abrió',
    T([EXE, 'pagina.html'], { exists: yes, cwd: 'C:\\Proyecto' }), ['file:///C:/Proyecto/pagina.html']);
  same('un .html y un link juntos, en orden', T([EXE, '--', 'C:\\a.html', 'https://b.com'], { exists: yes }), ['file:///C:/a.html', 'https://b.com']);
}

console.log('\n5. ¿Es este Prism? (la ruta que devuelve el shell contra la propia)');
{
  const os = await import('os');
  const tmp = os.tmpdir();                           // en la UCX: C:\Users\FRANCI~1\AppData\Local\Temp
  const long = fs.realpathSync.native(tmp);          //            C:\Users\francisco\AppData\Local\Temp
  ok(`la ruta corta y la larga son la misma${tmp === long ? ' (acá no hay corta: se prueba igual)' : ''}`, db.samePath(tmp, long), `${tmp} · ${long}`);
  ok('sin importar mayúsculas', db.samePath(long.toUpperCase(), long.toLowerCase()));
  ok('otra carpeta no', !db.samePath(long, path.join(long, 'otra')));
  ok('sin ruta, no', !db.samePath('', long) && !db.samePath(undefined, long));
}

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
