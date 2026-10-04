'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — contraseñas (lo que las conecta con Electron)
   La bóveda (src/vault.cjs) cifrada con DPAPI, las dos puertas por las que se
   le habla, y el "¿guardar la contraseña?" después de un login.

   ── Cifrado ────────────────────────────────────────────────────────────────
   safeStorage en Windows es DPAPI: la clave es tu cuenta de Windows. No hay
   contraseña maestra, pero el archivo copiado a otra compu (o leído por otra
   cuenta) no se abre. Si safeStorage no está, no se guarda nada: nunca se
   cae a texto plano en silencio.

   ── Dos puertas, con reglas distintas ──────────────────────────────────────
   · El cromo (la ventana de Prism) ve todo: lista, edita, revela, importa.
     Cada canal verifica que quien habla es la ventana y no una página.
   · Las páginas, por su preload (src/pass-preload.cjs), piden solo lo de SU
     sitio. El sitio no lo dicen ellas: sale del frame que manda el mensaje
     (senderFrame), que es lo que Chromium sabe que está cargado ahí. Una
     página no puede pedir la contraseña de otro sitio aunque mienta.

   ── Tarjetas ───────────────────────────────────────────────────────────────
   Una tarjeta no es de ningún sitio, así que no la cuida el sitio: la
   cuidan tres cosas.
   · Solo en páginas seguras: el frame que pide, y la página que lo contiene,
     son https (o la compu misma, para probar).
   · Solo con un gesto de verdad: completar exige un clic o un Enter de la
     persona en esa pestaña, visto por el proceso principal (input-event). Un
     renderer comprometido puede mandar cualquier IPC, pero no puede inventar
     un clic del lado de Chromium.
   · Solo a quien corresponde: el número viaja al frame donde se pidió, a los
     del mismo sitio que él o que la página, y a los de los procesadores de
     pago conocidos (el número de Stripe o Mercado Pago vive en su iframe).
     Un iframe de publicidad en la misma página no recibe nada.
   Los checkouts ponen el campo en un iframe chiquito: la lista no entra ahí.
   Se dibuja en el documento principal, y el iframe le pasa por acá las
   flechas, el Enter y el "me fui" (pay:key, pay:blur).
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, safeStorage, clipboard, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const store = require('./store.cjs');
const V = require('./vault.cjs');
const windows = require('./windows.cjs');

/** Cuánto vive una contraseña copiada en el portapapeles. */
const CLIPBOARD_MS = 45 * 1000;
/** Cuánto se recuerda el usuario del primer paso de un login en dos pasos. */
const STEP_MS = 10 * 60 * 1000;
/** Cuánto vale el campo de tarjeta enfocado para elegir de la lista. */
const PAY_MS = 2 * 60 * 1000;
/** Cuánto antes de completar tiene que haber un clic o un Enter de verdad. */
const GESTURE_MS = 1500;

/** Procesadores de pago que ponen los campos de la tarjeta en su propio iframe. */
const PAY_SITES = new Set([
  'stripe.com', 'mercadopago.com', 'mercadopago.com.ar', 'mercadolibre.com', 'mercadolibre.com.ar', 'mlstatic.com',
  'braintreegateway.com', 'braintree-api.com', 'paypal.com', 'adyen.com', 'checkout.com', 'squareup.com',
  'squarecdn.com', 'recurly.com', 'chargebee.com', 'paddle.com', 'dlocal.com', 'decidir.com', 'mobbex.com',
  'payway.com.ar', 'getnet.com.ar', 'worldpay.com', 'cybersource.com', 'authorize.net', 'spreedly.com',
]);

