import pty from 'node-pty';

const SECRET_PREFIXES = ['RDP_', 'CF_ACCESS_', 'DESKPORT_', 'GUACD_'];

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
 * Server -> client: raw terminal output as text frames.
 */
export function handleTerminal(ws, { tmuxSession, cwd }, log) {
  const term = pty.spawn('tmux', ['new-session', '-A', '-s', tmuxSession, '-c', cwd], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: shellEnv(),
  });
  log(`terminal: attached to tmux session "${tmuxSession}" (pid ${term.pid})`);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(({ exitCode }) => {
    log(`terminal: tmux client exited (${exitCode})`);
    if (ws.readyState === ws.OPEN) ws.close(1000, 'terminal exited');
  });

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
    }
  });

  ws.on('close', () => {
    try {
      term.kill();
    } catch {}
  });
}
