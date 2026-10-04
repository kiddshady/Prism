'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preguntas a la persona
   Un permiso, un "¿qué pantalla compartís?" o un "¿salir igual?" nace en el
   proceso principal pero se contesta en la ventana. Cada pregunta viaja con un id y queda esperando
   su respuesta; si la ventana se recarga o la pestaña se cierra mientras
   tanto, la respuesta es NO — un pedido colgado nunca termina concediendo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain } = require('electron');

function createPrompts(ctx) {
  let seq = 0;
  const pending = new Map();   // id → { resolve, wcId }

  function ask(kind, payload, fallback, wcId = null) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, { resolve, wcId, fallback });
      ctx.send('prompt:ask', { id, kind, ...payload });
    });
  }

  /* Solo contesta la ventana de esta pregunta (cada ventana tiene su fila).
     Si una página pudiera mandar esto, un renderer comprometido se concedería
     la cámara a sí mismo. */
  ipcMain.on('prompt:answer', (e, id, answer) => {
    if (!ctx.win || ctx.win.isDestroyed() || e.sender !== ctx.win.webContents) return;
    const p = pending.get(Number(id));
    if (!p) return;
    pending.delete(Number(id));
    p.resolve(answer ?? p.fallback);
  });

  /** Todo lo que estaba esperando se contesta con su default (negar). */
  function cancelAll(wcId = null) {
    for (const [id, p] of pending) {
      if (wcId != null && p.wcId !== wcId) continue;
      pending.delete(id);
      p.resolve(p.fallback);
      ctx.send('prompt:cancel', id);
    }
  }

  return {
    permission: ({ origin, what, keys, wcId }) =>
      ask('permission', { origin, what, keys }, { allow: false, remember: false }, wcId),
    pickSource: ({ origin, sources }) => ask('display', { origin, sources }, null),
    /** Una pregunta de Prism (no de un sitio): sí o no. Sin respuesta, no.
        La pidió la persona (Ctrl+Mayús+Q desde una página, la bandeja), así
        que el diálogo toma el teclado: sin eso, Escape y Enter seguían yendo
        a donde estaba el foco y el diálogo no los oía. Al contestar, el
        teclado vuelve a la página si lo tenía. */
    async confirm({ title, sub, confirmLabel, cancelLabel }) {
      const page = ctx.tabs?.active?.view?.webContents;
      const hadPage = !!page && !page.isDestroyed() && page.isFocused();
      ctx.focusChrome?.();
      const yes = await ask('confirm', { title, sub, confirmLabel, cancelLabel }, false);
      if (!yes && hadPage) ctx.tabs?.focusPage();
      return yes;
    },
    cancelAll,
  };
}

module.exports = { createPrompts };
