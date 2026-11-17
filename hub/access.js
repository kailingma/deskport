import fs from 'node:fs';
import path from 'node:path';

// Who may sign in, who is an admin, and which machines each person may use.
//
// Admins come from DESKPORT_ADMIN_EMAILS. When that is empty, everyone in
// DESKPORT_ALLOWED_EMAILS is an admin, and when both are empty every identity
// Cloudflare Access lets through is one (how deskport behaved before people
// had machines). Admins use every machine and manage everything else.
//
// Other people are kept in access.json in the config directory, written by
// the admin page: { "people": { "<email>": { "machines": ["<id>", ...] } } }.
// "*" in machines means every machine, including ones that join later.
// Someone listed there may sign in even when DESKPORT_ALLOWED_EMAILS does not
// name them (Cloudflare Access must still let them through).

export const ALL = '*';
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class AccessError extends Error {}

export function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new AccessError('not an email address');
  return email;
}

export function cleanMachines(value) {
  if (!Array.isArray(value)) throw new AccessError('machines must be a list');
  if (value.includes(ALL)) return [ALL];
  return [...new Set(value.filter((id) => typeof id === 'string' && ID.test(id)))].sort().slice(0, 500);
}

export function createAccess({ file, admins = [], allowed = [], dev = false, log = () => {} }) {
  const adminSet = new Set(admins.length ? admins : allowed);
  const allowedSet = new Set(allowed);
  // No list at all: anyone Access lets in is an admin.
  const open = !adminSet.size && !allowedSet.size;
  let people = {};
  const listeners = new Set();

  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      for (const [email, p] of Object.entries(data.people || {})) {
        try { people[cleanEmail(email)] = { machines: cleanMachines(p?.machines ?? []) }; } catch (err) { log(`access.json: skipped ${email}: ${err.message}`); }
      }
    }
  } catch (err) {
    log(`access.json: not read: ${err.message}`);
  }
  if (open && !dev) log('access: DESKPORT_ADMIN_EMAILS and DESKPORT_ALLOWED_EMAILS are empty, so everyone Cloudflare Access lets in is an admin');

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ people }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    for (const fn of listeners) fn();
  }

  const access = {
    isAdmin(email) {
      return dev || open || adminSet.has(email);
    },

    /** Whether this identity may use deskport at all. */
    mayEnter(email) {
      return access.isAdmin(email) || allowedSet.has(email) || Object.hasOwn(people, email);
    },

    canUse(email, machineId) {
      if (access.isAdmin(email)) return true;
      const list = people[email]?.machines ?? [];
      return list.includes(ALL) || list.includes(machineId);
    },

    /** Everyone on the admin page: admins from the environment, then the people in access.json. */
    list() {
      const rows = [];
      for (const email of [...adminSet].sort()) rows.push({ email, admin: true, machines: [ALL] });
      for (const email of Object.keys(people).sort()) {
        if (!adminSet.has(email)) rows.push({ email, admin: false, machines: people[email].machines });
      }
      return rows;
    },

    setPerson(email, machines) {
      email = cleanEmail(email);
      if (adminSet.has(email)) throw new AccessError(`${email} is an admin (DESKPORT_ADMIN_EMAILS) and uses every machine`);
      people[email] = { machines: cleanMachines(machines) };
      save();
      log(`access: ${email} may use ${people[email].machines.join(', ') || 'no machines'}`);
      return { email, admin: false, machines: people[email].machines };
    },

    removePerson(email) {
      email = String(email ?? '').toLowerCase();
      if (!Object.hasOwn(people, email)) return false;
      delete people[email];
      save();
      log(`access: removed ${email}`);
      return true;
    },

    /** Drops a machine that left the hub from everyone's list. */
    forgetMachine(id) {
      let changed = false;
      for (const p of Object.values(people)) {
        const i = p.machines.indexOf(id);
        if (i >= 0) { p.machines.splice(i, 1); changed = true; }
      }
      if (changed) save();
    },

    /** Called after every change, e.g. to close streams someone may no longer use. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return access;
}
