import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter, once } from 'node:events';
import pty from 'node-pty';
import { createAccess, ALL } from '../hub/access.js';
import { createStreamAccess } from '../hub/stream-access.js';
import { createMachines } from '../hub/machines.js';
import { encode, GuacParser } from '../shim/guac-protocol.js';
import { createReadOnlyFilter, readOnlyQuery } from '../shim/readonly.js';
import { handleScreen } from '../shim/guac.js';
import { handleDirect } from '../shim/direct.js';
import { handleTerminal, tmuxArgs } from '../shim/terminal.js';
import { canEdit, screenPermissionsFor, grantFor, changeGrant } from '../web/js/permissions.js';
import { pictureOptions, portalPermissions } from '../web/js/screen-options.js';

const quiet = () => {};

function socket() {
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, readyState: 1, sent: [], closed: null });
  ws.send = (data, options) => ws.sent.push({ data, options });
  ws.ping = quiet;
  ws.close = (code, reason) => { ws.closed = [code, reason]; ws.readyState = 3; ws.emit('close', code, reason); };
  return ws;
}

test('screen Read input is filtered by instruction, including fragments and mixed messages', () => {
  const filter = createReadOnlyFilter('screen');
  const safe = encode(['sync', '123']) + encode(['ack', '1', 'OK', '0']);
  const unsafe = ['key', 'mouse', 'size', 'clipboard', 'blob', 'end', 'put', 'pipe', 'touch', 'future-control'].map((op) => encode([op, '1', 'a😀b'])).join('');
  assert.equal(filter(unsafe + safe), safe);
  const key = encode(['key', '65', '1']);
  assert.equal(filter(key.slice(0, 6)), null);
  assert.equal(filter(key.slice(6) + encode(['sync', '124'])), encode(['sync', '124']));
  assert.equal(filter(encode(['', 'ping', '125'])), encode(['', 'ping', '125']));
  assert.equal(filter(encode(['', 'other', '125'])), null);
  assert.equal(filter(Buffer.from(safe), true), null);
  assert.equal(filter('garbage;'), null);
  assert.equal(filter('9'.repeat(65537)), null);
  assert.equal(filter(safe), safe, 'bad or oversized input cannot poison later messages');
});

test('terminal and video Read allow only their playback acknowledgements and pings', () => {
  const term = createReadOnlyFilter('term');
  const video = createReadOnlyFilter('video');
  for (const type of ['input', 'resize', 'clipboard', 'future-control']) {
    assert.equal(term(JSON.stringify({ type, data: 'a' })), null);
    assert.equal(video(JSON.stringify({ type, data: 'a' })), null);
  }
  for (const type of ['ack', 'ping']) assert.ok(term(JSON.stringify({ type })));
  for (const type of ['ack', 'key']) assert.ok(video(JSON.stringify({ type })));
  assert.equal(video(JSON.stringify({ type: 'ping' })), null);
  for (const raw of ['null', '[]', '{', '"ack"']) assert.equal(term(raw), null);
  assert.equal(term(Buffer.from('{"type":"ack"}'), true), null);
});

test('Read-only queries cannot select a desktop, resize a monitor or enable the direct path', () => {
  const q = new URLSearchParams(readOnlyQuery('screen', '?source=session&readonly=0&readonly=0&match=1&monitor=HDMI-1&path=direct&quality=high&width=800'));
  assert.deepEqual(q.getAll('readonly'), ['1']);
  assert.equal(q.get('source'), 'mirror');
  for (const key of ['match', 'monitor', 'path']) assert.equal(q.has(key), false);
  assert.equal(q.get('width'), '800');
  assert.equal(q.get('quality'), 'high');
  assert.equal(new URLSearchParams(readOnlyQuery('term', '?flow=1')).get('flow'), '1');
});

