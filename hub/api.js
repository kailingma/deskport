import express from 'express';
import { sameOrigin } from './auth.js';

/**
 * The JSON API of one host. server.js mounts it at / and at /h/<id>/ for this
 * host's own id, so a UI can address every host the same way.
 *
 *   GET  /api/me             who is signed in, and where
 *   GET  /api/host           this host's id, name, version and capabilities
 *   GET  /api/hosts          every host this server knows (multi-host groundwork)
 *   GET  /api/session        state of the separate desktop
 *   POST /api/session/stop   end the separate desktop (same-origin only)
 *   GET  /api/monitors       the physical monitors My monitor can show
 *   GET  /api/files/:token/:name  a file opened with xdg-open in the terminal
 */
export function createApi({ hosts, machine }) {
  const api = express.Router();
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  api.get('/api/me', (req, res) => {
    noStore(res).json({ email: req.user.email, host: hosts.self.name, hostId: hosts.self.id, dev: Boolean(req.user.dev) });
  });

  api.get('/api/host', (req, res) => {
    noStore(res).json(hosts.describe());
  });

  api.get('/api/hosts', (req, res) => {
    noStore(res).json(hosts.list());
  });

  // Answered by the machine: in this process, or by its agent (hub/agents.js).
  const forward = (method, path) => async (req, res, next) => {
    if (method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'cross-origin request' });
    try {
      const { status, body } = await machine.request({ method, path, query: req.query, user: { email: req.user.email } });
      noStore(res).status(status).json(body);
    } catch (err) {
      next(err);
    }
  };
  api.get('/api/session', forward('GET', '/api/session'));
  api.post('/api/session/stop', forward('POST', '/api/session/stop'));
  api.get('/api/monitors', forward('GET', '/api/monitors'));

  if (machine.file) api.get('/api/files/:token/:name', (req, res) => machine.file(req, res));

  return api;
}
