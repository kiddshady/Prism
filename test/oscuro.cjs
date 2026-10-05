/* ═══════════════════════════════════════════════════════════════════════════
   "Oscurecer todo": Prism con el ajuste prendido desde el arranque (es un
   switch de Chromium: no se puede prender a mitad de una corrida, por eso no
   está en el humo). Fuera de pantalla y con un perfil descartable, como el
   humo; `npm run smoke` corre los dos.

   Lo que se mide, en píxeles de capturePage:
     · una página blanca sin modo oscuro sale oscura;
     · una que tiene modo oscuro propio queda como la hizo su sitio;
     · el cromo y las vistas propias quedan afuera (declaran color-scheme);
     · la hoja de la vista previa de impresión sigue blanca: lo que se
       imprime no se oscurece.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const http = require('http');

const { tempDir } = require('./temporal.cjs');

// Se borra sola cuando el humo termina, aunque se aborte (temporal.cjs).
const TMP = tempDir('prism-oscuro-');
process.env.PRISM_SHOTS = '1';
process.env.PRISM_PROFILE = path.join(TMP, 'perfil');
process.env.PRISM_DATA = path.join(TMP, 'datos');
fs.mkdirSync(process.env.PRISM_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.PRISM_DATA, 'settings.json'), JSON.stringify({
  schema: 1, remoteSuggest: false, adblock: false, startup: 'newtab', forceDark: true,
}));

const { app, webContents } = require('electron');
const { ctx } = require(path.join(__dirname, '..', 'main.cjs'));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
setTimeout(() => bail('timeout de 60s'), 60000);
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* todavía no */ }
    await sleep(60);
  }
  return null;
}
/** El color de un píxel (x, y en CSS) de lo que pinta un webContents. */
async function pixel(wc, x, y) {
  const b = (await wc.capturePage({ x, y, width: 1, height: 1 })).toBitmap();
  return [b[2], b[1], b[0]];
}
const luz = ([r, g, b]) => Math.round((r + g + b) / 3);

const PAGES = {
  '/blanca': '<title>Blanca</title><body style="margin:0"><h1 style="margin:40px">Una página sin modo oscuro</h1></body>',
  '/propia': `<title>Propia</title><style>body{margin:0;background:#fff}@media (prefers-color-scheme: dark){body{background:rgb(32,33,36)}}</style><body></body>`,
};
const server = http.createServer((req, res) => {
  const body = PAGES[req.url];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body || 'no');
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  ok('la ventana aparece', !!(await until(() => ctx.win && ctx.tabs, 8000)));
  const js = (c) => ctx.win.webContents.executeJavaScript(c);
  await until(() => js(`!document.getElementById('boot-splash') && !!window.__prism`), 8000);

  console.log('\n1. Las páginas');
  ok('el switch de Blink está puesto', app.commandLine.getSwitchValue('blink-settings').includes('forceDarkModeEnabled=true'));
  ctx.tabs.create({ url: `${BASE}/blanca` });
  await until(() => ctx.tabs.active.title === 'Blanca' && !ctx.tabs.active.loading);
  const pwc = ctx.tabs.active.view.webContents;
  await sleep(400);
  const fondo = await until(async () => { const p = await pixel(pwc, 5, 5); return luz(p) < 40 && p; });
  ok('una página blanca sin modo oscuro sale oscura', !!fondo, String(await pixel(pwc, 5, 5)));
  ctx.tabs.create({ url: `${BASE}/propia` });
  await until(() => ctx.tabs.active.title === 'Propia' && !ctx.tabs.active.loading);
  await sleep(400);
  const propia = await pixel(ctx.tabs.active.view.webContents, 5, 5);
  ok('una con modo oscuro propio queda con sus colores', propia.join() === '32,33,36', propia.join());

  console.log('\n2. Lo de Prism queda afuera');
  const vistas = webContents.getAllWebContents().filter((w) => w.getURL().startsWith('prism-ui://'));
  const esquemas = await Promise.all(vistas.map((w) => w.executeJavaScript('getComputedStyle(document.documentElement).colorScheme')));
  ok('el cromo y sus vistas declaran color-scheme: dark', vistas.length >= 1 && esquemas.every((s) => s === 'dark'), esquemas.join());
  // Un cuadrado blanco en el cromo: oscurecido a la fuerza, saldría gris.
  await js(`(() => { const d = document.createElement('div'); d.id = 'blanco-de-prueba'; d.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;background:#fff;z-index:2147483647'; document.body.append(d); return true; })()`);
  await sleep(300);
  const blanco = await pixel(ctx.win.webContents, 12, 12);
  await js(`document.getElementById('blanco-de-prueba').remove(); true`);
  ok('lo blanco del cromo sigue blanco', luz(blanco) > 250, blanco.join());

  console.log('\n3. Imprimir');
  ctx.tabs.activate(ctx.tabs.list.find((t) => t.title === 'Blanca').id);
  await sleep(300);
  await js(`import('./js/print.js').then((m) => { m.openPrint(); return true; })`);
  ok('la vista previa dibuja la hoja', !!(await until(() => js(`!!document.querySelector('.pr-sheet.is-drawn')`), 15000)));
  // Una esquina del papel: el canvas donde pdf.js dibuja la hoja, en su margen.
  const hoja = await js(`(() => { const r = document.querySelector('.pr-sheet.is-drawn canvas').getBoundingClientRect(); return { x: Math.round(r.right - 8), y: Math.round(r.bottom - 8) }; })()`);
  await sleep(400);
  const papel = await pixel(ctx.win.webContents, hoja.x, hoja.y);
  ok('la hoja sigue blanca: lo impreso no se oscurece', luz(papel) > 240, papel.join());

  console.log('\n4. Un PDF');
  ctx.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(500);
  const pdf = path.join(TMP, 'hoja.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  ctx.tabs.create({ url: require('url').pathToFileURL(pdf).href });
  ok('se abre en el visor', !!(await until(() => ctx.tabs.active.url.endsWith('hoja.pdf') && !ctx.tabs.active.loading, 10000)));
  const vwc = ctx.tabs.active.view.webContents;
  const [w, h] = (() => { const b = ctx.tabs.active.view.getBounds(); return [b.width, b.height]; })();
  // La hoja va centrada: el medio de la vista cae sobre el papel.
  const hojaPdf = await until(async () => { const p = await pixel(vwc, Math.round(w / 2), Math.round(h / 2)); return luz(p) > 240 && p; }, 10000);
  ok('el papel del PDF sigue blanco', !!hojaPdf, String(await pixel(vwc, Math.round(w / 2), Math.round(h / 2))));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  server.close();
  app.exit(fail ? 1 : 0);
});
