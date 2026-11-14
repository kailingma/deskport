// Per-device settings, kept in localStorage. Every change is broadcast to listeners.

const KEY = 'deskport.settings';
const phone = matchMedia('(max-width: 640px)').matches;

export const DEFAULTS = {
  theme: 'system', // system | light | dark
  source: 'mirror', // mirror: the physical monitor | virtual: an extra GNOME monitor sized to this device | session: a separate headless desktop
  matchMonitor: false, // mirror only: change the monitor's mode to fit this device while connected
  monitor: 'primary', // mirror only: 'primary' or a connector name such as DP-1
  resolution: 'auto', // auto | 1 | 0.75 | 0.5 | 0.33 (scale of the desktop's native size)
  quality: 'high', // low | medium | high | lossless
  priority: 'speed', // speed: every frame | data: about 10 frames per second
  encoding: 'images', // images: guacd's pictures | av1 | h264: a video stream (shim/video.js)
  encSpeed: 0, // video encoder speed: 0 fastest | 1 balanced | 2 smallest
  bitrate: 'auto', // video: auto adapts to the connection, or a fixed kbit/s
  direct: false, // separate desktop with video: input and picture straight through Mutter, without RDP and guacd (shim/direct.js)
  touchScroll: 'natural', // natural | reversed
  termTheme: 'deskport-dark',
  termFont: 'system',
  termFontSize: phone ? 12 : 14,
  cursorStyle: 'block', // block | bar | underline
  cursorBlink: true,
  keyRow: 'auto', // auto | always | never
  kbResize: 'resize', // resize: the screen fits above the on-screen keyboard | keep: the keyboard covers the screen, which keeps its size
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

// Earlier versions had one three-step quality preset.
function migrate(saved) {
  const old = { fast: ['medium', 'data'], balanced: ['high', 'speed'], best: ['lossless', 'speed'] }[saved.quality];
  if (old) [saved.quality, saved.priority] = old;
  return saved;
}

const values = { ...DEFAULTS, ...migrate(load()) };
const listeners = new Set();

// Picture and source settings belong to the machine being shown. The hub's
// own machine keeps them in KEY with everything else (as before machines
// existed); another machine in KEY.<id>.
export const HOST_KEYS = ['source', 'resolution', 'quality', 'priority', 'matchMonitor', 'monitor', 'encoding', 'encSpeed', 'bitrate', 'direct'];
let hostKey = null; // null: the hub's own machine
let hostValues = null;

function loadHost(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key)) || {};
    return Object.fromEntries(HOST_KEYS.map((k) => [k, k in saved ? saved[k] : DEFAULTS[k]]));
  } catch {
    return Object.fromEntries(HOST_KEYS.map((k) => [k, DEFAULTS[k]]));
  }
}

export const settings = {
  get: (key) => (hostValues && HOST_KEYS.includes(key) ? hostValues[key] : values[key]),
  set(key, value) {
    if (settings.get(key) === value) return;
    try {
      if (hostValues && HOST_KEYS.includes(key)) {
        hostValues[key] = value;
        localStorage.setItem(hostKey, JSON.stringify(hostValues));
      } else {
        values[key] = value;
        localStorage.setItem(KEY, JSON.stringify(values));
      }
    } catch {}
    for (const fn of listeners) fn(key, value);
  },
  /** Switches the machine whose picture settings get and set use; self is the hub's own. */
  useHost(id, self) {
    hostKey = self ? null : `${KEY}.${id}`;
    hostValues = self ? null : loadHost(hostKey);
    for (const k of HOST_KEYS) for (const fn of listeners) fn(k, settings.get(k));
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
