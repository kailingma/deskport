import { settings } from './js/settings.js';
import { TERMINAL_THEMES, TERMINAL_FONTS } from './js/themes.js';
import { toggleMod } from './js/keys.js';
import { createScreen } from './js/screen.js';
import { createTerminal } from './js/terminal.js';

const $ = (id) => document.getElementById(id);
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const canFullscreen = Boolean(document.fullscreenEnabled);
const coarse = matchMedia('(pointer: coarse)');
// Running from a Home Screen icon: no browser bars to hide.
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
document.documentElement.classList.toggle('can-fullscreen', canFullscreen);
// iPhone Safari has no full-screen mode for pages; offer the Home Screen route instead.
document.documentElement.classList.toggle('can-install', !canFullscreen && !standalone && coarse.matches);

// ---------- status, toast ----------

const statusEl = $('status');
const status = { screen: ['idle', 'Idle'], term: ['idle', 'Idle'] };
let view = 'screen';

function setStatus(which, state, text) {
  status[which] = [state, text];
  // Phones have no top bar; the tab bar shows a dot while a view is not connected.
  const dot = document.querySelector(`.tab-dot[data-status-for="${which}"]`);
  if (dot) dot.dataset.state = state;
  if (which !== view) return;
  statusEl.dataset.state = state;
  statusEl.querySelector('.badge-text').textContent = text;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

let me = null;
fetch('/api/me').then((r) => r.json()).then((data) => {
  me = data;
  $('host').textContent = me.dev ? `${me.host} (dev)` : me.host;
  document.title = `${me.host} · deskport`;
}).catch(() => {});

const screen = createScreen({ wsBase, setStatus, toast });
const term = createTerminal({ wsBase, setStatus });

// ---------- views ----------

function showView(next) {
  view = next;
  document.body.dataset.view = next;
  for (const tab of document.querySelectorAll('button[data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === next));
  }
  $('view-screen').hidden = next !== 'screen';
  $('view-term').hidden = next !== 'term';
  setStatus(next, ...status[next]);
  try { localStorage.setItem('deskport.view', next); } catch {}

  if (next === 'screen') {
    screen.ensureConnected();
    if (!coarse.matches) screen.focus();
  } else {
    screen.releaseKeys();
    term.ensureConnected();
    if (!coarse.matches) term.focus();
  }
}

for (const tab of document.querySelectorAll('button[data-view]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

// Alt+1 / Alt+2 switch views without reaching the remote desktop or shell.
window.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '1' || e.key === '2')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showView(e.key === '1' ? 'screen' : 'term');
  }
}, true);

// ---------- full screen and the floating toolbar ----------

const bar = $('bar');
const handle = $('bar-handle');
let idleTimer;

function wakeBar() {
  bar.classList.remove('is-idle');
  handle.hidden = true;
  clearTimeout(idleTimer);
  if (!document.fullscreenElement) return;
  idleTimer = setTimeout(() => {
    if (bar.matches(':hover') || bar.contains(document.activeElement)) return wakeBar();
    bar.classList.add('is-idle');
    handle.hidden = false;
  }, 2500);
}

async function toggleFullscreen() {
  if (!canFullscreen) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
  // Chrome only: lets Escape, Super, Alt+Tab and similar reach the remote side.
  try { await navigator.keyboard?.lock(); } catch {}
}

document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', on);
  $('fs-icon').setAttribute('href', on ? '#i-minimize' : '#i-maximize');
  for (const b of document.querySelectorAll('[data-action="fullscreen"]')) {
    if (b.classList.contains('btn-icon')) {
      b.title = on ? 'Exit full screen' : 'Full screen';
      b.setAttribute('aria-label', b.title);
    }
  }
  if (!on) try { navigator.keyboard?.unlock(); } catch {}
  wakeBar();
  setTimeout(() => { screen.rescale(); term.fit(); }, 60);
});

document.addEventListener('mousemove', (e) => {
  if (document.fullscreenElement && e.clientY < 56) wakeBar();
});
bar.addEventListener('mouseleave', () => document.fullscreenElement && wakeBar());
handle.addEventListener('click', wakeBar);

// ---------- settings ----------

