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
   ═══════════════════════════════════════════════════════════════════════════ */

const { WebContentsView, clipboard, nativeImage, shell } = require('electron');
const omni = require('./omni.cjs');

const BG = '#0a0a0a';
const RADIUS = 10;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_CLOSED = 25;
const SLEEP_CHECK = 60 * 1000;
/** Mundo aislado propio: lo que Prism corre en una página, fuera del alcance de sus scripts. */
const PRISM_WORLD = 1001;

function createTabs(ctx) {
  const tabs = [];
  let activeId = null;
  let seq = 0;
  const closed = [];
  const byWc = new Map();
  let insets = { top: 84, right: 8, bottom: 26, left: 8 };
  let fullscreen = false;
  let frozen = false;
  let attached = null;

  const get = (id) => tabs.find((t) => t.id === Number(id)) || null;
  const active = () => get(activeId);
  const indexOf = (id) => tabs.findIndex((t) => t.id === Number(id));
  const pinnedCount = () => tabs.filter((t) => t.pinned).length;
  /** Dónde puede caer una pestaña: las fijadas, entre las fijadas; el resto, después. */
  const clampIndex = (i, pinned) => {
    const pc = pinnedCount();
    return pinned ? Math.max(0, Math.min(pc, i)) : Math.max(pc, Math.min(tabs.length, i));
  };

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
      crashed: t.crashed,
      audible: t.audible,
      muted: t.muted,
      pinned: t.pinned,
      zoom: t.zoom,
      blocked: t.blocked,
      dormant: !t.view && !t.internal,
      canGoBack: !!(nav?.canGoBack() || t.backTo),
      canGoForward: !!nav?.canGoForward(),
      bookmarked: ctx.library.isBookmarked(t.url),
      adblockOff: !ctx.settings.adblock || ctx.adblock?.isAllowed(t.url),
    };
  }

  function snapshot() {
    return {
      activeId,
      tabs: tabs.map(publicTab),
      canReopen: closed.length > 0,
      fullscreen,
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
      if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setTitle(t ? `${publicTab(t).title} — Prism` : 'Prism');
    }, 16);
  }

  /* ── Sesión: las pestañas sobreviven a un reinicio ─────────────────────── */
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => writeSession(), 800);
  }
  function sessionData() {
    return {
      active: Math.max(0, indexOf(activeId)),
      tabs: tabs.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon, ...(t.pinned ? { pinned: true } : {}) })),
    };
  }
  function writeSession() {
    clearTimeout(persistTimer);
    return ctx.sessionDoc.write(sessionData()).catch((err) => console.error('[session]', err.message));
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

  /* Congelada, la vista NO se saca de la ventana: se corre afuera, con su
     mismo tamaño. Sacarla (removeChildView) la ocultaba para Chromium, que
     descartaba su frame; al volver mostraba el fondo blanco hasta repintar,
     y cerrar un menú pestañeaba. Corrida, sigue viva y pintada, no cambia de
     tamaño (la página no se remaqueta) y vuelve en el acto. */
  function layout() {
    if (!attached) return;
    const b = pageBounds();
    if (frozen && !fullscreen) b.x = -(b.width + 20000);
    attached.setBounds(b);
    attached.setBorderRadius(fullscreen ? 0 : RADIUS);
  }

  function setInsets(next) {
    const n = {};
    for (const k of ['top', 'right', 'bottom', 'left']) n[k] = Math.max(0, Number(next?.[k]) || 0);
    insets = n;
    layout();
  }

  /** Qué vista tiene que estar en la ventana ahora, y solo esa. */
  function syncAttached() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    const t = active();
    const want = t && t.view && t.shown && !t.error && !t.crashed ? t.view : null;
    if (attached === want) { layout(); return; }
    if (attached) {
      try { ctx.win.contentView.removeChildView(attached); } catch { /* ya no estaba */ }
    }
    attached = want;
    if (want) {
      ctx.win.contentView.addChildView(want);
      layout();
    }
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
    if (ctx.win && !ctx.win.isDestroyed()) view.setBounds(pageBounds());
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
    if (attached === view) {
      try { ctx.win.contentView.removeChildView(view); } catch { /* nada */ }
      attached = null;
    }
    byWc.delete(view.webContents.id);
    t.view = null;
    t.shown = false;
    try { view.webContents.close(); } catch { /* ya estaba cerrada */ }
  }

  function wire(t, wc) {
    const touch = () => emit();

    wc.on('did-start-loading', () => { t.loading = true; touch(); });
    wc.on('did-stop-loading', () => { t.loading = false; touch(); });

    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      // El contador del escudo es por página: una navegación nueva lo reinicia.
      t.pendingBlocked = 0;
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
      t.blocked = t.pendingBlocked || 0;
      t.pendingBlocked = 0;
      t.navPending = false;
      t.favicon = ctx.library.faviconFor(url);
      t.everCommitted = true;
      if (!t.shown) { t.shown = true; syncAttached(); }
      // Despertar no es visitar: la página ya estaba abierta.
      if (t.waking) t.waking = false;
      else ctx.library.visit(url, wc.getTitle() === url ? '' : wc.getTitle());
      t.zoom = wc.getZoomFactor();
      touch();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame || url === t.url) return;
      t.url = url;
      ctx.library.visit(url, t.title);
      touch();
    });

    wc.on('dom-ready', () => {
      if (!t.painted) { t.painted = true; t.view?.setBackgroundColor('#ffffff'); }
      if (!t.shown) { t.shown = true; syncAttached(); }
    });

    wc.on('page-title-updated', (_e, title) => {
      t.title = title;
      ctx.library.setTitle(t.url, title);
      touch();
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      const icon = (icons || []).find((u) => /^(https?|data):/i.test(u));
      if (!icon) return;
      t.favicon = icon;
      ctx.library.setFavicon(t.url, icon);
      touch();
    });

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 es ERR_ABORTED: una navegación que otra reemplazó, o una descarga.
      if (!isMainFrame) return;
      t.navPending = false;
      if (code === -3) return;
      t.error = { code, desc, url };
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
      t.crashed = true;
      t.loading = false;
      syncAttached();
      touch();
    });

    wc.on('audio-state-changed', (e) => { t.audible = !!e.audible; touch(); });

    wc.on('update-target-url', (_e, url) => {
      if (t.id === activeId) ctx.send('page:hover', url || '');
    });

    wc.on('found-in-page', (_e, r) => {
      if (t.id === activeId) ctx.send('page:find', { matches: r.matches, ordinal: r.activeMatchOrdinal, final: r.finalUpdate });
    });

    wc.on('context-menu', (_e, p) => {
      if (t.id !== activeId) return;
      const b = pageBounds();
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

    wc.on('enter-html-full-screen', () => setFullscreen(true));
    wc.on('leave-html-full-screen', () => setFullscreen(false));

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

    wc.setWindowOpenHandler(({ url, disposition }) => {
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
            webPreferences: { session: ctx.web, sandbox: true, contextIsolation: true },
          },
        };
      }
      const background = disposition === 'background-tab';
      create({ url, active: !background, index: indexOf(t.id) + 1 + countOpenedBy(t.id), openerId: t.id });
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        create({ url, active: true });
        return { action: 'deny' };
      });
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
    const t = blank(url);
    t.openerId = openerId;
    t.pinned = !!pinned;
    const at = clampIndex(Number.isInteger(index) ? index : tabs.length, t.pinned);
    tabs.splice(at, 0, t);

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
    if (t.id === activeId && t.view) t.view.webContents.focus();
    return r;
  }

  function activateTab(id, { focusPage = true } = {}) {
    const t = get(id);
    if (!t) return;
    const changed = activeId !== t.id;
    if (changed) { const prev = active(); if (prev) prev.lastSeen = Date.now(); }
    activeId = t.id;
    if (!t.internal && !t.view) wake(t);              // una dormida se despierta al mirarla
    syncAttached();
    if (changed) ctx.send('page:hover', '');
    if (focusPage && t.view && t.shown) t.view.webContents.focus();
    emit();
  }

  function close(id) {
    const i = indexOf(id);
    if (i < 0) return;
    const t = tabs[i];
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
      activateTab((opener || tabs[Math.min(i, tabs.length - 1)]).id);
    } else emit();
  }

  function reopen() {
    const c = closed.pop();
    if (!c) return;
    create({ url: c.url, index: c.index, active: true, pinned: c.pinned });
  }

  // Como en Chrome, "cerrar las otras" y "las de la derecha" respetan las fijadas.
  function closeOthers(id) {
    for (const t of [...tabs]) if (t.id !== Number(id) && !t.pinned) close(t.id);
  }

  function closeRight(id) {
    const i = indexOf(id);
    for (const t of tabs.slice(i + 1)) if (!t.pinned) close(t.id);
  }

  function move(id, toIndex) {
    const i = indexOf(id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    tabs.splice(clampIndex(Number(toIndex) || 0, t.pinned), 0, t);
    t.openerId = null;
    emit();
  }

  /** Fijar la lleva al final de las fijadas; desfijar, a la primera después de ellas. */
  function pin(id, on) {
    const i = indexOf(id);
    if (i < 0 || tabs[i].pinned === !!on) return;
    const [t] = tabs.splice(i, 1);
    t.pinned = !!on;
    t.openerId = null;
    tabs.splice(pinnedCount(), 0, t);
    if (t.pinned && !t.internal && !t.view) wake(t);   // una fijada está viva
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

  /* ── Dormir y despertar ────────────────────────────────────────────────── */

  /** Si esta pestaña se puede dormir ahora sin que la persona pierda nada. */
  function canSleep(t, now = Date.now()) {
    const min = Number(ctx.settings.sleepTabs) || 0;
    if (!min || !t.view || t.internal || t.pinned || t.id === activeId) return false;
    if (t.sleeping || t.loading || !t.shown || t.error || t.crashed || t.audible) return false;
    const wc = t.view.webContents;
    if (wc.isCurrentlyAudible() || wc.isDevToolsOpened() || wc.isBeingCaptured()) return false;
    return now - t.lastSeen >= min * 60 * 1000;
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

  async function sleep(id) {
    const t = get(id);
    if (!t?.view || t.internal || t.id === activeId || t.sleeping) return false;
    const view = t.view;
    t.sleeping = true;
    await noteState(view.webContents);
    t.sleeping = false;
    // Mientras tanto la pudieron mirar, cerrar o navegar a una página propia.
    if (t.view !== view || t.id === activeId || !get(t.id)) return false;
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
    for (const t of [...tabs]) if (canSleep(t, now) && await sleep(t.id)) n++;
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
    // Si falla, did-fail-load lo cuenta (y restore ya trae su propio catch).
    t.view.webContents.navigationHistory.restore({ entries: h.entries, index: h.index });
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
    layout();
    emit();
  }

  /* ── Congelado (ver el encabezado) ─────────────────────────────────────── */

  async function snapshotPage() {
    if (!attached) return null;
    /* La primera captura de una vista a veces sale vacía (todavía no tiene un
       frame propio que copiar): se reintenta un par de veces antes de rendirse. */
    for (let i = 0; i < 3; i++) {
      try {
        const img = await attached.webContents.capturePage();
        if (!img.isEmpty()) return `data:image/jpeg;base64,${img.toJPEG(88).toString('base64')}`;
      } catch { /* se reintenta */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }

  function hold(on) {
    frozen = !!on;
    layout();
    if (!frozen) {
      const t = active();
      // Si el foco estaba en la página antes del overlay, vuelve a ella.
      if (t?.view && ctx.win?.isFocused()) {
        const chromeFocused = ctx.win.webContents.isFocused();
        if (!chromeFocused) t.view.webContents.focus();
      }
    }
  }

  function focusPage() {
    const t = active();
    if (t?.view && attached === t.view) t.view.webContents.focus();
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
      case 'link-copy': return p.url && clipboard.writeText(p.url);
      case 'link-save': return p.url && ctx.web.downloadURL(p.url);
      case 'image-tab': return p.url && create({ url: p.url, active: false, index: indexOf(activeId) + 1 });
      case 'image-copy': return wc?.copyImageAt(Math.round(p.x), Math.round(p.y));
      case 'image-copy-url': return p.url && clipboard.writeText(p.url);
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
      case 'print': return wc?.print();
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
    list.forEach((x, i) => create({ url: x.url, title: x.title, favicon: x.favicon, pinned: !!x.pinned, active: false, dormant: i !== act && !x.pinned }));
    activateTab(tabs[act].id);
    return true;
  }

  return {
    create, close, reopen, closeOthers, closeRight, move, duplicate, mute, pin, sleep, sweep, navigate,
    activate: activateTab, back, forward, reload, stop, zoom, find, stopFind, devtools,
    contextAction, snapshotPage, hold, focusPage, setInsets, layout, restore, writeSession,
    closeIfDownloadOnly, countBlocked,
    snapshot, emit,
    byWebContents: (id) => byWc.get(id) || null,
    get active() { return active(); },
    get list() { return tabs; },
    get fullscreen() { return fullscreen; },
    setFullscreen,
    reloadAll: () => tabs.forEach((t) => t.view?.webContents.reload()),
    openInternal(page) {
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

module.exports = { createTabs, ZOOMS, BG };
