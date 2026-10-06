'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — leer un QR (el de Tessera)
   Una NativeImage se pasa a RGBA y jsQR la lee. Tres fuentes:
     · la pantalla → lo que esté a la vista (ver fromScreen);
     · una imagen  → el diálogo del sistema (PNG o JPEG);
     · el portapapeles → primero como imagen (una captura recién hecha), y si
       no hay, como texto: un enlace otpauth:// pegado.
   Devuelve el texto del QR o null. Qué significa ese texto es cosa de
   src/totp.cjs: acá solo se lee.
   ═══════════════════════════════════════════════════════════════════════════ */

const { nativeImage, clipboard, dialog, desktopCapturer, screen } = require('electron');
const jsQR = require('jsqr');

/** Una captura de pantalla entera es enorme: se achica antes de buscar (el QR sigue sobrando). */
const MAX_SIDE = 2400;

/** NativeImage → el texto del primer QR que encuentre, o null. */
function decodeImage(img) {
  if (!img || img.isEmpty()) return null;
  let { width, height } = img.getSize();
  if (!width || !height) return null;
  if (Math.max(width, height) > MAX_SIDE) {
    const k = MAX_SIDE / Math.max(width, height);
    img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
    ({ width, height } = img.getSize());
  }
  const bgra = img.toBitmap();
  const rgba = new Uint8ClampedArray(width * height * 4);
  // toBitmap entrega BGRA (el orden de Skia); jsQR quiere RGBA.
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = 255;
  }
  return jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' })?.data || null;
}

/* ── La pantalla ─────────────────────────────────────────────────────────────
   Tessera se escondía antes de capturar: si el QR estaba debajo de su
   ventana, taparlo con la propia app era ridículo. Prism no se esconde,
   porque casi siempre el QR está ADENTRO de Prism, en la pestaña donde se
   está activando el doble factor. Se busca en orden:
     1. las páginas a la vista (`pages`, fotos de sus vistas: el panel de la
        llave no las tapa, porque la foto es de la página y no de la ventana);
     2. cada pantalla, a su resolución real (otra app, el teléfono espejado);
     3. cada ventana abierta, aunque esté tapada por otra (Windows guarda lo
        que pinta cada una), salvo las de Prism, que ya se miraron.
   Un QR que no es de doble factor (`want` dice que no) no corta la búsqueda. */
async function fromScreen({ pages = [], skip = new Set(), want = () => true } = {}) {
  const found = (img) => { const d = decodeImage(img); return d && want(d) ? d : null; };
  for (const img of pages) {
    const d = found(await img);
    if (d) return d;
  }
  const size = screen.getAllDisplays().reduce((m, d) => ({
    width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)),
    height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)),
  }), { width: 0, height: 0 });
  for (const types of [['screen'], ['window']]) {
    const sources = await desktopCapturer.getSources({ types, thumbnailSize: size }).catch(() => []);
    for (const s of sources) {
      if (skip.has(s.id)) continue;
      const d = found(s.thumbnail);
      if (d) return d;
    }
  }
  return null;
}

/** undefined si se canceló (no es lo mismo que una imagen sin QR). */
async function fromFile(win) {
  const r = await dialog.showOpenDialog(win, {
    title: 'Imagen con el código QR',
    buttonLabel: 'Leer',
    filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths?.[0]) return undefined;
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('No se pudo abrir esa imagen (solo PNG o JPEG).');
  return decodeImage(img);
}

/* Desde Electron 44 el portapapeles se lee asíncrono (ver passwords.cjs):
   el await sirve igual si devuelve el valor directo. */
async function fromClipboard() {
  const data = decodeImage(await clipboard.readImage());
  if (data) return data;
  const text = String((await clipboard.readText()) || '').trim();
  return /^otpauth(-migration)?:\/\//i.test(text) ? text : null;
}

module.exports = { decodeImage, fromScreen, fromFile, fromClipboard };
