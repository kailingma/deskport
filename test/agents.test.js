import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createAgentHub, AgentUnavailable } from '../hub/agents.js';
import { SUBPROTOCOL, generateAgentKey, signUpgrade, createUpgradeVerifier, publicKeyFrom, relayCloseCode } from '../hub/protocol.js';
import { parseRange, serveFileStream } from '../shim/files.js';
import { encode, GuacParser } from '../shim/guac-protocol.js';
import { EventEmitter } from 'node:events';

const quiet = () => {};
const once = (emitter, event) => new Promise((r) => emitter.once(event, (...a) => r(a)));

test('upgrade signatures: good, wrong key, replay, clock, unknown agent', () => {
  const a = generateAgentKey();
  const b = generateAgentKey();
  let now = 1_000_000_000_000;
  const verify = createUpgradeVerifier({ keyFor: (id) => (id === 'a' ? publicKeyFrom(a.publicKey) : null), now: () => now });
  const req = (headers, url = '/agent/v1/control') => ({ url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });

  const good = signUpgrade({ id: 'a', privateKeyPem: a.privateKeyPem, pathAndQuery: '/agent/v1/control', now });
  assert.equal(verify(req(good)), 'a');
  assert.throws(() => verify(req(good)), /nonce reused/);
  assert.throws(() => verify(req(signUpgrade({ id: 'a', privateKeyPem: b.privateKeyPem, pathAndQuery: '/agent/v1/control', now }))), /bad signature/);
  assert.throws(() => verify(req(signUpgrade({ id: 'a', privateKeyPem: a.privateKeyPem, pathAndQuery: '/agent/v1/control', now }), '/agent/v1/stream/x')), /bad signature/);
  assert.throws(() => verify(req(signUpgrade({ id: 'a', privateKeyPem: a.privateKeyPem, pathAndQuery: '/agent/v1/control', now: now - 61_000 }))), /clock/);
  assert.throws(() => verify(req(signUpgrade({ id: 'z', privateKeyPem: a.privateKeyPem, pathAndQuery: '/agent/v1/control', now }))), /unknown agent/);
  assert.throws(() => verify(req({})), /unsigned/);
});

test('relayed close codes', () => {
  assert.equal(relayCloseCode(1000), 1000);
  assert.equal(relayCloseCode(1008), 1008);
  assert.equal(relayCloseCode(4000), 4000);
  assert.equal(relayCloseCode(1005), undefined);
  assert.equal(relayCloseCode(1006), 1011);
  assert.equal(relayCloseCode(2000), 1011);
});

test('byte ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), false);
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

/** A hub with one browser endpoint (/ws/term) relayed to agent "pc", and a file route. */
async function startHub({ wait = false, readOnly = false, kind = 'term' } = {}) {
  const agents = createAgentHub({ log: quiet, version: 'test' });
  const browserWss = new WebSocketServer({ noServer: true });
  const app = express();
  app.get('/api/files/:token/:name', (req, res) => agents.file('pc', { token: req.params.token, name: req.params.name, headers: req.headers.range ? { range: req.headers.range } : {}, user: { email: 't@test' } }, res));
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const { pathname, search } = new URL(req.url, 'http://x');
    if (agents.handles(pathname)) return agents.upgrade(req, socket, head);
    browserWss.handleUpgrade(req, socket, head, (ws) => agents.openStream('pc', kind, ws, { query: search, user: { email: 't@test' }, wait, readOnly }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  return {
    agents,
    base,
    http: `http://127.0.0.1:${server.address().port}`,
    close() { agents.close(); for (const c of browserWss.clients) c.terminate(); server.close(); },
  };
}

/** A minimal agent: connects, says hello, and hands each open to onOpen(msg, dialStream). */
async function startAgent(hub, key, { onOpen, onRequest = async () => ({ status: 200, body: null }), capabilities = { terminal: true, readOnly: true } } = {}) {
  const dial = (p) => new WebSocket(`${hub.base}${p}`, SUBPROTOCOL, { headers: signUpgrade({ id: 'pc', privateKeyPem: key.privateKeyPem, pathAndQuery: p }) });
  const control = dial('/agent/v1/control');
  await once(control, 'open');
  control.send(JSON.stringify({ type: 'hello', agent: { version: '1', os: 'linux' }, capabilities }));
  const welcome = JSON.parse((await once(control, 'message'))[0]);
  control.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'open') onOpen?.(msg, () => dial(`/agent/v1/stream/${msg.stream}`));
    if (msg.type === 'request') control.send(JSON.stringify({ type: 'response', id: msg.id, ...(await onRequest(msg)) }));
  });
  return { control, welcome, dial };
}

