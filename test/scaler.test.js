import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GuacParser, encode } from '../src/guac.js';
import { createScaler } from '../src/scaler.js';

function run(opts, input) {
  return new Promise((resolve) => {
    let out = '';
    const scaler = createScaler({ log: () => {}, target: { width: 1000, height: 1000 }, ...opts, send: (t) => { out += t; } });
    scaler.push(new GuacParser().push(input));
    setTimeout(() => resolve({ out: new GuacParser().push(out).map((i) => i.elements), scaler }), 200);
  });
}

test('scales coordinates and keeps adjacent spans adjacent', async () => {
  const { out } = await run({ scale: 0.5, quality: 'high' },
    encode(['size', '0', '3840', '2160']) + encode(['rect', '0', '1', '1', '3', '3']) + encode(['copy', '-1', '10', '20', '5', '7', '14', '0', '101', '33']));
  assert.deepEqual(out[0], ['size', '0', '1920', '1080']);
  // 1..4 maps to round(0.5)=1 .. round(2)=2
  assert.deepEqual(out[1], ['rect', '0', '1', '1', '1', '1']);
  assert.deepEqual(out[2], ['copy', '-1', '5', '10', '3', '4', '14', '0', '51', '17']);
});

test('auto picks a scale from the target once the desktop size arrives, holding earlier output', async () => {
  const { out } = await run({ scale: null, quality: 'high', target: { width: 1920, height: 2000 } },
    encode(['ready', 'x']) + encode(['size', '0', '3840', '2160']));
  assert.deepEqual(out[0], ['ready', 'x']);
  assert.deepEqual(out[1], ['size', '0', '1920', '1080']);
});

test('re-encodes and resizes images, in stream order', async () => {
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#336699' } }).png().toBuffer();
  const b64 = png.toString('base64');
  const { out } = await run({ scale: 0.5, quality: 'low' },
    encode(['size', '0', '100', '100']) + encode(['img', '3', '14', '0', 'image/png', '10', '10'])
    + encode(['blob', '3', b64]) + encode(['end', '3']) + encode(['sync', '1']));
  const img = out.find((e) => e[0] === 'img');
  assert.deepEqual(img, ['img', '3', '14', '0', 'image/webp', '5', '5']);
  const blob = out.find((e) => e[0] === 'blob');
  const meta = await sharp(Buffer.from(blob[2], 'base64')).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 10);
  assert.deepEqual(out.at(-1), ['sync', '1']);
});

test('maps browser mouse coordinates back to desktop pixels', async () => {
  const { scaler } = await run({ scale: 0.5, quality: 'high' }, encode(['size', '0', '100', '100']));
  assert.equal(scaler.mapInput(encode(['mouse', '10', '21', '1'])), encode(['mouse', '20', '42', '1']));
  assert.equal(scaler.mapInput(encode(['key', '65', '1'])), encode(['key', '65', '1']));
});

test('at full size, PNGs become lossless WebP with the same pixels and lossy images pass through', async () => {
  // Text-like content: PNG and WebP both compress it, WebP further.
  const raw = Buffer.alloc(120 * 40 * 3);
  for (let i = 0; i < raw.length; i += 3) raw[i] = raw[i + 1] = raw[i + 2] = ((i / 3) % 7 < 2 || (i / 360) % 5 < 1) ? 230 : 30;
  const png = await sharp(raw, { raw: { width: 120, height: 40, channels: 3 } }).png().toBuffer();
  const jpeg = 'abc'; // never decoded: lossy images are passed on untouched
  const { out } = await run({ scale: 1, quality: 'high' },
    encode(['size', '0', '1000', '1000'])
    + encode(['img', '1', '14', '0', 'image/png', '7', '9']) + encode(['blob', '1', png.toString('base64')]) + encode(['end', '1'])
    + encode(['img', '2', '14', '0', 'image/jpeg', '0', '0']) + encode(['blob', '2', jpeg]) + encode(['end', '2'])
    + encode(['rect', '0', '1', '2', '3', '4']));
  const imgs = out.filter((e) => e[0] === 'img');
  assert.deepEqual(imgs, [['img', '1', '14', '0', 'image/webp', '7', '9'], ['img', '2', '14', '0', 'image/jpeg', '0', '0']]);
  const blobs = out.filter((e) => e[0] === 'blob');
  const webp = Buffer.from(blobs[0][2], 'base64');
  assert.ok(webp.length < png.length, `webp ${webp.length} vs png ${png.length}`);
  const a = await sharp(webp).removeAlpha().raw().toBuffer();
  assert.deepEqual(a, raw);
  assert.deepEqual(blobs[1], ['blob', '2', jpeg]);
  assert.deepEqual(out.at(-1), ['rect', '0', '1', '2', '3', '4']);
});
