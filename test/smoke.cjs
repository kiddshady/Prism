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
const http = require('http');

const { tempDir } = require('./temporal.cjs');

// Se borra sola cuando el humo termina, aunque se aborte (temporal.cjs).
const TMP = tempDir('prism-smoke-');
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
setTimeout(() => bail('timeout de 160s'), 160000);

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
  /* Para «Copiar enlace al texto»: la misma frase dos veces, lejos una de otra,
     un título seguido de su párrafo, y un texto con guion. */
  '/texto': `<title>Texto</title><body style="font:16px sans-serif;margin:20px">
    <p id="a">La absorción oral es lenta en ayunas.</p>
    <div style="height:3000px"></div>
    <h2 id="h">Farmacocinética en niños</h2>
    <p id="b">Sin embargo, en niños la absorción oral es más rápida que en adultos, y la semivida es menor.</p>
    <div style="height:3000px"></div>
    <p id="c">Un párrafo final con un inhibidor anti-inflamatorio no esteroide de uso común.</p>
    <div style="height:1500px"></div></body>`,
  /* Un sonido de un instante, como el final de un tema. */
  '/tono': `<title>Tono</title><body><script>
    const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
    g.gain.value = 0.2; o.connect(g).connect(c.destination); o.start(); setTimeout(() => o.stop(), 700);
  </script></body>`,
  /* Como los PDF de la cátedra en el campus: la dirección lleva espacios (%20). */
  '/Gu%C3%ADa%20TP%203': '<title>Guía TP 3</title><body><h1>Guía</h1></body>',
  '/titulo-largo': `<title>${'Un título larguísimo como el de un posteo de X, que no entra en una línea '.repeat(3)}</title><body></body>`,
  '/login': '<title>Login</title><body><form action="/bienvenida" method="post"><input id="u" name="usuario" autocomplete="username"><input id="p" type="password" name="clave"><button id="b">Entrar</button></form></body>',
  '/bienvenida': '<title>Bienvenida</title><body><h1>Adentro</h1></body>',
  /* Un checkout sin autocomplete (todo por nombres), con el vencimiento en dos
     selects, el código en un campo de contraseña y el DNI del titular, que se
     parece pero no es de la tarjeta. */
  '/pago': `<title>Pago</title><body style="font:16px sans-serif"><form id="f">
    <input id="nom" name="cardholder" placeholder="Nombre como figura en la tarjeta">
    <input id="num" name="numeroTarjeta" placeholder="1234 1234 1234 1234">
    <select id="mes" name="mesVencimiento"><option value="">Mes</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
    <select id="anio" name="anioVencimiento"><option value="">Año</option>${Array.from({ length: 10 }, (_, i) => `<option>${2026 + i}</option>`).join('')}</select>
    <input id="cvv" type="password" name="cvv" maxlength="4">
    <input id="dni" name="dniTitular" placeholder="DNI del titular">
    <button id="pagar">Pagar</button></form></body>`,
  /* Como Stripe o Mercado Pago: el titular en la página, el número en un
     iframe de otro sitio, y al lado un iframe de un tercero (publicidad) con
     un campo que dice ser de tarjeta. */
  '/pago-iframe': `<title>Pago iframe</title><body style="margin:0;font:16px sans-serif"><div style="padding:40px">
    <input id="nom" autocomplete="cc-name" placeholder="Titular">
    <iframe id="pay" width="420" height="44" style="border:0;display:block;margin-top:20px"></iframe>
    <iframe id="ad" width="300" height="44" style="border:0;display:block;margin-top:160px"></iframe></div>
    <script>const p = location.port; pay.src = 'http://localhost:' + p + '/campos'; ad.src = 'http://ads.localhost:' + p + '/anuncio';</script></body>`,
  '/campos': '<body style="margin:0"><input id="n" autocomplete="cc-number" style="width:200px;height:30px"><input id="e" autocomplete="cc-exp" placeholder="MM / AA" style="width:80px;height:30px"><input id="c" autocomplete="cc-csc" style="width:60px;height:30px"></body>',
  /* El mismo checkout con el iframe del mismo origen (mismo proceso): ahí
     sendInputEvent sí llega con el teclado, y se prueba el camino de las
     flechas y el Enter que el iframe le pasa a la lista de arriba. */
  '/pago-iframe-mismo': '<title>Pago mismo</title><body style="margin:0"><div style="padding:40px"><iframe id="pay" src="/campos" width="420" height="44" style="border:0;display:block"></iframe></div></body>',
  '/anuncio': '<body style="margin:0"><input id="n" autocomplete="cc-number" style="width:200px;height:30px"></body>',
  '/geo': '<title>Geo</title><body><script>navigator.geolocation.getCurrentPosition(()=>{},()=>{})</script></body>',
  /* Una página que abre cosas sola (sin que nadie la toque): una ventana y una
     pestaña al cargar. Y un botón que abre una ventana con un click de verdad. */
  '/abre': `<title>Abre</title><body style="margin:0"><button id="b" style="width:200px;height:60px"
    onclick="window.open('/dos', 'p', 'width=420,height=320')">abrir</button>
    <script>setTimeout(() => { window.open('/tres-x', 'q', 'width=300,height=300'); window.open('/dos'); }, 300);</script></body>`,
  /* Presentar, como en Meet: compartir la pantalla con un clic. */
  '/presentar': `<title>Presentar</title><body style="margin:0"><button id="b" style="width:200px;height:60px">presentar</button><script>
    b.onclick = () => navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { window.__r = 'stream ' + s.getTracks().map((t) => t.kind).join(); s.getTracks().forEach((t) => t.stop()); }, (e) => { window.__r = 'error ' + e.name; });
  </script></body>`,
  /* Links a aplicaciones de la compu: uno de los que se niegan siempre y uno común. */
  '/externo': `<title>Externo</title><body style="margin:0;font:16px sans-serif">
    <a id="ms" href="search-ms:query=prism" style="display:block;height:40px">buscar en el Explorador</a>
    <a id="mail" href="mailto:fran@example.com" style="display:block;height:40px">escribir</a></body>`,
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
  /* Un video sin red: un lienzo que se dibuja solo, como transmisión. Metido
     en una caja con transform (lo que rompe un position: fixed), y otro en un
     iframe, como el de YouTube adentro del aula del campus. */
  '/video': `<title>Video</title><body style="margin:0;font:16px sans-serif">
    <div style="transform:translateZ(0);overflow:hidden;width:640px;margin:20px"><video id="v" autoplay muted playsinline style="width:640px;height:360px;display:block"></video></div>
    <iframe id="f" src="/video-solo" width="400" height="240" allowfullscreen style="border:0;margin:20px"></iframe>
    <script>
      const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); let n = 0;
      setInterval(() => { x.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; x.fillRect(0, 0, 640, 360); }, 40);
      document.getElementById('v').srcObject = c.captureStream(25);
    </script></body>`,
  '/video-solo': `<body style="margin:0;background:#000"><video id="e" muted playsinline style="width:100%;height:100%;display:block"></video><script>
      const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); let n = 0;
      setInterval(() => { x.fillStyle = 'hsl(' + (n++ * 11 % 360) + ',60%,40%)'; x.fillRect(0, 0, 400, 300); }, 40);
      document.getElementById('e').srcObject = c.captureStream(25);
    </script></body>`,
  /* Como Moodle 4 con sesión: el documento no scrollea, scrollea una caja. */
  '/caja': `<title>Caja</title><style>html,body{height:100%;margin:0;overflow:hidden}
    #page{height:calc(100vh - 50px);margin-top:50px;overflow-y:auto}</style>
    <div id="page"><div style="height:3000px;background:linear-gradient(#c00,#00c)"></div></div>`,
};
/* Otro programa abre un archivo sin compartir nada (Excel con un CSV, un
   backup). Devuelve con qué soltarlo. */
