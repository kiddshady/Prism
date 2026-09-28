/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — copiar pdf.js a la interfaz
   La vista previa de impresión (renderer/js/print.js) dibuja las hojas con
   pdf.js. La interfaz se carga desde disco y no ve node_modules, así que los
   dos archivos que usa viajan copiados en renderer/vendor/pdfjs, con su
   licencia. Va la versión "legacy": la normal usa Map.getOrInsertComputed,
   que el Chromium 144 de Electron 40 todavía no trae. Para actualizarlo:

     npm install -D pdfjs-dist@<versión>
     node tools/vendor-pdfjs.mjs
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'pdfjs');

const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of [['legacy/build/pdf.min.mjs', 'pdf.min.mjs'], ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'], ['LICENSE', 'LICENSE']]) {
  fs.copyFileSync(path.join(SRC, from), path.join(OUT, to));
}
fs.writeFileSync(path.join(OUT, 'VERSION'), `${version}\n`);
console.log(`pdf.js ${version} → renderer/vendor/pdfjs`);
