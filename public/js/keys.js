// Key codes shared by the screen and terminal, and the key row's sticky modifiers.

export const KS = {
  ctrl: 0xffe3, alt: 0xffe9, del: 0xffff, superL: 0xffeb, esc: 0xff1b, tab: 0xff09,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, backspace: 0xff08, enter: 0xff0d,
};

/** X11 keysym for a character: Latin-1 maps directly, the rest use the Unicode range. */
export function keysymFor(ch) {
  const cp = ch.codePointAt(0);
  return cp < 0x100 ? cp : 0x01000000 | cp;
}

export const TERM_SEQ = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

// Ctrl / Alt from the key row stay armed until the next key.
const mods = { ctrl: false, alt: false };

export function toggleMod(name) {
  setMod(name, !mods[name]);
}

function setMod(name, on) {
  mods[name] = on;
  document.querySelector(`[data-mod="${name}"]`)?.setAttribute('aria-pressed', String(on));
}

/** Returns the armed modifiers and disarms them. */
export function takeMods() {
  const m = { ...mods };
  if (m.ctrl) setMod('ctrl', false);
  if (m.alt) setMod('alt', false);
  return m;
}
