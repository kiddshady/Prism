/* ═══════════════════════════════════════════════════════════════════════════
   El bloqueador sin red, con listas caídas y con el caché vencido. Corre en
   Electron (Ghostery lo necesita) pero no toca internet: la red es de
   mentira, y lo que se bloquea se mide en un servidor local, contando qué
   pedidos le llegaron. `npm run smoke` lo corre después del humo.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-adblock-'));
const { app, session, BrowserWindow } = require('electron');
app.setPath('userData', path.join(TMP, 'perfil'));
const { createAdblock } = require(path.join(__dirname, '..', 'src', 'adblock.cjs'));
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
setTimeout(() => bail('timeout de 60s'), 60000);
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* todavía no */ } await sleep(50); }
  return false;
}

/* ── La red de mentira ───────────────────────────────────────────────────── */
let red = 'sin';   // sin · ok · 429 · nueva
let pedidosALaRed = 0;
async function fakeFetch(url) {
  pedidosALaRed++;
  if (red === 'sin') throw new Error('net::ERR_INTERNET_DISCONNECTED');
  if (url.endsWith('resources.json')) return new Response('{"redirects":[],"scriptlets":[]}');
  if (red === '429' && url.endsWith('easyprivacy.txt')) return new Response('429: Too Many Requests', { status: 429 });
  if (url.endsWith('/easylist.txt')) return new Response(red === 'nueva' ? '/nuevo/\n' : '/ads/\n');
  return new Response('! vacía\n');
}

/* ── El sitio: una página que pide tres cosas ────────────────────────────── */
const hits = new Set();
const server = http.createServer((req, res) => {
  hits.add(req.url);
  res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'text/javascript' });
  res.end(req.url === '/' ? `<script>Promise.allSettled(['/ads/x.js', '/nuevo/x.js', '/viejo/x.js', '/ok.js'].map((u) => fetch(u))).then(() => { document.title = 'listo'; });</script>` : '');
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const web = session.fromPartition('adblock-prueba');
  const cacheFile = path.join(TMP, 'adblock-engine.bin');
  const ctx = { web, settings: { adblock: true, adblockAllow: [] } };
  const ab = createAdblock(ctx, { cacheFile, fetch: fakeFetch, retry: [400] });
  const win = new BrowserWindow({ show: false, webPreferences: { session: web } });
  /** Lo que de verdad le llegó al servidor desde la página. */
  async function llegaron() {
    hits.clear();
    await win.loadURL(`${BASE}/`);
    await until(() => win.webContents.getTitle() === 'listo');
    return ['/ads/x.js', '/nuevo/x.js', '/viejo/x.js', '/ok.js'].filter((u) => hits.has(u)).map((u) => u.split('/')[1].replace('.js', ''));
  }

  console.log('\n1. Arrancar sin red y sin caché');
  ok('load no tira: avisa que no pudo', (await ab.load()) === false);
  ok('sin motor, y con el porqué', !ab.ready && /DISCONNECTED/.test(ab.error || ''), ab.error);
  ok('no deja un caché a medias', !fs.existsSync(cacheFile));
  red = 'ok';
  ok('cuando vuelve la red, se reintenta solo', await until(() => ab.ready, 5000));
  ok('y guarda el caché', fs.existsSync(cacheFile) && !ab.error);
  let llego = await llegaron();
  ok('bloquea lo de la lista y deja pasar lo demás', !llego.includes('ads') && llego.includes('ok'), llego.join());

  console.log('\n2. Una lista que contesta 429');
  red = '429';
  const antes = fs.readFileSync(cacheFile);
  ok('la renovación falla entera', (await ab.refresh()) === false && /429/.test(ab.error || ''), ab.error);
  ok('el caché queda como estaba', fs.readFileSync(cacheFile).equals(antes));
  llego = await llegaron();
  ok('y el motor de antes sigue bloqueando', !llego.includes('ads') && llego.includes('ok'), llego.join());

  console.log('\n3. Listas nuevas con Prism abierto');
  red = 'nueva';
  ok('la renovación anda', (await ab.refresh()) === true && !ab.error);
  llego = await llegaron();
  ok('el motor nuevo entra sin reiniciar', !llego.includes('nuevo') && llego.includes('ads') && llego.includes('ok'), llego.join());

  console.log('\n4. Caché vencido y sin red al arrancar');
  const viejo = ElectronBlocker.parse('/viejo/\n');
  fs.writeFileSync(cacheFile, viejo.serialize());
  const ochoDias = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(cacheFile, ochoDias, ochoDias);
  red = 'sin';
  const pedidos = pedidosALaRed;
  ok('load intenta renovar y no puede', (await ab.load()) === false && pedidosALaRed > pedidos);
  ok('pero el caché vencido no se borra', fs.existsSync(cacheFile));
  llego = await llegaron();
  ok('y bloquea con él mientras tanto', ab.ready && !llego.includes('viejo') && llego.includes('ok'), llego.join());

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  server.close();
  app.exit(fail ? 1 : 0);
});
