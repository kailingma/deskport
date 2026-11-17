// The Machines view: every machine the hub knows, as a list or a grid, with
// search, sorting and the person's own order (kept on the hub, so it follows
// them across devices), and a dashboard per machine from its metrics.

import { hub } from './host.js';
import { ask } from './dialog.js';

const $ = (id) => document.getElementById(id);
const LIST_MS = 5000;
const LIVE_MS = 1000;
const WINDOW_MS = 10 * 60 * 1000;
const SORTS = {
  own: 'Your order',
  name: 'Name',
  status: 'Status',
  cpu: 'Processor use',
  memory: 'Memory use',
  seen: 'Last seen',
};

// ---------- formatting ----------

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('aria-') || k === 'role') e.setAttribute(k, v);
    else e[k] = v;
  }
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
};
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export function bytes(n, digits = 1) {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : digits)} ${units[i]}`;
}
const rate = (n) => `${bytes(n)}/s`;
const pct = (n) => (Number.isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)}%` : '–');
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ago(t, now = Date.now()) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function uptime(s) {
  if (!Number.isFinite(s)) return '';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `up ${d} d ${h} h` : h ? `up ${h} h ${m} min` : `up ${m} min`;
}

// ---------- metrics: from cumulative samples to values over time ----------

const sum = (a) => a.reduce((x, y) => x + y, 0);
const busyShare = (a, b) => {
  const total = sum(b) - sum(a);
  const idle = (b[3] + (b[4] || 0)) - (a[3] + (a[4] || 0));
  return total > 0 ? (1 - idle / total) * 100 : null;
};

/** One point per sample after the first: processor, memory, network and disk use. */
export function series(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const p = { t: b.t };
    if (a.sample.cpu?.total && b.sample.cpu?.total) p.cpu = busyShare(a.sample.cpu.total, b.sample.cpu.total);
    const m = b.sample.memory;
    if (m?.totalB) p.mem = (1 - m.availableB / m.totalB) * 100;
    const netA = new Map((a.sample.net || []).map((n) => [n.name, n]));
    let rx = 0;
    let tx = 0;
    for (const n of b.sample.net || []) {
      const o = netA.get(n.name);
      if (o) { rx += Math.max(0, n.rxB - o.rxB); tx += Math.max(0, n.txB - o.txB); }
    }
    p.rx = rx / dt;
    p.tx = tx / dt;
    const diskA = new Map((a.sample.disks || []).map((d) => [d.name, d]));
    let rd = 0;
    let wr = 0;
    for (const d of b.sample.disks || []) {
      const o = diskA.get(d.name);
      if (o) { rd += Math.max(0, d.readB - o.readB); wr += Math.max(0, d.writeB - o.writeB); }
    }
    p.read = rd / dt;
    p.write = wr / dt;
    out.push(p);
  }
  return out;
}

/** Per-item rates between the last two samples, for the tables. */
function lastRates(samples, field, keys) {
  const [a, b] = samples.slice(-2);
  if (!a || !b) return new Map();
  const dt = (b.t - a.t) / 1000;
  const before = new Map((a.sample[field] || []).map((x) => [x.name, x]));
  return new Map((b.sample[field] || []).map((x) => {
    const o = before.get(x.name);
    return [x.name, Object.fromEntries(keys.map((k) => [k, o && dt > 0 ? Math.max(0, x[k] - o[k]) / dt : null]))];
  }));
}

// ---------- sparkline ----------

/**
 * A single-series line over time, 2px, in the secondary ink. Hovering shows a
 * crosshair and the value and time in `readout`. max is fixed for
 * percentages; otherwise the peak of the window.
 */
