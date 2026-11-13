import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { createAuthenticator, AuthError, sameOrigin } from './auth.js';
import { handleScreen, SCREEN_SOURCES } from '../shim/guac.js';
import { handleTerminal } from '../shim/terminal.js';
import { createSessionControl } from '../shim/session.js';
import { createHostRegistry, routeFor } from './hosts.js';
import { createApi } from './api.js';
import { createMonitors } from '../shim/monitors.js';
import { createUi } from './ui.js';
import { createOpener } from '../shim/opener.js';
import { createVideoHub } from '../shim/video.js';

// Starts one deskport host: authentication and security headers, the API, the
// web page (unless DESKPORT_UI=0), and the screen and terminal WebSockets.
// Requests may be addressed to this host directly (/api/..., /ws/...) or by id
// (/h/<id>/api/..., /h/<id>/ws/...); ids of other hosts get 501 for now.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const log = (msg) => console.log(`[deskport] ${msg}`);

const problems = validateConfig();
if (problems.length) {
  for (const p of problems) console.error(`[deskport] config: ${p}`);
  process.exit(1);
}
if (config.insecureDev) log('WARNING: DESKPORT_INSECURE_DEV=1, Cloudflare Access checks are OFF');
if (!config.ui) log('DESKPORT_UI=0: serving the API and WebSockets only, no web page');

const authenticate = createAuthenticator(config);
const hosts = createHostRegistry({ config, sources: SCREEN_SOURCES, version, log });
const session = createSessionControl({
  unit: config.rdp.sessionUnit,
  host: config.rdp.hostname,
  port: config.rdp.sessionPort,
  log,
});
// The desktop on the monitor is this user's main session bus.
const mainBus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
const monitors = createMonitors({
  bus: mainBus,
  id: String(config.port),
  log,
});
monitors.restoreLeftover();
const opener = createOpener({
  dir: path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'deskport'),
  port: config.port,
  log,
});
const terminal = { ...config.terminal, binDir: path.join(root, 'bin'), opener };
const video = createVideoHub({ log });

// ---------- HTTP ----------

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

const api = createApi({ hosts, session, monitors, opener });
app.use(api);
app.use('/h/:hostId', (req, res, next) => {
  const host = hosts.get(req.params.hostId);
  if (!host) return res.status(404).json({ error: 'unknown host' });
  if (!host.local) return res.status(501).json({ error: 'controlling other hosts is not implemented yet' });
  next();
}, api);

if (config.ui) app.use(createUi({ root, dev: config.insecureDev, log }));

app.use((err, req, res, _next) => {
  log(`error: ${err.stack || err}`);
  res.status(500).type('text/plain').send('Internal error');
});

// ---------- WebSockets ----------

const server = http.createServer(app);
const screenWss = new WebSocketServer({
  noServer: true,
  // Screen updates are base64 images; fast deflate wins back most of the base64 overhead.
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
  handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false),
});
// Terminal output is repetitive text; keeping the deflate context across
// messages lets a redraw refer back to earlier ones.
const termWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 64, zlibDeflateOptions: { level: 6, memLevel: 8 } },
});
// Video frames (video.js) are already compressed.
const videoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const endpoints = {
  '/ws/screen': { wss: screenWss, open: (ws, req) => handleScreen(ws, req, { ...config, session, monitors, video, mainBus }, log) },
  '/ws/video': { wss: videoWss, open: (ws, req) => video.open(ws, req) },
  '/ws/term': { wss: termWss, open: (ws, req) => handleTerminal(ws, req, terminal, log) },
};

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = routeFor(pathname);
  const endpoint = endpoints[route.path];
  const host = hosts.get(route.hostId);
  if (!endpoint || !host) return reject(socket, 404, 'Not Found');
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
  if (!host.local) {
    log(`denied upgrade ${pathname}: controlling other hosts is not implemented yet`);
    return reject(socket, 501, 'Not Implemented');
  }
  endpoint.wss.handleUpgrade(req, socket, head, (ws) => {
    log(`${pathname} opened by ${req.user.email}`);
    endpoint.open(ws, req);
  });
});

server.listen(config.port, config.host, () => {
  log(`host "${hosts.self.id}" listening on http://${config.host}:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}, shutting down`);
    server.close();
    opener.close();
    for (const c of [...screenWss.clients, ...videoWss.clients, ...termWss.clients]) c.terminate();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
