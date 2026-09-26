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
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, safeStorage, clipboard, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const store = require('./store.cjs');
const V = require('./vault.cjs');
const { fromChrome } = require('./ipc.cjs');

/** Cuánto vive una contraseña copiada en el portapapeles. */
const CLIPBOARD_MS = 45 * 1000;
/** Cuánto se recuerda el usuario del primer paso de un login en dos pasos. */
const STEP_MS = 10 * 60 * 1000;

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
  const changed = () => ctx.send('pass:changed');

  /* ── El preload de las páginas ─────────────────────────────────────────── */
  let preloadId = null;
  function setEnabled(on) {
    if (on && !preloadId) {
      preloadId = ctx.web.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'pass-preload.cjs') });
    } else if (!on && preloadId) {
      ctx.web.unregisterPreloadScript(preloadId);
      preloadId = null;
    }
  }

  /* ── Puerta de las páginas ─────────────────────────────────────────────── */

  /** La dirección del frame que habla, si es una página de verdad. */
  function pageUrl(e) {
    const wc = e.sender;
    if (!enabled() || !ctx.win || wc === ctx.win.webContents || wc.session !== ctx.web) return null;
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

  /* ── "¿Guardar la contraseña?" ─────────────────────────────────────────── */
  let offer = null;           // una por vez: la última gana
  let offerSeq = 0;
  let offerTimer = null;

  ipcMain.on('pass:page-capture', (e, data = {}) => {
    const url = pageUrl(e);
    const password = String(data.password || '').slice(0, 4000);
    if (!url || !password) return;
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
      if (!fromChrome(ctx, e)) return { ok: false, error: 'No autorizado.' };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        console.error(`[pass] ${channel}:`, err.message);
        return { ok: false, error: err?.message || String(err) };
      }
    });
  }

  const withIcon = (it) => ({ ...it, favicon: it.urls[0] ? ctx.library.faviconFor(it.urls[0]) : null });

  chrome('pass:list', () => ({ items: vault.list().map(withIcon), broken: vault.broken }));
  chrome('pass:reveal', (id) => vault.get(String(id))?.password ?? '');

  chrome('pass:save', async (raw = {}) => {
    const it = await vault.save({
      id: raw.id ? String(raw.id) : undefined,
      title: raw.title, username: raw.username, email: raw.email, urls: raw.urls, note: raw.note,
      // Editar sin tocar la contraseña no la manda: undefined es "dejala como está".
      ...(raw.password != null ? { password: String(raw.password) } : {}),
    });
    changed();
    return withIcon(it);
  });

  chrome('pass:remove', async (id) => { const r = await vault.remove(String(id)); changed(); return r; });

  /* Copiar pasa por acá y no por el portapapeles del cromo: así la contraseña
     no viaja a la interfaz, y a los 45 s se borra si seguía siendo ella. */
  let clipTimer = null;
  chrome('pass:copy', (id, field) => {
    const it = vault.get(String(id));
    if (!it) return false;
    const value = field === 'password' ? it.password : field === 'email' ? it.email : it.username;
    if (!value) return false;
    clipboard.writeText(value);
    if (field === 'password') {
      clearTimeout(clipTimer);
      clipTimer = setTimeout(() => { if (clipboard.readText() === value) clipboard.clear(); }, CLIPBOARD_MS);
    }
    return true;
  });

  let lastImport = null;
  chrome('pass:import', async () => {
    const r = await dialog.showOpenDialog(ctx.win, {
      title: 'Importar contraseñas',
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
     propósito de la persona, y es borrar de verdad: la papelera la guardaría. */
  chrome('pass:forget-import', async () => {
    if (!lastImport) return false;
    await fs.unlink(lastImport).catch(() => {});
    lastImport = null;
    return true;
  });

  chrome('pass:answer', async (id, action, patch = {}) => {
    if (!offer || offer.id !== Number(id)) return false;
    const o = offer;
    offer = null;
    if (action === 'never') {
      await ctx.saveSettings({ passNever: [...never().add(o.site)] });
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
    async load() {
      await vault.load();
      if (vault.broken) console.error('[pass] la bóveda no se pudo abrir:', vault.broken);
      setEnabled(enabled());
    },
    setEnabled,
    forgetTab: (wcId) => steps.delete(wcId),
    vault,
  };
}

module.exports = { createPasswords };
