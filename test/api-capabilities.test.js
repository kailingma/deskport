import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApi } from '../hub/api.js';

test('API: screen metadata is current, arrays default empty, and local choices stay intact', async (t) => {
  let caps = null;
  const self = { id: 'desk', name: 'Desk', capabilities: { screen: { sources: ['mirror', 'virtual', 'session'] }, terminal: true } };
  const remote = { id: 'joined', name: 'Joined', os: 'linux' };
  const machines = {
    self: { id: self.id, describe: () => self },
    get: () => ({ id: remote.id, describe: () => ({ ...remote, capabilities: caps }) }),
  };
  const app = express();
  const api = createApi({
    hosts: { self }, machines,
    registry: { list: () => [remote], summary: () => ({}) },
    access: { canUse: () => true, canEdit: () => true },
  });
  app.use((req, res, next) => { req.user = { email: 'test@example.com' }; next(); });
  app.use('/h/:id', (req, res, next) => { req.machine = machines.get(req.params.id); next(); }, api);
  app.use((req, res, next) => { req.machine = machines.self; next(); }, api);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = async () => (await (await fetch(`${base}/api/hosts`)).json());

  const [local, offline] = await list();
  assert.equal(local.screen, true);
  assert.deepEqual(local.screenSources, ['mirror', 'virtual', 'session']);
  assert.deepEqual(local.screenEncodings, ['images', 'av1', 'h264']);
  assert.deepEqual(offline.screenSources, []);
  assert.deepEqual(offline.screenEncodings, []);
  assert.equal(offline.screenNote, null);

  caps = { screen: null, terminal: true, notes: { screen: 'No Wayland desktop is signed in.' } };
  const unavailable = (await list())[1];
  assert.equal(unavailable.screen, false);
  assert.deepEqual(unavailable.screenSources, []);
  assert.deepEqual(unavailable.screenEncodings, []);
  assert.equal(unavailable.screenNote, caps.notes.screen);

  caps = { screen: { sources: ['mirror'], encodings: ['images', 'h264'], backend: 'portal' }, terminal: true };
  const ready = (await list())[1];
  assert.equal(ready.screen, true);
  assert.deepEqual(ready.screenSources, caps.screen.sources);
  assert.deepEqual(ready.screenEncodings, caps.screen.encodings);
  assert.equal(ready.screenBackend, 'portal');
  assert.equal(ready.screenNote, null);
  assert.deepEqual((await (await fetch(`${base}/h/joined/api/host`)).json()).capabilities, caps);

  caps = { screen: { sources: ['mirror'] }, terminal: false };
  const older = (await list())[1];
  assert.deepEqual(older.screenEncodings, []);
  assert.equal(older.screenNote, null);
  assert.equal(older.terminal, false);
  assert.equal('screenBackend' in older, false);
});
