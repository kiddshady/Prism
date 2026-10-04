'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — capturas de la página
   Dos: lo visible (lo que ya pinta la vista, `capturePage`) y la página
   entera, que pide el protocolo de DevTools: `Page.captureScreenshot` con
   `captureBeyondViewport` le hace pintar a Chromium lo que queda fuera de la
   pantalla, sin mover el scroll de la persona.

   ── Por tramos ─────────────────────────────────────────────────────────────
   Una textura de GPU no pasa de 16384 px de lado. Una página más alta que eso
   sale cortada o con el final repetido, así que se pide en tramos de TILE px
   de CSS (con pantalla al 250 % siguen entrando) y se cosen acá, fila por
   fila, sobre el bitmap crudo.

   ── La caja que scrollea ───────────────────────────────────────────────────
   Hay páginas que no scrollean el documento sino una caja adentro: Moodle 4
   con sesión iniciada (#page), las apps de una sola pantalla. Para Chromium
   miden lo mismo que la ventana, y la entera salía igual que la visible.
   Si el documento no scrollea pero una caja grande sí, se la estira a ella y
   a sus padres (alto automático, sin recorte; lo fijo pasa a absoluto para
   que cuente en el largo) hasta que la página mida lo que mide su contenido.
   Se captura así y se devuelve todo como estaba, scroll incluido. Corre en el
   mundo aislado de Prism: los scripts de la página no lo ven.

   Lo que no alcanza: las listas virtuales (chats, feeds que dibujan solo lo
   que se ve) no tienen el resto dibujado, así que no hay qué capturar.

   Se guardan en Imágenes\Prism y se copian al portapapeles para pegarlas
   directo. Avisa la tarjeta de la esquina (card.cjs): mientras recorre la
   página, y después con la miniatura, Abrir y Mostrar en la carpeta. La lógica de nombres y tramos es pura, con tests; Electron se pide
   recién al crear el módulo.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fsp = require('fs/promises');

/** Alto de cada tramo, en px de CSS. */
const TILE = 6000;
/** Más alta que esto no se captura: 60 000 px de CSS ya son cientos de MB en memoria. */
const MAX_HEIGHT = 60000;
/** El portapapeles de Windows copia el bitmap entero: más de esto se guarda y no se copia. */
const MAX_CLIPBOARD_PX = 60e6;

const pad = (n) => String(n).padStart(2, '0');

/** "2026-09-27 14.03.22": ordena bien en el explorador y no lleva ':' (Windows no lo acepta). */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/** El nombre del archivo: el sitio y la hora. Lo que Windows no acepta en un nombre se va. */
function fileName(url, when = new Date(), full = false) {
  let host = '';
  try { host = new URL(String(url)).hostname.replace(/^www\./, ''); } catch { /* sin host */ }
  host = host.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 60);
  return `${host || 'Prism'} ${stamp(when)}${full ? ' (entera)' : ''}.png`;
}

/** Los tramos [y, alto] que cubren `height` px de CSS. */
function tiles(height, tile = TILE) {
  const out = [];
  for (let y = 0; y < height; y += tile) out.push([y, Math.min(tile, height - y)]);
  return out;
}

/* ── Adentro de la página (mundo aislado) ──────────────────────────────────── */

/** Estira la caja que scrollea, si la página es de esas. → true si tocó algo. */
function expandScroller() {
  const vw = innerWidth;
  const vh = innerHeight;
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollHeight > vh + 4) return false;   // el documento scrollea: nada que hacer
  let box = null;
  let boxArea = 0;
  for (const e of document.querySelectorAll('body *')) {
    if (e.scrollHeight <= e.clientHeight + 40) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) continue;
    const r = e.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (area > boxArea) { box = e; boxArea = area; }
  }
  // Una lista chica al costado (un índice, un cajón) no es "la página".
  if (!box || boxArea < vw * vh * 0.3) return false;

  const touched = [];
  const loosen = (el) => {
    touched.push([el, el.getAttribute('style')]);
    const set = (k, v) => el.style.setProperty(k, v, 'important');
    set('height', 'auto');
    set('max-height', 'none');
    set('overflow', 'visible');
    // Lo fijo no suma al largo del documento; y con arriba y abajo puestos, el alto sale de ahí.
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed') set('position', 'absolute');
    if (pos === 'fixed' || pos === 'absolute') set('bottom', 'auto');
  };
  const top = box.scrollTop;
  for (let el = box; el; el = el.parentElement) loosen(el);
  window.__prismUnexpand = () => {
    for (const [el, style] of touched.reverse()) {
      /* Chromium escribe el atributo de lo que se tocó por el.style recién
         cuando alguien lo lee. Sacado sin leerlo, la escritura pendiente llega
         después y deja style="" donde no había nada: se lee antes. */
      el.getAttribute('style');
      if (style == null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    }
    box.scrollTop = top;
    delete window.__prismUnexpand;
  };
  return true;
}

function unexpandScroller() {
  if (window.__prismUnexpand) window.__prismUnexpand();
}

/** Dos cuadros: lo estirado ya se maquetó cuando se mida. */
const settle = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';

