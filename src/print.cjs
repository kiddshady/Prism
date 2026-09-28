'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — imprimir
   El diálogo de Windows no sabe dibujar la vista previa de una app de
   Electron («Esta aplicación no admite la vista previa de impresión»). Prism
   tiene su propia pantalla (renderer/js/print.js), como la de Chrome: las
   opciones a un costado y, al otro, las hojas de verdad.

   La vista previa ES un PDF de la página, hecho con las mismas opciones que
   después van a la impresora: lo que se ve es lo que sale. La interfaz lo
   dibuja con pdf.js (no con el visor de Chromium, gris y con su barra).

   Desde acá:
   · preview  el PDF con las opciones de armado (papel, orientación,
              márgenes, escala, fondos). Elegir páginas, copias o color no lo
              rehace: la interfaz muestra o tiñe las hojas que ya tiene.
   · run      a la impresora, directo, sin el diálogo de Windows.
   · save     "Guardar como PDF", adonde diga la persona.
   · system   el diálogo de Windows de siempre, para lo que la pantalla
              propia no ofrece (bandeja, calidad, lo propio de cada impresora).
   ═══════════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { dialog, shell } = require('electron');

const PAPERS = ['A4', 'Letter', 'Legal'];
/** El margen "predeterminado" de Chromium: 1 cm, en pulgadas para printToPDF. */
const DEFAULT_MARGIN_IN = 0.4;
const MAX_RANGES = 100;

/** Solo lo que se sabe usar, acotado: la interfaz no es de fiar a ciegas. */
function clean(o = {}) {
  const int = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const ranges = Array.isArray(o.ranges)
    ? o.ranges.slice(0, MAX_RANGES)
      .map((r) => [int(r?.[0], 1, 99999, 0), int(r?.[1], 1, 99999, 0)])
      .filter(([a, b]) => a >= 1 && b >= a)
    : [];
  return {
    landscape: !!o.landscape,
    paper: PAPERS.includes(o.paper) ? o.paper : 'A4',
    margins: o.margins === 'none' ? 'none' : 'default',
    scale: int(o.scale, 10, 200, 100),
    background: !!o.background,
    color: o.color !== false,
    copies: int(o.copies, 1, 99, 1),
    duplex: !!o.duplex,
    ranges,
    device: String(o.device || '').slice(0, 512),
  };
}

/** Las opciones de printToPDF: las mismas que después van a print(). */
function pdfOptions(o, withRanges) {
  return {
    landscape: o.landscape,
    printBackground: o.background,
    scale: o.scale / 100,
    pageSize: o.paper,
    margins: o.margins === 'none'
      ? { top: 0, bottom: 0, left: 0, right: 0 }
      : { top: DEFAULT_MARGIN_IN, bottom: DEFAULT_MARGIN_IN, left: DEFAULT_MARGIN_IN, right: DEFAULT_MARGIN_IN },
    pageRanges: withRanges && o.ranges.length ? o.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') : '',
  };
}

/** El nombre del archivo: el título de la página, sin lo que Windows no acepta. */
function fileName(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || 'Página'}.pdf`;
}

/** La impresora predeterminada de Windows (Electron no la dice). */
let defaultCache = null;
function defaultPrinter() {
  if (defaultCache && Date.now() - defaultCache.at < 30_000) return Promise.resolve(defaultCache.name);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      const m = !err && /Device\s+REG_SZ\s+([^,\r\n]+)/.exec(String(out));
      const name = m ? m[1].trim() : null;
      defaultCache = { at: Date.now(), name };
      resolve(name);
    });
  });
}

function createPrint(ctx) {
  /** La pestaña a imprimir: una web de esta ventana, viva. */
  function tabOf(id) {
    const t = ctx.tabs?.list.find((x) => x.id === Number(id));
    const wc = t?.view?.webContents;
    if (!t || t.internal || !wc || wc.isDestroyed()) throw new Error('Esta pestaña no se puede imprimir.');
    return { t, wc };
  }

  async function printers() {
    const wc = ctx.win && !ctx.win.isDestroyed() ? ctx.win.webContents : null;
    const [list, dflt] = await Promise.all([wc ? wc.getPrintersAsync().catch(() => []) : [], defaultPrinter()]);
    return {
      list: list.map((p) => ({ name: p.name, label: p.displayName || p.name })),
      default: list.some((p) => p.name === dflt) ? dflt : null,
    };
  }

  async function preview(id, opts) {
    const { wc } = tabOf(id);
    return wc.printToPDF(pdfOptions(clean(opts), false));
  }

  function run(id, opts) {
    const { t, wc } = tabOf(id);
    const o = clean(opts);
    if (!o.device) throw new Error('Elegí una impresora.');
    return new Promise((resolve) => {
      wc.print({
        silent: true,
        deviceName: o.device,
        printBackground: o.background,
        color: o.color,
        landscape: o.landscape,
        scaleFactor: o.scale,
        copies: o.copies,
        duplexMode: o.duplex ? 'longEdge' : 'simplex',
        pageSize: o.paper,
        margins: { marginType: o.margins },
        ...(o.ranges.length ? { pageRanges: o.ranges.map(([a, b]) => ({ from: a - 1, to: b - 1 })) } : {}),
      }, (ok, why) => {
        if (ok) {
          ctx.card?.show({ kind: 'done', title: 'Enviado a la impresora', text: `${t.title || 'La página'} · ${o.device}`, life: 5000 });
        } else if (why !== 'cancelled') {
          ctx.card?.show({ kind: 'error', title: 'No se pudo imprimir', text: why ? `La impresora contestó: ${why}` : 'La impresora no lo aceptó.', life: 7000 });
        }
        resolve(!!ok);
      });
    });
  }

  async function save(id, opts) {
    const { t, wc } = tabOf(id);
    const o = clean(opts);
    const win = ctx.win && !ctx.win.isDestroyed() ? ctx.win : null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Guardar como PDF',
      defaultPath: path.join(ctx.downloads?.dir() || '', fileName(t.title)),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;
    try {
      const data = await wc.printToPDF(pdfOptions(o, true));
      await fsp.writeFile(filePath, data);
    } catch (err) {
      ctx.card?.show({ kind: 'error', title: 'No se pudo guardar el PDF', text: err.message || 'La página no se dejó guardar.', life: 7000 });
      return null;
    }
    ctx.card?.show({
      kind: 'done',
      title: 'PDF guardado',
      text: path.basename(filePath),
      buttons: [
        { id: 'open', label: 'Abrir', icon: 'file' },
        { id: 'folder', label: 'Mostrar en la carpeta', icon: 'folderOpen' },
      ],
      life: 7000,
    }, {
      open: () => shell.openPath(filePath),
      folder: () => shell.showItemInFolder(filePath),
    });
    return filePath;
  }

  /** El diálogo de Windows, con lo elegido acá ya puesto. */
  function system(id, opts) {
    const { wc } = tabOf(id);
    const o = clean(opts);
    wc.print({
      silent: false,
      ...(o.device ? { deviceName: o.device } : {}),
      printBackground: o.background,
      color: o.color,
      landscape: o.landscape,
      copies: o.copies,
    });
  }

  return { printers, preview, run, save, system };
}

module.exports = { createPrint, clean, pdfOptions, fileName };
