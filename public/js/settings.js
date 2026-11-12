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
  encoding: 'images', // images: guacd's pictures | av1 | h264: a video stream (src/video.js)
  encSpeed: 0, // video encoder speed: 0 fastest | 1 balanced | 2 smallest
  bitrate: 'auto', // video: auto adapts to the connection, or a fixed kbit/s
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

export const settings = {
  get: (key) => values[key],
  set(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch {}
    for (const fn of listeners) fn(key, value);
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
