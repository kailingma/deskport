import { settings } from './js/settings.js';
import { TERMINAL_THEMES, TERMINAL_FONTS } from './js/themes.js';
import { toggleMod } from './js/keys.js';
import { createScreen } from './js/screen.js';
import { createTerminal } from './js/terminal.js';
import { localHost, hub } from './js/host.js';
import { createMachines } from './js/machines.js';
import { createPeople } from './js/people.js';
import { ask } from './js/dialog.js';
import { pictureOptions, screenChoices, SCREEN_SOURCES, SCREEN_ENCODINGS } from './js/screen-options.js';

const $ = (id) => document.getElementById(id);
// The machine the Screen and Terminal views show; the Machines view switches it.
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
const status = { screen: ['idle', 'Idle'], term: ['idle', 'Idle'], machines: ['idle', 'Idle'] };
let view = 'machines';

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
// The machine being shown, including its screen capabilities and availability note.
let machine = { id: 'local', name: '', local: true, screen: true, terminal: true };
let screenPermissions = { control: true, clipboard: true };

function showMachineName() {
  const name = machine.local ? me?.host ?? '' : machine.name;
  $('host').textContent = machine.local && me?.dev ? `${name} (dev)` : name;
  if (name) document.title = `${name} · deskport`;
  $('no-screen-title').textContent = `${machine.name || 'This machine'} has no screen`;
  $('no-screen-body').textContent = machine.screenNote || 'Screen sharing is not available on this machine. You can still use its other features.';
  $('no-screen').querySelector('[data-view="term"]').hidden = !machine.terminal;
}

hub.json('/api/me').then((data) => {
  me = data;
  document.body.classList.toggle('is-admin', Boolean(data.admin));
  showMachineName();
}).catch(() => {});

const screen = createScreen({
  host, setStatus, toast, machine: () => machine,
  onPermissions(permissions) { screenPermissions = permissions; syncInputControls(); },
});
const term = createTerminal({ host, setStatus, toast });

/** Points Screen and Terminal at another machine, reconnecting what was connected. */
function useMachine(m, { quiet = false } = {}) {
  noMachines = false;
  const same = m.id === machine.id || (m.local && machine.local);
  const next = {
    id: m.local ? 'local' : m.id, name: m.name, local: Boolean(m.local), screen: Boolean(m.screen), terminal: m.terminal !== false,
    screenSources: m.screenSources ?? [], screenEncodings: m.screenEncodings ?? [],
    screenBackend: m.screenBackend, screenNote: m.screenNote ?? null,
  };
  if (same && JSON.stringify(next) === JSON.stringify(machine)) return;
  const previous = machine;
  const before = JSON.stringify(pictureOptions(machine, settings.get));
  machine = next;
  try { localStorage.setItem('deskport.host', machine.local ? 'local' : machine.id); } catch {}
  showMachineName();
  document.body.classList.toggle('no-screen', !machine.screen);
  $('no-screen').hidden = machine.screen;
  if (!same) {
    host.use(machine.id);
    settings.useHost(m.id, machine.local);
  }
  syncSource();
  syncInputControls();
  const changed = !same || machine.screen !== previous.screen || machine.screenBackend !== previous.screenBackend
    || before !== JSON.stringify(pictureOptions(machine, settings.get));
  if (!machine.screen) screen.stop();
  else if (changed) {
    if (view === 'screen') screen.reconnect();
    // A different machine: drop the old connection so its late video,
    // clipboard or connect callbacks cannot reach the new one.
    else if (!same) screen.close();
    else screen.markStale();
  }
  if (!machine.terminal) {
    term.stop();
    if (view === 'term') showView('machines');
  } else if (!same) term.switchHost();
  else if (!previous.terminal && view === 'term') term.ensureConnected();
  if (settingsDialog.open) {
    syncSettingsForm();
    if (changed) screenAtOpen = screenSettings();
    if (!same) { refreshSession(); refreshMonitors(); }
  }
  if (!quiet && !same) toast(`Showing ${m.name}`);
}

const machines = createMachines({
  toast,
  currentId: () => machine.id,
  watchSelected: () => !machine.local,
  open(m, which) {
    useMachine(m);
    showView(which === 'screen' && !m.screen ? 'term' : which);
  },
  onList(list, err) {
    if (err) setStatus('machines', 'bad', 'Hub unreachable');
    else {
      const online = list.filter((m) => m.status === 'online').length;
      setStatus('machines', 'ok', `${online} of ${list.length} online`);
    }
    // The shown machine was removed or taken away: the hub's own, else the
    // first one this person has, else none.
    if (!err && !list.some((m) => (machine.local ? m.local : m.id === machine.id))) {
      const next = list.find((m) => m.local) || list[0];
      if (next) useMachine(next);
      else showNoMachines();
    } else if (!err) {
      const cur = list.find((m) => (machine.local ? m.local : m.id === machine.id));
      if (cur) useMachine(cur, { quiet: true });
    }
  },
});

