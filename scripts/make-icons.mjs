// Renders the app icons in public/icons/ from the same geometry as public/favicon.svg.
// No dependencies: a small supersampled rasteriser and PNG encoder.
// Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [36, 99, 235];   // brand blue, close to oklch(0.55 0.19 260)
const FG = [255, 255, 255];

// Glyph in a 24-unit box (matches the i-monitor symbol), scaled into the icon's safe zone.
const segs = [[8, 20.5, 16, 20.5], [12, 16.5, 12, 20.5]];
const screenRect = { x: 2.5, y: 3.5, w: 19, h: 13, r: 2 };
const STROKE = 2;

function distSeg(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function distRoundRectEdge(px, py, { x, y, w, h, r }) {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r), qy = Math.abs(py - cy) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return Math.abs(outside + inside - r);
}
function inGlyph(gx, gy) {
  if (distRoundRectEdge(gx, gy, screenRect) <= STROKE / 2) return true;
  return segs.some((s) => distSeg(gx, gy, s) <= STROKE / 2);
}

function render(size, glyphScale) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  const unit = (size * glyphScale) / 24;
  const off = (size - 24 * unit) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const gx = (x + (sx + 0.5) / ss - off) / unit;
        const gy = (y + (sy + 0.5) / ss - off) / unit + 0.5;
        if (inGlyph(gx, gy)) cover++;
      }
      const a = cover / (ss * ss);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
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
for (const [name, size, scale] of [['apple-touch-icon.png', 180, 0.56], ['icon-192.png', 192, 0.5], ['icon-512.png', 512, 0.5]]) {
  fs.writeFileSync(new URL(name, out), render(size, scale));
  console.log(`wrote public/icons/${name}`);
}
