# Prism

Un navegador de escritorio. Adentro es Chromium de verdad —cada pestaña es un
`WebContentsView` con su propio proceso—, y afuera es [Opal](S:\tools\Opal):
todo el cromo (pestañas, barra de direcciones, menús, paneles) es vidrio sobre
niebla, dibujado a mano. Ni un control nativo, ni un emoji, ni una transición
que falte.

```
npm run dev     # con la consola del cromo en la terminal
npm start
npm test        # lógica pura: omnibox, cuentas, historial, atajos, tokens, disco, registro de Windows
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
- **Vista dividida**: dos pestañas lado a lado, unidas en la tira. Se arma
  desde el menú de la pestaña (con una nueva o con la actual) o con *Abrir el
  enlace al costado*. La barra de direcciones maneja la mitad activa (la del
  canto de luz); un clic en la otra la vuelve la activa. El divisor se
  arrastra (doble clic: mitad y mitad), el par se arrastra entero y la sesión
  lo recuerda. Cerrar una mitad o *Separar* lo deshace.
- **Omnibox**: dirección o búsqueda en un solo campo, autocompleta en línea los
  sitios que ya visitaste, sugiere de tu historial, tus favoritos y el buscador.
  Sin foco muestra la dirección partida — el host claro, el resto atenuado.
- **Cuentas y conversiones** en la barra: `250/3`, `15% de 300`,
  `1000 + 21%`, `-log(1,8e-5)`, `500 mg a g`, `37 c a f`, `5 mg/ml a g/l`.
  El resultado aparece como segunda fila (la primera sigue siendo lo que hace
  Enter) y elegirlo lo copia. Coma decimal y punto de miles, como se escribe
  acá; sin eval, con un parser propio.
- **Bloqueador** de anuncios, rastreadores y carteles de cookies (motor de
  Ghostery con listas de EasyList, EasyPrivacy y uBlock Origin). Cuenta lo que
  bloquea en cada página y se apaga por sitio desde el escudo.
- **Historial** agrupado por día, con búsqueda. **Favoritos** con la estrella
  o Ctrl+D, e importados de Chrome, Edge o Brave (o de un HTML exportado).
  **Descargas** con progreso, pausa y reintento. Salir (o reiniciar para
  actualizar) con una bajando pregunta antes, y si se corta igual queda en la
  lista para reintentar.
- **Barra de favoritos** debajo de la de direcciones, como en Chrome
  (Ctrl+Mayús+B la muestra u oculta). Lo que no entra queda en la flecha de la
  punta; se arrastran para cambiarlos de lugar, y el botón del medio abre en
  una pestaña nueva. Los de la flecha también se arrastran: adentro del menú
  para reordenarlos, o afuera hasta la barra para ponerlos a la vista.
- **Incógnito** (Ctrl+Mayús+N), con su fantasmita: una ventana aparte con su
  propia sesión en memoria, nueva cada vez. No anota historial, no recuerda
  permisos ni ofrece guardar contraseñas, y al cerrarla se borra todo. Los
  favoritos, los ajustes y el bloqueador son los mismos.
- **Capturas**: lo visible, o la página entera de punta a punta (Ctrl+Mayús+S)
  sin mover el scroll, también en las que scrollean una caja adentro (Moodle).
  Van a Imágenes\Prism y quedan copiadas; una tarjeta en la esquina avisa, con
  la miniatura, Abrir y Mostrar en la carpeta.
- **Imprimir con vista previa** (Ctrl+P, el menú o el botón "Imprimir" de un
  sitio): una pantalla propia, como la de Chrome, con las hojas de verdad al
  lado de las opciones (páginas, copias, orientación, color, papel, márgenes,
  escala, fondos, doble faz). Imprime directo o guarda como PDF; para lo
  propio de cada impresora queda el diálogo de Windows a un clic.
- **Ventanita** (picture-in-picture propio): un video sale a una ventana chica
  que queda siempre arriba mientras usás otra cosa. Con el botón que aparece
  sobre el video, el clic derecho, el menú o Ctrl+Mayús+P (que también lo trae
  de vuelta). Tiene sus controles: pausa, diez segundos atrás y adelante,
  barra de tiempo, silencio, volver a la pestaña y cerrar; se arrastra y se
  agranda desde los bordes, y recuerda dónde quedó. Encuentra el video aunque
  esté en un iframe (el de YouTube adentro del aula del campus).
- **Nueva pestaña** con tus favoritos y los sitios que más visitás.
- **Permisos** propios: cámara, micrófono, ubicación, notificaciones… se
  preguntan y se recuerdan por sitio. Compartir pantalla con selector propio.
  Abrir una aplicación (`mailto:`, `zoommtg:`) se pregunta por esquema, y
  los de Windows que se prestan a abuso se niegan siempre. Una página abre
  ventanas o pestañas solo después de un click tuyo: las demás se bloquean,
  y la tarjeta de la esquina avisa y ofrece abrirlas.
- **Sesión**: vuelve con las pestañas de antes, y cada una carga recién
  cuando la mirás.
- **Oscuro**: los sitios ven `prefers-color-scheme: dark`, y hay un ajuste
  para oscurecer también los que no tienen modo oscuro.
- **Atajos** de Chrome (la tabla completa está en Ajustes).
- **Vive en la bandeja.** Cerrar la ventana no cierra Prism: se esconde con
  las pestañas vivas (la música sigue, las descargas siguen). Salir de verdad
  es *Salir de Prism* en la bandeja o en el menú, o Ctrl+Mayús+Q. Instancia
  única: abrirlo otra vez (o abrir un link con Prism) lo trae de vuelta.
- **Navegador predeterminado**: Prism se anota en Windows como navegador (para
  los links, los .html y los PDF), así aparece en "Abrir con" y en
  Aplicaciones predeterminadas. Windows no deja que una app se ponga sola:
  Ajustes dice quién abre los links hoy y un botón lleva a la página de
  Prism en Configuración, donde se elige con "Establecer como
  predeterminado". Al volver, la fila se entera sola. Desinstalar Prism
  borra el registro; actualizarlo, no.
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
el link bajo el mouse va a la statusbar, y los avisos también. La excepción es
la tarjeta de la esquina (`src/card.cjs`): una vista nativa propia, chica y
transparente, apoyada ENCIMA de las pestañas. Flota sin congelar nada y tapa
solo su rectángulo.

### La ventanita

No es la de Chromium: la pestaña le presta su vista entera (`src/pip.cjs`). El
`WebContentsView` se muda a una ventana chica, y adentro de su página el video
se pone en pantalla completa (`src/pip-preload.cjs`, que corre en cada frame).
La capa de pantalla completa de Chromium esquiva los transform, overflow y
z-index de los contenedores, así que el video llena la ventanita en cualquier
sitio; y como esa ventana no se puede poner en pantalla completa, la ventana
grande no se entera. Encima va otra vista transparente con los controles
(`renderer/pip.html`). No se copia ningún cuadro: es el mismo video, con su
sonido y su reproductor.

Mientras tanto la hoja de la pestaña avisa que el video está afuera. Una vista
nativa no se desvanece, así que al irse (y al volver) una foto de la página
cubre el cambio y se funde con el aviso.

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

Viven en su propia sesión (`persist:prism`), sandboxeadas, y no ven
`window.prism`. Sí corren preloads de sesión en un mundo aislado
(window.chrome, permisos, ventanita, imprimir, contraseñas, el bloqueador),
y esos tienen `ipcRenderer`: **todo canal nuevo pasa por `handle()`/`on()`
de `src/ipc.cjs` o mira a mano quién lo manda** (`senderFrame`). El default
de Electron es **conceder** todo permiso que se pida; acá todo lo sensible
pasa por una pregunta y lo que no está en ninguna lista se niega
(`src/web.cjs`). Lo que un sitio abre solo (un permiso, compartir pantalla)
no toma clicks los primeros 600 ms. El user agent se presenta como el
Chromium que es, sin "Electron/": el login de Google rechaza a los que se
identifican así.

La lista para completar contraseñas y tarjetas no está en la página: la
dibuja Prism en una vista propia, encima (`src/fill.cjs`), así la página
no la puede leer, estilar ni tapar. Y la interfaz de Prism no se carga
como `file://` sino por su esquema, `prism-ui://app` (`src/ui-protocol.cjs`):
el instalador le saca a `file://` el privilegio de leer otros archivos.

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
- **Un link de otra app es una línea de comandos.** Windows abre
  `"Prism.exe" -- "%1"`. Sin el `--`, una dirección con comillas cuela
  switches de Chromium detrás (CVE-2018-1000006); `--single-argument`, el de
  Chrome, Electron no lo respeta. En la segunda instancia Chromium mete sus
  propios switches ANTES del `--`: lo que viene después llega entero.
