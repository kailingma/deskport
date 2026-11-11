import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { createAuthenticator, AuthError, sameOrigin } from './auth.js';
import { handleScreen } from './guac.js';
import { handleTerminal } from './terminal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`[deskport] ${msg}`);

const problems = validateConfig();
if (problems.length) {
  for (const p of problems) console.error(`[deskport] config: ${p}`);
  process.exit(1);
}
if (config.insecureDev) log('WARNING: DESKPORT_INSECURE_DEV=1, Cloudflare Access checks are OFF');

const authenticate = createAuthenticator(config);
const app = express();
app.disable('x-powered-by');

app.use(async (req, res, next) => {
  try {
    req.user = await authenticate(req);
    next();
  } catch (err) {
    if (!(err instanceof AuthError)) return next(err);
    log(`denied ${req.method} ${req.path}: ${err.message}`);
    res.status(403).type('text/plain').send('Forbidden: sign in through Cloudflare Access.');
  }
});

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
  });
  next();
});

app.get('/api/me', (req, res) => {
  res.json({ email: req.user.email, host: os.hostname(), dev: Boolean(req.user.dev) });
});


const vendor = {
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
for (const [route, file] of Object.entries(vendor)) {
  app.get(route, (req, res) => res.sendFile(path.join(root, file), { maxAge: '1d' }));
}

app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));

app.use((err, req, res, _next) => {
  log(`error: ${err.stack || err}`);
  res.status(500).type('text/plain').send('Internal error');
});

const server = http.createServer(app);
const screenWss = new WebSocketServer({
  noServer: true,
  // Screen updates are base64 images; fast deflate wins back most of the base64 overhead.
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
  handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false),
});
const termWss = new WebSocketServer({ noServer: true });

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target = pathname === '/ws/screen' ? screenWss : pathname === '/ws/term' ? termWss : null;
  if (!target) return reject(socket, 404, 'Not Found');
  if (!sameOrigin(req)) {
    log(`denied upgrade ${pathname}: origin ${req.headers.origin} does not match host ${req.headers.host}`);
    return reject(socket, 403, 'Forbidden');
  }
  try {
    req.user = await authenticate(req);
  } catch (err) {
    log(`denied upgrade ${pathname}: ${err.message}`);
    return reject(socket, 403, 'Forbidden');
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    log(`${pathname} opened by ${req.user.email}`);
    if (target === screenWss) handleScreen(ws, req, config, log);
    else handleTerminal(ws, config.terminal, log);
  });
});

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}, shutting down`);
    server.close();
    for (const c of [...screenWss.clients, ...termWss.clients]) c.terminate();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
