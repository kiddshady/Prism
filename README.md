# Prism

Un navegador de escritorio. Adentro es Chromium de verdad —cada pestaña es un
`WebContentsView` con su propio proceso—, y afuera es [Opal](S:\tools\Opal):
todo el cromo (pestañas, barra de direcciones, menús, paneles) es vidrio sobre
niebla, dibujado a mano. Ni un control nativo, ni un emoji, ni una transición
que falte.

```
npm run dev     # con la consola del cromo en la terminal
npm start
npm test        # lógica pura: omnibox, historial, atajos, tokens, disco
npm run smoke   # levanta Prism de verdad contra un servidor local y lo recorre
npm run icons   # regenera build/icon.ico, icon.png y tray.ico desde el código
npm run build   # instalador en dist/, sin publicar
npm run release # publica en GitHub (ver abajo)
```

## Qué trae

- **Pestañas** arriba, en la titlebar: se arrastran para reordenar, click del
  medio cierra, al cerrar con el mouse el ancho se congela (la cruz de la
  siguiente queda debajo del cursor), un parlante para silenciar, y las que
  abre una página se encolan a su derecha.
- **Fijadas**: angostas, solo el ícono, siempre a la izquierda. Ctrl+W no las
  cierra, cargan al abrir Prism y nunca se duermen.
- **Dormidas**: la pestaña que no mirás hace un rato (30 min por defecto, se
  cambia en Ajustes) cierra su proceso y libera memoria. Al mirarla vuelve
  donde estaba: misma página, atrás y adelante, scroll y formularios. Nunca se
  duermen las fijadas ni las que suenan.
- **Omnibox**: dirección o búsqueda en un solo campo, autocompleta en línea los
  sitios que ya visitaste, sugiere de tu historial, tus favoritos y el buscador.
  Sin foco muestra la dirección partida — el host claro, el resto atenuado.
- **Bloqueador** de anuncios, rastreadores y carteles de cookies (motor de
  Ghostery con listas de EasyList, EasyPrivacy y uBlock Origin). Cuenta lo que
  bloquea en cada página y se apaga por sitio desde el escudo.
- **Historial** agrupado por día, con búsqueda. **Favoritos** con la estrella
  o Ctrl+D. **Descargas** con progreso, pausa y reintento.
- **Nueva pestaña** con tus favoritos y los sitios que más visitás.
- **Permisos** propios: cámara, micrófono, ubicación, notificaciones… se
  preguntan y se recuerdan por sitio. Compartir pantalla con selector propio.
- **Sesión**: vuelve con las pestañas de antes, y cada una carga recién
  cuando la mirás.
- **Oscuro**: los sitios ven `prefers-color-scheme: dark`, y hay un ajuste
  para oscurecer también los que no tienen modo oscuro.
- **Atajos** de Chrome (la tabla completa está en Ajustes).
- **Vive en la bandeja.** Cerrar la ventana no cierra Prism: se esconde con
  las pestañas vivas (la música sigue, las descargas siguen). Salir de verdad
  es *Salir de Prism* en la bandeja o en el menú, o Ctrl+Mayús+Q. Instancia
  única: abrirlo otra vez (o abrir un link con Prism) lo trae de vuelta.
- **Se actualiza solo** desde los releases de GitHub: busca al arrancar y
  cada seis horas, avisa con un punto en el menú y en la statusbar, y no
  baja nada sin que digas que sí.

---

## Cómo está hecho

### La vista nativa encima del DOM — y el congelado

Una pestaña web es un `WebContentsView` apoyado exactamente sobre el
rectángulo de `#page`. Es un Chromium aparte, y eso trae una restricción dura:
**la vista tapa todo lo que el DOM dibuje en su rectángulo**, sin importar el
z-index. Un menú que cae sobre la página quedaría debajo de ella.

La salida es el *congelado* (`renderer/js/freeze.js`): antes de abrir cualquier
overlay que pise la página, se le saca una foto (`capturePage`), el cromo la
pinta en su lugar, y recién ahí se retira la vista. Para el ojo no cambia nada
— y como la foto sí está en el DOM, el vidrio del overlay la esmerila de
verdad. Es un contador: dos overlays a la vez congelan una sola vez.

Lo que NO puede congelar (porque se usa mientras mirás la página) vive fuera
de su rectángulo: la búsqueda en la página entra a la barra de herramientas,
el link bajo el mouse va a la statusbar, y los avisos también.

Sobre páginas claras, el vidrio de Opal (luz sobre niebla oscura) quedaba gris
claro con texto gris encima. Los overlays llevan una base oscura debajo de la
hoja (`--pr-float-base` en `prism.css`): el color de la página sigue pasando,
pero el contraste ya no depende de ella.

### Quién sabe qué

El proceso principal es la única fuente de verdad de las pestañas
(`src/tabs.cjs`). El cromo no guarda nada: recibe la foto completa del estado
en cada cambio y la dibuja. Las páginas propias (`prism://nueva`, `historial`,
`favoritos`, `descargas`, `ajustes`) no tienen vista: las dibuja el cromo
adentro de la hoja, y por eso pueden ser vidrio de verdad.

