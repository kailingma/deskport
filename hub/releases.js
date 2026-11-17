import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Agent builds this hub hands out (docs/protocol.md, Updates): the static
// binaries `npm run build:agent` makes, each described by version, size,
// SHA-256 and a signature with the hub's release key. The key is made on
// first start and kept in release.key in the config directory (mode 600).

export const PLATFORMS = {
  'linux-x86_64': 'x86_64-unknown-linux-musl',
  'linux-aarch64': 'aarch64-unknown-linux-musl',
  'windows-x86_64': 'x86_64-pc-windows-gnu',
};

/** Compares dotted version numbers: <0, 0 or >0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export const buildMessage = (platform, version, sha256) => Buffer.from(`deskport-agent-build-1\n${platform}\n${version}\n${sha256}`, 'utf8');

function loadKey(file, log) {
  if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  log(`releases: made a release key in ${file}`);
  return privateKey;
}

export function createReleases({ root, keyFile, log, buildDir = path.join(root, 'agent/target') }) {
  const key = loadKey(keyFile, log);
  const publicKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const cargo = fs.readFileSync(path.join(root, 'agent/Cargo.toml'), 'utf8');
  const crateVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] || '0.0.0';
  const cache = new Map(); // platform -> { stamp, build }

  /** The version a binary reports, when it runs here; else the crate's. */
  function versionOf(file) {
    try {
      const out = execFileSync(file, ['version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      return /deskport-agent (\S+)/.exec(out)?.[1] || crateVersion;
    } catch {
      return crateVersion;
    }
  }

  return {
    publicKey,

    fileFor(platform) {
      const triple = PLATFORMS[platform];
      const name = platform.startsWith('windows-') ? 'deskport-agent.exe' : 'deskport-agent';
      const file = triple && path.join(buildDir, triple, 'release', name);
      return file && fs.existsSync(file) ? file : null;
    },

    /** { platform, version, sha256, size, signature } of the build, or null. */
    build(platform) {
      const file = this.fileFor(platform);
      if (!file) return null;
      const st = fs.statSync(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = cache.get(platform);
      if (hit?.stamp === stamp) return hit.build;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const version = versionOf(file);
      const signature = crypto.sign(null, buildMessage(platform, version, sha256), key).toString('base64url');
      const build = { platform, version, sha256, size: st.size, signature };
      cache.set(platform, { stamp, build });
      return build;
    },

    /** The update message for an agent's hello, or null when it is current. */
    offerFor(hello) {
      const a = hello?.agent || {};
      const b = this.build(`${a.os}-${a.arch}`);
      if (!b || !a.version || compareVersions(b.version, a.version) <= 0) return null;
      return { type: 'update', version: b.version, path: `/agent/v1/download/${b.platform}`, sha256: b.sha256, size: b.size, signature: b.signature };
    },
  };
}