test('live grants close changed streams and stop input before a close handshake', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-stream-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const access = createAccess({ file: path.join(dir, 'access.json'), admins: ['admin@example.com'] });
  const tracker = createStreamAccess({ access, log: quiet });
  access.setPerson('person@example.com', ['pc']);
  const edit = socket();
  edit.close = (code, reason) => { edit.closed = [code, reason]; edit.readyState = 2; };
  assert.deepEqual(tracker.track(edit, 'person@example.com', 'pc'), { readOnly: false });
  let inputs = 0;
  let revoked;
  edit.on('message', () => inputs++);
  edit.on('access-changed', (...args) => { revoked = args; });
  edit.emit('message', 'before');
  access.setPerson('person@example.com', [], { readMachines: ['pc'] });
  assert.deepEqual(edit.closed, [4004, 'permissions changed']);
  assert.deepEqual(revoked, [4004, 'permissions changed']);
  edit.emit('message', 'after');
  assert.equal(inputs, 1);
  const read = socket();
  assert.deepEqual(tracker.track(read, 'person@example.com', 'pc'), { readOnly: true });
  access.setPerson('person@example.com', [], { readMachines: ['pc'], addMachines: true });
  assert.equal(read.closed, null, 'an unrelated permission does not drop a viewer');
  access.grantEdit('person@example.com', 'pc');
  assert.deepEqual(read.closed, [4004, 'permissions changed']);
  const removed = socket();
  tracker.track(removed, 'person@example.com', 'pc');
  access.removePerson('person@example.com');
  assert.deepEqual(removed.closed, [4003, 'access removed']);
});

test('local and joined machines pass server-derived Read-only authority to stream handlers', () => {
  const calls = [];
  const hosts = { self: { id: 'desk' }, describe: () => ({ id: 'desk' }) };
  const registry = { get: (id) => ({ id }), metrics: quiet };
  const req = { url: '/h/desk/ws/term?readonly=0', user: { email: 'person@example.com' } };
  const local = { streams: { term: (...args) => calls.push(args) } };
  createMachines({ hosts, registry, local }).self.stream('term', 'ws', req, { readOnly: true });
  assert.deepEqual(calls[0], ['ws', '/ws/term?readonly=0', { readOnly: true }]);
  const agents = { openStream: (...args) => calls.push(args) };
  const machines = createMachines({ hosts, registry, agents, local: null });
  machines.get('joined').stream('term', 'ws', req, { readOnly: true });
  assert.equal(calls[1][0], 'joined');
  assert.equal(calls[1][3].readOnly, true);
  assert.deepEqual(calls[1][3].user, { email: 'person@example.com' });
});

test('a local Read screen cannot start the separate desktop or acquire a monitor', async () => {
  const ws = socket();
  const closed = once(ws, 'close');
  let starts = 0;
  let monitorChanges = 0;
  handleScreen(ws, { url: '/ws/screen?source=session&path=direct&encoding=h264&match=1&monitor=HDMI-1&readonly=0' }, {
    readOnly: true, guacd: { host: '127.0.0.1', port: 0 }, rdp: { hostname: '127.0.0.1', port: 0, sessionPort: 0 },
    session: { ensureRunning: async () => { starts++; } },
    monitors: { acquire: async () => { monitorChanges++; return quiet; } }, video: {},
  }, quiet);
  await closed;
  assert.equal(starts, 0);
  assert.equal(monitorChanges, 0);
  assert.match(new GuacParser().push(ws.sent[0].data)[0].elements[1], /monitor is not being shared/);
});

test('the direct path refuses Read before starting a desktop or encoder', () => {
  const ws = socket();
  let starts = 0;
  handleDirect(ws, { readOnly: true, session: { ensureRunning: () => starts++ } });
  assert.equal(starts, 0);
  assert.deepEqual(ws.closed, [1011, '519']);
});

test('Read cannot use an RDP server whose mirror mode the hub cannot verify', async () => {
  const ws = socket();
  const closed = once(ws, 'close');
  handleScreen(ws, { url: '/ws/screen' }, {
    readOnly: true, guacd: {}, rdp: { hostname: 'unverified.example', port: 3389 }, session: {}, monitors: {},
  }, quiet);
  await closed;
  assert.match(new GuacParser().push(ws.sent[0].data)[0].elements[1], /cannot verify.*mirror mode/);
});

