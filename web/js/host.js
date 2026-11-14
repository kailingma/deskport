// The host a view talks to (see docs/multi-host.md).
//
// Every URL the page uses goes through a host object. A host for another
// machine prefixes paths with /h/<id>; the hub relays those to the machine's
// agent, so the browser still talks only to its own origin.

const wsOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

/**
 * @param {object} [opts]
 * @param {string} [opts.id]  host id; "local" (the default) is the serving host
 */
export function createHost({ id = 'local' } = {}) {
  let prefix = '';
  const host = {
    id,
    /** Points this host object at another machine; views reconnect themselves. */
    use(next) {
      host.id = next;
      prefix = next === 'local' ? '' : `/h/${encodeURIComponent(next)}`;
    },
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
  host.use(id);
  return host;
}

/** The machine the Screen and Terminal views show; app.js points it at the chosen one. */
export const localHost = createHost();

/** JSON from the hub itself (machine list, preferences), never prefixed. */
export const hub = createHost();
