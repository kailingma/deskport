import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAccess, AccessError, ALL } from '../hub/access.js';
import { createApi } from '../hub/api.js';

const quiet = () => {};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-access-')), 'access.json');

test('admins: DESKPORT_ADMIN_EMAILS, else the allowed list, else everyone', () => {
  const file = tmpFile();
  const a = createAccess({ file, admins: ['boss@x.io'], allowed: ['boss@x.io', 'pat@x.io'], log: quiet });
  assert.equal(a.isAdmin('boss@x.io'), true);
  assert.equal(a.isAdmin('pat@x.io'), false);
  assert.equal(a.mayEnter('pat@x.io'), true);
  assert.equal(a.mayEnter('stranger@x.io'), false);

  const b = createAccess({ file, allowed: ['pat@x.io'], log: quiet });
  assert.equal(b.isAdmin('pat@x.io'), true);
  assert.equal(b.isAdmin('other@x.io'), false);

  const c = createAccess({ file, log: quiet });
  assert.equal(c.isAdmin('anyone@x.io'), true);
  assert.equal(c.mayEnter('anyone@x.io'), true);
});

test('people get the machines they are given, saved and loaded again', () => {
  const file = tmpFile();
  const a = createAccess({ file, admins: ['boss@x.io'], log: quiet });
  let changes = 0;
  a.onChange(() => changes++);

  assert.equal(a.mayEnter('pat@x.io'), false);
  assert.deepEqual(a.setPerson(' Pat@X.io ', ['laptop', 'server', 'laptop', 'Bad Id']), { email: 'pat@x.io', admin: false, machines: ['laptop', 'server'], readMachines: [], addMachines: false });
  assert.equal(a.mayEnter('pat@x.io'), true);
  assert.equal(a.canUse('pat@x.io', 'laptop'), true);
  assert.equal(a.canUse('pat@x.io', 'hub-pc'), false);
  assert.equal(a.canUse('boss@x.io', 'hub-pc'), true);

  a.setPerson('sam@x.io', ['laptop', ALL]);
  assert.equal(a.canUse('sam@x.io', 'anything-later'), true);
  assert.throws(() => a.setPerson('boss@x.io', []), AccessError);
  assert.throws(() => a.setPerson('not-an-email', []), AccessError);
  assert.throws(() => a.setPerson('x@y.z', 'laptop'), AccessError);

  a.forgetMachine('laptop');
  assert.equal(a.canUse('pat@x.io', 'laptop'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(changes, 3);

  const again = createAccess({ file, admins: ['boss@x.io'], log: quiet });
  assert.deepEqual(again.list(), [
    { email: 'boss@x.io', admin: true, machines: [ALL], readMachines: [], addMachines: true },
    { email: 'pat@x.io', admin: false, machines: ['server'], readMachines: [], addMachines: false },
    { email: 'sam@x.io', admin: false, machines: [ALL], readMachines: [], addMachines: false },
  ]);
  assert.equal(again.removePerson('PAT@x.io'), true);
  assert.equal(again.removePerson('pat@x.io'), false);
  assert.equal(again.mayEnter('pat@x.io'), false);
});

test('Read, Edit and adding machines are independent, persisted grants', () => {
  const file = tmpFile();
  const a = createAccess({ file, admins: ['boss@x.io'] });
  a.setPerson('pat@x.io', ['laptop'], { readMachines: ['server', 'laptop'], addMachines: true });
  assert.equal(a.canRead('pat@x.io', 'server'), true);
  assert.equal(a.canUse('pat@x.io', 'server'), true);
  assert.equal(a.canEdit('pat@x.io', 'server'), false);
  assert.equal(a.canEdit('pat@x.io', 'laptop'), true);
  assert.equal(a.canAddMachines('pat@x.io'), true);
  assert.equal(a.canAddMachines('boss@x.io'), true);
  assert.deepEqual(a.list()[1].readMachines, ['server']);
  assert.throws(() => a.setPerson('pat@x.io', [], { readMachines: 'server' }), AccessError);
  assert.throws(() => a.setPerson('pat@x.io', [], { addMachines: 'true' }), AccessError);

  const again = createAccess({ file, admins: ['boss@x.io'] });
  assert.deepEqual(again.list(), a.list());
  again.setPerson('pat@x.io', ['laptop'], { readMachines: [ALL], addMachines: true });
  assert.equal(again.canRead('pat@x.io', 'future-machine'), true);
  assert.equal(again.canEdit('pat@x.io', 'future-machine'), false);
  again.grantEdit('pat@x.io', 'new-machine');
  assert.equal(again.canEdit('pat@x.io', 'new-machine'), true);
  again.forgetMachine('new-machine');
  assert.equal(again.canEdit('pat@x.io', 'new-machine'), false);
  assert.equal(again.canRead('pat@x.io', 'new-machine'), true, 'all Read remains');
  again.removePerson('pat@x.io');
  assert.equal(again.canAddMachines('pat@x.io'), false);
  assert.throws(() => again.grantEdit('pat@x.io', 'new-machine'), AccessError);
});

test('old access.json grants stay Edit and lists cannot mutate stored permissions', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ people: { 'pat@x.io': { machines: ['laptop'] }, 'sam@x.io': { machines: [ALL] } } }));
  const a = createAccess({ file, admins: ['boss@x.io'] });
  assert.equal(a.canEdit('pat@x.io', 'laptop'), true);
  assert.equal(a.canEdit('sam@x.io', 'added-later'), true);
  assert.equal(a.canAddMachines('sam@x.io'), false);
  a.list().find((p) => p.email === 'pat@x.io').machines.push('server');
  assert.equal(a.canEdit('pat@x.io', 'server'), false);
  a.setPerson('read@x.io', [], { readMachines: ['server'] });
  a.forgetMachine('server');
  assert.equal(a.canRead('read@x.io', 'server'), false);
});

