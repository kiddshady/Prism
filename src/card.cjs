'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la tarjeta de la esquina
   Un aviso que flota sobre la página sin congelarla: una WebContentsView
   propia, chica y transparente, apoyada ENCIMA de las vistas de las pestañas
   en la esquina de abajo a la derecha. Todo lo que el DOM del cromo dibuje
   queda debajo de la página (ver tabs.cjs), así que un aviso que no bloquee
   tiene que ser otra vista nativa. Tapa solo su rectángulo: el resto de la
   página se sigue usando.

   Adentro dibuja renderer/card.html. Acá se decide dónde va y cuándo está:
   · Oculta, no se saca de la ventana: se corre afuera (como la página
     congelada), así vuelve pintada y en el acto.
   · Tiene que ir arriba de todo. Cada vez que las pestañas se reacomodan
     (una vista nueva entra encima), se la vuelve a subir.
   · Si se abre un menú (la página se congela), se va: quedaría tapándolo.
   · Mide lo que mide su contenido: la tarjeta avisa su alto y la vista se
     ajusta hacia arriba, con la base fija.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const { WebContentsView, ipcMain } = require('electron');

/** Ancho de la tarjeta y el aire transparente alrededor, donde cae su sombra. */
const WIDTH = 340;
const MARGIN = 28;
/** Separación del borde de la página. */
const INSET = 14;
const HIDDEN_X = -30000;

function createCard(ctx) {
  let view = null;
  let ready = null;
  let shown = false;
  let height = 96 + MARGIN * 2;
  let actions = {};

  function ensure() {
    if (ready) return ready;
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'card-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setBounds({ x: HIDDEN_X, y: 0, width: WIDTH + MARGIN * 2, height });
    ctx.win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    ready = wc.loadFile(path.join(__dirname, '..', 'renderer', 'card.html')).then(() => view);
    return ready;
  }

  const from = (e) => view && e.sender === view.webContents;
  ipcMain.on('card:size', (e, h) => {
    if (!from(e)) return;
    height = Math.max(40, Math.min(400, Math.round(Number(h) || 0)));
    place();
  });
  ipcMain.on('card:act', (e, name) => {
    if (!from(e)) return;
    const fn = actions[String(name)];
    // El clic le dio el teclado a la tarjeta: vuelve a la página.
    ctx.tabs?.focusPage();
    fn?.();
  });
  ipcMain.on('card:gone', (e) => {
    if (!from(e)) return;
    shown = false;
    place();
  });

  /** Abajo a la derecha de la página (de las dos mitades, si hay un par). */
  function place() {
    if (!view || !ctx.win || ctx.win.isDestroyed()) return;
    const w = WIDTH + MARGIN * 2;
    if (!shown) {
      view.setBounds({ x: HIDDEN_X, y: 0, width: w, height });
      return;
    }
    const p = ctx.tabs.pageBounds();
    view.setBounds({
      x: Math.round(p.x + p.width - INSET - WIDTH - MARGIN),
      y: Math.round(p.y + p.height - INSET - height + MARGIN),
      width: w,
      height,
    });
    raise();
  }

  /** Arriba de todo: una pestaña que entra se apila encima. */
  function raise() {
    const kids = ctx.win.contentView.children;
    if (kids[kids.length - 1] !== view) ctx.win.contentView.addChildView(view);
  }

  /**
   * Muestra (o actualiza, si ya está) la tarjeta.
   * d: { kind: 'busy'|'done'|'error', title, text, thumb, buttons: [{ id, label, icon }], life }
   * onAct: { [id]: fn } — lo que hace cada botón (y 'thumb' al tocar la miniatura).
   */
  async function show(d, onAct = {}) {
    await ensure();
    actions = onAct;
    shown = true;
    place();
    view.webContents.send('card:show', d);
  }

  function hide() {
    if (shown && view) view.webContents.send('card:hide');
  }

  return { show, hide, place, get shown() { return shown; } };
}

module.exports = { createCard };