- **Un archivo no se vuelve dirección a mano.** `Apuntes #3.pdf` armado como
  `file:///…` cortaba la ruta en el `#` (el ancla): va con `pathToFileURL`.
- **Quién es el predeterminado se le pregunta al shell**, no al registro: en
  Windows 11 25H2 conviven `UserChoice` y `UserChoiceLatest` y pueden decir
  cosas distintas. Y `reg import` devuelve 0 aunque se saltee una clave: se
  verifica leyendo.
- **Configuración se entera tarde de un navegador nuevo.** El shell lo ve en
  el acto, pero la lista de Aplicaciones predeterminadas sale de un índice
  que no se rehace al registrarse (ni con `SHChangeNotify`): hasta entonces,
  el link lleva a la lista general. Reiniciar la compu lo rehace (confirmado
  con la 1.3.0); cerrar la sesión, no se probó. Por eso Prism se registra al
  arrancar, sin esperar al botón.
- **En Electron, una página `file://` lee otros archivos.** En Chrome no. Un
  `.html` de un mail abierto con doble click podía leer la compu entera. La
  interfaz va por `prism-ui://app` y el fuse `grantFileProtocolExtraPrivileges`
  está apagado en el instalador. Los fuses solo se aplican empaquetando: el
  humo corre el Electron de `node_modules`, así que se prueba sobre
  `dist/win-unpacked` (`electron-builder --win --dir`).
