/* ═══════════════════════════════════════════════════════════════════════════
   Humo: levanta Prism de verdad (main.cjs entero, fuera de pantalla y con un
   perfil descartable) y lo recorre contra un servidor local — sin internet.

     npm run smoke

   La regla que lo guía, heredada de Opal: medí dónde CAE una cosa, no solo si
   existe. Que la vista de la página esté "en la ventana" no alcanza: tiene
   que estar exactamente sobre el rectángulo de #page, o el sitio se dibuja
   corrido y tapa la barra.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-smoke-'));
const DL = path.join(TMP, 'descargas');
fs.mkdirSync(DL, { recursive: true });
process.env.PRISM_SHOTS = '1';
process.env.PRISM_PROFILE = path.join(TMP, 'perfil');
process.env.PRISM_DATA = path.join(TMP, 'datos');
process.env.PRISM_TRAY = '1';   // la bandeja existe unos segundos, para probarla
// Ajustes de arranque: nada de red (sin sugerencias remotas ni listas del bloqueador).
fs.mkdirSync(process.env.PRISM_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.PRISM_DATA, 'settings.json'), JSON.stringify({
  schema: 1, remoteSuggest: false, adblock: false, startup: 'newtab', downloadDir: DL,
}));

const { app } = require('electron');
const { ctx } = require(path.join(__dirname, '..', 'main.cjs'));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); return; }
  fail++;
  // Con la falla va la foto de la pestaña: casi siempre explica el porqué.
  const t = ctx?.tabs?.active;
  const d = t && { id: t.id, url: t.url, title: t.title, internal: t.internal, view: !!t.view, shown: t.shown, error: t.error, attached: !!(t.view && ctx.win.contentView.children.includes(t.view)) };
  console.log(`  FALLA ${n} ${x}
        ${JSON.stringify(d)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
setTimeout(() => bail('timeout de 90s'), 90000);

/** Espera a que algo sea verdad (o se rinde y devuelve false). */
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch { /* todavía no */ }
    await sleep(60);
  }
  return false;
}

