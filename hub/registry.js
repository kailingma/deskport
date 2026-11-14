import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { slugify, LOCAL } from './hosts.js';
import { publicKeyFrom, PROTOCOL } from './protocol.js';

// Machines that joined this hub (docs/protocol.md, Joining): their keys in
// agents.json in the config directory, one-use join tokens, and an hour of
// metrics samples per machine in memory.

const TOKEN_TTL_MS = 15 * 60 * 1000;
const KEEP_MS = 60 * 60 * 1000;
// Samples older than this are thinned to one per OLD_STEP_MS.
const RECENT_MS = 5 * 60 * 1000;
const OLD_STEP_MS = 5000;
const SLOW_MS = 15000;
const LIVE_MS = 1000;
// How long a dashboard keeps a machine at the live rate after its last request.
const LIVE_HOLD_MS = 30_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export class JoinError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createRegistry({ file, agents, reservedIds = [], log, now = () => Date.now() }) {
  const machines = new Map(); // id -> { id, name, os, arch, publicKey, joinedAt }
  const tokens = new Map(); // sha256 -> expires
  const metrics = new Map(); // id -> [{ t, sample }]
  const live = new Map(); // id -> timer that ends the live rate

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify([...machines.values()], null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  if (fs.existsSync(file)) {
    try {
      for (const m of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        try {
          agents.register(m.id, m.publicKey);
          machines.set(m.id, m);
        } catch (err) {
          log(`agents.json: skipping ${JSON.stringify(m?.id)}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`agents.json: not read: ${err.message}`);
    }
  }

  function uniqueId(name) {
    const base = slugify(name).slice(0, 60);
    const taken = (id) => machines.has(id) || id === LOCAL || reservedIds.includes(id);
    if (!taken(base)) return base;
    for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  }

  agents.onMetrics = (id, t, sample) => {
    if (!machines.has(id) && !reservedIds.includes(id)) return;
    const at = now();
    const list = [...(metrics.get(id) || []), { t: Number.isFinite(t) ? t : at, received: at, sample }];
    // Drop what is older than an hour, and keep one sample per 5 s of what is older than five minutes.
    const kept = [];
    let last = -Infinity;
    for (const s of list) {
      if (s.received < at - KEEP_MS) continue;
      if (s.received > at - RECENT_MS || s.received - last >= OLD_STEP_MS) {
        kept.push(s);
        last = s.received;
      }
    }
    metrics.set(id, kept);
  };

  return {
    /** A new join token; only its hash is kept. */
    mintToken() {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = now();
      for (const [h, exp] of tokens) if (exp < t) tokens.delete(h);
      tokens.set(sha256(token), t + TOKEN_TTL_MS);
      return { token, expiresAt: t + TOKEN_TTL_MS };
    },

    /** Whether token is a join token that is still usable (it is not used up). */
    tokenValid(token) {
      const exp = tokens.get(sha256(String(token || '')));
      return Boolean(exp && exp >= now());
    },

    /** POST /agent/v1/join. Returns { id, protocol } or throws JoinError. */
    join(body) {
      const name = text(body?.name, 100).trim();
      if (!name) throw new JoinError(400, 'name is required');
      try { publicKeyFrom(String(body?.publicKey || '')); } catch { throw new JoinError(400, 'publicKey must be a raw Ed25519 key, base64url'); }
      const h = sha256(String(body?.token || ''));
      const exp = tokens.get(h);
      tokens.delete(h);
      if (!exp || exp < now()) throw new JoinError(401, 'unknown, used or expired join token');
      const id = uniqueId(name);
      const m = { id, name, os: text(body.os, 32), arch: text(body.arch, 32), publicKey: body.publicKey, joinedAt: new Date(now()).toISOString() };
      agents.register(id, m.publicKey);
      machines.set(id, m);
      save();
      log(`machine ${id} joined (${m.os} ${m.arch})`);
      return { id, protocol: PROTOCOL };
    },

    get(id) { return machines.get(id) || null; },

    /** CPU and memory use from the last two samples, for the machine list. */
    summary(id) {
      const list = metrics.get(id) || [];
      const [a, b] = list.slice(-2);
      const out = {};
      const last = b || a;
      if (!last) return out;
      const m = last.sample.memory;
      if (m?.totalB) out.memPct = Math.round((1 - m.availableB / m.totalB) * 1000) / 10;
      const ta = a?.sample.cpu?.total;
      const tb = b?.sample.cpu?.total;
      if (ta && tb) {
        const sum = (t) => t.reduce((x, y) => x + y, 0);
        const idle = (t) => (t[3] || 0) + (t[4] || 0);
        const total = sum(tb) - sum(ta);
        if (total > 0) out.cpuPct = Math.round((1 - (idle(tb) - idle(ta)) / total) * 1000) / 10;
      }
      if (Number.isFinite(last.sample.uptimeS)) out.uptimeS = last.sample.uptimeS;
      out.sampledAt = last.t;
      return out;
    },

    list() {
      return [...machines.values()].map((m) => ({
        id: m.id,
        name: m.name,
        os: m.os,
        arch: m.arch,
        joinedAt: m.joinedAt,
        status: agents.connected(m.id) ? 'online' : 'offline',
        lastSeen: agents.lastSeen(m.id),
      }));
    },

    remove(id) {
      if (!machines.delete(id)) return false;
      agents.remove(id);
      metrics.delete(id);
      clearTimeout(live.get(id));
      live.delete(id);
      save();
      log(`machine ${id} removed`);
      return true;
    },

    /**
     * Samples since `since` (Unix ms). With live, the machine samples every
     * second for the next 30 s.
     */
    metrics(id, { since = 0, live: wantLive = false } = {}) {
      if (wantLive) {
        if (!live.has(id)) agents.setMetricsRate(id, LIVE_MS);
        clearTimeout(live.get(id));
        live.set(id, setTimeout(() => { live.delete(id); agents.setMetricsRate(id, SLOW_MS); }, LIVE_HOLD_MS).unref());
      }
      const list = metrics.get(id) || [];
      return { intervalMs: live.has(id) ? LIVE_MS : SLOW_MS, samples: list.filter((s) => s.t > since).map(({ t, sample }) => ({ t, sample })) };
    },
  };
}
