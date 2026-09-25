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
  /* Sonido de verdad para que Chromium marque la pestaña como audible, pero sin
     que se escuche: 30 Hz (debajo de lo que reproduce un parlante común) con
     ganancia 0,001 (-60 dB, arriba del umbral de silencio de Chromium). */
  '/sonido': `<title>Sonido</title><body><script>
    const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
    o.frequency.value = 30; g.gain.value = 0.001; o.connect(g).connect(c.destination); o.start();
  </script></body>`,
  /* Mide la scrollbar MIENTRAS se parsea, antes de dom-ready: si el CSS
     llegara tarde, acá todavía se vería la nativa. */
  '/larga': `<title>Larga</title><body style="margin:0"><div style="height:5000px"></div><script>
    window.__sb = innerWidth - document.documentElement.clientWidth;
  </script></body>`,
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

  console.log('\n3b. Volver a la ventana devuelve el teclado a la página');
  /* Lo que pasa cuando otra app (Moji, Alt+Tab) se lleva la ventana y la
     devuelve: Chromium le da el foco al cromo. Se simula el ida y vuelta sin
     robarle el foco real al escritorio. */
  pwc.focus();
  await until(() => pwc.isFocused());
  win.emit('blur');
  win.webContents.focus();
  await until(() => win.webContents.isFocused());
  win.emit('focus');
  ok('la página recupera el foco', await until(() => pwc.isFocused()));
  win.webContents.focus();
  win.emit('blur');
  win.emit('focus');
  await sleep(150);
  ok('y si lo tenía el cromo, queda en el cromo', win.webContents.isFocused() && !pwc.isFocused());

  console.log('\n4. El congelado: un menú sobre la página');
  await js(`document.getElementById('btn-menu').click()`);
  ok('el menú abre', await until(() => js(`!!document.querySelector('.op-menu')`)));
  ok('la foto de la página está puesta', await until(() => js(`document.getElementById('freeze').classList.contains('is-on') && !!document.getElementById('freeze').naturalWidth`)));
  ok('y la vista se corrió afuera (si no, taparía el menú)', await until(() => ctx.tabs.active.view.getBounds().x < 0));
  ok('sin sacarla de la ventana (sacarla la hacía repintar en blanco al volver)', win.contentView.children.includes(ctx.tabs.active.view));
  ok('ni cambiarle el tamaño (la página se remaquetaría)', ctx.tabs.active.view.getBounds().width === b.width);
  const menuBox = await js(`(() => { const r = document.querySelector('.op-menu').getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom }; })()`);
  ok('el menú cae adentro de la ventana', menuBox.top > 0 && menuBox.right <= 1360 && menuBox.bottom < 880, JSON.stringify(menuBox));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('Escape lo cierra', await until(() => js(`!document.querySelector('.op-menu')`)));
  ok('la vista vuelve a su lugar', await until(() => ctx.tabs.active.view.getBounds().x === b.x));
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

  console.log('\n7b. La barra grande de la nueva pestaña');
  ctx.command('tab:new');
  /* Siempre la vista VIVA: la anterior puede seguir desvaneciéndose unos
     160 ms con los mismos ids (el humo es más rápido que una mano). */
  const NTP = '.pr-view[data-page="nueva"]:not([data-state="closing"])';
  // Que el cromo ya tenga ESTA pestaña activa: el estado llega con 16 ms de
  // demora, y antes de eso la vista a mano es la de la pestaña anterior.
  await until(() => js(`__prism.S.activeId === ${ctx.tabs.active.id} && document.querySelectorAll('.pr-view[data-page="nueva"]').length === 1 && !!document.querySelector('${NTP} #ntp-input')`));
  /* Un click de mouse de verdad sobre la barra, como una persona. Con
     .focus() por script el foco de teclado seguía en la vista de la pestaña
     web anterior, y cuando Electron se lo devolvía al cromo el campo lo perdía. */
  const fb = await js(`(() => { const r = document.querySelector('${NTP} #fakebox').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  win.webContents.focus();
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(fb.x), y: Math.round(fb.y), button: 'left', clickCount: 1 });
  ok('toma el foco ella (no la de arriba)', await until(() => js(`document.activeElement.id === 'ntp-input'`)));
  await js(`(() => { const i = document.querySelector('${NTP} #ntp-input'); i.value = '127.0.0.1:${server.address().port}/dos'; i.dispatchEvent(new InputEvent('input', { inputType: 'insertText' })); })()`);
  ok('sugiere, colgando debajo de ella', await until(() => js(`(() => {
    const d = document.querySelector('.pr-suggest:not([data-state="closing"])'); const b = document.querySelector('${NTP} #fakebox');
    if (!d || !b) return false;
    const r = d.getBoundingClientRect(), a = b.getBoundingClientRect();
    return r.top >= a.bottom && Math.abs(r.left - a.left) < 2 && Math.abs(r.width - a.width) < 2; })()`)));
  ok('la de arriba queda como estaba', await js(`document.getElementById('omni-input').value === ''`));
  await js(`document.querySelector('${NTP} #ntp-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  ok('Enter navega esta misma pestaña', await until(() => ctx.tabs.active.title === 'Página dos'));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n7c. Silenciar desde el menú de la pestaña');
  ctx.tabs.create({ url: `${BASE}/sonido` });
  ok('la pestaña suena', await until(() => ctx.tabs.active.audible, 8000));
  ok('la pestaña ya no tiene botón de sonido', !(await js(`!!document.querySelector('.pr-tab__audio')`)));
  const clickMenuItem = async (text) => {
    await js(`document.querySelector('.pr-tab.is-active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))`);
    await until(() => js(`!!document.querySelector('.op-menu:not([data-state="closing"])')`));
    return js(`(() => { const b = [...document.querySelectorAll('.op-menu:not([data-state="closing"]) .op-menuitem')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
  };
  ok('el menú ofrece silenciar', await clickMenuItem('Silenciar la pestaña'));
  ok('queda silenciada de verdad', await until(() => ctx.tabs.active.muted && ctx.tabs.active.view.webContents.isAudioMuted()));
  await sleep(300);
  ok('el menú ahora ofrece activar el sonido', await clickMenuItem('Activar el sonido'));
  ok('y el sonido vuelve de verdad', await until(() => !ctx.tabs.active.muted && !ctx.tabs.active.view.webContents.isAudioMuted()));
  ok('la pestaña vuelve a sonar', await until(() => ctx.tabs.active.audible, 6000));
  await sleep(300);
  ok('y el menú vuelve a ofrecer silenciar', await clickMenuItem('Silenciar la pestaña'));
  await until(() => ctx.tabs.active.muted);
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n7d. Fijadas');
  const T = ctx.tabs;
  const tabEl = (id, expr) => js(`(() => { const el = document.querySelector('.pr-tab[data-id="${id}"]'); return el && (${expr}); })()`);
  const pa = T.create({ url: `${BASE}/` });
  const pb = T.create({ url: `${BASE}/dos` });
  await until(() => T.list.find((t) => t.id === pb)?.title === 'Página dos');
  T.pin(pb, true);
  ok('fijar la lleva a la izquierda', T.list[0].id === pb && T.list[0].pinned);
  ok('y en la tira queda angosta, solo el ícono', await until(() => tabEl(pb, `el.classList.contains('is-pinned') && Math.round(el.getBoundingClientRect().width) === 40`)));
  T.activate(pb);
  ctx.command('tab:close');
  await sleep(100);
  ok('Ctrl+W no cierra una fijada', !!T.list.find((t) => t.id === pb));
  T.move(pa, 0);
  ok('una sin fijar no se mete entre las fijadas', T.list[0].id === pb && T.list[1].id === pa);
  await T.writeSession();
  ok('la sesión recuerda cuál está fijada', (await ctx.sessionDoc.read()).tabs[0].pinned === true);

  console.log('\n7e. Dormidas');
  await ctx.saveSettings({ sleepTabs: 30 });
  await T.navigate(pa, `${BASE}/larga`);
  await until(() => T.list.find((t) => t.id === pa)?.title === 'Larga');
  const ta = T.list.find((t) => t.id === pa);
  T.activate(pa);
  await until(() => ta.shown);
  await ta.view.webContents.executeJavaScript('scrollTo(0, 1500)');
  const visitas = () => ctx.library.listVisits().filter((v) => v.url === `${BASE}/larga`).length;
  const antes = visitas();
  T.activate(pb);
  const later = Date.now() + 31 * 60 * 1000;
  ok('el barrido no duerme la activa', (await T.sweep(later)) >= 1 && !!T.active.view);
  ok('ni la fijada', !!T.list.find((t) => t.id === pb).view);
  ok('pero sí la que no mirás', !ta.view && T.snapshot().tabs.find((t) => t.id === pa).dormant);
  ok('su ícono se apaga en la tira', await until(() => tabEl(pa, `el.classList.contains('is-dormant')`)));
  T.activate(pa);
  ok('al mirarla despierta en la misma página', await until(() => ta.view && ta.title === 'Larga' && !ta.loading));
  ok('con atrás disponible', T.snapshot().tabs.find((t) => t.id === pa).canGoBack);
  ok('y el scroll donde estaba', await until(async () => (await ta.view.webContents.executeJavaScript('scrollY')) === 1500), `scrollY ${await ta.view.webContents.executeJavaScript('scrollY')}`);
  ok('despertar no suma una visita al historial', visitas() === antes);
  T.back();
  ok('y atrás vuelve a la anterior', await until(() => ta.title === 'Inicio de prueba'));
  T.pin(pb, false);
  ok('desfijar la deja primera entre las comunes', !T.list[0].pinned && T.list[0].id === pb);
  ok('y en la tira recupera su ancho', await until(() => tabEl(pb, `!el.classList.contains('is-pinned') && el.getBoundingClientRect().width > 60`)));
  T.close(pa);
  T.close(pb);

  console.log('\n8. Errores');
  ctx.tabs.create({ url: 'http://127.0.0.1:1/' });
  ok('una conexión rechazada muestra el aviso', await until(() => js(`!!document.querySelector('.pr-view[data-page="error"]')`), 8000));
  ok('y la vista no tapa el aviso', !ctx.tabs.active.view || !win.contentView.children.includes(ctx.tabs.active.view));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n8b. Scrollbars de las páginas');
  ctx.tabs.create({ url: `${BASE}/larga` });
  ok('carga la página larga', await until(() => ctx.tabs.active.title === 'Larga'));
  const sb = () => ctx.tabs.active.view.webContents.executeJavaScript('window.__sb');
  ok('la propia ya está antes de dom-ready (11 px)', (await sb()) === 11, `midió ${await sb()}`);
  await ctx.saveSettings({ pageScrollbars: false });
  ctx.tabs.reload(false);
  ok('apagada, vuelve la nativa', await until(async () => ![undefined, 11].includes(await sb())), `midió ${await sb()}`);
  await ctx.saveSettings({ pageScrollbars: true });
  ctx.tabs.reload(false);
  ok('prendida otra vez, la propia', await until(async () => (await sb()) === 11), `midió ${await sb()}`);
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
