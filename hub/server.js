import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { createAuthenticator, AuthError, sameOrigin } from './auth.js';
import { spawn } from 'node:child_process';
import { SCREEN_SOURCES } from '../shim/guac.js';
import { createLocalHost } from '../shim/host.js';
import { createHostRegistry, routeFor } from './hosts.js';
import { createApi } from './api.js';
import { createUi } from './ui.js';
import { createAgentHub, AgentUnavailable } from './agents.js';
import { generateAgentKey, KINDS } from './protocol.js';

// Starts one deskport host: authentication and security headers, the API, the
// web page (unless DESKPORT_UI=0), and the screen and terminal WebSockets.
// Requests may be addressed to this host directly (/api/..., /ws/...) or by id
// (/h/<id>/api/..., /h/<id>/ws/...); ids of other hosts get 501 for now.
//
// This machine's host work (shim/host.js) runs in the agent shim
// (shim/agent.js), a child process that speaks docs/protocol.md to this hub on
// loopback, or with DESKPORT_RELAY=0 in this process.

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
const agents = createAgentHub({ log, version });
const selfId = hosts.self.id;
const local = config.relay ? null : createLocalHost({ config, root, log });
if (!config.relay) log('DESKPORT_RELAY=0: host work runs in this process');

// The machine's API and streams, in this process or through its agent.
const FILE_HEADERS = ['range', 'if-none-match', 'if-modified-since'];
const machine = local
  ? {
      request: ({ method, path: p }) => local.requests[`${method} ${p}`](),
      file: (req, res) => local.opener.serveFile(req, res),
      stream: (kind, ws, req) => local.streams[kind](ws, req.url.replace(/^\/h\/[^/?]+/, '')),
    }
  : {
      request: (r) => agents.request(selfId, r).catch((err) => {
        if (err instanceof AgentUnavailable) return { status: 503, body: { error: err.message } };
        throw err;
      }),
      file: (req, res) => agents.file(selfId, {
        token: req.params.token,
        name: req.params.name,
        headers: Object.fromEntries(FILE_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
        user: { email: req.user.email },
      }, res),
      stream: (kind, ws, req) => agents.openStream(selfId, kind, ws, {
        query: new URL(req.url, 'http://localhost').search,
        user: { email: req.user.email },
      }),
    };

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

const api = createApi({ hosts, machine });
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
  '/ws/screen': screenWss,
  '/ws/video': videoWss,
  '/ws/term': termWss,
};

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // Agents sign their own upgrades (docs/protocol.md); no person check there.
  if (agents.handles(pathname)) return agents.upgrade(req, socket, head);
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
  endpoint.handleUpgrade(req, socket, head, (ws) => {
    log(`${pathname} opened by ${req.user.email}`);
    machine.stream(KINDS[route.path], ws, req);
  });
});

// The agent shim for this machine, restarted if it exits.
let shim = null;
let stopping = false;
function startShim() {
  const key = generateAgentKey();
  agents.register(selfId, key.publicKey);
  const hubHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  shim = spawn(process.execPath, [path.join(root, 'shim/agent.js')], {
    cwd: root,
    env: { ...process.env, DESKPORT_AGENT_HUB: `ws://${hubHost}:${config.port}`, DESKPORT_AGENT_ID: selfId, DESKPORT_AGENT_KEY: key.privateKeyPem },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const started = Date.now();
  shim.on('exit', (code, signal) => {
    shim = null;
    if (stopping) return;
    log(`agent shim exited (${signal || code}); restarting`);
    setTimeout(startShim, Date.now() - started > 10_000 ? 0 : 2000);
  });
}

server.listen(config.port, config.host, () => {
  log(`host "${hosts.self.id}" listening on http://${config.host}:${config.port}`);
  if (config.relay) startShim();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}, shutting down`);
    stopping = true;
    server.close();
    local?.close();
    agents.close();
    shim?.kill('SIGTERM');
    for (const c of [...screenWss.clients, ...videoWss.clients, ...termWss.clients]) c.terminate();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
