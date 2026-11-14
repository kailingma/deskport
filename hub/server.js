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
import { createAgentHub } from './agents.js';
import { createRegistry, JoinError } from './registry.js';
import { createMachines } from './machines.js';
import { createPrefs } from './prefs.js';
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

const registry = createRegistry({ file: config.agentsFile, agents, reservedIds: [selfId], log });
const machines = createMachines({ hosts, agents, registry, local });
const prefs = createPrefs({ file: config.prefsFile, log });

// ---------- HTTP ----------

const app = express();
app.disable('x-powered-by');

// Joining a machine (docs/protocol.md): the join token is the authentication,
// so this is answered before the person check. Nothing else under /agent/ is
// plain HTTP.
app.post('/agent/v1/join', express.json({ limit: '8kb' }), (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try {
    res.json(registry.join(req.body));
  } catch (err) {
    if (!(err instanceof JoinError)) throw err;
    log(`join refused: ${err.message}`);
    res.status(err.status).json({ error: err.message });
  }
});
// The install script, and the agent's build for a platform to anyone holding
// a join token that is still usable (scripts/install-agent.sh).
const AGENT_BUILDS = { 'linux-x86_64': 'x86_64-unknown-linux-musl', 'linux-aarch64': 'aarch64-unknown-linux-musl' };
app.get('/agent/v1/install.sh', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.type('text/x-shellscript').sendFile(path.join(root, 'scripts/install-agent.sh'));
});
app.get('/agent/v1/download/:platform', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!registry.tokenValid(token)) return res.status(401).type('text/plain').send('A join token that is still usable is required.\n');
  const triple = AGENT_BUILDS[req.params.platform];
  const file = triple && path.join(root, 'agent/target', triple, 'release/deskport-agent');
  if (!file || !fs.existsSync(file)) return res.status(404).type('text/plain').send(`No agent build for ${req.params.platform} on this hub (npm run build:agent).\n`);
  res.type('application/octet-stream').sendFile(file);
});
app.use('/agent', (req, res) => res.status(404).type('text/plain').send('Not Found'));

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

const api = createApi({ hosts, registry, prefs, machines });
app.use((req, res, next) => { req.machine = machines.self; next(); }, api);
app.use('/h/:hostId', (req, res, next) => {
  req.machine = machines.get(req.params.hostId);
  if (req.machine) return next();
  if (hosts.get(req.params.hostId)) return res.status(501).json({ error: 'hosts.json entries are not reachable; join the machine with an agent instead' });
  res.status(404).json({ error: 'unknown host' });
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
  const machine = machines.get(route.hostId);
  const kind = KINDS[route.path];
  if (!endpoint || !machine || !machine.offers(kind)) return reject(socket, 404, 'Not Found');
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
  endpoint.handleUpgrade(req, socket, head, (ws) => {
    log(`${pathname} opened by ${req.user.email}`);
    machine.stream(kind, ws, req);
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