function createCapture(ctx) {
  const { app, clipboard, ClipboardItem, nativeImage, shell } = require('electron');
  const { PRISM_WORLD } = require('./tabs.cjs');
  let busy = false;

  /** Imágenes\Prism. En modo verificación, adentro de los datos descartables. */
  const dir = () => process.env.PRISM_CAPTURES
    || (process.env.PRISM_SHOTS ? path.join(require('./store.cjs').ROOT, 'capturas') : path.join(app.getPath('pictures'), 'Prism'));

  /** Cose los tramos uno debajo del otro. Si alguno salió un píxel más angosto
      (redondeo de la escala), se copia lo que tiene y el resto queda negro. */
  function stitch(parts) {
    if (parts.length === 1) return parts[0];
    const sizes = parts.map((p) => p.getSize());
    const width = Math.max(...sizes.map((s) => s.width));
    const height = sizes.reduce((h, s) => h + s.height, 0);
    const out = Buffer.alloc(width * height * 4);
    let row = 0;
    parts.forEach((p, i) => {
      const { width: w, height: h } = sizes[i];
      const src = p.toBitmap();
      for (let y = 0; y < h; y++) src.copy(out, (row + y) * width * 4, y * w * 4, (y + 1) * w * 4);
      row += h;
    });
    return nativeImage.createFromBitmap(out, { width, height });
  }

  const inPage = (wc, code) => wc.executeJavaScriptInIsolatedWorld(PRISM_WORLD, [{ code }]);

  async function fullPage(wc) {
    const dbg = wc.debugger;
    const mine = !dbg.isAttached();
    try {
      if (mine) dbg.attach('1.3');
    } catch {
      throw new Error('No se pudo capturar: cerrá las herramientas de desarrollo de la página y probá de nuevo.');
    }
    const expanded = await inPage(wc, `(${expandScroller})()`).catch(() => false);
    if (expanded) await inPage(wc, settle).catch(() => {});
    try {
      const m = await dbg.sendCommand('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      const width = Math.ceil(size.width);
      const height = Math.min(MAX_HEIGHT, Math.ceil(size.height));
      const parts = [];
      for (const [y, h] of tiles(height)) {
        const r = await dbg.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y, width, height: h, scale: 1 },
        });
        parts.push(nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')));
      }
      return { image: stitch(parts), cut: size.height > MAX_HEIGHT };
    } finally {
      if (expanded) await inPage(wc, `(${unexpandScroller})()`).catch(() => {});
      if (mine) try { dbg.detach(); } catch { /* ya se había ido */ }
    }
  }

  /** Lo visible sale de lo que ya está pintado. La primera captura de una vista
      a veces viene vacía (ver snapshotPage en tabs.cjs): se reintenta. */
  async function visible(wc) {
    for (let i = 0; i < 3; i++) {
      const img = await wc.capturePage().catch(() => null);
      if (img && !img.isEmpty()) return { image: img, cut: false };
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error('No se pudo capturar la página.');
  }

  /** La parte de arriba de la captura, chiquita, para la tarjeta. */
  function thumbOf(image) {
    const { width, height } = image.getSize();
    const top = image.crop({ x: 0, y: 0, width, height: Math.min(height, Math.round(width * 0.75)) });
    return `data:image/jpeg;base64,${top.resize({ width: 144, quality: 'good' }).toJPEG(85).toString('base64')}`;
  }

  /** Cómo se llama la carpeta para una persona: la de siempre es Imágenes\Prism. */
  const folderLabel = (folder) => (folder === path.join(app.getPath('pictures'), 'Prism') ? 'Imágenes\\Prism' : folder);

  async function run(kind = 'visible') {
    const t = ctx.tabs?.active;
    const wc = t?.view?.webContents;
    if (!wc || t.internal || busy) return null;
    busy = true;
    const full = kind === 'full';
    try {
      // Si la pidió un menú, la vista vuelve a su lugar recién cuando el menú se va.
      await ctx.tabs.whenThawed();
      // La entera tarda: la tarjeta aparece ya, y cuando termina releva su contenido.
      if (full) ctx.card.show({ kind: 'busy', title: 'Capturando la página entera…', text: 'La estoy recorriendo de punta a punta.' });
      const { image, cut } = full ? await fullPage(wc) : await visible(wc);
      const { width, height } = image.getSize();

      const folder = dir();
      await fsp.mkdir(folder, { recursive: true });
      const file = path.join(folder, fileName(t.url, new Date(), full));
      const png = image.toPNG();
      await fsp.writeFile(file, png);

      const copied = width * height <= MAX_CLIPBOARD_PX;
      // Desde Electron 44 el portapapeles es el de la web: la imagen va como un PNG.
      if (copied) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      const where = folderLabel(folder);
      ctx.card.show({
        kind: 'done',
        title: full ? 'Página entera capturada' : 'Captura lista',
        text: `${copied ? `Copiada y guardada en ${where}` : `Guardada en ${where} (muy larga para copiarla)`}${cut ? ' · hasta donde se pudo' : ''}`,
        thumb: thumbOf(image),
        buttons: [
          { id: 'open', label: 'Abrir', icon: 'image' },
          { id: 'folder', label: 'Mostrar en la carpeta', icon: 'folderOpen' },
        ],
        life: 7000,
      }, {
        open: () => shell.openPath(file),
        thumb: () => shell.openPath(file),
        folder: () => shell.showItemInFolder(file),
      });
      return file;
    } catch (err) {
      console.error('[capture]', err);
      ctx.card.show({ kind: 'error', title: 'No se pudo capturar', text: err.message || 'La página no se dejó capturar.', life: 7000 });
      return null;
    } finally {
      busy = false;
    }
  }

  return { run, dir };
}

module.exports = { createCapture, fileName, tiles, stamp, TILE, MAX_HEIGHT };
