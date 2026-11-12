import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRateControl } from './ratecontrol.js';

// The AV1 and H.264 encodings of the Screen view.
//
// The Guacamole connection (guac.js) stays up for input, the mouse pointer and
// the clipboard, but the bridge drops guacd's drawing of the visible picture
// (createDrawFilter). Instead scripts/video-encoder.py records the same
// monitor through Mutter's ScreenCast API and encodes it, and the frames go to
// the browser over a second WebSocket, /ws/video?tunnel=<the tunnel's UUID>,
// as binary messages. The browser decodes them with WebCodecs into
// Guacamole's default layer, so scaling, zoom and touch work as before.
//
// Binary messages to the browser: u32 frame number, u8 1 for a keyframe,
// 3 zero bytes, then the frame (AV1 temporal unit or H.264 access unit, Annex B).
// Text messages to the browser: {type: "config", codec, width, height} before
// the first frame of each stream, {type: "stats", ...} every second, and
// {type: "error", message}.
// Text messages from the browser: {type: "ack", seq} once every frame up to seq
// is decoded (ratecontrol.js paces on these), {type: "key"} to ask for a keyframe.

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/video-encoder.py');

export const ENCODINGS = ['images', 'av1', 'h264'];
export const BITRATES = ['auto', '500', '1000', '2000', '5000', '10000', '20000'];
// Highest bitrate Adapt chooses for each quality, kbit/s. Data use halves it.
const CEILING = { low: 1500, medium: 4000, high: 8000, lossless: 16000 };
const FPS = { speed: 30, data: 10 };
const STEP_MS = 250;
const RESTARTS = 3;

/** WebCodecs codec string for a stream of w x h. */
export function codecString(codec, w, h) {
  if (codec === 'h264') return 'avc1.640034'; // High profile, level 5.2
  const area = w * h;
  const level = area <= 2228224 ? 8 : area <= 8912896 ? 12 : 16; // levels 4.0, 5.0, 6.0
  return `av01.0.${String(level).padStart(2, '0')}M.08`;
}

// Drawing instructions and the position of the layer they draw to. Layer 0 and
// above are visible; negative layers are off-screen buffers, which guacd uses
// for the mouse pointer's image, so they are kept.
const LAYER_ARG = {
  img: 3, copy: 7, transfer: 7, rect: 1, cfill: 2, cstroke: 2, lfill: 2, lstroke: 2,
  start: 1, line: 1, arc: 1, curve: 1, close: 1, clip: 1, push: 1, pop: 1, reset: 1,
  identity: 1, transform: 1,
};

/**
 * Drops guacd's drawing on visible layers, which the video stream replaces.
 * Layer sizes, the pointer and everything else pass through.
 */
export function createDrawFilter() {
  const dropped = new Set(); // image streams being dropped, by index
  return (instructions) => instructions.filter(({ elements: e }) => {
    const op = e[0];
    if (op === 'blob' || op === 'end') {
      if (!dropped.has(e[1])) return true;
      if (op === 'end') dropped.delete(e[1]);
      return false;
    }
    const at = LAYER_ARG[op];
    if (at === undefined || Number(e[at]) < 0) return true;
    if (op === 'img') dropped.add(e[1]);
    return false;
  });
}

/**
 * One screen connection's video. guac.js creates it and reports the picture
 * size; the browser's /ws/video socket attaches to it.
 *
 * @param {object} opts
 * @param {string} opts.bus  D-Bus address of the desktop to record
 * @param {string} opts.monitor  'primary', 'virtual' or a connector name
 * @param {'av1'|'h264'} opts.codec
 * @param {number} opts.speed  0 fastest .. 2 smallest
 * @param {string} opts.quality
 * @param {'speed'|'data'} opts.priority
 * @param {string} opts.bitrate  'auto' or kbit/s
 */
