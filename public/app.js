import Guacamole from '/vendor/guacamole-common.js';
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';

const $ = (id) => document.getElementById(id);
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ---------- shared UI ----------

const statusEl = $('status');
const status = { screen: ['idle', 'Idle'], term: ['idle', 'Idle'] };
let view = 'screen';

function setStatus(which, state, text) {
  status[which] = [state, text];
  if (which === view) {
    statusEl.dataset.state = state;
    statusEl.querySelector('.status-text').textContent = text;
  }
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showView(next) {
  view = next;
  document.body.dataset.view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === next));
  }
  $('view-screen').hidden = next !== 'screen';
  $('view-term').hidden = next !== 'term';
  setStatus(next, ...status[next]);
  try { localStorage.setItem('deskport.view', next); } catch {}

  if (next === 'screen') {
    screen.ensureConnected();
    screen.focus();
  } else {
    screen.releaseKeys();
    term.ensureConnected();
    term.focus();
  }
}

for (const tab of document.querySelectorAll('.tab')) {
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

$('btn-full').addEventListener('click', async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
  // Chrome only: lets Escape, Super, Alt+Tab etc. reach the remote side.
  try { await navigator.keyboard?.lock(); } catch {}
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) try { navigator.keyboard?.unlock(); } catch {}
  setTimeout(() => { screen.rescale(); term.fit(); }, 50);
});

fetch('/api/me').then((r) => r.json()).then((me) => {
  $('host').textContent = me.dev ? `${me.host} · dev` : me.host;
  document.title = `${me.host} · deskport`;
}).catch(() => {});

// ---------- Screen (RDP through guacd) ----------

const KEY = { ctrl: 0xffe3, alt: 0xffe9, del: 0xffff, superL: 0xffeb };

const screen = (() => {
  const wrap = $('display-wrap');
  wrap.tabIndex = 0;
  let client = null;
  let keyboard = null;
  let wantConnected = false;

  const overlay = (title, body) => {
    $('screen-overlay-title').textContent = title;
    $('screen-overlay-body').textContent = body || '';
    $('screen-overlay').hidden = false;
  };

  function rescale() {
    if (!client) return;
    const display = client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    if (!w || !h) return;
    display.scale(Math.min(wrap.clientWidth / w, wrap.clientHeight / h));
  }

  function connect() {
    disconnect();
    wantConnected = true;
    $('screen-overlay').hidden = true;

    const tunnel = new Guacamole.WebSocketTunnel(`${wsBase}/ws/screen`);
    client = new Guacamole.Client(tunnel);
    const display = client.getDisplay();
    const el = display.getElement();
    wrap.replaceChildren(el);

    client.onstatechange = (state) => {
      switch (state) {
        case 1: case 2: setStatus('screen', 'busy', 'Connecting'); break;
        case 3: setStatus('screen', 'ok', 'Connected'); break;
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
        navigator.clipboard?.writeText(text).then(
          () => toast('Copied from remote desktop'),
          () => {},
        );
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
    if (keyboard) { keyboard.onkeydown = keyboard.onkeyup = null; }
    keyboard = null;
    if (client) {
      client.onstatechange = client.onerror = null;
      try { client.disconnect(); } catch {}
    }
    client = null;
  }

  async function sendClipboard() {
    if (!client) return;
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('Clipboard access was blocked by the browser');
      return;
    }
    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    toast(`Sent ${text.length} characters. Paste with Ctrl+V on the remote side`);
    wrap.focus();
  }

  function tap(...keys) {
    if (!client) return;
    for (const k of keys) client.sendKeyEvent(1, k);
    for (const k of keys.reverse()) client.sendKeyEvent(0, k);
    wrap.focus();
  }

  new ResizeObserver(rescale).observe(wrap);
  $('btn-reconnect').addEventListener('click', connect);
  $('btn-paste').addEventListener('click', sendClipboard);
  $('btn-cad').addEventListener('click', () => tap(KEY.ctrl, KEY.alt, KEY.del));
  $('btn-super').addEventListener('click', () => tap(KEY.superL));
  window.addEventListener('blur', () => keyboard?.reset());

  return {
    ensureConnected() { if (!client) connect(); },
    focus() { wrap.focus({ preventScroll: true }); },
    releaseKeys() { keyboard?.reset(); },
    rescale,
  };
})();

// ---------- Terminal (tmux through node-pty) ----------

const term = (() => {
  const el = $('term');
  const xterm = new Terminal({
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: 14,
    lineHeight: 1.15,
    scrollback: 10000,
    allowProposedApi: false,
    theme: {
      background: '#0d0f14',
      foreground: '#e6e8ee',
      cursor: '#7aa2f7',
      selectionBackground: '#2c3550',
      black: '#1c202b', brightBlack: '#5c6377',
      red: '#f87171', brightRed: '#fca5a5',
      green: '#4ade80', brightGreen: '#86efac',
      yellow: '#fbbf24', brightYellow: '#fcd34d',
      blue: '#7aa2f7', brightBlue: '#a5c0ff',
      magenta: '#c084fc', brightMagenta: '#d8b4fe',
      cyan: '#22d3ee', brightCyan: '#67e8f9',
      white: '#d4d7e0', brightWhite: '#ffffff',
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
      xterm.onData((data) => send({ type: 'input', data }));
      new ResizeObserver(() => fit()).observe(el);
    }
    setStatus('term', 'busy', 'Connecting');
    ws = new WebSocket(`${wsBase}/ws/term`);
    ws.onopen = () => {
      retry = 0;
      setStatus('term', 'ok', 'tmux: web');
      fit();
    };
    ws.onmessage = (e) => xterm.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => {
      ws = null;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      setStatus('term', 'bad', `Reconnecting in ${Math.round(delay / 1000) || 1}s`);
      retryTimer = setTimeout(connect, delay);
    };
  }

  return {
    ensureConnected() { if (!ws) connect(); },
    focus() { xterm.focus(); },
    fit,
  };
})();

// ---------- start ----------

let initial = 'screen';
try { initial = localStorage.getItem('deskport.view') === 'term' ? 'term' : 'screen'; } catch {}
showView(initial);