/** Una dirección segura para completar una tarjeta: https, o la compu misma. */
function securePay(url) {
  const host = V.hostOf(url);
  if (!host) return false;
  if (/^https:/i.test(url)) return true;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

function createPasswords(ctx) {
  const vault = V.createVault({
    doc: store.doc('vault', null),
    seal: (s) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('El cifrado de Windows no está disponible: no se guarda nada.');
      return safeStorage.encryptString(s);
    },
    unseal: (b) => safeStorage.decryptString(b),
  });

  const enabled = () => ctx.settings.passwords !== false;
  const never = () => new Set(ctx.settings.passNever || []);
  const changed = () => windows.broadcast('pass:changed');

  /* ── El preload de las páginas ─────────────────────────────────────────────
     En cada sesión de páginas: la normal y, si está abierta, la de incógnito
     (que completa pero nunca ofrece guardar: ver pass:page-capture). */
  const sessions = new Map();   // session → id del preload (o null, apagado)
  let on = false;
  const PRELOAD = path.join(__dirname, 'pass-preload.cjs');
  function sync(session) {
    const id = sessions.get(session);
    if (on && !id) sessions.set(session, session.registerPreloadScript({ type: 'frame', filePath: PRELOAD }));
    else if (!on && id) { session.unregisterPreloadScript(id); sessions.set(session, null); }
  }
  function setEnabled(value) {
    on = !!value;
    for (const s of sessions.keys()) sync(s);
  }
  function addSession(session) {
    if (!sessions.has(session)) sessions.set(session, null);
    sync(session);
  }
  addSession(ctx.web);

  /* ── Puerta de las páginas ─────────────────────────────────────────────── */

  /** La dirección del frame que habla, si es una página de verdad. */
  function pageUrl(e) {
    const wc = e.sender;
    if (!enabled() || windows.ofSender(e) || !windows.ofSession(wc.session)) return null;
    const frame = e.senderFrame;
    if (!frame || frame.parent) return null;          // solo el documento principal
    return V.hostOf(frame.url) ? frame.url : null;
  }

  ipcMain.handle('pass:page-query', (e) => {
    const url = pageUrl(e);
    if (!url) return [];
    return vault.findFor(url).map((it) => ({ id: it.id, title: it.title, login: V.loginOf(it) }));
  });

  ipcMain.handle('pass:page-fill', (e, id) => {
    const url = pageUrl(e);
    if (!url) return null;
    const it = vault.findFor(url).find((x) => x.id === String(id));
    if (!it) return null;
    vault.markUsed(it.id).then(changed);
    return { login: V.loginOf(it), password: it.password };
  });

  /* El primer paso de un login en dos pasos (el correo solo, como Google):
     se recuerda por pestaña para juntarlo con la contraseña del segundo. */
  const steps = new Map();    // wcId → { site, login, at }
  ipcMain.on('pass:page-step', (e, login) => {
    const url = pageUrl(e);
    const l = String(login || '').trim().slice(0, 300);
    if (!url || !l) return;
    steps.set(e.sender.id, { site: V.siteOf(V.hostOf(url)), login: l, at: Date.now() });
  });

  /* ── Tarjetas en las páginas ───────────────────────────────────────────── */

  /** Cuándo fue el último clic o Enter de la persona, por pestaña. */
  const gestures = new Map();   // wcId → ms
  /** El campo de tarjeta enfocado, por pestaña: de qué frame y cuándo. */
  const pays = new Map();       // wcId → { frame, url, at }
  const watched = new WeakSet();
  function watchInput(wc) {
    if (watched.has(wc)) return;
    watched.add(wc);
    const id = wc.id;
    const mark = () => gestures.set(id, Date.now());
    wc.on('input-event', (_e, ev) => { if (ev.type === 'mouseUp' || ev.type === 'gestureTap') mark(); });
    wc.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Enter') mark(); });
    wc.once('destroyed', () => { gestures.delete(id); pays.delete(id); });
  }

  /** El frame que habla, si es de una página de verdad y segura (también un iframe). */
  function payFrame(e) {
    const wc = e.sender;
    if (!enabled() || windows.ofSender(e) || !windows.ofSession(wc.session)) return null;
    const frame = e.senderFrame;
    if (!frame || !securePay(frame.url) || !securePay(wc.mainFrame.url)) return null;
    return frame;
  }
  // Un frame que ya se fue tira al tocarlo: se lo toma como "no es el mismo".
  const sameFrame = (a, b) => {
    try { return !!a && !!b && a.processId === b.processId && a.routingId === b.routingId; } catch { return false; }
  };
  const isPayer = (url) => {
    const s = V.siteOf(V.hostOf(url));
    return [...PAY_SITES].some((p) => s === p || s.endsWith(`.${p}`));
  };
  /** El campo enfocado de esta pestaña, si sigue vigente. */
  function payOf(wc) {
    const p = pays.get(wc.id);
    if (!p || Date.now() - p.at > PAY_MS) return null;
    try { if (p.frame.detached) return null; } catch { return null; }
    return p;
  }
  const cardList = () => vault.cards().map((it) => ({
    id: it.id, title: it.title, brand: V.brandName(V.brandOf(it.number)), last4: it.number.slice(-4), expiry: V.shortExpiry(it.expiry),
  }));

  /* Se enfocó un campo de tarjeta (en la página o en un iframe). */
  ipcMain.handle('pay:query', (e) => {
    const frame = payFrame(e);
    if (!frame) return [];
    const list = cardList();
    if (!list.length) return [];
    watchInput(e.sender);
    pays.set(e.sender.id, { frame, url: frame.url, at: Date.now() });
    return list;
  });

  /* El documento principal pide la lista para colgarla sobre el iframe que la pidió. */
  ipcMain.handle('pay:menu', (e) => {
    const frame = payFrame(e);
    if (!frame || frame.parent || !payOf(e.sender)) return [];
    return cardList();
  });

  /* Las flechas, el Enter y la salida del iframe, al documento principal. */
  ipcMain.on('pay:key', (e, key) => {
    const p = payOf(e.sender);
    if (!p || !sameFrame(p.frame, e.senderFrame) || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(key)) return;
    e.sender.mainFrame.send('pay:key', key);
  });
  ipcMain.on('pay:blur', (e) => {
    const p = payOf(e.sender);
    if (p && sameFrame(p.frame, e.senderFrame)) e.sender.mainFrame.send('pay:blur');
  });
  /* Y al revés: el iframe sabe si la lista está abierta (y si hay una fila
     elegida), así sabe si un Enter es para la lista o para su formulario. */
  ipcMain.on('pay:open', (e, state) => {
    const p = payOf(e.sender);
    if (!p || !e.senderFrame || e.senderFrame.parent || sameFrame(p.frame, e.senderFrame)) return;
    try { p.frame.send('pay:open', Number(state) || 0); } catch { /* el iframe ya no está */ }
  });

  ipcMain.handle('pay:fill', (e, id) => {
    const wc = e.sender;
    const frame = payFrame(e);
    const p = payOf(wc);
    // Elige la lista: la del frame enfocado, o la del documento principal sobre el iframe.
    if (!frame || !p || !(sameFrame(frame, p.frame) || !frame.parent)) return false;
    if (Date.now() - (gestures.get(wc.id) || 0) > GESTURE_MS) return false;
    const it = vault.get(String(id));
    if (!it || !V.isCard(it)) return false;
    const sites = new Set([V.siteOf(V.hostOf(p.url)), V.siteOf(V.hostOf(wc.mainFrame.url))]);
    const card = {
      holder: it.holder, number: it.number, cvv: it.cvv, brand: V.brandName(V.brandOf(it.number)),
      month: it.expiry ? Number(it.expiry.slice(5, 7)) : 0, year: it.expiry ? Number(it.expiry.slice(0, 4)) : 0,
    };
    let sent = 0;
    for (const f of wc.mainFrame.framesInSubtree) {
      if (!securePay(f.url)) continue;
      if (!sameFrame(f, p.frame) && !sites.has(V.siteOf(V.hostOf(f.url))) && !isPayer(f.url)) continue;
      f.send('pay:put', card, sameFrame(f, p.frame));
      sent++;
    }
    gestures.delete(wc.id);
    vault.markUsed(it.id).then(changed);
    return sent > 0;
  });

  /* ── "¿Guardar la contraseña?" ─────────────────────────────────────────── */
  let offer = null;           // una por vez: la última gana
  let offerSeq = 0;
  let offerTimer = null;

  ipcMain.on('pass:page-capture', (e, data = {}) => {
    const url = pageUrl(e);
    const password = String(data.password || '').slice(0, 4000);
    if (!url || !password) return;
    // En incógnito se completa, pero nunca se ofrece guardar: no deja rastro.
    if (windows.ofSession(e.sender.session)?.private) return;
    const host = V.hostOf(url);
    const site = V.siteOf(host);
    if (never().has(site)) return;

    let login = String(data.login || '').trim().slice(0, 300);
    const step = steps.get(e.sender.id);
    if (!login && step && step.site === site && Date.now() - step.at < STEP_MS) login = step.login;

    const same = vault.findFor(url).filter((it) => V.siteOf(V.hostOf(it.urls[0])) === site);
    const mine = same.filter((it) => V.loginOf(it).toLowerCase() === login.toLowerCase());
    if (mine.some((it) => it.password === password)) return;      // ya está, igual
    const target = mine[0] || (!login && same.length === 1 ? same[0] : null);

    offer = { id: ++offerSeq, kind: target ? 'update' : 'save', itemId: target?.id || null, url, host: V.prettyHost(host), site, login, password };
    /* Se espera un poco: casi siempre el envío navega, y la pregunta cae
       mejor sobre la página a la que se llegó que sobre la que se va. */
    clearTimeout(offerTimer);
    const o = offer;
    offerTimer = setTimeout(() => {
      if (offer !== o) return;
      ctx.send('pass:offer', { id: o.id, kind: o.kind, host: o.host, login: o.login, title: o.itemId ? vault.get(o.itemId)?.title : '' });
    }, 900);
  });

  /* ── Puerta del cromo ──────────────────────────────────────────────────── */

  function chrome(channel, fn) {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!windows.ofSender(e)) return { ok: false, error: 'No autorizado.' };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        console.error(`[pass] ${channel}:`, err.message);
        return { ok: false, error: err?.message || String(err) };
      }
    });
  }

  const withIcon = (it) => ({ ...it, favicon: it.urls?.[0] ? ctx.library.faviconFor(it.urls[0]) : null });

  /** Lo secreto de cada clase: lo único que se pide aparte, de a un campo. */
  const SECRET = { login: ['password'], card: ['number', 'cvv', 'pin'] };
  const kindOf = (it) => (V.isCard(it) ? 'card' : 'login');

  chrome('pass:list', () => ({ items: vault.list().map(withIcon), broken: vault.broken }));
  chrome('pass:reveal', (id, field = 'password') => {
    const it = vault.get(String(id));
    return it && SECRET[kindOf(it)].includes(field) ? it[field] ?? '' : '';
  });

  chrome('pass:save', async (raw = {}) => {
    const prev = raw.id ? vault.get(String(raw.id)) : null;
    const card = prev ? V.isCard(prev) : raw.kind === 'card';
    // Editar sin tocar un secreto no lo manda: undefined es "dejalo como está".
    const secrets = Object.fromEntries(SECRET[card ? 'card' : 'login'].filter((k) => raw[k] != null).map((k) => [k, String(raw[k])]));
    if (card) {
      if (secrets.number && !/^\d{12,19}$/.test(secrets.number.replace(/[\s-]/g, ''))) throw new Error('El número de la tarjeta tiene que tener entre 12 y 19 dígitos.');
      if (String(raw.expiry || '').trim() && !V.parseExpiry(raw.expiry)) throw new Error('El vencimiento va como MM/AA (por ejemplo 08/29).');
      if (secrets.cvv && !/^\d{3,4}$/.test(secrets.cvv.trim())) throw new Error('El código de seguridad tiene 3 o 4 dígitos.');
    }
    const it = await vault.save(card
      ? { id: raw.id ? String(raw.id) : undefined, kind: 'card', title: raw.title, holder: raw.holder, expiry: raw.expiry, note: raw.note, ...secrets }
      : { id: raw.id ? String(raw.id) : undefined, title: raw.title, username: raw.username, email: raw.email, urls: raw.urls, note: raw.note, ...secrets });
    changed();
    return withIcon(it);
  });

  chrome('pass:remove', async (id) => { const r = await vault.remove(String(id)); changed(); return r; });

  /* Copiar pasa por acá y no por el portapapeles del cromo: así la contraseña
     no viaja a la interfaz, y a los 45 s se borra si seguía siendo ella. Lo
     mismo con el número, el código y el PIN de una tarjeta. */
  const COPY = { login: ['username', 'email', 'password'], card: ['holder', 'number', 'expiry', 'cvv', 'pin'] };
  let clipTimer = null;
  chrome('pass:copy', async (id, field) => {
    const it = vault.get(String(id));
    if (!it || !COPY[kindOf(it)].includes(field)) return false;
    const value = field === 'expiry' ? V.shortExpiry(it.expiry) : it[field];
    if (!value) return false;
    await clipboard.writeText(value);
    if (SECRET[kindOf(it)].includes(field)) {
      clearTimeout(clipTimer);
      /* Desde Electron 44 leer el portapapeles es asíncrono: comparado sin
         esperar, era una promesa contra el texto, nunca igual, y lo copiado
         no se borraba nunca. */
      clipTimer = setTimeout(async () => {
        try { if ((await clipboard.readText()) === value) clipboard.clear(); } catch { /* sin portapapeles */ }
      }, CLIPBOARD_MS);
    }
    return true;
  });

  let lastImport = null;
  chrome('pass:import', async () => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Importar contraseñas y tarjetas',
      buttonLabel: 'Importar',
      filters: [{ name: 'Exportación de Proton Pass', extensions: ['zip', 'csv', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const parsed = V.parseExport(path.basename(file), await fs.readFile(file));
    const res = await vault.importItems(parsed.items);
    lastImport = file;
    changed();
    return { ...res, skipped: parsed.skipped, file: path.basename(file) };
  });

  /* La exportación tiene todo en texto plano. Borrarla es un botón a
     propósito de la persona, y es borrar de verdad: la papelera la guardaría.
     Si no se pudo (abierta en Excel, tomada por OneDrive), el error sube: el
     aviso no puede decir que se borró un archivo que sigue ahí. */
  chrome('pass:forget-import', async () => {
    if (!lastImport) return false;
    try {
      await fs.unlink(lastImport);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('No se pudo borrar: ¿está abierto en otro programa?');
    }
    lastImport = null;
    return true;
  });

  chrome('pass:answer', async (id, action, patch = {}) => {
    if (!offer || offer.id !== Number(id)) return false;
    const o = offer;
    offer = null;
    if (action === 'never') {
      await ctx.updateSettings((s) => ({ passNever: [...new Set([...(s.passNever || []), o.site])] }));
      return true;
    }
    if (action !== 'save') return false;
    if (o.itemId && vault.get(o.itemId)) {
      await vault.save({ id: o.itemId, password: o.password });
    } else {
      const login = String(patch.login ?? o.login).trim();
      await vault.save({
        title: o.host,
        ...(login.includes('@') ? { email: login } : { username: login }),
        password: o.password,
        urls: [new URL(o.url).origin],
        note: '',
      });
    }
    changed();
    return true;
  });

  return {
    /** Un click en la lista de Prism (fill.cjs) es un gesto de la persona en esa pestaña. */
    markGesture(wc) {
      watchInput(wc);
      gestures.set(wc.id, Date.now());
    },
    async load() {
      await vault.load();
      if (vault.broken) console.error('[pass] la bóveda no se pudo abrir:', vault.broken);
      setEnabled(enabled());
    },
    setEnabled,
    addSession,
    forgetSession: (session) => sessions.delete(session),
    forgetTab: (wcId) => steps.delete(wcId),
    vault,
  };
}

module.exports = { createPasswords };