const settingsDialog = $('settings');
const QUALITY = ['low', 'medium', 'high', 'lossless'];
const QUALITY_HELP = {
  low: 'JPEG at 35% quality. Small text is hard to read. Uses the least data.',
  medium: 'JPEG at 60% quality. Text is readable.',
  high: 'Sharp. Areas that are changing look soft for a moment.',
  lossless: 'Exact pixels. Uses about a third more data than High.',
};
const PRIORITY_HELP = {
  speed: 'Sends every frame as soon as it is ready.',
  data: 'Sends at most 10 frames a second.',
};
const SCREEN_SETTINGS = ['source', 'resolution', 'quality', 'priority'];
const SOURCE_HELP = {
  mirror: 'What is on your monitor, at its resolution.',
  virtual: 'A second monitor next to yours, sized to this device. It has no top bar or dock, so drag windows onto it.',
  session: 'A separate GNOME desktop sized to this device. Your monitor is not affected.',
};
let screenAtOpen = '';

function fillSelect(id, entries) {
  $(id).replaceChildren(...Object.entries(entries).map(([value, { label }]) => new Option(label, value)));
}
fillSelect('set-term-theme', TERMINAL_THEMES);
fillSelect('set-term-font', TERMINAL_FONTS);

function syncSettingsForm() {
  for (const group of settingsDialog.querySelectorAll('[role="radiogroup"][data-setting]')) {
    const value = settings.get(group.dataset.setting);
    for (const b of group.querySelectorAll('[role="radio"]')) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  const source = settings.get('source');
  $('set-source').value = source;
  $('source-help').textContent = SOURCE_HELP[source];
  $('set-resolution').value = settings.get('resolution');
  $('set-resolution').disabled = source !== 'mirror';
  const size = screen.pictureSize();
  $('resolution-help').textContent = source !== 'mirror'
    ? 'Always matches this window.'
    : size ? `Receiving ${size[0]} × ${size[1]} pixels.` : '';
  $('set-quality').value = String(QUALITY.indexOf(settings.get('quality')));
  $('quality-help').textContent = QUALITY_HELP[settings.get('quality')];
  $('priority-help').textContent = PRIORITY_HELP[settings.get('priority')];
  $('set-term-theme').value = settings.get('termTheme');
  $('set-term-font').value = settings.get('termFont');
  $('set-term-size').value = String(settings.get('termFontSize'));
  $('term-size-value').textContent = `${settings.get('termFontSize')}px`;
  $('set-blink').checked = settings.get('cursorBlink');
  $('settings-who').textContent = me ? `Signed in as ${me.email} on ${me.host}` : '';
}

settingsDialog.addEventListener('click', (e) => {
  const radio = e.target.closest('[role="radio"]');
  if (radio) {
    settings.set(radio.closest('[data-setting]').dataset.setting, radio.dataset.value);
    syncSettingsForm();
  }
  if (e.target === settingsDialog) settingsDialog.close();
});
// Arrow keys move within a radio group.
settingsDialog.addEventListener('keydown', (e) => {
  const radio = e.target.closest('[role="radio"]');
  if (!radio || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const radios = [...radio.parentElement.querySelectorAll('[role="radio"]')];
  const next = radios[(radios.indexOf(radio) + (/Right|Down/.test(e.key) ? 1 : radios.length - 1)) % radios.length];
  next.click();
  next.focus();
});
settingsDialog.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'set-quality') settings.set('quality', QUALITY[Number(t.value)]);
  else if (t.id === 'set-term-size') settings.set('termFontSize', Number(t.value));
  else if (t.id === 'set-blink') settings.set('cursorBlink', t.checked);
  else if (t.dataset.setting) settings.set(t.dataset.setting, t.value);
  syncSettingsForm();
  if (t.id === 'set-source') refreshSession();
});
const screenSettings = () => SCREEN_SETTINGS.map((k) => settings.get(k)).join('|');

settingsDialog.addEventListener('close', () => {
  if (screenSettings() === screenAtOpen) return;
  if (view === 'screen') {
    screen.reconnect();
    toast('Reconnecting with the new picture settings');
  } else {
    screen.markStale();
  }
});

function openSettings() {
  screenAtOpen = screenSettings();
  syncSettingsForm();
  refreshSession();
  settingsDialog.showModal();
}

// ---------- the separate desktop ----------