test('capabilities: complete replacement removes notes without reconnecting', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const initial = { screen: null, terminal: true, files: false, metrics: true, notes: { screen: 'Install the screen packages.' } };
  const agent = await startAgent(hub, key, { capabilities: initial });
  const replace = async (capabilities) => {
    agent.control.send(JSON.stringify({ type: 'capabilities', capabilities }));
    await hub.agents.request('pc', { method: 'GET', path: '/test/fence' });
  };
  assert.deepEqual(hub.agents.hello('pc').capabilities, initial);
  const ready = { screen: { sources: ['mirror'], encodings: ['images', 'h264'], backend: 'portal' }, terminal: true, files: false, metrics: true, future: { enabled: true } };
  await replace(ready);
  assert.deepEqual(hub.agents.hello('pc').capabilities, ready);
  assert.equal(hub.agents.hello('pc').agent.version, '1');
  assert.equal(hub.agents.connected('pc'), true);
  await replace({ screen: null, terminal: false });
  assert.deepEqual(hub.agents.hello('pc').capabilities, { screen: null, terminal: false });
});

test('capabilities: malformed updates and non-object control messages are ignored', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const capabilities = { screen: { sources: ['mirror'], encodings: ['images'], backend: 'portal' }, terminal: true };
  const agent = await startAgent(hub, key, { capabilities });
  for (const bad of [undefined, null, [], 'screen', { screen: true }, { screen: [] }, { screen: { sources: 'mirror' } }, { screen: { encodings: [null] } }, { screen: { backend: {} } }, { terminal: 'yes' }, { readOnly: 'true' }, { notes: [] }, { notes: { screen: {} } }]) {
    agent.control.send(JSON.stringify({ type: 'capabilities', capabilities: bad }));
  }
  for (const raw of ['null', '[]', '"hello"', '{']) agent.control.send(raw);
  await hub.agents.request('pc', { method: 'GET', path: '/test/fence' });
  assert.deepEqual(hub.agents.hello('pc').capabilities, capabilities);
  assert.equal(hub.agents.connected('pc'), true);
});

test('relay: held input, both message types, close codes and reasons', async () => {
  const hub = await startHub();
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  let opened;
  const agent = await startAgent(hub, key, {
    onOpen(msg, dialStream) {
      opened = msg;
      // Dial late, so the browser's first message has to be held.
      setTimeout(() => {
        const ws = dialStream();
        ws.on('message', (data, isBinary) => {
          if (!isBinary && data.toString() === 'bye') return ws.close(4321, 'see you');
          ws.send(isBinary ? data : data.toString().toUpperCase(), { binary: isBinary });
        });
      }, 100);
    },
  });
  assert.equal(agent.welcome.type, 'welcome');
  assert.equal(agent.welcome.protocol, 1);
  assert.equal(hub.agents.connected('pc'), true);

  const browser = new WebSocket(`${hub.base}/ws/term?flow=1`);
  await once(browser, 'open');
  browser.send('hello');
  const [first, firstBinary] = await once(browser, 'message');
  assert.equal(first.toString(), 'HELLO');
  assert.equal(firstBinary, false);
  assert.equal(opened.kind, 'term');
  assert.equal(opened.query, '?flow=1');
  assert.deepEqual(opened.user, { email: 't@test' });
  browser.send(Buffer.from([1, 2, 3]));
  const [bin, isBinary] = await once(browser, 'message');
  assert.equal(isBinary, true);
  assert.deepEqual([...bin], [1, 2, 3]);
  browser.send('bye');
  const [code, reason] = await once(browser, 'close');
  assert.equal(code, 4321);
  assert.equal(reason.toString(), 'see you');
  agent.control.close();
  hub.close();
});

test('relay: requests, a stream the agent cannot serve, and refused upgrades', async () => {
  const hub = await startHub();
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  await assert.rejects(hub.agents.request('pc', { method: 'GET', path: '/api/session' }), AgentUnavailable);
  const agent = await startAgent(hub, key, {
    onRequest: async (msg) => ({ status: 200, body: { path: msg.path, who: msg.user.email } }),
    onOpen: (msg) => agent.control.send(JSON.stringify({ type: 'stream-failed', stream: msg.stream, message: 'no desktop' })),
  });
  assert.deepEqual(await hub.agents.request('pc', { method: 'GET', path: '/api/session', user: { email: 'me@test' } }), { status: 200, body: { path: '/api/session', who: 'me@test' } });

  const browser = new WebSocket(`${hub.base}/ws/term`);
  const [code, reason] = await once(browser, 'close');
  assert.equal(code, 1011);
  assert.equal(reason.toString(), 'no desktop');

  const status = (ws) => new Promise((r) => ws.on('unexpected-response', (req, res) => r(res)).on('error', () => {}));
  const noProto = await status(new WebSocket(`${hub.base}/agent/v1/control`, { headers: signUpgrade({ id: 'pc', privateKeyPem: key.privateKeyPem, pathAndQuery: '/agent/v1/control' }) }));
  assert.equal(noProto.statusCode, 426);
  assert.equal(noProto.headers['deskport-protocols'], SUBPROTOCOL);
  const other = generateAgentKey();
  const badKey = await status(new WebSocket(`${hub.base}/agent/v1/control`, SUBPROTOCOL, { headers: signUpgrade({ id: 'pc', privateKeyPem: other.privateKeyPem, pathAndQuery: '/agent/v1/control' }) }));
  assert.equal(badKey.statusCode, 401);
  const noStream = await status(agent.dial('/agent/v1/stream/AAAAAAAAAAAAAAAAAAAAAA'));
  assert.equal(noStream.statusCode, 404);

  // A second control socket from the same agent replaces the first.
  const replaced = once(agent.control, 'close');
  const again = await startAgent(hub, key);
  assert.equal((await replaced)[0], 4000);
  again.control.close();
  hub.close();
});

