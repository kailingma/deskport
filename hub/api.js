import express from 'express';
import { sameOrigin } from './auth.js';
import { ALL, AccessError } from './access.js';

/**
 * The JSON API of one machine. server.js mounts it at / for this machine and
 * at /h/<id>/ for any machine, with req.machine set (hub/machines.js), so a UI
 * can address every machine the same way.
 *
 *   GET    /api/me             who is signed in, where, and whether they are an admin
 *   GET    /api/host           the machine's id, name, version and capabilities
 *   GET    /api/hosts          the machines the signed-in person may use
 *   DELETE /api/hosts/:id      remove a machine that joined (admin, same-origin only)
 *   POST   /api/join-tokens    a one-use token for joining a machine (admin, same-origin only)
 *   GET    /api/admin/people   admins, people and their machines, and every machine (admin)
 *   PUT    /api/admin/people/:email  { machines: [ids] or ["*"] } (admin, same-origin only)
 *   DELETE /api/admin/people/:email  (admin, same-origin only)
 *   GET    /api/prefs         the signed-in person's machine order, list or grid, and sort
 *   PUT    /api/prefs         change them (same-origin only)
 *   GET    /api/metrics        the machine's recent metrics (?since=<ms>&live=1)
 *   GET    /api/session        state of the separate desktop
 *   POST   /api/session/stop   end the separate desktop (same-origin only)
 *   GET    /api/monitors       the physical monitors My monitor can show
 *   GET    /api/files/:token/:name  a file opened with xdg-open in the terminal
 *
 * Routes about one machine answer 403 to someone who may not use it
 * (hub/access.js).
 */
export function createApi({ hosts, registry, prefs, machines, access }) {
  const api = express.Router();
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const sameOriginOnly = (req, res, next) => (sameOrigin(req) ? next() : res.status(403).json({ error: 'cross-origin request' }));
  const adminOnly = (req, res, next) => (access.isAdmin(req.user.email) ? next() : res.status(403).json({ error: 'only an admin can do this' }));
  const mine = (req, res, next) => (access.canUse(req.user.email, req.machine.id) ? next() : res.status(403).json({ error: 'you have not been given this machine' }));

  api.get('/api/me', (req, res) => {
    noStore(res).json({
      email: req.user.email, host: hosts.self.name, hostId: hosts.self.id, dev: Boolean(req.user.dev),
      admin: access.isAdmin(req.user.email),
    });
  });

  api.get('/api/host', mine, (req, res) => {
    noStore(res).json(req.machine.describe());
  });

  // Every machine with what the machine list shows: status, what it offers,
  // and CPU and memory use from its last samples.
  function allMachines() {
    const self = machines.self.describe();
    return [{ id: self.id, name: self.name, local: true }, ...registry.list().map((m) => ({ id: m.id, name: m.name, local: false, os: m.os }))];
  }

  function screenFields(caps, encodings = []) {
    const screen = caps?.screen;
    return {
      screenSources: Array.isArray(screen?.sources) ? screen.sources : [],
      screenEncodings: screen ? (Array.isArray(screen.encodings) ? screen.encodings : encodings) : [],
      ...(typeof screen?.backend === 'string' ? { screenBackend: screen.backend } : {}),
      screenNote: typeof caps?.notes?.screen === 'string' ? caps.notes.screen : null,
    };
  }

  api.get('/api/hosts', (req, res) => {
    const email = req.user.email;
    const self = machines.self.describe();
    const list = access.canUse(email, self.id) ? [{
      id: self.id, name: self.name, local: true, status: 'online', os: 'linux',
      screen: true, terminal: true, ...screenFields(self.capabilities, ['images', 'av1', 'h264']), ...registry.summary(self.id),
    }] : [];
    for (const m of registry.list()) {
      if (!access.canUse(email, m.id)) continue;
      const caps = machines.get(m.id).describe().capabilities;
      list.push({
        ...m, local: false, screen: Boolean(caps?.screen), terminal: caps ? Boolean(caps.terminal) : true,
        ...screenFields(caps), ...registry.summary(m.id),
      });
    }
    noStore(res).json(list);
  });

  api.delete('/api/hosts/:id', adminOnly, sameOriginOnly, (req, res) => {
    if (!registry.remove(req.params.id)) return res.status(404).json({ error: 'unknown machine' });
    access.forgetMachine(req.params.id);
    noStore(res).json({ removed: req.params.id });
  });

  api.post('/api/join-tokens', adminOnly, sameOriginOnly, (req, res) => {
    noStore(res).json(registry.mintToken());
  });

  api.get('/api/admin/people', adminOnly, (req, res) => {
    noStore(res).json({ all: ALL, people: access.list(), machines: allMachines() });
  });

  api.put('/api/admin/people/:email', adminOnly, sameOriginOnly, express.json({ limit: '32kb' }), (req, res) => {
    try {
      noStore(res).json(access.setPerson(req.params.email, req.body?.machines));
    } catch (err) {
      if (!(err instanceof AccessError)) throw err;
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/api/admin/people/:email', adminOnly, sameOriginOnly, (req, res) => {
    if (!access.removePerson(req.params.email)) return res.status(404).json({ error: 'not on the list' });
    noStore(res).json({ removed: req.params.email.toLowerCase() });
  });

  api.get('/api/prefs', (req, res) => {
    noStore(res).json(prefs.get(req.user.email));
  });

  api.put('/api/prefs', sameOriginOnly, express.json({ limit: '32kb' }), (req, res) => {
    noStore(res).json(prefs.set(req.user.email, req.body || {}));
  });

  api.get('/api/metrics', mine, (req, res) => {
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
  api.get('/api/session', mine, forward('GET', '/api/session'));
  api.post('/api/session/stop', mine, forward('POST', '/api/session/stop'));
  api.get('/api/monitors', mine, forward('GET', '/api/monitors'));

  api.get('/api/files/:token/:name', mine, (req, res) => req.machine.file(req, res));

  return api;
}
