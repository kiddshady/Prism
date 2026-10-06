'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — el navegador de Windows
   Lo que hace falta para que Windows trate a Prism como un navegador: que
   aparezca en Aplicaciones predeterminadas, que se lo pueda elegir para los
   links y los .html, y que lo que Windows le pase al abrirlo llegue entero.

   ── Por qué no hay un botón que lo haga solo ──────────────────────────────
   Desde Windows 8 ninguna app puede ponerse de predeterminada: la elección
   vive en UserChoice, firmada con un hash, y desde 2024 un driver (UCPD) ni
   deja escribirla. Lo único legítimo es REGISTRARSE (decirle a Windows "soy
   un navegador, abro esto") y llevar a la persona a la pantalla de Windows
   donde lo elige. El registro va en HKCU: no pide permisos de administrador.

   ── Windows se entera tarde ─────────────────────────────────────────────────
   El shell ve el registro en el acto ("Abrir con", el comando de los links),
   pero la lista de Aplicaciones predeterminadas sale de un índice que no se
   rehace al registrarse: probado en la UCX (25H2), no lo refrescan
   SHChangeNotify, reiniciar Configuración ni el menú Inicio, ni un acceso
   directo nuevo. Ni siquiera una copia de las capacidades de Firefox con
   otro nombre aparece: en más de media hora de pruebas, nada. Reiniciar la
   compu sí lo rehace (confirmado con la 1.3.0, el 30/9/2026: después del
   reinicio el botón abrió directo la página de Prism). Si alcanza con cerrar
   la sesión no se probó. Hasta entonces, ms-settings abre la lista general
   en vez de la página de Prism. Por eso Prism se registra apenas arranca,
   sin esperar al botón.

   ── Quién es el predeterminado: se le pregunta al shell ─────────────────────
   No se lee el registro a mano. En Windows 11 25H2 conviven UserChoice y
   UserChoiceLatest, y en la UCX dicen cosas distintas (el viejo quedó en
   Firefox; el que manda dice Chrome). app.getApplicationInfoForProtocol
   pregunta a AssocQueryString, que es lo que usa el propio Windows.

   ── El comando: `"Prism.exe" -- "%1"` ──────────────────────────────────────
   Chrome se registra con `--single-argument %1`, pero Electron no respeta ese
   switch en process.argv. Sin el `--`, un link armado con comillas puede
   colar switches de Chromium detrás de la dirección (CVE-2018-1000006): se
   probó con `--gpu-launcher` y Electron 40 llegó a tomarlo y se cayó. Con
   el `--`, todo lo que sigue es texto, nunca un switch, y los espacios de la
   dirección viajan dentro de las comillas.

   Pura hasta createDefaultBrowser: el diseño del registro, el .reg y la
   lectura de la línea de comandos se prueban desde node (npm test).
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** El nombre con que Windows lo lista (y el de ms-settings:…registeredAppUser). */
const NAME = 'Prism';
/** La clase que abre los links y los archivos: la de Chrome es ChromeHTML. */
const PROG_ID = 'PrismHTML';
/** Lo mismo que registra Chrome. Registrarse no elige nada: solo suma a
    Prism a la lista de "abrir con" de cada tipo. */
const FILE_TYPES = ['.htm', '.html', '.pdf', '.shtml', '.svg', '.webp', '.xht', '.xhtml'];
const URL_TYPES = ['http', 'https'];
const DESCRIPTION = 'Navegador de escritorio sobre Chromium.';
const COMPANY = 'Umbrovex Systems';
/** Lo que Windows abre para elegir el predeterminado, ya en la página de Prism. */
const SETTINGS_URL = `ms-settings:defaultapps?registeredAppUser=${NAME}`;
const HKCU = 'HKEY_CURRENT_USER';
const ROOT = `${HKCU}\\Software`;

/** La línea de comandos con que Windows abre un link o un archivo. */
const command = (exe) => `"${exe}" -- "%1"`;

/**
 * Todo lo que Prism escribe en el registro, como [{ key, values }].
 * `values` usa '' para el valor predeterminado y null para un REG_NONE vacío
 * (lo que Windows espera en OpenWithProgids). `root` existe para las pruebas:
 * el mismo árbol se puede escribir debajo de una clave descartable.
 */
function layout(exe, root = ROOT) {
  const rel = root.slice(root.indexOf('\\') + 1);          // 'Software', sin la colmena
  const client = `${root}\\Clients\\StartMenuInternet\\${NAME}`;
  const icon = `${exe},0`;
  const byType = (types) => Object.fromEntries(types.map((t) => [t, PROG_ID]));
  return [
    { key: client, values: { '': NAME } },
    { key: `${client}\\Capabilities`, values: { ApplicationName: NAME, ApplicationDescription: DESCRIPTION, ApplicationIcon: icon } },
    { key: `${client}\\Capabilities\\FileAssociations`, values: byType(FILE_TYPES) },
    { key: `${client}\\Capabilities\\StartMenu`, values: { StartMenuInternet: NAME } },
    { key: `${client}\\Capabilities\\URLAssociations`, values: byType(URL_TYPES) },
    { key: `${client}\\DefaultIcon`, values: { '': icon } },
    { key: `${client}\\shell\\open\\command`, values: { '': `"${exe}"` } },
    { key: `${root}\\RegisteredApplications`, values: { [NAME]: `${rel}\\Clients\\StartMenuInternet\\${NAME}\\Capabilities` } },
    { key: `${root}\\Classes\\${PROG_ID}`, values: { '': 'Documento de Prism' } },
    { key: `${root}\\Classes\\${PROG_ID}\\Application`, values: { ApplicationName: NAME, ApplicationDescription: DESCRIPTION, ApplicationIcon: icon, ApplicationCompany: COMPANY } },
    { key: `${root}\\Classes\\${PROG_ID}\\DefaultIcon`, values: { '': icon } },
    { key: `${root}\\Classes\\${PROG_ID}\\shell\\open\\command`, values: { '': command(exe) } },
    ...FILE_TYPES.map((t) => ({ key: `${root}\\Classes\\${t}\\OpenWithProgids`, values: { [PROG_ID]: null } })),
  ];
}

/** Lo que borra el registro: las dos claves propias enteras, y en lo que es
    compartido (la lista de aplicaciones, el "abrir con" de cada tipo) solo el
    valor de Prism. Lo mismo hace el desinstalador (build/installer.nsh). */
function removal(root = ROOT) {
  return [
    { key: `${root}\\Clients\\StartMenuInternet\\${NAME}`, drop: true },
    { key: `${root}\\Classes\\${PROG_ID}`, drop: true },
    { key: `${root}\\RegisteredApplications`, values: { [NAME]: undefined } },
    ...FILE_TYPES.map((t) => ({ key: `${root}\\Classes\\${t}\\OpenWithProgids`, values: { [PROG_ID]: undefined } })),
  ];
}

/* En un .reg, dentro de las comillas, la barra y la comilla se escapan. Un
   salto de línea no se puede escribir: no hay ninguno en lo que se registra,
   y si una ruta lo trajera, mejor fallar que escribir otra cosa. */
function quote(s) {
  const v = String(s);
  if (/[\r\n\0]/.test(v)) throw new Error('Un valor del registro no puede tener saltos de línea.');
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** [{ key, values | drop }] → el texto de un .reg (versión 5, la de UTF-16). */
function regText(entries) {
  const out = ['Windows Registry Editor Version 5.00', ''];
  for (const e of entries) {
    if (e.drop) { out.push(`[-${e.key}]`, ''); continue; }
    out.push(`[${e.key}]`);
    for (const [name, value] of Object.entries(e.values || {})) {
      const lhs = name === '' ? '@' : quote(name);
      if (value === undefined) out.push(`${lhs}=-`);
      else if (value === null) out.push(`${lhs}=hex(0):`);
      else out.push(`${lhs}=${quote(value)}`);
    }
    out.push('');
  }
  return out.join('\r\n');
}

/* ── Lo que llega por la línea de comandos ────────────────────────────────── */

/** Lo que Prism abre si se lo pasan como archivo: lo registrado y un poco más. */
const OPENABLE = /\.(html?|shtml|xht|xhtml|pdf|svg|webp|txt|xml|json)$/i;

/**
 * Las direcciones a abrir, sacadas de la línea de comandos.
 * Con `--` (así lo lanza Windows), lo que sigue son links o archivos y nada
 * más. Sin él (Prism.exe abierto a mano con un link) se ignora lo que parece
 * un switch. En la segunda instancia Chromium mete los suyos
 * (--allow-file-access-from-files) ANTES del `--`: lo de después llega entero.
 * Un archivo se vuelve file:/// con pathToFileURL: "Apuntes #3.pdf" armado
 * a mano cortaba la ruta en el #, que en una dirección es el ancla.
 */
function targetsFromArgv(argv, { cwd = process.cwd(), exists = fs.existsSync } = {}) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const dash = list.indexOf('--');
  const args = dash >= 0 ? list.slice(dash + 1) : list.slice(1).filter((a) => !a.startsWith('-'));
  const out = [];
  for (const a of args) {
    if (/^https?:\/\/[^\s/]/i.test(a)) { out.push(a); continue; }
    if (!OPENABLE.test(a)) continue;
    const file = path.resolve(cwd, a);
    if (exists(file)) out.push(pathToFileURL(file).href);
  }
  return out;
}

/** Los archivos soltados sobre la ventana: los mismos que abre por línea de
    comandos, como file:///. Solo rutas absolutas que existen; el resto se
    ignora (un .docx soltado no tiene en qué abrirse). */
function fileTargets(paths, { exists = fs.existsSync } = {}) {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const file = String(p ?? '');
    if (!file || !path.isAbsolute(file) || !OPENABLE.test(file) || !exists(file)) continue;
    out.push(pathToFileURL(file).href);
  }
  return out;
}

