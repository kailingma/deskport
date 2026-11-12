import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// The web page and the browser libraries it loads. Optional: a host started
// with DESKPORT_UI=0 serves only the API and the WebSockets.

const VENDOR = {
  '/vendor/guacamole-common.js': 'node_modules/guacamole-common-js/dist/esm/guacamole-common.min.js',
  '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
  '/vendor/inter.woff2': 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  '/vendor/jetbrains-mono.woff2': 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  '/vendor/ibm-plex-mono-400.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  '/vendor/ibm-plex-mono-600.woff2': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
};

function assetVersion(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else hash.update(name).update(fs.readFileSync(file));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/**
 * @param {object} opts
 * @param {string} opts.root  the repository root
 * @param {boolean} opts.dev  rebuild the page on every request (files change under a dev server)
 */
export function createUi({ root, dev }) {
  const ui = express.Router();
  const publicDir = path.join(root, 'public');

  for (const [route, file] of Object.entries(VENDOR)) {
    ui.get(route, (req, res) => res.sendFile(path.join(root, file), { maxAge: '1d' }));
  }

  // Page assets are served under /v/<content hash>/ so a deploy can never mix a
  // new page with cached old CSS or JS (iOS home-screen apps cache aggressively).
  // Relative imports inside app.js resolve under the same prefix.
  const renderIndex = (version) => fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(/(href|src)="\/(style\.css|app\.js|theme-init\.js)"/g, `$1="/v/${version}/$2"`);
  const staticVersion = dev ? null : assetVersion(publicDir);
  const staticIndex = staticVersion && renderIndex(staticVersion);

  ui.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(staticIndex ?? renderIndex('dev'));
  });
  ui.use('/v/:version', express.static(publicDir, {
    index: false,
    ...(staticVersion ? { immutable: true, maxAge: '365d' } : { setHeaders: (r) => r.set('Cache-Control', 'no-cache') }),
  }));
  ui.use(express.static(publicDir, { index: false, setHeaders: (r) => r.set('Cache-Control', 'no-cache') }));

  return ui;
}
