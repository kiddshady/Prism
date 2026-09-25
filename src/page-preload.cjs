'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: scrollbars
   Las scrollbars de las páginas, a tono con las de la ventana. Se registra en
   la sesión de las páginas (web.cjs) solo con el ajuste prendido, y corre en
   cada frame ANTES de que el documento pinte: la nativa no llega a asomarse.
   Inyectado en `dom-ready`, la página ya se veía con la de Chromium.

   Van con origen 'user': si la página declara las suyas, las de la página
   ganan. El gris medio con alfa se lee igual sobre una página clara que sobre
   una oscura.

   Corre sandboxeado y no expone nada: ni `window`, ni IPC. Solo CSS.
   ═══════════════════════════════════════════════════════════════════════════ */

const { webFrame } = require('electron');

webFrame.insertCSS(`
::-webkit-scrollbar { width: 11px; height: 11px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, .38);
  border: 3px solid transparent; border-radius: 999px; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background-color: rgba(128, 128, 128, .62); }
::-webkit-scrollbar-button { display: none; }`, { cssOrigin: 'user' });
