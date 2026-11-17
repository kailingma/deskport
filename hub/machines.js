import { AgentUnavailable } from './agents.js';
import { LOCAL } from './hosts.js';

// One object per machine the hub can show: this machine (its host work in
// the hub's process or in the agent shim) and every machine that joined. The
// API and the WebSocket router talk to a machine only through this object.
//
//   describe()                 what GET /api/host answers
//   request({method, path, query, user})  -> { status, body }
//   file(req, res)             GET /api/files/:token/:name
//   stream(kind, ws, req, { readOnly })  a browser's /ws/<kind> socket
//   offers(kind)               whether stream(kind) can work
//   metrics({since, live})     recent metrics samples

const FILE_HEADERS = ['range', 'if-none-match', 'if-modified-since'];
const unavailable = (err) => {
  if (err instanceof AgentUnavailable) return { status: 503, body: { error: err.message } };
  throw err;
};

/** A machine whose host work runs in an agent (the shim or a joined machine). */
function agentMachine(id, agents, registry, describe, { wait = false } = {}) {
  return {
    id,
    describe,
    request: (r) => agents.request(id, r, { wait }).catch(unavailable),
    file: (req, res) => agents.file(id, {
      token: req.params.token,
      name: req.params.name,
      headers: Object.fromEntries(FILE_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
      user: { email: req.user.email },
    }, res, { wait }),
    stream: (kind, ws, req, { readOnly = false } = {}) => agents.openStream(id, kind, ws, {
      query: new URL(req.url, 'http://localhost').search,
      user: { email: req.user.email },
      wait,
      readOnly,
    }),
    metrics: (opts) => registry.metrics(id, opts),
  };
}

export function createMachines({ hosts, agents, registry, local }) {
  const selfId = hosts.self.id;
  const self = local
    ? {
        id: selfId,
        describe: () => hosts.describe(),
        request: async ({ method, path }) => {
          const handler = local.requests[`${method} ${path}`];
          return handler ? handler() : { status: 404, body: { error: 'not found' } };
        },
        file: (req, res) => local.opener.serveFile(req, res),
        stream: (kind, ws, req, options) => local.streams[kind](ws, req.url.replace(/^\/h\/[^/?]+/, ''), options),
        metrics: (opts) => registry.metrics(selfId, opts),
      }
    // The shim is always expected, so requests wait for it while it (re)starts.
    : agentMachine(selfId, agents, registry, () => hosts.describe(), { wait: true });
  self.offers = () => true;

  return {
    self,

    /** The machine for an id from a path ("local" is this machine), or null. */
    get(id) {
      if (id === LOCAL || id === selfId) return self;
      const m = registry.get(id);
      if (!m) return null;
      const machine = agentMachine(m.id, agents, registry, () => {
        const hello = agents.hello(m.id);
        return {
          id: m.id,
          name: m.name,
          version: hello?.agent?.version ?? null,
          ui: false,
          os: m.os,
          arch: m.arch,
          status: agents.connected(m.id) ? 'online' : 'offline',
          capabilities: hello?.capabilities ?? null,
        };
      });
      machine.offers = (kind) => {
        const caps = agents.hello(m.id)?.capabilities;
        if (!caps) return true; // offline: the stream fails with the reason
        if (kind === 'term') return Boolean(caps.terminal);
        if (kind === 'screen' || kind === 'video') return Boolean(caps.screen);
        return false;
      };
      return machine;
    },
  };
}
