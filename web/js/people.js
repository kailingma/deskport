// The People dialog (admins only): who may use which machine. Admins come from
// DESKPORT_ADMIN_EMAILS on the hub and use every machine; everyone else uses
// the Read/Edit grants chosen here. Every change is saved at once (hub/access.js).

import { hub } from './host.js';
import { ask } from './dialog.js';
import { grantFor, changeGrant } from './permissions.js';

const $ = (id) => document.getElementById(id);

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('aria-') || k === 'role' || k === 'for') e.setAttribute(k, v);
    else e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
};

export function createPeople({ toast }) {
  const dialog = $('people');
  const listEl = $('people-list');
  const form = $('people-add');
  let data = { all: '*', people: [], machines: [] };
  const pending = new Set();
  const errors = new Map();

  const path = (email) => `/api/admin/people/${encodeURIComponent(email)}`;

  async function load() {
    try {
      data = await hub.json('/api/admin/people');
      render();
    } catch (err) {
      listEl.replaceChildren(el('p', { class: 'dialog-body' }, `Could not load people: ${err.message}`));
    }
  }

  function machineChecks(p, idx) {
    const everyEdit = p.machines.includes(data.all);
    const everyRead = p.readMachines.includes(data.all);
    const row = (id, label, note = '') => {
      const level = grantFor(p, id, data.all);
      const check = (value, text) => {
        const inputId = `pp-${idx}-${id}-${value}`;
        const inherited = id !== data.all && (everyEdit || (everyRead && value === 'read' && level === 'read'));
        return el('label', { class: 'pp-check', for: inputId },
          el('input', { type: 'checkbox', id: inputId, checked: level === value, disabled: inherited,
            'aria-label': `${text} access to ${label} for ${p.email}`, dataset: { machine: id, level: value } }),
          el('span', {}, text));
      };
      return el('div', { class: `pp-row${id === data.all ? ' pp-row-all' : ''}` },
        el('div', { class: 'pp-machine-name' }, el('span', {}, label), note && el('span', { class: 'pp-note' }, note)),
        el('div', { class: 'pp-perm', role: 'group', 'aria-label': `Access to ${label}` }, check('read', 'Read'), check('edit', 'Edit')));
    };
    const addId = `pp-${idx}-add`;
    return el('fieldset', { class: 'pp-machines', disabled: pending.has(p.email), 'aria-label': `Permissions for ${p.email}` },
      row(data.all, 'Every machine', 'Includes machines added later.'),
      ...data.machines.map((m) => row(m.id, m.local ? `${m.name} (the hub)` : m.name)),
      el('label', { class: 'pp-add', for: addId },
        el('span', { class: 'pp-machine-name' }, el('span', {}, 'May add machines'),
          el('span', { class: 'pp-note', id: `${addId}-note` }, 'Gets Edit on each machine they add.')),
        el('input', { class: 'switch', type: 'checkbox', role: 'switch', id: addId, checked: p.addMachines,
          'aria-label': `Allow ${p.email} to add machines`, 'aria-describedby': `${addId}-note`, dataset: { addMachines: '' } })));
  }

  function render(focusId = document.activeElement?.closest('.pp-person') ? document.activeElement.id : null) {
    const scroll = listEl.scrollTop;
    if (!data.people.length) {
      listEl.replaceChildren(el('p', { class: 'dialog-body' }, 'Nobody yet.'));
      return;
    }
    listEl.replaceChildren(...data.people.map((p, i) => el('section', { class: 'pp-person', dataset: { email: p.email }, 'aria-busy': String(pending.has(p.email)) },
      el('div', { class: 'pp-head' },
        el('span', { class: 'pp-email' }, p.email),
        p.admin
          ? el('span', { class: 'pp-tag' }, 'Admin')
          : el('button', { class: 'btn-text pp-remove', type: 'button', disabled: pending.has(p.email), 'aria-label': `Remove ${p.email}` }, 'Remove'),
        pending.has(p.email) && el('span', { class: 'pp-note', role: 'status' }, 'Saving…')),
      p.admin
          ? el('p', { class: 'pp-note' }, 'Edit on every machine and may add machines. Set in DESKPORT_ADMIN_EMAILS on the hub.')
          : machineChecks(p, i),
        errors.has(p.email) && el('p', { class: 'pp-note pp-error', role: 'alert' }, errors.get(p.email)))));
    listEl.scrollTop = scroll;
    if (focusId) $(focusId)?.focus({ preventScroll: true });
  }

  async function save(email, grants) {
    if (pending.has(email)) return false;
    const focusId = document.activeElement?.id;
    const previous = data.people.find((p) => p.email === email);
    pending.add(email);
    errors.delete(email);
    if (previous) data.people[data.people.indexOf(previous)] = { ...previous, ...grants };
    render();
    try {
      const saved = await hub.json(path(email), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(grants),
      });
      const i = data.people.findIndex((p) => p.email === saved.email);
      if (i >= 0) data.people[i] = saved; else data.people.push(saved);
      return true;
    } catch (err) {
      const i = data.people.findIndex((p) => p.email === email);
      if (previous && i >= 0) data.people[i] = previous;
      errors.set(email, `Not saved: ${err.message}. Try the change again.`);
      toast(`Not saved: ${err.message}`);
      return false;
    } finally {
      pending.delete(email);
      render(focusId);
    }
  }

  listEl.addEventListener('change', (e) => {
    const input = e.target.closest('input');
    const person = e.target.closest('.pp-person');
    if (!input || !person) return;
    const email = person.dataset.email;
    const p = data.people.find((p) => p.email === email);
    if (!p || pending.has(email)) return;
    const grants = input.hasAttribute('data-add-machines')
      ? { machines: p.machines, readMachines: p.readMachines, addMachines: input.checked }
      : changeGrant(p, input.dataset.machine, input.dataset.level, input.checked, data.all);
    save(email, grants);
  });

  listEl.addEventListener('click', async (e) => {
    if (!e.target.closest('.pp-remove') || e.target.closest('.pp-remove').disabled) return;
    const email = e.target.closest('.pp-person').dataset.email;
    const ok = await ask({
      title: `Remove ${email}?`,
      body: 'They lose every machine at once, and their open screens and terminals close.',
      confirm: 'Remove',
    });
    if (!ok) return;
    try {
      await hub.json(path(email), { method: 'DELETE' });
      data.people = data.people.filter((p) => p.email !== email);
      render();
      toast(`${email} removed`);
    } catch (err) {
      toast(`Could not remove: ${err.message}`);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('people-email');
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    if (data.people.some((p) => p.email === email)) {
      toast(`${email} is already on the list`);
      return;
    }
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (await save(email, { machines: [], readMachines: [], addMachines: false })) {
        input.value = '';
        toast(`${email} added. Choose Read or Edit for their machines.`);
      }
    } finally { button.disabled = false; }
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-people="close"]')) dialog.close();
  });

  return {
    open() {
      listEl.replaceChildren(el('p', { class: 'dialog-body' }, 'Loading.'));
      dialog.showModal();
      load();
    },
  };
}
