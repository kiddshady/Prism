/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — copiar xterm.js a la interfaz
   La terminal (renderer/js/terminal.js) dibuja con xterm.js. La interfaz se
   carga desde disco y no ve node_modules, así que lo que usa viaja copiado en
   renderer/vendor/xterm, con su licencia: el módulo ES de cada paquete (no
   importan nada de afuera) y la hoja base. Para actualizarlo:

     npm install -D @xterm/xterm@<versión> @xterm/addon-fit@<versión> …
     node tools/vendor-xterm.mjs
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'node_modules', '@xterm');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'xterm');

const PACKAGES = [
  ['xterm', 'lib/xterm.mjs', 'xterm.mjs'],
  ['addon-fit', 'lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['addon-unicode11', 'lib/addon-unicode11.mjs', 'addon-unicode11.mjs'],
  ['addon-web-links', 'lib/addon-web-links.mjs', 'addon-web-links.mjs'],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const versions = [];
for (const [pkg, from, to] of PACKAGES) {
  const dir = path.join(MODS, pkg);
  // Sin el comentario del source map: el .map no viaja y la consola lo pediría.
  const code = fs.readFileSync(path.join(dir, from), 'utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
  fs.writeFileSync(path.join(OUT, to), code);
  versions.push(`@xterm/${pkg} ${JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version}`);
}
fs.copyFileSync(path.join(MODS, 'xterm', 'css', 'xterm.css'), path.join(OUT, 'xterm.css'));
fs.copyFileSync(path.join(MODS, 'xterm', 'LICENSE'), path.join(OUT, 'LICENSE'));
fs.writeFileSync(path.join(OUT, 'VERSION'), `${versions.join('\n')}\n`);
console.log(`${versions.join(' · ')} → renderer/vendor/xterm`);
