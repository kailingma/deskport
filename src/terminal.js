import { execFileSync } from 'node:child_process';
import pty from 'node-pty';

const SECRET_PREFIXES = ['RDP_', 'CF_ACCESS_', 'DESKPORT_', 'GUACD_'];

// Output that arrives within this long of the last send is batched into one
// message. The first chunk after a pause (a keystroke's echo) goes out at once.
const BATCH_MS = 4;
// Flow control (clients that connect with ?flow=1): characters sent but not
// yet acknowledged by the browser. Above HIGH the bridge stops reading the
// pseudo-terminal, so tmux sees a slow client, skips the output in between
// and redraws the screen once the browser has caught up.
const FLOW_HIGH = Number(process.env.DESKPORT_TERM_WINDOW || 128 * 1024);
const FLOW_LOW = FLOW_HIGH / 2;
const PING_MS = 25000;

/**
 * Variables for the tmux session's new windows and panes: binDir first on
 * PATH, and its xdg-open as BROWSER. Shells that are already running keep
 * their own.
 */
export function sessionVars(binDir, basePath) {
  const path = [binDir, ...basePath.split(':').filter((p) => p && p !== binDir)].join(':');
  return { PATH: path, BROWSER: `${binDir}/xdg-open` };
}

/**
 * Arguments for the tmux client: attach to (or create) the session and set
 * the session's variables. tmux gives the first pane of a new session the
 * client's own PATH, so the client is started with the same variables.
 */
export function tmuxArgs(session, cwd, vars) {
  const target = `=${session}`;
  return [
    'new-session', '-A', '-s', session, '-c', cwd,
    ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...Object.entries(vars).flatMap(([k, v]) => [';', 'set-environment', '-t', target, k, v]),
  ];
}

/** The PATH tmux gives new panes, before this bridge changes it. */
function tmuxPath() {
  try {
    const line = execFileSync('tmux', ['show-environment', '-g', 'PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return line.trim().replace(/^PATH=/, '');
  } catch {
    return process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  }
}

function shellEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

/**
 * Attaches a WebSocket to the persistent tmux session. Closing the socket
 * detaches the tmux client; the session and its programs keep running.
 *
 * Client -> server: JSON {type:"input", data} | {type:"resize", cols, rows}
 *   and, with ?flow=1, {type:"ack", chars} once output has been drawn (chars
 *   counts JavaScript string length) and {type:"ping", id}.
 * Server -> client: terminal output as text frames, and binary frames holding
 *   JSON: {type:"open", url, label, file?} when a program in the terminal runs
 *   xdg-open (src/opener.js), and with ?flow=1 {type:"pong", id}.
 */
export function handleTerminal(ws, req, { tmuxSession, cwd, binDir, opener }, log) {
  const flow = new URL(req.url, 'http://localhost').searchParams.get('flow') === '1';
  const vars = sessionVars(binDir, tmuxPath());
  const term = pty.spawn('tmux', tmuxArgs(tmuxSession, cwd, vars), {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: { ...shellEnv(), ...vars },
  });
  log(`terminal: attached to tmux session "${tmuxSession}" (pid ${term.pid}${flow ? ', flow control' : ''})`);

  const control = (msg) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(JSON.stringify(msg)), { binary: true }); };
  const unregister = opener ? opener.register(term.pid, control) : () => {};

  let pending = '';
  let timer = null;
  let lastSend = 0;
  let unacked = 0;
  let paused = false;

  const flush = () => {
    timer = null;
    if (!pending || ws.readyState !== ws.OPEN) return;
    const data = pending;
    pending = '';
    lastSend = Date.now();
    ws.send(data);
    if (flow) {
      unacked += data.length;
      if (!paused && unacked > FLOW_HIGH) {
        paused = true;
        term.pause();
      }
    }
  };

  term.onData((data) => {
    pending += data;
    if (timer) return;
    if (Date.now() - lastSend >= BATCH_MS) flush();
    else timer = setTimeout(flush, BATCH_MS);
  });
  term.onExit(({ exitCode }) => {
    flush();
    log(`terminal: tmux client exited (${exitCode})`);
    if (ws.readyState === ws.OPEN) ws.close(1000, 'terminal exited');
  });

  // Keeps idle connections open through proxies that close quiet ones.
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, PING_MS);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = Math.max(2, Math.min(500, msg.cols | 0));
      const rows = Math.max(2, Math.min(300, msg.rows | 0));
      term.resize(cols, rows);
    } else if (flow && msg.type === 'ack') {
      unacked = Math.max(0, unacked - (Number(msg.chars) || 0));
      if (paused && unacked < FLOW_LOW) {
        paused = false;
        term.resume();
      }
    } else if (flow && msg.type === 'ping') {
      control({ type: 'pong', id: msg.id });
    }
  });

  ws.on('close', () => {
    unregister();
    clearInterval(ping);
    clearTimeout(timer);
    try {
      term.kill();
    } catch {}
  });
}
