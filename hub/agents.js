import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PROTOCOL, SUBPROTOCOL, AGENT_PREFIX, createUpgradeVerifier, publicKeyFrom, relayCloseCode } from './protocol.js';

// The hub's side of docs/protocol.md: agents' keys, their control sockets,
// API requests over them, and the relay between a browser's socket and the
// stream socket the agent dials for it.

const PING_MS = 20_000;
const SILENCE_MS = 60_000;
const OPEN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HOLD_MESSAGES = 64;
const HOLD_BYTES = 256 * 1024;
const BROWSER_PING_MS = 25_000;
const STREAM_ID = /^[A-Za-z0-9_-]{22}$/;

export class AgentUnavailable extends Error {}

const sendable = (ws) => ws.readyState === ws.OPEN;

/** Closes ws with the code and reason the other side closed with. */
function closeLike(ws, code, reason) {
  if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return;
  const c = relayCloseCode(code);
  if (c === undefined) ws.close();
  else ws.close(c, Buffer.isBuffer(reason) ? reason.toString() : reason || '');
}

/** Copies every message both ways, unchanged, and closes each side like the other. */
function pair(browser, agent) {
  browser.on('message', (data, isBinary) => { if (sendable(agent)) agent.send(data, { binary: isBinary }); });
  agent.on('message', (data, isBinary) => { if (sendable(browser)) browser.send(data, { binary: isBinary }); });
  browser.on('close', (code, reason) => closeLike(agent, code, reason));
  agent.on('close', (code, reason) => closeLike(browser, code, reason));
  browser.on('error', () => {});
  agent.on('error', () => {});
}

