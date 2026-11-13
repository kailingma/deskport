import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The physical monitors of the desktop My monitor shows, through Mutter's
// DisplayConfig (scripts/monitor-config.py).
//
// "Match this device" changes the monitor's mode to the one that best fits the
// viewer while it is connected, and puts the previous configuration back when
// the last viewer leaves. With several monitors, the one to show is made
// primary for the session, because GNOME desktop sharing streams only the
// primary monitor. Everything applied is temporary (nothing in monitors.xml),
// and the configuration to put back is also kept in a file, so a crashed or
// restarted server restores it at start.
//
// On a monitor connected to two GPUs, a mode change once left one output unable
// to draw until the user logged out. The owner asked for this anyway; the
// setting is off by default and asks before turning on.

const run = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/monitor-config.py');
const RESTORE_DELAY_MS = 4000; // a reconnect within this time keeps the matched mode

const sameScale = (a, b) => Math.abs(a - b) < 0.01;
const odd = (transform) => transform % 2 === 1; // 90 or 270 degrees: width and height swap

/** The configuration in effect, in the shape ApplyMonitorsConfig takes. */
export function currentConfig(state) {
  const modeOf = (connector) => state.monitors.find((m) => m.connector === connector)?.modes.find((x) => x.current)?.id;
  return state.logical.map((l) => ({
    x: l.x, y: l.y, scale: l.scale, transform: l.transform, primary: l.primary,
    monitors: l.connectors.map((connector) => ({ connector, mode: modeOf(connector) })),
  }));
}

/**
 * Picks the size for a viewer of `width` x `height` device pixels: the largest
 * mode that fits inside it, so one monitor pixel is at least one device pixel;
 * if none fits, the smallest mode.
 */
export function chooseSize(sizes, width, height) {
  const fits = sizes.filter((s) => s.width <= width * 1.05 && s.height <= height * 1.05);
  const area = (s) => s.width * s.height;
  if (fits.length) return fits.reduce((a, b) => (area(b) > area(a) ? b : a));
  return sizes.reduce((a, b) => (area(b) < area(a) ? b : a));
}

/** Monitors as the settings list them. */
export function describe(state) {
  return state.logical.flatMap((l) => l.connectors.map((connector) => {
    const m = state.monitors.find((x) => x.connector === connector);
    const mode = m?.modes.find((x) => x.current);
    return { connector, name: m?.name || connector, primary: l.primary, width: mode?.width, height: mode?.height, mirrored: l.connectors.length > 1 };
  }));
}

/**
 * Plans the configuration for a viewer. Returns null when nothing would change.
 * @param {object} state  from monitor-config.py
 * @param {{width?: number, height?: number, monitor?: string}} want
 *   width/height: match this size (omit to keep modes); monitor: connector to show (default the primary)
 */
