/* ═══════════════════════════════════════════════════════════════════════════
   La carpeta temporal de un humo, que se borra sola cuando el humo termina.

   Cada humo arma su perfil, sus datos y sus descargas en una carpeta propia
   de %TEMP%, y no la borraba nunca: unos 29 MB por corrida de smoke.cjs.
   Borrarla desde el mismo humo, al final, no alcanza: mientras Electron
   corre, Chromium tiene tomados los archivos del perfil, y un humo que se
   aborta, o que mata un timeout de afuera, no llega a ningún «al terminar».

   Por eso, apenas se crea, se lanza un barrendero aparte (el mismo
   electron.exe, como node) que espera a que el proceso del humo deje de
   existir —termine bien, mal o a la fuerza— y recién ahí la borra,
   reintentando mientras algún proceso hijo de Chromium la tenga tomada.
   Solo borra ESA carpeta, y solo si es una carpeta de humo de %TEMP%.
   Se suelta antes de esperar (se relanza y el primero sale): así no es
   hijo del humo, y «terminar el árbol» de un humo trabado no se lo lleva.

   PRISM_SMOKE_KEEP=1 la deja, para mirarla después de una falla.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Corre aparte: argv = [ejecutable, pid del humo, carpeta, 'suelto' en el nieto].
const BARRENDERO = `
const fs = require('fs');
const os = require('os');
const path = require('path');
if (process.argv[3] !== 'suelto') {
  require('child_process').spawn(process.execPath, ['-e', process.env.PRISM_BARRENDERO, process.argv[1], process.argv[2], 'suelto'],
    { env: process.env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}
const pid = Number(process.argv[1]);
const dir = path.resolve(process.argv[2] || '');
// Nunca otra cosa que una carpeta de humo, directo en %TEMP%.
if (!pid || path.dirname(dir) !== path.resolve(os.tmpdir()) || !/^prism-[a-z]+-[A-Za-z0-9]{6}$/.test(path.basename(dir))) process.exit(0);
const vive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const t0 = Date.now();
const borrar = (t1) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* algo sigue tomado */ }
  if (fs.existsSync(dir) && Date.now() - t1 < 60000) setTimeout(() => borrar(t1), 500);
};
const esperar = () => {
  if (!vive()) { borrar(Date.now()); return; }
  // Un humo no dura media hora: si el pid sigue vivo, ya es otro proceso con el mismo número.
  if (Date.now() - t0 < 30 * 60000) setTimeout(esperar, 500);
};
esperar();
`;

/** Crea `%TEMP%/<prefijo>XXXXXX` y deja armado quien la borra al terminar este proceso. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (process.env.PRISM_SMOKE_KEEP === '1') {
    console.log(`(la carpeta del humo queda: ${dir})`);
    return dir;
  }
  spawn(process.execPath, ['-e', BARRENDERO, String(process.pid), dir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PRISM_BARRENDERO: BARRENDERO },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  return dir;
}

module.exports = { tempDir };