function sparkline({ points, key, label, format, max, readout }) {
  const W = 300;
  const H = 56;
  const pad = 3;
  const data = points.filter((p) => Number.isFinite(p[key]));
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  const t1 = Date.now();
  const t0 = t1 - WINDOW_MS;
  const top = max ?? Math.max(1, ...data.map((p) => p[key]));
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (v) => H - pad - (Math.min(v, top) / top) * (H - 2 * pad);
  svg.append(svgEl('line', { class: 'spark-base', x1: 0, x2: W, y1: H - pad + 0.5, y2: H - pad + 0.5 }));
  const now = data.at(-1);
  const peak = data.reduce((m, p) => Math.max(m, p[key]), 0);
  svg.setAttribute('aria-label', data.length
    ? `${label}, last 10 minutes: now ${format(now[key])}, peak ${format(peak)}`
    : `${label}: no data yet`);
  if (data.length > 1) {
    svg.append(svgEl('polyline', { class: 'spark-line', points: data.map((p) => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ') }));
  }
  const cross = svgEl('line', { class: 'spark-cross', y1: 0, y2: H, visibility: 'hidden' });
  svg.append(cross);
  const resting = () => (data.length ? `${format(now[key])} now · peak ${format(peak)}` : 'No data yet');
  readout.textContent = resting();
  svg.addEventListener('pointermove', (e) => {
    if (!data.length) return;
    const r = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = data[0];
    for (const p of data) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    cross.setAttribute('x1', x(best.t));
    cross.setAttribute('x2', x(best.t));
    cross.setAttribute('visibility', 'visible');
    readout.textContent = `${format(best[key])} at ${clock(best.t)}`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    readout.textContent = resting();
  });
  return svg;
}

const meter = (value, label) => el('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(value || 0)), 'aria-label': label },
  el('span', { style: `width:${Math.max(0, Math.min(100, value || 0))}%` }));

// ---------- the view ----------

export function createMachines({ open, toast, currentId, onList }) {
  const view = $('view-machines');
  const listEl = $('machine-list');
  const detailEl = $('machine-detail');
  const search = $('machine-search');
  const sortSel = $('machine-sort');
  let machines = [];
  let loaded = false;
  let prefs = { order: [], view: 'list', sort: 'own' };
  let detail = null; // { id, samples }
  let listTimer = null;
  let liveTimer = null;
  let visible = false;

  sortSel.replaceChildren(...Object.entries(SORTS).map(([v, label]) => new Option(label, v)));

  async function savePrefs(change) {
    prefs = { ...prefs, ...change };
    render();
    try {
      prefs = await hub.json('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
    } catch (err) {
      toast(`Could not save: ${err.message}`);
    }
  }

  function sorted() {
    const q = search.value.trim().toLowerCase();
    const shown = machines.filter((m) => !q || [m.name, m.id, m.os, m.arch, m.local ? 'this computer' : ''].some((s) => s?.toLowerCase().includes(q)));
    const rank = new Map(prefs.order.map((id, i) => [id, i]));
    const own = (m) => rank.get(m.id) ?? (m.local ? -1 : 1e6);
    const by = {
      own: (a, b) => own(a) - own(b),
      name: (a, b) => a.name.localeCompare(b.name),
      status: (a, b) => (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1) || own(a) - own(b),
      cpu: (a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1),
      memory: (a, b) => (b.memPct ?? -1) - (a.memPct ?? -1),
      seen: (a, b) => (b.local ? Infinity : b.lastSeen ?? 0) - (a.local ? Infinity : a.lastSeen ?? 0),
    }[prefs.sort];
    return shown.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
  }

  function statusBadge(m) {
    const state = m.status === 'online' ? 'ok' : 'bad';
    const text = m.status === 'online' ? 'Online' : m.local ? 'Offline' : `Offline, seen ${ago(m.lastSeen)}`;
    return el('span', { class: 'badge', dataset: { state } }, el('span', { class: 'dot' }), el('span', { class: 'badge-text' }, text));
  }

  function card(m) {
    const current = m.id === currentId() || (m.local && currentId() === 'local');
    const own = prefs.sort === 'own' && !search.value.trim();
    const meta = [m.local ? 'This computer' : null, [m.os, m.arch].filter(Boolean).join(' '), uptime(m.uptimeS)].filter(Boolean).join(' · ');
    return el('article', { class: 'mc', dataset: { id: m.id }, 'aria-current': current ? 'true' : 'false' },
      own && el('button', { class: 'mc-grip', type: 'button', title: 'Drag to reorder, or use the arrow keys', 'aria-label': `Move ${m.name}` },
        svgUse('i-grip')),
      el('button', { class: 'mc-main', type: 'button', title: `Dashboard of ${m.name}` },
        el('span', { class: 'mc-name' }, m.name),
        el('span', { class: 'mc-meta' }, meta)),
      statusBadge(m),
      el('div', { class: 'mc-figures' },
        el('div', { class: 'mc-figure' }, el('span', { class: 'mc-figure-label' }, 'Processor'), el('span', { class: 'mc-figure-value' }, pct(m.cpuPct)), meter(m.cpuPct, `${m.name} processor use`)),
        el('div', { class: 'mc-figure' }, el('span', { class: 'mc-figure-label' }, 'Memory'), el('span', { class: 'mc-figure-value' }, pct(m.memPct)), meter(m.memPct, `${m.name} memory use`))),
      el('div', { class: 'mc-actions' },
        m.screen && el('button', { class: 'btn-text btn-open', type: 'button', dataset: { open: 'screen' } }, svgUse('i-monitor'), 'Screen'),
        m.terminal && el('button', { class: 'btn-text btn-open', type: 'button', dataset: { open: 'term' } }, svgUse('i-terminal'), 'Terminal')));
  }

  function render() {
    sortSel.value = prefs.sort;
    for (const b of view.querySelectorAll('[data-machine-view]')) b.setAttribute('aria-checked', String(b.dataset.machineView === prefs.view));
    listEl.dataset.layout = prefs.view;
    const items = sorted();
    listEl.replaceChildren(...items.map(card));
    $('machine-empty').hidden = items.length > 0;
    $('machine-empty').textContent = machines.length ? 'No machine matches the search.'
      : loaded ? 'No machines have been given to you yet. Ask an admin of this hub.' : 'Loading.';
    if (detail) renderDetail();
  }

  async function refresh() {
    try {
      machines = await hub.json('/api/hosts');
      loaded = true;
      onList?.(machines, null);
    } catch (err) {
      onList?.(machines, err);
    }
    render();
  }

  // ---------- own order: drag the grip, or arrow keys on it ----------

  function moveTo(id, beforeId) {
    const ids = sorted().map((m) => m.id).filter((x) => x !== id);
    const i = beforeId ? ids.indexOf(beforeId) : ids.length;
    ids.splice(i < 0 ? ids.length : i, 0, id);
    savePrefs({ order: ids });
  }

  listEl.addEventListener('keydown', (e) => {
    const grip = e.target.closest('.mc-grip');
    if (!grip || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const id = grip.closest('.mc').dataset.id;
    const ids = sorted().map((m) => m.id);
    const i = ids.indexOf(id);
    const j = /Up|Left/.test(e.key) ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    ids.splice(i, 1);
    ids.splice(j, 0, id);
    savePrefs({ order: ids }).then(() => listEl.querySelector(`.mc[data-id="${CSS.escape(id)}"] .mc-grip`)?.focus());
  });

  let drag = null;
  listEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.mc-grip');
    if (!grip) return;
    e.preventDefault();
    const item = grip.closest('.mc');
    grip.setPointerCapture(e.pointerId);
    item.classList.add('is-dragging');
    drag = { id: item.dataset.id, item, before: undefined };
  });
  listEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mc');
    for (const m of listEl.querySelectorAll('.mc.drop-before, .mc.drop-after')) m.classList.remove('drop-before', 'drop-after');
    if (!under || under === drag.item) { drag.before = undefined; return; }
    const r = under.getBoundingClientRect();
    const after = prefs.view === 'grid' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    under.classList.add(after ? 'drop-after' : 'drop-before');
    drag.before = after ? (under.nextElementSibling?.dataset.id ?? null) : under.dataset.id;
  });
  const endDrag = () => {
    if (!drag) return;
    const { id, before, item } = drag;
    drag = null;
    item.classList.remove('is-dragging');
    for (const m of listEl.querySelectorAll('.mc.drop-before, .mc.drop-after')) m.classList.remove('drop-before', 'drop-after');
    if (before !== undefined && before !== id) moveTo(id, before);
  };
  listEl.addEventListener('pointerup', endDrag);
  listEl.addEventListener('pointercancel', endDrag);

  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.mc');
    if (!item || e.target.closest('.mc-grip')) return;
    const m = machines.find((x) => x.id === item.dataset.id);
    if (!m) return;
    const go = e.target.closest('[data-open]');
    if (go) open(m, go.dataset.open);
    else if (e.target.closest('.mc-main')) showDetail(m.id);
  });

  search.addEventListener('input', render);
  sortSel.addEventListener('change', () => savePrefs({ sort: sortSel.value }));
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-machine-view]');
    if (b) savePrefs({ view: b.dataset.machineView });
  });

  // ---------- add a machine ----------

  const addDialog = $('add-machine');
  let expiryTimer = null;
  let addToken = null;
  let addOs = 'linux';
  const ADD_OS = {
    linux: {
      where: 'On the machine, as the user the agent should run as, run:',
      command: (origin, token) => `curl -fsSL ${origin}/agent/v1/install.sh | sh -s -- ${token}`,
      needs: 'It needs curl, and tmux for its terminal. It installs deskport-agent as a systemd user service and shows up here when it connects.',
    },
    windows: {
      where: 'On the machine, in PowerShell as the user the agent should run as (not as administrator), run:',
      command: (origin, token) => `$env:DESKPORT_JOIN_TOKEN='${token}'; irm ${origin}/agent/v1/install.ps1 | iex`,
      needs: 'It needs Windows 10 version 1809 or later. It installs deskport-agent with a scheduled task that starts it at each logon, and shows up here when it connects. Its terminal is PowerShell.',
    },
  };
  function showAddCommand() {
    const os = ADD_OS[addOs];
    for (const b of addDialog.querySelectorAll('[data-add-os]')) b.setAttribute('aria-checked', String(b.dataset.addOs === addOs));
    $('add-where').textContent = os.where;
    $('add-needs').textContent = os.needs;
    if (addToken) $('add-command').textContent = os.command(location.origin, addToken);
  }
  async function addMachine() {
    addToken = null;
    showAddCommand();
    $('add-command').textContent = 'Making a join token.';
    $('add-expiry').textContent = '';
    addDialog.showModal();
    try {
      const { token, expiresAt } = await hub.json('/api/join-tokens', { method: 'POST' });
      addToken = token;
      showAddCommand();
      const tick = () => {
        const left = Math.round((expiresAt - Date.now()) / 60000);
        $('add-expiry').textContent = left > 0
          ? `Works once, for the next ${left} min (until ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`
          : 'This token has expired. Close and add again for a new one.';
      };
      tick();
      clearInterval(expiryTimer);
      expiryTimer = setInterval(tick, 15000);
    } catch (err) {
      $('add-command').textContent = `Could not make a join token: ${err.message}`;
    }
  }
  addDialog.addEventListener('close', () => { clearInterval(expiryTimer); refresh(); });
  addDialog.addEventListener('click', async (e) => {
    if (e.target === addDialog) return addDialog.close();
    const os = e.target.closest('[data-add-os]')?.dataset.addOs;
    if (os) { addOs = os; showAddCommand(); }
    const action = e.target.closest('[data-add]')?.dataset.add;
    if (action === 'close') addDialog.close();
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText($('add-command').textContent);
        toast('Copied');
      } catch {
        const r = document.createRange();
        r.selectNodeContents($('add-command'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        toast('Selected; copy it with your keyboard or menu');
      }
    }
  });
  $('add-machine-open').addEventListener('click', addMachine);

  // ---------- dashboard ----------

  async function pollDetail() {
    if (!detail) return;
    const d = detail;
    const since = d.samples.at(-1)?.t ?? Date.now() - WINDOW_MS;
    try {
      const r = await hub.json(`/h/${encodeURIComponent(d.id)}/api/metrics?live=1&since=${since}`);
      if (detail !== d) return;
      d.samples.push(...r.samples);
      const cut = Date.now() - WINDOW_MS - 60_000;
      while (d.samples.length > 2 && d.samples[0].t < cut) d.samples.shift();
      d.error = null;
    } catch (err) {
      d.error = err.message;
    }
    if (detail === d) renderDetail();
  }

  function showDetail(id) {
    detail = { id, samples: [] };
    listEl.hidden = true;
    $('machine-tools').hidden = true;
    $('machine-empty').hidden = true;
    detailEl.hidden = false;
    renderDetail();
    pollDetail();
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (!document.hidden) pollDetail(); }, LIVE_MS);
    detailEl.querySelector('.md-back')?.focus();
  }

  function closeDetail() {
    detail = null;
    clearInterval(liveTimer);
    detailEl.hidden = true;
    detailEl.replaceChildren();
    listEl.hidden = false;
    $('machine-tools').hidden = false;
    render();
  }

  function cardBox(title, ...body) {
    return el('section', { class: 'md-card' }, el('h3', { class: 'md-card-title' }, title), ...body);
  }

  function chartRow(points, key, label, format, max) {
    const readout = el('span', { class: 'md-readout' });
    return el('div', { class: 'md-chart' },
      el('div', { class: 'md-chart-head' }, el('span', { class: 'md-chart-label' }, label), readout),
      sparkline({ points, key, label, format, max, readout }));
  }

  function table(head, rows, numeric = []) {
    return el('table', { class: 'md-table' },
      el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', { class: numeric.includes(i) ? 'num' : '' }, h)))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: numeric.includes(i) ? 'num' : '' }, c))))));
  }

  function renderDetail() {
    const m = machines.find((x) => x.id === detail.id);
    if (!m) return closeDetail();
    // Keep the chart under the pointer, and its crosshair, until it leaves.
    if (detailEl.querySelector('.spark:hover')) return;
    const samples = detail.samples;
    const last = samples.at(-1)?.sample;
    const points = series(samples);
    const now = points.at(-1) || {};
    const focus = document.activeElement?.closest?.('#machine-detail') ? document.activeElement.dataset.focusKey : null;

    const head = el('header', { class: 'md-head' },
      el('button', { class: 'btn-icon md-back', type: 'button', 'aria-label': 'Back to machines', title: 'Back to machines', dataset: { focusKey: 'back' } },
        svgUse('i-left')),
      el('div', { class: 'md-title' },
        el('h2', {}, m.name),
        el('span', { class: 'mc-meta' }, [m.local ? 'This computer' : null, [m.os, m.arch].filter(Boolean).join(' '), uptime(last?.uptimeS)].filter(Boolean).join(' · '))),
      statusBadge(m),
      el('div', { class: 'md-actions' },
        m.screen && el('button', { class: 'btn-text btn-open', type: 'button', dataset: { open: 'screen', focusKey: 'screen' } }, svgUse('i-monitor'), 'Screen'),
        m.terminal && el('button', { class: 'btn-text btn-open', type: 'button', dataset: { open: 'term', focusKey: 'term' } }, svgUse('i-terminal'), 'Terminal'),
        !m.local && el('button', { class: 'btn-text md-remove admin-only', type: 'button', dataset: { focusKey: 'remove' } }, 'Remove')));

    const cards = [];
    if (!last) {
      cards.push(el('p', { class: 'md-note' }, detail.error ? `Could not load metrics: ${detail.error}` : m.status === 'online' ? 'Waiting for the first samples.' : 'No metrics: the machine is offline and sent none in the last hour.'));
    } else {
      if (m.status !== 'online') cards.push(el('p', { class: 'md-note' }, `Offline. These are its last values, from ${clock(samples.at(-1).t)}.`));
      const cpu = last.cpu || {};
      const coresNow = (() => {
        const prev = samples.at(-2)?.sample.cpu?.cores;
        return prev && cpu.cores ? cpu.cores.map((c, i) => (prev[i] ? busyShare(prev[i], c) : null)) : [];
      })();
      cards.push(cardBox('Processor',
        el('p', { class: 'md-big' }, pct(now.cpu), el('span', { class: 'md-sub' }, cpu.load ? ` load ${cpu.load.map((l) => l.toFixed(2)).join(', ')}` : '')),
        chartRow(points, 'cpu', 'All cores', pct, 100),
        coresNow.length > 0 && el('div', { class: 'md-cores', 'aria-label': 'Each core' },
          ...coresNow.map((v, i) => el('div', { class: 'md-core', title: `Core ${i}: ${pct(v)}` }, meter(v, `Core ${i}`))))));

      const mem = last.memory;
      if (mem) {
        const used = mem.totalB - mem.availableB;
        const swapUsed = mem.swapTotalB - mem.swapFreeB;
        cards.push(cardBox('Memory',
          el('p', { class: 'md-big' }, bytes(used), el('span', { class: 'md-sub' }, ` of ${bytes(mem.totalB)}`)),
          chartRow(points, 'mem', 'In use', pct, 100),
          el('p', { class: 'md-line' }, mem.commitLimitB
            ? `Committed ${bytes(mem.commitB)} of ${bytes(mem.commitLimitB)} · cache ${bytes(mem.cachedB)}`
            : `Swap ${mem.swapTotalB ? `${bytes(swapUsed)} of ${bytes(mem.swapTotalB)}` : 'none'} · cache ${bytes(mem.cachedB)}`)));
      }

      const pr = last.pressure;
      if (pr) {
        const row = (name, p) => [name, pct(p?.some10), p?.full10 === undefined ? '' : pct(p.full10)];
        cards.push(cardBox('Pressure',
          el('p', { class: 'md-line' }, 'Share of the last 10 s that some or all tasks waited.'),
          table(['', 'Some', 'All'], [row('Processor', pr.cpu), row('Memory', pr.memory), row('Disk', pr.io)], [1, 2])));
      }

      const netRates = lastRates(samples, 'net', ['rxB', 'txB']);
      cards.push(cardBox('Network',
        chartRow(points, 'rx', 'Received', rate),
        chartRow(points, 'tx', 'Sent', rate),
        (last.net || []).length > 0 && table(['Interface', 'Received', 'Sent'], (last.net || []).map((n) => [n.name, rate(netRates.get(n.name)?.rxB), rate(netRates.get(n.name)?.txB)]), [1, 2])));

      const diskRates = lastRates(samples, 'disks', ['readB', 'writeB']);
      cards.push(cardBox('Disks',
        chartRow(points, 'read', 'Read', rate),
        chartRow(points, 'write', 'Written', rate),
        (last.disks || []).length > 0 && table(['Disk', 'Read', 'Written'], (last.disks || []).map((d) => [d.name, rate(diskRates.get(d.name)?.readB), rate(diskRates.get(d.name)?.writeB)]), [1, 2])));

      if ((last.mounts || []).length) {
        cards.push(cardBox('Storage', ...last.mounts.map((mt) => {
          const usedPct = mt.totalB ? (1 - mt.freeB / mt.totalB) * 100 : 0;
          return el('div', { class: 'md-mount' },
            el('div', { class: 'md-chart-head' }, el('span', { class: 'md-chart-label' }, mt.path), el('span', { class: 'md-readout' }, `${bytes(mt.freeB)} free of ${bytes(mt.totalB)}`)),
            meter(usedPct, `${mt.path} used`));
        })));
      }

      if ((last.gpus || []).length) {
        cards.push(cardBox('Graphics', table(['Card', 'Use', 'Encoder', 'Memory', 'Temp.', 'Power'],
          last.gpus.map((g) => [g.name, pct(g.utilPct), pct(g.encoderPct), g.memTotalB ? `${bytes(g.memUsedB, 0)} of ${bytes(g.memTotalB, 0)}` : '–', Number.isFinite(g.c) ? `${g.c} °C` : '–', Number.isFinite(g.powerW) ? `${g.powerW.toFixed(0)} W` : '–']),
          [1, 2, 3, 4, 5])));
      }

      if ((last.temps || []).length) {
        const temps = [...last.temps].sort((a, b) => b.c - a.c);
        cards.push(cardBox('Temperatures', table(['Sensor', '°C'], temps.map((t) => [t.sensor, t.c.toFixed(1)]), [1])));
      }

      if ((last.top || []).length) {
        cards.push(cardBox('Busiest processes', table(['Process', 'PID', 'Processor', 'Memory'],
          last.top.map((p) => [p.name, String(p.pid), pct(p.cpuPct), bytes(p.rssB)]), [1, 2, 3])));
      }
    }

    // Rebuilding once a second must not move the page: keep the scroll position
    // of the view, and focus the control again without scrolling it into view.
    const scroller = detailEl.closest('.machines');
    const scrollTop = scroller?.scrollTop ?? 0;
    detailEl.replaceChildren(head, el('div', { class: 'md-grid' }, ...cards));
    if (scroller) scroller.scrollTop = scrollTop;
    if (focus) detailEl.querySelector(`[data-focus-key="${focus}"]`)?.focus({ preventScroll: true });
  }

  function svgUse(id) {
    const s = svgEl('svg', { class: 'icon' });
    s.append(svgEl('use', { href: `#${id}` }));
    return s;
  }

  detailEl.addEventListener('click', async (e) => {
    if (e.target.closest('.md-back')) return closeDetail();
    const m = machines.find((x) => x.id === detail?.id);
    if (!m) return;
    const go = e.target.closest('[data-open]');
    if (go) return open(m, go.dataset.open);
    if (e.target.closest('.md-remove')) {
      const ok = await ask({
        title: `Remove ${m.name}?`,
        body: 'The hub forgets its key and closes its connections. The agent on it stops; to add it again, install with a new join token.',
        confirm: 'Remove',
      });
      if (!ok) return;
      try {
        await hub.json(`/api/hosts/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
        toast(`${m.name} removed`);
        closeDetail();
        refresh();
      } catch (err) {
        toast(`Could not remove it: ${err.message}`);
      }
    }
  });

  hub.json('/api/prefs').then((p) => { prefs = p; render(); }).catch(() => {});

  return {
    show() {
      visible = true;
      refresh();
      clearInterval(listTimer);
      listTimer = setInterval(() => { if (!document.hidden) refresh(); }, LIST_MS);
      if (detail) showDetail(detail.id);
    },
    hide() {
      visible = false;
      clearInterval(listTimer);
      clearInterval(liveTimer);
    },
    refresh,
    list: () => machines,
    get visible() { return visible; },
  };
}
