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
// Cámara y micrófono de mentira de Chromium: la videollamada se prueba sin tocar los de verdad.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
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
  '/login': '<title>Login</title><body><form action="/bienvenida" method="post"><input id="u" name="usuario" autocomplete="username"><input id="p" type="password" name="clave"><button id="b">Entrar</button></form></body>',
  '/bienvenida': '<title>Bienvenida</title><body><h1>Adentro</h1></body>',
  '/geo': '<title>Geo</title><body><script>navigator.geolocation.getCurrentPosition(()=>{},()=>{})</script></body>',
  /* Lo que hace una videollamada al entrar: mira el permiso, pide cámara y
     micrófono, y lista los dispositivos. */
  '/llamada': `<title>Llamada</title><body><script>
    const q = async (name) => (await navigator.permissions.query({ name })).state;
    const nombres = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind !== 'audiooutput').every((d) => d.label);
    (async () => {
      const r = { antes: await q('camera'), noti: Notification.permission };
      try { r.pistas = (await navigator.mediaDevices.getUserMedia({ video: true, audio: true })).getTracks().map((t) => t.kind + ':' + t.readyState).sort().join(); }
      catch (e) { r.pistas = e.name; }
      r.despues = await q('camera');
      r.nombres = await nombres();
      window.__r = r;
    })();
  </script></body>`,
  /* Sonido de verdad para que Chromium marque la pestaña como audible, pero sin
     que se escuche: 30 Hz (debajo de lo que reproduce un parlante común) con
     ganancia 0,001 (-60 dB, arriba del umbral de silencio de Chromium). */
  '/sonido': `<title>Sonido</title><body><script>
    const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
    o.frequency.value = 30; g.gain.value = 0.001; o.connect(g).connect(c.destination); o.start();
  </script></body>`,
  /* Mide la scrollbar MIENTRAS se parsea, antes de dom-ready: si el CSS
     llegara tarde, acá todavía se vería la nativa. */
  '/negra': '<title>Negra</title><style>html{background:#000}body{margin:0}#app{background:rgb(12,16,20);min-height:4000px}</style><div id="app"></div>',
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

  console.log('\n2b. La statusbar al pasar de un link a otro');
  ctx.send('page:hover', `${BASE}/uno`);
  await until(() => js(`document.querySelectorAll('#status-left .pr-status__msg').length === 1`));
  await sleep(300);
  /* Mientras el viejo se va y el nuevo llega, los dos en el MISMO lugar
     (antes el nuevo entraba al lado y la barra se veía larguísima). */
  const posiciones = js(`new Promise((res) => {
    const xs = new Set(); let dos = false; const t0 = performance.now();
    const tick = () => {
      const ms = [...document.querySelectorAll('#status-left .pr-status__msg')];
      if (ms.length > 1) dos = true;
      ms.forEach((m) => xs.add(Math.round(m.getBoundingClientRect().left)));
      if (performance.now() - t0 < 350) requestAnimationFrame(tick); else res({ xs: [...xs], dos });
    };
    requestAnimationFrame(tick);
  })`);
  ctx.send('page:hover', `${BASE}/dos`);
  const pos = await posiciones;
  ok('el aviso viejo y el nuevo se cruzan en el mismo lugar, no uno al lado del otro', pos.dos && pos.xs.length === 1, JSON.stringify(pos));
  ctx.send('page:hover', `${BASE}/${'larguisimo/'.repeat(60)}`);
  await sleep(400);
  const anchos = await js(`(() => { const l = document.getElementById('status-left').getBoundingClientRect(); const m = [...document.querySelectorAll('#status-left .pr-status__msg')].pop().getBoundingClientRect(); return { l: Math.round(l.right), m: Math.round(m.right) }; })()`);
  ok('un link larguísimo se recorta y no estira la barra', anchos.m <= anchos.l, JSON.stringify(anchos));
  ctx.send('page:hover', '');

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

  console.log('\n7b2. Sugerencias sin historial');
  const sugg = (q) => js(`window.prism.omni.suggest(${JSON.stringify(q)})`);
  let sg = await sugg('dos');
  ok('con el historial, sugiere la página visitada', sg.items.some((i) => i.kind === 'history' && i.url.endsWith('/dos')), JSON.stringify(sg.items));
  await ctx.saveSettings({ historySuggest: false });
  sg = await sugg('dos');
  ok('apagado, la visitada ya no aparece', sg.items.length === 0, JSON.stringify(sg.items));
  sg = await sugg('127.0');
  ok('pero el favorito sí', sg.items.length === 1 && sg.items[0].kind === 'bookmark' && sg.items[0].url === `${BASE}/`, JSON.stringify(sg.items));
  await js(`(() => { const i = document.getElementById('omni-input'); i.focus(); i.value = 'dos'; i.dispatchEvent(new InputEvent('input', { inputType: 'insertText' })); })()`);
  await until(() => js(`!!document.querySelector('.pr-suggest:not([data-state="closing"])')`));
  await sleep(150);
  ok('y la barra no la muestra', await js(`![...document.querySelectorAll('.pr-suggest:not([data-state="closing"]) .pr-sugg')].some((b) => b.textContent.includes('Página dos'))`));
  await js(`(() => { const i = document.getElementById('omni-input'); i.value = ''; i.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' })); i.blur(); })()`);
  await ctx.saveSettings({ historySuggest: true });
  sg = await sugg('dos');
  ok('prendido otra vez, vuelve', sg.items.some((i) => i.kind === 'history'), JSON.stringify(sg.items));

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

  console.log('\n7f. Vista dividida');
  const paneRect = (slot) => js(`(() => { const r = document.querySelector('.pr-pane[data-slot="${slot}"]').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const same = (v, r) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(v[k] - r[k]) <= 1);
  const sx = T.create({ url: `${BASE}/` });
  const tx = T.list.find((t) => t.id === sx);
  await until(() => tx.title === 'Inicio de prueba' && tx.shown);
  const full = tx.view.getBounds();
  const sn = T.split(sx);
  const tn = T.list.find((t) => t.id === sn);
  ok('dividir arma el par con una pestaña nueva a la derecha', T.snapshot().split?.a === sx && T.snapshot().split?.b === sn && T.list[T.list.indexOf(tx) + 1] === tn);
  ok('y la nueva pasa a ser la activa', T.active.id === sn);
  ok('la hoja se parte en dos', await until(() => js(`document.getElementById('page').classList.contains('is-split')`)));
  ok('la derecha dibuja la nueva pestaña', await until(() => js(`!!document.querySelector('#internal-2 .pr-view[data-page="nueva"]')`)));
  ok('la izquierda sigue viendo su página', win.contentView.children.includes(tx.view));
  ok('la vista izquierda cae EXACTAMENTE sobre su hoja', await until(async () => same(tx.view.getBounds(), await paneRect(0))), `${JSON.stringify(tx.view.getBounds())} vs ${JSON.stringify(await paneRect(0))}`);
  ok('y mide la mitad (menos el aire del medio)', tx.view.getBounds().width === Math.round((full.width - 8) / 2));
  ok('en la tira van unidas', await until(() => tabEl(sx, `el.classList.contains('is-split-a')`) && tabEl(sn, `el.classList.contains('is-split-b')`)));
  await T.navigate(sn, `${BASE}/dos`);
  ok('la derecha navega a una web', await until(() => tn.title === 'Página dos' && win.contentView.children.includes(tn.view)));
  ok('las dos vistas en la ventana a la vez', win.contentView.children.includes(tx.view) && win.contentView.children.includes(tn.view));
  ok('la derecha cae EXACTAMENTE sobre su hoja', await until(async () => same(tn.view.getBounds(), await paneRect(1))), `${JSON.stringify(tn.view.getBounds())} vs ${JSON.stringify(await paneRect(1))}`);
  tx.view.webContents.focus();
  ok('un clic en la otra mitad la vuelve la activa', await until(() => T.active.id === sx));
  ok('y su hoja lleva el canto de activa', await until(() => js(`document.querySelector('.pr-pane[data-slot="0"]').classList.contains('is-active')`)));
  T.setSplitRatio(sx, 0.3);
  ok('el divisor reparte el ancho', await until(async () => same(tx.view.getBounds(), await paneRect(0)) && same(tn.view.getBounds(), await paneRect(1)) && tx.view.getBounds().width < tn.view.getBounds().width));
  T.setSplitRatio(sx, 0.05);
  ok('pero no menos del 20 %', T.snapshot().split.ratio === 0.2);
  T.setSplitRatio(sx, 0.5);
  await until(async () => same(tx.view.getBounds(), await paneRect(0)));
  const dv = await js(`(() => { const r = document.getElementById('divider').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: dv.x, y: dv.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: dv.x, y: dv.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: dv.x - k * 40, y: dv.y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: dv.x - 240, y: dv.y, button: 'left', clickCount: 1 });
  ok('arrastrar el divisor reparte el ancho', await until(async () => T.snapshot().split.ratio < 0.4 && same(tx.view.getBounds(), await paneRect(0))), `ratio ${T.snapshot().split.ratio}`);
  T.setSplitRatio(sx, 0.5);
  await js(`document.getElementById('btn-menu').click()`);
  /* El menú aparece recién DESPUÉS de congelar (layers.js: fotos → vistas
     afuera → Menu.show). Un Escape mandado apenas se ven las fotos puede
     llegar antes que el menú: se pierde, el menú se abre igual y queda
     abierto con la página congelada — y todo lo que sigue falla en cadena.
     Por eso se espera al menú, no a las fotos. */
  ok('un menú congela las dos mitades', await until(() => js(`!!document.querySelector('.op-menu') && ['freeze', 'freeze-2'].every((id) => document.getElementById(id).classList.contains('is-on'))`)));
  ok('y corre las dos vistas', await until(() => tx.view.getBounds().x < 0 && tn.view.getBounds().x < 0));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('y al cerrarlo vuelven las dos', await until(() => tx.view.getBounds().x >= 0 && tn.view.getBounds().x >= 0 && js(`!document.querySelector('.op-menu') && !document.getElementById('freeze-2').classList.contains('is-on')`)));
  ok('el barrido no duerme la mitad que no es la activa', (await T.sweep(Date.now() + 99 * 60 * 1000), !!tn.view && !!tx.view));
  T.swapSplit(sx);
  ok('intercambiar lados da vuelta el par', T.snapshot().split.a === sn && T.list[T.list.indexOf(tn) + 1] === tx);
  ok('y las vistas cambian de lugar', await until(async () => same(tn.view.getBounds(), await paneRect(0)) && same(tx.view.getBounds(), await paneRect(1))));
  const otra = T.create({ url: `${BASE}/dos`, active: false });
  T.move(sn, T.list.length - 1);
  ok('mover una mueve el par entero', T.list.at(-1) === tx && T.list.at(-2) === tn);
  const metida = T.create({ url: '', index: T.list.indexOf(tx), active: false });
  ok('una pestaña nueva no se mete entre las dos: va después', T.list[T.list.indexOf(tn) + 1] === tx && T.list[T.list.indexOf(tx) + 1]?.id === metida);
  T.close(metida);
  T.close(otra);
  await T.writeSession();
  ok('la sesión recuerda el par', (await ctx.sessionDoc.read()).splits?.some((x) => x.a >= 0 && x.b === x.a + 1));
  T.close(sn);
  ok('cerrar una mitad deshace el par', !T.snapshot().split && T.active.id === sx);
  ok('y la otra vuelve a ocupar toda la hoja', await until(async () => same(tx.view.getBounds(), await paneRect(0)) && tx.view.getBounds().width === full.width && js(`!document.getElementById('page').classList.contains('is-split')`)));
  T.contextAction('link-split', { url: `${BASE}/dos` });
  ok('abrir un enlace al costado arma el par con ese enlace', await until(() => T.snapshot().split?.a === sx && T.active.title === 'Página dos'));
  const lk = T.active.id;
  T.contextAction('link-split', { url: `${BASE}/larga` });
  // El enlace sale de la mitad activa (la derecha): cae en la izquierda, sin armar otro par.
  ok('y con el par armado, el enlace va a la otra mitad', await until(() => T.snapshot().split?.a === sx && T.snapshot().split?.b === lk && tx.title === 'Larga' && T.active.id === sx));
  T.unsplit(sx);
  ok('separar deja las dos como pestañas comunes', !T.snapshot().split && !T.snapshot().tabs.some((t) => t.split));
  T.close(lk);
  T.close(sx);

  console.log('\n8. Errores');
  ctx.tabs.create({ url: 'http://127.0.0.1:1/' });
  ok('una conexión rechazada muestra el aviso', await until(() => js(`!!document.querySelector('.pr-view[data-page="error"]')`), 8000));
  ok('y la vista no tapa el aviso', !ctx.tabs.active.view || !win.contentView.children.includes(ctx.tabs.active.view));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n8b. Scrollbars de las páginas');
  ctx.tabs.create({ url: `${BASE}/larga` });
  ok('carga la página larga', await until(() => ctx.tabs.active.title === 'Larga'));
  const sb = await ctx.tabs.active.view.webContents.executeJavaScript('window.__sb');
  ok('la scrollbar flota: no le come ancho a la página', sb === 0, `midió ${sb}`);
  ctx.tabs.close(ctx.tabs.active.id);
  // Como Instagram: <html> negro y el contenido en un bloque de otro color.
  ctx.tabs.create({ url: `${BASE}/negra` });
  ok('carga la página de <html> negro', await until(() => ctx.tabs.active.title === 'Negra' && !ctx.tabs.active.loading));
  await sleep(300);
  const shot = await ctx.tabs.active.view.webContents.capturePage();
  const { width: shw, height: shh } = shot.getSize();
  const bmp = shot.toBitmap();
  const px = (x, y) => { const i = (y * shw + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
  const borde = px(shw - 3, shh - 20);
  ok('en el borde derecho no asoma el negro', borde[0] > 6 && borde[2] > 12, borde.join(','));
  ctx.tabs.close(ctx.tabs.active.id);
  const propia = await js(`(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-300px;top:0;width:100px;height:40px;overflow-y:scroll'; d.innerHTML = '<div style="height:400px"></div>'; document.body.appendChild(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; })()`);
  ok('las de la ventana siguen siendo las propias (10 px)', propia === 10, `midió ${propia}`);

  console.log('\n8c. window.chrome como en Chrome (lo que pide el login de Google)');
  ctx.tabs.create({ url: `${BASE}/` });
  ok('carga una página', await until(() => ctx.tabs.active.title === 'Inicio de prueba' && !ctx.tabs.active.loading));
  const wch = await ctx.tabs.active.view.webContents.executeJavaScript(`(() => {
    const c = window.chrome;
    const lt = c?.loadTimes?.();
    const csi = c?.csi?.();
    return {
      keys: c ? Object.keys(c).sort() : null,
      installed: c?.app?.isInstalled, state: c?.app?.runningState?.(),
      lt: lt && typeof lt.requestTime === 'number' && typeof lt.connectionInfo === 'string' && lt.finishLoadTime >= lt.requestTime,
      csi: csi && typeof csi.startE === 'number' && typeof csi.pageT === 'number',
    };
  })()`);
  ok('trae app, csi y loadTimes', JSON.stringify(wch.keys) === '["app","csi","loadTimes"]', JSON.stringify(wch));
  ok('con la forma de Chrome', wch.installed === false && wch.state === 'cannot_run' && wch.lt && wch.csi, JSON.stringify(wch));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n9. Descargas');
  ctx.tabs.contextAction('link-save', { url: `${BASE}/archivo.bin` });
  ok('baja el archivo a la carpeta elegida', await until(() => fs.existsSync(path.join(DL, 'archivo.bin')) && ctx.downloads.list()[0]?.state === 'completed', 8000));
  ok('el panel lo lista', await until(() => js(`__prism.S.downloads.some(d => d.filename === 'archivo.bin')`)));

  console.log('\n9b. Contraseñas');
  const V = ctx.passwords.vault;
  await V.save({ title: 'Prueba', username: 'fran', password: 'secreta', urls: [BASE], note: 'una notita' });
  const enDisco = fs.readFileSync(path.join(process.env.PRISM_DATA, 'vault.json'), 'utf8');
  ok('la bóveda se guarda cifrada (ni el usuario ni la nota a la vista)', enDisco.includes('"blob"') && !enDisco.includes('fran') && !enDisco.includes('notita'));
  ctx.tabs.create({ url: `${BASE}/login` });
  ok('carga el login', await until(() => ctx.tabs.active.title === 'Login' && !ctx.tabs.active.loading));
  const lwc = ctx.tabs.active.view.webContents;
  const click = async (sel) => {
    const r = await lwc.executeJavaScript(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    lwc.focus();
    for (const type of ['mouseDown', 'mouseUp']) lwc.sendInputEvent({ type, x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
  };
  const listaAbierta = () => lwc.executeJavaScript(`[...document.documentElement.children].some((e) => e.tagName === 'DIV' && !e.shadowRoot)`);
  await click('#u');
  ok('enfocar el usuario cuelga la lista de Prism', await until(listaAbierta));
  ok('y la página no puede leerla (shadow root cerrado)', await lwc.executeJavaScript(`!document.body.innerText.includes('Prueba')`));
  lwc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  lwc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  ok('elegir completa usuario y contraseña', await until(() => lwc.executeJavaScript(`document.getElementById('u').value === 'fran' && document.getElementById('p').value === 'secreta'`)));
  ok('y anota el último uso', await until(() => !!V.get(V.list()[0].id).lastUsedAt));
  await lwc.executeJavaScript(`document.getElementById('p').value = 'nueva'`);
  await click('#b');
  ok('enviar navega', await until(() => ctx.tabs.active.title === 'Bienvenida'));
  ok('y ofrece actualizar la contraseña', await until(() => js(`!!document.querySelector('.pr-offer') && document.querySelector('.pr-pop__title').textContent.includes('Actualizar')`), 6000));
  await js(`document.querySelector('[data-o=save]').click()`);
  ok('actualizar la reemplaza', await until(() => V.get(V.list()[0].id).password === 'nueva'));
  ok('el panel de la oferta se va', await until(() => js(`!document.querySelector('.pr-offer')`)));
  ok('otro sitio no recibe nada', V.findFor(BASE.replace('127.0.0.1', 'localhost') + '/login').length === 0);
  await js(`document.getElementById('btn-pass').click()`);
  ok('la llave abre el panel con la lista', await until(() => js(`document.querySelectorAll('.pr-pass__row').length === 1`)));
  ok('con el detalle, la nota y las fechas', await until(() => js(`(() => { const t = document.querySelector('#pp-main').innerText; return t.includes('Prueba') && t.includes('una notita') && t.includes('Último completado automático'); })()`)));
  ok('la contraseña no está en el cromo hasta que se pide', await js(`!document.querySelector('.pr-pass').innerText.includes('nueva')`));
  await js(`document.querySelector('[data-a=reveal]').click()`);
  ok('mostrarla la trae', await until(() => js(`document.getElementById('pp-secret').textContent === 'nueva'`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('Escape cierra el panel', await until(() => js(`!document.querySelector('.pr-pass')`)));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n9c. El IPC del cromo no atiende a las páginas');
  /* Un preload SOLO de prueba le pasa ipcRenderer al mundo de la página: es
     lo que tendría un renderer comprometido. Los pedidos salen de verdad
     desde el webContents de una página, no de un evento simulado. */
  const hostil = path.join(TMP, 'preload-hostil.cjs');
  fs.writeFileSync(hostil, `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('__ipc', { invoke: (c, ...a) => ipcRenderer.invoke(c, ...a), send: (c, ...a) => ipcRenderer.send(c, ...a) });`);
  const hostilId = ctx.web.registerPreloadScript({ type: 'frame', filePath: hostil });
  ctx.tabs.create({ url: `${BASE}/` });
  ok('carga una página con ipcRenderer a mano', await until(() => ctx.tabs.active.title === 'Inicio de prueba' && !ctx.tabs.active.loading));
  const hwc = ctx.tabs.active.view.webContents;
  const desde = (c) => hwc.executeJavaScript(c).catch((e) => ({ rechazado: String(e?.message || e) }));
  const antesDl = ctx.settings.downloadDir;
  const r1 = await desde(`__ipc.invoke('settings:save', { downloadDir: 'C:/de-la-pagina', searchEngine: 'bing' })`);
  ok('settings:save desde una página: "No autorizado."', r1?.ok === false && r1.error === 'No autorizado.', JSON.stringify(r1));
  ok('y los ajustes no cambian', ctx.settings.downloadDir === antesDl && ctx.settings.searchEngine !== 'bing');
  const r2 = await desde(`__ipc.invoke('bookmarks:add', { url: 'https://malo.example/', title: 'Malo' })`);
  ok('bookmarks:add tampoco', r2?.ok === false && !ctx.library.listBookmarks().some((b) => b.url === 'https://malo.example/'), JSON.stringify(r2));
  const r3 = await desde(`__ipc.invoke('pass:list')`);
  ok('ni la lista de contraseñas', r3?.ok === false && !r3.data, JSON.stringify(r3));
  const r4 = await desde(`__ipc.invoke('update:state')`);
  ok('los canales de main.cjs rechazan', !!r4?.rechazado, JSON.stringify(r4));
  await desde(`__ipc.send('win:minimize'); __ipc.send('win:toggle-maximize'); true`);
  await sleep(300);
  ok('y la ventana no se minimiza ni se maximiza desde una página', !win.isMinimized() && !win.isMaximized());
  const r5 = await js(`window.prism.settings.get().then(() => 'ok', (e) => e.message)`);
  ok('el cromo sigue pudiendo', r5 === 'ok', r5);

  console.log('\n10. Permisos');
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/geo`);
  ok('pregunta antes de dar la ubicación', await until(() => js(`!!document.querySelector('.op-modal .pr-ask')`), 8000));
  // La página intenta contestarse sola que sí (a cualquier id de pregunta).
  await desde(`for (let i = 1; i <= 40; i++) __ipc.send('prompt:answer', i, { allow: true, remember: true }); true`);
  await sleep(300);
  ok('una página no puede contestarse el permiso', !ctx.settings.permissions?.[BASE]?.geolocation && await js(`!!document.querySelector('.op-modal .pr-ask')`));
  await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].find(b => b.textContent.includes('Bloquear')).click()`);
  ok('y recuerda el "no"', await until(() => ctx.settings.permissions?.[BASE]?.geolocation === 'deny'));
  ok('el velo se va', await until(() => js(`!document.querySelector('.op-scrim')`)));
  ctx.web.unregisterPreloadScript(hostilId);

  console.log('\n10b. Videollamadas: cámara y micrófono (falsos)');
  const llamada = `${BASE}/llamada`;
  const resultado = async () => { await until(() => ctx.tabs.active.view.webContents.executeJavaScript('!!window.__r'), 8000); return ctx.tabs.active.view.webContents.executeJavaScript('window.__r'); };
  const pregunta = () => until(() => js(`!!document.querySelector('.op-modal .pr-ask')`), 8000);
  const contestar = async (boton, recordar) => {
    if (!recordar) await js(`document.getElementById('p-remember').click()`);
    await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].find(b => b.textContent.includes('${boton}')).click()`);
    await until(() => js(`!document.querySelector('.op-scrim')`));
  };
  await ctx.tabs.navigate(ctx.tabs.active.id, llamada);
  ok('pregunta por la cámara y el micrófono', await pregunta());
  await contestar('Permitir', false);
  let r = await resultado();
  ok('antes de decidir, el sitio lee "prompt" y no "denied"', r.antes === 'prompt' && r.noti === 'default', JSON.stringify(r));
  ok('permitir da video y audio en vivo', r.pistas === 'audio:live,video:live', JSON.stringify(r));
  ok('y el sitio ya lee "granted", con los dispositivos por su nombre', r.despues === 'granted' && r.nombres, JSON.stringify(r));
  ok('sin "Recordar" no se guarda nada', !ctx.settings.permissions?.[BASE]?.camera && !ctx.settings.permissions?.[BASE]?.microphone);
  ctx.tabs.active.view.webContents.reload();
  r = await resultado();
  ok('recargar el mismo sitio no vuelve a preguntar', r.antes === 'granted' && r.pistas === 'audio:live,video:live' && !(await js(`!!document.querySelector('.op-modal .pr-ask')`)), JSON.stringify(r));
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE.replace('127.0.0.1', 'localhost')}/dos`);
  await until(() => ctx.tabs.active.title === 'Página dos');
  await ctx.tabs.navigate(ctx.tabs.active.id, llamada);
  ok('irse a otro sitio y volver: pregunta de nuevo', await pregunta());
  await contestar('Bloquear', true);
  r = await resultado();
  ok('bloquear recordando: el sitio lee "denied" y no recibe nada', r.despues === 'denied' && r.pistas === 'NotAllowedError' && ctx.settings.permissions?.[BASE]?.camera === 'deny', JSON.stringify(r));
  // Los dos a la vez: antes el segundo pisaba al primero (ver ctx.updateSettings).
  await js(`Promise.all([window.prism.permissions.revoke('${BASE}', 'camera'), window.prism.permissions.revoke('${BASE}', 'microphone')])`);
  ok('"Olvidar" los dos a la vez borra los dos', await until(() => !ctx.settings.permissions?.[BASE]?.camera && !ctx.settings.permissions?.[BASE]?.microphone));
  ctx.tabs.active.view.webContents.reload();
  ok('y el sitio vuelve a preguntar', await pregunta());
  await contestar('Bloquear', false);

  console.log('\n10c. Los ajustes se guardan en fila');
  const enDiscoAj = () => JSON.parse(fs.readFileSync(path.join(process.env.PRISM_DATA, 'settings.json'), 'utf8'));
  const previo = { sleepTabs: ctx.settings.sleepTabs, askDownload: ctx.settings.askDownload };
  await js(`Promise.all([window.prism.settings.save({ sleepTabs: 15 }), window.prism.settings.save({ askDownload: true })])`);
  ok('dos guardados a la vez: quedan los dos', ctx.settings.sleepTabs === 15 && ctx.settings.askDownload === true);
  ok('también en el disco', enDiscoAj().sleepTabs === 15 && enDiscoAj().askDownload === true, JSON.stringify(enDiscoAj()));
  await ctx.saveSettings(previo);
  await ctx.saveSettings({ adblockAllow: ['uno.example', 'dos.example', 'tres.example'] });
  await js(`Promise.all([window.prism.settings.remove('adblockAllow', 'uno.example'), window.prism.settings.remove('adblockAllow', 'dos.example')])`);
  ok('quitar dos de una lista a la vez: se van los dos', JSON.stringify(ctx.settings.adblockAllow) === '["tres.example"]', JSON.stringify(ctx.settings.adblockAllow));
  const ajeno = await js(`window.prism.settings.remove('permissions', 'x').then(() => 'pasó', (e) => e.message)`);
  ok('y solo se puede con las listas previstas', ajeno === 'Esa lista no existe.', ajeno);
  await ctx.saveSettings({ adblockAllow: [] });

  console.log('\n11. Páginas propias');
  for (const p of ['historial', 'favoritos', 'descargas', 'ajustes']) {
    ctx.tabs.openInternal(p);
    ok(`prism://${p} se dibuja`, await until(() => js(`!!document.querySelector('.pr-view[data-page="${p}"] .pr-head__title')`)));
    if (p === 'historial') ok('el historial lista lo visitado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="historial"] .pr-row').length >= 2`)));
    if (p === 'favoritos') ok('los favoritos listan el guardado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="favoritos"] .pr-row').length === 1`)));
  }

  // Ajustes quedó abierta: doble clic en un switch. Tiene que volver a como estaba,
  // guardado Y a la vista (antes quedaba prendido pero mostrándose apagado).
  const sw = `document.querySelector('.pr-view[data-page="ajustes"] [data-toggle="askDownload"]')`;
  const antesAsk = !!ctx.settings.askDownload;
  /* Se cuentan los guardados y se compara cuando terminaron los dos: mirar
     enseguida daba bien por casualidad (dos clics devuelven el switch a su
     lugar antes de que llegue ningún guardado). */
  let guardados = 0;
  const upd = ctx.updateSettings;
  ctx.updateSettings = (fn) => upd(fn).finally(() => { guardados++; });
  await js(`(() => { const b = ${sw}; b.click(); b.click(); })()`);
  await until(() => guardados >= 2, 3000);
  ok('doble clic en un switch: lo guardado vuelve a como estaba', !!ctx.settings.askDownload === antesAsk, `guardado ${ctx.settings.askDownload}`);
  ok('y lo que se ve coincide', await until(async () => (await js(`${sw}.classList.contains('is-on')`)) === antesAsk, 3000));
  guardados = 0;
  await js(`${sw}.click()`);
  await until(() => guardados >= 1, 3000);
  ctx.updateSettings = upd;
  ok('y un clic solo lo da vuelta', !!ctx.settings.askDownload === !antesAsk && await until(async () => (await js(`${sw}.classList.contains('is-on')`)) === !antesAsk, 3000));
  await ctx.saveSettings({ askDownload: antesAsk });

  /* Cambiar de página propia: la que se va se desvanece (antes un estilo en
     línea le apagaba la animación y quedaba entera encima de la nueva), y la
     nueva espera su turno. */
  ok('Ajustes ya se asentó', await until(() => js(`!!document.querySelector('#internal .pr-view[data-page="ajustes"].is-settled')`)));
  const relevo = await js(`new Promise((res) => {
    const t0 = performance.now();
    const tick = () => {
      const c = document.querySelector('#internal .pr-view[data-state="closing"]');
      if (c) return res({ sale: getComputedStyle(c).animationName, llega: !!document.querySelector('#internal .pr-view.is-after:not([data-state])') });
      if (performance.now() - t0 > 2000) return res(null);
      requestAnimationFrame(tick);
    };
    window.prism.tabs.navigate(null, 'prism://historial');
    requestAnimationFrame(tick);
  })`);
  ok('al cambiar de página, la vieja se desvanece', relevo?.sale === 'op-fade-out', JSON.stringify(relevo));
  ok('y la nueva espera a que se vaya', relevo?.llega === true, JSON.stringify(relevo));

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