function lockFile(file) {
  return new Promise((resolve) => {
    const ps = require('child_process').spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); 'listo'; Start-Sleep -Seconds 60`]);
    ps.stdout.once('data', () => resolve(() => new Promise((r) => { ps.once('exit', r); ps.kill(); })));
  });
}

/** Los tamaños de los íconos que una ventana le da a Windows: «grande chico», en px.
    Se le pregunta a la ventana (WM_GETICON) desde afuera, sin trabar este proceso:
    tiene que seguir atendiendo mensajes para contestar. */
function iconosDeLaVentana(win) {
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const ps = `
    Add-Type -AssemblyName System.Drawing
    Add-Type 'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint ms, out IntPtr r); }'
    $out = foreach ($cual in 1, 0) {
      $r = [IntPtr]::Zero
      [void][W]::SendMessageTimeout([IntPtr]${hwnd}, 0x7F, [IntPtr]$cual, [IntPtr]::Zero, 2, 3000, [ref]$r)
      if ($r -eq [IntPtr]::Zero) { 0 } else { [System.Drawing.Icon]::FromHandle($r).Width }
    }
    $out -join ' '`;
  return new Promise((resolve) => {
    require('child_process').execFile('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      (err, out) => resolve(err ? `error: ${err.message}` : out.trim()));
  });
}

/** Cuántas veces se pidió cada dirección (para saber si una página se recargó). */
const hits = {};
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/archivo.bin') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="archivo.bin"' });
    return res.end(Buffer.alloc(64 * 1024, 7));
  }
  /* El título entero de un apunte como nombre: más largo que lo que entra. */
  if (req.url === '/apunte-largo') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${'Guia de trabajos practicos de Farmacologia - Unidad 4 - '.repeat(4)}(catedra).pdf"` });
    return res.end('%PDF-1.4\n%%EOF\n');
  }
  /* Una página que tarda en llegar: mientras carga, recargar es detener. */
  if (req.url === '/lenta') {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>Lenta</title><body>lenta</body>'); }, 1500);
    return undefined;
  }
  /* Una descarga que no termina nunca: gotea mientras la conexión siga. */
  if (req.url === '/lento') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="lento.bin"', 'Content-Length': String(50 * 1024 * 1024) });
    const drip = setInterval(() => res.write(Buffer.alloc(8 * 1024, 1)), 100);
    req.on('close', () => clearInterval(drip));
    return undefined;
  }
  /* Un favicon que no carga y tarda en fallar (como el de un aparato de la
     red). Contesta algo que no es una imagen: falla igual, sin dejar un 404
     en la consola del cromo, que el humo vigila al final. */
  if (req.url === '/icono-roto.ico') {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('no es una imagen'); }, 600);
    return undefined;
  }
  const body = PAGES[req.url.split('?')[0]];
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
  /* El ícono de la ventana sale del .ico, cada cuadro a su tamaño. Con el PNG
     de 256 px la ventana le daba ese para todo y la barra de tareas lo
     achicaba: el prisma salía más chico y con las caras pegadas. */
  const iconos = await iconosDeLaVentana(win);
  ok('la ventana le da a Windows los cuadros del .ico (32 y 16 px), no el de 256 achicado', iconos === '32 16', iconos);
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

  console.log('\n2a. Enter en una dirección con espacios');
  const guia = `${BASE}/Gu%C3%ADa%20TP%203`;
  await js(`window.prism.tabs.navigate(null, '${guia}')`);
  ok('carga la página con espacios en la dirección', await until(() => ctx.tabs.active.title === 'Guía TP 3' && !ctx.tabs.active.loading));
  win.webContents.focus();
  await js(`document.getElementById('omni-input').focus(); true`);
  ok('la barra la muestra legible, con los espacios como %20', await until(() => js(`document.getElementById('omni-input').value === ${JSON.stringify(`${BASE}/Guía%20TP%203`)}`)), await js(`document.getElementById('omni-input').value`));
  const pedidos = hits['/Gu%C3%ADa%20TP%203'];
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  ok('Enter la recarga', await until(() => hits['/Gu%C3%ADa%20TP%203'] > pedidos));
  ok('y no se va a buscar a Google', ctx.tabs.active.url === guia, ctx.tabs.active.url);
  await js(`window.prism.tabs.navigate(null, '${BASE}/')`);
  await until(() => ctx.tabs.active.title === 'Inicio de prueba' && !ctx.tabs.active.loading);

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
  ok('y se enciende', await until(() => js(`document.getElementById('omni-star').classList.contains('is-b')`)));

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

  console.log('\n7b2b. Cuentas y conversiones en la barra');
  ok('una cuenta trae su resultado', (await sugg('250/3')).answer?.num === '83,33333333', JSON.stringify((await sugg('250/3')).answer));
  ok('una búsqueda no', (await sugg('gatitos')).answer === null);
  /* El portapapeles de verdad es de la persona: la prueba no lo pisa. Se
     atrapa lo que la fila le mandaría. */
  await js(`window.__copiado = null; navigator.clipboard.writeText = async (t) => { window.__copiado = t; }; true`);
  await js(`(() => { const i = document.getElementById('omni-input'); i.focus(); i.value = '500 mg a g'; i.dispatchEvent(new InputEvent('input', { inputType: 'insertText' })); })()`);
  const filas = () => js(`[...document.querySelectorAll('.pr-suggest:not([data-state="closing"]) .pr-sugg')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`);
  ok('la segunda fila es el resultado', await until(async () => (await filas())[1]?.startsWith('= 0,5 g')), JSON.stringify(await filas()));
  ok('la primera sigue siendo lo que hace Enter', (await filas())[0].includes('Buscar en'));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  ok('pararse en el resultado no pisa lo escrito', await until(async () => (await js(`document.querySelectorAll('.pr-sugg')[1]?.classList.contains('is-active')`)) && (await js(`document.getElementById('omni-input').value`)) === '500 mg a g'));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  ok('Enter en el resultado lo copia', await until(() => js(`window.__copiado === '0,5'`)), String(await js('window.__copiado')));
  ok('sin ir a ningún lado', ctx.tabs.active.internal === 'nueva' || !String(ctx.tabs.active.url).includes('search'), ctx.tabs.active.url);
  ok('y la statusbar lo cuenta', await until(() => js(`document.getElementById('status-left').textContent.includes('Copiado: 0,5')`)));
  await js(`(() => { const i = document.getElementById('omni-input'); i.value = ''; i.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' })); i.blur(); })()`);

  console.log('\n7b3. La pestaña nueva sin "Los que más visitás"');
  // Otro host que el del favorito: si no, la pestaña nueva lo descarta por repetido.
  ctx.library.visit('https://ejemplo.test/', 'Ejemplo');
  ctx.command('tab:new');
  const topTile = `${NTP} .pr-tile[data-kind="top"]`;
  ok('prendido, muestra los que más visitás', await until(() => js(`!!document.querySelector('${topTile}')`)));
  await ctx.saveSettings({ ntpTopSites: false });
  ok('apagado, se van sin reabrir la pestaña', await until(() => js(`!document.querySelector('${topTile}')`)));
  ok('y el favorito sigue', await js(`!!document.querySelector('${NTP} .pr-tile[data-kind="bookmark"]')`));
  await ctx.saveSettings({ ntpTopSites: true });
  ok('prendido otra vez, vuelven', await until(() => js(`!!document.querySelector('${topTile}')`)));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n7b4. El panel del escudo al tocar su switch');
  /* El panel se arma asíncrono (pide los números del bloqueador): los íconos
     se montaban sobre el contenido viejo y, al refrescarse, se asomaba un
     instante un escudo en el encabezado. Se muestrea cuadro por cuadro. El
     guardado es de mentira: prender el bloqueador de verdad bajaría listas. */
  const saveReal = ctx.saveSettings;
  ctx.saveSettings = async (p) => ({ ...ctx.settings, ...p });
  await js(`document.getElementById('btn-shield').click()`);
  await until(() => js(`!!document.querySelector('.pr-pop #sh-global')`));
  const escudo = js(`new Promise((res) => {
    let svg = 0; let crudo = 0; const t0 = performance.now();
    const tick = () => {
      const pop = document.querySelector('.pr-pop');
      if (pop?.querySelector('.pr-pop__head svg')) svg++;
      if (pop?.querySelector('i[data-icon]')) crudo++;
      if (performance.now() - t0 < 700) requestAnimationFrame(tick); else res({ svg, crudo });
    };
    requestAnimationFrame(tick);
    document.querySelector('.pr-pop #sh-global').click();
  })`);
  const ev4 = await escudo;
  ok('tocar el switch no hace asomar un ícono en el encabezado', ev4.svg === 0, JSON.stringify(ev4));
  ok('ni queda un ícono sin montar en el panel', ev4.crudo === 0, JSON.stringify(ev4));
  await js(`document.getElementById('btn-shield').click()`);
  await until(() => js(`!document.querySelector('.pr-pop:not([data-state="closing"])')`));
  ctx.saveSettings = saveReal;

  console.log('\n7b5. Imprimir');
  /* La pantalla propia, con la vista previa dibujada por pdf.js. El diálogo
     de guardar es de mentira; a una impresora de verdad no se manda nada. */
  const { dialog } = require('electron');
  const pdfFile = path.join(TMP, 'impreso.pdf');
  const saveDlg = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdfFile });
  ctx.tabs.create({ url: `${BASE}/larga` });
  await until(() => ctx.tabs.active.title === 'Larga');
  const pt = ctx.tabs.active;
  await until(() => !pt.view.webContents.isLoading());
  ctx.command('page:print');
  ok('Ctrl+P abre la pantalla de impresión', await until(() => js(`!!document.querySelector('.pr-print')`)));
  ok('con la vista previa dibujada', await until(() => js(`!!document.querySelector('.pr-print .pr-sheet.is-drawn')`), 10000));
  const hojas = await js(`document.querySelectorAll('.pr-print__sheets:not([data-state="closing"]) .pr-sheet').length`);
  ok('una hoja por página', hojas > 1, String(hojas));
  await js(`document.getElementById('pp-dest').click()`);
  await until(() => js(`!!document.querySelector('.op-menu .op-menuitem')`));
  await js(`[...document.querySelectorAll('.op-menu .op-menuitem')].find((b) => b.textContent.includes('Guardar como PDF')).click()`);
  ok('con "Guardar como PDF" el botón dice Guardar', await until(() => js(`document.querySelector('.op-modal__foot .op-btn--primary').textContent === 'Guardar'`)));
  await js(`document.querySelector('#pp-pages [data-value="custom"]').click()`);
  await js(`(() => { const i = document.getElementById('pp-range'); i.value = '1-2'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  ok('elegir páginas pliega las otras', await until(() => js(`document.querySelectorAll('.pr-print__sheets:not([data-state="closing"]) .pr-sheet:not(.is-out)').length === 2`)));
  await js(`(() => { const i = document.getElementById('pp-range'); i.value = '1-'; i.dispatchEvent(new Event('input', { bubbles: true })); i.value = '1-x'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  ok('un rango a medio escribir no vacía la vista previa', await js(`document.querySelectorAll('.pr-print__sheets:not([data-state="closing"]) .pr-sheet:not(.is-out)').length > 0`));
  ok('y no deja imprimir', await js(`document.querySelector('.op-modal__foot .op-btn--primary').disabled`));
  await js(`(() => { const i = document.getElementById('pp-range'); i.value = '1-2'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('.op-modal__foot .op-btn--primary').click()`);
  ok('guarda el PDF', await until(() => fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 500, 10000));
  const paginas = fs.existsSync(pdfFile) ? (fs.readFileSync(pdfFile, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length : 0;
  ok('solo con las páginas elegidas', paginas === 2, String(paginas));
  ok('y lo avisa en la tarjeta', await until(() => ctx.card.shown));
  ok('la pantalla se va', await until(() => js(`!document.querySelector('.pr-print')`)));
  ok('y recuerda el destino', ctx.settings.printDest === 'pdf');
  await sleep(1600);   // un sitio que llama a print() en bucle no la reabre enseguida
  await pt.view.webContents.executeJavaScript('window.print()', true);
  ok('el window.print() de un sitio abre la misma pantalla', await until(() => js(`!!document.querySelector('.pr-print')`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('Escape la cierra', await until(() => js(`!document.querySelector('.pr-print')`)));
  dialog.showSaveDialog = saveDlg;
  await ctx.saveSettings({ printDest: null });
  ctx.tabs.close(pt.id);

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

  console.log('\n7d2. El cartelito de una pestaña no se mete bajo la página');
  const pl = T.create({ url: `${BASE}/titulo-largo` });
  await until(() => T.list.find((t) => t.id === pl)?.title.startsWith('Un título'));
  await until(() => tabEl(pl, `el.dataset.tip?.startsWith('Un título')`));
  await tabEl(pl, `(el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })), true)`);
  ok('aparece el cartelito', await until(() => js(`!!document.querySelector('.op-tooltip:not([data-state="closing"])')`)));
  const tipBox = await js(`(() => { const t = document.querySelector('.op-tooltip:not([data-state="closing"])').getBoundingClientRect(); return { bottom: t.bottom, page: document.getElementById('page').getBoundingClientRect().top }; })()`);
  ok('termina antes de donde empieza la página', tipBox.bottom <= tipBox.page, JSON.stringify(tipBox));
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  T.close(pl);

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
  /* El hueco entre dos temas: una pestaña que sonó hace un momento no se
     duerme. Silenciada, así la prueba no suena en la compu de nadie. */
  T.mute(pa, true);
  await T.navigate(pa, `${BASE}/tono`);
  ok('suena y se calla (Chromium la da por callada a los ~2 s)', await until(() => ta.lastAudible > 0 && !ta.audible, 10000), JSON.stringify({ audible: ta.audible, lastAudible: ta.lastAudible }));
  T.activate(pb);
  ta.lastSeen = Date.now() - 31 * 60 * 1000;
  await T.sweep();
  ok('sonó hace un momento: no se duerme', !!ta.view);
  ta.lastAudible = Date.now() - 11 * 60 * 1000;
  await T.sweep();
  ok('hace más de 10 minutos que no suena: se duerme', !ta.view);
  T.activate(pa);
  await until(() => ta.view && !ta.loading);
  T.mute(pa, false);
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
  /* El canto de la mitad activa, pegado a una página blanca, no se veía. Ahora
     va despegado: un hueco del color del fondo y después la luz. Se mide en
     los píxeles de afuera del borde (la vista nativa tapa lo de adentro). */
  const canto = async (slot, lado) => {
    const rect = await js(`(() => { const r = document.querySelector('.pr-pane[data-slot="${slot}"]').getBoundingClientRect(); return { x: Math.round(${lado === 'izq' ? 'r.left - 5' : 'r.right'}), y: Math.round(r.top + r.height / 2), width: 5, height: 1 }; })()`);
    const b = (await win.webContents.capturePage(rect)).toBitmap();
    const out = [];
    for (let i = 0; i < b.length; i += 4) out.push(Math.round((b[i] + b[i + 1] + b[i + 2]) / 3));
    return lado === 'izq' ? out.reverse() : out;   // del borde hacia afuera
  };
  ok('la mitad activa tiene su canto: un hueco oscuro y después la luz', await until(async () => { const c = await canto(1, 'izq'); return c[0] < 40 && Math.max(c[2], c[3]) > 70; }), JSON.stringify(await canto(1, 'izq')));
  ok('y la otra no', (await canto(0, 'izq')).every((v) => v < 40), JSON.stringify(await canto(0, 'izq')));
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

  console.log('\n7g. La tira: cerrar y desbordar');
  /* Cerrar una del medio: la que se va se pliega con la vecina. Quieta en su
     ancho, la vecina se le metía encima mientras todavía se veía. Se mide
     cuadro a cuadro, en el cromo. */
  const extra = [];
  for (let i = 0; i < 3; i++) extra.push(T.create({ url: `${BASE}/dos` }));
  await sleep(1200);
  const cerrar = extra[1];
  const vecina = extra[2];
  await js(`(() => {
    window.__cuadros = [];
    const a = document.querySelector('.pr-tab[data-id="${cerrar}"] .pr-tab__body');
    const b = document.querySelector('.pr-tab[data-id="${vecina}"] .pr-tab__body');
    const t0 = performance.now();
    const tick = () => {
      const ra = a.isConnected ? a.getBoundingClientRect() : null;
      __cuadros.push({ encima: ra ? ra.right - b.getBoundingClientRect().left : 0, opacidad: ra ? +getComputedStyle(a).opacity : 0 });
      if (performance.now() - t0 < 360) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);
  T.close(cerrar);
  await sleep(600);
  const cuadros = await js('window.__cuadros');
  const encimadas = Math.max(0, ...cuadros.filter((c) => c.opacidad > 0.05).map((c) => c.encima));
  ok('cerrar una del medio: la vecina no se le mete encima mientras se ve', cuadros.length > 10 && encimadas <= 0.5, `${cuadros.length} cuadros · ${encimadas.toFixed(1)} px`);
  /* Muchas pestañas: la capa termina antes del «+» (la que caía debajo se
     dibujaba con la cruz encima) y el lado con escondidas se esfuma. */
  for (let i = 0; i < 40; i++) extra.push(T.create({ url: `${BASE}/dos` }));
  await sleep(2500);
  T.activate(T.list[0].id);
  await sleep(700);
  const tira = () => js(`(() => { const h = document.getElementById('tabs'); return { clases: h.className, capa: Math.round(h.getBoundingClientRect().right), mas: Math.round(document.getElementById('btn-newtab').getBoundingClientRect().left) }; })()`);
  let ti = await tira();
  ok('con 40 pestañas, la capa termina antes del «+»', ti.capa <= ti.mas, JSON.stringify(ti));
  ok('y se esfuma el lado con pestañas escondidas', /is-over/.test(ti.clases) && /has-after/.test(ti.clases) && !/has-before/.test(ti.clases), ti.clases);
  T.activate(T.list[T.list.length - 1].id);
  await until(async () => /has-before/.test((await tira()).clases));
  ti = await tira();
  ok('del otro lado al llegar al final', /has-before/.test(ti.clases) && !/has-after/.test(ti.clases), ti.clases);
  for (const id of extra) if (T.list.some((t) => t.id === id)) T.close(id);
  ok('y sin desborde, la tira vuelve a ser la de siempre', await until(async () => !/is-over/.test((await tira()).clases)));

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

  console.log('\n8d. Copiar enlace al texto');
  /* El enlace lleva un fragmento `#:~:text=…` (src/textlink.cjs). Lo que se
     prueba es lo que importa: que quien lo abre CAE en lo elegido, no en la
     primera vez que aparece esa frase. El portapapeles de verdad no se toca. */
  const { clipboard } = require('electron');
  const escribirReal = clipboard.writeText;
  let copiadoTexto = null;
  clipboard.writeText = async (t) => { copiadoTexto = t; };
  ctx.tabs.create({ url: `${BASE}/texto` });
  ok('carga la página de texto', await until(() => ctx.tabs.active.title === 'Texto' && !ctx.tabs.active.loading && ctx.tabs.active.view));
  const idTexto = ctx.tabs.active.id;
  const twc = () => ctx.tabs.active.view.webContents;
  /** Elige en la página lo que arme `rango` (sobre un Range llamado r). */
  const seleccionar = (rango) => twc().executeJavaScript(`(() => { const r = document.createRange(); ${rango}; const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  /** Abre un enlace en otra pestaña y dice si cayó con ese elemento a la vista. */
  const caeEn = async (link, id) => {
    ctx.tabs.create({ url: link });
    await until(() => ctx.tabs.active.id !== idTexto && ctx.tabs.active.title === 'Texto' && !ctx.tabs.active.loading && ctx.tabs.active.view);
    const donde = () => twc().executeJavaScript(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { y: Math.round(scrollY), top: Math.round(r.top), alto: innerHeight }; })()`);
    const bien = await until(async () => { const d = await donde(); return d.y > 1000 && d.top >= 0 && d.top < d.alto; }, 4000);
    const d = await donde();
    ctx.tabs.close(ctx.tabs.active.id);
    ctx.tabs.activate(idTexto);
    await until(() => ctx.tabs.active.id === idTexto);
    return bien ? '' : JSON.stringify(d);
  };

  // «a absorción ora», a mitad de palabra, en el SEGUNDO párrafo que lo dice.
  await seleccionar(`const n = document.getElementById('b').firstChild; const i = n.data.indexOf('a absorción ora'); r.setStart(n, i); r.setEnd(n, i + 15)`);
  const l1 = await ctx.tabs.contextAction('text-link', { text: 'a absorción ora' });
  ok('lo elegido a mitad de palabra se estira a palabras enteras, y como la frase está más arriba lleva contexto', l1 === `${BASE}/texto#:~:text=embargo%2C%20en%20ni%C3%B1os-,la%20absorci%C3%B3n%20oral,-es%20m%C3%A1s%20r%C3%A1pida`, String(l1));
  ok('queda en el portapapeles', copiadoTexto === l1);
  ok('y lo avisa en la statusbar', await until(() => js(`document.getElementById('status-left').textContent.includes('Enlace al texto copiado')`)));
  let malCae = await caeEn(l1, 'b');
  ok('quien lo abre cae en ESE párrafo, no en el primero que dice lo mismo', !malCae, malCae);
  malCae = await caeEn(`${BASE}/texto#:~:text=la%20absorci%C3%B3n%20oral`, 'a');
  ok('(sin el contexto caería arriba: la prueba distingue)', !!malCae, malCae);

  // Del título al párrafo: dos bloques.
  await seleccionar(`r.setStart(document.getElementById('h').firstChild, 0); const n = document.getElementById('b').firstChild; r.setEnd(n, n.data.length)`);
  const l2 = await ctx.tabs.contextAction('text-link', { text: '' });
  ok('lo que cruza de un bloque a otro va con inicio y fin', l2 === `${BASE}/texto#:~:text=Farmacocin%C3%A9tica%20en%20ni%C3%B1os,y%20la%20semivida%20es%20menor.`, String(l2));
  malCae = await caeEn(l2, 'h');
  ok('y cae en el título donde empieza', !malCae, malCae);

  // Un guion adentro: es el separador del contexto, va escapado.
  await seleccionar(`const n = document.getElementById('c').firstChild; const i = n.data.indexOf('anti-inflamatorio'); r.setStart(n, i); r.setEnd(n, i + 'anti-inflamatorio no esteroide'.length)`);
  const l3 = await ctx.tabs.contextAction('text-link', { text: '' });
  ok('un guion adentro del texto va escapado', l3 === `${BASE}/texto#:~:text=anti%2Dinflamatorio%20no%20esteroide`, String(l3));
  malCae = await caeEn(l3, 'c');
  ok('y el enlace cae en su párrafo', !malCae, malCae);

  // El clic derecho de verdad sobre lo elegido.
  const ptTexto = await twc().executeJavaScript(`(() => { scrollTo(0, 0); const n = document.getElementById('a').firstChild; const r = document.createRange(); r.setStart(n, 3); r.setEnd(n, 17); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  twc().focus();
  for (const type of ['mouseDown', 'mouseUp']) twc().sendInputEvent({ type, x: ptTexto.x, y: ptTexto.y, button: 'right', clickCount: 1 });
  ok('el clic derecho sobre un texto elegido lo ofrece, debajo de Copiar', await until(() => js(`(() => { const it = [...document.querySelectorAll('.op-menu:not([data-state="closing"]) .op-menuitem')].map((b) => b.textContent.trim()); const i = it.findIndex((t) => t.startsWith('Copiar enlace al texto')); return i > 0 && it[i - 1].startsWith('Copiar'); })()`), 4000));
  await js(`[...document.querySelectorAll('.op-menu .op-menuitem')].find((b) => b.textContent.includes('Copiar enlace al texto')).click()`);
  ok('y elegirlo copia el enlace a ese texto', await until(() => copiadoTexto === `${BASE}/texto#:~:text=La-,absorci%C3%B3n%20oral,-es%20lenta%20en`), String(copiadoTexto));
  await until(() => js(`!document.querySelector('.op-menu')`));

  // En una página propia de Prism no hay a dónde enlazar.
  ok('una página que no es http ni un archivo no arma enlace', (await (async () => { const antes = copiadoTexto; ctx.tabs.openInternal('historial'); await until(() => ctx.tabs.active.internal === 'historial'); const r = await ctx.tabs.contextAction('text-link', { text: 'algo' }); ctx.tabs.close(ctx.tabs.active.id); return !r && copiadoTexto === antes; })()));
  clipboard.writeText = escribirReal;
  ctx.tabs.close(idTexto);

  console.log('\n9. Descargas');
  ctx.tabs.contextAction('link-save', { url: `${BASE}/archivo.bin` });
  ok('baja el archivo a la carpeta elegida', await until(() => fs.existsSync(path.join(DL, 'archivo.bin')) && ctx.downloads.list()[0]?.state === 'completed', 8000));
  ok('el panel lo lista', await until(() => js(`__prism.S.downloads.some(d => d.filename === 'archivo.bin')`)));
  ctx.tabs.contextAction('link-save', { url: `${BASE}/apunte-largo` });
  const largo = () => ctx.downloads.list().find((d) => d.url.endsWith('/apunte-largo'));
  ok('un nombre larguísimo se recorta sin perder el .pdf', await until(() => largo()?.state === 'completed' && largo().filename.endsWith('.pdf') && largo().filename.length <= 180 && fs.existsSync(largo().path), 8000), largo()?.filename);

  console.log('\n9a. Salir con una descarga en curso');
  ctx.tabs.contextAction('link-save', { url: `${BASE}/lento` });
  const lento = () => ctx.downloads.list().find((d) => d.filename === 'lento.bin');
  ok('arranca a bajar', await until(() => lento()?.state === 'progressing' && lento().received > 0, 8000));
  /* Con un link largo bajo el mouse, el lado izquierdo de la statusbar le
     sacaba lugar al derecho: «1 descarga» se encogía y quedaba debajo del
     porcentaje («1 des64arga»). Cede el link, que se trunca. */
  ok('la statusbar cuenta la descarga', await until(() => js(`!!document.querySelector('#status-right .pr-status__pct.is-on')`), 8000));
  ctx.send('page:hover', `${BASE}/rastreo?${'utm_source=ejemplo&id=1234567890&'.repeat(12)}`);
  const cuenta = () => js(`(() => { const r = document.getElementById('status-right'); const c = r.querySelector('.pr-status__count'); const p = r.querySelector('.pr-status__pct'); const a = c.getBoundingClientRect(), b = p.getBoundingClientRect(); return { ancho: Math.round(a.width), justo: c.scrollWidth <= Math.ceil(a.width) + 1, separados: a.right <= b.left + 0.5, entra: r.scrollWidth <= r.clientWidth + 1 }; })()`);
  // Se mide con el link ya dibujado: antes de que llegue, la cuenta tiene todo el lugar.
  await until(() => js(`[...document.querySelectorAll('#status-left .pr-status__url')].pop()?.textContent.includes('rastreo')`));
  await sleep(450);
  const medida = await cuenta();
  ok('con un link larguísimo bajo el mouse, lo de la derecha no se encoge: «1 descarga» y el porcentaje no se pisan', medida.entra && medida.justo && medida.separados && medida.ancho > 40, JSON.stringify(medida));
  ok('y el link se trunca', await js(`(() => { const u = [...document.querySelectorAll('#status-left .pr-status__url')].pop(); return !!u && u.scrollWidth > u.clientWidth; })()`));
  ctx.send('page:hover', '');
  const titulo = () => js(`document.querySelector('.op-modal__anim:not([data-state="closing"]) .op-modal__title')?.textContent || ''`);
  const boton = (t) => js(`[...document.querySelectorAll('.op-modal__anim:not([data-state="closing"]) .op-modal__foot .op-btn')].find((b) => b.textContent.includes(${JSON.stringify(t)})).click()`);
  const salir = ctx.quit();
  ok('Salir de Prism pregunta antes de cortarla', await until(async () => (await titulo()) === 'Hay una descarga en curso'));
  ok('nombra el archivo y cuánto va', await js(`(() => { const t = document.querySelector('.op-modal__sub').textContent; return t.includes('lento.bin') && /va por el \\d+ %/.test(t); })()`));
  ok('y el foco está en "Seguir bajando": un Enter de más no corta nada', await until(() => js(`document.activeElement?.textContent.trim() === 'Seguir bajando'`)));
  await boton('Seguir bajando');
  await salir;
  ok('"Seguir bajando" no sale y la descarga sigue', !ctx.win.isDestroyed() && lento()?.state === 'progressing');
  ok('el diálogo se va', await until(async () => !(await titulo())));
  const reinicio = js(`window.prism.relaunch()`);
  ok('reiniciar (Ajustes) también pregunta', await until(async () => (await titulo()) === 'Hay una descarga en curso') && await js(`document.querySelector('.op-modal__anim:not([data-state="closing"]) .op-modal__foot').textContent.includes('Reiniciar igual')`));
  await boton('Seguir bajando');
  ok('y no reinicia', (await reinicio) === false && !ctx.win.isDestroyed());
  ok('el diálogo se va', await until(async () => !(await titulo())));
  ctx.downloads.cancel(lento().id);
  ok('cancelada, ya no hay nada que preguntar', await until(() => lento()?.state === 'cancelled' && ctx.downloads.activeCount === 0));
  // El diálogo congela la página de atrás y la suelta cuando terminó de irse.
  ok('la página de atrás vuelve a estar a la vista', await until(() => ctx.tabs.active.view.webContents.executeJavaScript(`document.visibilityState === 'visible'`)));
  ok('con el teclado, como antes de preguntar', await until(() => ctx.tabs.active.view.webContents.isFocused()));

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
  /* La lista es una vista de Prism encima de la página (src/fill.cjs), no un
     elemento de la página: se pregunta acá, no en su DOM. */
  const listaAbierta = () => ctx.fill.shown;
  const domDeLaPagina = (wc) => wc.executeJavaScript(`document.documentElement.children.length`);
  const hijosAntes = await domDeLaPagina(lwc);
  await click('#u');
  ok('enfocar el usuario cuelga la lista de Prism', await until(listaAbierta));
  ok('y no está en la página: no la puede leer, estilar ni tapar', (await domDeLaPagina(lwc)) === hijosAntes && await lwc.executeJavaScript(`!document.documentElement.innerHTML.includes('Prueba')`));
  ok('la lista cae debajo del campo', await (async () => {
    const r = await lwc.executeJavaScript(`(() => { const r = document.getElementById('u').getBoundingClientRect(); return { x: r.left, y: r.bottom }; })()`);
    const b = ctx.tabs.active.view.getBounds();
    // Su lugar de layout (offset), no el rectángulo: mientras entra, el transform la corre unos píxeles.
    const f = ctx.fill.webContents && await ctx.fill.webContents.executeJavaScript(`(() => { const b = document.getElementById('box'); return { x: b.offsetLeft, y: b.offsetTop }; })()`);
    const v = ctx.win.contentView.children.find((c) => c.webContents === ctx.fill.webContents)?.getBounds();
    return !!f && !!v && Math.abs(v.x + f.x - (b.x + r.x)) <= 2 && Math.abs(v.y + f.y - (b.y + r.y + 4)) <= 2;
  })());
  // Una flecha inventada por la página no elige nada (la de la persona sí, abajo).
  await lwc.executeJavaScript(`document.getElementById('u').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`);
  await sleep(150);
  ok('una flecha de la página no mueve la lista', !(await ctx.fill.webContents.executeJavaScript(`!!document.querySelector('.pr-fill__row.is-active')`)));
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
  ok('mostrarla la trae', await until(() => js(`document.getElementById('pp-secret-password').textContent === 'nueva'`)));
  /* El detalle se releva con un fundido también cuando la vista que se va
     nació quieta (debajo de otro calco): su is-quiet le ganaba a la salida, y
     quedaba entera encima de la nueva hasta el plazo de red. */
  await js(`document.querySelector('.pr-pass [data-a=edit]').click()`);
  await until(() => js(`!!document.querySelector('#pp-form') && document.querySelectorAll('#pp-main .pr-pass__view').length === 1`));
  const calco = await js(`new Promise((resolve) => {
    document.querySelector('.pr-pass [data-a=cancel]').click();
    setTimeout(() => {
      const v = document.querySelector('#pp-main .pr-pass__view[data-state=closing]');
      resolve(v ? { quieta: v.classList.contains('is-quiet'), anim: getComputedStyle(v).animationName, op: Number(getComputedStyle(v).opacity) } : null);
    }, 90);
  })`);
  ok('el detalle que se va se esfuma, aunque haya nacido quieto', !!calco && calco.quieta && calco.anim === 'op-dissolve' && calco.op < 0.9, JSON.stringify(calco));
  await until(() => js(`document.querySelectorAll('#pp-main .pr-pass__view').length === 1`));
  /* Y mientras se funde no tapa el canto de la hoja: la línea de luz de
     arriba se apagaba y volvía, y ese lado se veía un píxel más alto que el
     de la lista. Se mide pintado, con el fundido congelado a 60 ms; si el
     plazo de red sacó el calco antes de la foto, se repite. */
  const cantoHoja = async () => {
    const rect = await js(`(() => { const r = document.querySelector('#pp-main').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top), width: 1, height: 1 }; })()`);
    const b = (await win.webContents.capturePage(rect)).toBitmap();
    return Math.round((b[0] + b[1] + b[2]) / 3);
  };
  const cantoQuieto = await cantoHoja();
  let cantoFundiendo = null;
  for (let i = 0; i < 4 && cantoFundiendo == null; i++) {
    const congelado = await js(`new Promise((resolve) => {
      document.querySelector('.pr-pass [data-a=${i % 2 ? 'cancel' : 'edit'}]').click();
      const a = document.querySelector('#pp-main .pr-pass__view[data-state=closing]')?.getAnimations().find((x) => x.animationName === 'op-dissolve');
      if (!a) return resolve(false);
      a.pause();
      a.currentTime = 60;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    })`);
    const v = congelado ? await cantoHoja() : null;
    if (congelado && await js(`!!document.querySelector('#pp-main .pr-pass__view[data-state=closing]')`)) cantoFundiendo = v;
    await until(() => js(`document.querySelectorAll('#pp-main .pr-pass__view').length === 1`));
  }
  ok('y fundiéndose no tapa el canto de la hoja', cantoFundiendo != null && Math.abs(cantoFundiendo - cantoQuieto) <= 3, `${cantoQuieto} → ${cantoFundiendo}`);
  if (await js(`!!document.querySelector('#pp-form')`)) {
    await js(`document.querySelector('.pr-pass [data-a=cancel]').click()`);
    await until(() => js(`!document.querySelector('#pp-form') && document.querySelectorAll('#pp-main .pr-pass__view').length === 1`));
  }

  /* Importar de Proton y borrar la exportación, con el CSV abierto en otro
     programa: el aviso no puede decir que lo borró. */
  const csv = path.join(TMP, 'proton.csv');
  fs.writeFileSync(csv, 'type,name,url,email,username,password,note,totp,createTime,modifyTime,vault\nlogin,Exportada,https://exportada.com/,,yo,clave1,,,,,Personal\n');
  const realOpen = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [csv] });
  await js(`document.getElementById('pp-import').click()`);
  ok('importar muestra el aviso de borrar la exportación', await until(() => js(`!!document.querySelector('.pr-pass__banner [data-a=forget-import]')`)));
  dialog.showOpenDialog = realOpen;
  const soltarCsv = await lockFile(csv);
  await js(`document.querySelector('[data-a=forget-import]').click()`);
  ok('con el CSV tomado, dice que no se pudo', await until(() => js(`document.getElementById('status-left').textContent.includes('No se pudo borrar')`)));
  ok('el aviso se queda y el archivo sigue ahí', fs.existsSync(csv) && await js(`!!document.querySelector('.pr-pass__banner [data-a=forget-import]')`));
  await soltarCsv();
  await js(`document.querySelector('[data-a=forget-import]').click()`);
  ok('suelto, lo borra de verdad', await until(() => !fs.existsSync(csv)));
  ok('y recién ahí el aviso se va y lo confirma', await until(() => js(`!document.querySelector('.pr-pass__banner') && document.getElementById('status-left').textContent.includes('Archivo exportado borrado')`)));
  await V.remove(V.list().find((it) => it.title === 'Exportada').id);

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('Escape cierra el panel', await until(() => js(`!document.querySelector('.pr-pass')`)));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n9b2. Tarjetas');
  /* La de prueba de Stripe: no es de nadie. */
  const tarjetaPrueba = await V.save({ kind: 'card', title: 'Débito de prueba', holder: 'Fran Pavez', number: '4242 4242 4242 4242', expiry: '08/29', cvv: '123' });
  ok('la tarjetaPrueba tampoco queda a la vista en disco', !fs.readFileSync(path.join(process.env.PRISM_DATA, 'vault.json'), 'utf8').includes('4242'));
  /** Un clic de verdad (mouseDown + mouseUp) en un campo; de un iframe, solo dónde está. */
  const clickIn = async (wc, sel, frame = null, { click = true } = {}) => {
    const rect = (code, f) => (f ? f.executeJavaScript(code) : wc.executeJavaScript(code));
    const of = (s) => `(() => { const r = document.querySelector('${s}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;
    const r = await rect(of(sel), frame?.f);
    const o = frame ? await wc.executeJavaScript(`(() => { const r = document.querySelector('${frame.sel}').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`) : { x: 0, y: 0 };
    const at = { x: Math.round(o.x + r.x + r.w / 2), y: Math.round(o.y + r.y + r.h / 2) };
    wc.focus();
    if (click) for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    return { ...at, bottom: Math.round(o.y + r.y + r.h) };
  };
  const conLista = () => ctx.fill.shown;
  /** Un clic de verdad en la primera fila de la lista de Prism (su propia vista). */
  const clicEnLista = async () => {
    const fwc = ctx.fill.webContents;
    const r = await fwc.executeJavaScript(`(() => { const r = document.querySelector('.pr-fill__row').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    fwc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    for (const type of ['mouseDown', 'mouseUp']) fwc.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const elegir = async (wc) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    await sleep(250);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  };

  ctx.tabs.create({ url: `${BASE}/pago` });
  ok('carga el checkout', await until(() => ctx.tabs.active.title === 'Pago' && !ctx.tabs.active.loading));
  const cwc = ctx.tabs.active.view.webContents;
  await clickIn(cwc, '#num');
  ok('enfocar el número cuelga la lista de tarjetas', await until(() => conLista(cwc)));
  await elegir(cwc);
  const valores = () => cwc.executeJavaScript(`['nom', 'num', 'mes', 'anio', 'cvv', 'dni'].map((id) => document.getElementById(id).value).join('|')`);
  ok('elegir completa titular, número, vencimiento (en selects) y código', await until(async () => (await valores()) === 'Fran Pavez|4242424242424242|08|2029|123|'), await valores());
  ok('y anota el último pago', await until(() => !!V.get(tarjetaPrueba.id).lastUsedAt));
  await clickIn(cwc, '#pagar');
  await sleep(2500);
  ok('un código en un campo de contraseña no ofrece guardarse', await js(`!document.querySelector('.pr-offer')`));
  ctx.tabs.close(ctx.tabs.active.id);

  ctx.tabs.create({ url: `${BASE}/pago-iframe` });
  ok('carga el checkout con iframes', await until(() => ctx.tabs.active.title === 'Pago iframe' && !ctx.tabs.active.loading));
  const iwc = ctx.tabs.active.view.webContents;
  const frameDe = (p) => iwc.mainFrame.framesInSubtree.find((f) => f.url.includes(p));
  ok('los dos iframes cargan (localhost y ads.localhost)', await until(async () => {
    const a = frameDe('/campos'); const b = frameDe('/anuncio');
    return !!a && !!b && await a.executeJavaScript('!!document.getElementById("c")') && await b.executeJavaScript('!!document.getElementById("n")');
  }, 8000));
  const pay = { f: frameDe('/campos'), sel: '#pay' };
  /* sendInputEvent no lleva un clic adentro de un iframe de otro proceso:
     enfoca el <iframe> y nada más. Así que el clic va (le da el foco al
     iframe) y el campo se enfoca por script. El clic en la lista y las
     teclas, que son los que tienen que ser de verdad, van por sendInputEvent. */
  const enfocar = () => pay.f.executeJavaScript(`document.getElementById('n').focus(); true`);
  await clickIn(iwc, '#n', pay);
  await sleep(150);
  await enfocar();
  ok('el campo del iframe cuelga la lista en la página de arriba', await until(() => conLista(iwc)));
  await sleep(250);
  await clicEnLista();
  const enIframe = () => pay.f.executeJavaScript(`['n', 'e', 'c'].map((id) => document.getElementById(id).value).join('|')`);
  ok('un clic en la lista completa número, vencimiento y código en el iframe', await until(async () => (await enIframe()) === '4242424242424242|08 / 29|123'), await enIframe());
  ok('y el titular en la página', await iwc.executeJavaScript(`document.getElementById('nom').value`) === 'Fran Pavez');
  ok('el iframe de un tercero no recibe nada', await frameDe('/anuncio').executeJavaScript(`document.getElementById('n').value`) === '');
  await pay.f.executeJavaScript(`['n', 'e', 'c'].forEach((id) => { document.getElementById(id).value = ''; }); document.activeElement.blur(); true`);
  await sleep(300);
  await enfocar();
  ok('volver al campo la cuelga de nuevo', await until(() => conLista(iwc)));
  ctx.tabs.close(ctx.tabs.active.id);

  ctx.tabs.create({ url: `${BASE}/pago-iframe-mismo` });
  ok('carga el checkout con un iframe del mismo origen', await until(() => ctx.tabs.active.title === 'Pago mismo' && !ctx.tabs.active.loading));
  const mwc = ctx.tabs.active.view.webContents;
  const mismo = () => mwc.mainFrame.framesInSubtree.find((f) => f.url.includes('/campos'));
  await until(async () => !!mismo() && await mismo().executeJavaScript('!!document.getElementById("c")'));
  await sleep(600);   // que la pestaña nueva termine de pintarse: antes, el clic no encuentra el iframe
  await clickIn(mwc, '#n', { f: mismo(), sel: '#pay' });
  ok('el clic en el campo del iframe cuelga la lista arriba', await until(() => conLista(mwc)), JSON.stringify({
    arriba: await mwc.executeJavaScript('document.activeElement?.tagName'), adentro: await mismo().executeJavaScript('document.activeElement?.id'),
    url: mismo().url, cards: V.cards().length, foco: mwc.isFocused(),
  }));
  await elegir(mwc);
  const enMismo = () => mismo().executeJavaScript(`['n', 'e', 'c'].map((id) => document.getElementById(id).value).join('|')`);
  ok('las flechas y el Enter desde el iframe eligen y completan', await until(async () => (await enMismo()) === '4242424242424242|08 / 29|123'), await enMismo());
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
  const r3b = await desde(`__ipc.invoke('pass:backup-setup', 'C:/', 'una clave larga')`);
  ok('ni prender un respaldo de la bóveda con su propia clave', r3b?.ok === false && ctx.passwords.backup.state().on === false, JSON.stringify(r3b));
  const rt = await desde(`__ipc.invoke('pay:query').then((l) => __ipc.invoke('pay:fill', l[0]?.id).then((r) => ({ n: l.length, r })))`);
  ok('una página puede ver qué tarjetas hay, pero no completarlas sin un clic de la persona', rt?.n === 1 && rt.r === false, JSON.stringify(rt));
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
  /* Una llamada en segundo plano con todos callados no suena: igual no se
     duerme (dormirla corta la llamada). */
  const enLlamada = ctx.tabs.active;
  const sleepAntes = ctx.settings.sleepTabs;
  await ctx.saveSettings({ sleepTabs: 30 });
  const otraId = ctx.tabs.create({ url: `${BASE}/dos` });
  await until(() => ctx.tabs.active.title === 'Página dos');
  enLlamada.lastSeen = Date.now() - 31 * 60 * 1000;
  await ctx.tabs.sweep();
  ok('una pestaña en una llamada no se duerme aunque haga rato que no la mirás', !!enLlamada.view && enLlamada.usesMedia === true);
  ctx.tabs.close(otraId);
  await ctx.saveSettings({ sleepTabs: sleepAntes });
  await until(() => ctx.tabs.active === enLlamada);
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

  /* Una pregunta es de la pestaña que la hizo: si esa pestaña se cierra, el
     diálogo se va solo (antes quedaba abierto, esperando), y la que esperaba
     su turno en la fila ni aparece. */
  console.log('\n10b2. Una pregunta se va con su pestaña');
  const volver = ctx.tabs.active.id;
  const idA = ctx.tabs.create({ url: llamada });
  ok('la pestaña nueva pregunta', await pregunta());
  const idB = ctx.tabs.create({ url: `${BASE.replace('127.0.0.1', 'localhost')}/llamada` });
  await sleep(1500);                     // la segunda ya preguntó: espera en la fila
  ctx.tabs.close(idB);
  ctx.tabs.close(idA);
  ok('cerrar la pestaña cierra su pregunta', await until(() => js(`!document.querySelector('.op-scrim')`)));
  await sleep(700);
  ok('y la que esperaba en la fila no aparece', !(await js(`!!document.querySelector('.op-modal .pr-ask')`)));
  ctx.tabs.activate(volver);

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

  console.log('\n10d. Lo que un sitio abre solo');
  const OTRO = BASE.replace('127.0.0.1', 'localhost');
  /** Un clic de verdad en el cromo, en el centro de lo que diga el selector. */
  const clicCromo = async (sel) => {
    const p = await js(`(() => { const r = document.querySelector(\`${sel}\`).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  /** Un clic de verdad en la página activa, en el centro de lo que diga el selector. */
  const clicPagina = async (sel) => {
    const pw = ctx.tabs.active.view.webContents;
    const p = await pw.executeJavaScript(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    pw.focus();
    for (const type of ['mouseDown', 'mouseUp']) pw.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  await ctx.tabs.navigate(ctx.tabs.active.id, `${OTRO}/geo`);
  ok('un sitio nuevo pregunta por la ubicación', await pregunta());
  ok('el foco arranca en el diálogo, no en "Permitir"', await until(() => js(`document.activeElement?.classList.contains('op-modal')`), 1000));
  await clicCromo('.op-modal__foot .op-btn--primary');
  await sleep(250);
  ok('un clic en "Permitir" apenas aparece no cuenta', await js(`!!document.querySelector('.op-modal .pr-ask')`) && !ctx.settings.permissions?.[OTRO]?.geolocation);
  await sleep(600);
  await clicCromo('.op-modal__foot .op-btn:not(.op-btn--primary)');
  ok('pasado el armado, el clic sí cuenta', await until(() => ctx.settings.permissions?.[OTRO]?.geolocation === 'deny'), JSON.stringify(ctx.settings.permissions?.[OTRO]));
  await until(() => js(`!document.querySelector('.op-scrim')`));

  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/externo`);
  await until(() => ctx.tabs.active.title === 'Externo' && !ctx.tabs.active.loading);
  await sleep(300);
  await clicPagina('#ms');
  await sleep(900);
  ok('un link «search-ms:» se niega sin preguntar', !(await js(`!!document.querySelector('.op-modal .pr-ask')`)) && !Object.keys(ctx.settings.permissions?.[BASE] || {}).some((k) => k.startsWith('openExternal')));
  await clicPagina('#mail');
  ok('un «mailto:» pregunta, y dice cuál es', await pregunta() && await js(`document.querySelector('.pr-ask__text').textContent.includes('«mailto:»')`), await js(`document.querySelector('.pr-ask__text')?.textContent`));
  await sleep(700);
  await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].find((b) => b.textContent.includes('Bloquear')).click()`);
  ok('y se recuerda por esquema: «no» a mailto: no dice nada de los demás', await until(() => ctx.settings.permissions?.[BASE]?.['openExternal:mailto'] === 'deny') && !ctx.settings.permissions?.[BASE]?.openExternal);
  await until(() => js(`!document.querySelector('.op-scrim')`));

  const { BrowserWindow } = require('electron');
  const ventanas = BrowserWindow.getAllWindows().length;
  const pestanas = ctx.tabs.list.length;
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/abre`);
  await until(() => ctx.tabs.active.title === 'Abre' && !ctx.tabs.active.loading);
  await sleep(1200);
  ok('sin un clic, ni ventana ni pestaña nueva', BrowserWindow.getAllWindows().length === ventanas && ctx.tabs.list.length === pestanas,
    `${ventanas} → ${BrowserWindow.getAllWindows().length} ventanas, ${pestanas} → ${ctx.tabs.list.length} pestañas`);
  const aviso = ctx.win.contentView.children.find((v) => v.webContents?.getURL().endsWith('card.html'));
  ok('y la tarjeta avisa que la bloqueó', ctx.card.shown && !!aviso && (await aviso.webContents.executeJavaScript('document.body.innerText')).includes('Ventana emergente bloqueada'));
  await clicPagina('#b');
  ok('con un clic de verdad, la ventana se abre', await until(() => BrowserWindow.getAllWindows().length === ventanas + 1));
  const emergente = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed() && w.webContents.getURL().includes('/dos'));
  ok('y su título dice primero de qué sitio es', await until(() => emergente?.getTitle().startsWith('127.0.0.1 · ')), emergente?.getTitle());
  emergente?.destroy();

  console.log('\n10e. Compartir la pantalla');
  /* getDisplayMedia llega al manejador de permisos como "media" sin tipos: antes
     se negaba ahí y el selector propio ni aparecía (Meet no podía presentar). */
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/presentar`);
  await until(() => ctx.tabs.active.title === 'Presentar' && !ctx.tabs.active.loading);
  await sleep(300);
  await clicPagina('#b');
  ok('presentar abre el selector de Prism', await until(() => js(`!!document.querySelector('.op-modal .pr-source')`), 8000));
  await sleep(700);
  await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].find((b) => b.textContent.includes('Compartir')).click()`);
  const presenta = () => ctx.tabs.active.view.webContents.executeJavaScript('window.__r || null');
  ok('y compartir le da el video a la página', await until(async () => String(await presenta()).startsWith('stream video'), 6000), String(await presenta()));
  ok('la pestaña que presenta no se duerme', ctx.tabs.active.usesMedia === true);
  await until(() => js(`!document.querySelector('.op-scrim')`));

  console.log('\n11. Páginas propias');
  for (const p of ['historial', 'favoritos', 'descargas', 'ajustes']) {
    ctx.tabs.openInternal(p);
    ok(`prism://${p} se dibuja`, await until(() => js(`!!document.querySelector('.pr-view[data-page="${p}"] .pr-head__title')`)));
    if (p === 'historial') ok('el historial lista lo visitado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="historial"] .pr-row').length >= 2`)));
    if (p === 'favoritos') ok('los favoritos listan el guardado', await until(() => js(`document.querySelectorAll('.pr-view[data-page="favoritos"] .pr-row').length === 1`)));
  }

  /* Cambiar de pestaña desarmaba la página propia: al volver entraba de cero,
     arriba de todo y sin la búsqueda. Queda guardada, como la dejaste. */
  const vista = (p) => `document.querySelector('.pr-view[data-page="${p}"]:not(.is-parked):not([data-state="closing"])')`;
  const ajustesId = ctx.tabs.active.id;
  await js(`(() => { const v = ${vista('ajustes')}; v.__marca = 'la misma'; v.querySelector('.pr-view__scroll').scrollTop = 600; return true; })()`);
  await sleep(200);
  const scrollAntes = await js(`${vista('ajustes')}.querySelector('.pr-view__scroll').scrollTop`);
  ctx.tabs.openInternal('historial');
  await until(() => ctx.tabs.active.internal === 'historial');
  const histId = ctx.tabs.active.id;
  await until(() => js(`!!${vista('historial')}`));
  await js(`(() => { const v = ${vista('historial')}; v.__marca = 'la misma'; const q = v.querySelector('#h-q'); q.value = 'dos'; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(500);
  ctx.tabs.activate(ajustesId);
  ok('volver a Ajustes muestra la misma página, no una armada de nuevo', await until(() => js(`${vista('ajustes')}?.__marca === 'la misma'`)));
  ok('con el scroll donde estaba', scrollAntes > 0 && (await js(`${vista('ajustes')}.querySelector('.pr-view__scroll').scrollTop`)) === scrollAntes, `${scrollAntes}`);
  ok('y sin volver a entrar', await until(() => js(`${vista('ajustes')}.getAnimations().filter((a) => a instanceof CSSAnimation).length === 0`)));
  ctx.tabs.activate(histId);
  ok('el Historial vuelve con su búsqueda', await until(() => js(`${vista('historial')}?.__marca === 'la misma' && ${vista('historial')}.querySelector('#h-q').value === 'dos'`)));
  ctx.tabs.close(histId);
  ok('al cerrar su pestaña, la página guardada se va', await until(() => js(`!document.querySelector('.pr-view[data-page="historial"]')`)));
  ctx.tabs.activate(ajustesId);
  await until(() => js(`!!${vista('ajustes')}`));
  await js(`${vista('ajustes')}.querySelector('.pr-view__scroll').scrollTop = 0`);

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

  /* Un ajuste cambiado desde afuera (el switch del escudo) repinta Ajustes
     entera. Los segmentados tienen que nacer en su lugar (antes viajaban desde
     la izquierda en cada repintado) y el switch que cambió, moverse en vez de
     saltar. Se muestrea cuadro por cuadro: a ojo no se distingue. */
  const previoSleep = ctx.settings.sleepTabs;
  await sleep(700);                      // que pase la ventana en que Ajustes ignora los avisos
  await ctx.saveSettings({ sleepTabs: 30 });
  await sleep(700);
  const muestreo = js(`new Promise((res) => {
    const page = document.querySelector('.pr-view[data-page="ajustes"]');
    const seg = new Set(); const knob = new Set();
    const t0 = performance.now();
    const tick = () => {
      const cs = getComputedStyle(page.querySelector('#s-sleep'), '::before');
      seg.add(cs.transform + ' ' + cs.width);
      knob.add(getComputedStyle(page.querySelector('[data-toggle="askDownload"]'), '::after').transform);
      if (performance.now() - t0 < 700) return requestAnimationFrame(tick);
      res({ seg: [...seg], knob: [...knob] });
    };
    requestAnimationFrame(tick);
  })`);
  await sleep(80);
  await ctx.saveSettings({ askDownload: !antesAsk });
  const repinte = await muestreo;
  ok('un ajuste cambiado desde afuera no mueve los segmentados', repinte.seg.length === 1, JSON.stringify(repinte.seg));
  ok('y el switch que cambió se desliza, no salta', repinte.knob.length > 2, JSON.stringify(repinte.knob));
  await ctx.saveSettings({ askDownload: antesAsk, sleepTabs: previoSleep });

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

  console.log('\n11b. Capturas');
  const { nativeImage } = require('electron');
  const medir = (file) => file && nativeImage.createFromPath(file).getSize();
  const tarjeta = () => ctx.win.contentView.children.find((v) => v.webContents.getURL().endsWith('card.html'));
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/larga`);
  await until(() => ctx.tabs.active.title === 'Larga');
  const larga = medir(await ctx.capture.run('full'));
  ok('la entera mide lo que mide la página', larga?.height === 5000, JSON.stringify(larga));
  const card = tarjeta();
  ok('avisa con la tarjeta de la esquina', !!card && await until(() => card.webContents.executeJavaScript(`!!document.querySelector('.pr-card--done .pr-card__thumb img')`)));
  const kids = ctx.win.contentView.children;
  ok('arriba de la página', kids[kids.length - 1] === card);
  const cardRect = card.getBounds();
  const pageRect = ctx.tabs.pageBounds();
  ok('en la esquina de abajo a la derecha', cardRect.x + cardRect.width > pageRect.x + pageRect.width - 60 && cardRect.y + cardRect.height > pageRect.y + pageRect.height - 60 && cardRect.x > pageRect.x + pageRect.width / 2, JSON.stringify({ cardRect, pageRect }));

  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/caja`);
  await until(() => ctx.tabs.active.title === 'Caja');
  const cajaWc = ctx.tabs.active.view.webContents;
  await cajaWc.executeJavaScript(`document.getElementById('page').scrollTop = 1200`);
  const estado = () => cajaWc.executeJavaScript(`JSON.stringify([document.getElementById('page').scrollTop, ...[document.documentElement, document.body, document.getElementById('page')].map((e) => e.getAttribute('style'))])`);
  const cajaAntes = await estado();
  const caja = medir(await ctx.capture.run('full'));
  ok('una página que scrollea en una caja sale entera', caja?.height >= 3000, JSON.stringify(caja));
  const cajaDespues = await estado();
  ok('y queda como estaba: scroll y estilos', cajaDespues === cajaAntes && cajaAntes.startsWith('[1200,'), `${cajaAntes} → ${cajaDespues}`);
  const vis = medir(await ctx.capture.run('visible'));
  ok('lo visible mide la vista', vis?.height === ctx.tabs.active.view.getBounds().height, JSON.stringify(vis));
  ctx.tabs.hold(true);
  ok('un menú que se abre aparta la tarjeta', await until(() => !ctx.card.shown && tarjeta().getBounds().x < 0));
  ctx.tabs.hold(false);

  console.log('\n11c. Barra de favoritos');
  ctx.library.addBookmark({ url: `${BASE}/dos`, title: 'Página dos' });
  ctx.send('library:changed');
  ok('muestra los favoritos', await until(() => js(`[...document.querySelectorAll('.pr-bm')].some((b) => b.textContent.includes('Página dos'))`)));
  const paginaTop = () => js(`Math.round(document.getElementById('page').getBoundingClientRect().top)`);
  const conBarra = await paginaTop();
  const vistaEnSuLugar = async () => {
    const top = await paginaTop();
    const v = ctx.tabs.active.view?.getBounds();
    return !v || (v.x >= 0 && v.y === top);
  };
  ctx.command('bookmarks:bar');
  ok('Ctrl+Mayús+B la oculta y la página sube lo que medía', await until(async () => (await paginaTop()) === conBarra - 30 && await vistaEnSuLugar()), String(await paginaTop()));
  ok('y se guarda', ctx.settings.bookmarksBar === false);
  ctx.command('bookmarks:bar');
  ok('otra vez la muestra, con la página en su lugar', await until(async () => (await paginaTop()) === conBarra && await vistaEnSuLugar()));
  ok('sin foto del congelado olvidada', await until(() => js(`!document.getElementById('freeze').classList.contains('is-on') && !document.getElementById('page').classList.contains('is-shifting')`)));

  // Arrastrar el primero al segundo lugar, con el mouse de verdad.
  ctx.library.addBookmark({ url: `${BASE}/titulo-largo`, title: 'Otra' });
  ctx.send('library:changed');
  // Que el nuevo ya esté primero en la barra, y que la barra esté quieta (sin nada
  // entrando ni viajando a su lugar): medir antes arrastraba sobre la fila vieja.
  await until(() => js(`document.querySelector('.pr-bm')?.textContent.trim() === 'Otra' && !document.querySelector('.pr-bm.is-entering, .pr-bm.is-flipping')`));
  const primero = ctx.library.listBookmarks()[0].url;
  const [bx, by, bx1] = await js(`(() => { const [a, b] = document.querySelectorAll('.pr-bm'); const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); return [Math.round(ra.x + ra.width / 2), Math.round(ra.y + ra.height / 2), Math.round(rb.x + rb.width + 12)]; })()`);
  const urlAntes = ctx.tabs.active.url;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bx, y: by, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bx + ((bx1 - bx) * i) / 8), y: by, button: 'left', modifiers: ['leftButtonDown'] });
    await sleep(30);
  }
  // Con el botón apretado (:active) el que se arrastra tiene que seguir opaco: no deja ver al de abajo.
  const fondo = await js(`(() => { const e = document.querySelector('.pr-bm.is-dragging'); return e ? getComputedStyle(e).backgroundColor : ''; })()`);
  ok('el que se arrastra es opaco', !!fondo && !/rgba\(|\/\s*0?\.\d/.test(fondo), fondo);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bx1, y: by, button: 'left', clickCount: 1 });
  ok('arrastrar un favorito lo cambia de lugar', await until(() => ctx.library.listBookmarks()[1]?.url === primero),
    JSON.stringify({ orden: ctx.library.listBookmarks().map((x) => x.title), primero, desde: [bx, by, bx1], barra: await js(`[...document.querySelectorAll('.pr-bm')].map((e) => e.textContent.trim() + '|' + e.className + '|' + Math.round(e.getBoundingClientRect().x))`) }));
  ok('y soltarlo no lo abre', ctx.tabs.active.url === urlAntes);

  /* El menú de la flecha: los que no entran también se arrastran, adentro del
     menú para reordenarlos y afuera hasta la barra para ponerlos a la vista. */
  for (let i = 1; i <= 14; i++) ctx.library.addBookmark({ url: `${BASE}/?n=${i}`, title: `Favorito número ${i} con un nombre largo` });
  ctx.send('library:changed');
  ok('los que no entran van a la flecha', await until(() => js(`!document.getElementById('bmbar-more').hidden && !document.querySelector('.pr-bm.is-entering, .pr-bm.is-flipping')`)));
  await sleep(350);
  const centro = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  const clic = async ([x, y]) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); };
  const arrastrar = async ([x0, y0], [x1, y1], pasos = 10) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let i = 1; i <= pasos; i++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / pasos), y: Math.round(y0 + ((y1 - y0) * i) / pasos), button: 'left', modifiers: ['leftButtonDown'] });
      await sleep(30);
    }
  };
  const soltar = ([x, y]) => win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  const ids = () => ctx.library.listBookmarks().map((b) => b.id);
  const menuAbierto = () => js(`document.querySelectorAll('.pr-bmmenu:not([data-state="closing"]) .pr-bmmenu__item').length`);

  await clic(await centro('#bmbar-more'));
  ok('la flecha abre el menú de los escondidos', await until(async () => (await menuAbierto()) > 2));
  const filasMenu = await js(`[...document.querySelectorAll('.pr-bmmenu__item')].map((r) => { const b = r.getBoundingClientRect(); return { id: r.dataset.id, x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2), h: Math.round(b.height) }; })`);
  const [filaA, filaB] = filasMenu;
  // La primera fila, un lugar y medio para abajo: cae después de la segunda.
  await arrastrar([filaA.x, filaA.y], [filaA.x, Math.round(filaA.y + filaA.h * 1.4)]);
  ok('la fila que se arrastra va opaca', await js(`(() => { const e = document.querySelector('.pr-bmmenu__item.is-dragging'); return !!e && !/rgba\\(|\\/\\s*0?\\.\\d/.test(getComputedStyle(e).backgroundColor); })()`));
  soltar([filaA.x, Math.round(filaA.y + filaA.h * 1.4)]);
  ok('arrastrar adentro del menú los cambia de lugar', await until(() => { const o = ids(); return o.indexOf(filaA.id) === o.indexOf(filaB.id) + 1; }), JSON.stringify(ctx.library.listBookmarks().map((b) => b.title)));
  ok('y el menú sigue abierto, con las filas en su lugar', await until(async () => (await menuAbierto()) > 2 && (await js(`[...document.querySelectorAll('.pr-bmmenu__item')].map((r) => r.dataset.id).indexOf(${JSON.stringify(filaA.id)})`)) === 1 && await js(`![...document.querySelectorAll('.pr-bmmenu__item')].some((r) => r.style.transform)`)));

  // Ahora la primera del menú (la que era segunda), afuera, hasta el principio de la barra.
  const [bx0, by0] = await js(`(() => { const r = document.querySelector('.pr-bm:not([hidden])').getBoundingClientRect(); return [Math.round(r.x + 6), Math.round(r.y + r.height / 2)]; })()`);
  const fila0 = await js(`(() => { const r = document.querySelector('.pr-bmmenu__item').getBoundingClientRect(); return [Math.round(r.x + 40), Math.round(r.y + r.height / 2)]; })()`);
  await arrastrar(fila0, [bx0, by0], 14);
  ok('afuera del menú la sigue un fantasma', await js(`!!document.querySelector('.pr-bm--ghost:not([data-state="closing"])')`));
  ok('y la barra le abre un hueco al principio', await until(() => js(`/translateX\\(\\d/.test(document.querySelector('.pr-bm:not([hidden])').style.transform)`)));
  soltar([bx0, by0]);
  ok('soltarlo en la barra lo pone a la vista ahí', await until(() => ids()[0] === filaB.id), JSON.stringify(ctx.library.listBookmarks().slice(0, 3).map((b) => b.title)));
  ok('primero en la barra', await until(() => js(`document.querySelector('.pr-bm:not([hidden]):not([data-state="closing"])')?.dataset.id === ${JSON.stringify(filaB.id)} && !document.querySelector('.pr-bm.is-entering, .pr-bm.is-flipping')`)));
  ok('el menú se cierra y no queda ningún fantasma', await until(async () => (await menuAbierto()) === 0 && await js(`!document.querySelector('.pr-bm--ghost')`)));
  ok('ni la barra corrida', await until(() => js(`![...document.querySelectorAll('.pr-bm')].some((b) => b.style.transform) && !document.getElementById('bmbar').classList.contains('is-sorting')`)));

  // Un clic, sin arrastrar, sigue abriendo el favorito.
  await sleep(300);
  await clic(await centro('#bmbar-more'));
  await until(async () => (await menuAbierto()) > 0);
  const abre = await js(`document.querySelector('.pr-bmmenu__item').dataset.id`);
  await clic(await centro('.pr-bmmenu__item'));
  const urlAbre = ctx.library.listBookmarks().find((b) => b.id === abre)?.url;
  ok('un clic en el menú abre el favorito', await until(() => ctx.tabs.active.url === urlAbre), `${ctx.tabs.active.url} vs ${urlAbre}`);
  ok('y lo cierra', await until(async () => (await menuAbierto()) === 0));

  /* Un favorito cuyo ícono no carga muestra el mundito, y no lo pierde cada
     vez que la barra se reacomoda (antes reintentaba el ícono y, mientras
     tanto, quedaba vacío). */
  ctx.library.addBookmark({ url: `${BASE}/?roto`, title: 'Ícono roto', favicon: `${BASE}/icono-roto.ico` });
  ctx.send('library:changed');
  const iconoRoto = () => js(`(() => { const b = [...document.querySelectorAll('.pr-bm:not([data-state="closing"])')].find((x) => x.textContent.trim() === 'Ícono roto'); const i = b?.querySelector('img, .op-icon'); return !i ? 'nada' : i.tagName === 'IMG' ? 'img' : 'mundito'; })()`);
  ok('un ícono que no carga cae al mundito', await until(async () => (await iconoRoto()) === 'mundito', 4000), await iconoRoto());
  const todos = ids();
  ctx.library.moveBookmark(todos[todos.length - 1], 0);   // reordenar repinta la barra entera
  ctx.send('library:changed');
  const visto = new Set();
  for (let t = 0; t < 12; t++) { visto.add(await iconoRoto()); await sleep(80); }
  ok('y al reacomodar la barra no pestañea', visto.size === 1 && visto.has('mundito'), [...visto].join(', '));

  console.log('\n11d. Incógnito');
  const g = ctx.openIncognito();
  const gjs = (c) => g.win.webContents.executeJavaScript(c);
  ok('Ctrl+Mayús+N abre la ventana de incógnito', await until(() => g.win && !g.win.isDestroyed() && g.tabs.active?.internal === 'nueva', 8000));
  await until(() => gjs(`!document.getElementById('boot-splash') && !!window.__prism`), 8000);
  ok('arranca con el foco en la barra de direcciones, para escribir de una', await until(() => gjs(`document.activeElement?.id === 'omni-input'`)));
  ok('con su fantasmita en la barra', await until(() => gjs(`getComputedStyle(document.querySelector('.pr-incognito')).display === 'flex'`)));
  ok('y la pestaña nueva de incógnito', await until(() => gjs(`!!document.querySelector('.pr-view[data-page="nueva"] .pr-incog') && !document.getElementById('ntp-tiles')`)));
  ok('la normal no lleva fantasma', await js(`getComputedStyle(document.querySelector('.pr-incognito')).display === 'none'`));
  ok('el título lo dice', /Incógnito/.test(g.win.getTitle()), g.win.getTitle());
  ok('su sesión es otra y en memoria', g.web !== ctx.web && !g.web.isPersistent());
  ok('otro Ctrl+Mayús+N trae la misma', ctx.openIncognito() === g);
  const gTabs = await gjs(`window.prism.tabs.state().then((s) => s.tabs.length)`);
  ok('cada ventana ve sus pestañas', gTabs === g.tabs.list.length && gTabs !== ctx.tabs.list.length, `${gTabs} vs ${ctx.tabs.list.length}`);

  // Cookies: lo de la normal no se ve en incógnito, ni al revés.
  await ctx.tabs.navigate(ctx.tabs.active.id, `${BASE}/dos`);
  await until(() => ctx.tabs.active.title === 'Página dos');
  await ctx.tabs.active.view.webContents.executeJavaScript(`document.cookie = 'normal=1; path=/'`);
  await g.tabs.navigate(g.tabs.active.id, `${BASE}/dos?incognito=1`);
  ok('navega en incógnito', await until(() => g.tabs.active.title === 'Página dos'));
  const gv = g.tabs.active.view.webContents;
  ok('no ve las cookies de la normal', !(await gv.executeJavaScript('document.cookie')).includes('normal'));
  await gv.executeJavaScript(`document.cookie = 'fantasma=1; path=/'`);
  ok('y la normal no ve las suyas', !(await ctx.tabs.active.view.webContents.executeJavaScript('document.cookie')).includes('fantasma'));
  await sleep(200);
  ok('no anota historial', !ctx.library.listVisits({ query: 'incognito' }).some((v) => v.url.includes('incognito=1')));
  await ctx.tabs.writeSession();
  ok('ni queda en la sesión para el reinicio', !JSON.stringify(await ctx.sessionDoc.read()).includes('incognito=1'));
  g.command('open:historial');
  ok('el historial se abre en la normal', await until(() => ctx.tabs.list.some((t) => t.internal === 'historial')) && !g.tabs.list.some((t) => t.internal === 'historial'));

  g.win.close();
  ok('cerrarla la termina', await until(() => globalThis.__prismGhost() === null));
  ok('y cierra sus pestañas de verdad', gv.isDestroyed());
  ok('la normal sigue', !win.isDestroyed() && ctx.tabs.list.length > 0);
  const g2 = ctx.openIncognito();
  ok('una nueva es otra sesión', g2 !== g && g2.web !== g.web);
  await until(() => g2.tabs.active?.internal === 'nueva', 8000);
  await g2.tabs.navigate(g2.tabs.active.id, `${BASE}/dos`);
  await until(() => g2.tabs.active.title === 'Página dos');
  ok('sin las cookies de la anterior', !(await g2.tabs.active.view.webContents.executeJavaScript('document.cookie')).includes('fantasma'));
  g2.win.close();
  await until(() => globalThis.__prismGhost() === null);

  console.log('\n11e. La ventanita');
  const { BaseWindow } = require('electron');
  const pipWin = () => BaseWindow.getAllWindows().find((w) => w.getTitle() === 'Prism · Ventanita') || null;
  ctx.tabs.create({ url: `${BASE}/video` });
  await until(() => ctx.tabs.active.title === 'Video');
  const vt = ctx.tabs.active;
  const vwc = vt.view.webContents;
  await until(() => vwc.executeJavaScript(`!document.getElementById('v').paused && document.getElementById('v').videoWidth > 0`), 8000);
  // El botón: con el mouse sobre el video aparece en su borde derecho, y tocarlo lo saca.
  const vr = await vwc.executeJavaScript(`(() => { const r = document.getElementById('v').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
  const vy = Math.round((vr[1] + vr[3]) / 2);
  vwc.sendInputEvent({ type: 'mouseMove', x: Math.round((vr[0] + vr[2]) / 2), y: vy });
  await sleep(250);
  const bx2 = Math.round(vr[2] - 26);
  vwc.sendInputEvent({ type: 'mouseMove', x: bx2, y: vy });
  ok('con el mouse sobre el video aparece el botón', await until(() => vwc.executeJavaScript(`document.elementFromPoint(${bx2}, ${vy})?.tagName === 'PRISM-PIP'`)));
  vwc.sendInputEvent({ type: 'mouseDown', x: bx2, y: vy, button: 'left', clickCount: 1 });
  vwc.sendInputEvent({ type: 'mouseUp', x: bx2, y: vy, button: 'left', clickCount: 1 });
  ok('tocarlo abre la ventanita', await until(() => ctx.pip.current?.tabId === vt.id && pipWin()?.isVisible() && pipWin().getOpacity() > 0.99 && pipWin().getBounds().x > -10000, 5000));
  const pw = pipWin();
  ok('siempre arriba', pw.isAlwaysOnTop());
  ok('la página se mudó: no está en la ventana grande', !win.contentView.children.includes(vt.view) && pw.contentView.children[0] === vt.view);
  const [pcw, pch] = pw.getContentSize();
  const pvb = vt.view.getBounds();
  ok('y llena la ventanita, con los controles encima', pvb.width === pcw && pvb.height === pch && pw.contentView.children[1].getBounds().width === pcw, JSON.stringify({ pvb, pcw, pch }));
  ok('la ventanita tiene la forma del video', Math.abs(pcw / pch - 16 / 9) < 0.02, `${pcw}x${pch}`);
  ok('el video la llena (pantalla completa adentro de su página)', await vwc.executeJavaScript(`document.fullscreenElement?.id === 'v'`));
  ok('la ventana grande no se pone en pantalla completa', !win.isFullScreen() && !ctx.tabs.fullscreen);
  ok('la hoja de la pestaña dice que está en la ventanita', await until(() => js(`!!document.querySelector('#internal .pr-view[data-page="pip"]:not([data-state="closing"])')`)));
  ok('y la pestaña no se duerme mientras tanto', vt.pip === true);
  const pui = pw.contentView.children[1].webContents;
  await until(() => pui.executeJavaScript(`!!document.querySelector('[data-act="toggle"]')`));
  await pui.executeJavaScript(`document.querySelector('[data-act="toggle"]').click()`);
  ok('la pausa de la ventanita pausa el video', await until(() => vwc.executeJavaScript(`document.getElementById('v').paused`)));
  ok('y los controles se enteran', await until(() => pui.executeJavaScript(`document.getElementById('pip').classList.contains('is-paused')`)));
  await pui.executeJavaScript(`document.querySelector('[data-act="toggle"]').click()`);
  await until(() => vwc.executeJavaScript(`!document.getElementById('v').paused`));
  await js(`document.querySelector('#internal .pr-view[data-page="pip"] [data-a="back"]').click()`);
  ok('"Traer de vuelta" la devuelve a su pestaña', await until(() => !ctx.pip.current && win.contentView.children.includes(vt.view), 5000));
  ok('en su lugar exacto', JSON.stringify(vt.view.getBounds()) === JSON.stringify(ctx.tabs.rectFor(vt)), JSON.stringify(vt.view.getBounds()));
  ok('fuera de la pantalla completa y sonando', await vwc.executeJavaScript(`!document.fullscreenElement && !document.getElementById('v').paused`));
  ok('y la ventanita se fue', await until(() => !pipWin()));

  // Ctrl+Mayús+P: el video que suena. Si suena el del iframe, sale ese.
  await vwc.executeJavaScript(`document.getElementById('v').pause()`);
  const marco = vwc.mainFrame.frames[0];
  await marco.executeJavaScript(`document.getElementById('e').play()`, true);
  await until(() => marco.executeJavaScript(`!document.getElementById('e').paused`));
  ctx.command('page:pip');
  const abrio = await until(() => ctx.pip.current && pipWin()?.getOpacity() > 0.99 && pipWin().getBounds().x > -10000, 5000);
  const enMarco = await marco.executeJavaScript(`document.fullscreenElement?.id || null`);
  ok('Ctrl+Mayús+P saca el video que está sonando, aunque esté en un iframe', abrio && enMarco === 'e',
    JSON.stringify({ abrio, enMarco, cur: ctx.pip.current, arriba: await vwc.executeJavaScript(`document.fullscreenElement?.id || null`) }));
  ctx.command('page:pip');
  ok('y otra vez lo trae de vuelta', await until(() => !ctx.pip.current && !pipWin() && win.contentView.children.includes(vt.view), 5000));

  // Mientras se mira afuera, uno está en otra pestaña: el atajo igual lo trae.
  ctx.command('page:pip');
  await until(() => ctx.pip.current && pipWin()?.getOpacity() > 0.99 && pipWin().getBounds().x > -10000, 5000);
  ctx.tabs.create({ url: `${BASE}/dos` });
  await until(() => ctx.tabs.active.title === 'Página dos');
  const lejos = ctx.tabs.active;
  ctx.command('page:pip');
  ok('Ctrl+Mayús+P desde otra pestaña trae el video de vuelta', await until(() => !ctx.pip.current && !pipWin() && win.contentView.children.includes(vt.view), 5000));
  ok('y pasa a su pestaña', ctx.tabs.active.id === vt.id);
  ctx.tabs.close(lejos.id);

  // Con el teclado en la ventanita (se tocaron sus controles), también.
  ctx.command('page:pip');
  await until(() => ctx.pip.current && pipWin()?.getOpacity() > 0.99 && pipWin().getBounds().x > -10000, 5000);
  const pui2 = pipWin().contentView.children[1].webContents;
  for (const type of ['keyDown', 'keyUp']) pui2.sendInputEvent({ type, keyCode: 'P', modifiers: ['control', 'shift'] });
  ok('Ctrl+Mayús+P con el teclado en la ventanita la trae de vuelta', await until(() => !ctx.pip.current && !pipWin() && win.contentView.children.includes(vt.view), 5000));

  await vwc.executeJavaScript(`document.getElementById('v').play()`);
  ctx.command('page:pip');
  await until(() => ctx.pip.current && pipWin()?.getOpacity() > 0.99 && pipWin().getBounds().x > -10000, 5000);
  ctx.tabs.close(vt.id);
  ok('cerrar la pestaña se lleva la ventanita', await until(() => !ctx.pip.current && !pipWin()));

  ctx.tabs.create({ url: `${BASE}/dos` });
  await until(() => ctx.tabs.active.title === 'Página dos');
  ctx.card.hide();
  await until(() => !ctx.card.shown);
  ctx.command('page:pip');
  ok('en una página sin video no abre nada y lo avisa', await until(() => ctx.card.shown) && !pipWin() && !ctx.pip.current);

  console.log('\n12. Bandeja e instancia única');
  win.close();
  ok('cerrar esconde la ventana en vez de salir', await until(() => !win.isDestroyed() && !win.isVisible()));
  ok('las pestañas siguen vivas', ctx.tabs.list.length > 0);
  app.emit('second-instance', {}, [process.execPath]);
  ok('abrir Prism otra vez la trae de vuelta', await until(() => win.isVisible()));
  ok('y le suma una pestaña nueva', await until(() => ctx.tabs.active.internal === 'nueva'));
  // Ctrl+Alt+P (el atajo global no se registra en las pruebas: se llama directo).
  win.focus();
  await until(() => win.isFocused());
  ctx.toggleMain();
  ok('Ctrl+Alt+P con Prism al frente lo manda a la bandeja', await until(() => !win.isDestroyed() && !win.isVisible()));
  ok('sin cerrar pestañas', ctx.tabs.list.length > 0);
  ctx.toggleMain();
  ok('y otra vez lo trae', await until(() => win.isVisible() && win.isFocused()));
  win.minimize();
  await until(() => win.isMinimized());
  ctx.toggleMain();
  ok('minimizado, lo trae en vez de ocultarlo', await until(() => win.isVisible() && !win.isMinimized()));

  console.log('\n12b. Links desde Windows y navegador predeterminado');
  /* Windows lanza `"Prism.exe" -- "%1"` (default-browser.cjs). Con Prism ya
     abierto, Chromium le pasa esa línea a la instancia que está, con sus
     propios switches ANTES del --. */
  win.hide();
  await until(() => !win.isVisible());
  app.emit('second-instance', {}, [process.execPath, '--allow-file-access-from-files', '--', `${BASE}/dos`], TMP);
  ok('un link desde otra app trae Prism de la bandeja', await until(() => win.isVisible()));
  ok('y se abre en una pestaña nueva, al frente', await until(() => ctx.tabs.active?.url === `${BASE}/dos` && ctx.tabs.active.title === 'Página dos'), ctx.tabs.active?.url);
  const apunte = path.join(TMP, 'Apuntes #3 de Tecnia.html');
  fs.writeFileSync(apunte, '<title>Apunte tres</title><h1>Tecnia</h1>');
  app.emit('second-instance', {}, [process.execPath, '--', apunte], TMP);
  ok('un .html con # en el nombre llega entero', await until(() => ctx.tabs.active?.title === 'Apunte tres'), ctx.tabs.active?.url);

  /* La fila de Ajustes. Acá Prism no está instalado: primero dice eso, y
     después se le pone un Windows de mentira (no se toca el registro de nadie). */
  ctx.tabs.openInternal('ajustes');
  const fila = (k) => js(`!!document.querySelector('.pr-view[data-page="ajustes"]:not([data-state="closing"]) .pr-dflt__state[data-key=${JSON.stringify(k)}]:not([data-state="closing"])')`);
  ok('sin instalar, Ajustes dice que se elige desde Prism instalado', await until(() => fila('dev')));
  ok('y no ofrece un botón que no puede cumplir', !(await js(`!!document.querySelector('.pr-dflt [data-dflt="make"]')`)));
  const real = { state: ctx.defaultBrowser.state, makeDefault: ctx.defaultBrowser.makeDefault };
  let fake = { supported: true, isDefault: false, current: 'Google Chrome' };
  let pantallas = 0;
  ctx.defaultBrowser.state = async () => ({ ...fake });
  ctx.defaultBrowser.makeDefault = async () => { pantallas++; return { ...fake }; };
  await js(`window.dispatchEvent(new Event('focus'))`);
  ok('instalado, dice quién abre los links hoy', await until(() => fila('not:Google Chrome')));
  ok('con el nombre de ese navegador', await js(`document.querySelector('.pr-dflt').textContent.includes('Google Chrome')`));
  await js(`document.querySelector('.pr-dflt [data-dflt="make"]').click()`);
  ok('el botón lleva a la pantalla de Windows', await until(() => pantallas === 1));
  ok('y la fila explica qué tocar allá', await until(() => fila('waiting')));
  fake = { supported: true, isDefault: true, current: 'Prism' };
  await js(`window.dispatchEvent(new Event('focus'))`);
  ok('al volver a Prism, la fila lo muestra elegido', await until(() => fila('default')));
  ok('una sola fila, sin la vieja colgada', await until(() => js(`document.querySelectorAll('.pr-view[data-page="ajustes"] .pr-dflt__state').length === 1`)));
  ok('sin un alto a mano que quede pegado', await until(() => js(`document.querySelector('.pr-dflt').style.height === ''`)));
  ok('y la statusbar lo confirma', await until(() => js(`document.getElementById('status-left').textContent.includes('predeterminado')`)));
  Object.assign(ctx.defaultBrowser, real);

  console.log('\n12c. Respaldo de la bóveda');
  /* La bóveda se abre solo con esta cuenta de Windows: el respaldo es otro
     archivo, con su clave, en la carpeta que se elija (src/backup.cjs). Acá
     se prende desde Ajustes, se mira que se ponga al día solo, y se restaura
     por Importar: el de acá sin preguntar, y uno ajeno pidiendo su clave. */
  const B = require(path.join(__dirname, '..', 'src', 'backup.cjs'));
  const RESP = path.join(TMP, 'respaldos');
  const aj = vista('ajustes');
  const abrirCon = async (archivo, gesto) => {
    const antes = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archivo] });
    await gesto();
    await sleep(250);
    dialog.showOpenDialog = antes;
  };
  ok('en Ajustes arranca apagado, y dice qué se arriesga', await until(() => js(`!!${aj}.querySelector('#s-bk-setup') && ${aj}.querySelector('.pr-bk').textContent.includes('solo en esta compu')`)));
  await js(`${aj}.querySelector('#s-bk-setup').click()`);
  ok('Configurar abre el diálogo, con el foco en la clave', await until(() => js(`document.activeElement?.id === 'bk-p1'`)));
  const btnPrender = `[...document.querySelectorAll('.op-modal__foot .op-btn')].pop()`;
  const avisoResp = (t) => until(() => js(`document.querySelector('#bk-msg').textContent.includes(${JSON.stringify(t)}) && document.querySelector('#bk-msg').classList.contains('op-field__hint--error') && !!document.querySelector('.op-modal')`), 3000);
  await js(`${btnPrender}.click()`);
  ok('sin carpeta no prende: el diálogo se queda y dice qué falta', await avisoResp('Elegí una carpeta'));
  await abrirCon(RESP, () => js(`document.querySelector('#bk-pick').click()`));
  ok('la carpeta elegida queda a la vista', await until(() => js(`document.querySelector('#bk-dir').textContent.includes('respaldos')`)));
  await js(`document.querySelector('#bk-p1').value = 'corta'; ${btnPrender}.click()`);
  ok('una clave corta no pasa', await avisoResp('al menos 8'));
  await js(`document.querySelector('#bk-p1').value = 'clave de prueba'; document.querySelector('#bk-p2').value = 'clave de pruebo'; ${btnPrender}.click()`);
  ok('dos claves distintas tampoco', await avisoResp('no coinciden'));
  ok('y nada quedó prendido todavía', ctx.passwords.backup.state().on === false && !fs.existsSync(RESP));
  await js(`document.querySelector('#bk-p2').value = 'clave de prueba'; ${btnPrender}.click()`);
  ok('con todo bien, el diálogo se cierra', await until(() => js(`!document.querySelector('.op-modal')`)));
  const hoyResp = path.join(RESP, B.fileName());
  const enRespaldo = async (clave = 'clave de prueba') => (await B.openBackup(fs.readFileSync(hoyResp, 'utf8'), { passphrase: clave })).items;
  ok('la primera copia ya está en la carpeta', fs.existsSync(hoyResp));
  ok('cifrada: ni el sitio ni el usuario a la vista', !/Prueba|fran|127\.0\.0\.1/.test(fs.readFileSync(hoyResp, 'utf8')));
  ok('y se abre con la clave elegida', (await enRespaldo()).some((it) => it.title === 'Prueba'));
  ok('la fila pasa a mostrar la carpeta y la última copia', await until(() => js(`(() => { const f = ${aj}.querySelector('.pr-bk'); return !!f.querySelector('#s-bk-menu') && f.textContent.includes('respaldos') && f.textContent.includes('Última copia'); })()`)));
  ok('una sola fila, sin la de antes colgada', await until(() => js(`${aj}.querySelectorAll('.pr-bk .pr-opt').length === 1`)));
  ok('lo que queda en la compu no es la clave', !fs.readFileSync(path.join(process.env.PRISM_DATA, 'backup.json'), 'utf8').includes('clave de prueba'));

  const paraRespaldar = await V.save({ title: 'Para respaldar', username: 'r', password: 'respaldada', urls: ['https://respaldo.test'] });
  ok('guardar una contraseña pone el respaldo al día solo', await until(async () => (await enRespaldo()).some((it) => it.title === 'Para respaldar' && it.password === 'respaldada'), 9000));

  await js(`${aj}.querySelector('#s-bk-menu').click()`);
  const opcionResp = (t) => `[...document.querySelectorAll('.op-menu:not([data-state="closing"]) .op-menuitem')].find((b) => b.textContent.includes(${JSON.stringify(t)}))`;
  ok('Opciones ofrece respaldar ahora, la carpeta, la clave y apagar', await until(() => js(`['Respaldar ahora', 'Abrir la carpeta', 'Cambiar de carpeta', 'Cambiar la clave', 'Apagar el respaldo'].every((t) => [...document.querySelectorAll('.op-menu .op-menuitem')].some((b) => b.textContent.includes(t)))`)));
  await js(`${opcionResp('Respaldar ahora')}.click()`);
  ok('respaldar ahora lo confirma en la statusbar', await until(() => js(`document.getElementById('status-left').textContent.includes('Respaldo al día')`)));
  /* La hora se releva adentro de la frase. El relevo es una grilla: sin
     ponerla en línea, la hora bajaba a un renglón propio y la frase se partía
     en tres. */
  await sleep(500);
  ok('la hora de la última copia se releva sin partir la frase en renglones', await js(`(() => { const w = [...${aj}.querySelectorAll('.pr-bk .pr-bk__when')].pop(); const h = w.closest('.pr-opt__hint'); return w.classList.contains('op-swap') && h.getClientRects().length === 1 && h.offsetHeight < 24; })()`), await js(`String([...${aj}.querySelectorAll('.pr-bk .pr-bk__when')].pop()?.closest('.pr-opt__hint').offsetHeight)`));

  /* Restaurar. A la bóveda le falta una contraseña que el respaldo tiene. */
  await V.remove(paraRespaldar.id);
  await until(() => ctx.passwords.backup.flush().then(() => true));
  await js(`document.getElementById('btn-pass').click()`);
  ok('la bóveda abre sin la que se borró', await until(() => js(`!!document.querySelector('.pr-pass') && ![...document.querySelectorAll('.pr-pass__rowtitle')].some((r) => r.textContent === 'Para respaldar')`)));
  // El respaldo de ayer (el de hoy ya se puso al día sin ella): es de esta misma configuración.
  const respAyer = path.join(TMP, 'Prism-boveda-ayer.prismvault');
  const cfgResp = JSON.parse(fs.readFileSync(path.join(process.env.PRISM_DATA, 'backup.json'), 'utf8'));
  const salAca = Buffer.from(cfgResp.salt, 'base64');
  fs.writeFileSync(respAyer, B.sealBackup([{ kind: 'login', title: 'Para respaldar', username: 'r', password: 'respaldada', urls: ['https://respaldo.test'] }], { key: await B.deriveKey('clave de prueba', salAca), salt: salAca }));
  await abrirCon(respAyer, () => js(`document.getElementById('pp-import').click()`));
  ok('un respaldo de acá se restaura sin pedir la clave', await until(() => js(`document.querySelector('.pr-pass__banner')?.textContent.includes('Se restauró 1 contraseña') && [...document.querySelectorAll('.pr-pass__rowtitle')].some((r) => r.textContent === 'Para respaldar')`)));
  ok('y no ofrece borrar el archivo: está cifrado', await js(`!document.querySelector('.pr-pass__banner [data-a=forget-import]') && !!document.querySelector('.pr-pass__banner [data-a=banner-close]')`));
  ok('el respaldo sigue en su lugar', fs.existsSync(respAyer));
  ok('lo restaurado trae su contraseña', V.get(V.list().find((it) => it.title === 'Para respaldar').id).password === 'respaldada');

  // Uno de otra compu (otra sal, otra clave): hace falta la clave.
  const respAjeno = path.join(TMP, 'de-otra-compu.prismvault');
  const salAjena = Buffer.from('fedcba9876543210');
  fs.writeFileSync(respAjeno, B.sealBackup([{ kind: 'login', title: 'De la otra compu', username: 'o', password: 'ajena', urls: ['https://otra.test'] }], { key: await B.deriveKey('la clave de la otra', salAjena), salt: salAjena }));
  await abrirCon(respAjeno, () => js(`document.getElementById('pp-import').click()`));
  ok('uno de otra compu pide su clave, adentro del panel', await until(() => js(`!!document.querySelector('.pr-pass #pp-restore [name=key]') && document.querySelector('#pp-restore').textContent.includes('de-otra-compu.prismvault')`)));
  ok('con el foco en el campo', await until(() => js(`document.activeElement?.name === 'key'`)));
  await js(`document.querySelector('#pp-restore [name=key]').value = 'no es esta'; document.querySelector('#pp-restore').requestSubmit()`);
  ok('con una clave que no es, lo dice y deja probar de nuevo', await until(() => js(`document.querySelector('#pp-restore-msg')?.textContent.includes('no es la clave') && !document.querySelector('#pp-restore [type=submit]').disabled`)));
  ok('y no entró nada', !V.list().some((it) => it.title === 'De la otra compu'));
  await js(`document.querySelector('#pp-restore [name=key]').value = 'la clave de la otra'; document.querySelector('#pp-restore').requestSubmit()`);
  ok('con la clave, se suma lo que faltaba', await until(() => js(`document.querySelector('.pr-pass__banner')?.textContent.includes('Se restauró 1 contraseña') && [...document.querySelectorAll('.pr-pass__rowtitle')].some((r) => r.textContent === 'De la otra compu')`)));
  ok('sin pisar lo que ya estaba', V.list().some((it) => it.title === 'Prueba') && V.list().some((it) => it.title === 'Para respaldar'));
  await abrirCon(respAjeno, () => js(`document.getElementById('pp-import').click()`));
  await until(() => js(`!!document.querySelector('#pp-restore [name=key]')`));
  await js(`document.querySelector('#pp-restore [name=key]').value = 'la clave de la otra'; document.querySelector('#pp-restore').requestSubmit()`);
  ok('restaurar dos veces lo mismo no duplica', await until(() => js(`document.querySelector('.pr-pass__banner')?.textContent.includes('No había nada nuevo para restaurar')`)) && V.list().filter((it) => it.title === 'De la otra compu').length === 1);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => js(`!document.querySelector('.pr-pass')`));

  await js(`${aj}.querySelector('#s-bk-menu').click()`);
  await until(() => js(`!!${opcionResp('Apagar el respaldo')}`));
  await js(`${opcionResp('Apagar el respaldo')}.click()`);
  ok('apagar pregunta antes', await until(() => js(`document.querySelector('.op-modal__title')?.textContent.includes('Apagar el respaldo')`)));
  await js(`[...document.querySelectorAll('.op-modal__foot .op-btn')].pop().click()`);
  ok('apagado: la fila vuelve a ofrecer configurarlo', await until(() => js(`!!${aj}.querySelector('.pr-bk #s-bk-setup:not([data-state="closing"])') && !document.querySelector('.op-modal')`)));
  ok('la clave se olvida y las copias quedan', !fs.existsSync(path.join(process.env.PRISM_DATA, 'backup.json')) && fs.existsSync(hoyResp));
  // Como estaba: las contraseñas de esta sección se van.
  for (const t of ['Para respaldar', 'De la otra compu']) { const it = V.list().find((x) => x.title === t); if (it) await V.remove(it.id); }

  console.log('\n13. Actualizaciones');
  ctx.send('update:state', { phase: 'available', version: '9.9.9', name: 'Prism 9.9.9', bytes: 1e8, pct: 0 });
  ok('el menú muestra un punto', await until(() => js(`document.getElementById('btn-menu').classList.contains('has-update')`)));
  /* El ícono del botón de Ajustes va separado del texto como en cualquier
     otro botón. Su rótulo se releva adentro de un envoltorio, que no heredaba
     el espacio del botón: quedaban pegados (0 px). */
  const aire = () => js(`(() => {
    const b = [...document.querySelectorAll('#s-update')].find((x) => x.getClientRects().length);
    const item = b && [...b.querySelectorAll('.op-swap__item')].find((x) => x.dataset.state !== 'closing');
    const svg = item?.querySelector('svg');
    const t = svg?.nextSibling;
    if (!t || t.nodeType !== 3) return null;
    const r = document.createRange();
    const i = t.textContent.search(/\\S/);
    r.setStart(t, i); r.setEnd(t, i + 1);
    return { texto: t.textContent.trim(), px: Math.round(r.getBoundingClientRect().left - svg.getBoundingClientRect().right) };
  })()`);
  ok('en Ajustes, el ícono del botón de actualizar va separado del texto (8 px, como los demás)', await until(async () => { const a = await aire(); return a?.texto === 'Descargar' && a.px === 8; }, 3000), JSON.stringify(await aire()));
  await js(`document.getElementById('btn-menu').click()`);
  ok('y ofrece descargarla arriba de todo', await until(() => js(`!!document.querySelector('.op-menu .op-menuitem')?.textContent.includes('9.9.9')`)));
  ok('con "Salir de Prism" al final', await js(`[...document.querySelectorAll('.op-menu .op-menuitem')].pop().textContent.includes('Salir de Prism')`));
  /* Con un 60 % de la ventana como tope, "Salir de Prism" quedaba abajo del
     borde en la ventana de fábrica, y nada avisaba que había más. */
  const menuPpal = `document.querySelector('.op-menu:not([data-state="closing"])')`;
  const tamano = win.getContentSize();
  ok('con la ventana de fábrica entra entero, sin desplazarse', await js(`(() => { const m = ${menuPpal}; return m.scrollHeight <= m.clientHeight + 1 && m.getBoundingClientRect().bottom <= innerHeight; })()`), JSON.stringify(tamano));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => js(`!${menuPpal}`));
  win.setContentSize(1100, 500);
  await sleep(400);
  await js(`document.getElementById('btn-menu').click()`);
  ok('con una ventana baja, el menú se corta en el borde de la ventana', await until(() => js(`(() => { const m = ${menuPpal}; return !!m && m.getBoundingClientRect().bottom <= innerHeight - 9; })()`)));
  ok('y deja ver que hay más: se desplaza, con la barrita a la vista', await js(`(() => { const m = ${menuPpal}; return m.scrollHeight > m.clientHeight + 1 && !m.classList.contains('is-bottom'); })()`));
  await js(`(() => { const m = ${menuPpal}; m.scrollTop = m.scrollHeight; return true; })()`);
  ok('y desplazándolo se llega a "Salir de Prism"', await until(() => js(`(() => { const m = ${menuPpal}; const s = [...m.querySelectorAll('.op-menuitem')].pop().getBoundingClientRect(); return m.classList.contains('is-bottom') && s.bottom <= m.getBoundingClientRect().bottom; })()`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => js(`!${menuPpal}`));
  win.setContentSize(...tamano);
  await sleep(300);
  await js(`document.getElementById('btn-menu').click()`);
  await until(() => js(`!!${menuPpal}`));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  ok('la statusbar lo avisa', await until(() => js(`document.getElementById('status-left').textContent.includes('9.9.9')`)));

  console.log('\n13b. El anillo de foco');
  /* Con el teclado, todo control enfocable muestra el anillo. Era un
     box-shadow, y los controles con sombra propia (primario, secundario,
     switch, check, select) le ganaban: quedaban sin ninguna marca. Se mide
     en píxeles: con foco y sin foco, el borde de alrededor tiene que cambiar. */
  win.webContents.focus();
  await js(`(() => {
    const box = document.createElement('div');
    box.id = 'anillos-de-prueba';
    box.style.cssText = 'position:fixed;left:40px;top:200px;z-index:2147483646;display:flex;gap:24px;padding:16px;background:var(--op-bg)';
    box.innerHTML = '<button class="op-btn op-btn--primary">Primario</button><button class="op-btn op-btn--secondary">Secundario</button>'
      + '<button class="op-btn op-btn--danger-solid">Borrar</button><button class="op-btn op-btn--ghost">Fantasma</button>'
      + '<button class="op-switch is-on"></button><button class="op-check is-on"></button><button class="op-select"><span class="op-select__value">Elegir</span></button>'
      + '<button class="op-iconbtn">x</button>';
    document.body.append(box);
    return true;
  })()`);
  await sleep(300);
  const controles = await js(`[...document.querySelectorAll('#anillos-de-prueba > *')].map((e) => e.className)`);
  const foto = async (i) => {
    const r = await js(`(() => { const r = document.querySelectorAll('#anillos-de-prueba > *')[${i}].getBoundingClientRect(); return { x: Math.floor(r.left) - 6, y: Math.floor(r.top) - 6, width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12 }; })()`);
    return (await win.webContents.capturePage(r)).toBitmap();
  };
  for (let i = 0; i < controles.length; i++) {
    const sin = await foto(i);
    // La ventana de prueba compite por el foco con el escritorio: se insiste hasta que tome.
    const visible = await until(async () => {
      win.webContents.focus();
      return js(`(() => { const e = document.querySelectorAll('#anillos-de-prueba > *')[${i}]; e.focus({ focusVisible: true }); return e.matches(':focus-visible'); })()`);
    }, 3000);
    /* La captura puede traer el cuadro de antes si el compositor todavía no
       pintó el nuevo, o la ventana de prueba pudo perder el foco (la persona
       sigue usando la compu): se vuelve a sacar un rato. Un anillo que no
       está no aparece nunca, así que esto no esconde la falla. */
    let distintos = 0;
    await until(async () => {
      // Sin la ventana enfocada, Chromium no pinta :focus: se le devuelve antes de cada foto.
      win.webContents.focus();
      await js(`document.querySelectorAll('#anillos-de-prueba > *')[${i}].focus({ focusVisible: true }); true`);
      await sleep(60);
      const con = await foto(i);
      distintos = 0;
      for (let p = 0; p < Math.min(sin.length, con.length); p += 4) if (Math.abs(sin[p] - con[p]) + Math.abs(sin[p + 1] - con[p + 1]) + Math.abs(sin[p + 2] - con[p + 2]) > 30) distintos++;
      return distintos > 20;
    }, 2000);
    ok(`${controles[i].split(' ').find((c) => c.startsWith('op-') && (c.includes('--') || c !== 'op-btn')) || controles[i]}: con el teclado se ve el anillo`, visible && distintos > 20, `focus-visible ${visible} · píxeles que cambian ${distintos}`);
    await js(`document.activeElement.blur(); true`);
  }
  await js(`document.getElementById('anillos-de-prueba').remove(); true`);

  console.log('\n13c. Ningún anillo de foco se corta');
  /* El anillo sale 3,5 px por fuera del control. Donde no hay ese aire (el
     segmentado tiene 2 px de carril) se montaba sobre el canto del control y
     sobre la opción vecina. Cada control se enfoca como con el teclado y se
     mide su anillo real contra lo que lo recorta y contra el canto de la
     superficie que lo contiene; y además, que el foco se note. Es el 9-bis
     del humo de Opal. */
  const AUDITAR_ANILLOS = (scope) => `((scope) => {
    if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before{transition:none!important}</style>');
    const look = (el) => {
      const s = getComputedStyle(el);
      const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor);
      return [ring, s.boxShadow, s.backgroundColor, s.borderColor, getComputedStyle(el, '::before').boxShadow].join('|');
    };
    let marked = true;
    const extent = (el) => {
      const before = look(el);
      el.focus({ focusVisible: true, preventScroll: true });
      marked = !el.matches(':focus') || look(el) !== before;
      const s = getComputedStyle(el);
      let m = 0;
      for (const part of s.boxShadow.split(/,(?![^(]*\\))/)) {
        if (part.includes('inset') || part.trim() === 'none') continue;
        const nums = part.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)/g, '').match(/-?[\\d.]+px/g) || [];
        const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
        if (blur > 0) continue;
        m = Math.max(m, spread + Math.max(Math.abs(x), Math.abs(y)));
      }
      if (s.outlineStyle !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor)) m = Math.max(m, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
      el.blur();
      return m;
    };
    const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
    const name = (el) => {
      const id = el.id ? '#' + el.id : '';
      const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
      const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
    };
    const out = [];
    for (const el of scope.querySelectorAll(SEL)) {
      if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const R = extent(el);
      if (!marked) { out.push(name(el) + '  no marca el foco'); continue; }
      if (R <= 0.5) continue;
      const boxes = [{ who: 'ventana', l: 0, t: 0, r: innerWidth, b: innerHeight }];
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || /paint|strict|content/.test(s.contain)) {
          const ar = a.getBoundingClientRect();
          const l = ar.left + a.clientLeft; const t = ar.top + a.clientTop;
          boxes.push({ who: name(a), l, t, r: l + a.clientWidth, b: t + a.clientHeight });
        }
      }
      const e = 0.5;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        const surf = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none') && parseFloat(s.borderTopLeftRadius) > 0;
        if (!surf) continue;
        const ar = a.getBoundingClientRect();
        const g = [r.left - ar.left, r.top - ar.top, ar.right - r.right, ar.bottom - r.bottom];
        if (g.some((x) => x < -e)) continue;
        const det = g.map((x, i) => ['izq', 'arriba', 'der', 'abajo'][i] + ' ' + x.toFixed(1)).filter((_, i) => g[i] < R - e);
        if (det.length) { out.push(name(el) + '  roza ' + name(a) + '  [' + det.join(', ') + ']'); break; }
      }
      for (const bx of boxes) {
        const inside = r.left >= bx.l - e && r.top >= bx.t - e && r.right <= bx.r + e && r.bottom <= bx.b + e;
        if (!inside) break;
        const lados = [];
        if (r.left - R < bx.l - e) lados.push('izq ' + (r.left - bx.l).toFixed(1));
        if (r.top - R < bx.t - e) lados.push('arriba ' + (r.top - bx.t).toFixed(1));
        if (r.right + R > bx.r + e) lados.push('der ' + (bx.r - r.right).toFixed(1));
        if (r.bottom + R > bx.b + e) lados.push('abajo ' + (bx.b - r.bottom).toFixed(1));
        if (lados.length) { out.push(name(el) + '  ← ' + bx.who + '  [' + lados.join(', ') + ']'); break; }
      }
    }
    return out;
  })(${scope})`;
  ctx.tabs.openInternal('ajustes');
  await until(() => js(`!!document.querySelector('.pr-view[data-page="ajustes"]:not(.is-parked):not([data-state="closing"]) .pr-head__title')`));
  await sleep(500);
  const enfocada = () => until(async () => { win.focus(); win.webContents.focus(); return js('document.hasFocus()'); }, 3000);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await enfocada());
  let cortes = await js(AUDITAR_ANILLOS(`document.querySelector('.pr-view[data-page="ajustes"]:not(.is-parked):not([data-state="closing"])')`));
  ok('Ajustes: todo control marca el foco, y ningún anillo se corta ni roza un canto', cortes.length === 0, '\n      ' + cortes.join('\n      '));
  await js(`document.querySelector('.pr-view[data-page="ajustes"] .pr-view__scroll').scrollTop = 0; true`);
  await js(`document.getElementById('btn-pass').click()`);
  await until(() => js(`document.querySelectorAll('.pr-pass__row').length >= 1`));
  await sleep(400);
  await enfocada();
  cortes = await js(AUDITAR_ANILLOS(`document.querySelector('.pr-pass')`));
  ok('la bóveda: todo control marca el foco, y ningún anillo se corta ni roza un canto', cortes.length === 0, '\n      ' + cortes.join('\n      '));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => js(`!document.querySelector('.pr-pass')`));
  await js(`document.getElementById('aud-notr')?.remove(); true`);
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n13c2. El Tab recorre solo lo que se ve');
  /* La barra de buscar cerrada estaba escondida con aria-hidden solo: el Tab
     caía en su campo y en sus tres botones, invisibles, y sus tooltips
     («Cerrar Esc») flotaban al lado de la ventana. Y la barra de favoritos y
     los botones de la ventana tampoco se recorren (como en Chrome). */
  await enfocada();
  const recorrido = await (async () => {
    const vistos = [];
    await js(`document.activeElement?.blur(); true`);
    for (let i = 0; i < 30; i++) {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(60);
      const r = await js(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const b = el.getBoundingClientRect();
        let opaco = true;
        for (let a = el; a && a !== document.documentElement; a = a.parentElement) if (getComputedStyle(a).opacity === '0') opaco = false;
        return { nombre: (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')),
          oculto: !!el.closest('[aria-hidden="true"],[inert]') || b.width < 2 || b.height < 2 || !opaco,
          barra: !!el.closest('#bmbar'), ventana: el.matches('.op-wincontrol') };
      })()`);
      if (!r) continue;
      if (vistos.some((v) => v.nombre === r.nombre)) break;
      vistos.push(r);
    }
    return vistos;
  })();
  const pasos = recorrido.map((v) => v.nombre).join(' → ');
  ok('el Tab no se detiene en nada que no se vea', recorrido.length > 3 && !recorrido.some((v) => v.oculto), pasos);
  ok('ni en la barra de favoritos ni en los botones de la ventana', !recorrido.some((v) => v.barra || v.ventana), pasos);
  ok('y pasa por la barra de direcciones', recorrido.some((v) => v.nombre === '#omni-input'), pasos);
  ctx.tabs.create({ url: `${BASE}/` });
  await until(() => ctx.tabs.active.title === 'Inicio de prueba' && !ctx.tabs.active.loading);
  ok('la barra de buscar, cerrada, es inerte', await js(`document.getElementById('find').inert`));
  ctx.command('find:open');
  ok('abierta deja de serlo, y el foco va a su campo', await until(() => js(`!document.getElementById('find').inert && document.activeElement?.id === 'find-input'`)));
  await js(`document.getElementById('find-close').click(); true`);
  ok('y al cerrarla vuelve a ser inerte', await until(() => js(`document.getElementById('find').inert`)));
  ctx.tabs.close(ctx.tabs.active.id);
  if (!(await js(`!!document.querySelector('.pr-bm')`))) {
    ctx.library.addBookmark({ url: `${BASE}/dos`, title: 'Página dos' });
    ctx.send('library:changed');
    await until(() => js(`!!document.querySelector('.pr-bm')`));
  }
  // Con el anillo prendido de verdad: sin la ventana enfocada no hay :focus-visible, y se insiste.
  const medirBarra = () => js(`(() => [document.querySelector('.pr-bm'), document.getElementById('bmbar-more')].map((el) => {
    el.focus({ focusVisible: true });
    const s = getComputedStyle(el);
    const r = { tab: el.tabIndex, prendido: el.matches(':focus-visible') && s.outlineStyle !== 'none', sale: parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset) };
    el.blur();
    return r;
  }))()`);
  let barra = [];
  await until(async () => { await enfocada(); barra = await medirBarra(); return barra.every((b) => b.prendido); }, 6000);
  ok('la barra de favoritos queda fuera del Tab', barra.every((b) => b.tab === -1), JSON.stringify(barra));
  ok('y su anillo va por dentro: la barra ya no le come el canto', barra.every((b) => b.prendido && b.sale <= 0.5), JSON.stringify(barra));

  console.log('\n13c3. El pie de Ajustes');
  ctx.tabs.openInternal('ajustes');
  await until(() => js(`!!document.getElementById('s-data')`));
  const pie = await js(`(() => {
    const btn = document.getElementById('s-data');
    const fila = btn.closest('.pr-opt');
    const sc = fila.closest('.pr-view__scroll'); sc.scrollTop = sc.scrollHeight;
    const rf = fila.getBoundingClientRect(); const rb = btn.getBoundingClientRect();
    const raya = getComputedStyle(fila).boxShadow !== 'none';
    return { raya, arriba: Math.round(rb.top - rf.top), abajo: Math.round(rf.bottom - rb.bottom) };
  })()`);
  ok('la raya de arriba no queda pegada al botón ni a la firma', pie.raya && pie.arriba >= 8 && Math.abs(pie.arriba - pie.abajo) <= 2, JSON.stringify(pie));
  ctx.tabs.close(ctx.tabs.active.id);

  console.log('\n13d. Detalles: toast, tooltip, modal, campos y botones');
  /* Lo que vino de Opal en su tanda 7. Una página web activa: la estrella
     solo está con un sitio, y la que tarda en cargar deja ver «detener». */
  ctx.tabs.create({ url: `${BASE}/lenta` });
  ok('mientras carga, recargar pasa a detener (sus íconos se cruzan)', await until(() => js(`document.getElementById('btn-reload').classList.contains('is-b')`), 3000));
  ok('y al terminar vuelve a recargar', await until(() => js(`!document.getElementById('btn-reload').classList.contains('is-b')`), 6000) && ctx.tabs.active.title === 'Lenta', ctx.tabs.active.title);

  const toast = await js(`(async () => {
    const { Toast } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    Toast.show({ title: 'Con hover', duration: 2000 });
    const el = [...document.querySelectorAll('.op-toast')].pop();
    const cerrar = el.querySelector('[data-close]').getAttribute('aria-label');
    await wait(200);
    el.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(600);
    el.dispatchEvent(new PointerEvent('pointerleave'));
    await wait(1200);
    const sigue = el.isConnected && el.dataset.state !== 'closing';
    await wait(1100);
    return { cerrar, sigueA1200: sigue, seFueA2300: !el.isConnected || el.dataset.state === 'closing' };
  })()`);
  ok('el toast tocado al principio sigue con el tiempo que le quedaba', toast.sigueA1200 && toast.seFueA2300, JSON.stringify(toast));
  ok('y su cruz se llama «Cerrar»', toast.cerrar === 'Cerrar', JSON.stringify(toast));

  const tip = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.createElement('button');
    // Un texto largo: la escala de la entrada lo corre varios píxeles si se mide mal.
    b.className = 'op-iconbtn'; b.dataset.tip = 'Se va, y es un tooltip bastante largo'; b.innerHTML = '<svg width="14" height="14"></svg>';
    b.style.cssText = 'position:fixed;left:600px;top:400px;z-index:5';
    document.body.append(b);
    b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await wait(700);
    const t = document.querySelector('.op-tooltip:not([data-state="closing"])');
    const rb = b.getBoundingClientRect(); const rt = t?.getBoundingClientRect();
    const centrado = t ? Math.abs((rt.left + rt.right) / 2 - (rb.left + rb.right) / 2) : null;
    const nombre = b.getAttribute('aria-label');
    b.remove();
    await wait(450);
    return { seVio: !!t, centrado, nombre, huerfano: !!document.querySelector('.op-tooltip:not([data-state="closing"])') };
  })()`);
  ok('un tooltip queda centrado sobre su ancla (medido sin la escala de su entrada)', tip.seVio && tip.centrado <= 1, JSON.stringify(tip));
  ok('si su ancla se va del DOM, el tooltip se va', tip.seVio && !tip.huerfano, JSON.stringify(tip));
  ok('un botón de solo ícono toma su nombre del tooltip', tip.nombre === 'Se va, y es un tooltip bastante largo', JSON.stringify(tip));
  // También los que ya estaban al arrancar: el chip del zoom no trae aria-label propio.
  ok('y también los que ya estaban al arrancar', await js(`document.getElementById('omni-zoom').getAttribute('aria-label') === 'Restablecer el zoom'`));
  /* Sin la ventana enfocada no hay :focus-visible, y la de prueba compite por
     el foco con el escritorio: se insiste, como con los anillos (13b). Un
     tooltip que no aparece con el teclado no aparece nunca. */
  let tipTeclado = {};
  await until(async () => {
    win.focus(); win.webContents.focus();
    tipTeclado = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = document.getElementById('btn-pass');
      b.focus({ focusVisible: true });
      const foco = b.matches(':focus-visible');
      await wait(650);
      const visto = document.querySelector('.op-tooltip:not([data-state="closing"])')?.textContent;
      b.blur();
      await wait(300);
      return { foco, visto, seFue: !document.querySelector('.op-tooltip:not([data-state="closing"])') };
    })()`);
    return tipTeclado.foco && tipTeclado.visto === 'Contraseñas y tarjetas' && tipTeclado.seFue;
  }, 8000);
  ok('el tooltip aparece también al llegar con Tab, y se va al salir', tipTeclado.visto === 'Contraseñas y tarjetas' && tipTeclado.seFue, JSON.stringify(tipTeclado));

  const conEnter = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Un campo escondido antes que el de verdad: el foco no se va a lo que no se ve.
    const p = Modal.show({ title: 'Con un campo', body: '<input class="op-input" id="campo-oculto" style="display:none"><input class="op-input" id="campo-enter" value="algo">',
      actions: [{ label: 'Cancelar', value: false }, { label: 'Guardar', value: 'guardado', variant: 'primary' }] });
    await wait(200);
    const foco = document.activeElement?.id;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const v = await Promise.race([p, wait(1200).then(() => 'sin respuesta')]);
    // Si Enter no lo cerró, se cierra acá: el siguiente esperaría su turno para siempre.
    if (v === 'sin respuesta') { Modal.close(null); await p; }
    await wait(400);
    // Con autofocus en el botón, se queda el foco aunque haya campos (imprimir).
    const q = Modal.show({ title: 'De opciones', body: '<input class="op-input" id="campo-copias" type="number" value="1">',
      actions: [{ label: 'Cancelar', value: null }, { label: 'Imprimir', value: 'go', variant: 'primary', autofocus: true }] });
    await wait(200);
    const focoAuto = document.activeElement?.textContent;
    Modal.close(null);
    await Promise.race([q, wait(1500)]);
    await wait(400);
    return { foco, v, focoAuto };
  })()`);
  ok('en un modal con un campo, el foco arranca en el primer campo visible', conEnter.foco === 'campo-enter', JSON.stringify(conEnter));
  ok('y Enter en el campo confirma con la acción primaria', conEnter.v === 'guardado', JSON.stringify(conEnter));
  ok('un botón con autofocus se queda el foco aunque haya campos', conEnter.focoAuto === 'Imprimir', JSON.stringify(conEnter));

  // Los de verdad: editar un favorito se escribe y se guarda con Enter; borrar datos no arranca en la X.
  ctx.library.addBookmark({ url: `${BASE}/editar`, title: 'Para editar' });
  const fav = ctx.library.listBookmarks().find((x) => x.url === `${BASE}/editar`);
  const edicion = await js(`(async () => {
    const { editBookmark } = await import('./js/pages.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const p = editBookmark(${JSON.stringify(fav?.id)});
    await wait(400);
    const foco = document.activeElement?.id;
    const alto = document.getElementById('b-title')?.getBoundingClientRect().height;
    document.activeElement.value = 'Editado con Enter';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const v = await Promise.race([p, wait(1500).then(() => 'sin respuesta')]);
    if (v === 'sin respuesta') { const { Modal } = await import('./js/overlays.js'); Modal.close(null); await wait(400); }
    return { foco, alto };
  })()`);
  ok('«Editar favorito» arranca con el foco en el nombre', edicion.foco === 'b-title', JSON.stringify(edicion));
  ok('y Enter lo guarda', await until(() => ctx.library.listBookmarks().find((x) => x.id === fav?.id)?.title === 'Editado con Enter'));
  await until(() => js(`!document.querySelector('.op-modal__anim:not([data-state="closing"])')`));
  ctx.library.removeBookmark(fav?.id);
  const borrar = await js(`(async () => {
    const { clearDataModal } = await import('./js/pages.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    clearDataModal();
    await wait(400);
    const foco = document.activeElement?.textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(400);
    const cerrado = !document.querySelector('.op-modal__anim:not([data-state="closing"])');
    if (!cerrado) { const { Modal } = await import('./js/overlays.js'); Modal.close(null); await wait(400); }
    return { foco, cerrado };
  })()`);
  ok('«Borrar datos» arranca en Cancelar, no en la X', borrar.foco === 'Cancelar' && borrar.cerrado, JSON.stringify(borrar));

  const piezas = await js(`(() => {
    const box = document.createElement('div');
    box.id = 'piezas-de-prueba';
    box.style.cssText = 'position:fixed;left:40px;top:220px;z-index:2147483646;display:flex;gap:12px;align-items:center;padding:16px;background:var(--op-bg)';
    box.innerHTML = '<input class="op-input" style="width:120px"><button class="op-select" style="width:120px"><span class="op-select__value">Elegir</span></button>'
      + '<button class="op-btn op-btn--secondary">Botón</button><button class="op-iconbtn" disabled>x</button>'
      + '<div class="op-stepper" style="width:90px"><input class="op-input" type="number" value="1" min="1" max="1">'
      + '<div class="op-stepper__btns"><button class="op-stepper__btn" data-step="up" disabled>+</button><button class="op-stepper__btn" data-step="down">-</button></div></div>';
    document.body.append(box);
    const q = (s) => box.querySelector(s);
    const color = (v) => { const p = document.createElement('span'); p.style.color = v; box.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    const dur = (html, sel) => { const s = document.createElement('div'); s.innerHTML = html; box.append(s); const d = getComputedStyle(s.querySelector(sel)).animationDuration; s.remove(); return d; };
    const r = {
      alturas: [q('.op-input').getBoundingClientRect().height, q('.op-select').getBoundingClientRect().height, q('.op-btn').getBoundingClientRect().height],
      flecha: getComputedStyle(q('[data-step="down"]')).color, flechaApagada: getComputedStyle(q('[data-step="up"]')).color,
      flechaOpacidad: getComputedStyle(q('[data-step="up"]')).opacity,
      texto3: color('var(--op-text-3)'), texto4: color('var(--op-text-4)'),
      apagado: getComputedStyle(q('.op-iconbtn[disabled]')).opacity,
      salidaRelevo: dur('<span class="op-swap"><span class="op-swap__item" data-state="closing">x</span></span>', '.op-swap__item'),
      salidaPestana: dur('<div class="pr-tab" data-state="closing"><div class="pr-tab__body"></div></div>', '.pr-tab__body'),
      salidaTooltip: dur('<div class="op-tooltip" data-state="closing">x</div>', '.op-tooltip'),
    };
    box.remove();
    return r;
  })()`);
  ok('un campo mide lo mismo que un select y un botón (30 px)', piezas.alturas.every((v) => v === 30), JSON.stringify(piezas.alturas));
  ok('las flechas del campo numérico que andan se ven (text-3)', piezas.flecha === piezas.texto3, JSON.stringify(piezas));
  ok('y la del tope se apaga a text-4, sin velo encima', piezas.flechaApagada === piezas.texto4 && piezas.flechaOpacidad === '1', JSON.stringify(piezas));
  ok('un botón de ícono apagado se ve apagado', Number(piezas.apagado) < 0.7, JSON.stringify(piezas));
  ok('las salidas en su lugar duran --op-t-out (un relevo, una pestaña)', piezas.salidaRelevo === '0.15s' && piezas.salidaPestana === '0.15s', JSON.stringify(piezas));
  ok('y el tooltip sale con --op-t-1', piezas.salidaTooltip === '0.11s', JSON.stringify(piezas));

  /* Los seis botones de dos íconos son ahora un .op-iconswap: los dos en la
     misma celda (por el centro: el escondido va achicado), y con .is-b se
     cruzan. Cada uno con el disparador de verdad donde se puede. */
  ctx.send('win:maximized', true);
  ok('maximizada, el botón cambia a restaurar', await until(() => js(`document.getElementById('win-max').classList.contains('is-b')`), 2000));
  ctx.send('win:maximized', false);
  await until(() => js(`!document.getElementById('win-max').classList.contains('is-b')`), 2000);
  // En el humo el bloqueador está apagado: el escudo va tachado en todos lados.
  ok('el escudo apagado muestra el tachado', await js(`(() => { const s = document.getElementById('btn-shield'); return s.classList.contains('is-off') && s.classList.contains('is-b'); })()`));
  const cruce = async (sel) => js(`(async () => {
    const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return { falta: true };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const svgs = () => [...b.children].filter((c) => c.tagName === 'svg');
    const c = svgs().map((i) => i.getBoundingClientRect());
    const misma = c.length === 2 && Math.abs((c[0].left + c[0].right) - (c[1].left + c[1].right)) < 1 && Math.abs((c[0].top + c[0].bottom) - (c[1].top + c[1].bottom)) < 1;
    const era = b.classList.contains('is-b');
    const op = () => svgs().map((i) => getComputedStyle(i).opacity).join(',');
    b.classList.toggle('is-b', false); await wait(450); const a = op();
    b.classList.toggle('is-b', true); await wait(450); const bb = op();
    b.classList.toggle('is-b', era);
    return { misma, a, b: bb };
  })()`);
  for (const [nombre, sel] of [['maximizar', '#win-max'], ['recargar', '#btn-reload'], ['la estrella', '#omni-star'], ['el escudo', '#btn-shield']]) {
    const r = await cruce(sel);
    ok(`${nombre}: sus dos íconos en la misma celda, y se cruzan`, r.misma && r.a === '1,0' && r.b === '0,1', JSON.stringify(r));
  }
  await js(`document.getElementById('btn-pass').click()`);
  await until(() => js(`document.querySelectorAll('.pr-pass__row').length >= 1`));
  if (!(await js(`!!document.querySelector('.pr-pass [data-a="reveal"]')`))) await js(`document.querySelector('.pr-pass__row').click()`);
  ok('la bóveda muestra el ojo de un secreto', await until(() => js(`!!document.querySelector('.pr-pass [data-a="reveal"]')`), 3000));
  await js(`document.querySelector('.pr-pass [data-a="reveal"]').click()`);
  ok('el ojo, al mostrar, cambia al tachado', await until(() => js(`document.querySelector('.pr-pass [data-a="reveal"]').classList.contains('is-b')`), 3000));
  for (const [nombre, sel] of [['copiar', '.pr-pass__copy'], ['el ojo', '.pr-pass [data-a="reveal"]']]) {
    const r = await cruce(sel);
    ok(`${nombre}: sus dos íconos en la misma celda, y se cruzan`, r.misma && r.a === '1,0' && r.b === '0,1', JSON.stringify(r));
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => js(`!document.querySelector('.pr-pass')`));

  console.log('\n13e. Si se cae el cromo, vuelve solo');
  /* Va al final: recarga el cromo. Las pestañas viven en sus procesos y su
     estado en main, así que el cromo nuevo tiene que quedar como estaba. */
  const cromoAntes = { n: ctx.tabs.list.length, activa: ctx.tabs.active?.id };
  win.webContents.forcefullyCrashRenderer();
  // Con el cromo caído, executeJavaScript no contesta nunca: cada intento tiene su plazo.
  const vivo = () => Promise.race([js(`!document.getElementById('boot-splash') && !!window.__prism && document.querySelectorAll('.pr-tab').length > 0`).catch(() => false), sleep(1500).then(() => false)]);
  const volvio = await until(vivo, 15000);
  ok('el cromo se recarga y arranca de nuevo', volvio);
  if (!volvio) {
    console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
    server.close();
    app.exit(1);
    return;
  }
  ok('con las mismas pestañas, y la misma activa', ctx.tabs.list.length === cromoAntes.n && ctx.tabs.active?.id === cromoAntes.activa, JSON.stringify({ antes: cromoAntes, ahora: { n: ctx.tabs.list.length, activa: ctx.tabs.active?.id } }));
  ok('y tantas pestañas en la tira como en main', await until(() => js(`document.querySelectorAll('.pr-tab:not([data-state="closing"])').length === ${cromoAntes.n}`), 4000));
  const cae = async () => {
    const p = await js(`(() => { const r = document.getElementById('page').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    const v = ctx.tabs.active.view?.getBounds();
    return v && Math.abs(v.x - p.x) <= 1 && Math.abs(v.y - p.y) <= 1 && Math.abs(v.width - p.w) <= 1 && Math.abs(v.height - p.h) <= 1;
  };
  ok('la página sigue cayendo exactamente sobre #page', await until(cae, 4000));

  console.log('\n14. Sin errores en la consola del cromo');
  ok('ninguno', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  server.close();
  app.exit(fail ? 1 : 0);
});