export function plan(state, { width, height, monitor }) {
  const config = currentConfig(state);
  const index = monitor && monitor !== 'primary'
    ? state.logical.findIndex((l) => l.connectors.includes(monitor))
    : state.logical.findIndex((l) => l.primary);
  if (index === -1) return null;
  const target = config[index];
  let changed = false;

  if (monitor && monitor !== 'primary' && !target.primary) {
    for (const l of config) l.primary = false;
    target.primary = true;
    changed = true;
  }

  if (width && height) {
    // Mirrored outputs in one logical monitor need a size every one of them offers.
    const modesOf = target.monitors.map(({ connector }) => state.monitors.find((m) => m.connector === connector)?.modes ?? []);
    const sizes = modesOf[0]
      .filter((a) => modesOf.every((modes) => modes.some((b) => b.width === a.width && b.height === a.height)))
      .map(({ width: w, height: h }) => ({ width: w, height: h }));
    const [vw, vh] = odd(target.transform) ? [height, width] : [width, height];
    const size = sizes.length ? chooseSize(sizes, vw, vh) : null;
    const current = modesOf[0].find((m) => m.current);
    if (size && current && (size.width !== current.width || size.height !== current.height)) {
      const picked = modesOf.map((modes, i) => {
        const now = modes.find((m) => m.current);
        // Same size, the refresh rate closest to the current one.
        return modes.filter((m) => m.width === size.width && m.height === size.height)
          .sort((a, b) => Math.abs(a.rate - (now?.rate ?? 60)) - Math.abs(b.rate - (now?.rate ?? 60)))[0];
      });
      const scales = picked[0].scales.filter((s) => picked.every((m) => m.scales.some((t) => sameScale(s, t))));
      const scale = scales.find((s) => sameScale(s, target.scale))
        ?? scales.reduce((a, b) => (Math.abs(b - target.scale) < Math.abs(a - target.scale) ? b : a), scales[0] ?? 1);

      // Move monitors to the right of or below this one by the change in its size.
      const logicalSize = (w, h, s) => {
        const [lw, lh] = state.layoutMode === 2 ? [w, h] : [w / s, h / s];
        return odd(target.transform) ? [lh, lw] : [lw, lh];
      };
      const [ow, oh] = logicalSize(current.width, current.height, target.scale);
      const [nw, nh] = logicalSize(size.width, size.height, scale);
      for (const l of config) {
        if (l === target) continue;
        if (l.x >= target.x + ow) l.x = Math.round(l.x + nw - ow);
        if (l.y >= target.y + oh) l.y = Math.round(l.y + nh - oh);
      }
      target.monitors = target.monitors.map((m, i) => ({ ...m, mode: picked[i].id }));
      target.scale = scale;
      changed = true;
    }
  }
  return changed ? config : null;
}

/**
 * @param {object} opts
 * @param {string} opts.bus  address of the session bus of the desktop My monitor shows
 * @param {string} opts.id  names the file that keeps the configuration to put back (one per server)
 * @param {(s: string) => void} opts.log
 */
export function createMonitors({ bus, id, log }) {
  const saved = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `deskport-monitors-${id}.json`);
  let viewers = 0;
  let original = null; // configuration to put back
  let restoreTimer = null;
  let busy = Promise.resolve();
  const serially = (fn) => (busy = busy.then(fn, fn));

  const state = async () => JSON.parse((await run('python3', [script, bus, 'state'], { timeout: 10000 })).stdout);
  const apply = async (config) => {
    const s = await state();
    await run('python3', [script, bus, 'apply', String(s.serial), JSON.stringify(config)], { timeout: 15000 });
  };

  async function restore() {
    if (!original) return;
    try {
      await apply(original);
      log('monitors: configuration put back');
    } catch (err) {
      log(`monitors: could not put the configuration back: ${err.message.trim().split('\n').at(-1)}`);
    }
    original = null;
    fs.rmSync(saved, { force: true });
  }

  return {
    state,
    async list() { return describe(await state()); },

    /** Puts back a configuration a previous run left changed. */
    restoreLeftover: () => serially(async () => {
      try {
        original = JSON.parse(fs.readFileSync(saved, 'utf8'));
      } catch {
        return;
      }
      log('monitors: a previous run left the monitor configuration changed');
      await restore();
    }),

    /**
     * Applies the plan for one viewer. Resolves to a function to call when the
     * viewer disconnects.
     */
    acquire: (want) => serially(async () => {
      clearTimeout(restoreTimer);
      viewers++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (--viewers > 0) return;
        restoreTimer = setTimeout(() => serially(() => (viewers ? null : restore())), RESTORE_DELAY_MS);
      };
      try {
        const s = await state();
        const next = plan(s, want);
        if (!next) return release;
        if (!original) {
          original = currentConfig(s);
          fs.writeFileSync(saved, JSON.stringify(original), { mode: 0o600 });
        }
        await apply(next);
        const t = next.find((l) => l.primary);
        log(`monitors: showing ${t.monitors.map((m) => m.connector).join('+')} at ${t.monitors[0].mode}, scale ${t.scale}`);
      } catch (err) {
        log(`monitors: could not change the configuration: ${err.message.trim().split('\n').at(-1)}`);
      }
      return release;
    }),
  };
}
