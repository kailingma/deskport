// Isolated browser fixture: real access/API/UI, fake machines and streams.
// It never starts tmux, changes a monitor or sends input to a real desktop.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createAccess } from '../../hub/access.js';
import { createApi } from '../../hub/api.js';
import { createUi } from '../../hub/ui.js';
import { createStreamAccess } from '../../hub/stream-access.js';
import { routeFor } from '../../hub/hosts.js';
import { encode, GuacParser } from '../../shim/guac-protocol.js';
import { createReadOnlyFilter, readOnlyQuery } from '../../shim/readonly.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-permissions-ui-'));
const access = createAccess({ file: path.join(dir, 'access.json'), admins: ['admin@example.com'] });
access.setPerson('editor@example.com', ['laptop', 'server']);
access.setPerson('reader@example.com', [], { readMachines: ['desk', 'laptop'], addMachines: true });
const events = [];
const busyRead = new Set();
const unsupportedRead = new Set();
const joined = new Map([
  ['laptop', { id: 'laptop', name: 'Laptop', os: 'linux', status: 'online' }],
  ['server', { id: 'server', name: 'Build server with a deliberately long machine name', os: 'linux', status: 'online' }],
]);
const hosts = { self: { id: 'desk', name: 'Desk' } };
const machine = (id, name, local = false) => ({
  id,
  describe: () => ({ id, name, capabilities: { terminal: true, readOnly: true, screen: {
    sources: local ? ['mirror', 'virtual', 'session'] : ['mirror'], encodings: ['images'], ...(!local ? { backend: 'portal' } : {}),
  } } }),
  metrics: () => ({ samples: [] }),
  request: async (request) => {
    events.push({ type: 'request', id, ...request });
    return { status: 200, body: request.path === '/api/monitors' ? [] : { state: 'running' } };
  },
});
const machines = {
  self: machine('desk', 'Desk', true),
  get: (id) => id === 'desk' || id === 'local' ? machines.self : joined.has(id) ? machine(id, joined.get(id).name) : null,
};
const registry = {
  list: () => [...joined.values()], summary: () => ({}), remove: (id) => joined.delete(id),
  mintToken: (email) => {
    events.push({ type: 'token', email });
    return { token: 'test-only-do-not-install', expiresAt: Date.now() + 900000 };
  },
};
const emailFor = (req) => /(?:^|;\s*)deskport-test-user=([^;]*)/.exec(req.headers.cookie || '')?.[1] || 'admin@example.com';
const app = express();
app.get('/__test/fixture', (_req, res) => res.json({ fixture: 'deskport-permissions-ui' }));
app.get('/__test/events', (_req, res) => res.json(events));
app.post('/__test/reset', (_req, res) => {
  access.setPerson('editor@example.com', ['laptop', 'server']);
  access.setPerson('reader@example.com', [], { readMachines: ['desk', 'laptop'], addMachines: true });
  events.length = 0;
  busyRead.clear();
  unsupportedRead.clear();
  res.sendStatus(204);
});
app.post('/__test/unsupported', express.json(), (req, res) => {
  if (req.body.enabled) unsupportedRead.add(req.body.id);
  else unsupportedRead.delete(req.body.id);
  res.sendStatus(204);
});
app.use((req, res, next) => {
  req.user = { email: emailFor(req) };
  if (!access.mayEnter(req.user.email)) return res.status(403).json({ error: 'not allowed' });
  next();
});
const api = createApi({ hosts, machines, registry, access, prefs: { get: () => ({ order: [], view: 'list', sort: 'own' }), set: (_email, p) => p } });
app.use((req, _res, next) => { req.machine = machines.self; next(); }, api);
app.use('/h/:id', (req, res, next) => {
  req.machine = machines.get(req.params.id);
  if (!req.machine) return res.status(404).json({ error: 'unknown machine' });
  next();
}, api);
app.use(createUi({ root, dev: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const tracker = createStreamAccess({ access, log: () => {} });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routeFor(url.pathname);
  const target = machines.get(route.hostId);
  const email = emailFor(req);
  if (!target || !access.canRead(email, target.id)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const { readOnly } = tracker.track(ws, email, target.id);
    const kind = route.path === '/ws/term' ? 'term' : 'screen';
    const query = readOnly ? readOnlyQuery(kind, url.search) : url.search;
    events.push({ type: 'stream', id: target.id, email, kind, readOnly, query });
    if (readOnly && unsupportedRead.has(target.id)) {
      ws.close(4005, 'This machine\'s agent needs an update for Read access.');
      return;
    }
    const key = `${email}:${target.id}`;
    if (kind === 'screen' && readOnly && busyRead.delete(key)) {
      ws.send(encode(['error', 'This screen is already being viewed. Try again after the other viewer disconnects.', '519']));
      ws.close(1011, '519');
      return;
    }
    ws.on('access-changed', (code) => {
      if (kind === 'screen' && !readOnly && code === 4004) busyRead.add(key);
    });
    const filter = readOnly ? createReadOnlyFilter(kind) : (data) => data;
    const parser = new GuacParser();
    if (kind === 'term') ws.send('Read-only test output\r\n$ ');
    else {
      ws.send(encode(['', 'test-screen']));
      ws.send(encode(['size', 0, 800, 600]) + encode(['sync', Date.now()]));
      if (target.id !== 'desk') ws.send(encode(['name', 'View only: control was not allowed at this machine.']));
    }
    ws.on('message', (data, binary) => {
      const input = filter(data, binary);
      if (input === null) return;
      if (kind === 'term') {
        const msg = JSON.parse(input.toString());
        if (msg.type === 'input' || msg.type === 'resize') events.push({ type: msg.type, id: target.id, email });
        if (msg.type === 'ping') ws.send(Buffer.from(JSON.stringify({ type: 'pong', id: msg.id })));
      } else {
        for (const { elements } of parser.push(input.toString())) {
          if (elements[0] === '' && elements[1] === 'ping') ws.send(encode(elements));
          if (['key', 'mouse', 'size', 'clipboard', 'blob', 'end'].includes(elements[0])) events.push({ type: 'screen-input', id: target.id, email });
        }
      }
    });
  });
});
server.listen(Number(process.env.DESKPORT_TEST_PORT || 7913), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const ws of wss.clients) ws.terminate();
  server.close(() => { fs.rmSync(dir, { recursive: true }); process.exit(0); });
});
