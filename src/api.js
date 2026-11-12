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
 */
export function createApi({ hosts, session, monitors }) {
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

  api.get('/api/session', async (req, res) => {
    noStore(res).json(await session.state());
  });

  api.post('/api/session/stop', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin request' });
    try {
      await session.stop();
      res.json(await session.state());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  api.get('/api/monitors', async (req, res) => {
    try {
      noStore(res).json(await monitors.list());
    } catch (err) {
      res.status(500).json({ error: err.message.trim().split('\n').at(-1) });
    }
  });

  return api;
}