/* ── Un sitio de mentira ─────────────────────────────────────────────────── */
const PAGES = {
  '/': '<title>Inicio de prueba</title><body style="font:16px sans-serif"><h1>Hola Prism</h1><p>fiebre fiebre fiebre</p><a id="l" href="/dos">dos</a></body>',
  '/dos': '<title>Página dos</title><body><h1>Dos</h1></body>',
  '/geo': '<title>Geo</title><body><script>navigator.geolocation.getCurrentPosition(()=>{},()=>{})</script></body>',
};
const server = http.createServer((req, res) => {
  if (req.url === '/archivo.bin') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="archivo.bin"' });
    return res.end(Buffer.alloc(64 * 1024, 7));
  }
  const body = PAGES[req.url];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body || 'no');
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  ok('la ventana aparece', await until(() => ctx.win && ctx.tabs, 8000));
  const win = ctx.win;
  const js = (c) => win.webContents.executeJavaScript(c);
  await until(() => js(`!document.getElementById('boot-splash') && !!window.__prism`), 8000);
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 3 || e.level === 'error') errores.push(e.message); });

  console.log('\n1. Arranque');
  ok('el splash se fue', await js(`!document.getElementById('boot-splash')`));
  ok('los <i data-icon> se reemplazaron', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('arranca con una nueva pestaña', ctx.tabs.list.length === 1 && ctx.tabs.active.internal === 'nueva');
  ok('la nueva pestaña se dibuja', await until(() => js(`!!document.querySelector('.pr-view[data-page="nueva"] .pr-fakebox')`)));
  ok('no hay emojis ni glifos en el cromo', !(await js(`/[\\u2190-\\u21ff\\u2600-\\u27bf\\u{1F300}-\\u{1FAFF}]/u.test(document.body.innerText)`)));

  console.log('\n2. Navegar desde la omnibox');
  await js(`window.prism.tabs.navigate(null, '${BASE}/')`);
  ok('la pestaña pasa a ser web', await until(() => ctx.tabs.active.view && !ctx.tabs.active.internal));
  ok('carga y toma el título', await until(() => ctx.tabs.active.title === 'Inicio de prueba'));
  ok('la vista está en la ventana', await until(() => win.contentView.children.includes(ctx.tabs.active.view)));
  const rect = await js(`(() => { const r = document.getElementById('page').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const b = ctx.tabs.active.view.getBounds();
  ok('la vista cae EXACTAMENTE sobre #page', Math.abs(b.x - rect.x) <= 1 && Math.abs(b.y - rect.y) <= 1 && Math.abs(b.width - rect.w) <= 1 && Math.abs(b.height - rect.h) <= 1,
    `vista ${JSON.stringify(b)} vs page ${JSON.stringify(rect)}`);
  ok('la omnibox muestra el host partido', await until(() => js(`document.getElementById('omni-display').querySelector('b')?.textContent === '127.0.0.1:${server.address().port}'`)));
  ok('se registró en el historial', ctx.library.listVisits().some((v) => v.url === `${BASE}/`));

  console.log('\n3. Atrás / adelante');
  /* Un click de mouse DE VERDAD sobre el link. Con .click() por script no hay
     gesto de usuario, y Chromium marca la entrada anterior como "salteable":
     Atrás la saltea (así se defiende de las páginas que llenan el historial
     solas). Es el comportamiento correcto; el test tiene que clickear como
     una persona. */
  const pwc = ctx.tabs.active.view.webContents;
  const lr = await pwc.executeJavaScript(`(() => { const r = document.getElementById('l').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  pwc.focus();
  for (const type of ['mouseDown', 'mouseUp']) pwc.sendInputEvent({ type, x: Math.round(lr.x), y: Math.round(lr.y), button: 'left', clickCount: 1 });
  ok('sigue el link', await until(() => ctx.tabs.active.title === 'Página dos'));
  ok('el botón atrás se habilita', await until(() => js(`!document.getElementById('btn-back').disabled`)));
  ctx.tabs.back();
  ok('vuelve', await until(() => ctx.tabs.active.title === 'Inicio de prueba'));
  ok('y adelante se habilita', await until(() => js(`!document.getElementById('btn-forward').disabled`)));

  console.log('\n4. El congelado: un menú sobre la página');
  await js(`document.getElementById('btn-menu').click()`);
  ok('el menú abre', await until(() => js(`!!document.querySelector('.op-menu')`)));
  ok('la foto de la página está puesta', await until(() => js(`document.getElementById('freeze').classList.contains('is-on') && !!document.getElementById('freeze').naturalWidth`)));
  ok('y la vista se retiró (si no, taparía el menú)', await until(() => !win.contentView.children.includes(ctx.tabs.active.view)));
  const menuBox = await js(`(() => { const r = document.querySelector('.op-menu').getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom }; })()`);
  ok('el menú cae adentro de la ventana', menuBox.top > 0 && menuBox.right <= 1360 && menuBox.bottom < 880, JSON.stringify(menuBox));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('Escape lo cierra', await until(() => js(`!document.querySelector('.op-menu')`)));
  ok('la vista vuelve', await until(() => win.contentView.children.includes(ctx.tabs.active.view)));
  ok('y la foto se va', await until(() => js(`!document.getElementById('freeze').classList.contains('is-on')`)));

  console.log('\n5. Buscar en la página');
  ctx.command('find:open');
  ok('la barra de búsqueda entra', await until(() => js(`document.getElementById('find').classList.contains('is-open')`)));
  await js(`(() => { const i = document.getElementById('find-input'); i.value = 'fiebre'; i.dispatchEvent(new Event('input')); })()`);
  ok('cuenta las coincidencias', await until(() => js(`document.getElementById('find-count').textContent.endsWith('/3')`)), await js(`document.getElementById('find-count').textContent`));
  await js(`document.getElementById('find-next').click()`);
  ok('siguiente avanza', await until(() => js(`document.getElementById('find-count').textContent === '2/3'`)), await js(`document.getElementById('find-count').textContent`));
  await js(`document.getElementById('find-close').click()`);

  console.log('\n6. Favoritos');
  await js(`document.getElementById('omni-star').click()`);
  ok('la estrella lo guarda', await until(() => ctx.library.isBookmarked(`${BASE}/`)));
  ok('y se enciende', await until(() => js(`document.getElementById('omni-star').classList.contains('is-on')`)));

  console.log('\n7. Pestañas');
  ctx.command('tab:new');
  ok('Ctrl+T abre una nueva', await until(() => ctx.tabs.list.length === 2 && ctx.tabs.active.internal === 'nueva'));
  ok('la tira dibuja dos', await until(() => js(`document.querySelectorAll('.pr-tab:not([data-state="closing"])').length === 2`)));
  ok('la omnibox toma el foco', await until(() => js(`document.activeElement.id === 'omni-input'`)));
  ok('la nueva pestaña muestra el favorito', await until(() => js(`!!document.querySelector('.pr-tile[data-kind="bookmark"]')`)));
  const x2 = await js(`getComputedStyle(document.querySelectorAll('.pr-tab')[1]).getPropertyValue('--x')`);
  ok('la segunda pestaña va a la derecha de la primera', parseFloat(x2) > 100, x2);
  ctx.command('tab:close');
  ok('Ctrl+W la cierra', await until(() => ctx.tabs.list.length === 1));
  ctx.command('tab:reopen');
  ok('Ctrl+Mayús+T no reabre una nueva pestaña vacía', await until(() => ctx.tabs.list.length === 1, 800));

  console.log('\n8. Errores');
  ctx.tabs.create({ url: 'http://127.0.0.1:1/' });
  ok('una conexión rechazada muestra el aviso', await until(() => js(`!!document.querySelector('.pr-view[data-page="error"]')`), 8000));
  ok('y la vista no tapa el aviso', !ctx.tabs.active.view || !win.contentView.children.includes(ctx.tabs.active.view));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n9. Descargas');
  ctx.tabs.contextAction('link-save', { url: `${BASE}/archivo.bin` });
  ok('baja el archivo a la carpeta elegida', await until(() => fs.existsSync(path.join(DL, 'archivo.bin')) && ctx.downloads.list()[0]?.state === 'completed', 8000));
  ok('el panel lo lista', await until(() => js(`__prism.S.downloads.some(d => d.filename === 'archivo.bin')`)));

  console.log('\n10. Permisos');
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/geo`);
  ok('pregunta antes de dar la ubicación', await until(() => js(`!!document.querySelector('.op-modal .pr-ask')`), 8000));
  await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].find(b => b.textContent.includes('Bloquear')).click()`);
  ok('y recuerda el "no"', await until(() => ctx.settings.permissions?.[BASE]?.geolocation === 'deny'));
  ok('el velo se va', await until(() => js(`!document.querySelector('.op-scrim')`)));

  console.log('\n11. Páginas propias');
  for (const p of ['historial', 'favoritos', 'descargas', 'ajustes']) {
    ctx.tabs.openInternal(p);
    ok(`prism://${p} se dibuja`, await until(() => js(`!!document.querySelector('.pr-view[data-page="${p}"] .pr-head__title')`)));
    if (p === 'historial') ok('el historial lista lo visitado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="historial"] .pr-row').length >= 2`)));
    if (p === 'favoritos') ok('los favoritos listan el guardado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="favoritos"] .pr-row').length === 1`)));
  }

  console.log('\n12. Bandeja e instancia única');
  win.close();
  ok('cerrar esconde la ventana en vez de salir', await until(() => !win.isDestroyed() && !win.isVisible()));
  ok('las pestañas siguen vivas', ctx.tabs.list.length > 0);
  app.emit('second-instance', {}, [process.execPath]);
  ok('abrir Prism otra vez la trae de vuelta', await until(() => win.isVisible()));
  ok('y le suma una pestaña nueva', await until(() => ctx.tabs.active.internal === 'nueva'));

  console.log('\n13. Actualizaciones');
  ctx.send('update:state', { phase: 'available', version: '9.9.9', name: 'Prism 9.9.9', bytes: 1e8, pct: 0 });
  ok('el menú muestra un punto', await until(() => js(`document.getElementById('btn-menu').classList.contains('has-update')`)));
  await js(`document.getElementById('btn-menu').click()`);
  ok('y ofrece descargarla arriba de todo', await until(() => js(`!!document.querySelector('.op-menu .op-menuitem')?.textContent.includes('9.9.9')`)));
  ok('con "Salir de Prism" al final', await js(`[...document.querySelectorAll('.op-menu .op-menuitem')].pop().textContent.includes('Salir de Prism')`));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('la statusbar lo avisa', await until(() => js(`document.getElementById('status-left').textContent.includes('9.9.9')`)));

  console.log('\n14. Sin errores en la consola del cromo');
  ok('ninguno', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  server.close();
  app.exit(fail ? 1 : 0);
});
