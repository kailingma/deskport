import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import express from 'express';

// The web page and the browser libraries it loads. Optional: a host started
// with DESKPORT_UI=0 serves only the API and the WebSockets.
//
// Every file the page loads, its own and the vendored libraries, is served from
// memory under /v/<content hash>/, cached by the browser for good, and
// precompressed with brotli and gzip. The page itself is never cached, and it
// lists every script as a modulepreload, so a load costs the page's own round
// trip plus one more for everything else, instead of one per level of imports.

const VENDOR = {
  'vendor/guacamole-common.js': 'node_modules/guacamole-common-js/dist/esm/guacamole-common.min.js',
  'vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  'vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  'vendor/addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
  'vendor/addon-webgl.mjs': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
  'vendor/inter.woff2': 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'vendor/jetbrains-mono.woff2': 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  'vendor/ibm-plex-mono-400.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  'vendor/ibm-plex-mono-600.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
};

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
};
const TEXT = new Set(['.js', '.mjs', '.css', '.svg', '.webmanifest', '.html']);
// Absolute references to vendored files in scripts, styles and the page.
const VENDOR_REF = /(["'(])\/vendor\//g;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Reads every page file and vendored file into memory, keyed by its path under /v/<hash>/. */
function readAssets(root) {
  const publicDir = path.join(root, 'web');
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file, `${prefix}${name}/`);
      else if (`${prefix}${name}` !== 'index.html') files.set(`${prefix}${name}`, fs.readFileSync(file));
    }
  };
  walk(publicDir, '');
  for (const [name, file] of Object.entries(VENDOR)) files.set(name, fs.readFileSync(path.join(root, file)));

  const hash = crypto.createHash('sha1');
  for (const [name, body] of files) hash.update(name).update(body);
  const version = hash.digest('hex').slice(0, 12);
  const prefix = `/v/${version}/`;

  const assets = new Map();
  for (const [name, raw] of files) {
    const ext = path.extname(name);
    const body = TEXT.has(ext) ? Buffer.from(raw.toString('utf8').replace(VENDOR_REF, `$1${prefix}vendor/`)) : raw;
    assets.set(name, { body, type: TYPES[ext] || 'application/octet-stream', etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`, text: TEXT.has(ext) });
  }
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  return { version, prefix, assets, html: renderIndex(html, prefix, [...assets.keys()]) };
}

function renderIndex(html, prefix, names) {
  const scripts = names.filter((n) => /\.m?js$/.test(n) && n !== 'theme-init.js');
  const preloads = scripts.map((n) => `  <link rel="modulepreload" href="${prefix}${n}">`).join('\n');
  return html
    .replace(/(href|src)="\/(style\.css|app\.js|theme-init\.js)"/g, `$1="${prefix}$2"`)
    .replace(VENDOR_REF, `$1${prefix}vendor/`)
    .replace('</head>', `${preloads}\n</head>`);
}

async function compressAll(assets, log) {
  for (const a of assets.values()) {
    if (!a.text || a.body.length < 1024) continue;
    a.br = await brotli(a.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: a.body.length } });
    a.gz = await gzip(a.body, { level: 9 });
  }
  log?.('ui: page files compressed');
}

function encodingFor(req, a) {
  const accept = req.headers['accept-encoding'] || '';
  if (a.br && /\bbr\b/.test(accept)) return ['br', a.br];
  if (a.gz && /\bgzip\b/.test(accept)) return ['gzip', a.gz];
  return [null, a.body];
}

/**
 * @param {object} opts
 * @param {string} opts.root  the repository root
 * @param {boolean} opts.dev  rebuild on every request (files change under a dev server)
 * @param {(msg: string) => void} [opts.log]
 */
export function createUi({ root, dev, log }) {
  const ui = express.Router();
  let built = readAssets(root);
  // Files go out uncompressed until this finishes (about a second after start).
  ui.ready = dev ? Promise.resolve() : compressAll(built.assets, log).catch((err) => log?.(`ui: compression failed: ${err.message}`));
  const current = () => (dev ? (built = readAssets(root)) : built);

  const page = (req, res) => {
    const { html } = current();
    res.set({ 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' }).type('html').send(html);
  };
  ui.get(['/', '/index.html'], page);

  const serve = (a, req, res, cache) => {
    const [encoding, body] = encodingFor(req, a);
    res.set({ 'Content-Type': a.type, 'Cache-Control': cache, ETag: a.etag, Vary: 'Accept-Encoding' });
    if (encoding) res.set('Content-Encoding', encoding);
    if (req.headers['if-none-match'] === a.etag) return res.status(304).end();
    res.send(body);
  };

  ui.get('/v/:version/*path', (req, res, next) => {
    const { version, assets } = current();
    const a = assets.get([].concat(req.params.path).join('/'));
    if (!a) return next();
    // Pages from an earlier deploy may still ask for their own version; they get
    // today's file, uncached, rather than a 404.
    const cache = !dev && req.params.version === version ? 'public, max-age=31536000, immutable' : 'no-cache';
    serve(a, req, res, cache);
  });

  // Unversioned paths: icons, the manifest, and files linked by older pages.
  ui.get(['/vendor/*path', '/*path'], (req, res, next) => {
    const a = current().assets.get(req.path.slice(1));
    if (!a) return next();
    serve(a, req, res, 'no-cache');
  });

  return ui;
}
