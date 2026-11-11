// Renders the app icons in public/icons/ from the same geometry as public/favicon.svg.
// No dependencies: a small supersampled rasteriser and PNG encoder.
// Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

// Gradient ends, top-left to bottom-right, and the glyph colour.
const BG_A = [61, 123, 255];
const BG_B = [23, 57, 196];
const FG = [255, 255, 255];

// Glyph in a 32-unit box, matching public/favicon.svg: a "d" whose bowl is a screen,
// with a text cursor inside.
const STROKE = 2.6;
const bowl = { x: 8.5, y: 12.5, w: 14.5, h: 12, r: 3 };
const stem = [23, 6.5, 23, 24.5];
const cursor = { x: 12, y: 16, w: 3.2, h: 5, r: 0.8 };

function distSeg(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/** Signed distance to a rounded rectangle (negative inside). */
function sdRoundRect(px, py, { x, y, w, h, r }) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function inGlyph(gx, gy) {
  return Math.abs(sdRoundRect(gx, gy, bowl)) <= STROKE / 2
    || distSeg(gx, gy, stem) <= STROKE / 2
    || sdRoundRect(gx, gy, cursor) <= 0;
}

function render(size, glyphScale) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  const unit = (size * glyphScale) / 32;
  const off = (size - 32 * unit) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        if (inGlyph((x + (sx + 0.5) / ss - off) / unit, (y + (sy + 0.5) / ss - off) / unit)) cover++;
      }
      const a = cover / (ss * ss);
      const t = (x + y) / (2 * size);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const bg = BG_A[c] * (1 - t) + BG_B[c] * t;
        px[i + c] = Math.round(bg * (1 - a) + FG[c] * a);
      }
      px[i + 3] = 255;
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/icons/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
// Full-bleed squares: iOS and maskable Android icons apply their own corner mask.
// The glyph fills the same share of the square as in the favicon; maskable icons get extra margin.
for (const [name, size, scale] of [['apple-touch-icon.png', 180, 1], ['icon-192.png', 192, 0.8], ['icon-512.png', 512, 0.8]]) {
  fs.writeFileSync(new URL(name, out), render(size, scale));
  console.log(`wrote public/icons/${name}`);
}