test('Read terminal startup, input and resize stay read-only while output and flow control work', (t) => {
  const writes = [];
  const resizes = [];
  let output;
  let pauses = 0;
  let resumes = 0;
  let args;
  const term = { pid: 123, onData: (fn) => { output = fn; }, onExit: quiet, write: (text) => writes.push(text), resize: (...size) => resizes.push(size),
    pause: () => pauses++, resume: () => resumes++, kill: quiet };
  t.mock.method(pty, 'spawn', (_command, commandArgs) => { args = commandArgs; return term; });
  const ws = socket();
  t.after(() => ws.close());
  handleTerminal(ws, { url: '/ws/term?flow=1&readonly=0' }, { tmuxSession: 'test-only', cwd: '/', readOnly: true }, quiet);
  assert.deepEqual(args, ['attach-session', '-E', '-t', '=test-only', '-f', 'read-only,ignore-size']);
  assert.deepEqual(tmuxArgs('test-only', '/', { PATH: '/new' }, { readOnly: true }), args);
  output('x'.repeat(140 * 1024));
  assert.equal(pauses, 1);
  for (const msg of [{ type: 'input', data: 'run a command\n' }, { type: 'resize', cols: 2, rows: 2 }, null, { type: 'ack', chars: 200000 }, { type: 'ping', id: 5 }]) {
    ws.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(resizes, []);
  assert.equal(resumes, 1);
  assert.deepEqual(JSON.parse(ws.sent.at(-1).data.toString()), { type: 'pong', id: 5 });
});

test('Read/Edit checkbox changes are exclusive and preserve independent add permission', () => {
  const p = { machines: ['laptop'], readMachines: ['server'], addMachines: true };
  assert.equal(grantFor(p, 'laptop'), 'edit');
  assert.equal(grantFor(p, 'server'), 'read');
  assert.equal(grantFor(p, 'other'), null);
  const read = changeGrant(p, 'laptop', 'read', true);
  assert.deepEqual(read, { machines: [], readMachines: ['laptop', 'server'], addMachines: true });
  const edit = changeGrant(read, 'laptop', 'edit', true);
  assert.deepEqual(edit, p);
  assert.equal(grantFor(changeGrant(edit, 'laptop', 'edit', false), 'laptop'), null);
  const everyRead = changeGrant(p, ALL, 'read', true);
  assert.equal(grantFor(everyRead, 'future'), 'read');
  assert.equal(grantFor(everyRead, 'laptop'), 'edit');
  assert.equal(grantFor(changeGrant(everyRead, 'laptop', 'edit', false), 'laptop'), 'read');
  const everyEdit = changeGrant(everyRead, ALL, 'edit', true);
  assert.deepEqual(everyEdit, { machines: [ALL], readMachines: [], addMachines: true });
});

test('machine Edit never overrides portal control or clipboard restrictions', () => {
  const edit = { access: 'edit' };
  const read = { access: 'read' };
  assert.equal(canEdit({}), false);
  assert.deepEqual(screenPermissionsFor(edit, portalPermissions('View only: not allowed at the machine.')), { waiting: false, control: false, clipboard: false });
  assert.deepEqual(screenPermissionsFor(edit, portalPermissions('Clipboard unavailable: not allowed at the machine.')), { waiting: false, control: true, clipboard: false });
  assert.deepEqual(screenPermissionsFor(read, portalPermissions('')), { waiting: false, control: false, clipboard: false });
  const saved = { source: 'session', encoding: 'h264', direct: true, monitor: 'HDMI-1', matchMonitor: true };
  assert.deepEqual(pictureOptions({ ...read, local: true, screen: true }, (k) => saved[k]), { source: 'mirror', encoding: 'h264', direct: false, monitor: 'primary', matchMonitor: false });
});