- **Desde Electron 44, `appendSwitch('enable-features')` llega tarde.**
  Chromium decide las scrollbars flotantes antes de que corra `main.cjs`: el
  flag tiene que estar en la línea de comandos de verdad. Los scripts lo
  pasan, y la app instalada que arranca sin él se relanza una vez con él
  (adelante del `--`, o se lee como un link).
- **Compartir pantalla llega como `media` sin tipos.** `getDisplayMedia` pasa
  primero por el manejador de permisos; negado ahí, el selector propio ni
  aparece. Desde Electron 45 va a llegar como `display-capture`.
- **Apagar Windows no pasa por `before-quit`.** Electron no lo emite cuando
  la sesión de Windows termina, y Prism vive en la bandeja: lo normal es
  apagar con él abierto. Windows le avisa a cada ventana (también a la
  escondida) y después puede matar el proceso en cualquier momento, así que
  `query-session-end` y `session-end` escriben en el acto y sin soltar el
  hilo (`writeJSONSync`). Medido: cuando `SendMessage` vuelve, la sesión y el
  historial ya están en el disco; con `WM_ENDSESSION` Electron cierra ahí
  mismo.
- **Un debounce sin tope no escribe nunca.** Una pestaña con un reloj en el
  título (un pomodoro) lo corría cada segundo: el historial no se guardaba
  mientras estuviera abierta. Lo pendiente llega al disco a los 5 s como
  mucho, y un título que cambia solo no apura la escritura.
- **Un archivo tomado no es un archivo vacío.** Si la lectura falla (un
  antivirus o un backup lo tiene abierto), se reintenta, y si no se suelta,
  ese archivo no se escribe en toda la corrida: arrancar vacío y guardar
  encima lo borraba. Un JSON roto se aparta como `.corrupto-…` y se avisa.
