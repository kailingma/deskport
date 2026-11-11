import Guacamole from '/vendor/guacamole-common.js';
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';

const $ = (id) => document.getElementById(id);
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const canFullscreen = Boolean(document.fullscreenEnabled);
document.documentElement.classList.toggle('can-fullscreen', canFullscreen);

// ---------- status, toast ----------

const statusEl = $('status');
const status = { screen: ['idle', 'Idle'], term: ['idle', 'Idle'] };
let view = 'screen';

function setStatus(which, state, text) {
  status[which] = [state, text];
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

fetch('/api/me').then((r) => r.json()).then((me) => {
  $('host').textContent = me.dev ? `${me.host} (dev)` : me.host;
  document.title = `${me.host} · deskport`;
}).catch(() => {});

// ---------- keys ----------

const KS = {
  ctrl: 0xffe3, alt: 0xffe9, del: 0xffff, superL: 0xffeb, esc: 0xff1b, tab: 0xff09,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, backspace: 0xff08, enter: 0xff0d,
};
const keysymFor = (ch) => {
  const cp = ch.codePointAt(0);
  return cp < 0x100 ? cp : 0x01000000 | cp;
};
const TERM_SEQ = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

// Sticky Ctrl / Alt from the key row: armed until the next key.
const mods = { ctrl: false, alt: false };
function setMod(name, on) {
  mods[name] = on;
  document.querySelector(`[data-mod="${name}"]`).setAttribute('aria-pressed', String(on));
}
function takeMods() {
  const m = { ...mods };
  if (m.ctrl) setMod('ctrl', false);
  if (m.alt) setMod('alt', false);
  return m;
}

// ---------- Screen (RDP through guacd) ----------

const screen = (() => {
  const wrap = $('display-wrap');
  const ime = $('screen-ime');
  wrap.tabIndex = 0;
  let client = null;
  let keyboard = null;
  let wantConnected = false;

  const overlay = (title, body) => {
    $('screen-overlay-title').textContent = title;
    $('screen-overlay-body').textContent = body || '';
    $('screen-overlay').hidden = false;
  };

  // zoom is relative to "fit to window"; above 1 the wrap scrolls (programmatically) to pan.
  let zoom = 1;

  function fitScale() {
    const display = client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    return w && h ? Math.min(wrap.clientWidth / w, wrap.clientHeight / h) : 0;
  }

  function rescale() {
    if (!client) return;
    const fit = fitScale();
    if (!fit) return;
    client.getDisplay().scale(fit * zoom);
  }

  // Two fingers belong to deskport, not the remote mouse: pinch zooms the view,
  // dragging pans it when zoomed and scrolls the remote desktop when not.
  let pinch = null;
  const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !client) return;
    e.stopPropagation();
    e.preventDefault();
    const mid = touchMid(e.touches);
    const rect = wrap.getBoundingClientRect();
    pinch = {
      dist: touchDist(e.touches), zoom, mode: null, lastY: mid.y,
      // content point under the fingers, in unscaled remote pixels
      cx: (wrap.scrollLeft + mid.x - rect.left - contentOffset().x) / (fitScale() * zoom),
      cy: (wrap.scrollTop + mid.y - rect.top - contentOffset().y) / (fitScale() * zoom),
    };
  }, { capture: true, passive: false });

  wrap.addEventListener('touchmove', (e) => {
    if (!pinch) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.touches.length < 2) return;
    const mid = touchMid(e.touches);
    const ratio = touchDist(e.touches) / pinch.dist;
    if (!pinch.mode) {
      if (Math.abs(ratio - 1) > 0.08) pinch.mode = 'zoom';
      else if (Math.abs(mid.y - pinch.lastY) > 10) pinch.mode = zoom > 1 ? 'zoom' : 'scroll';
      else return;
    }
    if (pinch.mode === 'scroll') {
      const steps = Math.trunc((mid.y - pinch.lastY) / 24);
      if (steps) {
        pinch.lastY += steps * 24;
        wheel(steps < 0 ? 'down' : 'up', Math.abs(steps), mid);
      }
      return;
    }
    zoom = Math.min(5, Math.max(1, pinch.zoom * ratio));
    rescale();
    const scale = fitScale() * zoom;
    const rect = wrap.getBoundingClientRect();
    wrap.scrollLeft = pinch.cx * scale - (mid.x - rect.left) + contentOffset().x;
    wrap.scrollTop = pinch.cy * scale - (mid.y - rect.top) + contentOffset().y;
  }, { capture: true, passive: false });

  const endPinch = (e) => {
    if (!pinch) return;
    e.stopPropagation();
    if (e.touches.length) return;
    pinch = null;
    if (zoom < 1.05) { zoom = 1; rescale(); }
  };
  wrap.addEventListener('touchend', endPinch, { capture: true });
  wrap.addEventListener('touchcancel', endPinch, { capture: true });

  // The display is centred in the wrap on any axis where it fits.
  function contentOffset() {
    const el = client.getDisplay().getElement();
    return { x: el.offsetLeft, y: el.offsetTop };
  }

  function wheel(dir, steps, at) {
    const el = client.getDisplay().getElement().getBoundingClientRect();
    const scale = fitScale() * zoom;
    const pos = { x: (at.x - el.left) / scale, y: (at.y - el.top) / scale };
    for (let i = 0; i < steps; i++) {
      client.sendMouseState({ ...pos, [dir]: true });
      client.sendMouseState({ ...pos });
    }
  }

  function connect() {
    disconnect();
    wantConnected = true;
    zoom = 1;
    $('screen-overlay').hidden = true;

    const tunnel = new Guacamole.WebSocketTunnel(`${wsBase}/ws/screen`);
    const c = new Guacamole.Client(tunnel);
    client = c;
    const display = client.getDisplay();
    const el = display.getElement();
    wrap.replaceChildren(el);

    client.onstatechange = (state) => {
      switch (state) {
        case 1: case 2: setStatus('screen', 'busy', 'Connecting'); break;
        case 3:
          setStatus('screen', 'ok', 'Connected');
          // GNOME desktop sharing can accept a session and then send no picture.
          setTimeout(() => {
            if (client === c && wantConnected && !c.getDisplay().getWidth()) {
              setStatus('screen', 'bad', 'No picture');
              overlay('No picture from the desktop',
                'GNOME desktop sharing accepted the connection but is not sending the screen. '
                + 'Restart it on the host with: systemctl --user restart gnome-remote-desktop');
            }
          }, 12000);
          break;
        case 4: setStatus('screen', 'busy', 'Closing'); break;
        case 5:
          if (!wantConnected) break; // onerror already reported why
          setStatus('screen', 'bad', 'Disconnected');
          overlay('Disconnected', 'The remote desktop session ended.');
          break;
      }
    };
    client.onerror = (st) => {
      setStatus('screen', 'bad', 'Error');
      overlay('Could not connect', st.message || `Guacamole status ${st.code}`);
      wantConnected = false;
    };
    display.onresize = rescale;

    client.onclipboard = (stream, mimetype) => {
      if (!/^text\//.test(mimetype)) return;
      const reader = new Guacamole.StringReader(stream);
      let text = '';
      reader.ontext = (t) => { text += t; };
      reader.onend = () => {
        navigator.clipboard?.writeText(text).then(() => toast('Copied from the remote desktop'), () => {});
      };
    };

    const mouse = new Guacamole.Mouse(el);
    mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => {
      wrap.focus({ preventScroll: true });
      client.sendMouseState(e.state, true);
    });
    mouse.on('mouseout', () => display.showCursor(false));

    const touch = new Guacamole.Mouse.Touchscreen(el);
    touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => client.sendMouseState(e.state, true));

    keyboard = new Guacamole.Keyboard(wrap);
    keyboard.onkeydown = (keysym) => { client?.sendKeyEvent(1, keysym); return false; };
    keyboard.onkeyup = (keysym) => { client?.sendKeyEvent(0, keysym); };

    const ratio = window.devicePixelRatio || 1;
    const params = new URLSearchParams({
      width: String(Math.round(wrap.clientWidth * ratio)),
      height: String(Math.round(wrap.clientHeight * ratio)),
      dpi: String(Math.round(96 * ratio)),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    });
    client.connect(params.toString());
  }

  function disconnect() {
    wantConnected = false;
    keyboard?.reset();
    if (keyboard) keyboard.onkeydown = keyboard.onkeyup = null;
    keyboard = null;
    if (client) {
      client.onstatechange = client.onerror = null;
      try { client.disconnect(); } catch {}
    }
    client = null;
  }

  // Press keysyms in order, release in reverse.
  function chord(...keys) {
    if (!client) return;
    for (const k of keys) client.sendKeyEvent(1, k);
    for (const k of [...keys].reverse()) client.sendKeyEvent(0, k);
  }

  function press(keysym) {
    const m = takeMods();
    const held = [m.ctrl && KS.ctrl, m.alt && KS.alt].filter(Boolean);
    chord(...held, keysym);
  }

  // The soft keyboard types into a hidden textarea; forward what it produces.
  ime.addEventListener('keydown', (e) => {
    const special = { Enter: KS.enter, Backspace: KS.backspace, Tab: KS.tab, Escape: KS.esc,
      ArrowLeft: KS.left, ArrowRight: KS.right, ArrowUp: KS.up, ArrowDown: KS.down }[e.key];
    if (special) {
      e.preventDefault();
      press(special);
    }
  });
  ime.addEventListener('input', (e) => {
    if (e.inputType === 'deleteContentBackward') press(KS.backspace);
    else if (e.inputType === 'insertLineBreak') press(KS.enter);
    else if (e.data) for (const ch of e.data) press(keysymFor(ch));
    ime.value = '';
  });

  async function sendClipboard() {
    if (!client) return;
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('The browser blocked clipboard access');
      return;
    }
    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    toast(`Sent ${text.length} characters. Paste with Ctrl+V on the remote desktop`);
  }

  new ResizeObserver(rescale).observe(wrap);
  window.addEventListener('blur', () => keyboard?.reset());

  return {
    ensureConnected() { if (!client) connect(); },
    reconnect: connect,
    focus() { wrap.focus({ preventScroll: true }); },
    releaseKeys() { keyboard?.reset(); },
    showKeyboard() { ime.focus({ preventScroll: true }); },
    key(name) { press(KS[name] ?? keysymFor(name)); },
    superKey() { chord(KS.superL); },
    ctrlAltDel() { chord(KS.ctrl, KS.alt, KS.del); },
    sendClipboard,
    rescale,
  };
})();

