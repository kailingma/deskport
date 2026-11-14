import express from 'express';
import { sameOrigin } from './auth.js';

/**
 * The JSON API of one machine. server.js mounts it at / for this machine and
 * at /h/<id>/ for any machine, with req.machine set (hub/machines.js), so a UI
 * can address every machine the same way.
 *
 *   GET    /api/me             who is signed in, and where
 *   GET    /api/host           the machine's id, name, version and capabilities
 *   GET    /api/hosts          every machine this hub knows
 *   DELETE /api/hosts/:id      remove a machine that joined (same-origin only)
 *   POST   /api/join-tokens    a one-use token for joining a machine (same-origin only)
 *   GET    /api/prefs         the signed-in person's machine order, list or grid, and sort
 *   PUT    /api/prefs         change them (same-origin only)
 *   GET    /api/metrics        the machine's recent metrics (?since=<ms>&live=1)
 *   GET    /api/session        state of the separate desktop
 *   POST   /api/session/stop   end the separate desktop (same-origin only)
 *   GET    /api/monitors       the physical monitors My monitor can show
 *   GET    /api/files/:token/:name  a file opened with xdg-open in the terminal
 */
export function createApi({ hosts, registry, prefs, machines }) {
  const api = express.Router();
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const sameOriginOnly = (req, res, next) => (sameOrigin(req) ? next() : res.status(403).json({ error: 'cross-origin request' }));

  api.get('/api/me', (req, res) => {
    noStore(res).json({ email: req.user.email, host: hosts.self.name, hostId: hosts.self.id, dev: Boolean(req.user.dev) });
  });

  api.get('/api/host', (req, res) => {
    noStore(res).json(req.machine.describe());
  });

  // Every machine with what the machine list shows: status, what it offers,
  // and CPU and memory use from its last samples.
  api.get('/api/hosts', (req, res) => {
    const self = machines.self.describe();
    const list = [{
      id: self.id, name: self.name, local: true, status: 'online', os: 'linux',
      screen: true, terminal: true, ...registry.summary(self.id),
    }];
    for (const m of registry.list()) {
      const caps = machines.get(m.id).describe().capabilities;
      list.push({ ...m, local: false, screen: Boolean(caps?.screen), terminal: caps ? Boolean(caps.terminal) : true, ...registry.summary(m.id) });
    }
    noStore(res).json(list);
  });

  api.delete('/api/hosts/:id', sameOriginOnly, (req, res) => {
    if (!registry.remove(req.params.id)) return res.status(404).json({ error: 'unknown machine' });
    noStore(res).json({ removed: req.params.id });
  });

  api.post('/api/join-tokens', sameOriginOnly, (req, res) => {
    noStore(res).json(registry.mintToken());
  });

  api.get('/api/prefs', (req, res) => {
    noStore(res).json(prefs.get(req.user.email));
  });

  api.put('/api/prefs', sameOriginOnly, express.json({ limit: '32kb' }), (req, res) => {
    noStore(res).json(prefs.set(req.user.email, req.body || {}));
  });

  api.get('/api/metrics', (req, res) => {
    const since = Number(req.query.since) || 0;
    noStore(res).json(req.machine.metrics({ since, live: req.query.live === '1' }));
  });

  // Answered by the machine: in this process, or by its agent (hub/agents.js).
  const forward = (method, path) => async (req, res, next) => {
    if (method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'cross-origin request' });
    try {
      const { status, body } = await req.machine.request({ method, path, query: req.query, user: { email: req.user.email } });
      noStore(res).status(status).json(body);
    } catch (err) {
      next(err);
    }
  };
  api.get('/api/session', forward('GET', '/api/session'));
  api.post('/api/session/stop', forward('POST', '/api/session/stop'));
  api.get('/api/monitors', forward('GET', '/api/monitors'));

  api.get('/api/files/:token/:name', (req, res) => req.machine.file(req, res));

  return api;
}