export function createVideoSource({ bus, monitor, codec, speed, quality, priority, bitrate, log }) {
  const ceiling = (CEILING[quality] ?? CEILING.high) / (priority === 'data' ? 2 : 1);
  let ws = null;
  let size = null; // { width, height, desktop: [w, h] }
  let child = null;
  let running = ''; // size the encoder runs at, "WxH"
  let restartTimer = null;
  let restarts = 0;
  let closed = false;
  let rc = null;
  let seq = 0;
  let tick = null;
  let frames = 0;
  let encodeMs = [];

  const isOpen = () => ws !== null && ws.readyState === ws.OPEN;
  const send = (obj) => { if (isOpen()) ws.send(JSON.stringify(obj)); };

  function stop() {
    clearInterval(tick);
    tick = null;
    if (child) {
      child.removeAllListeners('exit');
      child.stdin.end();
      const c = child;
      setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 2000).unref();
    }
    child = null;
    running = '';
  }

  function start() {
    stop();
    if (closed || !ws || !size) return;
    // Encoders want even sizes.
    const width = size.width & ~1;
    const height = size.height & ~1;
    rc = createRateControl({ bitrate, priority, ceiling });
    const now = performance.now();
    const kbps = rc.step(now);
    const cfg = { bus, monitor, match: size.desktop, width, height, codec, speed, quality, kbps, fps: FPS[priority] };
    log(`video: ${codec} ${width}x${height} from ${monitor} (speed ${speed}, ${quality}, ${priority}, bitrate ${bitrate})`);
    const c = spawn('python3', [script, JSON.stringify(cfg)], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    running = `${width}x${height}`;
    let open = true;
    let sentKbps = kbps;
    const command = (obj) => { if (child === c && c.stdin.writable) c.stdin.write(`${JSON.stringify(obj)}\n`); };
    send({ type: 'config', codec: codecString(codec, width, height), width, height });

    let buf = Buffer.alloc(0);
    let lastError = '';
    c.stdout.on('data', (chunk) => {
      if (child !== c) return; // replaced, as after a resize
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 16) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 16 + len) break;
        const kind = buf[4];
        const key = buf[5];
        const captured = buf.readDoubleLE(8);
        const payload = buf.subarray(16, 16 + len);
        buf = buf.subarray(16 + len);
        if (kind === 1) {
          const msg = JSON.parse(payload.toString());
          // Reported only if the encoder is not restarted (see the exit handler).
          if (msg.type === 'error') lastError = msg.message;
          continue;
        }
        if (!isOpen()) continue;
        seq++;
        frames++;
        if (captured) encodeMs.push(Number(process.hrtime.bigint() / 1000n) / 1000 - captured);
        const header = Buffer.alloc(8);
        header.writeUInt32LE(seq, 0);
        header[4] = key;
        ws.send(Buffer.concat([header, payload]), { binary: true });
        rc.sent(seq, payload.length + 8, performance.now());
        const now = performance.now();
        if (!rc.open(now)) { open = false; command({ open: false }); }
      }
    });
    c.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line && !line.startsWith('Svt')) log(`video: ${line}`);
    });
    c.on('exit', (code) => {
      if (child !== c) return;
      child = null;
      running = '';
      clearInterval(tick);
      if (closed) return;
      // 3: the monitor went away, as when the separate desktop resizes it.
      if (code === 3 && restarts++ < RESTARTS) {
        restartTimer = setTimeout(start, 1000);
        return;
      }
      log(`video: encoder exited with ${code}`);
      send({ type: 'error', message: lastError ? `The video encoder stopped: ${lastError}.` : `The video encoder stopped (exit code ${code}).` });
    });

    let lastStats = now;
    tick = setInterval(() => {
      const t = performance.now();
      if (!open && rc.open(t)) { open = true; command({ open: true }); }
      const next = rc.step(t);
      if (Math.abs(next - sentKbps) / sentKbps > 0.03) {
        sentKbps = next;
        command({ kbps: next });
      }
      if (t - lastStats >= 1000) {
        encodeMs.sort((a, b) => a - b);
        send({ type: 'stats', ...rc.stats(t), fps: Math.round((frames * 1000) / (t - lastStats)), encodeMs: encodeMs.length ? Math.round(encodeMs[encodeMs.length >> 1]) : null });
        frames = 0;
        encodeMs = [];
        lastStats = t;
      }
    }, STEP_MS);
    c.ackFrame = (n) => {
      const t = performance.now();
      rc.acked(n, t);
      if (!open && rc.open(t)) { open = true; command({ open: true }); }
    };
    c.keyframe = () => command({ key: true });
  }

  return {
    /** Size of the picture the browser receives, and of the desktop it shows. */
    setSize(width, height, desktop) {
      size = { width, height, desktop };
      if (`${width & ~1}x${height & ~1}` === running) return;
      clearTimeout(restartTimer);
      restarts = 0;
      restartTimer = setTimeout(start, running ? 300 : 0);
    },

    attach(socket) {
      if (ws) return socket.close(1008, 'already attached');
      ws = socket;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'ack' && Number.isInteger(msg.seq)) child?.ackFrame?.(msg.seq);
        else if (msg.type === 'key') child?.keyframe?.();
      });
      socket.on('close', () => {
        if (ws === socket) { ws = null; stop(); }
      });
      start();
    },

    close() {
      closed = true;
      clearTimeout(restartTimer);
      stop();
      if (isOpen()) ws.close(1000);
    },
  };
}

/** Connects /ws/video sockets to the screen connection whose tunnel they name. */
export function createVideoHub({ log }) {
  const sources = new Map();
  return {
    offer(uuid, source) { sources.set(uuid, source); },
    withdraw(uuid) { sources.delete(uuid); },
    open(ws, req) {
      const uuid = new URL(req.url, 'http://localhost').searchParams.get('tunnel') || '';
      const source = sources.get(uuid);
      if (!source) {
        log('video: no screen connection for this tunnel');
        return ws.close(1008, 'unknown tunnel');
      }
      source.attach(ws);
    },
  };
}
