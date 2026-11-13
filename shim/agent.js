import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { config } from '../hub/config.js';
import { SUBPROTOCOL, AGENT_PREFIX, signUpgrade } from '../hub/protocol.js';
import { createLocalHost } from './host.js';
import { serveFileStream } from './files.js';

// The agent shim: this machine's host code (shim/host.js) speaking the hub
// and agent protocol (docs/protocol.md) to a hub on loopback. The hub starts
// it with DESKPORT_RELAY=1 and hands it the hub's URL, its agent id and its
// private key in the environment, which it removes before starting anything.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const log = (msg) => console.log(`[deskport agent] ${msg}`);

const hub = process.env.DESKPORT_AGENT_HUB;
const id = process.env.DESKPORT_AGENT_ID;
const privateKeyPem = process.env.DESKPORT_AGENT_KEY;
delete process.env.DESKPORT_AGENT_KEY;
delete process.env.DESKPORT_AGENT_HUB;
delete process.env.DESKPORT_AGENT_ID;
if (!hub || !id || !privateKeyPem) {
  console.error('[deskport agent] DESKPORT_AGENT_HUB, DESKPORT_AGENT_ID and DESKPORT_AGENT_KEY are required');
  process.exit(1);
}

const SILENCE_MS = 60_000;
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 15000];
const STEADY_MS = 60_000;
const KINDS = new Set(['screen', 'video', 'term', 'file']);

const host = createLocalHost({ config, root, log });

function dial(pathAndQuery) {
  return new WebSocket(new URL(pathAndQuery, hub), SUBPROTOCOL, {
    headers: signUpgrade({ id, privateKeyPem, pathAndQuery }),
    perMessageDeflate: false, // loopback (docs/protocol.md)
  });
}

function openStream(control, msg) {
  const failed = (message) => {
    if (control.readyState === WebSocket.OPEN) control.send(JSON.stringify({ type: 'stream-failed', stream: msg.stream, message }));
  };
  if (!KINDS.has(msg.kind) || typeof msg.stream !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(msg.stream)) return failed('unknown stream kind');
  const query = typeof msg.query === 'string' ? msg.query : '';
  const ws = dial(`${AGENT_PREFIX}stream/${msg.stream}`);
  ws.on('error', (err) => { log(`stream ${msg.kind}: ${err.message}`); failed(err.message); });
  ws.on('open', () => {
    if (msg.kind === 'file') serveFileStream(ws, query, msg.headers || {}, host.opener);
    else host.streams[msg.kind](ws, `/ws/${msg.kind}${query && !query.startsWith('?') ? '?' : ''}${query}`);
  });
}

async function answer(control, msg) {
  const handler = host.requests[`${msg.method} ${msg.path}`];
  const res = handler ? await handler(msg).catch((err) => ({ status: 500, body: { error: err.message } })) : { status: 404, body: { error: 'not found' } };
  if (control.readyState === WebSocket.OPEN) control.send(JSON.stringify({ type: 'response', id: msg.id, ...res }));
}

let attempt = 0;
let stopping = false;
let current = null;

function connect() {
  const ws = dial(`${AGENT_PREFIX}control`);
  current = ws;
  let connectedAt = 0;
  let lastSeen = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - lastSeen > SILENCE_MS) ws.terminate(); }, 5000);
  ws.on('open', () => {
    connectedAt = Date.now();
    ws.send(JSON.stringify({
      type: 'hello',
      agent: { version, os: process.platform, arch: os.arch(), name: config.self.name },
      capabilities: { screen: { sources: ['mirror', 'virtual', 'session'], encodings: ['images', 'av1', 'h264'] }, terminal: true, files: true, metrics: false },
    }));
  });
  ws.on('message', (raw, isBinary) => {
    lastSeen = Date.now();
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'welcome') log(`connected to the hub (protocol ${msg.protocol})`);
    else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
    else if (msg.type === 'open') openStream(ws, msg);
    else if (msg.type === 'request') answer(ws, msg);
  });
  ws.on('error', (err) => log(`control: ${err.message}`));
  ws.on('close', (code) => {
    clearInterval(watchdog);
    if (stopping) return;
    if (code === 4001) {
      log('removed by the hub');
      return shutdown();
    }
    if (connectedAt && Date.now() - connectedAt > STEADY_MS) attempt = 0;
    const base = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    setTimeout(connect, base * (1 + Math.random() * 0.2));
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  current?.close(1001);
  host.close();
  setTimeout(() => process.exit(0), 300).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
// The hub started this process with an IPC channel; when the hub goes, so does the shim.
process.on('disconnect', shutdown);
connect();
