/* ═══════════════════════════════════════════════════════════════════════════
   Importar favoritos: el JSON de Chrome, el HTML exportado y la búsqueda de
   perfiles (sobre una carpeta de mentira, no la de la persona).
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { flattenChrome, parseNetscape, chromeTime, findSources, readSource } = require('../src/bookmarks-import.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

/* 2026-01-01 en el reloj de Chrome: microsegundos desde 1601. */
const T2026 = String((Date.UTC(2026, 0, 1) + 11644473600000) * 1000);

const chrome = {
  roots: {
    bookmark_bar: { type: 'folder', children: [
      { type: 'url', name: 'UMaza', url: 'https://umaza.edu.ar/', date_added: T2026 },
      { type: 'folder', name: 'Facu', children: [
        { type: 'url', name: 'PubChem', url: 'https://pubchem.ncbi.nlm.nih.gov/' },
        { type: 'url', name: 'Bookmarklet', url: 'javascript:void(0)' },
      ] },
    ] },
    other: { type: 'folder', children: [{ type: 'url', name: 'Ajustes', url: 'chrome://settings' }, { type: 'url', name: 'Local', url: 'file:///C:/apuntes.html' }] },
    synced: { type: 'folder', children: [{ type: 'url', name: ' Del celu ', url: 'https://youtube.com/' }] },
  },
};

console.log('\n1. Chrome');
const flat = flattenChrome(chrome);
ok('aplana las carpetas en orden (la barra primero)', flat.map((b) => b.title).join('|') === 'UMaza|PubChem|Local|Del celu', flat.map((b) => b.title).join('|'));
ok('saltea bookmarklets y chrome://', !flat.some((b) => /^(javascript|chrome):/.test(b.url)));
ok('la fecha de Chrome pasa a milisegundos', flat[0].createdAt === Date.UTC(2026, 0, 1), String(flat[0].createdAt));
ok('sin fecha, null', flat[1].createdAt === null);
ok('una fecha basura no rompe', chromeTime('abc') === null && chromeTime('0') === null);
ok('un JSON vacío da nada', flattenChrome({}).length === 0 && flattenChrome(null).length === 0);

console.log('\n2. HTML exportado');
const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Barra</H3>
  <DL><p>
    <DT><A HREF="https://umaza.edu.ar/?a=1&amp;b=2" ADD_DATE="1767225600" ICON="data:image/png;base64,xx">UMaza &amp; cía</A>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><a href='https://es.wikipedia.org/wiki/Paracetamol'>Paracetamol &#8212; <b>Wiki</b></a>
  </DL><p>
</DL>`;
const net = parseNetscape(html);
ok('encuentra los visitables', net.length === 2, String(net.length));
ok('decodifica la dirección', net[0].url === 'https://umaza.edu.ar/?a=1&b=2', net[0].url);
ok('decodifica el título', net[0].title === 'UMaza & cía', net[0].title);
ok('ADD_DATE en segundos pasa a milisegundos', net[0].createdAt === 1767225600000);
ok('comillas simples, entidades numéricas y etiquetas adentro', net[1].title === 'Paracetamol — Wiki', net[1].title);

console.log('\n3. Perfiles');
const root = await mkdtemp(join(tmpdir(), 'prism-import-'));
try {
  const ud = join(root, 'Google', 'Chrome', 'User Data');
  await mkdir(join(ud, 'Default'), { recursive: true });
  await mkdir(join(ud, 'Profile 1'), { recursive: true });
  await mkdir(join(ud, 'Vacío'), { recursive: true });
  await writeFile(join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Fran' } } } }));
  await writeFile(join(ud, 'Default', 'Bookmarks'), JSON.stringify(chrome));
  await writeFile(join(ud, 'Profile 1', 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'x', url: 'https://x.com/' }] } } }));
  await writeFile(join(ud, 'Vacío', 'Bookmarks'), JSON.stringify({ roots: {} }));

  const src = await findSources(root);
  ok('encuentra los perfiles con favoritos', src.length === 2, JSON.stringify(src));
  const def = src.find((s) => s.id === 'chrome/Default');
  ok('con el nombre de Local State', def?.profile === 'Fran' && def?.browser === 'Chrome' && def?.count === 4, JSON.stringify(def));
  ok('sin nombre, el de la carpeta', src.find((s) => s.id === 'chrome/Profile 1')?.profile === 'Profile 1');
  ok('sin LOCALAPPDATA, nada', (await findSources('')).length === 0);
  ok('lee una fuente por su id', (await readSource('chrome/Default', root)).length === 4);
  let threw = 0;
  for (const bad of ['chrome/..', 'chrome/../..', 'chrome/a\\..\\b', 'opera/Default', 'chrome']) {
    await readSource(bad, root).then(() => {}, () => { threw += 1; });
  }
  ok('no sale de la carpeta del navegador', threw === 5, String(threw));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