export function createAgentHub({ log, version }) {
  const keys = new Map(); // id -> KeyObject
  const agents = new Map(); // id -> { ws, hello, lastSeen }
  const pendingStreams = new Map(); // stream id -> { agentId, attach(ws), fail(message) }
  const pendingRequests = new Map(); // request id -> { resolve, reject, timer }
  const verify = createUpgradeVerifier({ keyFor: (id) => keys.get(id) || null });
  const rates = new Map(); // id -> metrics interval in ms
  const lastSeen = new Map(); // id -> Unix ms of the last message
  const waiting = new Map(); // id -> [resolve] for callers waiting for the agent to connect
  /** Resolves true once the agent is connected, or false after ms. */
  function whenConnected(id, ms) {
    if (agents.get(id)?.welcomed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const list = waiting.get(id) || [];
      const timer = setTimeout(() => { waiting.set(id, (waiting.get(id) || []).filter((f) => f !== done)); resolve(false); }, ms);
      const done = () => { clearTimeout(timer); resolve(true); };
      list.push(done);
      waiting.set(id, list);
    });
  }
  let hub;

  // Agents offer deflate only from other machines (docs/protocol.md).
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 } },
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    maxPayload: 64 * 1024 * 1024,
  });

  function send(id, msg) {
    const a = agents.get(id);
    if (!a || !a.welcomed || !sendable(a.ws)) throw new AgentUnavailable(`machine ${id} is not connected`);
    a.ws.send(JSON.stringify(msg));
  }

  function onControl(id, ws) {
    const old = agents.get(id);
    if (old) old.ws.close(4000, 'replaced');
    const entry = { ws, hello: null, welcomed: false, lastSeen: Date.now() };
    agents.set(id, entry);
    let pingId = 0;
    const timer = setInterval(() => {
      if (Date.now() - entry.lastSeen > SILENCE_MS) return ws.terminate();
      if (entry.welcomed && sendable(ws)) ws.send(JSON.stringify({ type: 'ping', id: ++pingId }));
    }, PING_MS);
    ws.on('message', (raw, isBinary) => {
      entry.lastSeen = Date.now();
      lastSeen.set(id, entry.lastSeen);
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'hello' && !entry.welcomed) {
        entry.hello = { agent: msg.agent || {}, capabilities: msg.capabilities || {} };
        entry.welcomed = true;
        ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL, hub: { version }, id, metrics: { intervalMs: rates.get(id) ?? 15000 } }));
        log(`agent ${id} connected (${entry.hello.agent.version || '?'}, ${entry.hello.agent.os || '?'})`);
        const offer = hub.onHello?.(id, entry.hello);
        if (offer) {
          ws.send(JSON.stringify(offer));
          log(`agent ${id}: offered version ${offer.version}`);
        }
        for (const done of waiting.get(id) || []) done();
        waiting.delete(id);
      } else if (!entry.welcomed) {
        // Nothing but hello before welcome.
      } else if (msg.type === 'response') {
        const p = pendingRequests.get(msg.id);
        if (!p) return;
        pendingRequests.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ status: Number.isInteger(msg.status) ? msg.status : 502, body: msg.body ?? null });
      } else if (msg.type === 'metrics' && msg.sample && typeof msg.sample === 'object') {
        hub.onMetrics?.(id, Number(msg.t), msg.sample);
      } else if (msg.type === 'stream-failed') {
        pendingStreams.get(msg.stream)?.fail(String(msg.message || 'the machine could not open this stream'));
      }
    });
    ws.on('close', () => {
      clearInterval(timer);
      if (agents.get(id) === entry) {
        agents.delete(id);
        log(`agent ${id} disconnected`);
        for (const p of pendingStreams.values()) if (p.agentId === id) p.fail('the machine disconnected');
      }
    });
    ws.on('error', () => {});
  }

  hub = {
    /** Set by the registry: called with (id, t, sample) for each metrics message. */
    onMetrics: null,
    /** Set by the server: (id, hello) -> an update message to send, or null. */
    onHello: null,

    /** Checks the signature headers of a plain request from an agent; returns its id or throws. */
    verifyRequest(req) { return verify(req); },

    /** Unix ms of the agent's last message, or null. */
    lastSeen(id) { return lastSeen.get(id) ?? null; },

    /** Asks the agent to sample every ms (docs/protocol.md, metrics-rate). */
    setMetricsRate(id, ms) {
      rates.set(id, ms);
      try { send(id, { type: 'metrics-rate', intervalMs: ms }); } catch { /* sent in welcome when it connects */ }
    },

    /** Registers or replaces an agent's raw base64url Ed25519 public key. */
    register(id, publicKey) { keys.set(id, publicKeyFrom(publicKey)); },

    /** Forgets an agent: its key, and its sockets are closed. */
    remove(id) {
      keys.delete(id);
      rates.delete(id);
      lastSeen.delete(id);
      agents.get(id)?.ws.close(4001, 'removed');
    },

    connected(id) { return Boolean(agents.get(id)?.welcomed); },
    hello(id) { return agents.get(id)?.hello || null; },

    /** True for upgrade paths this hub answers for agents. */
    handles(pathname) { return pathname.startsWith(AGENT_PREFIX); },

    /** Handles an upgrade under /agent/v1/: version, signature, then control or stream. */
    upgrade(req, socket, head) {
      const reject = (status, text, extra = '') => {
        socket.write(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      const { pathname } = new URL(req.url, 'http://localhost');
      const offered = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
      if (!offered.includes(SUBPROTOCOL)) return reject(426, 'Upgrade Required', `Deskport-Protocols: ${SUBPROTOCOL}\r\n`);
      let id;
      try {
        id = verify(req);
      } catch (err) {
        log(`agent upgrade ${pathname} refused: ${err.message}`);
        return reject(401, 'Unauthorized');
      }
      if (pathname === `${AGENT_PREFIX}control`) {
        return wss.handleUpgrade(req, socket, head, (ws) => onControl(id, ws));
      }
      const m = /^\/agent\/v1\/stream\/([^/]+)$/.exec(pathname);
      const pending = m && STREAM_ID.test(m[1]) ? pendingStreams.get(m[1]) : null;
      if (!pending || pending.agentId !== id) return reject(404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => pending.attach(ws));
    },

    /**
     * Asks the agent to dial a stream for the browser's socket and relays the
     * two. Messages from the browser before the agent's socket are held.
     */
    openStream(agentId, kind, browser, { query, user, headers, wait = false }) {
      const stream = crypto.randomBytes(16).toString('base64url');
      const held = [];
      let heldBytes = 0;
      let done = false;
      const ping = setInterval(() => { if (sendable(browser)) browser.ping(); }, BROWSER_PING_MS);
      browser.on('close', () => clearInterval(ping));
      const onHeld = (data, isBinary) => {
        held.push([data, isBinary]);
        heldBytes += data.length;
        if (held.length > HOLD_MESSAGES || heldBytes > HOLD_BYTES) fail('too much input before the machine answered', 1013);
      };
      const onEarlyClose = () => { if (!done) { done = true; cleanup(); } };
      const cleanup = () => {
        clearTimeout(timer);
        pendingStreams.delete(stream);
        browser.off('message', onHeld);
        browser.off('close', onEarlyClose);
      };
      const fail = (message, code = 1011) => {
        if (done) return;
        done = true;
        cleanup();
        log(`stream ${kind} for ${agentId} failed: ${message}`);
        if (sendable(browser)) browser.close(code, message.slice(0, 120));
      };
      const timer = setTimeout(() => fail('the machine did not open the stream within 10 s'), OPEN_TIMEOUT_MS);
      browser.on('message', onHeld);
      browser.on('close', onEarlyClose);
      pendingStreams.set(stream, {
        agentId,
        fail,
        attach(agent) {
          if (done) return agent.close(1000);
          done = true;
          cleanup();
          for (const [data, isBinary] of held) agent.send(data, { binary: isBinary });
          pair(browser, agent);
        },
      });
      const open = () => {
        if (done) return;
        try {
          send(agentId, { type: 'open', stream, kind, query, user, ...(headers ? { headers } : {}) });
        } catch (err) {
          fail(err.message);
        }
      };
      // An agent that is expected (this machine's shim, starting or restarting)
      // gets until the open timeout to connect.
      if (wait && !agents.get(agentId)?.welcomed) whenConnected(agentId, OPEN_TIMEOUT_MS).then(open);
      else open();
    },

    /** Sends the browser's API call to the agent; resolves { status, body }. */
    async request(agentId, { method, path, query, body, user }, { wait = false } = {}) {
      if (wait) await whenConnected(agentId, REQUEST_TIMEOUT_MS);
      return new Promise((resolve, reject) => {
        const id = crypto.randomBytes(9).toString('base64url');
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          resolve({ status: 504, body: { error: 'the machine did not answer within 10 s' } });
        }, REQUEST_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        try {
          send(agentId, { type: 'request', id, method, path, query, body: body ?? null, user });
        } catch (err) {
          clearTimeout(timer);
          pendingRequests.delete(id);
          reject(err);
        }
      });
    },

    /**
     * Fetches a file the agent serves (xdg-open in the terminal) and writes it
     * to the HTTP response.
     */
    file(agentId, { token, name, headers, user }, res, { wait = false } = {}) {
      const fake = new FileSink(res);
      hub.openStream(agentId, 'file', fake, { query: new URLSearchParams({ token, name }).toString(), user, headers, wait });
    },

    close() {
      for (const { ws } of agents.values()) ws.terminate();
      for (const p of pendingStreams.values()) p.fail('the hub is shutting down');
    },
  };
  return hub;
}

