import crypto from 'node:crypto';

// Constants and signatures of the hub and agent protocol (docs/protocol.md).

export const PROTOCOL = 1;
export const SUBPROTOCOL = `deskport.${PROTOCOL}`;
export const AGENT_PREFIX = '/agent/v1/';
export const CLOCK_WINDOW_MS = 60_000;
export const NONCE_TTL_MS = 120_000;

/** Stream kinds and the browser endpoint each one serves. */
export const KINDS = { '/ws/screen': 'screen', '/ws/video': 'video', '/ws/term': 'term' };

const signed = (pathAndQuery, time, nonce) => Buffer.from(`deskport-agent-1\n${pathAndQuery}\n${time}\n${nonce}`, 'utf8');

/** A new Ed25519 key pair; publicKey is the raw 32 bytes as base64url. */
export function generateAgentKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ format: 'jwk' }).x,
  };
}

/** The KeyObject for a raw base64url Ed25519 public key. Throws on a bad key. */
export function publicKeyFrom(raw) {
  if (Buffer.from(raw, 'base64url').length !== 32) throw new Error('bad public key');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/** Headers for an agent's upgrade to pathAndQuery. */
export function signUpgrade({ id, privateKeyPem, pathAndQuery, now = Date.now() }) {
  const time = String(now);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const signature = crypto.sign(null, signed(pathAndQuery, time, nonce), privateKeyPem).toString('base64url');
  return { 'Deskport-Agent': id, 'Deskport-Time': time, 'Deskport-Nonce': nonce, 'Deskport-Signature': signature };
}

/**
 * Checks the signature headers of an agent's upgrade. keyFor(id) returns the
 * agent's KeyObject or null. Returns the agent id, or throws with the reason.
 */
export function createUpgradeVerifier({ keyFor, now = () => Date.now() }) {
  const seen = new Map(); // nonce -> time first seen
  return function verify(req) {
    const id = req.headers['deskport-agent'];
    const time = req.headers['deskport-time'];
    const nonce = req.headers['deskport-nonce'];
    const signature = req.headers['deskport-signature'];
    if (!id || !time || !nonce || !signature) throw new Error('unsigned');
    const key = keyFor(id);
    if (!key) throw new Error(`unknown agent ${JSON.stringify(id)}`);
    const t = now();
    if (!/^\d{1,16}$/.test(time) || Math.abs(t - Number(time)) > CLOCK_WINDOW_MS) throw new Error('clock off by more than 60 s');
    for (const [n, at] of seen) if (t - at > NONCE_TTL_MS) seen.delete(n); else break;
    if (seen.has(nonce)) throw new Error('nonce reused');
    let ok = false;
    try { ok = crypto.verify(null, signed(req.url, time, nonce), key, Buffer.from(signature, 'base64url')); } catch { ok = false; }
    if (!ok) throw new Error('bad signature');
    seen.set(nonce, t);
    return id;
  };
}

/** The close code to pass on to the other side of a relayed stream (docs/protocol.md). */
export function relayCloseCode(code) {
  if (code === 1005) return undefined;
  if (code === 1000 || code === 1001 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}
