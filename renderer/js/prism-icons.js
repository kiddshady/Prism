/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — íconos propios
   Se suman al set base de Opal con Icons.add(). Misma grilla (16), mismo
   trazo (1.5, puntas redondas). Ni un glifo: hasta la estrella del favorito
   y el escudo del bloqueador son trazos nuestros.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';

Icons.add({
  /* La marca: un prisma visto como gema, tres caras que reciben luz distinta.
     En la interfaz es acromática — la luz no rellena: talla —, así que las
     caras son la misma tinta con tres opacidades. La luz de la marca (el
     degradé #pr-gem) vive solo en el ícono de la app, el splash, la pestaña
     de nueva pestaña y la nueva pestaña. */
  prism: '<path class="pr-mark__f pr-mark__f--a" d="M7.55 3.78 2.73 12.12 7.55 9.34Z"/>'
       + '<path class="pr-mark__f pr-mark__f--b" d="M8.45 3.78 13.27 12.12 8.45 9.34Z"/>'
       + '<path class="pr-mark__f pr-mark__f--c" d="M3.18 12.90 12.82 12.90 8.00 10.12Z"/>',

  reload: '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M12.2 1.9v2.9H9.3"/>',
  star: '<path d="M8 2.1l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.08 4.47 12.95l.7-3.93L2.3 6.25l3.95-.55z"/>',
  starFill: '<path d="M8 2.1l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.08 4.47 12.95l.7-3.93L2.3 6.25l3.95-.55z" fill="currentColor"/>',
  shield: '<path d="M8 1.9 13.2 3.8v3.7c0 3.2-2.2 5.6-5.2 6.6-3-1-5.2-3.4-5.2-6.6V3.8z"/>',
  shieldCheck: '<path d="M8 1.9 13.2 3.8v3.7c0 3.2-2.2 5.6-5.2 6.6-3-1-5.2-3.4-5.2-6.6V3.8z"/><path d="M5.7 8.1 7.3 9.6l3-3.2"/>',
  shieldOff: '<path d="M8 1.9 13.2 3.8v3.7c0 3.2-2.2 5.6-5.2 6.6-3-1-5.2-3.4-5.2-6.6V3.8z"/><path d="M2.2 2.2l11.6 11.6"/>',
  speaker: '<path d="M2.4 6.2h2.4L8.2 3.2v9.6L4.8 9.8H2.4z"/><path d="M10.6 5.6a3.2 3.2 0 0 1 0 4.8M12.4 3.8a5.8 5.8 0 0 1 0 8.4"/>',
  speakerOff: '<path d="M2.4 6.2h2.4L8.2 3.2v9.6L4.8 9.8H2.4z"/><path d="M10.6 6.2l3.6 3.6M14.2 6.2l-3.6 3.6"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.3 2.4v2.9h2.9"/><path d="M8 5.2V8l2 1.4"/>',
  bookmark: '<path d="M4 2.2h8a.8.8 0 0 1 .8.8v10.8L8 10.9l-4.8 2.9V3a.8.8 0 0 1 .8-.8z"/>',
  printer: '<path d="M4.4 5.6V2.2h7.2v3.4"/><rect x="1.8" y="5.6" width="12.4" height="5.6" rx="1.6"/><path d="M4.4 9.4h7.2v4.4H4.4z"/>',
  code: '<path d="M5.4 4.4 1.8 8l3.6 3.6M10.6 4.4 14.2 8l-3.6 3.6M9.2 2.6 6.8 13.4"/>',
  image: '<rect x="2" y="2.6" width="12" height="10.8" rx="2"/><circle cx="5.8" cy="6.2" r="1.2"/><path d="M14 10.6 10.6 7.4 3.2 13.4"/>',
  tabs: '<rect x="1.8" y="4.4" width="12.4" height="9.4" rx="1.8"/><path d="M1.8 7.2h12.4M4.6 4.4V2.6a.6.6 0 0 1 .6-.6h3.6a.6.6 0 0 1 .6.6v1.8"/>',
  reopen: '<path d="M3.2 6.4a5 5 0 1 1-.1 3.4"/><path d="M2.6 3v3.4H6"/>',
  /* Capturas: el visor (cuatro esquinas) con lo que entra. La visible encierra
     un recuadro; la entera, una flecha que baja: la página sigue más allá. */
  /* Incógnito: un fantasmita. Cabeza redonda que usa casi toda la grilla, la
     falda en cinco medias ondas que empiezan y terminan bajando (los dos
     costados son piecitos), y los ojos como dos rayitas: con puntos
     rellenos, a 14 px se fundían con el borde de la cabeza. */
  ghost: '<path d="M2.8 13.6V7.2a5.2 5.2 0 0 1 10.4 0v6.4q-1.04 1.3-2.08 0t-2.08 0-2.08 0-2.08 0-2.08 0z"/>'
       + '<path d="M6.3 6.6v1.6M9.7 6.6v1.6"/>',
  capture: '<path d="M2 5.2V3.6A1.6 1.6 0 0 1 3.6 2h1.6M10.8 2h1.6A1.6 1.6 0 0 1 14 3.6v1.6M14 10.8v1.6a1.6 1.6 0 0 1-1.6 1.6h-1.6M5.2 14H3.6A1.6 1.6 0 0 1 2 12.4v-1.6"/><rect x="5" y="5.4" width="6" height="5.2" rx="1.1"/>',
  captureFull: '<path d="M2 5.2V3.6A1.6 1.6 0 0 1 3.6 2h1.6M10.8 2h1.6A1.6 1.6 0 0 1 14 3.6v1.6M14 10.8v1.6a1.6 1.6 0 0 1-1.6 1.6h-1.6M5.2 14H3.6A1.6 1.6 0 0 1 2 12.4v-1.6"/><path d="M8 4.8v6.2M5.8 8.8 8 11l2.2-2.2"/>',
  /* La ventanita: la pantalla con una más chica en su esquina, rellena para
     que se lea a 14 px. Volver a la pestaña: la flecha entra de la esquina
     hacia la pantalla grande. Los saltos de diez segundos, una vuelta
     abierta (el número va en HTML, al medio). */
  pip: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><rect x="7.9" y="7.9" width="4.3" height="3.3" rx=".8" fill="currentColor" stroke="none"/>',
  pipBack: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M11.2 10.6 6.3 5.9M6.1 8.9V5.7h3.2"/>',
  skipBack: '<path d="M3.1 8a4.9 4.9 0 1 0 1.5-3.5"/><path d="M4.3 1.9v2.8h2.8"/>',
  skipFwd: '<path d="M12.9 8a4.9 4.9 0 1 1-1.5-3.5"/><path d="M11.7 1.9v2.8H8.9"/>',
  camera: '<rect x="1.6" y="4" width="9.2" height="8" rx="1.8"/><path d="M10.8 7 14.4 4.8v6.4L10.8 9z"/>',
  mic: '<rect x="5.8" y="1.8" width="4.4" height="7.6" rx="2.2"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2"/>',
  location: '<path d="M8 14.2s4.6-4 4.6-7.4a4.6 4.6 0 0 0-9.2 0c0 3.4 4.6 7.4 4.6 7.4z"/><circle cx="8" cy="6.8" r="1.7"/>',
  screen: '<rect x="1.6" y="2.4" width="12.8" height="8.8" rx="1.6"/><path d="M5.6 13.8h4.8M8 11.2v2.6"/>',
  window: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8"/><path d="M1.8 5.6h12.4"/><circle cx="4" cy="4.1" r=".55" fill="currentColor" stroke="none"/><circle cx="5.8" cy="4.1" r=".55" fill="currentColor" stroke="none"/>',
  wifiOff: '<path d="M1.6 5.9a9.6 9.6 0 0 1 3-1.8M7.2 3.6a9.6 9.6 0 0 1 7.2 2.3M3.8 8.3a6.4 6.4 0 0 1 2.4-1.3M10.3 7.2a6.4 6.4 0 0 1 1.9 1.1M6 10.7a3.2 3.2 0 0 1 4 0"/><circle cx="8" cy="13" r=".8" fill="currentColor" stroke="none"/><path d="M2.4 2.2l11.2 11.2"/>',
  broken: '<path d="M3.6 2.2h5.6l3.2 3.2v3.1"/><path d="M9.2 2.2v3.2h3.2"/><path d="M3.6 2.2v11.6h3.2l1.4-2 1.4 1.6 1.4-1.8 1.4 2.2"/>',
  folderOpen: '<path d="M2 12.4V4.2a1.4 1.4 0 0 1 1.4-1.4h2.4l1.4 1.8h4.4a1.4 1.4 0 0 1 1.4 1.4v1.2"/><path d="M2 12.4l1.8-5a1.2 1.2 0 0 1 1.1-.8h8.9a.8.8 0 0 1 .8 1.1l-1.7 4.7z"/>',
  resume: '<path d="M5.6 3.4 12.6 8l-7 4.6z"/>',
  archive: '<rect x="1.8" y="2.4" width="12.4" height="3.4" rx="1.1"/><path d="M3 5.8v6.6a1.4 1.4 0 0 0 1.4 1.4h7.2a1.4 1.4 0 0 0 1.4-1.4V5.8M6.4 8.6h3.2"/>',
  video: '<rect x="1.8" y="3" width="12.4" height="10" rx="2"/><path d="M6.6 5.8 10.2 8l-3.6 2.2z"/>',
  music: '<path d="M6 12.2V3.4l7.2-1.4v8.6"/><circle cx="4.2" cy="12.2" r="1.8"/><circle cx="11.4" cy="10.6" r="1.8"/>',
  sparkle: '<path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4M3.7 3.7l2.2 2.2M10.1 10.1l2.2 2.2M12.3 3.7l-2.2 2.2M5.9 10.1l-2.2 2.2"/>',
  moon: '<path d="M13.4 9.6A5.6 5.6 0 0 1 6.4 2.6a5.6 5.6 0 1 0 7 7z"/>',
  keyboard: '<rect x="1.4" y="3.6" width="13.2" height="8.8" rx="1.8"/><path d="M4 6.4h.01M6.7 6.4h.01M9.3 6.4h.01M12 6.4h.01M4 9.6h8"/>',
  pdf: '<path d="M9.2 1.9H5A1.8 1.8 0 0 0 3.2 3.7v8.6A1.8 1.8 0 0 0 5 14.1h6a1.8 1.8 0 0 0 1.8-1.8V5.5z"/><path d="M9.2 1.9v3.6h3.6M5.8 11.2h4.4M5.8 8.8h2.4"/>',
  zipFile: '<path d="M9.2 1.9H5A1.8 1.8 0 0 0 3.2 3.7v8.6A1.8 1.8 0 0 0 5 14.1h6a1.8 1.8 0 0 0 1.8-1.8V5.5z"/><path d="M9.2 1.9v3.6h3.6M7 4.2h1M7 6.2h1M7 8.2h1"/><rect x="6.3" y="9.8" width="2.4" height="2" rx=".6"/>',
  appFile: '<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.2"/><path d="M5.4 8 7.3 9.9 10.8 6.2"/>',
  splitView: '<rect x="1.6" y="2.8" width="5.6" height="10.4" rx="1.6"/><rect x="8.8" y="2.8" width="5.6" height="10.4" rx="1.6"/>',
  unsplit: '<rect x="2.4" y="2.8" width="11.2" height="10.4" rx="2"/><path d="M8 5.4v5.2" stroke-dasharray="1.2 1.6"/>',
  swap: '<path d="M2.6 5.4h10.4M10.6 3 13 5.4l-2.4 2.4M13.4 10.6H3M5.4 8.2 3 10.6 5.4 13"/>',
  /* La calculadora de la fila de una cuenta en la barra (calc.cjs): el
     visor como una raya y seis teclas como puntos. La conversión usa `swap`. */
  calc: '<rect x="3" y="1.8" width="10" height="12.4" rx="2"/><path d="M5.6 4.8h4.8"/>'
    + '<circle cx="5.9" cy="8.4" r=".75" fill="currentColor" stroke="none"/><circle cx="8" cy="8.4" r=".75" fill="currentColor" stroke="none"/><circle cx="10.1" cy="8.4" r=".75" fill="currentColor" stroke="none"/>'
    + '<circle cx="5.9" cy="11.2" r=".75" fill="currentColor" stroke="none"/><circle cx="8" cy="11.2" r=".75" fill="currentColor" stroke="none"/><circle cx="10.1" cy="11.2" r=".75" fill="currentColor" stroke="none"/>',
  /* La llave del gestor de contraseñas, de contorno continuo: el ojo y el eje
     con su diente son una sola silueta, sin palito (la `key` de Opal es
     horizontal y de trazos sueltos). Se dibuja acostada, con el ojo a la
     derecha y el agujero hacia la punta, y rotate(-45) la pone en diagonal. */
  passKey: '<g transform="rotate(-45 8 8)"><path d="M8.31 6.6H1.9V9.4H3.2V11H5.8V9.4H8.31A3.3 3.3 0 1 0 8.31 6.6Z"/><circle cx="12.3" cy="8" r="1" fill="currentColor" stroke="none"/></g>',
  /* La tarjeta: el plástico con su banda y el renglón del número. */
  card: '<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.8"/><path d="M1.8 6.6h12.4M4.4 10.1h2.8"/>',
  /* El código de doble factor: un cronómetro (el código vale mientras corre). */
  otp: '<circle cx="8" cy="9.1" r="5"/><path d="M6.5 1.9h3M8 1.9v2.2M8 6.6v2.5l1.7 1.1M12.1 4.6l.9-.9"/>',
  /* Leer un QR: el de Tessera, tres ojos y dos módulos. */
  qr: '<rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.1"/><rect x="9" y="2.2" width="4.8" height="4.8" rx="1.1"/><rect x="2.2" y="9" width="4.8" height="4.8" rx="1.1"/><path d="M9.2 9.2h2v2h-2zM11.8 11.8h2v2h-2z"/>',
  clipboard: '<path d="M6.2 2.4h3.6a1 1 0 0 1 1 1v.9H5.2v-.9a1 1 0 0 1 1-1z"/><path d="M4.6 3.7H4.2a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7.6a1.3 1.3 0 0 0 1.3-1.3V5a1.3 1.3 0 0 0-1.3-1.3h-.4"/><path d="M5.8 8.2h4.4M5.8 10.6h3"/>',
  mail: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.8"/><path d="M2.2 4.4 8 8.6l5.8-4.2"/>',
  note: '<path d="M13.4 9.4V3.8a1.4 1.4 0 0 0-1.4-1.4H4a1.4 1.4 0 0 0-1.4 1.4v8.4A1.4 1.4 0 0 0 4 13.6h5.6z"/><path d="M13.4 9.4H10.4a1 1 0 0 0-1 1v3.2M5.2 5.8h5.6M5.2 8.2h3"/>',
  wand: '<path d="M2.4 13.6 10.2 5.8M8.9 4.5l2.6 2.6"/><path d="M12.2 1.8v2.4M11 3h2.4M13.8 6.4v1.8M12.9 7.3h1.8M5.8 1.8v1.8M4.9 2.7h1.8"/>',
  exit: '<path d="M6.2 13.8H3.6a1.4 1.4 0 0 1-1.4-1.4V3.6a1.4 1.4 0 0 1 1.4-1.4h2.6M10.4 11.2 13.6 8l-3.2-3.2M13.6 8H6.2"/>',
});

export { Icons };
