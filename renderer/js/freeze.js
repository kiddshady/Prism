/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — el congelado
   La vista de una página es nativa y tapa todo lo que el DOM dibuje en su
   rectángulo, sin importar el z-index. Un menú que cae sobre la página
   quedaría DEBAJO de ella.

   La salida: antes de abrir un overlay se le saca una foto a la página, se la
   pinta en el DOM exactamente donde estaba, y recién entonces se esconde la
   vista. Para el ojo no cambia nada — y el overlay flota sobre una imagen
   que SÍ está en el DOM, así que su vidrio la esmerila de verdad.

   Es un contador: dos overlays a la vez (un select adentro de un modal)
   congelan una sola vez y descongelan cuando se va el último. Todo pasa por
   una cadena de promesas para que un "descongelar" no se adelante a un
   "congelar" que todavía está sacando la foto.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api } from './state.js';
import { raf2 } from './motion.js';

let count = 0;
let frozen = false;
let chain = Promise.resolve();

// Una foto por hoja: con vista dividida se congelan las dos mitades.
const imgs = () => [document.getElementById('freeze'), document.getElementById('freeze-2')].filter(Boolean);

/**
 * Congela la página y devuelve la función que la libera.
 *   const release = await hold();
 *   … overlay …
 *   release();
 */
export function hold() {
  count += 1;
  const ready = (chain = chain.then(async () => {
    if (!count || frozen) return;
    const shots = await api.page.snapshot().catch(() => []);
    const put = (shots || []).map(({ slot, url }) => ({ el: imgs()[slot], url })).filter((x) => x.el && x.url);
    if (put.length) {
      await Promise.all(put.map(async ({ el, url }) => {
        el.src = url;
        try { await el.decode(); } catch { /* una foto rota no frena el overlay */ }
      }));
      put.forEach(({ el }) => el.classList.add('is-on'));
      /* La vista se corre recién cuando la foto YA está en pantalla. Sin esta
         espera, el proceso principal la retiraba antes de que el cromo pintara
         la foto, y quedaba un frame con la hoja vacía: el pestañeo al abrir
         un menú. Dos frames, con un tope por si la ventana no está pintando. */
      await Promise.race([new Promise((r) => raf2(r)), new Promise((r) => setTimeout(r, 80))]);
    }
    await api.page.hold(true).catch(() => {});
    frozen = true;
  }));

  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    count = Math.max(0, count - 1);
    if (!count) thaw();
  };
  return ready.then(() => release);
}

function thaw() {
  chain = chain.then(async () => {
    if (count || !frozen) return;
    await api.page.hold(false).catch(() => {});
    frozen = false;
    // La vista vuelve ENCIMA de la foto; recién un par de frames después se
    // saca la foto, así no queda un instante de hueco entre las dos.
    await new Promise((r) => raf2(r));
    await new Promise((r) => setTimeout(r, 30));
    if (!count) {
      for (const el of imgs()) {
        el.classList.remove('is-on');
        el.removeAttribute('src');
      }
    }
  });
}

/** Libera después de que la salida del overlay haya terminado de verse. */
export function releaseAfter(release, ms = 140) {
  setTimeout(release, ms);
}

export const isFrozen = () => frozen;

/** Al arrancar (o si la interfaz se recargó a mitad de un overlay). */
export function reset() {
  count = 0;
  frozen = false;
  api.page.hold(false).catch(() => {});
  imgs().forEach((el) => el.classList.remove('is-on'));
}

/** Para depurar desde la consola (o por CDP): cuántos overlays lo sostienen. */
export const debug = () => ({ count, frozen, img: imgs().some((el) => el.classList.contains('is-on')) });
