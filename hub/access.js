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
// the admin page: { "people": { "<email>": { "machines": ["<id>", ...],
// "readMachines": [], "addMachines": false } } }. machines are Edit grants;
// older files therefore keep their existing access. Read grants allow viewing
// only. "*" in either list means every machine, including ones that join later.
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
  return [...new Set(value.filter((id) => typeof id === 'string' && ID.test(id)))].sort();
}

function cleanPerson(machines, { readMachines = [], addMachines = false } = {}) {
  if (typeof addMachines !== 'boolean') throw new AccessError('addMachines must be true or false');
  const edit = cleanMachines(machines);
  const read = cleanMachines(readMachines);
  return { machines: edit, readMachines: edit.includes(ALL) ? [] : read.filter((id) => !edit.includes(id)), addMachines };
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
        try { people[cleanEmail(email)] = cleanPerson(p?.machines ?? [], p ?? {}); } catch (err) { log(`access.json: skipped ${email}: ${err.message}`); }
      }
    }
  } catch (err) {
    log(`access.json: not read: ${err.message}`);
  }
  if (open && !dev) log('access: DESKPORT_ADMIN_EMAILS and DESKPORT_ALLOWED_EMAILS are empty, so everyone Cloudflare Access lets in is an admin');

  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ people: next }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    people = next;
    for (const fn of listeners) fn();
  }

  const given = (email, key, id) => people[email]?.[key]?.some((m) => m === ALL || m === id) ?? false;
  const row = (email) => ({ email, admin: false, ...people[email], machines: [...people[email].machines], readMachines: [...people[email].readMachines] });

  const access = {
    isAdmin(email) {
      return dev || open || adminSet.has(email);
    },

    /** Whether this identity may use deskport at all. */
    mayEnter(email) {
      return access.isAdmin(email) || allowedSet.has(email) || Object.hasOwn(people, email);
    },

    canUse(email, machineId) {
      return access.canRead(email, machineId);
    },

    canRead(email, machineId) {
      return access.canEdit(email, machineId) || given(email, 'readMachines', machineId);
    },

    canEdit(email, machineId) {
      return access.isAdmin(email) || given(email, 'machines', machineId);
    },

    canAddMachines(email) {
      return access.isAdmin(email) || people[email]?.addMachines === true;
    },

    /** Everyone on the admin page: admins from the environment, then the people in access.json. */
    list() {
      const rows = [];
      for (const email of [...adminSet].sort()) rows.push({ email, admin: true, machines: [ALL], readMachines: [], addMachines: true });
      for (const email of Object.keys(people).sort()) {
        if (!adminSet.has(email)) rows.push(row(email));
      }
      return rows;
    },

    setPerson(email, machines, options = {}) {
      email = cleanEmail(email);
      if (adminSet.has(email)) throw new AccessError(`${email} is an admin (DESKPORT_ADMIN_EMAILS) and uses every machine`);
      save({ ...people, [email]: cleanPerson(machines, options) });
      log(`access: ${email}: Edit ${people[email].machines.join(', ') || 'none'}, Read ${people[email].readMachines.join(', ') || 'none'}, add machines ${people[email].addMachines}`);
      return row(email);
    },

    /** The issuer of a join token gets control of the machine they added. */
    grantEdit(email, id) {
      email = cleanEmail(email);
      if (!ID.test(id)) throw new AccessError('not a machine id');
      if (access.isAdmin(email) || access.canEdit(email, id)) return;
      if (!Object.hasOwn(people, email)) throw new AccessError('this person is no longer on the list');
      const p = people[email];
      save({ ...people, [email]: cleanPerson([...p.machines, id], p) });
      log(`access: ${email} gets Edit on the machine they added: ${id}`);
    },

    removePerson(email) {
      email = String(email ?? '').toLowerCase();
      if (!Object.hasOwn(people, email)) return false;
      const next = { ...people };
      delete next[email];
      save(next);
      log(`access: removed ${email}`);
      return true;
    },

    /** Drops a machine that left the hub from everyone's list. */
    forgetMachine(id) {
      let changed = false;
      const next = {};
      for (const [email, p] of Object.entries(people)) {
        const machines = p.machines.filter((m) => m !== id);
        const readMachines = p.readMachines.filter((m) => m !== id);
        if (machines.length !== p.machines.length || readMachines.length !== p.readMachines.length) changed = true;
        next[email] = { ...p, machines, readMachines };
      }
      if (changed) save(next);
    },

    /** Called after every change, e.g. to close streams someone may no longer use. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return access;
}
