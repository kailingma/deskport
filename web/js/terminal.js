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
// How long a touch selection waits for tmux to send the copied text back.
const COPY_WAIT_MS = 5000;
const TWO_TAP_MS = 350;
// Links the page will offer from xdg-open (shim/opener.js).
const OPENABLE = /^(https?:|mailto:|tel:|sms:|\/api\/files\/)/i;

/**
 * The Terminal view: xterm.js attached to tmux over a WebSocket.
 *
 * Touch: drag scrolls (tmux scrollback when tmux has the mouse, otherwise
 * xterm's own), long press then drag selects and copies, long press and
 * release or a two-finger tap is a right click (tmux's menu). All are
 * delivered to xterm as synthetic wheel and mouse events, so xterm encodes
 * them for whatever mouse mode the program inside has asked for.
 *
 * Clipboard: programs copy with OSC 52, which tmux forwards when it copies a
 * selection. Paste reads the browser's clipboard and pastes it as one
 * bracketed paste.
 */
export function createTerminal({ host, setStatus, toast }) {
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

  let pasting = false;

  // Apply sticky Ctrl / Alt from the key row to the next input.
  function input(data) {
    if (pasting) return send({ type: 'input', data });
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

  // ---------- clipboard ----------

  let pendingCopy = null;

  function copied(text) {
    toast(`Copied ${text.length} character${text.length === 1 ? '' : 's'}`);
  }

  // Outside a tap or click, iPhone Safari refuses clipboard writes; the toast's
  // button makes one.
  function copyText(text) {
    const offer = () => toast('Copied in the terminal', {
      action: { label: 'Copy', onClick: () => navigator.clipboard?.writeText(text).then(() => copied(text), () => toast('The browser blocked the clipboard')) },
    });
    if (!navigator.clipboard) return offer();
    navigator.clipboard.writeText(text).then(() => copied(text), offer);
  }

  // A touch selection ends inside the gesture, but tmux copies it a round trip
  // later. A clipboard write started now with a promise of the text keeps the
  // gesture's permission until the text arrives.
  function copyAfterSelect() {
    if (xterm.modes.mouseTrackingMode === 'none') {
      const text = xterm.getSelection();
      if (text) copyText(text);
      return;
    }
    if (!navigator.clipboard?.write || !window.ClipboardItem) return;
    pendingCopy?.reject(new Error('replaced'));
    let job;
    const text = new Promise((resolve, reject) => { job = { resolve, reject, text: null }; });
    text.catch(() => {});
    job.timer = setTimeout(() => { if (pendingCopy === job) pendingCopy = null; job.reject(new Error('nothing copied')); }, COPY_WAIT_MS);
    pendingCopy = job;
    const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(
      () => copied(job.text),
      () => { if (job.text) copyText(job.text); },
    );
  }

  xterm.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    // "?" asks for the clipboard; tmux answers that itself from its buffer.
    if (!b64 || b64 === '?') return true;
    let text;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return true;
    }
    if (pendingCopy) {
      const job = pendingCopy;
      pendingCopy = null;
      clearTimeout(job.timer);
      job.text = text;
      job.resolve(text);
    } else {
      copyText(text);
    }
    return true;
  });

  async function paste() {
    // With a mouse, typing goes to the terminal again right away; on touch,
    // focusing it would open the on-screen keyboard.
    if (matchMedia('(pointer: fine)').matches) xterm.focus();
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('The browser did not allow reading the clipboard');
      return;
    }
    if (!text) return toast('The clipboard is empty');
    pasting = true;
    try { xterm.paste(text); } finally { pasting = false; }
  }

  // Ctrl+Shift+C copies xterm's own selection (Shift+drag while a program has
  // the mouse); Ctrl+Shift+V is left to the browser, which pastes.
  xterm.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
    if (e.code === 'KeyC') {
      if (e.type === 'keydown') {
        const text = xterm.getSelection();
        if (text) copyText(text);
      }
      e.preventDefault();
      return false;
    }
    return e.code !== 'KeyV';
  });

  // While a program has the mouse, right click goes to it (tmux opens its
  // menu) instead of opening the browser's.
  el.addEventListener('contextmenu', (e) => {
    if (xterm.modes.mouseTrackingMode !== 'none') e.preventDefault();
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

  function mouseEvent(type, x, y, target = screenEl(), button = 0) {
    target?.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, button, buttons: type === 'mouseup' ? 0 : (button === 2 ? 2 : 1), bubbles: true, cancelable: true, view: window,
    }));
  }

  // A right press without its release: tmux keeps the menu it opens on the
  // press until a click picks an item or lands outside it. A release, or a
  // motion report without a button, would close it again at once.
  function rightClick(x, y) {
    mouseEvent('mousedown', x, y, screenEl(), 2);
  }

  // Touch has no hover. Drop the button-less mousemove a browser sends before
  // the mousedown of a tap, so programs (and tmux's menu) see only the click.
  let lastTouch = -Infinity;
  el.addEventListener('mousemove', (e) => {
    if (!e.buttons && e.timeStamp - lastTouch < 1000) e.stopPropagation();
  }, true);

  el.addEventListener('touchstart', (e) => {
    scroller.stop();
    if (e.touches.length === 2 && (!g || (g.mode !== 'scroll' && g.mode !== 'select'))) {
      clearTimeout(g?.timer);
      const [a, b] = e.touches;
      g = { two: true, t0: e.timeStamp, x0: (a.clientX + b.clientX) / 2, y0: (a.clientY + b.clientY) / 2, moved: false };
      return;
    }
    if (e.touches.length !== 1) { g = null; return; }
    const p = e.touches[0];
    g = { x0: p.clientX, y0: p.clientY, lastY: p.clientY, mode: null };
    // Held still: a right click on release, or a selection once it moves.
    g.timer = setTimeout(() => { if (g && !g.mode) g.mode = 'held'; }, LONG_PRESS_MS);
  }, { capture: true, passive: true });

  el.addEventListener('touchmove', (e) => {
    if (g?.two) {
      const [a, b] = e.touches;
      if (b && Math.hypot((a.clientX + b.clientX) / 2 - g.x0, (a.clientY + b.clientY) / 2 - g.y0) > MOVE_SLOP) g.moved = true;
      return;
    }
    if (!g || e.touches.length !== 1) return;
    const p = e.touches[0];
    if (g.mode === 'held' && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > MOVE_SLOP) {
      g.mode = 'select';
      mouseEvent('mousedown', g.x0, g.y0);
    }
    if (!g.mode && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > MOVE_SLOP) {
      clearTimeout(g.timer);
      g.mode = 'scroll';
      scroller.start(e.timeStamp);
    }
    if (!g.mode || g.mode === 'held') return;
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
    lastTouch = e.timeStamp;
    if (!g) return;
    if (g.two) {
      e.preventDefault();
      if (e.touches.length) return;
      if (!g.moved && e.type === 'touchend' && e.timeStamp - g.t0 < TWO_TAP_MS) rightClick(g.x0, g.y0);
      g = null;
      return;
    }
    clearTimeout(g.timer);
    if (g.mode === 'held') {
      e.preventDefault();
      if (e.type === 'touchend') rightClick(g.x0, g.y0);
    } else if (g.mode === 'scroll') {
      e.preventDefault();
      scroller.release(e.timeStamp);
    } else if (g.mode === 'select') {
      e.preventDefault();
      const p = e.changedTouches[0];
      mouseEvent('mouseup', p.clientX, p.clientY, document);
      if (e.type === 'touchend') copyAfterSelect();
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

  function onControl(buf) {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(buf)); } catch { return; }
    if (msg.type === 'open' && typeof msg.url === 'string' && OPENABLE.test(msg.url)) {
      const href = msg.file ? host.api(msg.url) : msg.url;
      const text = msg.file ? msg.label : msg.url.replace(/^https?:\/\//, '');
      toast(text, { action: { label: 'Open', href } });
    }
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
      // Text frames are terminal output; binary frames are JSON messages.
      if (typeof e.data === 'string') onOutput(e.data);
      else onControl(e.data);
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
    paste,
    focus() { xterm.focus(); },
    key(name) { input(TERM_SEQ[name] ?? name); },
    fit,
  };
}
