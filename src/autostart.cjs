/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — arrancar con Windows
   El interruptor de Ajustes. La verdad la tiene Windows, no un ajuste de
   Prism: si la persona lo apaga desde Configuración → Aplicaciones → Inicio,
   Windows lo anota aparte (StartupApproved) y el interruptor de acá tiene que
   mostrarlo apagado. Por eso `state` le pregunta a Windows si de verdad va a
   lanzar Prism (executableWillLaunchAtLogin), y `set` escribe las dos cosas:
   la entrada de Run y su aprobación.

   Arranca con --hidden: Prism carga escondido en la bandeja y aparece al
   instante con un clic, Ctrl+Alt+P o un link (ver main.cjs).
   ═══════════════════════════════════════════════════════════════════════════ */

const HIDDEN = '--hidden';

function createAutostart({ app, exe = process.execPath } = {}) {
  /* Solo Prism instalado: el de desarrollo anotaría el electron.exe de
     node_modules para arrancar con Windows. */
  const supported = process.platform === 'win32' && !!app?.isPackaged;
  const opts = { path: exe, args: [HIDDEN] };

  function state() {
    if (!supported) return { supported: false, on: false };
    const s = app.getLoginItemSettings(opts);
    return { supported: true, on: !!s.executableWillLaunchAtLogin };
  }

  function set(on) {
    if (!supported) return state();
    app.setLoginItemSettings({ ...opts, openAtLogin: !!on, enabled: !!on });
    return state();
  }

  /* Al abrir, si está prendido, se reescribe: si Prism se reinstaló en otra
     carpeta, la entrada sigue apuntando al .exe de hoy. */
  function refresh() {
    if (state().on) set(true);
  }

  return { supported, state, set, refresh };
}

module.exports = { createAutostart, HIDDEN };
