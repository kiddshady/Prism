'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la sesión de las páginas
   Las páginas viven en su propia partición (`persist:prism`), separada de la
   de la ventana. No es prolijidad: el bloqueador registra un preload en TODOS
   los frames de la sesión, y la interfaz de Prism no tiene por qué cargar los
   filtros cosméticos de un bloqueador de anuncios.

   Acá se decide lo que una página puede pedir: permisos (cámara, micrófono,
   ubicación…), compartir pantalla, y con qué nombre se presenta el navegador.

   El default de Electron es CONCEDER todo permiso que se pida. Para un
   navegador eso es inaceptable: cualquier página podría encender la cámara.
   Todo lo sensible pasa por una pregunta propia, y la respuesta se recuerda.
   ═══════════════════════════════════════════════════════════════════════════ */

const { session, desktopCapturer, ipcMain, webContents } = require('electron');
const path = require('path');
const omni = require('./omni.cjs');

/* Lo que se concede sin preguntar: no expone nada de la persona. */
const ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection']);

/* Lo que se pregunta. Cualquier otro permiso que no esté en ninguna de las
   dos listas se niega: si Chromium agrega uno nuevo, entra cerrado. */
const ASK = {
  camera: 'usar tu cámara',
  microphone: 'usar tu micrófono',
  'camera+microphone': 'usar tu cámara y tu micrófono',
  geolocation: 'saber tu ubicación',
  notifications: 'mostrarte notificaciones',
  'clipboard-read': 'leer tu portapapeles',
  midi: 'usar tus dispositivos MIDI',
  midiSysex: 'controlar tus dispositivos MIDI',
  'idle-detection': 'saber cuándo estás usando la compu',
  'window-management': 'administrar tus ventanas',
  openExternal: 'abrir una aplicación de tu compu',
  'storage-access': 'usar sus cookies en este sitio',
  'top-level-storage-access': 'usar sus cookies en este sitio',
};

/* Abrir una aplicación (mailto:, zoommtg:, spotify:…) se pregunta y se
   recuerda POR ESQUEMA: «sí» a un mailto: no habilita nada más. Antes era un
   solo permiso para todo, y la pregunta ni decía cuál. Estos se niegan
   siempre, sin preguntar: abren cosas de Windows con parámetros que elige la
   página (búsquedas del Explorador que muestran archivos remotos, el
   diagnóstico de Office de Follina, instaladores, ayudas compiladas). */
const NEVER_OPEN = new Set([
  'file', 'shell', 'javascript', 'vbscript', 'data', 'about', 'blob', 'view-source', 'prism',
  'search', 'search-ms', 'ms-msdt', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full',
  'ms-word', 'ms-excel', 'ms-powerpoint', 'ms-visio', 'ms-access', 'ms-project', 'ms-publisher',
  'ms-spd', 'ms-infopath', 'hcp', 'its', 'ms-its', 'mk', 'res', 'jar',
]);
const schemeOf = (url) => {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
};

/** El pedido de media se desarma en cámara / micrófono, que se recuerdan por separado. */
function mediaKeys(details) {
  const types = new Set(details?.mediaTypes || []);
  const keys = [];
  if (types.has('video')) keys.push('camera');
  if (types.has('audio')) keys.push('microphone');
  return keys;
}

/* Lo que la página lee de sus permisos se contesta desde la sesión a la que
   pertenece (la normal o la de incógnito). Los canales se registran una sola
   vez; cada sesión anota acá cómo contestar. */
const statesBySession = new Map();   // session → (e) → estados
let permChannels = false;
function listenPermChannels() {
  if (permChannels) return;
  permChannels = true;
  const statesFor = (e) => statesBySession.get(e.sender?.session)?.(e) ?? null;
  ipcMain.on('perm:states', (e) => { e.returnValue = statesFor(e); });
  ipcMain.handle('perm:state', (e, name) => {
    const st = statesFor(e);
    return st && Object.hasOwn(st, String(name)) ? st[name] : null;
  });
}

/**
 * La sesión de las páginas de una ventana. La normal persiste en disco; la de
 * incógnito (`{ private: true }`) vive en memoria, en una partición nueva cada
 * vez, y no recuerda ninguna respuesta de permisos: pregunta de nuevo.
 */