const people = createPeople({ toast });
$('people-open').addEventListener('click', () => people.open());

/** Someone with no machines: Screen and Terminal stay closed, Machines says why. */
let noMachines = false;
function showNoMachines() {
  if (noMachines) return;
  noMachines = true;
  screen.stop();
  term.stop();
  showView('machines');
}

// ---------- views ----------

function showView(next) {
  if (noMachines && next !== 'machines') {
    toast('No machines have been given to you yet');
    next = 'machines';
  }
  if (next === 'term' && !machine.terminal) {
    toast('This machine has no terminal');
    next = 'machines';
  }
  view = next;
  document.body.dataset.view = next;
  for (const tab of document.querySelectorAll('button[data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === next));
  }
  $('view-screen').hidden = next !== 'screen';
  $('view-term').hidden = next !== 'term';
  $('view-machines').hidden = next !== 'machines';
  setStatus(next, ...status[next]);
  syncInputControls();

  if (next === 'machines') {
    screen.releaseKeys();
    machines.show();
    return;
  }
  machines.hide();
  if (next === 'screen') {
    if (!machine.screen) return;
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

// Alt+1, Alt+2 and Alt+3 switch views without reaching the remote desktop or shell.
window.addEventListener('keydown', (e) => {
  const next = { 1: 'machines', 2: 'screen', 3: 'term' }[e.key];
  if (e.altKey && !e.ctrlKey && !e.metaKey && next) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showView(next);
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
const PORTAL_QUALITY_HELP = {
  low: 'JPEG at 40% quality. Small text can be hard to read. Uses the least data.',
  medium: 'JPEG at 65% quality. Text is clearer, at more data.',
  high: 'JPEG at 85% quality. Sharper text, at more data.',
  lossless: 'JPEG at 95% quality. The sharpest images here, but not exact pixels.',
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
const PORTAL_SPEED_HELP = ['Encodes quickly, at more data.', 'Spends longer encoding to use less data.', 'Spends the most time encoding to use the least data.'];
const SCREEN_SETTINGS = ['source', 'resolution', 'quality', 'priority', 'matchMonitor', 'monitor', 'encoding', 'encSpeed', 'bitrate', 'direct'];
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
  const { sources, encodings } = screenChoices(machine);
  const options = pictureOptions(machine, settings.get);
  const portal = machine.screenBackend === 'portal';
  $('screen-settings').hidden = !machine.screen;
  fillScreenSelect('set-source', sources, SCREEN_SOURCES);
  fillScreenSelect('set-encoding', encodings, SCREEN_ENCODINGS);
  $('source-row').hidden = sources.length < 2;
  for (const group of settingsDialog.querySelectorAll('[role="radiogroup"][data-setting]')) {
    const value = settings.get(group.dataset.setting);
    for (const b of group.querySelectorAll('[role="radio"]')) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  const source = options.source;
  $('set-source').value = source;
  $('source-help').textContent = portal
    ? 'The monitor chosen in this machine\'s sharing dialog. Its resolution is not changed. Someone there must allow the first connection.'
    : SOURCE_HELP[source];
  const matched = options.matchMonitor;
  $('monitor-rows').hidden = !machine.local || source !== 'mirror';
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
  const encoding = options.encoding;
  const isVideo = encoding !== 'images';
  $('set-encoding').value = encoding;
  const name = encoding === 'av1' ? 'AV1' : 'H.264';
  const encodingHelp = !portal ? ENCODING_HELP[encoding] : encoding === 'images'
    ? 'Full frames are sent as JPEG pictures. Works in every browser.'
    : 'A video stream, encoded on this machine\'s processor. The pointer is part of the picture.';
  $('encoding-help').textContent = encodingHelp
    + (!isVideo || !decodes ? '' : decodes[encoding] ? ` This browser can decode ${name}.` : ` This browser cannot decode ${name}, so images are sent instead.`);
  $('video-rows').hidden = !isVideo;
  if (isVideo) {
    $('set-enc-speed').value = String(settings.get('encSpeed'));
    $('enc-speed-help').textContent = (portal ? PORTAL_SPEED_HELP : SPEED_HELP[encoding])[settings.get('encSpeed')];
    $('set-bitrate').value = settings.get('bitrate');
    $('bitrate-help').textContent = bitrateHelp(settings.get('bitrate'), settings.get('priority'));
    $('video-stats').textContent = videoStatsLine();
    $('video-stats').hidden = !$('video-stats').textContent;
    $('direct-rows').hidden = !machine.local || source !== 'session';
    $('set-direct').checked = settings.get('direct');
    $('direct-help').textContent = settings.get('direct')
      ? 'Keys and the pointer go straight to the separate desktop, and its picture is recorded without Remote Desktop. It starts in about half a second. Not yet: the clipboard, and the pointer is part of the video, so it moves with the picture.'
      : 'Off: the separate desktop is reached through Remote Desktop, like your monitor.';
  }
  $('set-quality').value = String(QUALITY.indexOf(settings.get('quality')));
  $('quality-top-label').textContent = portal ? 'Highest' : 'Lossless';
  $('quality-help').textContent = (isVideo ? VIDEO_QUALITY_HELP : portal ? PORTAL_QUALITY_HELP : QUALITY_HELP)[settings.get('quality')];
  const [fps, adapt] = VIDEO_PRIORITY_HELP[settings.get('priority')];
  $('priority-help').textContent = !isVideo ? portal ? `Up to ${settings.get('priority') === 'data' ? 10 : 30} frames a second. Frames wait for this browser to acknowledge the picture.` : PRIORITY_HELP[settings.get('priority')]
    : settings.get('bitrate') === 'auto' ? `${fps} ${adapt}` : fps;
  $('set-term-theme').value = settings.get('termTheme');
  $('set-term-font').value = settings.get('termFont');
  $('set-term-size').value = String(settings.get('termFontSize'));
  $('term-size-value').textContent = `${settings.get('termFontSize')}px`;
  $('set-blink').checked = settings.get('cursorBlink');
  $('kb-help').textContent = portal && settings.get('kbResize') === 'resize'
    ? 'The picture shrinks to fit above the keyboard. This machine\'s monitor is not resized.'
    : KB_HELP[settings.get('kbResize')];
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
  else if (t.id === 'set-direct') settings.set('direct', t.checked);
  else if (t.dataset.setting) settings.set(t.dataset.setting, t.value);
  syncSettingsForm();
  if (t.id === 'set-source') refreshSession();
});
const screenSettings = () => JSON.stringify({ ...Object.fromEntries(SCREEN_SETTINGS.map((k) => [k, settings.get(k)])), ...pictureOptions(machine, settings.get) });

settingsDialog.addEventListener('close', () => {
  if (!machine.screen || screenSettings() === screenAtOpen) return;
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
  if (!machine.local) { monitorList = []; syncMonitorPick(); return; }
  const id = host.id;
  try {
    const list = await host.json('/api/monitors');
    if (host.id !== id) return;
    monitorList = list;
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
  if (!machine.local) { row.hidden = true; return; }
  const id = host.id;
  try {
    const s = await host.json('/api/session');
    if (host.id !== id) return;
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

function fillScreenSelect(id, choices, labels) {
  $(id).replaceChildren(...choices.map((v) => new Option(labels[v], v)));
}

function syncSource() {
  const { sources } = screenChoices(machine);
  const source = pictureOptions(machine, settings.get).source;
  fillScreenSelect('quick-source', sources, SCREEN_SOURCES);
  $('quick-source').hidden = sources.length < 2;
  $('sheet-sources').hidden = sources.length < 2;
  $('quick-source').value = source;
  for (const b of document.querySelectorAll('[data-source]')) {
    b.hidden = !sources.includes(b.dataset.source);
    b.setAttribute('aria-checked', String(b.dataset.source === source));
  }
}

function switchSource(source) {
  if (!screenChoices(machine).sources.includes(source) || source === pictureOptions(machine, settings.get).source) return;
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

function syncInputControls() {
  const control = machine.screen && screenPermissions.control;
  for (const b of document.querySelectorAll('[data-action="super"], [data-action="cad"]')) b.disabled = !control;
  for (const b of document.querySelectorAll('[data-action="clipboard"]')) b.disabled = !machine.screen || !screenPermissions.clipboard;
  for (const b of document.querySelectorAll('[data-action="keyboard"]')) b.disabled = view === 'screen' && !control;
  document.body.classList.toggle('screen-view-only', !control);
  $('keyrow').inert = view === 'screen' && !control;
}

const actions = {
  clipboard: () => screen.sendClipboard(),
  paste: () => term.paste(),
  super: () => screen.superKey(),
  cad: () => screen.ctrlAltDel(),
  fullscreen: toggleFullscreen,
  reconnect: () => (view === 'screen' ? machine.screen && screen.reconnect() : view === 'term' ? term.reconnect() : machines.refresh()),
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

// Every visit opens on Machines, so Screen does not connect until it is shown.
// The machine last shown on this device stays selected for Screen and Terminal.
const initial = 'machines';
let savedHost = 'local';
try {
  // Nothing saved (a first visit): wait for the list, since the hub's own
  // machine may not be one this person was given.
  savedHost = localStorage.getItem('deskport.host');
} catch {}
if (savedHost === null) {
  hub.json('/api/hosts').then((list) => {
    const m = list.find((x) => x.local) || list[0];
    if (m) useMachine(m, { quiet: true });
    else showNoMachines();
  }).catch(() => {}).finally(() => { if (!noMachines) showView(initial); });
} else {
  showView(initial);
  if (savedHost !== 'local') hub.json('/api/hosts').then((list) => { const m = list.find((x) => x.id === savedHost && !x.local); if (m) useMachine(m, { quiet: true }); }).catch(() => {});
}
