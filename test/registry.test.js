import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegistry, JoinError } from '../hub/registry.js';
import { generateAgentKey } from '../hub/protocol.js';

const quiet = () => {};

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
  const reg = createRegistry({ file, agents, reservedIds: ['hub-pc'], log: quiet });
  const key = generateAgentKey().publicKey;

  const t1 = reg.mintToken();
  assert.equal(reg.tokenValid(t1.token), true);
  assert.deepEqual(reg.join({ token: t1.token, name: 'Hub PC', os: 'linux', arch: 'x86_64', publicKey: key }), { id: 'hub-pc-2', protocol: 1 });
  assert.equal(reg.tokenValid(t1.token), false);
  assert.throws(() => reg.join({ token: t1.token, name: 'again', publicKey: key }), (e) => e instanceof JoinError && e.status === 401);

  const t2 = reg.mintToken();
  assert.throws(() => reg.join({ token: t2.token, name: '', publicKey: key }), (e) => e.status === 400);
  assert.throws(() => reg.join({ token: t2.token, name: 'x', publicKey: 'short' }), (e) => e.status === 400);
  // A 400 leaves the token usable.
  assert.equal(reg.join({ token: t2.token, name: 'Local', publicKey: key }).id, 'local-2');
  assert.throws(() => reg.join({ token: 'made-up', name: 'x', publicKey: key }), (e) => e.status === 401);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.map((m) => m.id), ['hub-pc-2', 'local-2']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = fakeAgents();
  const reg2 = createRegistry({ file, agents: again, reservedIds: ['hub-pc'], log: quiet });
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
  const reg = createRegistry({ file: path.join(os.tmpdir(), 'unused-agents.json'), agents: fakeAgents(), log: quiet, now: () => t });
  const { token } = reg.mintToken();
  t = 15 * 60 * 1000 + 1;
  assert.equal(reg.tokenValid(token), false);
  assert.throws(() => reg.join({ token, name: 'x', publicKey: generateAgentKey().publicKey }), (e) => e.status === 401);
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
