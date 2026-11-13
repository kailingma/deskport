import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostRegistry, routeFor, slugify, LOCAL } from '../hub/hosts.js';

test('routeFor splits host-addressed paths', () => {
  assert.deepEqual(routeFor('/ws/screen'), { hostId: LOCAL, path: '/ws/screen' });
  assert.deepEqual(routeFor('/h/laptop/ws/term'), { hostId: 'laptop', path: '/ws/term' });
  assert.deepEqual(routeFor('/h/laptop'), { hostId: 'laptop', path: '/' });
});

test('slugify makes path-safe ids', () => {
  assert.equal(slugify('My PC_01'), 'my-pc-01');
  assert.equal(slugify('---'), 'host');
});

test('the registry serves itself and lists other hosts as not implemented', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-hosts-'));
  const hostsFile = path.join(dir, 'hosts.json');
  fs.writeFileSync(hostsFile, JSON.stringify([
    { id: 'laptop', name: 'Laptop', url: 'https://laptop.example.com/x' },
    { id: 'Bad Id', url: 'https://x.example.com' },
    { id: 'plain', url: 'http://insecure.example.com' },
  ]));
  const logs = [];
  const hosts = createHostRegistry({
    config: { self: { id: 'desk', name: 'Desk' }, ui: true, hostsFile },
    sources: ['mirror'],
    version: '1.0.0',
    log: (m) => logs.push(m),
  });
  assert.deepEqual(hosts.list().map((h) => [h.id, h.local, h.status]), [['desk', true, 'online'], ['laptop', false, 'not-implemented']]);
  assert.equal(hosts.get(LOCAL).local, true);
  assert.equal(hosts.get('desk').local, true);
  assert.deepEqual(hosts.get('laptop'), { id: 'laptop', name: 'Laptop', url: 'https://laptop.example.com', local: false });
  assert.equal(hosts.get('nope'), null);
  assert.equal(hosts.describe().capabilities.screen.sources[0], 'mirror');
  assert.equal(logs.filter((m) => m.includes('skipping')).length, 2);
  fs.rmSync(dir, { recursive: true });
});
