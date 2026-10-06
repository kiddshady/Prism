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

   ── Códigos de doble factor ────────────────────────────────────────────────
   Los de Tessera, en la misma bóveda. El código se calcula acá y el cromo
   recibe solo los dígitos y cuánto les queda; la clave se pide aparte, como
   una contraseña. Entran por un QR (una imagen o el portapapeles, src/qr.cjs),
   a mano, o importados (el respaldo de Tessera, el QR de Google Authenticator,
   el totpUri de los logins de Proton Pass).

   ── Respaldo ───────────────────────────────────────────────────────────────
   Como la bóveda solo se abre con esta cuenta de Windows, el respaldo es otro
   archivo con su propia clave (src/backup.cjs): se escribe solo después de
   cada cambio, en la carpeta que la persona eligió. Se restaura por
   "Importar", que suma lo que falta y no pisa nada. La frase del respaldo
   pasa por acá una vez, al prenderlo o al restaurar, y no se guarda.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, safeStorage, clipboard, dialog, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const store = require('./store.cjs');
const V = require('./vault.cjs');
const T = require('./totp.cjs');
const QR = require('./qr.cjs');
const B = require('./backup.cjs');
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
  const seal = (s) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El cifrado de Windows no está disponible: no se guarda nada.');
    return safeStorage.encryptString(s);
  };
  const unseal = (b) => safeStorage.decryptString(b);
  let backup = null;
  const vault = V.createVault({
    doc: store.doc('vault', null),
    seal,
    unseal,
    onPersist: () => backup?.schedule(),
  });
  backup = B.createBackup({
    doc: store.doc('backup', null),
    // Una bóveda que no se pudo abrir está vacía en memoria: eso no se respalda.
    items: () => { if (vault.broken) throw new Error('la bóveda no se pudo abrir'); return vault.dump(); },
    seal,
    unseal,
    fs,
    onChange: () => windows.broadcast('pass:backup', backup.state()),
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
  const SECRET = { login: ['password'], card: ['number', 'cvv', 'pin'], totp: ['secret'] };
  const kindOf = V.kindOf;

  chrome('pass:list', async () => {
    // Si al arrancar estaba tomada, abrir Contraseñas es el momento de volver a probar.
    await vault.retryRead();
    return { items: vault.list().map(withIcon), broken: vault.broken, aside: vault.aside && path.basename(vault.aside) };
  });
  chrome('pass:show-aside', () => { if (vault.aside) shell.showItemInFolder(vault.aside); return !!vault.aside; });
  chrome('pass:reveal', (id, field = 'password') => {
    const it = vault.get(String(id));
    return it && SECRET[kindOf(it)].includes(field) ? it[field] ?? '' : '';
  });

  /* El código vigente: los dígitos y cuánto les queda, nunca la clave. */
  chrome('pass:code', (id) => {
    try { return vault.code(String(id)); } catch (err) { return { error: err.message }; }
  });

  /** Un código nuevo; si esa clave ya estaba, devuelve el que estaba. */
  async function addCode(acc) {
    const prev = vault.codeWith(acc.secret);
    if (prev) return { item: withIcon(V.publicItem(prev)), existed: true };
    const item = await vault.save({ kind: 'totp', ...acc, title: acc.issuer });
    changed();
    return { item: withIcon(item), existed: false };
  }

  /* Un QR de una imagen o del portapapeles. El de un sitio se guarda en el
     acto (se ve el código, y se edita si hace falta); el de "Transferir
     cuentas" de Google Authenticator trae varios y entra como una importación. */
  /** La foto de una página (la primera a veces sale vacía: se reintenta, como en el congelado). */
  async function pageShot(wc) {
    for (let i = 0; i < 3; i++) {
      const img = await wc.capturePage().catch(() => null);
      if (img && !img.isEmpty()) return img;
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }

  /* Escanear la pantalla: primero las pestañas a la vista (la activa
     primero), después las pantallas y las ventanas (src/qr.cjs). */
  function fromScreen() {
    const shown = (ctx.tabs?.list || []).filter((t) => t.view && t.shown && !t.crashed && !t.view.webContents.isDestroyed());
    const active = ctx.tabs?.active;
    shown.sort((a, b) => (b === active) - (a === active));
    const skip = new Set();
    try { if (ctx.win && !ctx.win.isDestroyed()) skip.add(ctx.win.getMediaSourceId()); } catch { /* sin ventana */ }
    return QR.fromScreen({
      pages: shown.map((t) => pageShot(t.view.webContents)),
      skip,
      want: (text) => T.isOtpauth(text) || T.isMigration(text),
    });
  }

  const NOT_FOUND = {
    screen: 'No se encontró un código QR de doble factor a la vista: ni en la pestaña, ni en la pantalla, ni en las otras ventanas. Dejalo visible (que no esté minimizado) y probá de nuevo.',
    file: 'No se encontró un código QR en esa imagen.',
    clipboard: 'El portapapeles no tiene una imagen con un código QR (ni un enlace otpauth://). Copiá una captura del QR y probá de nuevo.',
  };

  chrome('pass:qr', async (source) => {
    const text = source === 'screen' ? await fromScreen() : source === 'file' ? await QR.fromFile(ctx.win) : await QR.fromClipboard();
    if (text === undefined) return null;
    if (!text) throw new Error(NOT_FOUND[source] || NOT_FOUND.clipboard);
    if (!T.isOtpauth(text) && !T.isMigration(text)) throw new Error('Ese QR no es de doble factor: no trae un enlace otpauth://.');
    const r = T.parseAny(text);
    if (T.isMigration(text)) {
      const res = await vault.importItems(V.codeItems(r.accounts));
      changed();
      return { imported: { ...res, skipped: r.skipped.length, file: 'Google Authenticator', batch: r.batch } };
    }
    return addCode(r.accounts[0]);
  });

  /* Guardar un código. La clave puede venir como el enlace otpauth:// entero
     (el que muchos sitios muestran debajo del QR): trae todo lo demás, y
     completa lo que quedó vacío. */
  async function saveCode(raw) {
    const id = raw.id ? String(raw.id) : undefined;
    let clave = raw.secret != null ? String(raw.secret).trim() : undefined;
    let fields = { title: raw.title, account: raw.account, digits: raw.digits, period: raw.period, algorithm: raw.algorithm, note: raw.note };
    if (clave && T.isOtpauth(clave)) {
      const acc = T.parseOtpauth(clave);
      clave = acc.secret;
      fields = {
        ...fields,
        title: String(raw.title || '').trim() || acc.issuer,
        account: String(raw.account || '').trim() || acc.account,
        digits: acc.digits, period: acc.period, algorithm: acc.algorithm,
      };
    }
    if (clave && !T.isValidSecret(clave)) throw new Error('La clave va en base32: letras de la A a la Z y dígitos del 2 al 7 (o pegá el enlace otpauth:// entero).');
    if (!id && !clave) throw new Error('Falta la clave: la que muestra el sitio al lado del QR, o el enlace otpauth://.');
    if (clave && vault.codeWith(clave) && vault.codeWith(clave).id !== id) throw new Error('Ese código ya está guardado.');
    // Lo que no vino queda como estaba (un undefined pisaría, por ejemplo, los 8 dígitos con el 6 de fábrica).
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const it = await vault.save({ id, kind: 'totp', ...given, ...(clave ? { secret: clave } : {}) });
    changed();
    return withIcon(it);
  }

  chrome('pass:save', async (raw = {}) => {
    const prev = raw.id ? vault.get(String(raw.id)) : null;
    const kind = prev ? kindOf(prev) : kindOf(raw);
    if (kind === 'totp') return saveCode(raw);
    const card = kind === 'card';
    // Editar sin tocar un secreto no lo manda: undefined es "dejalo como está".
    const secrets = Object.fromEntries(SECRET[kind].filter((k) => raw[k] != null).map((k) => [k, String(raw[k])]));
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
  chrome('pass:undo-remove', async () => {
    const it = await vault.undoRemove();
    if (it) changed();
    return it && withIcon(it);
  });

  /* Copiar pasa por acá y no por el portapapeles del cromo: así la contraseña
     no viaja a la interfaz, y a los 45 s se borra si seguía siendo ella. Lo
     mismo con el número, el código y el PIN de una tarjeta. */
  const COPY = { login: ['username', 'email', 'password'], card: ['holder', 'number', 'expiry', 'cvv', 'pin'], totp: ['account', 'secret', 'code'] };
  let clipTimer = null;
  chrome('pass:copy', async (id, field) => {
    const it = vault.get(String(id));
    if (!it || !COPY[kindOf(it)].includes(field)) return false;
    const value = field === 'expiry' ? V.shortExpiry(it.expiry) : field === 'code' ? vault.code(it.id)?.code : it[field];
    if (!value) return false;
    await clipboard.writeText(value);
    // Sin avisar el cambio: el panel abierto se repintaría y se llevaría el tilde de copiado.
    if (field === 'code') vault.markUsed(it.id);
    // El código también se va: a los 45 s ya no sirve, y en el portapapeles sobra.
    if (SECRET[kindOf(it)].includes(field) || field === 'code') {
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
  /** El respaldo elegido en "Importar" que está esperando su clave. */
  let pendingRestore = null;
  /* Restaurar suma lo que falta, como importar: lo que ya está igual se
     saltea y nada se pisa. No es una exportación en texto plano: no se
     ofrece borrarlo (lastImport no se toca). */
  async function restore(opened, file) {
    const res = await vault.importItems(opened.items);
    changed();
    return { ...res, skipped: 0, file: path.basename(file), backup: true, when: opened.when };
  }
  chrome('pass:import', async () => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Importar contraseñas, tarjetas y códigos',
      buttonLabel: 'Importar',
      filters: [{ name: 'Proton Pass, Tessera o un respaldo de Prism', extensions: ['zip', 'csv', 'json', 'txt', B.EXT.slice(1)] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const buf = await fs.readFile(file);
    if (B.isBackup(path.basename(file), buf)) {
      // El de esta misma configuración se abre con la clave de acá; cualquier otro pide la suya.
      const opened = await backup.open(buf.toString('utf8'));
      if (opened) return restore(opened, file);
      pendingRestore = file;
      return { needsKey: true, file: path.basename(file) };
    }
    const parsed = V.parseExport(path.basename(file), buf);
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

  /* La clave del respaldo que se eligió recién. Si no es, el archivo sigue
     esperando: se puede probar de nuevo sin volver a elegirlo. */
  chrome('pass:restore', async (passphrase) => {
    if (!pendingRestore) return null;
    const file = pendingRestore;
    const opened = await backup.open(await fs.readFile(file, 'utf8'), String(passphrase ?? ''));
    pendingRestore = null;
    return restore(opened, file);
  });

  chrome('pass:backup-state', () => backup.state());
  chrome('pass:backup-folder', async (current) => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Carpeta del respaldo',
      buttonLabel: 'Elegir',
      defaultPath: String(current || '').slice(0, 1000) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  chrome('pass:backup-setup', (dir, passphrase) => backup.setup(String(dir || '').slice(0, 1000), String(passphrase ?? '').slice(0, 1000)));
  chrome('pass:backup-move', (dir) => backup.move(String(dir || '').slice(0, 1000)));
  chrome('pass:backup-now', async () => { await backup.run(); return backup.state(); });
  chrome('pass:backup-off', () => backup.off());
  chrome('pass:backup-open', () => { const { dir } = backup.state(); if (dir) shell.openPath(dir); return !!dir; });

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
      await backup.load();
      backup.catchUp();
    },
    setEnabled,
    addSession,
    forgetSession: (session) => sessions.delete(session),
    forgetTab: (wcId) => steps.delete(wcId),
    vault,
    backup,
  };
}

module.exports = { createPasswords };
