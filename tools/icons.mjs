/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — el ícono, horneado desde el código
   La marca facetada (el prisma visto como gema: tres caras que reciben luz
   distinta) sobre la baldosa de Opal: a sangre, sin borde, esquinas al 19 %.

   Acromático, con la escalera de grises de Finway (#e9ebee → #a4a9b0 →
   #6e737b): un degradé en diagonal, con la luz entrando de arriba a la
   izquierda, que cruza las tres caras. Cada cara, además, se apaga un escalón
   (izquierda, derecha, base), la misma luz que tiene el prisma de la
   interfaz. El degradé no llega al gris más oscuro: a 32 px un gris de más
   se apaga al lado de los vecinos. Las caras las separa una costura del color
   de la baldosa — la luz talla, no rellena. (Hasta el 26 sep 2026 las caras
   iban en ámbar, cian y violeta.)

   Geometría con distancia con signo y supermuestreo: cada tamaño se dibuja a
   SU tamaño. La costura tiene un piso de ~1 px real para no empastarse en la
   bandeja (16–32 px).

   `npm run icons` regenera build/icon.ico, icon.png y tray.ico, y deja la hoja
   de control en .shots/icons.png.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.mjs';
import { encodeICO } from './ico.mjs';
import { oklchToHex } from './oklch.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');

/* ── Color: los tokens de la app ─────────────────────────────────────────── */

const css = fs.readFileSync(path.join(ROOT, 'renderer/css/tokens.css'), 'utf8');
const num = (re, what) => {
  const m = css.match(re);
  if (!m) throw new Error(`tokens.css: no encontré ${what}`);
  return m.slice(1).map(Number);
};
const [HUE] = num(/--op-hue:\s*([\d.]+)/, '--op-hue');
const [TINT] = num(/--op-tint:\s*([\d.]+)/, '--op-tint');
const token = (name) => {
  const [L, C] = num(new RegExp(`--op-${name}:\\s*oklch\\(([\\d.]+)%\\s+calc\\(([\\d.]+)\\s*\\*\\s*var\\(--op-tint\\)\\)`), `--op-${name}`);
  const hex = oklchToHex(L / 100, C * TINT, HUE);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
};
const mix = (a, b, k) => a.map((v, i) => Math.round(v * (1 - k) + b[i] * k));

const BG = token('bg');
const [S1] = num(/--op-s1:\s*rgb\(255 255 255 \/ (\.\d+)\)/, '--op-s1');
const TILE = mix(BG, [255, 255, 255], S1);
const HI = [233, 235, 238];
const MID = [164, 169, 176];
const LO = [110, 115, 123];
const SHADE = [0, 0.1, 0.24];            // cuánto se apaga hacia la baldosa: izquierda · derecha · base

/* El degradé recorre la gema en diagonal (dirección 1,1) y termina en el 80 %
   de la escalera, entre el gris medio y el oscuro. */
function paint(f, u, v, g) {
  const t = Math.max(0, Math.min(1, (u - g.left + v - g.top) / (g.right - g.left + g.bot - g.top)));
  const s = t * 0.8;
  const col = s < 0.5 ? mix(HI, MID, s * 2) : mix(MID, LO, (s - 0.5) * 2);
  return mix(col, TILE, SHADE[f]);
}

/* ── La gema ─────────────────────────────────────────────────────────────── */

const TILE_R = 0.19;

function sdTile(u, v) {
  const qx = Math.abs(u - 0.5) - (0.5 - TILE_R);
  const qy = Math.abs(v - 0.5) - (0.5 - TILE_R);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - TILE_R;
}

function dSeg(u, v, [ax, ay], [bx, by]) {
  const px = u - ax; const py = v - ay; const dx = bx - ax; const dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h);
}

/** Distancia con signo al triángulo (negativa adentro). */
function sdTri(u, v, a, b, c) {
  const d = Math.min(dSeg(u, v, a, b), dSeg(u, v, b, c), dSeg(u, v, c, a));
  const cross = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const P = [u, v];
  const d1 = cross(P, a, b); const d2 = cross(P, b, c); const d3 = cross(P, c, a);
  const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  return inside ? -d : d;
}

/* El triángulo equilátero, con su caja centrada en el lienzo. `span` es el
   ALTO del dibujo sobre el lienzo (el ancho sale 1,15 veces más). */