// The API with fake machines: what each person sees and may do.
async function withApi(fn) {
  const access = createAccess({ file: tmpFile(), admins: ['boss@x.io'], log: quiet });
  access.setPerson('pat@x.io', ['laptop']);
  const forwarded = [];
  const machine = (id) => ({
    id, describe: () => ({ id, name: id, capabilities: { terminal: true } }), metrics: () => ({ id, samples: [] }),
    request: async (r) => { forwarded.push([id, r]); return { status: 200, body: { state: 'running' } }; },
    file: (req, res) => res.json({ file: req.params.name }),
  });
  const removed = [];
  const issuers = [];
  const machines = { self: machine('hub-pc'), get: (id) => (['hub-pc', 'laptop', 'server'].includes(id) ? machine(id) : null) };
  const registry = {
    list: () => [{ id: 'laptop', name: 'Laptop', os: 'linux' }, { id: 'server', name: 'Server', os: 'linux' }],
    summary: () => ({}),
    remove: (id) => { removed.push(id); return true; },
    mintToken: (email) => { issuers.push(email); return { token: 't', expiresAt: 0 }; },
  };
  const hosts = { self: { id: 'hub-pc', name: 'Hub PC' } };
  const app = express();
  app.use((req, res, next) => { req.user = { email: req.headers['x-test-user'] }; next(); });
  const api = createApi({ hosts, registry, prefs: { get: () => ({}), set: () => ({}) }, machines, access });
  app.use((req, res, next) => { req.machine = machines.self; next(); }, api);
  app.use('/h/:hostId', (req, res, next) => { req.machine = machines.get(req.params.hostId); next(); }, api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'x-test-user': user, origin: base, 'content-type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try { await fn({ call, access, removed, forwarded, issuers }); } finally { server.close(); }
}

test('API: the list, machine routes and admin routes follow access', async () => {
  await withApi(async ({ call, access, removed }) => {
    assert.deepEqual((await call('boss@x.io', 'GET', '/api/hosts')).body.map((m) => m.id), ['hub-pc', 'laptop', 'server']);
    assert.deepEqual((await call('pat@x.io', 'GET', '/api/hosts')).body.map((m) => m.id), ['laptop']);
    assert.equal((await call('pat@x.io', 'GET', '/api/me')).body.admin, false);
    assert.equal((await call('boss@x.io', 'GET', '/api/me')).body.admin, true);

    assert.equal((await call('pat@x.io', 'GET', '/h/laptop/api/metrics')).status, 200);
    assert.equal((await call('pat@x.io', 'GET', '/h/server/api/metrics')).status, 403);
    assert.equal((await call('pat@x.io', 'GET', '/api/host')).status, 403);

    assert.equal((await call('pat@x.io', 'POST', '/api/join-tokens')).status, 403);
    assert.equal((await call('pat@x.io', 'DELETE', '/api/hosts/laptop')).status, 403);
    assert.equal((await call('pat@x.io', 'GET', '/api/admin/people')).status, 403);
    assert.equal((await call('pat@x.io', 'PUT', '/api/admin/people/pat@x.io', { machines: [ALL] })).status, 403);
    assert.equal((await call('boss@x.io', 'POST', '/api/join-tokens')).status, 200);

    const people = (await call('boss@x.io', 'GET', '/api/admin/people')).body;
    assert.deepEqual(people.machines.map((m) => m.id), ['hub-pc', 'laptop', 'server']);
    assert.equal((await call('boss@x.io', 'PUT', '/api/admin/people/pat@x.io', { machines: ['server'] })).status, 200);
    assert.deepEqual((await call('pat@x.io', 'GET', '/api/hosts')).body.map((m) => m.id), ['server']);
    assert.equal((await call('boss@x.io', 'PUT', '/api/admin/people/nope', { machines: [] })).status, 400);

    assert.equal((await call('boss@x.io', 'DELETE', '/api/hosts/server')).status, 200);
    assert.deepEqual(removed, ['server']);
    assert.equal(access.canUse('pat@x.io', 'server'), false);
    assert.equal((await call('boss@x.io', 'DELETE', '/api/admin/people/pat@x.io')).status, 200);
    assert.equal(access.mayEnter('pat@x.io'), false);
  });
});

test('API: Read views output but cannot control; adding machines does not confer admin', async () => {
  await withApi(async ({ call, access, forwarded, issuers }) => {
    access.setPerson('pat@x.io', ['laptop'], { readMachines: ['hub-pc', 'server'], addMachines: true });
    const me = (await call('pat@x.io', 'GET', '/api/me')).body;
    assert.equal(me.admin, false);
    assert.equal(me.canAddMachines, true);
    assert.equal((await call('boss@x.io', 'GET', '/api/me')).body.canAddMachines, true);
    assert.deepEqual((await call('pat@x.io', 'GET', '/api/hosts')).body.map((m) => [m.id, m.access]), [['hub-pc', 'read'], ['laptop', 'edit'], ['server', 'read']]);
    assert.equal((await call('pat@x.io', 'GET', '/api/host')).body.access, 'read');
    assert.equal((await call('pat@x.io', 'GET', '/h/laptop/api/host')).body.access, 'edit');
    for (const p of ['/api/session', '/api/monitors', '/api/metrics', '/api/files/t/file.txt']) {
      assert.equal((await call('pat@x.io', 'GET', p)).status, 200, p);
    }
    const before = forwarded.length;
    assert.equal((await call('pat@x.io', 'POST', '/api/session/stop')).status, 403);
    assert.equal(forwarded.length, before, 'a denied mutation never reaches the agent');
    assert.equal((await call('pat@x.io', 'POST', '/h/laptop/api/session/stop')).status, 200);
    assert.equal((await call('pat@x.io', 'POST', '/h/laptop/api/session/stop', null, { origin: 'https://other.example' })).status, 403);
    assert.equal((await call('pat@x.io', 'POST', '/api/join-tokens')).status, 200);
    assert.deepEqual(issuers, ['pat@x.io']);
    assert.equal((await call('pat@x.io', 'POST', '/api/join-tokens', null, { origin: 'https://other.example' })).status, 403);
    assert.equal((await call('pat@x.io', 'GET', '/api/admin/people')).status, 403);
    assert.equal((await call('pat@x.io', 'DELETE', '/api/hosts/laptop')).status, 403);
    const saved = await call('boss@x.io', 'PUT', '/api/admin/people/pat@x.io', { machines: [], readMachines: [ALL], addMachines: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.readMachines, [ALL]);
    assert.equal((await call('pat@x.io', 'POST', '/api/join-tokens')).status, 403);
    assert.equal((await call('pat@x.io', 'POST', '/h/laptop/api/session/stop')).status, 403);
    assert.equal((await call('boss@x.io', 'PUT', '/api/admin/people/pat@x.io', { machines: [], addMachines: 1 })).status, 400);
  });
});
