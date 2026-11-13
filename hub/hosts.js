import fs from 'node:fs';

// Multi-host groundwork (see docs/multi-host.md). Every machine runs its own
// deskport server. Later, one server's web UI will also reach other machines'
// servers through paths like /h/<id>/ws/screen, which it forwards, so the
// browser only ever talks to the origin that served the page.
//
// Today only this machine is served. Other hosts can be listed in hosts.json
// and appear in /api/hosts, but requests for them get 501 Not Implemented.

/** The id that always means "the server that answered", whatever its own id is. */
export const LOCAL = 'local';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A stable id from a machine name: lower case, letters, digits and dashes. */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'host';
}

/**
 * Splits a request path into the host it is for and the path on that host.
 * "/ws/screen" is for this host; "/h/<id>/ws/screen" is for host <id>.
 */
export function routeFor(pathname) {
  const m = /^\/h\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return { hostId: LOCAL, path: pathname };
  return { hostId: decodeURIComponent(m[1]), path: m[2] || '/' };
}

/**
 * Reads other hosts from hosts.json in the config directory:
 *   [{ "id": "laptop", "name": "Laptop", "url": "https://laptop.example.com" }]
 * The file is optional. Entries with a bad id or URL are skipped with a log line.
 */
function loadRemotes(file, selfId, log) {
  if (!fs.existsSync(file)) return [];
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('expected an array');
  } catch (err) {
    log(`hosts: ignoring ${file}: ${err.message}`);
    return [];
  }
  const remotes = [];
  for (const e of entries) {
    let url;
    try { url = new URL(e?.url); } catch { url = null; }
    if (!ID.test(e?.id ?? '') || e.id === LOCAL || e.id === selfId || url?.protocol !== 'https:') {
      log(`hosts: skipping entry ${JSON.stringify(e?.id)}: needs a unique id (a-z, 0-9, -) and an https url`);
      continue;
    }
    remotes.push({ id: e.id, name: String(e.name || e.id), url: url.origin });
  }
  if (remotes.length) log(`hosts: ${remotes.length} other host(s) listed; controlling them is not implemented yet`);
  return remotes;
}

/**
 * @param {object} opts
 * @param {{ self: { id: string, name: string }, ui: boolean, hostsFile: string }} opts.config
 * @param {string[]} opts.sources  screen sources this host offers
 */
export function createHostRegistry({ config, sources, version, log }) {
  const self = { id: config.self.id, name: config.self.name };
  const remotes = loadRemotes(config.hostsFile, self.id, log);

  return {
    self,

    /** What this host offers, as GET /api/host reports it to a UI or another host. */
    describe() {
      return {
        id: self.id,
        name: self.name,
        version,
        ui: config.ui,
        capabilities: { screen: { sources }, terminal: true },
      };
    },

    /** Every known host, this one first. Remote entries carry no live state yet. */
    list() {
      return [
        { id: self.id, name: self.name, local: true, status: 'online' },
        ...remotes.map((r) => ({ id: r.id, name: r.name, local: false, status: 'not-implemented' })),
      ];
    },

    /** The host for an id from a path, or null. LOCAL and this host's own id are this host. */
    get(id) {
      if (id === LOCAL || id === self.id) return { ...self, local: true };
      const r = remotes.find((h) => h.id === id);
      return r ? { ...r, local: false } : null;
    },
  };
}
