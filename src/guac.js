import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

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
// Quality presets, from the settings menu. GNOME desktop sharing ignores colour
// depth and most RDP experience flags, so the presets differ in frame rate and
// in whether guacd may compress lossily. Measured on a mostly static 4K desktop:
// fast ~310 KB/s at ~10 fps, balanced ~380 KB/s at ~16 fps, best 530-650 KB/s.
const PRESETS = {
  fast: { minFrameMs: 100, params: {} },
  balanced: { minFrameMs: 0, params: {} },
  best: { minFrameMs: 0, params: { 'force-lossless': 'true' } },
};

const BASE_PARAMS = {
  'color-depth': '24',
  'enable-font-smoothing': 'true',
  'enable-wallpaper': 'true',
  'enable-theming': 'true',
  'enable-desktop-composition': 'true',
  'enable-full-window-drag': 'true',
};

export function handleScreen(ws, req, { guacd, rdp }, log) {
  const url = new URL(req.url, 'http://localhost');
  const width = intParam(url.searchParams.get('width'), 1280, 320, 7680);
  const height = intParam(url.searchParams.get('height'), 720, 240, 4320);
  const dpi = intParam(url.searchParams.get('dpi'), 96, 48, 384);
  const timezone = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(url.searchParams.get('tz') || '')
    ? url.searchParams.get('tz')
    : '';

  const quality = Object.hasOwn(PRESETS, url.searchParams.get('quality')) ? url.searchParams.get('quality') : 'balanced';
  const audio = url.searchParams.get('audio') === '1';

  const params = {
    hostname: rdp.hostname,
    port: String(rdp.port),
    username: rdp.username,
    password: rdp.password,
    security: 'any',
    'ignore-cert': 'true',
    'disable-audio': audio ? 'false' : 'true',
    'server-layout': 'en-us-qwerty',
    timezone,
    ...BASE_PARAMS,
    ...PRESETS[quality].params,
  };
  const { minFrameMs } = PRESETS[quality];

  connect();

  function connect() {
    const socket = net.connect(guacd.port, guacd.host);
    const decoder = new StringDecoder('utf8');
    const parser = new GuacParser();
    let handshakeDone = false;
    let lastSync = 0;
    let closed = false;

    const closeAll = (code, reason) => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    };

    const sendError = (message, status) => {
      if (ws.readyState === ws.OPEN) ws.send(encode(['error', message, String(status)]));
      closeAll(1011, String(status));
    };

    socket.setNoDelay(true);

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
          encode(['size', width, height, dpi]) +
            encode(['audio', ...(audio ? ['audio/L8', 'audio/L16'] : [])]) +
            encode(['video']) +
            encode(['image', 'image/png', 'image/jpeg', 'image/webp']) +
            (timezone ? encode(['timezone', timezone]) : '') +
            encode(['connect', ...values]),
        );
        handshakeDone = true;
        log(`screen: connecting RDP ${rdp.hostname}:${rdp.port} (${quality}, browser ${width}x${height})`);

        // First message tells the browser tunnel its UUID and marks it open.
        ws.send(encode(['', randomUUID()]));
        instructions = instructions.slice(argsIdx + 1);
      }

      if (instructions.length && ws.readyState === ws.OPEN) {
        ws.send(instructions.map((i) => i.raw).join(''));
      }
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
      // guacd sends the next frame only after the browser acknowledges the last
      // one, so holding acknowledgements back caps the frame rate.
      if (minFrameMs && msg.startsWith('4.sync,')) {
        const wait = Math.max(0, lastSync + minFrameMs - Date.now());
        lastSync = Date.now() + wait;
        if (wait) {
          setTimeout(() => { if (!socket.destroyed) socket.write(msg); }, wait);
          return;
        }
      }
      socket.write(msg);
    });

    ws.on('close', () => closeAll(1000, ''));
  }
}
