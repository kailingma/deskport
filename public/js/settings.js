// Per-device settings, kept in localStorage. Every change is broadcast to listeners.

const KEY = 'deskport.settings';
const phone = matchMedia('(max-width: 640px)').matches;

export const DEFAULTS = {
  theme: 'system', // system | light | dark
  quality: 'balanced', // fast | balanced | best
  touchScroll: 'natural', // natural | reversed
  termTheme: 'deskport-dark',
  termFont: 'system',
  termFontSize: phone ? 12 : 14,
  cursorStyle: 'block', // block | bar | underline
  cursorBlink: true,
  keyRow: 'auto', // auto | always | never
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

const values = { ...DEFAULTS, ...load() };
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
