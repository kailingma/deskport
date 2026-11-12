import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { settings } from './settings.js';
import { TERMINAL_THEMES, TERMINAL_FONTS } from './themes.js';
import { TERM_SEQ, takeMods } from './keys.js';
import { createScroller } from './gestures.js';

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;
// Drawn output is acknowledged in batches of this many characters, or after
// ACK_MS, so the server can keep at most its window of output in flight.
const ACK_CHARS = 16384;
const ACK_MS = 50;
// A ping while the page is visible; no message at all within PONG_MS means the
// connection is dead (phones drop sockets silently in the background).
const PING_MS = 15000;
const PONG_MS = 5000;

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
  let webgl = null;

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

  // GPU drawing: much faster than the DOM renderer for full-screen redraws.
  // Falls back to the DOM renderer if WebGL is unavailable or its context is
  // lost (iOS drops it in the background); it is tried again when visible.
  function useWebgl() {
    if (webgl || !opened) return;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl?.dispose(); webgl = null; });
      xterm.loadAddon(webgl);
    } catch {
      webgl = null;
    }
  }

  let unacked = 0;
  let ackTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let pingId = 0;

  function ack() {
    clearTimeout(ackTimer);
    ackTimer = null;
    if (unacked) send({ type: 'ack', chars: unacked });
    unacked = 0;
  }

  function onOutput(data) {
    xterm.write(data, () => {
      unacked += data.length;
      if (unacked >= ACK_CHARS) ack();
      else if (!ackTimer) ackTimer = setTimeout(ack, ACK_MS);
    });
  }

  // Sends a ping and reconnects if nothing at all arrives within PONG_MS.
  function checkAlive() {
    if (ws?.readyState !== WebSocket.OPEN || pongTimer) return;
    send({ type: 'ping', id: ++pingId });
    const socket = ws;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (ws === socket) reconnect();
    }, PONG_MS);
  }

  function stopTimers() {
    clearTimeout(ackTimer);
    clearTimeout(pongTimer);
    clearInterval(pingTimer);
    ackTimer = pongTimer = pingTimer = null;
    unacked = 0;
  }

  function connect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!opened) {
      xterm.open(box);
      opened = true;
      xterm.onData(input);
      new ResizeObserver(() => fit()).observe(el);
      useWebgl();
      applyFont();
    }
    stopTimers();
    setStatus('term', 'busy', 'Connecting');
    const socket = new WebSocket(host.ws('/ws/term?flow=1'));
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => {
      retry = 0;
      setStatus('term', 'ok', 'Connected');
      fit();
      pingTimer = setInterval(() => { if (!document.hidden) checkAlive(); }, PING_MS);
    };
    socket.onmessage = (e) => {
      clearTimeout(pongTimer);
      pongTimer = null;
      // Text frames are terminal output; binary frames are replies to pings.
      if (typeof e.data === 'string') onOutput(e.data);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      stopTimers();
      // The first retry is immediate; later ones back off up to 10 s.
      const delay = retry ? Math.min(10000, 250 * 2 ** retry) : 0;
      retry++;
      setStatus('term', 'bad', delay ? `Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s` : 'Reconnecting');
      retryTimer = setTimeout(connect, delay);
    };
  }

  function reconnect() {
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.close();
    }
    retry = 0;
    connect();
  }

  // Back from the background or the network: check the connection now, and
  // skip the rest of a reconnect backoff.
  function wake() {
    if (document.hidden || !opened) return;
    useWebgl();
    if (ws) checkAlive();
    else if (retryTimer) { retry = 0; connect(); }
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);

  return {
    ensureConnected() { if (!ws) connect(); },
    reconnect,
    focus() { xterm.focus(); },
    key(name) { input(TERM_SEQ[name] ?? name); },
    fit,
  };
}
