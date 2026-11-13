import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createUi } from '../hub/ui.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function serve() {
  const ui = createUi({ root, dev: false });
  await ui.ready;
  const app = express().use(ui);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('the page preloads every module under one content-hash prefix', async () => {
  const { base, close } = await serve();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const html = await res.text();
    const prefix = /src="(\/v\/[0-9a-f]{12}\/)app\.js"/.exec(html)?.[1];
    assert.ok(prefix, 'app.js is versioned');
    for (const m of ['app.js', 'js/terminal.js', 'vendor/xterm.mjs', 'vendor/guacamole-common.js']) {
      assert.match(html, new RegExp(`rel="modulepreload" href="${prefix}${m}"`));
    }
    assert.doesNotMatch(html, /"\/vendor\//);
  } finally {
    close();
  }
});

test('versioned files are immutable, compressed, and point at versioned libraries', async () => {
  const { base, close } = await serve();
  try {
    const html = await (await fetch(`${base}/`)).text();
    const prefix = /src="(\/v\/[0-9a-f]{12}\/)app\.js"/.exec(html)[1];
    const res = await fetch(`${base}${prefix}js/terminal.js`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-encoding'), 'br');
    // fetch decodes br itself; check the body names versioned vendor paths.
    const js = await res.text();
    assert.match(js, new RegExp(`from '${prefix}vendor/xterm\\.mjs'`));

    const raw = await fetch(`${base}${prefix}vendor/xterm.mjs`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(raw.headers.get('content-encoding'), null);
    const etag = raw.headers.get('etag');
    const again = await fetch(`${base}${prefix}vendor/xterm.mjs`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);

    const old = await fetch(`${base}/v/000000000000/app.js`);
    assert.equal(old.status, 200);
    assert.equal(old.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${base}${prefix}missing.js`)).status, 404);
  } finally {
    close();
  }
});

test('brotli output decodes to the served file', async () => {
  const { base, close } = await serve();
  try {
    const html = await (await fetch(`${base}/`)).text();
    const prefix = /src="(\/v\/[0-9a-f]{12}\/)app\.js"/.exec(html)[1];
    const url = `${base}${prefix}vendor/xterm.mjs`;
    const plain = Buffer.from(await (await fetch(url, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer());
    const { request } = await import('node:http');
    const br = await new Promise((resolve, reject) => {
      request(url, { headers: { 'accept-encoding': 'br' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject).end();
    });
    assert.ok(br.length < plain.length / 3, `brotli ${br.length} vs ${plain.length}`);
    assert.deepEqual(zlib.brotliDecompressSync(br), plain);
  } finally {
    close();
  }
});