test('file streams: whole file, a range, and an expired token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-files-'));
  const file = path.join(dir, 'clip.txt');
  fs.writeFileSync(file, 'abcdefghijklmnopqrstuvwxyz'.repeat(4000));
  const opener = { fileFor: (token) => (token === 'ok' ? { file, sandbox: false } : null) };
  const hub = await startHub();
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const agent = await startAgent(hub, key, {
    onOpen(msg, dialStream) {
      const ws = dialStream();
      ws.on('open', () => serveFileStream(ws, msg.query, msg.headers, opener));
    },
  });

  const whole = await fetch(`${hub.http}/api/files/ok/clip.txt`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.headers.get('content-type'), /^text\/plain/);
  assert.equal((await whole.text()).length, 104000);

  const part = await fetch(`${hub.http}/api/files/ok/clip.txt`, { headers: { range: 'bytes=26-51' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 26-51/104000');
  assert.equal(await part.text(), 'abcdefghijklmnopqrstuvwxyz');

  const gone = await fetch(`${hub.http}/api/files/nope/clip.txt`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /expired/);

  agent.control.close();
  hub.close();
  fs.rmSync(dir, { recursive: true });
});

test('relay: a stream for an expected agent waits for it to connect', async () => {
  const hub = await startHub({ wait: true });
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const browser = new WebSocket(`${hub.base}/ws/term`);
  await once(browser, 'open');
  browser.send('early');
  await new Promise((r) => setTimeout(r, 300));
  const agent = await startAgent(hub, key, {
    onOpen(msg, dialStream) {
      const ws = dialStream();
      ws.on('message', (data) => ws.send(`got ${data}`));
    },
  });
  const [msg] = await once(browser, 'message');
  assert.equal(msg.toString(), 'got early');
  browser.close();
  agent.control.close();
  hub.close();
});

test('Read relay: terminal input and resize are dropped before pairing and afterwards', async (t) => {
  const hub = await startHub({ readOnly: true });
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const got = [];
  let opened;
  await startAgent(hub, key, {
    onOpen(msg, dialStream) {
      opened = msg;
      setTimeout(() => {
        const ws = dialStream();
        ws.on('message', (data, binary) => {
          got.push([JSON.parse(data), binary]);
          ws.send('output');
        });
      }, 50);
    },
  });
  const browser = new WebSocket(`${hub.base}/ws/term?flow=1&readonly=0`);
  await once(browser, 'open');
  const early = once(browser, 'message');
  browser.send(JSON.stringify({ type: 'input', data: 'early command' }));
  browser.send(JSON.stringify({ type: 'resize', cols: 2, rows: 2 }));
  browser.send(Buffer.from(JSON.stringify({ type: 'input', data: 'binary command' })));
  browser.send(JSON.stringify({ type: 'ack', chars: 1 }));
  assert.equal((await early)[0].toString(), 'output');
  assert.equal(opened.readOnly, true);
  assert.equal(new URLSearchParams(opened.query).get('readonly'), '1');
  assert.equal(new URLSearchParams(opened.query).get('flow'), '1');
  assert.deepEqual(got, [[{ type: 'ack', chars: 1 }, false]]);
  const live = once(browser, 'message');
  browser.send(JSON.stringify({ type: 'input', data: 'late command' }));
  browser.send(JSON.stringify({ type: 'resize', cols: 3, rows: 3 }));
  browser.send(JSON.stringify({ type: 'ping', id: 7 }));
  await live;
  assert.deepEqual(got.map(([msg]) => msg.type), ['ack', 'ping']);
});

test('Read relay: mixed and fragmented screen input cannot smuggle control instructions', async (t) => {
  const hub = await startHub({ readOnly: true, kind: 'screen' });
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const got = [];
  let opened;
  await startAgent(hub, key, {
    onOpen(msg, dialStream) {
      opened = msg;
      setTimeout(() => {
        const ws = dialStream();
        const parser = new GuacParser();
        ws.on('message', (data) => {
          for (const { elements } of parser.push(data.toString())) {
            got.push(elements);
            if (elements[0] === 'sync') ws.send(`fence ${elements[1]}`);
          }
        });
      }, 50);
    },
  });
  const browser = new WebSocket(`${hub.base}/ws/screen?source=session&match=1&monitor=HDMI-1&path=direct&readonly=0`);
  await once(browser, 'open');
  const early = once(browser, 'message');
  browser.send(encode(['key', 65, 1]) + encode(['mouse', 1, 2, 1]) + encode(['size', 800, 600]) + encode(['clipboard', 0, 'text/plain']) + encode(['blob', 0, 'YQ==']) + encode(['end', 0]));
  browser.send(encode(['sync', 1]));
  assert.equal((await early)[0].toString(), 'fence 1');
  assert.deepEqual(got, [['sync', '1']]);
  const q = new URLSearchParams(opened.query);
  assert.equal(q.get('source'), 'mirror');
  assert.equal(q.get('readonly'), '1');
  for (const key of ['match', 'monitor', 'path']) assert.equal(q.has(key), false);
  const live = once(browser, 'message');
  const keyInput = encode(['key', 66, 1]);
  browser.send(keyInput.slice(0, 4));
  browser.send(keyInput.slice(4) + encode(['clipboard', 1, 'text/plain']) + encode(['blob', 1, 'Yg==']) + encode(['end', 1]) + encode(['sync', 2]));
  assert.equal((await live)[0].toString(), 'fence 2');
  assert.deepEqual(got, [['sync', '1'], ['sync', '2']]);
});

test('Read relay: video acknowledgements and keyframe requests remain available', async (t) => {
  const hub = await startHub({ readOnly: true, kind: 'video' });
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  const got = [];
  await startAgent(hub, key, {
    onOpen(_msg, dialStream) {
      const ws = dialStream();
      ws.on('message', (data) => { got.push(JSON.parse(data)); ws.send('frame'); });
    },
  });
  const browser = new WebSocket(`${hub.base}/ws/video?tunnel=test`);
  await once(browser, 'open');
  const frame = once(browser, 'message');
  browser.send(JSON.stringify({ type: 'input', data: 'command' }));
  browser.send(JSON.stringify({ type: 'key' }));
  await frame;
  assert.deepEqual(got, [{ type: 'key' }]);
  const next = once(browser, 'message');
  browser.send(JSON.stringify({ type: 'ack', seq: 1 }));
  await next;
  assert.deepEqual(got, [{ type: 'key' }, { type: 'ack', seq: 1 }]);
});

test('Read relay: older agents are refused before any stream starts', async (t) => {
  const hub = await startHub({ readOnly: true });
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  let opens = 0;
  await startAgent(hub, key, { capabilities: { terminal: true }, onOpen: () => opens++ });
  const browser = new WebSocket(`${hub.base}/ws/term`);
  const [code, reason] = await once(browser, 'close');
  assert.equal(code, 4005);
  assert.match(reason.toString(), /needs an update for Read access/);
  assert.equal(opens, 0);
});

test('relay: revoked pending streams cannot attach or forward previously held input', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const key = generateAgentKey();
  hub.agents.register('pc', key.publicKey);
  let opened;
  const opening = new Promise((resolve) => { opened = resolve; });
  await startAgent(hub, key, { onOpen: (_msg, dialStream) => opened(dialStream) });
  const browser = new EventEmitter();
  Object.assign(browser, { OPEN: 1, readyState: 1, ping: quiet, send: quiet, close: quiet });
  t.after(() => browser.emit('close'));
  hub.agents.openStream('pc', 'term', browser, { query: '?flow=1', user: { email: 'test@example.com' } });
  browser.emit('message', Buffer.from('{"type":"input","data":"held command"}'), false);
  const dial = await opening;
  browser.emit('access-changed', 4004, 'permissions changed');
  browser.readyState = 2; // The browser has not acknowledged the close yet.
  const ws = dial();
  const refused = new Promise((resolve) => ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }).on('error', quiet));
  assert.equal(await refused, 404);
  ws.terminate();
});

test('Read relay: an offline machine is unavailable, not misreported as needing an update', async (t) => {
  const hub = await startHub({ readOnly: true });
  t.after(() => hub.close());
  const browser = new WebSocket(`${hub.base}/ws/term`);
  const [code, reason] = await once(browser, 'close');
  assert.equal(code, 1011);
  assert.match(reason.toString(), /not connected/);
});
