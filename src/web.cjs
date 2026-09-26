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

const { session, desktopCapturer } = require('electron');
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

/** El pedido de media se desarma en cámara / micrófono, que se recuerdan por separado. */
function mediaKeys(details) {
  const types = new Set(details?.mediaTypes || []);
  const keys = [];
  if (types.has('video')) keys.push('camera');
  if (types.has('audio')) keys.push('microphone');
  return keys;
}

function createWeb(ctx) {
  const web = session.fromPartition('persist:prism');

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

  const decided = (origin, key) => ctx.settings.permissions?.[origin]?.[key] || null;

  async function remember(origin, keys, value) {
    const all = { ...(ctx.settings.permissions || {}) };
    all[origin] = { ...(all[origin] || {}) };
    for (const k of keys) all[origin][k] = value;
    await ctx.saveSettings({ permissions: all });
  }

  web.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALLOW.has(permission)) return callback(true);
    const origin = omni.originOf(details?.requestingUrl || wc?.getURL?.());
    if (!origin) return callback(false);

    const keys = permission === 'media' ? mediaKeys(details) : [permission];
    if (!keys.length || keys.some((k) => !ASK[k])) return callback(false);

    // Si ya hay respuesta para todo lo pedido, no se vuelve a preguntar.
    const prev = keys.map((k) => decided(origin, k));
    if (prev.every((v) => v === 'allow')) return callback(true);
    if (prev.some((v) => v === 'deny')) return callback(false);

    const label = keys.length === 2 ? ASK['camera+microphone'] : ASK[keys[0]];
    ctx.prompts.permission({ origin, what: label, keys, wcId: wc?.id })
      .then(async ({ allow, remember: keep }) => {
        if (keep) await remember(origin, keys, allow ? 'allow' : 'deny');
        callback(!!allow);
      })
      .catch(() => callback(false));
  });

  /* El chequeo sincrónico (enumerateDevices, Notification.permission…): solo
     dice que sí a lo que la persona ya concedió explícitamente. */
  web.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (ALLOW.has(permission)) return true;
    const origin = omni.originOf(requestingOrigin || details?.requestingUrl);
    if (!origin) return false;
    if (permission === 'media') {
      const k = details?.mediaType === 'video' ? 'camera' : details?.mediaType === 'audio' ? 'microphone' : null;
      return !!k && decided(origin, k) === 'allow';
    }
    return decided(origin, permission) === 'allow';
  });

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
      callback({ video: src, ...(pick.audio && src.id.startsWith('screen') ? { audio: 'loopback' } : {}) });
    } catch (err) {
      console.error('[display-media]', err.message);
      try { callback({}); } catch { /* ya respondido */ }
    }
  }, { useSystemPicker: false });

  /* ── Scrollbars de las páginas ─────────────────────────────────────────────
     Un preload de sesión (src/page-preload.cjs) que corre antes de que el
     documento pinte. Prenderlo o apagarlo vale desde la próxima navegación. */
  let scrollbarsId = null;
  function setPageScrollbars(on) {
    if (on && !scrollbarsId) {
      scrollbarsId = web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'page-preload.cjs') });
    } else if (!on && scrollbarsId) {
      web.unregisterPreloadScript(scrollbarsId);
      scrollbarsId = null;
    }
  }
  setPageScrollbars(!!ctx.settings.pageScrollbars);

  return { session: web, userAgent: ua, setPageScrollbars };
}

module.exports = { createWeb, ASK, ALLOW };
