import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegistry, JoinError } from '../hub/registry.js';
import { generateAgentKey } from '../hub/protocol.js';
import { createAccess } from '../hub/access.js';

const quiet = () => {};
const issuer = 'boss@x.io';
const adminAccess = { canAddMachines: (email) => email === issuer, grantEdit: () => {} };

function fakeAgents() {
  const keys = new Map();
  const rates = [];
  return {
    keys,
    rates,
    register: (id, k) => keys.set(id, k),
    remove: (id) => keys.delete(id),
    connected: (id) => id === 'online-box',
    lastSeen: () => null,
    setMetricsRate: (id, ms) => rates.push([id, ms]),
    onMetrics: null,
  };
}

test('join: one use per token, unique ids, saved and loaded again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-reg-'));
  const file = path.join(dir, 'agents.json');
  const agents = fakeAgents();
  const reg = createRegistry({ file, agents, access: adminAccess, reservedIds: ['hub-pc'], log: quiet });
  const key = generateAgentKey().publicKey;

  const t1 = reg.mintToken(issuer);
  assert.equal(reg.tokenValid(t1.token), true);
  assert.deepEqual(reg.join({ token: t1.token, name: 'Hub PC', os: 'linux', arch: 'x86_64', publicKey: key }), { id: 'hub-pc-2', protocol: 1 });
  assert.equal(reg.tokenValid(t1.token), false);
  assert.throws(() => reg.join({ token: t1.token, name: 'again', publicKey: key }), (e) => e instanceof JoinError && e.status === 401);

  const t2 = reg.mintToken(issuer);
  assert.throws(() => reg.join({ token: t2.token, name: '', publicKey: key }), (e) => e.status === 400);
  assert.throws(() => reg.join({ token: t2.token, name: 'x', publicKey: 'short' }), (e) => e.status === 400);
  // A 400 leaves the token usable.
  assert.equal(reg.join({ token: t2.token, name: 'Local', publicKey: key }).id, 'local-2');
  assert.throws(() => reg.join({ token: 'made-up', name: 'x', publicKey: key }), (e) => e.status === 401);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.map((m) => m.id), ['hub-pc-2', 'local-2']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = fakeAgents();
  const reg2 = createRegistry({ file, agents: again, access: adminAccess, reservedIds: ['hub-pc'], log: quiet });
  assert.deepEqual(reg2.list().map((m) => [m.id, m.status]), [['hub-pc-2', 'offline'], ['local-2', 'offline']]);
  assert.equal(again.keys.size, 2);
  assert.equal(reg2.remove('local-2'), true);
  assert.equal(reg2.remove('local-2'), false);
  assert.equal(again.keys.has('local-2'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => m.id), ['hub-pc-2']);
  fs.rmSync(dir, { recursive: true });
});

test('tokens expire after 15 minutes', () => {
  let t = 0;
  const reg = createRegistry({ file: path.join(os.tmpdir(), 'unused-agents.json'), agents: fakeAgents(), access: adminAccess, log: quiet, now: () => t });
  const { token } = reg.mintToken(issuer);
  t = 15 * 60 * 1000 + 1;
  assert.equal(reg.tokenValid(token), false);
  assert.throws(() => reg.join({ token, name: 'x', publicKey: generateAgentKey().publicKey }), (e) => e.status === 401);
});

