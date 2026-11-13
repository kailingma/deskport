import path from 'node:path';
import { handleScreen } from './guac.js';
import { handleTerminal } from './terminal.js';
import { createSessionControl } from './session.js';
import { createMonitors } from './monitors.js';
import { createOpener } from './opener.js';
import { createVideoHub } from './video.js';

/**
 * This machine's host work: the screen, video and terminal endpoints, the
 * separate desktop, the monitors and xdg-open. Used in the hub's own process
 * (DESKPORT_RELAY=0) or by the agent shim (shim/agent.js).
 *
 * streams[kind](ws, url) serves one browser stream; url is the browser's path
 * and query. requests[`${method} ${path}`]() answers the host's API with
 * { status, body }.
 */
export function createLocalHost({ config, root, log }) {
  const session = createSessionControl({
    unit: config.rdp.sessionUnit,
    host: config.rdp.hostname,
    port: config.rdp.sessionPort,
    log,
  });
  // The desktop on the monitor is this user's main session bus.
  const mainBus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
  const monitors = createMonitors({ bus: mainBus, id: String(config.port), log });
  monitors.restoreLeftover();
  const opener = createOpener({
    dir: path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'deskport'),
    port: config.port,
    log,
  });
  const terminal = { ...config.terminal, binDir: path.join(root, 'bin'), opener };
  const video = createVideoHub({ log });
  const screenConfig = { ...config, session, monitors, video, mainBus };

  const streams = {
    screen: (ws, url) => handleScreen(ws, { url }, screenConfig, log),
    video: (ws, url) => video.open(ws, { url }),
    term: (ws, url) => handleTerminal(ws, { url }, terminal, log),
  };

  const requests = {
    'GET /api/session': async () => ({ status: 200, body: await session.state() }),
    'POST /api/session/stop': async () => {
      try {
        await session.stop();
        return { status: 200, body: await session.state() };
      } catch (err) {
        return { status: 500, body: { error: err.message } };
      }
    },
    'GET /api/monitors': async () => {
      try {
        return { status: 200, body: await monitors.list() };
      } catch (err) {
        return { status: 500, body: { error: err.message.trim().split('\n').at(-1) } };
      }
    },
  };

  return { session, monitors, opener, streams, requests, close: () => opener.close() };
}