Los atajos no pueden vivir en el DOM: con el foco en una página, las teclas van
a SU proceso. Se interceptan con `before-input-event` en los dos lados y se
resuelven en un solo lugar (`src/shortcuts.cjs`, con tests).

### Las páginas no ven nada de Prism

Viven en su propia sesión (`persist:prism`), sandboxeadas, sin preload. El
default de Electron es **conceder** todo permiso que se pida; acá todo lo
sensible pasa por una pregunta y lo que no está en ninguna lista se niega
(`src/web.cjs`). El user agent se presenta como el Chromium que es, sin
"Electron/": el login de Google rechaza a los que se identifican así.

### Trampas que ya se pisaron

- **`findNext` está al revés.** En Electron, `findInPage(t, { findNext: true })`
  quiere decir "empezar una búsqueda NUEVA". El código habla de sesión.
- **La primera captura de una vista puede salir vacía.** Se reintenta.
- **Volver atrás desde la bfcache** restaura la página sin volver a emitir
  `page-title-updated`: el título se lee en `did-navigate`.
- **Un click por script no es un click.** Sin gesto de usuario, Chromium marca
  la entrada anterior del historial como salteable y Atrás la saltea. Es lo
  correcto (así se defiende de las páginas que llenan el historial solas); el
  humo clickea con eventos de mouse de verdad.
- **Varias pestañas cargando a la vez** intercalan sus visitas: el historial
  deduplica mirando el último minuto entero, no solo la última visita.

---

## El mapa

```
main.cjs              La ventana (anti-flash de Opal), el arranque y los comandos.
preload.cjs           La única puerta del cromo al sistema.
src/
  tabs.cjs            Las pestañas: vistas, navegación, congelado, sesión.
  omni.cjs            URL o búsqueda. Pura, con tests.
  library.cjs         Historial y favoritos, con el ranking de sugerencias.
  web.cjs             La sesión de las páginas: permisos, pantalla, identidad.
  adblock.cjs         El bloqueador, con conteo por pestaña y apagado por sitio.
  downloads.cjs       Descargas.
  prompts.cjs         Preguntas que nacen acá y se contestan en el cromo.
  shortcuts.cjs       Atajos. Puro, con tests.
  updater.cjs         Auto-update desde los releases de GitHub.
  ipc.cjs             Lo que el cromo puede pedir.
  store.cjs           JSON atómico (de Opal) y los ajustes.
renderer/
  index.html          El shell: tira de pestañas, barra, hoja de la página.
  css/prism.css       El cromo del navegador (prefijo pr-).
  css/pages.css       Las páginas propias.
  js/tabstrip.js      Pestañas posicionadas a mano, con arrastre.
  js/omnibox.js       La barra de direcciones y sus sugerencias.
  js/toolbar.js       Navegación, buscar en la página, escudo, descargas.
  js/pages.js         Nueva pestaña, historial, favoritos, descargas, ajustes.
  js/freeze.js        El congelado.
  js/layers.js        Menú, modal y popover de Opal, con congelado.
  (el resto)          El sistema de Opal: tokens, controles, overlays, motion.
tools/
  icons.mjs           El ícono y el de la bandeja, desde la geometría de la marca.
  release.mjs         Publicar un release entero, o nada.
  shot.mjs            Captura fiel (cromo + página) en modo verificación.
  cdp.mjs · main.mjs  Manejar el cromo y el proceso principal desde afuera.
```

### Modo verificación

`PRISM_SHOTS=1` abre la ventana **fuera de pantalla**, sin robar el foco, con
un perfil descartable (`PRISM_PROFILE`) y sin el cálculo de oclusión de
Windows (una ventana tapada deja de pintar). Es lo que usa el humo, y lo que
permite fotografiar Prism mientras la compu se sigue usando:

```
$env:PRISM_SHOTS=1; $env:PRISM_DATA="$env:TEMP\prism-shots\data"
npx electron --inspect=9334 . --dev --remote-debugging-port=9333
node tools/shot.mjs .shots/algo.png
```

### Publicar una versión

La receta de Quire/Umbral/Mnemus: sin servidor, `electron-updater` lee el
`latest.yml` que electron-builder sube a cada release de `kiddshady/Prism`
(el repo tiene que ser público para que la app instalada lo lea sin token).

```
npm version patch -m "Version %s"
git push origin main --follow-tags
npm run release
```

En ese orden: el tag tiene que estar en GitHub ANTES del release, o GitHub lo
crea sobre el commit anterior. `tools/release.mjs` (de Mnemus) crea el
borrador antes de compilar —electron-builder tiene una carrera que parte el
release en dos borradores gemelos—, verifica lo subido contra `dist/` y recién
ahí publica. `npm run release -- --ensayo` hace todo el camino y borra.

Para probar el cartel sin compilar: `PRISM_UPDATE_TEST=1 npm start` finge ser
la 0.0.1 contra los releases reales.

### Los datos

En desarrollo, `data/` del proyecto; empaquetada, el `userData` de la app;
`PRISM_DATA` los mueve. Historial, favoritos, descargas y sesión son JSON
legibles con escritura atómica (la de Opal, con sus tres trampas cubiertas).

Kidd Shady · Umbrovex Systems
