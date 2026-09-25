// Encoder ICO y remuestreo, también sin dependencias.
//
// Los tamaños chicos van como DIB/BMP 32bpp bottom-up — el formato que produce
// png-to-ico, o sea el ya probado con electron-builder y con el header del
// instalador NSIS, que se dibuja a ~32px.
//
// Los grandes (≥128) van como PNG embebido, que es lo que estandarizó Vista y lo
// que hace cualquier herramienta moderna. No es cosmético: **GDI+ no lee una
// entrada de 256 en DIB** (System.Drawing devuelve el 128 en su lugar), y ese
// tamaño sin comprimir pesa 262 KB él solo. Con PNG el ícono entero baja de
// 372 KB a unos 30 KB y los 256 se leen.

import { encodePNG } from './png.mjs';

/**
 * Remuestreo por área promedio (box filter).
 *
 * Con factor de ampliación ENTERO cada píxel destino cae dentro de uno solo del
 * origen, así que esto degenera exactamente en vecino-más-cercano y el pixel art
 * sale nítido. Con factores rotos (los tamaños chicos del ICO) promedia, que es
 * justo lo que hay que hacer ahí. Un solo camino para los dos casos.
 *
 * El promedio va en alfa premultiplicado: sin eso, los píxeles transparentes
 * arrastran su color al borde y el halo termina con una orla sucia.
 */
export function resample(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const kx = sw / dw;
  const ky = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = y * ky;
    const y1 = (y + 1) * ky;
    for (let x = 0; x < dw; x++) {
      const x0 = x * kx;
      const x1 = (x + 1) * kx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;

      for (let yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * w;
          g += src[i + 1] * al * w;
          b += src[i + 2] * al * w;
          a += src[i + 3] * w;
          wsum += w;
        }
      }

      const o = (y * dw + x) * 4;
      if (wsum > 0 && a > 0) {
        const alpha = a / wsum;              // 0..255
        const k = (alpha / 255) * wsum;      // peso premultiplicado acumulado
        out[o] = Math.round(r / k);
        out[o + 1] = Math.round(g / k);
        out[o + 2] = Math.round(b / k);
        out[o + 3] = Math.round(alpha);
      }
    }
  }
  return out;
}

/** Recorta al contenido (alfa > 0) y lo centra en un lienzo cuadrado. */
export function squareTrim(src, w, h, pad = 1) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { data: src, size: Math.max(w, h) };

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const size = Math.max(bw, bh) + pad * 2;
  const out = new Uint8Array(size * size * 4);
  const ox = Math.floor((size - bw) / 2);
  const oy = Math.floor((size - bh) / 2);

  for (let y = 0; y < bh; y++) {
    const s = ((minY + y) * w + minX) * 4;
    const d = ((oy + y) * size + ox) * 4;
    out.set(src.subarray(s, s + bw * 4), d);
  }
  return { data: out, size };
}

function dibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);        // biSize
  header.writeInt32LE(size, 4);       // biWidth
  header.writeInt32LE(size * 2, 8);   // biHeight = XOR + máscara AND
  header.writeUInt16LE(1, 12);        // biPlanes
  header.writeUInt16LE(32, 14);       // biBitCount
  header.writeUInt32LE(0, 16);        // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y; // el DIB va de abajo hacia arriba
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];     // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];     // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // Máscara AND en 1bpp, filas alineadas a 4 bytes. Va en cero (todo opaco): con
  // 32bpp manda el canal alfa, pero la estructura tiene que estar igual.
  const andStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(andStride * size);

  return Buffer.concat([header, xor, mask]);
}

const PNG_FROM = 128; // de acá para arriba, PNG embebido

/** @param {Array<{size:number, data:Uint8Array}>} images */
export function encodeICO(images) {
  const entries = images.map((img) => ({
    size: img.size,
    blob: img.size >= PNG_FROM
      ? encodePNG(img.size, img.size, img.data)
      : dibEntry(img.data, img.size),
  }));

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);              // tipo 1 = ícono
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const table = [];
  for (const e of entries) {
    const rec = Buffer.alloc(16);
    rec[0] = e.size >= 256 ? 0 : e.size; // 0 significa 256
    rec[1] = e.size >= 256 ? 0 : e.size;
    rec[2] = 0;                          // paleta
    rec[3] = 0;
    rec.writeUInt16LE(1, 4);             // planos
    rec.writeUInt16LE(32, 6);            // bpp
    rec.writeUInt32LE(e.blob.length, 8);
    rec.writeUInt32LE(offset, 12);
    table.push(rec);
    offset += e.blob.length;
  }

  return Buffer.concat([dir, ...table, ...entries.map((e) => e.blob)]);
}