function createWeb(ctx, { partition = 'persist:prism', private: priv = false } = {}) {
  const web = session.fromPartition(partition);

  /* ── Identidad ─────────────────────────────────────────────────────────────
     El user agent por defecto dice "Electron/40…" y "Prism/0.1.0". Varios
     sitios (el login de Google, el primero) rechazan a los navegadores que se
     identifican como Electron. Se presenta como el Chromium que es. */
  const ua = web.getUserAgent().replace(/\s(Electron|prism|Prism)\/\S+/g, '');
  web.setUserAgent(ua);

  /* ── Entrar con Google ─────────────────────────────────────────────────────
     Google corta el login desde navegadores "embebidos" ("No puedes acceder:
     es posible que este navegador no sea seguro"): no distingue a Prism de un
     Chromium metido en el medio para robar sesiones. Probado contra su login
     con un correo inventado (sep 2026): lo que lo dispara es window.chrome
     vacío. Hacerse pasar por Firefox, o sumar "Google Chrome" a las marcas,
     no alcanzó; completar window.chrome como lo trae Chrome, sí, sin tocar
     nada más. Lo hace src/chrome-preload.cjs, en todas las páginas: un Chrome
     de verdad lo tiene en todas. */
  web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'chrome-preload.cjs') });

  /* ── Ortografía en castellano (y en inglés) ────────────────────────────── */
  const avail = new Set(web.availableSpellCheckerLanguages || []);
  const langs = ['es-AR', 'es-419', 'es', 'en-US'].filter((l) => avail.has(l));
  const es = langs.find((l) => l.startsWith('es'));
  try { web.setSpellCheckerLanguages([es, 'en-US'].filter((l) => l && avail.has(l))); } catch { /* sin diccionarios */ }

  /* ── Permisos ──────────────────────────────────────────────────────────── */

  /* En incógnito, lo que se decide vale solo mientras dure la ventana: no se
     lee ni se escribe en los ajustes. */
  const mem = {};
  const decided = (origin, key) => (priv ? mem[origin]?.[key] : ctx.settings.permissions?.[origin]?.[key]) || null;

  async function remember(origin, keys, value) {
    if (priv) {
      mem[origin] = { ...(mem[origin] || {}) };
      for (const k of keys) mem[origin][k] = value;
      return;
    }
    await ctx.updateSettings((s) => {
      const all = { ...(s.permissions || {}) };
      all[origin] = { ...(all[origin] || {}) };
      for (const k of keys) all[origin][k] = value;
      return { permissions: all };
    });
  }

  /* "Permitir" sin "Recordar" vale mientras esa pestaña siga en ese sitio:
     una videollamada pide la cámara varias veces (al entrar, al cambiar de
     dispositivo) y preguntar en cada una sería insoportable. Se olvida al
     irse a otro sitio o al cerrar la pestaña. */
  const once = new Map();     // wcId → { origin, keys: Set }
  /* Los escuchadores se cuelgan una sola vez por pestaña. Colgarlos cada vez
     que la entrada se creaba de nuevo (después de irse a otro sitio o de
     "Olvidar") los iba sumando: uno más por cada permiso concedido. */
  const watched = new WeakSet();
  function grantOnce(wc, origin, keys) {
    if (!wc || wc.isDestroyed()) return;
    const g = once.get(wc.id);
    if (g && g.origin === origin) { keys.forEach((k) => g.keys.add(k)); return; }
    once.set(wc.id, { origin, keys: new Set(keys) });
    if (watched.has(wc)) return;
    watched.add(wc);
    const id = wc.id;
    wc.on('did-navigate', (_e, url) => { if (omni.originOf(url) !== once.get(id)?.origin) once.delete(id); });
    wc.once('destroyed', () => once.delete(id));
  }
  const grantedOnce = (wc, origin, key) => {
    const g = wc && once.get(wc.id);
    return !!g && g.origin === origin && g.keys.has(key);
  };
  /** Olvidar un sitio (Ajustes, el panel del sitio) también olvida lo de esta visita. */
  ctx.forgetOnce = (origin) => { for (const [id, g] of once) if (g.origin === origin) once.delete(id); };

  /** 'granted' · 'denied' · 'prompt', como lo diría Chrome. */
  function stateOf(wc, origin, key) {
    const d = decided(origin, key);
    if (d === 'allow' || grantedOnce(wc, origin, key)) return 'granted';
    if (d === 'deny') return 'denied';
    return 'prompt';
  }

  web.setPermissionRequestHandler((wc, permission, answer, details) => {
    /* Una pestaña con cámara o micrófono está en una llamada aunque nadie
       hable: no se duerme (tabs.cjs, canSleep). */
    const callback = (yes) => {
      if (yes && permission === 'media' && (details?.mediaTypes || []).length && wc) ctx.tabs?.markMedia(wc.id);
      answer(yes);
    };
    if (ALLOW.has(permission)) return callback(true);
    /* Compartir pantalla (getDisplayMedia) llega como 'media' sin tipos
       (desde Electron 45, como 'display-capture'). La que pregunta es el
       selector propio, más abajo (setDisplayMediaRequestHandler): acá solo se
       le abre la puerta. Negado acá, ni aparecía, y Meet no podía presentar. */
    if (permission === 'display-capture' || (permission === 'media' && !(details?.mediaTypes || []).length)) return callback(true);
    const origin = omni.originOf(details?.requestingUrl || wc?.getURL?.());
    if (!origin) return callback(false);

    let keys = permission === 'media' ? mediaKeys(details) : [permission];
    let label = null;
    if (permission === 'openExternal') {
      const scheme = schemeOf(details?.externalURL);
      if (!scheme || NEVER_OPEN.has(scheme)) return callback(false);
      keys = [`openExternal:${scheme}`];
      label = `abrir un link «${scheme}:» con una aplicación de tu compu`;
    } else if (!keys.length || keys.some((k) => !ASK[k])) return callback(false);

    // Si ya hay respuesta para todo lo pedido, no se vuelve a preguntar.
    const prev = keys.map((k) => stateOf(wc, origin, k));
    if (prev.every((v) => v === 'granted')) return callback(true);
    if (prev.some((v) => v === 'denied')) return callback(false);

    label ??= keys.length === 2 ? ASK['camera+microphone'] : ASK[keys[0]];
    ctx.prompts.permission({ origin, what: label, keys, wcId: wc?.id })
      .then(async ({ allow, remember: keep }) => {
        if (keep) await remember(origin, keys, allow ? 'allow' : 'deny');
        else if (allow) grantOnce(wc, origin, keys);
        callback(!!allow);
      })
      .catch(() => callback(false));
  });

  /* El chequeo sincrónico (enumerateDevices, Notification.permission…): solo
     dice que sí a lo que la persona concedió, guardado o por esta visita. */
  web.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (ALLOW.has(permission)) return true;
    const origin = omni.originOf(requestingOrigin || details?.requestingUrl);
    if (!origin) return false;
    if (permission === 'media') {
      const k = details?.mediaType === 'video' ? 'camera' : details?.mediaType === 'audio' ? 'microphone' : null;
      return !!k && stateOf(wc, origin, k) === 'granted';
    }
    return stateOf(wc, origin, permission) === 'granted';
  });

  /* Electron solo sabe decir sí o no: lo que no se preguntó todavía le llega
     a la página como "denied", y una videollamada que lee "denied" muestra
     "tu navegador bloqueó la cámara" y ni la pide (lo mismo las
     notificaciones: un sitio que las ve bloqueadas no las ofrece).
     src/permissions-preload.cjs corrige lo que lee la página con el estado
     de verdad, que sale de acá: del documento que pregunta, nunca de otro. */
  const QUERYABLE = ['camera', 'microphone', 'geolocation', 'notifications'];
  statesBySession.set(web, (e) => {
    const wc = e.sender;
    if (!wc || wc.session !== web || e.senderFrame?.parent) return null;
    const origin = omni.originOf(e.senderFrame?.url);
    return origin ? Object.fromEntries(QUERYABLE.map((k) => [k, stateOf(wc, origin, k)])) : null;
  });
  listenPermChannels();
  web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'permissions-preload.cjs') });

  /* ── La ventanita ──────────────────────────────────────────────────────────
     El botón sobre los videos y el manejo del video que se va a la ventanita
     (src/pip.cjs). Corre en cada frame: el video puede estar en un iframe. */
  web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'pip-preload.cjs') });

  /* ── Imprimir ──────────────────────────────────────────────────────────────
     El window.print() de un sitio abre la pantalla de impresión de Prism, con
     vista previa, en vez del diálogo de Windows (src/print-preload.cjs). */
  web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'print-preload.cjs') });

  /* ── Archivos soltados ─────────────────────────────────────────────────────
     Un PDF soltado sobre una página se abre en su pestaña, si la página no lo
     tomó como adjunto (src/drop-preload.cjs). */
  web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'drop-preload.cjs') });

  /* ── Compartir pantalla ────────────────────────────────────────────────────
     Sin este manejador, getDisplayMedia falla directo: Meet dice que no se
     puede presentar. El selector es propio, con miniaturas de cada pantalla y
     ventana, y el audio del sistema solo se ofrece para pantalla completa
     (Windows no captura el audio de una ventana suelta). */
  web.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      const origin = omni.originOf(request.securityOrigin || request.frame?.url) || '';
      const pick = await ctx.prompts.pickSource({
        origin,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen') ? 'screen' : 'window',
          thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        })),
      });
      const src = pick && sources.find((s) => s.id === pick.id);
      if (!src) return callback({});
      // Presentando: la pestaña no se duerme (tabs.cjs, canSleep).
      const wc = request.frame && webContents.fromFrame(request.frame);
      if (wc) ctx.tabs?.markMedia(wc.id);
      callback({ video: src, ...(pick.audio && src.id.startsWith('screen') ? { audio: 'loopback' } : {}) });
    } catch (err) {
      console.error('[display-media]', err.message);
      try { callback({}); } catch { /* ya respondido */ }
    }
  }, { useSystemPicker: false });

  // Al cerrar la ventana de incógnito, su sesión deja de contestar.
  const dispose = () => statesBySession.delete(web);
  return { session: web, userAgent: ua, dispose };
}

module.exports = { createWeb, ASK, ALLOW, NEVER_OPEN, schemeOf };
