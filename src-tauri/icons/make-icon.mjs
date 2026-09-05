/**
 * The application icon, drawn rather than downloaded — Phase 5 T6.
 *
 * `tauri init` seeds Tauri's own logo, and T1 §6 named that as a thing T6 has
 * to fix. This produces the ONE source image (`source.png`, 1024x1024 RGBA)
 * that `pnpm exec tauri icon src-tauri/icons/source.png` then fans out into
 * every `.png` size and the `.ico`.
 *
 * The design constraint is the 16x16 taskbar cell, not the 1024x1024 preview,
 * so there are exactly four shapes: a rounded square, a darker screen inside
 * it, two eyes, and a mouth. That is the OLED face the firmware actually draws
 * — `apps/web/src/generated/face-bitmaps.ts` — reduced to what survives being
 * four pixels tall. Anything finer disappears at 16 px and only muddies it.
 *
 * Colours are the app's own tokens from `apps/web/src/styles.css`:
 *   --panel-2 #1b212b   the body
 *   --bg      #0d1015   the screen
 *   --accent  #6e9ee6   the bezel
 *   --observed #4ec9a0  the face
 *
 * No dependencies: `node:zlib` deflates the pixels and the CRCs are eight
 * lines. Rendering is 4x supersampled and box-filtered down, which is the whole
 * of the anti-aliasing.
 *
 *   node src-tauri/icons/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SIZE = 1024;
const SS = 4; // supersample factor
const W = SIZE * SS;

const BODY = [0x1b, 0x21, 0x2b];
const SCREEN = [0x0d, 0x10, 0x15];
const BEZEL = [0x6e, 0x9e, 0xe6];
const FACE = [0x4e, 0xc9, 0xa0];

/** Signed distance to a rounded rectangle, in supersampled pixels. */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function circle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

const S = (v) => v * SS; // logical (1024-space) -> supersampled

// One draw call per shape, painted back to front. `inside` is a predicate in
// supersampled coordinates; the caller supplies the colour.
const shapes = [
  // the body, with the bezel as a ring around it
  { color: BEZEL, inside: (x, y) => roundedRect(x, y, W / 2, W / 2, S(448), S(448), S(120)) <= 0 },
  { color: BODY, inside: (x, y) => roundedRect(x, y, W / 2, W / 2, S(424), S(424), S(100)) <= 0 },
  // the screen
  { color: SCREEN, inside: (x, y) => roundedRect(x, y, W / 2, W / 2, S(336), S(336), S(64)) <= 0 },
  // two eyes — the only thing that has to survive 16 px
  { color: FACE, inside: (x, y) => circle(x, y, S(390), S(452), S(88)) <= 0 },
  { color: FACE, inside: (x, y) => circle(x, y, S(634), S(452), S(88)) <= 0 },
  // the mouth: a thick bar, not an arc. An arc is one pixel of nothing at 16 px.
  { color: FACE, inside: (x, y) => roundedRect(x, y, W / 2, S(660), S(150), S(38), S(38)) <= 0 },
];

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const x = px * SS + sx + 0.5;
        const y = py * SS + sy + 0.5;
        let hit = null;
        for (const shape of shapes) if (shape.inside(x, y)) hit = shape.color;
        if (hit !== null) {
          r += hit[0];
          g += hit[1];
          b += hit[2];
          a += 255;
        }
      }
    }
    const n = SS * SS;
    const i = (py * SIZE + px) * 4;
    // premultiplied average -> straight alpha, so the edge pixels are the shape
    // colour at partial opacity rather than the shape colour blended with black
    const cov = a / n;
    rgba[i] = cov === 0 ? 0 : Math.round(r / (a / 255));
    rgba[i + 1] = cov === 0 ? 0 : Math.round(g / (a / 255));
    rgba[i + 2] = cov === 0 ? 0 : Math.round(b / (a / 255));
    rgba[i + 3] = Math.round(cov);
  }
}

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'source.png');
writeFileSync(out, png);
process.stdout.write(`${out} ${String(png.length)} bytes ${SIZE}x${SIZE}\n`);