function layout(size) {
  const tray = size < 48;
  const span = tray ? 0.66 : 0.56;
  const r = span / 1.5;                    // centro → vértice
  const cy = 0.5 + r / 4;                  // el centroide queda abajo del centro de la caja
  const ang = (deg) => [0.5 + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const seam = Math.max(tray ? 0.075 : 0.034, 1.05 / size);
  const A = ang(-90); const B = ang(30); const D = ang(150);
  return { A, B, D, C: [0.5, cy], seam, top: A[1], bot: B[1], left: D[0], right: B[0] };
}

/** Qué cara pinta en (u,v): 0 izquierda, 1 derecha, 2 base, o null. */
function sample(g, u, v) {
  if (sdTri(u, v, g.A, g.B, g.D) > 0) return null;
  // Costuras: del centro a cada vértice.
  for (const p of [g.A, g.B, g.D]) if (dSeg(u, v, g.C, p) < g.seam / 2) return null;
  const ang = (Math.atan2(v - g.C[1], u - g.C[0]) * 180) / Math.PI;
  if (ang > -90 && ang <= 30) return 1;
  if (ang > 30 && ang <= 150) return 2;
  return 0;
}

function render(size) {
  const g = layout(size);
  const N = size <= 64 ? 8 : 5;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      const acc = [0, 0, 0];
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const u = (px + (sx + 0.5) / N) / size;
          const v = (py + (sy + 0.5) / N) / size;
          if (sdTile(u, v) > 0) continue;
          tile++;
          const f = sample(g, u, v);
          const col = f == null ? TILE : paint(f, u, v, g);
          acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2];
        }
      }
      if (!tile) continue;
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(acc[c] / tile);
      out[o + 3] = Math.round((tile / (N * N)) * 255);
    }
  }
  return out;
}

/* ── Hornear ─────────────────────────────────────────────────────────────── */

const ICO_SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16];
const images = new Map(ICO_SIZES.map((size) => [size, render(size)]));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO(ICO_SIZES.map((size) => ({ size, data: images.get(size) }))));
fs.writeFileSync(path.join(OUT, 'icon.png'), encodePNG(256, 256, images.get(256)));
// La bandeja: el mismo objeto, en los tamaños que Windows le pide a un tray
// (a 96 DPI se ve a 16 px; los grandes cubren el escalado).
const TRAY_SIZES = [32, 24, 20, 16];
fs.writeFileSync(path.join(OUT, 'tray.ico'), encodeICO(TRAY_SIZES.map((size) => ({ size, data: images.get(size) }))));

/* ── Hoja de control: 1:1 y los chicos ampliados por vecino más cercano, sobre
   la barra oscura y la clara de Windows 11. La comparación con los vecinos
   (Atlas, Pharos, Mnemus…) se arma aparte, con los PNG de cada app. ─────── */

function sheet() {
  const GAP = 16;
  const cells = [...ICO_SIZES.map((s) => ({ s, zoom: 1 })), { s: 16, zoom: 10 }, { s: 24, zoom: 8 }, { s: 32, zoom: 6 }];
  const W = cells.reduce((w, c) => w + c.s * c.zoom + GAP, GAP);
  const rowH = 256 + GAP * 2;
  const px = new Uint8Array(W * rowH * 2 * 4);
  [[32, 32, 32], [243, 243, 243]].forEach((bg, row) => {
    for (let y = row * rowH; y < (row + 1) * rowH; y++) {
      for (let x = 0; x < W; x++) px.set([...bg, 255], (y * W + x) * 4);
    }
    let x0 = GAP;
    for (const { s, zoom } of cells) {
      const img = images.get(s); const side = s * zoom;
      const y0 = (row * rowH + GAP + (256 - side) / 2) | 0;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const i = (((y / zoom) | 0) * s + ((x / zoom) | 0)) * 4; const a = img[i + 3] / 255;
          const o = ((y0 + y) * W + x0 + x) * 4;
          for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] * (1 - a) + img[i + c] * a);
        }
      }
      x0 += side + GAP;
    }
  });
  return encodePNG(W, rowH * 2, px);
}

fs.mkdirSync(path.join(ROOT, '.shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.shots/icons.png'), sheet());

const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1);
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
console.log(`baldosa ${hex(TILE)} · escalera ${[HI, MID, LO].map(hex).join(' ')}`);
console.log(`icon.ico  ${kb('icon.ico')} kB  (${ICO_SIZES.join(', ')})`);
console.log(`icon.png  ${kb('icon.png')} kB`);
console.log(`tray.ico  ${kb('tray.ico')} kB  (32, 24, 20, 16)`);
console.log('control: .shots/icons.png');
