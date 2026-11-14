import fs from 'node:fs';
import path from 'node:path';

// Per-person preferences that follow a person across devices: the machine
// list's own order, list or grid, and sort. Kept in prefs.json in the config
// directory, keyed by the signed-in email.

const VIEWS = new Set(['list', 'grid']);
const SORTS = new Set(['own', 'name', 'status', 'cpu', 'memory', 'seen']);
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The preferences in body that are valid, with defaults for the rest. */
export function cleanPrefs(body = {}) {
  return {
    order: Array.isArray(body.order) ? [...new Set(body.order.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, 500) : [],
    view: VIEWS.has(body.view) ? body.view : 'list',
    sort: SORTS.has(body.sort) ? body.sort : 'own',
  };
}

export function createPrefs({ file, log }) {
  let all = {};
  try {
    if (fs.existsSync(file)) all = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    log(`prefs.json: not read: ${err.message}`);
  }
  return {
    get(email) { return cleanPrefs(all[email]); },
    set(email, body) {
      all[email] = cleanPrefs({ ...this.get(email), ...body });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      return all[email];
    },
  };
}
