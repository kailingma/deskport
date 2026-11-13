import { settings } from './js/settings.js';
import { TERMINAL_THEMES, TERMINAL_FONTS } from './js/themes.js';
import { toggleMod } from './js/keys.js';
import { createScreen } from './js/screen.js';
import { createTerminal } from './js/terminal.js';
import { localHost } from './js/host.js';
import { ask } from './js/dialog.js';

const $ = (id) => document.getElementById(id);
// One host for now: the server that served this page (docs/multi-host.md).
const host = localHost;
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
/**
 * Shows a short message. With an action, the toast holds a button (or, with
 * href, a link that opens in a new tab) and stays up longer; browsers only
 * let a page open tabs and write the clipboard from a tap or click.
 */
function toast(text, { action, ms } = {}) {
  const el = $('toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { className: 'toast-text', textContent: text }));
  el.classList.toggle('has-action', Boolean(action));
  if (action) {
    const btn = document.createElement(action.href ? 'a' : 'button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    if (action.href) Object.assign(btn, { href: action.href, target: '_blank', rel: 'noopener noreferrer' });
    btn.addEventListener('click', () => {
      action.onClick?.();
      el.classList.remove('show');
    });
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms ?? (action ? 15000 : 2400));
}

let me = null;
host.json('/api/me').then((data) => {
  me = data;
  $('host').textContent = me.dev ? `${me.host} (dev)` : me.host;
  document.title = `${me.host} · deskport`;
}).catch(() => {});

const screen = createScreen({ host, setStatus, toast });
const term = createTerminal({ host, setStatus, toast });

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
  low: 'Compressed at 35% quality. Small text is hard to read. Uses the least data.',
  medium: 'Compressed at 60% quality. Text is readable.',
  high: 'Sharp. Areas that are changing look soft for a moment.',
  lossless: 'Exact pixels. Uses about a third more data than High.',
};
const PRIORITY_HELP = {
  speed: 'Sends every frame as soon as it is ready.',
  data: 'Sends at most 10 frames a second.',
};
// With a video encoding the slider sets the encoder's quantizer range, not an image format.
const VIDEO_QUALITY_HELP = {
  low: 'Blurry text, and the least data, also while the screen is still.',
  medium: 'Readable text.',
  high: 'Sharp text once the picture stops changing.',
  lossless: 'The sharpest the video encoder allows, at the most data. Not exact pixels.',
};
const VIDEO_PRIORITY_HELP = {
  speed: ['Up to 30 frames a second.', 'Adapt keeps the delay as low as the connection allows.'],
  data: ['Up to 10 frames a second.', 'Adapt uses at most half the bitrate and raises it slowly.'],
};
const ENCODING_HELP = {
  images: 'Changed areas are sent as pictures. Works in every browser.',
  av1: 'A video stream, encoded on the computer\'s processor. Moving content uses much less data than images.',
  h264: 'A video stream, encoded on the computer\'s graphics card, which leaves the processor free. More devices decode it than AV1.',
};
// Measured on this computer's encoders, per 1920 x 1080 frame.
const SPEED_HELP = {
  av1: ['About 13 ms to encode a frame.', 'About 15 ms to encode a frame, searching longer for a smaller encoding.', 'About 19 ms to encode a frame, the encoder\'s most thorough setting here.'],
  h264: ['About 2 ms to encode a frame.', 'About 3 ms to encode a frame, searching longer for a smaller encoding.', 'About 5 ms to encode a frame, the encoder\'s most thorough setting here.'],
};
const SCREEN_SETTINGS = ['source', 'resolution', 'quality', 'priority', 'matchMonitor', 'monitor', 'encoding', 'encSpeed', 'bitrate'];
let decodes = null;
screen.videoSupport().then((s) => {
  decodes = s;
  if (settingsDialog.open) syncSettingsForm();
});

function bitrateHelp(bitrate, priority) {
  if (bitrate === 'auto') {
    return priority === 'data'
      ? 'Starts low and raises the bitrate slowly while frames arrive on time. Lowers it when they start to queue.'
      : 'Raises the bitrate while frames arrive on time and lowers it as soon as they start to queue.';
  }
  return `Always ${Number(bitrate) / 1000} Mbit/s. When the connection cannot carry it, frames are skipped instead of queued.`;
}

/** One line about the video stream being received, or ''. */
function videoStatsLine() {
  const { encoding, stats } = screen.videoInfo();
  if (encoding === 'images' || !stats) return '';
  const mbit = (kbps) => (kbps / 1000).toFixed(kbps < 10000 ? 1 : 0);
  const parts = [`Now ${mbit(stats.sentKbps)} Mbit/s at ${stats.fps} frames a second`];
  if (settings.get('bitrate') === 'auto') parts.push(`target ${mbit(stats.kbps)} Mbit/s`);
  if (stats.rttMs !== null) parts.push(`${stats.rttMs} ms round trip`);
  return `${parts.join(', ')}.`;
}
const KB_HELP = {
  resize: 'The screen shrinks to fit above the keyboard. A separate desktop or extra monitor is resized to match.',
  keep: 'The keyboard covers the bottom of the screen and nothing is resized. Drag with one finger to see what is under it.',
};
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
  const matched = source === 'mirror' && settings.get('matchMonitor');
  $('monitor-rows').hidden = source !== 'mirror';
  $('set-match').checked = settings.get('matchMonitor');
  $('match-help').textContent = settings.get('matchMonitor')
    ? 'While you are connected, the monitor switches to the resolution closest to this device. It switches back a few seconds after you disconnect.'
    : 'Off: the monitor keeps its resolution and the picture is scaled to fit.';
  syncMonitorPick();
  $('set-resolution').value = settings.get('resolution');
  $('set-resolution').disabled = source !== 'mirror' || matched;
  const size = screen.pictureSize();
  $('resolution-help').textContent = source !== 'mirror' || matched
    ? 'Always matches this window.'
    : size ? `Receiving ${size[0]} × ${size[1]} pixels.` : '';
  const encoding = settings.get('encoding');
  const isVideo = encoding !== 'images';
  $('set-encoding').value = encoding;
  const name = encoding === 'av1' ? 'AV1' : 'H.264';
  $('encoding-help').textContent = ENCODING_HELP[encoding]
    + (!isVideo || !decodes ? '' : decodes[encoding] ? ` This browser can decode ${name}.` : ` This browser cannot decode ${name}, so images are sent instead.`);
  $('video-rows').hidden = !isVideo;
  if (isVideo) {
    $('set-enc-speed').value = String(settings.get('encSpeed'));
    $('enc-speed-help').textContent = SPEED_HELP[encoding][settings.get('encSpeed')];
    $('set-bitrate').value = settings.get('bitrate');
    $('bitrate-help').textContent = bitrateHelp(settings.get('bitrate'), settings.get('priority'));
    $('video-stats').textContent = videoStatsLine();
    $('video-stats').hidden = !$('video-stats').textContent;
  }
  $('set-quality').value = String(QUALITY.indexOf(settings.get('quality')));
  $('quality-help').textContent = (isVideo ? VIDEO_QUALITY_HELP : QUALITY_HELP)[settings.get('quality')];
  const [fps, adapt] = VIDEO_PRIORITY_HELP[settings.get('priority')];
  $('priority-help').textContent = !isVideo ? PRIORITY_HELP[settings.get('priority')]
    : settings.get('bitrate') === 'auto' ? `${fps} ${adapt}` : fps;
  $('set-term-theme').value = settings.get('termTheme');
  $('set-term-font').value = settings.get('termFont');
  $('set-term-size').value = String(settings.get('termFontSize'));
  $('term-size-value').textContent = `${settings.get('termFontSize')}px`;
  $('set-blink').checked = settings.get('cursorBlink');
  $('kb-help').textContent = KB_HELP[settings.get('kbResize')];
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
settingsDialog.addEventListener('input', async (e) => {
  const t = e.target;
  if (t.id === 'set-match') {
    if (!t.checked) settings.set('matchMonitor', false);
    else {
      t.checked = false;
      const ok = await ask({
        title: 'Change your monitor\'s resolution?',
        body: 'While you are connected, the physical monitor switches to the resolution closest to this device, and windows on it rearrange. '
          + 'On this computer a resolution change once left the monitor blank until the next login.',
        confirm: 'Turn on',
      });
      if (ok) settings.set('matchMonitor', true);
    }
    syncSettingsForm();
    return;
  }
  if (t.id === 'set-quality') settings.set('quality', QUALITY[Number(t.value)]);
  else if (t.id === 'set-enc-speed') settings.set('encSpeed', Number(t.value));
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

// ---------- physical monitors (My monitor) ----------

let monitorList = [];
function syncMonitorPick() {
  const pick = $('set-monitor');
  const several = monitorList.length > 1;
  $('monitor-pick-row').hidden = !several;
  $('monitor-help').hidden = !several;
  if (!several) return;
  pick.replaceChildren(new Option('Primary monitor', 'primary'),
    ...monitorList.map((m) => new Option(`${m.name} (${m.connector})${m.primary ? ', primary' : ''}`, m.connector)));
  pick.value = monitorList.some((m) => m.connector === settings.get('monitor')) ? settings.get('monitor') : 'primary';
  $('monitor-help').textContent = 'GNOME desktop sharing shows one monitor at a time. The one chosen is made the primary monitor while you are connected.';
}
async function refreshMonitors() {
  try {
    monitorList = await host.json('/api/monitors');
  } catch {
    monitorList = [];
  }
  syncMonitorPick();
}

function openSettings() {
  screen.cancelGesture();
  screenAtOpen = screenSettings();
  syncSettingsForm();
  refreshSession();
  refreshMonitors();
  settingsDialog.showModal();
  // The video stream's numbers change while the dialog is open.
  const statsTimer = setInterval(() => {
    const line = videoStatsLine();
    $('video-stats').textContent = line;
    $('video-stats').hidden = !line;
  }, 1000);
  settingsDialog.addEventListener('close', () => clearInterval(statsTimer), { once: true });
}

// ---------- the separate desktop ----------

async function refreshSession() {
  const row = $('session-row');
  try {
    const s = await host.json('/api/session');
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
  const ok = await ask({
    title: 'End the separate desktop?',
    body: 'Apps open in it will close. It starts again the next time you show it.',
    confirm: 'End it',
  });
  if (!ok) return;
  $('end-session').disabled = true;
  try {
    await host.json('/api/session/stop', { method: 'POST' });
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

// ---------- reload without the browser cache ----------

// Browsers have no forced reload a page can trigger, so every file this page
// loaded is fetched again past the cache first, then the page reloads.
async function hardReload() {
  toast('Reloading');
  try {
    const urls = new Set([location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]);
    const own = [...urls].filter((u) => {
      const url = new URL(u);
      return url.origin === location.origin && !/^\/(h\/[^/]+\/)?(api|ws)\//.test(url.pathname);
    });
    await Promise.all(own.map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => {})));
    if (window.caches) for (const key of await caches.keys()) await caches.delete(key);
  } catch {}
  location.reload();
}

// ---------- actions (top bar, toolbar, sheet) ----------

const sheet = $('sheet');

const actions = {
  clipboard: () => screen.sendClipboard(),
  paste: () => term.paste(),
  super: () => screen.superKey(),
  cad: () => screen.ctrlAltDel(),
  fullscreen: toggleFullscreen,
  reconnect: () => (view === 'screen' ? screen.reconnect() : term.reconnect()),
  keyboard: () => (view === 'screen' ? screen.showKeyboard() : term.focus()),
  sheet: () => { screen.cancelGesture(); sheet.showModal(); },
  'close-sheet': () => sheet.close(),
  settings: openSettings,
  'close-settings': () => settingsDialog.close(),
  'end-session': endSession,
  'hard-reload': hardReload,
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
  if (btn.dataset.action) return;
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