- **Probar la app empaquetada cerrando solo su PID.** `dist/win-unpacked/Prism.exe`
  se llama igual que el instalado: cerrar por nombre mata el Prism de quien
  lo está usando. Y al relanzarse, el PID cambia: se buscan los de esa ruta.

---

## El mapa

```
main.cjs              La ventana (anti-flash de Opal), el arranque y los comandos.
preload.cjs           La única puerta del cromo al sistema.
src/
  tabs.cjs            Las pestañas: vistas, navegación, congelado, sesión.
  omni.cjs            URL o búsqueda. Pura, con tests.
  calc.cjs            Cuentas y conversiones de la barra. Pura, con tests.
  library.cjs         Historial y favoritos, con el ranking de sugerencias.
  web.cjs             La sesión de las páginas: permisos, pantalla, identidad.
  adblock.cjs         El bloqueador, con conteo por pestaña y apagado por sitio.
  downloads.cjs       Descargas.
  capture.cjs         Capturas: lo visible y la página entera, por tramos cosidos.
  card.cjs            La tarjeta de la esquina: un aviso que flota sobre la página.
  fill.cjs            La lista de contraseñas y tarjetas: una vista propia sobre el campo.
  ui-protocol.cjs     prism-ui://app: la interfaz por su propio esquema, no como file://.
  print.cjs           Imprimir: la vista previa (un PDF), a la impresora o a un PDF.
  print-preload.cjs   En cada página: su window.print() abre la pantalla de Prism.
  pip.cjs             La ventanita: el video afuera, siempre arriba, con sus controles.
  pip-preload.cjs     En cada frame: el botón sobre los videos y el manejo del que sale.
  bookmarks-import.cjs  Favoritos de Chrome/Edge/Brave o de un HTML. Puro, con tests.
  prompts.cjs         Preguntas que nacen acá y se contestan en el cromo.
  shortcuts.cjs       Atajos. Puro, con tests.
  updater.cjs         Auto-update desde los releases de GitHub.
  default-browser.cjs Ser el navegador de Windows: el registro, quién abre los
                      links y lo que llega por la línea de comandos. Pura hasta
                      Electron, con tests.
  ipc.cjs             Lo que el cromo puede pedir.
  store.cjs           JSON atómico (de Opal) y los ajustes.
  windows.cjs         Las ventanas (normal e incógnito): de cuál viene cada pedido.
renderer/
  index.html          El shell: tira de pestañas, barra, hoja de la página.
  css/prism.css       El cromo del navegador (prefijo pr-).
  css/pages.css       Las páginas propias.
  js/tabstrip.js      Pestañas posicionadas a mano, con arrastre.
  js/omnibox.js       La barra de direcciones y sus sugerencias.
  js/toolbar.js       Navegación, buscar en la página, escudo, descargas.
  js/pages.js         Nueva pestaña, historial, favoritos, descargas, ajustes.
  js/bmbar.js         La barra de favoritos.
  js/print.js         La pantalla de impresión: opciones y hojas (con pdf.js).
  vendor/pdfjs/       pdf.js, copiado de node_modules (tools/vendor-pdfjs.mjs).
  js/freeze.js        El congelado.
  js/layers.js        Menú, modal y popover de Opal, con congelado.
  (el resto)          El sistema de Opal: tokens, controles, overlays, motion.
build/
  installer.nsh       Lo propio del instalador: desinstalar borra el registro
                      de navegador (actualizar no).
tools/
  icons.mjs           El ícono y el de la bandeja, desde la geometría de la marca.
  release.mjs         Publicar un release entero, o nada.
  vendor-pdfjs.mjs    Copiar pdf.js a renderer/vendor al actualizarlo.
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
npx electron --enable-features=OverlayScrollbar --inspect=9334 . --dev --remote-debugging-port=9333
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
legibles con escritura atómica (la de Opal, con sus trampas cubiertas, más una
cuarta: la escritura sincrónica para cuando Windows se apaga).

Kidd Shady · Umbrovex Systems