/**
 * Stands in for a browser's WebSocket for a file stream: the first text
 * message sets the HTTP status and headers, binary messages are the body.
 */
class FileSink {
  constructor(res) {
    this.res = res;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.CLOSING = 2;
    this.readyState = 1;
    this.handlers = { message: [], close: [], error: [] };
    this.started = false;
    res.on('close', () => this.finish(1001));
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
  off(event, fn) { this.handlers[event] = (this.handlers[event] || []).filter((f) => f !== fn); return this; }
  ping() {}

  finish(code, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const fn of this.handlers.close) fn(code, Buffer.from(reason));
  }

  /** Data from the agent. */
  send(data, { binary } = {}) {
    if (!binary && !this.started) {
      this.started = true;
      let head;
      try { head = JSON.parse(data.toString()); } catch { head = { status: 502, headers: {} }; }
      this.res.status(Number.isInteger(head.status) ? head.status : 502);
      for (const [k, v] of Object.entries(head.headers || {})) this.res.setHeader(k, v);
    } else if (binary && this.started) {
      this.res.write(data);
    }
  }

  /** The agent closed its stream: the body is complete (1000) or broken. */
  close(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (!this.started) this.res.status(502).type('text/plain').end('The machine could not send this file.');
    else if (code === 1000) this.res.end();
    else this.res.destroy();
    for (const fn of this.handlers.close) fn(code ?? 1000, Buffer.alloc(0));
  }
}
