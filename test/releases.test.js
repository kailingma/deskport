import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleases, compareVersions, buildMessage } from '../hub/releases.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('versions compare as dotted numbers', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.2') === 0);
  assert.ok(compareVersions('0.1.9', '0.2.0') < 0);
});

test('builds are signed with the release key and offered to older agents only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-rel-'));
  const buildDir = path.join(dir, 'target');
  const bin = path.join(buildDir, 'aarch64-unknown-linux-musl/release/deskport-agent');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'not really an agent');
  const rel = createReleases({ root, keyFile: path.join(dir, 'release.key'), buildDir, log: () => {} });
  assert.equal(fs.statSync(path.join(dir, 'release.key')).mode & 0o777, 0o600);

  // The file does not run here, so its version is the crate's.
  const crate = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'agent/Cargo.toml'), 'utf8'))[1];
  const b = rel.build('linux-aarch64');
  assert.equal(b.version, crate);
  assert.equal(b.size, 19);
  assert.equal(b.sha256, crypto.createHash('sha256').update('not really an agent').digest('hex'));
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rel.publicKey }, format: 'jwk' });
  assert.ok(crypto.verify(null, buildMessage('linux-aarch64', b.version, b.sha256), key, Buffer.from(b.signature, 'base64url')));

  const offer = rel.offerFor({ agent: { os: 'linux', arch: 'aarch64', version: '0.0.1' } });
  assert.equal(offer.type, 'update');
  assert.equal(offer.path, '/agent/v1/download/linux-aarch64');
  assert.equal(rel.offerFor({ agent: { os: 'linux', arch: 'aarch64', version: crate } }), null);
  assert.equal(rel.offerFor({ agent: { os: 'linux', arch: 'x86_64', version: '0.0.1' } }), null, 'no build for that platform');

  // The same key is used after a restart.
  const again = createReleases({ root, keyFile: path.join(dir, 'release.key'), buildDir, log: () => {} });
  assert.equal(again.publicKey, rel.publicKey);
  fs.rmSync(dir, { recursive: true });
});
