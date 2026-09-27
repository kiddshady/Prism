'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — las ventanas
   Prism tiene una ventana normal y, a veces, una de incógnito. Cada una es un
   "contexto de ventana": su BrowserWindow, sus pestañas, su sesión de páginas,
   su tarjeta. El de incógnito hereda del normal (Object.create) todo lo que
   se comparte —favoritos, ajustes, bloqueador, contraseñas— y pisa lo propio.

   Acá se anotan, y de acá sale la respuesta a la pregunta que se hacen todos
   los canales IPC: ¿de qué ventana viene este pedido? Solo el cromo de una
   ventana de Prism puede hablar; una página (que tiene ipcRenderer en el
   mundo aislado de sus preloads) no es ninguna ventana y no recibe nada.
   ═══════════════════════════════════════════════════════════════════════════ */

const list = new Set();

/** Suma una ventana; devuelve la función que la saca. */
function add(w) {
  list.add(w);
  return () => list.delete(w);
}

const alive = (w) => !!w.win && !w.win.isDestroyed() && !w.win.webContents.isDestroyed();

/** La ventana cuyo cromo mandó el mensaje, o null (una página, o nadie). */
function ofSender(e) {
  for (const w of list) if (alive(w) && e?.sender === w.win.webContents) return w;
  return null;
}

/** La ventana a la que pertenece una sesión de páginas. */
function ofSession(session) {
  for (const w of list) if (w.web === session) return w;
  return null;
}

/** La pestaña de un webContents, en la ventana que sea. → { w, tab } */
function tabOf(wcId) {
  for (const w of list) {
    const tab = w.tabs?.byWebContents(wcId);
    if (tab) return { w, tab };
  }
  return null;
}

/** El mismo aviso a todas las ventanas (ajustes, favoritos, contraseñas). */
function broadcast(channel, payload) {
  for (const w of list) if (alive(w)) w.win.webContents.send(channel, payload);
}

const all = () => [...list];

module.exports = { add, ofSender, ofSession, tabOf, broadcast, all };