test('join: the token issuer gets Edit, not an identity claimed in the body', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-join-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const accessFile = path.join(dir, 'access.json');
  const access = createAccess({ file: accessFile, admins: [issuer] });
  access.setPerson('pat@x.io', [], { readMachines: ['old-machine'], addMachines: true });
  access.setPerson('other@x.io', []);
  const agents = fakeAgents();
  const reg = createRegistry({ file: path.join(dir, 'agents.json'), agents, access, log: quiet });
  const token = reg.mintToken(' Pat@X.io ').token;
  const body = { token, name: 'New Machine', publicKey: generateAgentKey().publicKey, issuer: 'other@x.io', owner: 'other@x.io', email: issuer };
  const joined = reg.join(body);
  assert.equal(access.canEdit('pat@x.io', joined.id), true);
  assert.equal(access.canEdit('other@x.io', joined.id), false);
  assert.equal(access.canRead('pat@x.io', 'old-machine'), true);
  assert.equal(access.canAddMachines('pat@x.io'), true);
  assert.equal(createAccess({ file: accessFile, admins: [issuer] }).canEdit('pat@x.io', joined.id), true);
  assert.throws(() => reg.mintToken('other@x.io'), (e) => e.status === 403);
  const adminToken = reg.mintToken(issuer).token;
  reg.join({ ...body, token: adminToken, name: 'Admin Machine' });
  assert.equal(access.list().filter((p) => p.email === issuer).length, 1, 'admin does not acquire a stored person row');
});

test('join: revoking add permission or removing the issuer invalidates outstanding tokens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-join-revoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const access = createAccess({ file: path.join(dir, 'access.json'), admins: [issuer] });
  const reg = createRegistry({ file: path.join(dir, 'agents.json'), agents: fakeAgents(), access, log: quiet });
  const publicKey = generateAgentKey().publicKey;
  for (const revoke of [() => access.setPerson('pat@x.io', []), () => access.removePerson('pat@x.io')]) {
    access.setPerson('pat@x.io', [], { addMachines: true });
    const { token } = reg.mintToken('pat@x.io');
    revoke();
    assert.equal(reg.tokenValid(token), false, 'revoked tokens cannot download an agent either');
    assert.throws(() => reg.join({ token, name: 'Machine', publicKey }), (e) => e.status === 401);
    assert.deepEqual(reg.list(), []);
    access.setPerson('pat@x.io', [], { addMachines: true });
    assert.equal(reg.tokenValid(token), false, 'the refused join consumes the token');
  }
});

test('join: a failed ownership grant rolls the machine back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-join-failed-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const agents = fakeAgents();
  const file = path.join(dir, 'agents.json');
  const access = { canAddMachines: () => true, grantEdit: () => { throw new Error('could not save access'); } };
  const reg = createRegistry({ file, agents, access, log: quiet });
  const { token } = reg.mintToken(issuer);
  assert.throws(() => reg.join({ token, name: 'Machine', publicKey: generateAgentKey().publicKey }), /could not save access/);
  assert.deepEqual(reg.list(), []);
  assert.equal(agents.keys.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  assert.equal(reg.tokenValid(token), false);
});

test('metrics: an hour kept, thinned to 5 s after five minutes, live rate on request', () => {
  let t = 0;
  const agents = fakeAgents();
  const reg = createRegistry({ file: path.join(os.tmpdir(), 'unused-agents.json'), agents, reservedIds: ['pc'], log: quiet, now: () => t });
  // One sample a second for 70 minutes.
  for (t = 0; t <= 70 * 60 * 1000; t += 1000) agents.onMetrics('pc', t, { n: t });
  t -= 1000;
  const { samples, intervalMs } = reg.metrics('pc');
  assert.equal(intervalMs, 15000);
  assert.ok(samples[0].t >= t - 60 * 60 * 1000, 'nothing older than an hour');
  const recent = samples.filter((s) => s.t > t - 5 * 60 * 1000);
  const old = samples.filter((s) => s.t <= t - 5 * 60 * 1000);
  assert.equal(recent.length, 300);
  assert.ok(old.length >= 655 && old.length <= 661, `old samples: ${old.length}`);
  assert.deepEqual(reg.metrics('pc', { since: t - 3000 }).samples.map((s) => s.t), [t - 2000, t - 1000, t]);
  // Samples for machines nobody knows are dropped.
  agents.onMetrics('stranger', t, {});
  assert.equal(reg.metrics('stranger').samples.length, 0);

  assert.equal(reg.metrics('pc', { live: true }).intervalMs, 1000);
  reg.metrics('pc', { live: true });
  assert.deepEqual(agents.rates, [['pc', 1000]], 'asked once while live');
});
