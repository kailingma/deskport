// The host a view talks to (see docs/multi-host.md).
//
// Every URL the page uses goes through a host object. Today there is one: the
// server that served the page. A controller UI will create one per machine
// with createHost({ id }), which prefixes paths with /h/<id>; the serving
// server forwards those, so the browser still talks only to its own origin.

const wsOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

/**
 * @param {object} [opts]
 * @param {string} [opts.id]  host id; "local" (the default) is the serving host
 */
export function createHost({ id = 'local' } = {}) {
  const prefix = id === 'local' ? '' : `/h/${encodeURIComponent(id)}`;
  return {
    id,
    /** Path of an API endpoint on this host, e.g. api('/api/session'). */
    api: (path) => `${prefix}${path}`,
    /** WebSocket URL of an endpoint on this host, e.g. ws('/ws/screen'). */
    ws: (path) => `${wsOrigin}${prefix}${path}`,
    /** Fetches JSON from this host's API; throws with the server's message on failure. */
    async json(path, init) {
      const r = await fetch(`${prefix}${path}`, init);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    },
  };
}

/** The server that served this page. */
export const localHost = createHost();
