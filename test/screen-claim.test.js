import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { claimScreen } from '../shim/screen-claim.js';

function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.closed = null;
  ws.close = (code, reason) => {
    ws.closed = [code, reason];
    ws.readyState = 3;
    ws.emit('close');
  };
  return ws;
}

test('the first viewer for a source connects at once', async () => {
  const claims = new Map();
  await claimScreen(claims, 'mirror', fakeSocket(), { wait: 0 });
  assert.equal(claims.has('mirror'), true);
});

test('a newer viewer closes the older one as a normal close and waits for it to release', async () => {
  const claims = new Map();
  const first = fakeSocket();
  const second = fakeSocket();
  await claimScreen(claims, 'mirror', first, { wait: 0 });
  await claimScreen(claims, 'mirror', second, { wait: 0 });
  assert.deepEqual(first.closed, [1000, '0']);
  assert.equal(second.closed, null);
});

test('viewers of different sources do not affect each other', async () => {
  const claims = new Map();
  const mirror = fakeSocket();
  const session = fakeSocket();
  await claimScreen(claims, 'mirror', mirror, { wait: 0 });
  await claimScreen(claims, 'session', session, { wait: 0 });
  assert.equal(mirror.closed, null);
});

test('the new viewer waits for the old RDP session to be released', async () => {
  const claims = new Map();
  const first = fakeSocket();
  await claimScreen(claims, 'mirror', first, { wait: 0 });
  let connected = false;
  const pending = claimScreen(claims, 'mirror', fakeSocket(), { wait: 100, timeout: 5000 }).then(() => { connected = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(connected, false);
  await pending;
  assert.equal(connected, true);
});
