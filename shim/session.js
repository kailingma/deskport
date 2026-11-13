import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const scaleScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/session-scale.py');
// desktop-session.sh puts the separate desktop's private D-Bus socket here.
const sessionBus = `unix:path=${process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`}/deskport-session/bus`;

// The "Separate desktop" screen source: a headless GNOME session run by the
// systemd user unit that scripts/install-services.sh writes (it runs
// scripts/desktop-session.sh). deskport starts it on the first connection and
// leaves it running, like the tmux session, until someone ends it.

function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

export function createSessionControl({ unit, host, port, log }) {
  const systemctl = (...args) => run('systemctl', ['--user', ...args], { timeout: 15000 });

  async function state() {
    try {
      const { stdout } = await systemctl('show', unit, '-p', 'ActiveState', '-p', 'MemoryCurrent', '-p', 'LoadState');
      const props = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
      if (props.LoadState !== 'loaded') return { state: 'missing' };
      const memory = Number(props.MemoryCurrent);
      return {
        state: props.ActiveState === 'active' ? 'running' : props.ActiveState === 'activating' ? 'starting' : 'stopped',
        memoryMB: Number.isFinite(memory) ? Math.round(memory / 1048576) : null,
      };
    } catch (err) {
      return { state: 'error', error: err.message };
    }
  }

  return {
    state,
    /** D-Bus address of the separate desktop's private session bus. */
    bus: sessionBus,

    /** Starts the session if needed and resolves once its RDP port accepts connections. */
    async ensureRunning() {
      if (await portOpen(host, port)) return;
      const s = await state();
      if (s.state === 'missing') throw new Error(`${unit} is not installed; run scripts/install-services.sh`);
      log(`session: starting ${unit}`);
      await systemctl('start', unit);
      for (let i = 0; i < 60; i++) {
        if (await portOpen(host, port)) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`the separate desktop did not open port ${port}`);
    },

    /**
     * GNOME makes each client's monitor at scale 1. Sets the monitor of the given
     * size to the scale closest to `scale` that GNOME allows, on the separate
     * desktop's own bus. Resolves to the scale applied.
     */
    async setScale(width, height, scale) {
      const { stdout } = await run('python3', [scaleScript, sessionBus, String(width), String(height), String(scale)], { timeout: 10000 });
      return Number(stdout.trim());
    },

    async stop() {
      log(`session: stopping ${unit}`);
      await systemctl('stop', unit);
    },
  };
}