async function refreshSession() {
  const row = $('session-row');
  try {
    const s = await (await fetch('/api/session')).json();
    row.hidden = s.state === 'stopped' && settings.get('source') !== 'session';
    $('session-state').textContent = {
      running: `Running${s.memoryMB ? ` and using ${s.memoryMB} MB of memory` : ''}. Apps in it keep running after you disconnect.`,
      starting: 'Starting.',
      stopped: 'Not running. It starts when you show it.',
      missing: 'Not installed. Run scripts/install-services.sh on the computer.',
    }[s.state] ?? 'Unknown';
    $('end-session').hidden = s.state !== 'running' && s.state !== 'starting';
  } catch {
    row.hidden = true;
  }
}

async function endSession() {
  if (!confirm('End the separate desktop? Apps open in it will close.')) return;
  $('end-session').disabled = true;
  try {
    const r = await fetch('/api/session/stop', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    toast('Separate desktop ended');
    if (settings.get('source') === 'session') screen.markStale();
  } catch (err) {
    toast(`Could not end it: ${err.message}`);
  }
  $('end-session').disabled = false;
  refreshSession();
}

// ---------- quick source switch (top bar, More sheet) ----------

function syncSource() {
  const source = settings.get('source');
  $('quick-source').value = source;
  for (const b of document.querySelectorAll('[data-source]')) b.setAttribute('aria-checked', String(b.dataset.source === source));
}

function switchSource(source) {
  if (source === settings.get('source')) return;
  settings.set('source', source);
  if (view === 'screen') screen.reconnect();
  else screen.markStale();
}

$('quick-source').addEventListener('change', (e) => {
  switchSource(e.target.value);
  if (!coarse.matches) screen.focus();
});
$('sheet-source').addEventListener('click', (e) => {
  const b = e.target.closest('[data-source]');
  if (!b) return;
  switchSource(b.dataset.source);
  sheet.close();
});
syncSource();

// Theme and key-row preferences that live outside the views.
function applyTheme() {
  const theme = settings.get('theme');
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? '#111111' : '#ffffff';
}
function applyKeyRow() {
  document.body.classList.toggle('keyrow-always', settings.get('keyRow') === 'always');
  document.body.classList.toggle('keyrow-never', settings.get('keyRow') === 'never');
}
applyTheme();
applyKeyRow();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
settings.onChange((key) => {
  if (key === 'theme') applyTheme();
  if (key === 'keyRow') applyKeyRow();
  if (key === 'source') syncSource();
});

// ---------- actions (top bar, toolbar, sheet) ----------

const sheet = $('sheet');

const actions = {
  clipboard: () => screen.sendClipboard(),
  super: () => screen.superKey(),
  cad: () => screen.ctrlAltDel(),
  fullscreen: toggleFullscreen,
  reconnect: () => (view === 'screen' ? screen.reconnect() : term.reconnect()),
  keyboard: () => (view === 'screen' ? screen.showKeyboard() : term.focus()),
  sheet: () => sheet.showModal(),
  'close-sheet': () => sheet.close(),
  settings: openSettings,
  'close-settings': () => settingsDialog.close(),
  'end-session': endSession,
  install: () => $('install').showModal(),
  'close-install': () => $('install').close(),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.closest('#sheet')) sheet.close();
  actions[btn.dataset.action]?.();
  const keepFocus = ['reconnect', 'settings', 'close-settings', 'sheet'].includes(btn.dataset.action);
  if (!coarse.matches && view === 'screen' && !keepFocus) screen.focus();
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
$('install').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- key row ----------

const keyrow = $('keyrow');
// Keep focus (and the soft keyboard) where it is while tapping keys.
keyrow.addEventListener('pointerdown', (e) => e.preventDefault());
keyrow.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.mod) return toggleMod(btn.dataset.mod);
  (view === 'screen' ? screen : term).key(btn.dataset.key);
});

// ---------- fit the app to the visible viewport (iOS keyboard) ----------

const vv = window.visualViewport;
function syncViewport() {
  if (!vv) return;
  document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
  document.body.style.top = `${vv.offsetTop}px`;
  document.body.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
}
vv?.addEventListener('resize', syncViewport);
vv?.addEventListener('scroll', syncViewport);
syncViewport();

// ---------- start ----------

let initial = 'screen';
try { initial = localStorage.getItem('deskport.view') === 'term' ? 'term' : 'screen'; } catch {}
showView(initial);
