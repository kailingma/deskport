// The People dialog (admins only): who may use which machine. Admins come from
// DESKPORT_ADMIN_EMAILS on the hub and use every machine; everyone else uses
// the machines ticked here. Every change is saved at once (hub/access.js).

import { hub } from './host.js';
import { ask } from './dialog.js';

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
    const every = p.machines.includes(data.all);
    const box = (id, label, checked, disabled) => {
      const inputId = `pp-${idx}-${id}`;
      return el('label', { class: 'pp-check', for: inputId },
        el('input', { type: 'checkbox', id: inputId, checked, disabled, dataset: { machine: id } }),
        el('span', {}, label));
    };
    return el('div', { class: 'pp-machines', role: 'group', 'aria-label': `Machines for ${p.email}` },
      box(data.all, 'Every machine, including ones added later', every, false),
      ...data.machines.map((m) => box(m.id, m.local ? `${m.name} (the hub)` : m.name, every || p.machines.includes(m.id), every)));
  }

  function render() {
    if (!data.people.length) {
      listEl.replaceChildren(el('p', { class: 'dialog-body' }, 'Nobody yet.'));
      return;
    }
    listEl.replaceChildren(...data.people.map((p, i) => el('section', { class: 'pp-person', dataset: { email: p.email } },
      el('div', { class: 'pp-head' },
        el('span', { class: 'pp-email' }, p.email),
        p.admin
          ? el('span', { class: 'pp-tag' }, 'Admin')
          : el('button', { class: 'btn-text pp-remove', type: 'button' }, 'Remove')),
      p.admin
        ? el('p', { class: 'pp-note' }, 'Uses every machine. Set in DESKPORT_ADMIN_EMAILS on the hub.')
        : machineChecks(p, i))));
  }

  async function save(email, machines) {
    try {
      const saved = await hub.json(path(email), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machines }),
      });
      const i = data.people.findIndex((p) => p.email === saved.email);
      if (i >= 0) data.people[i] = saved; else data.people.push(saved);
      render();
      return true;
    } catch (err) {
      toast(`Not saved: ${err.message}`);
      render();
      return false;
    }
  }

  listEl.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-machine]');
    const person = e.target.closest('.pp-person');
    if (!input || !person) return;
    const email = person.dataset.email;
    if (input.dataset.machine === data.all) return save(email, input.checked ? [data.all] : []);
    const ids = [...person.querySelectorAll('input[data-machine]:checked')]
      .map((x) => x.dataset.machine)
      .filter((id) => id !== data.all);
    save(email, ids);
  });

  listEl.addEventListener('click', async (e) => {
    if (!e.target.closest('.pp-remove')) return;
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
    if (await save(email, [])) {
      input.value = '';
      toast(`${email} added. Tick the machines they may use.`);
    }
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