/* ── Con Electron ─────────────────────────────────────────────────────────── */

/* La ruta larga. Prism lanzado con la corta (C:\Users\FRANCI~1\…, como sale
   de %TEMP%) se registraba así, y la comparación con la que devuelve el
   shell decía que no era Prism aunque lo fuera. */
function longPath(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

const samePath = (a, b) => !!a && !!b && longPath(path.resolve(a)).toLowerCase() === longPath(path.resolve(b)).toLowerCase();

function createDefaultBrowser({ app, shell, exe: rawExe = process.execPath } = {}) {
  const exe = longPath(rawExe);
  const { execFile } = require('child_process');
  const os = require('os');
  const fsp = require('fs/promises');

  /* Solo Prism instalado: registrar el de desarrollo apuntaría Windows al
     electron.exe de node_modules. */
  const supported = process.platform === 'win32' && !!app?.isPackaged;
  const REG = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

  const reg = (args) => new Promise((resolve, reject) => {
    execFile(REG, args, { windowsHide: true, timeout: 15000, encoding: 'latin1' }, (err, out, stderr) => {
      if (err) reject(new Error(`reg ${args[0]}: ${String(stderr || err.message).trim()}`));
      else resolve(out);
    });
  });

  /* Un solo `reg import` escribe todo de una vez (y es un proceso, no treinta). */
  async function importText(text) {
    const file = path.join(os.tmpdir(), `prism-registro-${process.pid}-${Date.now()}.reg`);
    await fsp.writeFile(file, `\ufeff${text}\r\n`, 'utf16le');
    try { await reg(['import', file]); } finally { fsp.unlink(file).catch(() => {}); }
  }

  /* \u00bfQued\u00f3 escrito? `reg import` devuelve 0 aunque saltee una clave que no
     pudo escribir (probado con una colmena inv\u00e1lida): se lee el comando. La
     salida viene en la p\u00e1gina de c\u00f3digos de la consola, as\u00ed que no se
     compara la ruta (una tilde en la carpeta del usuario no coincidir\u00eda):
     alcanza con que est\u00e9 la parte que escribe Prism. */
  async function registered() {
    const out = await reg(['query', `${ROOT}\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve']).catch(() => '');
    return out.includes('-- "%1"');
  }

  /** Se anota como navegador. Idempotente: escribir lo mismo no cambia nada. */
  async function register() {
    if (!supported) return false;
    await importText(regText(layout(exe)));
    if (!(await registered())) throw new Error('Windows no guard\u00f3 el registro de Prism.');
    return true;
  }

  /** ¿Quién abre los links hoy? → { supported, isDefault, current } */
  async function state() {
    if (!supported) return { supported: false, isDefault: false, current: '' };
    const info = await app.getApplicationInfoForProtocol('https://example.com/').catch(() => null);
    const isDefault = samePath(info?.path, exe);
    return { supported: true, isDefault, current: isDefault ? NAME : (info?.name || '') };
  }

  /** Se registra (por si acaso) y abre la página de Prism en Aplicaciones predeterminadas. */
  async function makeDefault() {
    if (!supported) throw new Error('Solo se puede desde Prism instalado.');
    await register();
    await shell.openExternal(SETTINGS_URL);
    return state();
  }

  return { supported, register, registered, state, makeDefault };
}

module.exports = {
  NAME, PROG_ID, FILE_TYPES, URL_TYPES, SETTINGS_URL, ROOT,
  command, layout, removal, regText, targetsFromArgv, fileTargets, samePath, createDefaultBrowser,
};