// ---------- Terminal (tmux through node-pty) ----------

const term = (() => {
  const el = $('term');
  const xterm = new Terminal({
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: matchMedia('(max-width: 640px)').matches ? 12 : 14,
    lineHeight: 1.15,
    scrollback: 10000,
    theme: {
      background: '#0f1012',
      foreground: '#e4e4e7',
      cursor: '#6b9cff',
      selectionBackground: '#2b3a5c',
      black: '#18181b', brightBlack: '#5f6068',
      red: '#f2676b', brightRed: '#ff9a9c',
      green: '#4cc38a', brightGreen: '#7ee2b1',
      yellow: '#e8b44d', brightYellow: '#f5d27e',
      blue: '#6b9cff', brightBlue: '#9dbdff',
      magenta: '#b98cf5', brightMagenta: '#d3b5ff',
      cyan: '#3fc2d1', brightCyan: '#7edbe5',
      white: '#d4d4d8', brightWhite: '#fafafa',
    },
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

  function connect() {
    clearTimeout(retryTimer);
    if (!opened) {
      xterm.open(el);
      opened = true;
      xterm.onData(input);
      new ResizeObserver(() => fit()).observe(el);
    }
    setStatus('term', 'busy', 'Connecting');
    ws = new WebSocket(`${wsBase}/ws/term`);
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
    reconnect() { ws?.close(); retry = 0; connect(); },
    focus() { xterm.focus(); },
    key(name) { input(TERM_SEQ[name] ?? name); },
    fit,
  };
})();

// ---------- views ----------

function showView(next) {
  view = next;
  document.body.dataset.view = next;
  for (const tab of document.querySelectorAll('[data-view]')) {
    if (tab !== document.body) tab.setAttribute('aria-selected', String(tab.dataset.view === next));
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

const coarse = matchMedia('(pointer: coarse)');

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
    b.title = on ? 'Exit full screen' : 'Full screen';
    b.setAttribute('aria-label', b.title);
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
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.closest('dialog')) sheet.close();
  actions[btn.dataset.action]?.();
  if (!coarse.matches && view === 'screen' && btn.dataset.action !== 'reconnect') screen.focus();
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

// ---------- key row ----------

const keyrow = $('keyrow');
// Keep focus (and the soft keyboard) where it is while tapping keys.
keyrow.addEventListener('pointerdown', (e) => e.preventDefault());
keyrow.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.mod) return setMod(btn.dataset.mod, !mods[btn.dataset.mod]);
  (view === 'screen' ? screen : term).key(btn.dataset.key);
});

// ---------- fit the app to the visible viewport (iOS keyboard) ----------

const vv = window.visualViewport;
function syncViewport() {
  if (!vv) return;
  const height = vv.height;
  document.documentElement.style.setProperty('--app-h', `${height}px`);
  document.body.style.top = `${vv.offsetTop}px`;
  document.body.classList.toggle('kb-open', window.innerHeight - height > 120);
}
vv?.addEventListener('resize', syncViewport);
vv?.addEventListener('scroll', syncViewport);
syncViewport();

// ---------- start ----------

let initial = 'screen';
try { initial = localStorage.getItem('deskport.view') === 'term' ? 'term' : 'screen'; } catch {}
showView(initial);
