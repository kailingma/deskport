import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { settings } from './settings.js';
import { TERMINAL_THEMES, TERMINAL_FONTS } from './themes.js';
import { TERM_SEQ, takeMods } from './keys.js';
import { createScroller } from './gestures.js';

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

/**
 * The Terminal view: xterm.js attached to tmux over a WebSocket.
 *
 * Touch: drag scrolls (tmux scrollback when tmux has the mouse, otherwise
 * xterm's own), long press then drag selects. Both are delivered to xterm as
 * synthetic wheel and mouse events, so xterm encodes them for whatever mouse
 * mode the program inside has asked for.
 */
export function createTerminal({ host, setStatus }) {
  const el = document.getElementById('term');
  const view = document.getElementById('view-term');
  // xterm goes in an unpadded box so the fit addon measures the real space.
  const box = document.createElement('div');
  box.className = 'term-box';
  el.append(box);
  const xterm = new Terminal({
    cursorBlink: settings.get('cursorBlink'),
    cursorStyle: settings.get('cursorStyle'),
    fontFamily: TERMINAL_FONTS[settings.get('termFont')]?.family ?? TERMINAL_FONTS.system.family,
    fontSize: settings.get('termFontSize'),
    lineHeight: 1.15,
    scrollback: 10000,
    theme: (TERMINAL_THEMES[settings.get('termTheme')] ?? TERMINAL_THEMES['deskport-dark']).colors,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  let opened = false;
  let ws = null;
  let retry = 0;
  let retryTimer = null;

  const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  // Apply sticky Ctrl / Alt from the key row to the next input.
  function input(data) {
    const m = takeMods();
    if (m.ctrl && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) data = String.fromCharCode(c & 0x1f);
      else if (data === ' ') data = '\x00';
    }
    if (m.alt) data = `\x1b${data}`;
    send({ type: 'input', data });
  }

  function fit() {
    if (!opened || el.offsetParent === null) return;
    fitAddon.fit();
    send({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
  }

  // ---------- appearance ----------

  function applyTheme() {
    const theme = TERMINAL_THEMES[settings.get('termTheme')] ?? TERMINAL_THEMES['deskport-dark'];
    xterm.options.theme = theme.colors;
    view.style.setProperty('--term-bg', theme.colors.background);
  }

  async function applyFont() {
    const font = TERMINAL_FONTS[settings.get('termFont')] ?? TERMINAL_FONTS.system;
    const size = settings.get('termFontSize');
    if (font.load) {
      try { await document.fonts.load(`${size}px ${font.load}`); } catch {}
    }
    xterm.options.fontFamily = font.family;
    xterm.options.fontSize = size;
    fit();
  }

  applyTheme();
  settings.onChange((key, value) => {
    if (key === 'termTheme') applyTheme();
    else if (key === 'termFont' || key === 'termFontSize') applyFont();
    else if (key === 'cursorStyle') xterm.options.cursorStyle = value;
    else if (key === 'cursorBlink') xterm.options.cursorBlink = value;
  });

  // ---------- touch ----------

  const screenEl = () => el.querySelector('.xterm-screen');
  let g = null;

  // tmux scrolls 5 lines per wheel step, so one step is worth 5 rows of finger travel.
  const rowHeight = () => (screenEl()?.clientHeight || 400) / xterm.rows;
  const scroller = createScroller({
    stepPx: () => rowHeight() * (xterm.modes.mouseTrackingMode === 'none' ? 1 : 5),
    maxVelocity: 2,
    onStep: (steps) => {
      const target = screenEl();
      if (!target || !g) return;
      const sign = settings.get('touchScroll') === 'natural' ? -1 : 1;
      // Line-based deltas: xterm converts pixel deltas using device pixels, which loses steps on phones.
      for (let i = 0; i < Math.abs(steps); i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: Math.sign(steps) * sign, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: g.x0, clientY: g.y0, bubbles: true, cancelable: true,
        }));
      }
    },
  });

  function mouseEvent(type, x, y, target = screenEl()) {
    target?.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true, view: window,
    }));
  }

  el.addEventListener('touchstart', (e) => {
    scroller.stop();
    if (e.touches.length !== 1) { g = null; return; }
    const p = e.touches[0];
    g = { x0: p.clientX, y0: p.clientY, lastY: p.clientY, mode: null };
    g.timer = setTimeout(() => {
      if (g && !g.mode) {
        g.mode = 'select';
        mouseEvent('mousedown', g.x0, g.y0);
      }
    }, LONG_PRESS_MS);
  }, { capture: true, passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 1) return;
    const p = e.touches[0];
    if (!g.mode && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > MOVE_SLOP) {
      clearTimeout(g.timer);
      g.mode = 'scroll';
      scroller.start(e.timeStamp);
    }
    if (!g.mode) return;
    e.preventDefault();
    e.stopPropagation();
    if (g.mode === 'scroll') {
      scroller.move(p.clientY - g.lastY, e.timeStamp);
      g.lastY = p.clientY;
    } else {
      mouseEvent('mousemove', p.clientX, p.clientY, document);
    }
  }, { capture: true, passive: false });

  const end = (e) => {
    if (!g) return;
    clearTimeout(g.timer);
    if (g.mode === 'scroll') {
      e.preventDefault();
      scroller.release(e.timeStamp);
    } else if (g.mode === 'select') {
      e.preventDefault();
      const p = e.changedTouches[0];
      mouseEvent('mouseup', p.clientX, p.clientY, document);
    }
    // Keep the gesture's start point for momentum steps.
    const done = g;
    setTimeout(() => { if (g === done) g = null; }, 1500);
  };
  el.addEventListener('touchend', end, { capture: true, passive: false });
  el.addEventListener('touchcancel', end, { capture: true, passive: false });

  // ---------- connection ----------

  function connect() {
    clearTimeout(retryTimer);
    if (!opened) {
      xterm.open(box);
      opened = true;
      xterm.onData(input);
      new ResizeObserver(() => fit()).observe(el);
      applyFont();
    }
    setStatus('term', 'busy', 'Connecting');
    ws = new WebSocket(host.ws('/ws/term'));
    ws.onopen = () => {
      retry = 0;
      setStatus('term', 'ok', 'Connected');
      fit();
    };
    ws.onmessage = (e) => xterm.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => {
      ws = null;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      setStatus('term', 'bad', `Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s`);
      retryTimer = setTimeout(connect, delay);
    };
  }

  return {
    ensureConnected() { if (!ws) connect(); },
    reconnect() {
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      retry = 0;
      connect();
    },
    focus() { xterm.focus(); },
    key(name) { input(TERM_SEQ[name] ?? name); },
    fit,
  };
}
