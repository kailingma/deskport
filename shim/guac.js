import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createScaler } from './scaler.js';
import { createAckAhead, lastSyncTimestamp } from './pacing.js';
import { createDrawFilter, createVideoSource, ENCODINGS, BITRATES } from './video.js';
import { handleDirect } from './direct.js';

// Guacamole protocol: each element is "<length>.<value>", elements are
// separated by "," and an instruction ends with ";". Lengths count Unicode
// code points, not UTF-16 units or bytes.

const ASCII_ONLY = /^[\x00-\x7f]*$/;

function codePointLength(s) {
  if (ASCII_ONLY.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function encode(elements) {
  return elements.map((e) => {
    const s = String(e);
    return `${codePointLength(s)}.${s}`;
  }).join(',') + ';';
}

/** Index just past `count` code points starting at `start`, or -1 if the string ends first. */
function advanceCodePoints(s, start, count) {
  const fastEnd = start + count;
  if (fastEnd > s.length) return -1;
  if (!/[\uD800-\uDBFF]/.test(s.slice(start, fastEnd))) return fastEnd;
  let i = start;
  for (let n = 0; n < count; n++) {
    if (i >= s.length) return -1;
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i > s.length ? -1 : i;
}

export class GuacParser {
  buf = '';

  /** Appends text and returns every complete instruction as {raw, elements}. */
  push(text) {
    this.buf += text;
    const s = this.buf;
    const out = [];
    let pos = 0;
    let instStart = 0;
    let elements = [];

    while (pos < s.length) {
      const dot = s.indexOf('.', pos);
      if (dot === -1) break;
      const lenStr = s.slice(pos, dot);
      if (!/^\d{1,9}$/.test(lenStr)) throw new Error(`malformed Guacamole instruction near "${s.slice(pos, pos + 20)}"`);
      const end = advanceCodePoints(s, dot + 1, Number(lenStr));
      if (end === -1 || end >= s.length) break;
      const term = s[end];
      if (term !== ',' && term !== ';') throw new Error('malformed Guacamole instruction terminator');
      elements.push(s.slice(dot + 1, end));
      pos = end + 1;
      if (term === ';') {
        out.push({ raw: s.slice(instStart, pos), elements });
        instStart = pos;
        elements = [];
      }
    }

    this.buf = s.slice(instStart);
    return out;
  }
}

const STATUS_UPSTREAM_NOT_FOUND = 0x0204;
const STATUS_SERVER_ERROR = 0x0200;

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/**
 * Bridges a guacamole-common-js WebSocketTunnel to guacd and opens an RDP
 * session to this machine's GNOME desktop sharing.
 */
// Picture settings from the settings menu. GNOME desktop sharing ignores colour
// depth, most RDP experience flags and the requested size, so deskport shapes
// the picture itself:
//   quality   low | medium | high | lossless. Low and medium re-encode guacd's
//             images as WebP at quality 35 / 60 (see scaler.js); lossless makes
//             guacd send only lossless images. At high and lossless, guacd's
//             PNGs are re-encoded as lossless WebP (same pixels, about a
//             quarter smaller) unless DESKPORT_LOSSLESS_WEBP=0.
//   priority  speed sends every frame; data paces frame acknowledgements so
//             guacd sends about 10 frames per second.
//   res       auto | 1 | 0.75 | 0.5 | 0.33. Below 1, scaler.js shrinks the picture;
//             auto picks the scale that fills the browser's device pixels.
//   encoding  images (guacd's pictures, as above) | av1 | h264. The video
//             encodings send the picture as a video stream instead (video.js),
//             at encoder speed `speed` (0 fastest .. 2 smallest) and `bitrate`
//             (auto adapts to the link, or a fixed kbit/s).
const QUALITIES = new Set(['low', 'medium', 'high', 'lossless']);
const SCALES = new Set(['1', '0.75', '0.5', '0.33']);
const DATA_SAVER_FRAME_MS = 100;
// Frames the bridge acknowledges ahead of the browser at Responsiveness (pacing.js); 0 turns it off.
const ACK_AHEAD = Number(process.env.DESKPORT_ACK_AHEAD ?? 2);
const LOSSLESS_WEBP = process.env.DESKPORT_LOSSLESS_WEBP !== '0';

// Screen source:
//   mirror   the physical monitor (GNOME desktop sharing in mirror-primary mode).
//   virtual  an extra monitor: GNOME desktop sharing in extend mode adds a
//            virtual monitor sized to the browser beside the physical one, and
//            resizes it as the browser window changes. It is a secondary
//            monitor, so it has no top bar; windows have to be moved onto it.
//   session  a separate headless GNOME desktop on its own RDP port
//            (session.js), with one monitor sized to the browser.
export const SCREEN_SOURCES = ['mirror', 'virtual', 'session'];
const SOURCES = new Set(SCREEN_SOURCES);

// GNOME offers a monitor scale only if the scaled desktop keeps at least this
// many logical pixels, and virtual monitors only get whole-number scales here.
const MIN_LOGICAL_AREA = 800 * 480;

/**
 * Picks how the separate desktop fills a browser of w x h device pixels at the
 * given DPI: at full device resolution with a GNOME scale of 2 or more when
 * GNOME allows one (sharp, right-sized text), otherwise at CSS-pixel size and
 * scale 1, which the browser enlarges.
 */
export function sessionLayout(w, h, dpi) {
  for (let s = Math.floor(dpi / 96 + 0.25); s >= 2; s--) {
    const step = 4 * s; // whole logical pixels, and even sizes for guacd
    const fw = Math.floor(w / step) * step;
    const fh = Math.floor(h / step) * step;
    if ((fw / s) * (fh / s) >= MIN_LOGICAL_AREA) return { scale: s, width: fw, height: fh, dpi };
  }
  return { scale: 1, width: w, height: h, dpi: 96 };
}
const run = promisify(execFile);
async function setShareMode(mode, log) {
  try {
    const { stdout } = await run('gsettings', ['get', 'org.gnome.desktop.remote-desktop.rdp', 'screen-share-mode']);
    if (stdout.trim() === `'${mode}'`) return;
    await run('gsettings', ['set', 'org.gnome.desktop.remote-desktop.rdp', 'screen-share-mode', mode]);
    log(`screen: GNOME desktop sharing set to ${mode}`);
  } catch (err) {
    log(`screen: could not set screen-share-mode to ${mode}: ${err.message}`);
  }
}

/** True if `uid` is signed in to a desktop on a seat (not only ssh or a lingering user manager). */
export function hasDesktopLogin(sessions, uid) {
  return sessions.some((s) => s.uid === uid && s.class === 'user' && s.seat);
}

function portOpen(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const NO_DESKTOP_LOGIN = 'Nobody is signed in on this computer\'s screen, so there is nothing to show. '
  + 'This happens after a restart. Sign in at the computer, or choose Separate desktop.';

/**
 * Resolves once GNOME desktop sharing accepts connections on host:port. On this
 * machine it starts gnome-remote-desktop if a desktop login exists, and rejects
 * with NO_DESKTOP_LOGIN if none does (GNOME shares only a signed-in desktop).
 */
async function desktopSharingReady(host, port, log) {
  if (await portOpen(host, port)) return;
  if (!LOOPBACK.has(host)) throw new Error(`GNOME desktop sharing is not answering at ${host}:${port}.`);
  let sessions = null;
  try {
    sessions = JSON.parse((await run('loginctl', ['list-sessions', '-j'])).stdout);
  } catch (err) {
    log(`screen: could not list login sessions: ${err.message}`);
  }
  if (sessions && !hasDesktopLogin(sessions, process.getuid())) {
    log(`screen: port ${port} closed and no desktop login`);
    throw new Error(NO_DESKTOP_LOGIN);
  }
  log(`screen: port ${port} closed, starting gnome-remote-desktop`);
  await run('systemctl', ['--user', 'start', 'gnome-remote-desktop.service']).catch((err) => {
    log(`screen: could not start gnome-remote-desktop: ${err.message}`);
  });
  for (let i = 0; i < 10; i++) {
    if (await portOpen(host, port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`GNOME desktop sharing is not answering on port ${port}. Check that desktop sharing is on in Settings, System, Remote Desktop on the computer.`);
}

const BASE_PARAMS = {
  'color-depth': '24',
  'enable-font-smoothing': 'true',
  'enable-wallpaper': 'true',
  'enable-theming': 'true',
  'enable-desktop-composition': 'true',
  'enable-full-window-drag': 'true',
};

const VIDEO_SELF_ACK_MS = 250;

export function handleScreen(ws, req, { guacd, rdp, session, monitors, video, mainBus }, log) {
  const url = new URL(req.url, 'http://localhost');
  const width = intParam(url.searchParams.get('width'), 1280, 320, 7680);
  const height = intParam(url.searchParams.get('height'), 720, 240, 4320);
  const dpi = intParam(url.searchParams.get('dpi'), 96, 48, 384);
  const timezone = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(url.searchParams.get('tz') || '')
    ? url.searchParams.get('tz')
    : '';

  const q = url.searchParams;
  const quality = QUALITIES.has(q.get('quality')) ? q.get('quality') : 'high';
  const priority = q.get('priority') === 'data' ? 'data' : 'speed';
  const res = q.get('res') === 'auto' || SCALES.has(q.get('res')) ? q.get('res') : '1';
  const audio = q.get('audio') === '1';
  const encoding = ENCODINGS.includes(q.get('encoding')) && video ? q.get('encoding') : 'images';
  const videoMode = encoding !== 'images';
  const speed = intParam(q.get('speed'), 0, 0, 2);
  const bitrate = BITRATES.includes(q.get('bitrate')) ? q.get('bitrate') : 'auto';
  // With a video encoding the browser's own acknowledgements are not used:
  // guacd's pictures are dropped, so the bridge acknowledges its frames itself.
  const minFrameMs = videoMode ? 0 : priority === 'data' ? DATA_SAVER_FRAME_MS : 0;
  const source = SOURCES.has(q.get('source')) ? q.get('source') : 'mirror';
  // My monitor only: "match" changes the monitor's mode to fit this browser
  // while it is connected; "monitor" names the monitor to show (monitors.js).
  const match = source === 'mirror' && q.get('match') === '1';
  const monitor = source === 'mirror' && /^[A-Za-z0-9-]{1,32}$/.test(q.get('monitor') || '') ? q.get('monitor') : 'primary';
  // Extra monitors and the separate desktop are already the browser's size, so
  // they never need shrinking.
  const sized = source !== 'mirror';
  const reshape = LOSSLESS_WEBP || (!sized && res !== '1') || quality === 'low' || quality === 'medium';
  const port = source === 'session' ? rdp.sessionPort : rdp.port;
  // guacd turns the browser's device pixels into a desktop size using its "dpi"
  // argument. An extra monitor is always made at CSS-pixel size (scale 1 on the
  // main desktop is never changed); the separate desktop follows sessionLayout().
  // The direct path (shim/direct.js): no guacd or RDP, for the separate
  // desktop with a video encoding. Other sources and images use guacd.
  if (q.get('path') === 'direct' && source === 'session' && videoMode) {
    return handleDirect(ws, { width, height, dpi, encoding, speed, quality, priority, bitrate, session, video, log });
  }
  const layout = source === 'session' ? sessionLayout(width, height, dpi)
    : source === 'virtual' ? { scale: 1, width, height, dpi: 96 }
    : null;

  const params = {
    hostname: rdp.hostname,
    port: String(port),
    username: rdp.username,
    password: rdp.password,
    security: 'any',
    'ignore-cert': 'true',
    'disable-audio': audio ? 'false' : 'true',
    ...(sized ? { 'resize-method': 'display-update', dpi: String(layout.dpi) } : {}),
    'server-layout': 'en-us-qwerty',
    timezone,
    ...BASE_PARAMS,
    ...(quality === 'lossless' ? { 'force-lossless': 'true' } : {}),
  };

  let releaseMonitors = null;
  ws.on('close', () => releaseMonitors?.());
  const ready = source === 'session'
    ? session.ensureRunning()
    : desktopSharingReady(rdp.hostname, port, log)
      .then(() => setShareMode(source === 'virtual' ? 'extend' : 'mirror-primary', log))
      .then(async () => {
        if (!match && monitor === 'primary') return;
        const release = await monitors.acquire(match ? { width, height, monitor } : { monitor });
        if (ws.readyState === ws.OPEN) releaseMonitors = release;
        else release();
      });
  ready.then(() => {
    if (ws.readyState === ws.OPEN) connect();
  }, (err) => {
    log(`screen: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      const message = source === 'session' ? `Could not start the separate desktop: ${err.message}` : err.message;
      ws.send(encode(['error', message, String(STATUS_UPSTREAM_NOT_FOUND)]));
      ws.close(1011, String(STATUS_UPSTREAM_NOT_FOUND));
    }
  });

  function connect() {
    const socket = net.connect(guacd.port, guacd.host);
    const decoder = new StringDecoder('utf8');
    const parser = new GuacParser();
    let handshakeDone = false;
    let lastSync = 0;
    let heldSync = null;
    // At Responsiveness, frames are acknowledged to guacd as they leave (pacing.js).
    const pacer = videoMode || minFrameMs || !ACK_AHEAD ? null : createAckAhead({
      max: ACK_AHEAD,
      ack: (ts) => { if (!socket.destroyed) socket.write(encode(['sync', ts])); },
    });
    // Video encodings: guacd's drawing on the visible picture is dropped, and
    // a video stream of the same monitor replaces it at the size the browser
    // receives (after the scaler).
    const drawFilter = videoMode ? createDrawFilter() : null;
    const videoSource = videoMode ? createVideoSource({
      bus: source === 'session' ? session.bus : mainBus,
      monitor: source === 'mirror' ? monitor : 'virtual',
      codec: encoding, speed, quality, priority, bitrate, log,
    }) : null;
    let desktopSize = null;
    let uuid = null;
    let selfAck = null; // newest sync from guacd not yet acknowledged
    let selfAckTimer = null;
    const ackGuacd = () => {
      selfAckTimer = null;
      if (selfAck && !socket.destroyed) socket.write(encode(['sync', selfAck]));
      selfAck = null;
    };
    const toBrowser = (text) => {
      if (ws.readyState !== ws.OPEN) return;
      if (videoSource && text.includes('4.size,1.0,')) {
        const m = [...text.matchAll(/(?:^|;)4\.size,1\.0,\d+\.(\d+),\d+\.(\d+);/g)].at(-1);
        if (m && desktopSize) videoSource.setSize(Number(m[1]), Number(m[2]), desktopSize);
      }
      const ts = pacer && lastSyncTimestamp(text);
      ws.send(text, ts ? (err) => { if (!err) pacer.sent(ts, ws.bufferedAmount); } : undefined);
    };
    const scaler = reshape
      ? createScaler({
        scale: sized ? 1 : res === 'auto' ? null : Number(res),
        target: { width, height },
        quality,
        send: toBrowser,
        log,
      })
      : null;
    let closed = false;

    const closeAll = (code, reason) => {
      if (closed) return;
      closed = true;
      scaler?.close();
      clearTimeout(selfAckTimer);
      if (uuid) video?.withdraw(uuid);
      videoSource?.close();
      socket.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    };

    const sendError = (message, status) => {
      if (ws.readyState === ws.OPEN) ws.send(encode(['error', message, String(status)]));
      closeAll(1011, String(status));
    };

    socket.setNoDelay(true);

    // The separate desktop starts each monitor at scale 1; match this device's
    // pixel density once the monitor has settled at a new size.
    let scaleTimer;
    const scaleSession = (w, h) => {
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => {
        if (closed) return;
        session.setScale(w, h, layout.scale).then(
          (applied) => log(`screen: separate desktop ${w}x${h} at scale ${applied}`),
          (err) => log(`screen: could not scale the separate desktop: ${err.message.split('\n').at(-2) || err.message}`),
        );
      }, 400);
    };

    socket.on('connect', () => {
      socket.write(encode(['select', 'rdp']));
    });

    socket.on('data', (chunk) => {
      let instructions;
      try {
        instructions = parser.push(decoder.write(chunk));
      } catch (err) {
        log(`screen: ${err.message}`);
        return sendError('Bad data from guacd', STATUS_SERVER_ERROR);
      }

      if (!handshakeDone) {
        const argsIdx = instructions.findIndex((i) => i.elements[0] === 'args');
        if (argsIdx === -1) return;
        const names = instructions[argsIdx].elements.slice(1);
        const values = names.map((name) => (name.startsWith('VERSION_') ? name : params[name] ?? ''));

        socket.write(
          encode(['size', layout?.width ?? width, layout?.height ?? height, dpi]) +
            encode(['audio', ...(audio ? ['audio/L8', 'audio/L16'] : [])]) +
            encode(['video']) +
            encode(['image', 'image/png', 'image/jpeg', 'image/webp']) +
            (timezone ? encode(['timezone', timezone]) : '') +
            encode(['connect', ...values]),
        );
        handshakeDone = true;
        log(`screen: connecting RDP ${rdp.hostname}:${port} (${source}, ${encoding}, quality ${quality}, ${priority}, scale ${sized ? 'n/a' : res}, browser ${width}x${height}${layout ? `, desktop ${layout.width}x${layout.height} at GNOME scale ${layout.scale}` : ''})`);

        // First message tells the browser tunnel its UUID and marks it open.
        uuid = randomUUID();
        if (videoSource) video.offer(uuid, videoSource);
        ws.send(encode(['', uuid]));
        instructions = instructions.slice(argsIdx + 1);
      }

      if (!instructions.length) return;
      if (videoSource) {
        const size = instructions.findLast((i) => i.elements[0] === 'size' && i.elements[1] === '0');
        if (size) desktopSize = [Number(size.elements[2]), Number(size.elements[3])];
        const sync = instructions.findLast((i) => i.elements[0] === 'sync');
        if (sync) {
          selfAck = sync.elements[1];
          selfAckTimer ??= setTimeout(ackGuacd, VIDEO_SELF_ACK_MS);
        }
        instructions = drawFilter(instructions);
        if (!instructions.length) return;
      }
      if (source === 'session' && layout.scale > 1) {
        const size = instructions.findLast((i) => i.elements[0] === 'size' && i.elements[1] === '0');
        if (size) scaleSession(Number(size.elements[2]), Number(size.elements[3]));
      }
      if (scaler) scaler.push(instructions);
      else toBrowser(instructions.map((i) => i.raw).join(''));
    });

    socket.on('error', (err) => {
      log(`screen: guacd ${guacd.host}:${guacd.port} error: ${err.code || err.message}`);
      sendError(`guacd is not reachable at ${guacd.host}:${guacd.port}`, STATUS_UPSTREAM_NOT_FOUND);
    });

    socket.on('close', () => closeAll(1000, ''));

    ws.on('message', (raw) => {
      const msg = raw.toString();
      // Internal tunnel instructions start with an empty opcode ("0.").
      // The browser sends "ping" this way and expects it echoed back.
      if (msg.startsWith('0.,')) {
        if (msg.startsWith('0.,4.ping,') && ws.readyState === ws.OPEN) ws.send(msg);
        return;
      }
      if (!handshakeDone || socket.destroyed) return;
      // Resizes of a scaled separate desktop keep whole logical pixels.
      if (layout?.scale > 1 && msg.startsWith('4.size,')) {
        const m = /^4\.size,\d+\.(\d+),\d+\.(\d+);$/.exec(msg);
        if (m) {
          const step = 4 * layout.scale;
          socket.write(encode(['size', Math.floor(m[1] / step) * step, Math.floor(m[2] / step) * step]));
          return;
        }
      }
      // guacd sends the next frame only after the browser acknowledges the last
      // one, so holding acknowledgements back caps the frame rate. Only the
      // newest held acknowledgement is sent: it covers every frame before it,
      // and queueing each one would add the wait once per frame.
      if (videoMode && msg.startsWith('4.sync,')) return;
      if (pacer && msg.startsWith('4.sync,')) {
        const ts = /^4\.sync,\d+\.(\d+)/.exec(msg)?.[1];
        if (ts && !pacer.fromBrowser(ts)) return;
      }
      if (minFrameMs && msg.startsWith('4.sync,')) {
        const wait = lastSync + minFrameMs - Date.now();
        if (wait > 0) {
          const pending = heldSync;
          heldSync = msg;
          if (pending === null) {
            setTimeout(() => {
              const latest = heldSync;
              heldSync = null;
              lastSync = Date.now();
              if (latest && !socket.destroyed) socket.write(latest);
            }, wait);
          }
          return;
        }
        lastSync = Date.now();
      }
      socket.write(scaler ? scaler.mapInput(msg) : msg);
    });

    ws.on('close', () => closeAll(1000, ''));
  }
}
