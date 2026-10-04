'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — pestañas
   Cada pestaña web es un WebContentsView: un Chromium de verdad, con su propio
   proceso, apoyado ENCIMA del DOM de la ventana en el rectángulo de la página.
   Las pestañas propias (nueva pestaña, historial, ajustes…) no tienen vista:
   las dibuja el renderer de la ventana, y por eso pueden ser vidrio sobre la
   niebla como el resto del shell.

   Este módulo es la única fuente de verdad del estado de las pestañas. El
   renderer no guarda nada: recibe una foto completa (`tabs:state`) cada vez
   que algo cambia y la dibuja. Así nunca hay dos versiones del estado que se
   puedan desincronizar.

   ── Lo que obliga a hacer una vista nativa encima del DOM ─────────────────
   Una WebContentsView tapa TODO lo que el DOM dibuje en su rectángulo, sin
   importar el z-index. Un menú o un modal que caiga sobre la página quedaría
   debajo. Por eso existe el "congelado": se le saca una foto a la página, el
   renderer la pinta en su lugar, y recién ahí se esconde la vista. El overlay
   aparece sobre la foto — y como la foto está en el DOM, el vidrio del
   overlay la esmerila de verdad.

   ── Fijadas y dormidas ─────────────────────────────────────────────────────
   Las fijadas van siempre juntas a la izquierda (el arreglo `tabs` lo
   garantiza: primero todas las fijadas, después el resto), no se cierran con
   Ctrl+W y nunca se duermen: son lo que tiene que estar vivo siempre.
   Dormir una pestaña es cerrar su proceso y quedarse con su historial de
   Chromium (direcciones, scroll y lo escrito en los formularios). Al mirarla
   se restaura desde ahí: vuelve donde estaba, con atrás y adelante.

   ── Vista dividida ─────────────────────────────────────────────────────────
   Un par de pestañas que se ven juntas, lado a lado: `a` a la izquierda y
   `b` a la derecha, siempre contiguas en `tabs` (normalizeSplits lo
   sostiene). Mirar una pestaña de un par muestra el par entero; la activa
   es la mitad donde está la persona, y es la que manejan la omnibox, atrás,
   recargar y el zoom. Hacer clic en la otra mitad la vuelve la activa.

   ── La ventanita ───────────────────────────────────────────────────────────
   Una pestaña cuyo video está en la ventanita (src/pip.cjs) presta su vista:
   `away` dice que la vista vive allá, y acá no se la toca (no se pega a la
   ventana, no se le da el teclado, no se duerme). Su hoja muestra que el
   video está afuera.
   ═══════════════════════════════════════════════════════════════════════════ */

const { WebContentsView, clipboard, nativeImage, screen, shell } = require('electron');
const omni = require('./omni.cjs');

const BG = '#0a0a0a';
const RADIUS = 10;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_CLOSED = 25;
const SLEEP_CHECK = 60 * 1000;
/* Una pestaña que sonó hace poco no se duerme: Chromium la da por callada a
   los 2 s del último sonido, y el barrido podía caer justo en el hueco entre
   dos temas o en un silencio de una llamada. */
const AUDIO_GRACE = 10 * 60 * 1000;
/** Mundo aislado propio: lo que Prism corre en una página, fuera del alcance de sus scripts. */
const PRISM_WORLD = 1001;
/** Aire entre las dos mitades de una vista dividida (ahí vive el divisor). */
const GAP = 8;
/** Cuánto dura un gesto de la persona para abrir ventanas: lo mismo que la activación de Chromium. */
const ACTIVATION_MS = 5000;
const OPENS_ON_INPUT = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'gestureTap', 'touchEnd']);
const clampRatio = (r) => Math.max(0.2, Math.min(0.8, Number(r) || 0.5));

