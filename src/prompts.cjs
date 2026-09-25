'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preguntas a la persona
   Un permiso o un "¿qué pantalla compartís?" nace en el proceso principal pero
   se contesta en la ventana. Cada pregunta viaja con un id y queda esperando
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

  ipcMain.on('prompt:answer', (_e, id, answer) => {
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
    cancelAll,
  };
}

module.exports = { createPrompts };
