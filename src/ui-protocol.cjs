'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la interfaz por su propio esquema (prism-ui://app/…)
   El cromo, la tarjeta, la lista de contraseñas y la ventanita se cargaban
   como file://, y en Electron una página file:// tiene privilegios que en
   Chrome no tiene: puede leer cualquier otro archivo de la compu. Para la
   interfaz de Prism daba igual, pero Prism también abre los .html de Windows
   (es el navegador predeterminado), y un comprobante.html que llega por mail
   y se abre con doble click corría con ese permiso.

   La salida es la que recomienda Electron: la interfaz se sirve por un
   esquema propio, y el instalador apaga el privilegio de file:// (el fuse
   grantFileProtocolExtraPrivileges, en package.json). Así un archivo local
   abierto en una pestaña es una página más, como en Chrome.

   · El esquema es estándar y seguro: las direcciones relativas, los módulos
     de JS y el worker de pdf.js funcionan como en cualquier sitio.
   · Sirve solo lo que está en renderer/, y solo a la sesión de la interfaz:
     las páginas viven en otra (web.cjs) y no lo pueden pedir.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, net } = require('electron');

const SCHEME = 'prism-ui';
const HOST = 'app';
const ROOT = path.join(__dirname, '..', 'renderer');

/** Antes de que la app esté lista: el esquema se anota estándar y seguro (una sola vez). */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

/** Con la app lista: sirve los archivos de renderer/, y nada que quede afuera. */
function serve() {
  protocol.handle(SCHEME, async (req) => {
    let url;
    try { url = new URL(req.url); } catch { return new Response(null, { status: 400 }); }
    if (url.host !== HOST) return new Response(null, { status: 404 });
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response(null, { status: 404 });
    try {
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

/** La dirección de una página de la interfaz: uiUrl('index.html'). */
const uiUrl = (page) => `${SCHEME}://${HOST}/${page}`;

module.exports = { registerScheme, serve, uiUrl, SCHEME };