function createTabs(ctx) {
  /* En incógnito (ctx.private) no se anota nada: ni visitas, ni títulos, ni
     favicons. Se lee igual: la estrella de un favorito, los íconos que ya se
     conocían. */
  const library = ctx.private
    ? Object.assign(Object.create(ctx.library), { visit() {}, setTitle() {}, setFavicon() {} })
    : ctx.library;
  /** Las páginas propias que no son la pestaña nueva (historial, ajustes…)
      son de la ventana normal: desde incógnito se abren allá, como en Chrome. */
  const elsewhere = (page) => ctx.private && page && page !== 'nueva';
  const tabs = [];
  let activeId = null;
  let seq = 0;
  const closed = [];
  const byWc = new Map();
  let insets = { top: 84, right: 8, bottom: 26, left: 8 };
  let fullscreen = false;
  let frozen = false;
  const attached = new Map();   // vista → lugar que ocupa (0: la hoja o su izquierda · 1: la derecha)
  const splits = [];            // pares { a, b, ratio }

  const get = (id) => tabs.find((t) => t.id === Number(id)) || null;
  const active = () => get(activeId);
  const indexOf = (id) => tabs.findIndex((t) => t.id === Number(id));
  const pinnedCount = () => tabs.filter((t) => t.pinned).length;
  /** Dónde puede caer una pestaña: las fijadas, entre las fijadas; el resto, después. */
  const clampIndex = (i, pinned) => {
    const pc = pinnedCount();
    return pinned ? Math.max(0, Math.min(pc, i)) : Math.max(pc, Math.min(tabs.length, i));
  };

  /* ── Vista dividida: quién está con quién ──────────────────────────────── */

  const pairOf = (id) => splits.find((x) => x.a === Number(id) || x.b === Number(id)) || null;
  const partnerOf = (id) => { const x = pairOf(id); return x ? get(x.a === Number(id) ? x.b : x.a) : null; };
  /** El par que se ve: el de la pestaña activa, si tiene uno. */
  const shownPair = () => (fullscreen ? null : pairOf(activeId));
  /** Las pestañas que se ven ahora, por lugar: [izquierda, derecha] o [la activa]. */
  function visible() {
    const x = shownPair();
    if (x) return [get(x.a), get(x.b)];
    const t = active();
    return t ? [t] : [];
  }
  const isVisible = (id) => visible().some((t) => t?.id === Number(id));
  /** Una pestaña nueva no cae entre las dos de un par: va después. */
  function notInsidePair(i) {
    const l = tabs[i - 1];
    const r = tabs[i];
    const x = l && pairOf(l.id);
    return x && x.a === l.id && r?.id === x.b ? i + 1 : i;
  }

  /* Los pares se sostienen solos: si una de las dos se cerró o se fijó, el
     par se deshace; si quedaron separadas, la derecha vuelve junto a la
     izquierda. */
  function normalizeSplits() {
    for (let i = splits.length - 1; i >= 0; i--) {
      const x = splits[i];
      const a = get(x.a);
      const b = get(x.b);
      if (!a || !b || a.pinned || b.pinned) { splits.splice(i, 1); continue; }
      if (indexOf(x.b) !== indexOf(x.a) + 1) {
        tabs.splice(indexOf(x.b), 1);
        tabs.splice(indexOf(x.a) + 1, 0, b);
      }
    }
  }

  /* ── Estado → renderer ─────────────────────────────────────────────────── */

  function publicTab(t) {
    const nav = t.view?.webContents?.navigationHistory;
    return {
      id: t.id,
      url: t.url,
      title: t.title || (t.internal ? omni.INTERNAL[t.internal] : '') || t.url,
      favicon: t.favicon,
      loading: t.loading,
      internal: t.internal,
      error: t.error,
      // Abierta confiando en un certificado que Chromium no valida: la barra
      // no puede mostrarle el candado de "conexión segura".
      certAccepted: !t.internal && !t.error && !!t.certAccepted,
      crashed: t.crashed,
      audible: t.audible,
      muted: t.muted,
      pinned: t.pinned,
      split: pairOf(t.id) ? (pairOf(t.id).a === t.id ? 'a' : 'b') : null,
      pip: !!t.pip,
      zoom: t.zoom,
      blocked: t.blocked,
      dormant: !t.view && !t.internal,
      canGoBack: !!(nav?.canGoBack() || t.backTo),
      canGoForward: !!nav?.canGoForward(),
      bookmarked: library.isBookmarked(t.url),
      adblockOff: !ctx.settings.adblock || ctx.adblock?.isAllowed(t.url),
    };
  }

  function snapshot() {
    return {
      activeId,
      tabs: tabs.map(publicTab),
      canReopen: closed.length > 0,
      fullscreen,
      split: shownPair() && { a: shownPair().a, b: shownPair().b, ratio: shownPair().ratio, gap: GAP },
    };
  }

  let emitTimer = null;
  function emit() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      ctx.send('tabs:state', snapshot());
      persist();
      const t = active();
      const app = ctx.private ? 'Prism · Incógnito' : 'Prism';
      if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setTitle(t ? `${publicTab(t).title} — ${app}` : app);
    }, 16);
  }

  /* ── Sesión: las pestañas sobreviven a un reinicio ─────────────────────── */
  /* Debounce con tope: cada cambio de una pestaña lo corre, y una que cambia
     el título cada segundo (un reloj, un pomodoro) lo corría para siempre.
     Lo pendiente llega al disco a los 5 s como mucho. */
  const PERSIST_MAX_WAIT = 5000;
  let persistTimer = null;
  let persistDue = 0;
  /** Lo último que se mandó a escribir: lo mismo otra vez no se escribe. */
  let lastSession = null;
  function persist() {
    clearTimeout(persistTimer);
    if (!persistDue) persistDue = Date.now() + PERSIST_MAX_WAIT;
    persistTimer = setTimeout(() => writeSession(), Math.max(0, Math.min(800, persistDue - Date.now())));
  }
  function sessionData() {
    return {
      active: Math.max(0, indexOf(activeId)),
      tabs: tabs.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon, ...(t.pinned ? { pinned: true } : {}) })),
      splits: splits.map((x) => ({ a: indexOf(x.a), b: indexOf(x.b), ratio: x.ratio })),
    };
  }
  /** Lo que hay que escribir, o null si es lo mismo que ya se mandó. */
  function takeSession() {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistDue = 0;
    // Incógnito no vuelve al reiniciar: sus pestañas no se escriben nunca.
    if (ctx.private) return null;
    const data = sessionData();
    const text = JSON.stringify(data);
    if (text === lastSession) return null;
    lastSession = text;
    return data;
  }
  function writeSession() {
    const data = takeSession();
    if (!data) return Promise.resolve();
    return ctx.sessionDoc.write(data).catch((err) => { lastSession = null; console.error('[session]', err.message); });
  }
  /** Igual, sin soltar el hilo: Windows se está apagando (ver store.cjs). */
  function writeSessionSync() {
    const data = takeSession();
    if (!data) return;
    try { ctx.sessionDoc.writeSync(data); } catch (err) { lastSession = null; console.error('[session]', err.message); }
  }

  /* ── Geometría ─────────────────────────────────────────────────────────── */

  function pageBounds() {
    const [w, h] = ctx.win.getContentSize();
    if (fullscreen) return { x: 0, y: 0, width: w, height: h };
    return {
      x: Math.round(insets.left),
      y: Math.round(insets.top),
      width: Math.max(0, Math.round(w - insets.left - insets.right)),
      height: Math.max(0, Math.round(h - insets.top - insets.bottom)),
    };
  }

  /** El rectángulo de cada lugar: la hoja entera, o sus dos mitades. El
      renderer hace la misma cuenta para dibujar las hojas debajo. */
  function slotRects() {
    const b = pageBounds();
    const x = shownPair();
    if (!x) return [b];
    const left = Math.round((b.width - GAP) * x.ratio);
    return [
      { x: b.x, y: b.y, width: left, height: b.height },
      { x: b.x + left + GAP, y: b.y, width: Math.max(0, b.width - GAP - left), height: b.height },
    ];
  }
  const rectOf = (t) => slotRects()[Math.max(0, visible().findIndex((x) => x?.id === t.id))] || pageBounds();

  /* Congelada, la vista NO se saca de la ventana: se corre afuera, con su
     mismo tamaño. Sacarla (removeChildView) la ocultaba para Chromium, que
     descartaba su frame; al volver mostraba el fondo blanco hasta repintar,
     y cerrar un menú pestañeaba. Corrida, sigue viva y pintada, no cambia de
     tamaño (la página no se remaqueta) y vuelve en el acto. */
  function layout() {
    // La tarjeta de la esquina (card.cjs) y la lista de contraseñas (fill.cjs)
    // siguen a la página y se quedan arriba de todo.
    ctx.card?.place();
    ctx.fill?.place();
    if (!attached.size) return;
    const rects = slotRects();
    for (const [view, slot] of attached) {
      const b = { ...(rects[slot] || rects[0]) };
      if (frozen && !fullscreen) b.x = -(b.width + 20000);
      view.setBounds(b);
      view.setBorderRadius(fullscreen ? 0 : RADIUS);
    }
  }

  function setInsets(next) {
    const n = {};
    for (const k of ['top', 'right', 'bottom', 'left']) n[k] = Math.max(0, Number(next?.[k]) || 0);
    insets = n;
    layout();
  }

  /** Qué vistas tienen que estar en la ventana ahora (una, o las dos de un par), y solo esas. */
  function syncAttached() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    const want = new Map();
    visible().forEach((t, slot) => {
      if (t && t.view && t.shown && !t.error && !t.crashed && !t.away) want.set(t.view, slot);
    });
    for (const view of [...attached.keys()]) {
      if (want.has(view)) continue;
      try { ctx.win.contentView.removeChildView(view); } catch { /* ya no estaba */ }
      attached.delete(view);
    }
    for (const [view, slot] of want) {
      if (!attached.has(view)) ctx.win.contentView.addChildView(view);
      attached.set(view, slot);
    }
    layout();
  }

  /* ── Vistas ────────────────────────────────────────────────────────────── */

  function ensureView(t) {
    if (t.view) return t.view;
    const view = new WebContentsView({
      webPreferences: {
        session: ctx.web,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        /* Los preloads de la sesión corren también en los iframes (no Node:
           con sandbox, solo el preload). El video de YouTube embebido en el
           aula del campus vive en uno, y la ventanita tiene que encontrarlo. */
        nodeIntegrationInSubFrames: true,
        spellcheck: true,
        safeDialogs: true,
        // El visor de PDF de Chromium es un plugin: sin esto un PDF se descarga.
        plugins: true,
      },
    });
    /* Oscuro hasta el primer DOM: una pestaña nueva no destella blanco
       mientras la página todavía no pintó. En dom-ready pasa a blanco, que es
       el lienzo que el estándar le da a una página sin fondo declarado — si
       quedara oscuro, esas páginas saldrían con texto negro sobre negro. */
    view.setBackgroundColor(BG);
    view.setBorderRadius(RADIUS);
    /* Nace con el tamaño de la página aunque todavía no esté en la ventana:
       así maqueta una sola vez, y una pestaña que despierta puede volver a su
       scroll (en 0×0 no hay adónde scrollear). */
    if (ctx.win && !ctx.win.isDestroyed()) view.setBounds(rectOf(t));
    t.view = view;
    t.shown = false;
    const wc = view.webContents;
    byWc.set(wc.id, t);
    wire(t, wc);
    return view;
  }

  function destroyView(t) {
    const view = t.view;
    if (!view) return;
    // Si el video estaba en la ventanita (o yendo), la ventanita se va con la
    // pestaña: primero se desvanece, y recién ahí se cierra la página.
    const leaving = ctx.pip?.drop(t);
    if (attached.has(view)) {
      try { ctx.win.contentView.removeChildView(view); } catch { /* nada */ }
      attached.delete(view);
    }
    byWc.delete(view.webContents.id);
    t.view = null;
    t.shown = false;
    const close = () => { try { view.webContents.close(); } catch { /* ya estaba cerrada */ } };
    if (leaving) leaving.then(close, close);
    else close();
  }

  function wire(t, wc) {
    const touch = () => emit();

    wc.on('focus', () => {
      ctx.notePageFocus?.();
      // Un clic en la otra mitad de una vista dividida la vuelve la activa.
      if (t.id !== activeId && isVisible(t.id)) activateTab(t.id, { focusPage: false });
    });
    wc.on('did-start-loading', () => { t.loading = true; touch(); });
    wc.on('did-stop-loading', () => { t.loading = false; touch(); });

    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      // Otra página: el video de la ventanita ya no existe, la pestaña vuelve.
      if (t.pip) ctx.pip?.lost(t);
      // El contador del escudo es por página: una navegación nueva lo reinicia.
      t.pendingBlocked = 0;
      // La llamada (cámara, micrófono, pantalla) era de la página que se va.
      t.usesMedia = false;
      t.navPending = true;
    });

    wc.on('did-navigate', (_e, url) => {
      t.url = url;
      /* Volver atrás desde la caché de Chromium (bfcache) restaura la página
         entera sin volver a emitir page-title-updated: el título se lee acá. */
      const title = wc.getTitle();
      t.title = title && title !== url ? title : '';
      t.error = null;
      t.crashed = false;
      /* Se decide al abrir la página y queda fijo hasta la próxima: olvidar el
         certificado desde Ajustes no puede pasar esta página abierta a
         "conexión segura". */
      t.certAccepted = !!ctx.certs?.acceptedFor(url);
      t.blocked = t.pendingBlocked || 0;
      t.pendingBlocked = 0;
      t.navPending = false;
      t.favicon = library.faviconFor(url);
      t.everCommitted = true;
      if (!t.shown) { t.shown = true; syncAttached(); }
      // Despertar no es visitar: la página ya estaba abierta.
      if (t.waking) t.waking = false;
      else library.visit(url, wc.getTitle() === url ? '' : wc.getTitle());
      t.zoom = wc.getZoomFactor();
      touch();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame || url === t.url) return;
      t.url = url;
      library.visit(url, t.title);
      touch();
    });

    wc.on('dom-ready', () => {
      if (!t.painted) { t.painted = true; t.view?.setBackgroundColor('#ffffff'); }
      if (!t.shown) { t.shown = true; syncAttached(); }
    });

    wc.on('page-title-updated', (_e, title) => {
      t.title = title;
      library.setTitle(t.url, title);
      touch();
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      const icon = (icons || []).find((u) => /^(https?|data):/i.test(u));
      if (!icon) return;
      t.favicon = icon;
      library.setFavicon(t.url, icon);
      touch();
    });

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 es ERR_ABORTED: una navegación que otra reemplazó, o una descarga.
      if (!isMainFrame) return;
      t.navPending = false;
      if (code === -3) return;
      t.error = { code, desc, url };
      // Un certificado inválido: la página de error ofrece confiar en él si es
      // de la red local (certs.cjs decide).
      if (code <= -200 && code > -300) t.error.cert = ctx.certs?.rejectedFor(wc.id, url) || null;
      t.url = url || t.url;
      t.loading = false;
      // Lo que quedaba de la página anterior (título, ícono, bloqueados) ya no
      // describe nada: la pestaña pasa a llamarse como el sitio que no cargó.
      try { t.title = new URL(t.url).host || t.url; } catch { t.title = t.url; }
      t.favicon = null;
      t.blocked = 0;
      syncAttached();
      touch();
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      if (t.pip) ctx.pip?.lost(t);
      t.crashed = true;
      t.loading = false;
      syncAttached();
      touch();
    });

    wc.on('audio-state-changed', (e) => {
      if (t.audible && !e.audible) t.lastAudible = Date.now();
      t.audible = !!e.audible;
      touch();
    });

    wc.on('update-target-url', (_e, url) => {
      if (t.id === activeId) ctx.send('page:hover', url || '');
    });

    wc.on('found-in-page', (_e, r) => {
      if (t.id === activeId) ctx.send('page:find', { matches: r.matches, ordinal: r.activeMatchOrdinal, final: r.finalUpdate });
    });

    wc.on('context-menu', (_e, p) => {
      if (!isVisible(t.id)) return;
      // El frame del clic derecho: "Ver en una ventanita" saca el video de ese.
      t.contextFrame = p.frame || null;
      if (t.id !== activeId) activateTab(t.id, { focusPage: false });
      const b = rectOf(t);
      ctx.send('page:context', {
        x: b.x + p.x,
        y: b.y + p.y,
        pageX: p.x,
        pageY: p.y,
        linkURL: p.linkURL,
        linkText: p.linkText,
        srcURL: p.srcURL,
        mediaType: p.mediaType,
        hasImageContents: p.hasImageContents,
        selectionText: p.selectionText,
        isEditable: p.isEditable,
        editFlags: p.editFlags,
        misspelledWord: p.misspelledWord,
        suggestions: p.dictionarySuggestions || [],
        pageURL: p.pageURL,
        canGoBack: wc.navigationHistory.canGoBack() || !!t.backTo,
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });

    /* En la ventanita, la pantalla completa es la del video adentro de su
       ventana chica: la ventana grande no se entera. Si la página sale sola
       de ella, el video vuelve a su pestaña. */
    wc.on('enter-html-full-screen', () => { if (!t.pip) setFullscreen(true); });
    wc.on('leave-html-full-screen', () => {
      if (t.pip) { if (!ctx.pip?.isClosing(t)) ctx.pip?.lost(t); return; }
      setFullscreen(false);
    });

    wc.on('zoom-changed', (_e, dir) => { if (t.id === activeId) zoom(dir === 'in' ? 'in' : 'out'); });

    /* Irse de una página con `beforeunload` no pregunta: se va. Sin esto la
       navegación queda frenada en silencio y parece que el link no anda. */
    wc.on('will-prevent-unload', (e) => e.preventDefault());

    wc.on('before-input-event', (e, input) => {
      // Escape saca de la pantalla completa de la página (un video, una
      // presentación). Fuera de eso, Escape es de la página: cierra SUS modales.
      if (fullscreen && input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault();
        wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
        setFullscreen(false);
        return;
      }
      const cmd = ctx.shortcuts.match(input);
      if (!cmd) return;
      e.preventDefault();
      ctx.command(cmd, { from: 'page' });
    });

    watchGestures(wc);
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!activated(wc)) { blockedPopup(t, url); return { action: 'deny' }; }
      /* window.open con tamaño es un popup de verdad (el login de Google, un
         pago): necesita su `opener`, así que se abre como ventana. Todo lo
         demás —target=_blank, click del medio— es una pestaña. */
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            backgroundColor: BG,
            autoHideMenuBar: true,
            width: 520,
            height: 680,
            // En modo verificación (el humo) no aparece en la pantalla de quien está usando la compu.
            show: !process.env.PRISM_SHOTS,
            webPreferences: { session: ctx.web, sandbox: true, contextIsolation: true },
          },
        };
      }
      const background = disposition === 'background-tab';
      create({ url, active: !background, index: indexOf(t.id) + 1 + countOpenedBy(t.id), openerId: t.id });
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      watchGestures(child.webContents);
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (activated(child.webContents)) create({ url, active: true });
        else blockedPopup(t, url);
        return { action: 'deny' };
      });
      child.webContents.on('dom-ready', () => growIfPdf(child));
      /* La ventanita no tiene barra de direcciones: el título dice de qué
         sitio es, primero, para que un login falso no pueda pasar por el de
         Google con solo ponerse ese título. */
      const titled = () => {
        if (child.isDestroyed()) return;
        const host = omni.bareHost(child.webContents.getURL());
        const title = child.webContents.getTitle();
        child.setTitle(host ? `${host} · ${title}` : title);
      };
      child.on('page-title-updated', (e) => { e.preventDefault(); titled(); });
      child.webContents.on('did-navigate', titled);
    });
  }

  /* ── Ventanas emergentes ───────────────────────────────────────────────────
     Electron no trae el bloqueador de Chrome: cualquier página abría ventanas
     y pestañas sin que la tocaras, en cantidad, y cada ventana podía imitar
     el login de un banco. Como en Chromium, una página abre otra solo dentro
     de los 5 s después de un click o una tecla en ella. Si no, se bloquea, y
     la tarjeta de la esquina avisa y ofrece abrirla. */
  const gestures = new Map();   // wcId → ms del último gesto
  function watchGestures(wc) {
    const id = wc.id;
    wc.on('input-event', (_e, ev) => { if (OPENS_ON_INPUT.has(ev.type)) gestures.set(id, Date.now()); });
    // Como en Chromium, el gesto es del documento: la página nueva no hereda el click de la anterior.
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) gestures.delete(id); });
    wc.once('destroyed', () => gestures.delete(id));
  }
  /** Si hubo un gesto reciente, y lo gasta: un click abre una sola cosa, como en Chromium. */
  function activated(wc) {
    const ok = Date.now() - (gestures.get(wc.id) || 0) < ACTIVATION_MS;
    if (ok) gestures.delete(wc.id);
    return ok;
  }

  function blockedPopup(t, url) {
    const from = omni.bareHost(t.url) || 'Este sitio';
    const to = omni.bareHost(url);
    const web = /^https?:\/\//i.test(url || '');
    ctx.card?.show({
      kind: 'done',
      icon: 'window',
      title: 'Ventana emergente bloqueada',
      text: `${from} quiso abrir ${to && to !== from ? to : 'otra ventana'} sin que hicieras click.`,
      buttons: web ? [{ id: 'open', label: 'Abrirla', icon: 'external' }] : [],
      life: 8000,
    }, {
      // A su derecha, como cualquier link que abre; si ya se cerró, al final.
      open: () => create({ url, active: true, ...(get(t.id) ? { index: indexOf(t.id) + 1 + countOpenedBy(t.id), openerId: t.id } : {}) }),
    });
  }

  /* El campus abre sus PDF en una ventanita con tamaño (window.open con
     width/height), y Prism le da 520 px. Ahí, con la columna de miniaturas
     abierta, al visor de Chromium le quedan ~200 px para la hoja y la ajusta
     al mínimo: 25 %. Si lo que cargó es un PDF, la ventana crece en dom-ready,
     antes de que el visor calcule su zoom: con lugar, abre en 100 % (ajustar
     al ancho nunca pasa de ahí). Los popups que no son PDF (un login, un
     pago) quedan como estaban. */
  async function growIfPdf(win) {
    if (win.isDestroyed() || win.grownForPdf) return;
    const type = await win.webContents.executeJavaScript('document.contentType', true).catch(() => '');
    if (type !== 'application/pdf' || win.isDestroyed()) return;
    win.grownForPdf = true;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const width = Math.round(area.width * 0.85);
    const height = Math.round(area.height * 0.9);
    win.setBounds({
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    });
  }

  function countOpenedBy(id) {
    // Los links que abre una pestaña se encolan a su derecha, en orden, como
    // en Chrome: abrir tres resultados de búsqueda los deja 1-2-3, no 3-2-1.
    let n = 0;
    for (let i = indexOf(id) + 1; i < tabs.length && tabs[i].openerId === id; i++) n++;
    return n;
  }

  /* ── Crear, navegar, cerrar ────────────────────────────────────────────── */

  function blank(url) {
    return {
      id: ++seq,
      url: url || omni.internalUrl('nueva'),
      title: '',
      favicon: null,
      loading: false,
      internal: null,
      error: null,
      crashed: false,
      audible: false,
      muted: false,
      pinned: false,
      zoom: 1,
      blocked: 0,
      pendingBlocked: 0,
      view: null,
      shown: false,
      painted: false,
      backTo: null,
      openerId: null,
      everCommitted: false,
      lastSeen: Date.now(),
      slept: null,
      waking: false,
    };
  }

  /**
   * Abre una pestaña. `url` vacía → nueva pestaña. `dormant` deja la pestaña
   * con su dirección pero sin cargar: así restaurar diez pestañas no levanta
   * diez procesos de golpe — cada una carga recién cuando la mirás.
   */
  function create({ url = '', active: activate = true, index, openerId = null, dormant = false, title = '', favicon = null, pinned = false } = {}) {
    if (elsewhere(omni.internalPage(url))) { ctx.openPage(omni.internalPage(url)); return null; }
    const t = blank(url);
    t.openerId = openerId;
    t.pinned = !!pinned;
    const at = clampIndex(Number.isInteger(index) ? index : tabs.length, t.pinned);
    tabs.splice(t.pinned ? at : notInsidePair(at), 0, t);

    const page = omni.internalPage(t.url);
    if (page) {
      t.internal = page;
    } else if (dormant) {
      t.title = title;
      t.favicon = favicon;
    } else {
      load(t, t.url);
    }
    if (activate) activateTab(t.id);
    else emit();
    return t.id;
  }

  function load(t, url) {
    const page = omni.internalPage(url);
    if (elsewhere(page)) { ctx.openPage(page); return; }
    if (page) { toInternal(t, page); return; }
    if (t.internal) t.backTo = t.internal;
    t.internal = null;
    t.error = null;
    t.crashed = false;
    t.url = url;
    t.loading = true;
    ensureView(t);
    if (t.muted) t.view.webContents.setAudioMuted(true);
    t.view.webContents.loadURL(url).catch(() => { /* did-fail-load lo cuenta */ });
    syncAttached();
    emit();
  }

  function toInternal(t, page) {
    if (t.view) destroyView(t);
    t.internal = page;
    t.url = omni.internalUrl(page);
    t.title = omni.INTERNAL[page];
    t.favicon = null;
    t.loading = false;
    t.error = null;
    t.crashed = false;
    t.backTo = null;
    t.blocked = 0;
    syncAttached();
    emit();
  }

  /** Lo que llega de la omnibox: texto crudo que hay que clasificar. */
  function navigate(id, input) {
    const t = get(id) || active();
    if (!t) return null;
    const r = omni.classify(input, ctx.settings.searchEngine);
    if (!r) return null;
    load(t, r.url);
    if (t.id === activeId && t.view && !t.away) t.view.webContents.focus();
    return r;
  }

  function activateTab(id, { focusPage = true } = {}) {
    const t = get(id);
    if (!t) return;
    const changed = activeId !== t.id;
    if (changed) { const prev = active(); if (prev) prev.lastSeen = Date.now(); }
    activeId = t.id;
    if (!t.internal && !t.view) wake(t);              // una dormida se despierta al mirarla
    const p = partnerOf(t.id);                        // y en un par, se ven las dos
    if (p && !p.internal && !p.view) wake(p);
    syncAttached();
    if (changed) ctx.send('page:hover', '');
    if (focusPage && t.view && t.shown && !t.away) t.view.webContents.focus();
    emit();
  }

  function close(id) {
    const i = indexOf(id);
    if (i < 0) return;
    const t = tabs[i];
    // Cerrar una mitad deshace el par; si era la activa, queda la otra.
    const partner = partnerOf(t.id);
    if (partner) splits.splice(splits.indexOf(pairOf(t.id)), 1);
    if (!t.internal || t.internal !== 'nueva') {
      closed.push({ url: t.url, title: t.title, favicon: t.favicon, index: i, pinned: t.pinned });
      if (closed.length > MAX_CLOSED) closed.shift();
    }
    tabs.splice(i, 1);
    destroyView(t);

    if (!tabs.length) {
      // La última no deja la ventana vacía: queda una nueva pestaña.
      create({});
      return;
    }
    if (activeId === t.id) {
      // Como Chrome: si la abrió otra pestaña, se vuelve a esa; si no, la de la derecha.
      const opener = t.openerId && get(t.openerId);
      activateTab((partner || opener || tabs[Math.min(i, tabs.length - 1)]).id);
    } else { syncAttached(); emit(); }
  }

  function reopen() {
    const c = closed.pop();
    if (!c) return;
    create({ url: c.url, index: c.index, active: true, pinned: c.pinned });
  }

  // Como en Chrome, "cerrar las otras" y "las de la derecha" respetan las fijadas.
  // Con una pestaña que ya no existe no hacen nada: sin la guarda, un menú que
  // quedó abierto de una pestaña cerrada se llevaba TODAS (ninguna era "esa").
  function closeOthers(id) {
    if (!get(id)) return;
    for (const t of [...tabs]) if (t.id !== Number(id) && !t.pinned) close(t.id);
  }

  function closeRight(id) {
    const i = indexOf(id);
    if (i < 0) return;
    for (const t of tabs.slice(i + 1)) if (!t.pinned) close(t.id);
  }

  /** Mueve una pestaña; si es de un par, se mueve el par entero y `id` cae en `toIndex`. */
  function move(id, toIndex) {
    const i = indexOf(id);
    if (i < 0) return;
    const x = pairOf(id);
    const block = x ? [get(x.a), get(x.b)] : [tabs[i]];
    const offset = block.findIndex((b) => b.id === Number(id));
    for (const b of block) tabs.splice(indexOf(b.id), 1);
    const at = clampIndex((Number(toIndex) || 0) - offset, block[0].pinned);
    tabs.splice(block[0].pinned ? at : notInsidePair(at), 0, ...block);
    for (const b of block) b.openerId = null;
    emit();
  }

  /** Fijar la lleva al final de las fijadas; desfijar, a la primera después de ellas. */
  function pin(id, on) {
    const i = indexOf(id);
    if (i < 0 || tabs[i].pinned === !!on) return;
    const x = pairOf(id);
    if (x) splits.splice(splits.indexOf(x), 1);       // una fijada no va en un par
    const [t] = tabs.splice(i, 1);
    t.pinned = !!on;
    t.openerId = null;
    tabs.splice(pinnedCount(), 0, t);
    if (t.pinned && !t.internal && !t.view) wake(t);   // una fijada está viva
    syncAttached();
    emit();
  }

  function duplicate(id) {
    const t = get(id);
    if (!t) return;
    create({ url: t.url, index: indexOf(id) + 1 });
  }

  function mute(id) {
    const t = get(id);
    if (!t) return;
    t.muted = !t.muted;
    t.view?.webContents.setAudioMuted(t.muted);
    emit();
  }

  /** Una pestaña abierta solo para bajar un archivo no muestra nada: se cierra. */
  function closeIfDownloadOnly(wcId) {
    const t = byWc.get(wcId);
    if (t && !t.everCommitted && !t.backTo && tabs.length > 1) setTimeout(() => close(t.id), 0);
  }

  /* ── Vista dividida: armar, deshacer, dar vuelta, repartir ─────────────── */

  /** Arma un par: `id` a la izquierda y `otherId` (o una pestaña nueva) a la
      derecha, y la derecha pasa a ser la activa. */
  function split(id, otherId = null) {
    const t = get(id);
    if (!t || t.pinned || pairOf(t.id)) return null;
    let o = otherId == null ? null : get(otherId);
    if (otherId != null && (!o || o.id === t.id || o.pinned || pairOf(o.id))) return null;
    if (!o) {
      o = get(create({ index: indexOf(t.id) + 1, active: false }));
    } else {
      tabs.splice(indexOf(o.id), 1);
      tabs.splice(indexOf(t.id) + 1, 0, o);
      o.openerId = null;
    }
    splits.push({ a: t.id, b: o.id, ratio: 0.5 });
    activateTab(o.id);
    return o.id;
  }

  function unsplit(id) {
    const x = pairOf(id);
    if (!x) return;
    splits.splice(splits.indexOf(x), 1);
    syncAttached();
    emit();
  }

  /** Da vuelta el par: cada página conserva su ancho, cambia de lado. */
  function swapSplit(id) {
    const x = pairOf(id);
    if (!x) return;
    [x.a, x.b] = [x.b, x.a];
    x.ratio = clampRatio(1 - x.ratio);
    normalizeSplits();
    syncAttached();
    emit();
  }

  function setSplitRatio(id, ratio) {
    const x = pairOf(id) || shownPair();
    if (!x) return;
    x.ratio = clampRatio(ratio);
    layout();
    emit();
  }

  /* ── Dormir y despertar ────────────────────────────────────────────────── */

  /** Si esta pestaña se puede dormir ahora sin que la persona pierda nada. */
  function canSleep(t, now = Date.now()) {
    const min = Number(ctx.settings.sleepTabs) || 0;
    if (!min || !t.view || t.internal || t.pinned || t.pip || isVisible(t.id)) return false;
    if (t.sleeping || t.loading || !t.shown || t.error || t.crashed) return false;
    return !inUse(t, now) && now - t.lastSeen >= min * 60 * 1000;
  }

  /** Lo que la persona perdería si se duerme ahora: lo que suena, una llamada. */
  function inUse(t, now) {
    if (t.audible || (t.lastAudible && now - t.lastAudible < AUDIO_GRACE)) return true;
    /* Una llamada en segundo plano (Meet con todos callados) no suena, pero
       dormirla la corta. Lo que tuvo cámara, micrófono o pantalla queda
       despierto hasta que la pestaña se va a otra página. */
    if (t.usesMedia) return true;
    const wc = t.view.webContents;
    return wc.isCurrentlyAudible() || wc.isDevToolsOpened() || wc.isBeingCaptured();
  }

  /* Chromium anota el scroll y lo escrito en los formularios en su historial
     recién al navegar, no mientras la página está quieta (medido: ni visible
     ni oculta lo anota solo). Un replaceState que no cambia nada es una
     navegación mínima que lo obliga a anotarlo ya. Corre en un mundo aislado:
     las páginas que parchean `history` (routers de Next y compañía) no se
     enteran. Si la página no contesta, se duerme igual, sin el scroll. */
  function noteState(wc) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.off('did-navigate-in-page', done); resolve(); };
      const timer = setTimeout(done, 1500);
      wc.once('did-navigate-in-page', done);
      wc.executeJavaScriptInIsolatedWorld(PRISM_WORLD, [{ code: "history.replaceState(history.state, '')" }]).catch(done);
    });
  }

  async function sleep(id, now = Date.now()) {
    const t = get(id);
    if (!t?.view || t.internal || isVisible(t.id) || t.sleeping) return false;
    const view = t.view;
    t.sleeping = true;
    await noteState(view.webContents);
    t.sleeping = false;
    /* Mientras tanto (hasta 1,5 s) la pudieron mirar, cerrar o navegar a una
       página propia, o pudo empezar a sonar o a llamar: se vuelve a mirar.
       (No canSleep entero: el replaceState de recién la deja "cargando".) */
    if (t.view !== view || isVisible(t.id) || !get(t.id) || inUse(t, Math.max(now, Date.now()))) return false;
    const nav = view.webContents.navigationHistory;
    const entries = nav.getAllEntries();
    t.slept = entries.length ? { entries, index: nav.getActiveIndex() } : null;
    destroyView(t);
    t.loading = false;
    t.audible = false;
    emit();
    return true;
  }

  async function sweep(now = Date.now()) {
    let n = 0;
    for (const t of [...tabs]) if (canSleep(t, now) && await sleep(t.id, now)) n++;
    return n;
  }
  setInterval(() => { sweep().catch((err) => console.error('[dormir]', err.message)); }, SLEEP_CHECK);

  function wake(t) {
    const h = t.slept;
    t.slept = null;
    if (!h) { load(t, t.url); return; }
    t.error = null;
    t.crashed = false;
    t.loading = true;
    t.waking = true;
    ensureView(t);
    if (t.muted) t.view.webContents.setAudioMuted(true);
    /* restore devuelve una promesa que se rechaza si la página no carga. Eso
       ya lo cuenta did-fail-load: acá solo se atrapa, para que no quede una
       promesa rechazada suelta en el proceso principal. */
    t.view.webContents.navigationHistory.restore({ entries: h.entries, index: h.index }).catch(() => {});
    syncAttached();
    emit();
  }

  /* ── Navegación ────────────────────────────────────────────────────────── */

  function back() {
    const t = active();
    if (!t) return;
    const nav = t.view?.webContents.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
    else if (t.backTo) toInternal(t, t.backTo);
  }

  function forward() {
    const nav = active()?.view?.webContents.navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  }

  function reload(hard = false) {
    const t = active();
    if (!t || t.internal) return;
    if (t.error || t.crashed || !t.view) { load(t, t.error?.url || t.url); return; }
    hard ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload();
  }

  function stop() {
    active()?.view?.webContents.stop();
  }

  /* ── Zoom ──────────────────────────────────────────────────────────────── */

  function zoom(dir) {
    const t = active();
    const wc = t?.view?.webContents;
    if (!wc) return;
    const cur = wc.getZoomFactor();
    let next = 1;
    if (dir === 'in') next = ZOOMS.find((z) => z > cur + 0.001) ?? ZOOMS[ZOOMS.length - 1];
    else if (dir === 'out') next = [...ZOOMS].reverse().find((z) => z < cur - 0.001) ?? ZOOMS[0];
    wc.setZoomFactor(next);
    t.zoom = next;
    emit();
  }

  /* ── Pantalla completa de la página (un video, una presentación) ───────── */

  function setFullscreen(on) {
    if (fullscreen === on) return;
    fullscreen = on;
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setFullScreen(on);
    ctx.send('page:fullscreen', on);
    syncAttached();                // en pantalla completa se ve una sola, aunque sea de un par
    emit();
  }

  /* ── Congelado (ver el encabezado) ─────────────────────────────────────── */

  /** Una foto por vista en la ventana, con el lugar que ocupa (en un par, son dos). */
  async function snapshotPage() {
    const shots = [];
    for (const [view, slot] of attached) {
      /* La primera captura de una vista a veces sale vacía (todavía no tiene
         un frame propio que copiar): se reintenta un par de veces. */
      for (let i = 0; i < 3; i++) {
        try {
          const img = await view.webContents.capturePage();
          if (!img.isEmpty()) { shots.push({ slot, url: `data:image/jpeg;base64,${img.toJPEG(88).toString('base64')}` }); break; }
        } catch { /* se reintenta */ }
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return shots;
  }

  /* Lo que necesita la vista en su lugar (una captura pedida desde un menú)
     espera a que el overlay se vaya, y un par de cuadros más para que pinte. */
  const thawWaiters = new Set();
  function whenThawed(max = 2000) {
    return new Promise((resolve) => {
      if (!frozen) return resolve();
      const done = () => { clearTimeout(timer); thawWaiters.delete(done); setTimeout(resolve, 80); };
      const timer = setTimeout(done, max);
      thawWaiters.add(done);
    });
  }

  function hold(on) {
    frozen = !!on;
    // Un menú o un modal que se abre no puede quedar debajo de la tarjeta ni de la lista.
    if (frozen) { ctx.card?.hide(); ctx.fill?.hide(); }
    layout();
    if (!frozen) {
      for (const done of [...thawWaiters]) done();
      const t = active();
      // Si el foco estaba en la página antes del overlay, vuelve a ella.
      if (t?.view && !t.away && ctx.win?.isFocused()) {
        const chromeFocused = ctx.win.webContents.isFocused();
        if (!chromeFocused) t.view.webContents.focus();
      }
    }
  }

  function focusPage() {
    const t = active();
    if (t?.view && !t.away && attached.has(t.view)) t.view.webContents.focus();
  }

  /* ── La ventanita (src/pip.cjs) ────────────────────────────────────────── */

  /** La vista se va a la ventanita (o vuelve de ella). */
  function setAway(t, on) {
    t.away = !!on;
    syncAttached();
    emit();
  }

  /* Una vista nativa no se desvanece: aparece o no está. Para que irse a la
     ventanita (y volver) no sea un corte, en su hoja se pone una foto de la
     página (freeze.js, otra que la del congelado) que se desvanece sola. */
  const photoWaiters = new Map();
  let photoSeq = 0;
  const slotOf = (t) => visible().findIndex((x) => x?.id === t.id);

  /** Pone la foto en la hoja de `t` (si se ve) y espera a que esté en pantalla. */
  function showPhoto(t, url, { fade = false } = {}) {
    const slot = slotOf(t);
    if (slot < 0 || !url) return Promise.resolve(false);
    const nonce = ++photoSeq;
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); photoWaiters.delete(nonce); resolve(ok); };
      const timer = setTimeout(() => done(false), fade ? 900 : 500);
      photoWaiters.set(nonce, done);
      ctx.send('page:photo', { nonce, slot, url, fade });
    });
  }

  function hidePhoto(t, { fade = false } = {}) {
    const slot = slotOf(t);
    ctx.send('page:photo', { slot: slot < 0 ? 'all' : slot, url: null, fade });
  }

  /* ── Buscar en la página ───────────────────────────────────────────────── */

  /* Ojo con el nombre: en Electron `findNext: true` quiere decir "empezar una
     búsqueda NUEVA", y `false` "seguir con la que hay". Al revés de lo que
     sugiere. Por eso acá se habla de sesión. */
  function find(text, { forward: fwd = true, newSession = true } = {}) {
    const wc = active()?.view?.webContents;
    if (!wc || !text) return;
    wc.findInPage(String(text), { forward: fwd, findNext: newSession });
  }

  function stopFind() {
    for (const t of tabs) t.view?.webContents.stopFindInPage('clearSelection');
  }

  /* ── Menú contextual de la página ──────────────────────────────────────── */

  function contextAction(action, p = {}) {
    const t = active();
    const wc = t?.view?.webContents;
    switch (action) {
      case 'back': return back();
      case 'forward': return forward();
      case 'reload': return reload();
      case 'link-tab': return p.url && create({ url: p.url, active: false, index: indexOf(activeId) + 1 + countOpenedBy(activeId), openerId: activeId });
      case 'link-split': {
        // Al costado: si ya hay un par, el enlace va a la otra mitad.
        if (!p.url || !t || t.pinned) return null;
        const other = partnerOf(t.id);
        if (other) { load(other, p.url); activateTab(other.id); return other.id; }
        return split(t.id, create({ url: p.url, index: indexOf(t.id) + 1, active: false, openerId: t.id }));
      }
      case 'link-incognito': return p.url && ctx.openIncognito?.(p.url);
      case 'video-pip': return t && ctx.pip?.fromContext(ctx, t, t.contextFrame);
      case 'link-copy': return p.url && clipboard.writeText(p.url).catch(() => {});
      case 'link-save': return p.url && ctx.web.downloadURL(p.url);
      case 'image-tab': return p.url && create({ url: p.url, active: false, index: indexOf(activeId) + 1 });
      case 'image-copy': return wc?.copyImageAt(Math.round(p.x), Math.round(p.y));
      case 'image-copy-url': return p.url && clipboard.writeText(p.url).catch(() => {});
      case 'image-save': return p.url && ctx.web.downloadURL(p.url);
      case 'copy': return wc?.copy();
      case 'cut': return wc?.cut();
      case 'paste': return wc?.paste();
      case 'paste-plain': return wc?.pasteAndMatchStyle();
      case 'select-all': return wc?.selectAll();
      case 'undo': return wc?.undo();
      case 'redo': return wc?.redo();
      case 'search': {
        const q = String(p.text || '').trim().slice(0, 400);
        if (!q) return null;
        const url = omni.engine(ctx.settings.searchEngine).search.replace('%s', encodeURIComponent(q));
        return create({ url, index: indexOf(activeId) + 1, openerId: activeId });
      }
      case 'spell': return p.word && wc?.replaceMisspelling(p.word);
      case 'spell-add': return p.word && ctx.web.addWordToSpellCheckerDictionary(p.word);
      case 'inspect': return wc && (wc.inspectElement(Math.round(p.x), Math.round(p.y)), wc.isDevToolsOpened() || wc.openDevTools({ mode: 'detach' }));
      case 'source': return t && !t.internal && create({ url: `view-source:${t.url}`, index: indexOf(activeId) + 1 });
      // La pantalla de impresión propia, con vista previa (renderer/js/print.js).
      case 'print': if (!wc || t.internal) return null; ctx.focusChrome?.(); return ctx.send('cmd', 'print:open');
      default: return null;
    }
  }

  function devtools() {
    const wc = active()?.view?.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  /* ── Bloqueador ────────────────────────────────────────────────────────── */

  function countBlocked(wcId) {
    const t = byWc.get(wcId);
    if (!t) return;
    // Lo que se bloquea ANTES del commit es de la página que está llegando.
    if (t.navPending) t.pendingBlocked += 1;
    else t.blocked += 1;
    if (t.id === activeId) emit();
  }

  /* ── Restaurar ─────────────────────────────────────────────────────────── */

  function restore(data) {
    const list = Array.isArray(data?.tabs) ? data.tabs.filter((x) => x && typeof x.url === 'string') : [];
    if (!list.length) return false;
    const act = Math.max(0, Math.min(list.length - 1, Number(data.active) || 0));
    // Las fijadas cargan de entrada: son las que tienen que estar vivas (avisos, música).
    const ids = list.map((x, i) => create({ url: x.url, title: x.title, favicon: x.favicon, pinned: !!x.pinned, active: false, dormant: i !== act && !x.pinned }));
    for (const x of Array.isArray(data.splits) ? data.splits : []) {
      const a = ids[x?.a];
      const b = ids[x?.b];
      if (a && b && a !== b && !pairOf(a) && !pairOf(b)) splits.push({ a, b, ratio: clampRatio(x.ratio) });
    }
    normalizeSplits();
    activateTab(ids[act]);
    return true;
  }

  return {
    whenThawed, create, close, reopen, closeOthers, closeRight, move, duplicate, mute, pin, sleep, sweep, navigate,
    split, unsplit, swapSplit, setSplitRatio,
    activate: activateTab, back, forward, reload, stop, zoom, find, stopFind, devtools,
    contextAction, snapshotPage, hold, focusPage, setInsets, layout, pageBounds, restore, writeSession, writeSessionSync,
    setAway, rectFor: (t) => rectOf(t), showPhoto, hidePhoto,
    photoReady: (n) => photoWaiters.get(Number(n))?.(true),
    closeIfDownloadOnly, countBlocked,
    snapshot, emit,
    byWebContents: (id) => byWc.get(id) || null,
    /** La pestaña recibió cámara, micrófono o pantalla (web.cjs): no se duerme. */
    markMedia(wcId) { const t = byWc.get(wcId); if (t) t.usesMedia = true; },
    get active() { return active(); },
    get list() { return tabs; },
    get fullscreen() { return fullscreen; },
    setFullscreen,
    reloadAll: () => tabs.forEach((t) => t.view?.webContents.reload()),
    /** Cierra el proceso de cada pestaña (la ventana de incógnito que se va:
        una vista no muere sola con su ventana y seguiría sonando). */
    destroyAll() {
      clearTimeout(persistTimer);
      for (const t of tabs) destroyView(t);
      tabs.length = 0;
    },
    openInternal(page) {
      if (elsewhere(page)) { ctx.openPage(page); return; }
      // Si ya hay una pestaña con esa página, se va a esa en vez de abrir otra.
      const t = tabs.find((x) => x.internal === page);
      if (t) activateTab(t.id);
      else {
        const cur = active();
        if (cur?.internal === 'nueva') load(cur, omni.internalUrl(page));
        else create({ url: omni.internalUrl(page), index: indexOf(activeId) + 1 });
      }
    },
  };
}

module.exports = { createTabs, ZOOMS, BG, PRISM_WORLD };
