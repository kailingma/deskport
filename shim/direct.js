import { randomUUID } from 'node:crypto';
import { createVideoSource } from './video.js';
import { encode, GuacParser, sessionLayout } from './guac.js';

// The direct screen path (roadmap phase 4), for the separate desktop with a
// video encoding: no guacd and no RDP. The picture comes from a virtual
// monitor recorded through a Mutter RemoteDesktop session
// (scripts/video-encoder.py, "direct"), and input goes to that session over
// D-Bus. To the page this looks like the usual screen connection: the bridge
// speaks the part of the Guacamole protocol the page uses (the tunnel's id,
// the display size, sync and nop out; key, mouse, size and sync in), and the
// picture arrives on /ws/video as with the other video encodings.
//
// The clipboard goes both ways through the session's selection methods: text
// the page sends becomes the desktop's clipboard, and text copied on the
// desktop is sent to the page as a clipboard stream.
//
// Not yet here: a pointer drawn by the browser (the pointer is drawn into the
// video), touch events (the page sends touch as mouse), audio.

const NOP_MS = 2000;
// Guacamole's mouse mask bits and the evdev buttons they stand for.
const BUTTONS = [[1, 272], [2, 274], [4, 273]]; // left, middle, right
const SCROLL_UP = 8;
const SCROLL_DOWN = 16;
const CLIP_MAX = 1 << 20;
// Guacamole sends stream data as base64 in pieces of at most this many bytes.
const BLOB_BYTES = 6144;

export function handleDirect(ws, { width, height, dpi, encoding, speed, quality, priority, bitrate, session, video, log, readOnly = false }) {
  if (readOnly) {
    ws.send(encode(['error', 'Read access can only view the existing monitor.', '519']));
    ws.close(1011, '519');
    return;
  }
  let layout = sessionLayout(width, height, dpi);
  let source = null;
  let uuid = null;
  let mask = 0;
  let closed = false;
  let scaleTimer = null;
  const parser = new GuacParser();
  const clips = new Map(); // stream index -> base64 pieces of text the page is sending
  let outStream = 0;
  const clipToPage = (text) => {
    const index = String(outStream++ % 1000);
    const bytes = Buffer.from(String(text));
    const out = [['clipboard', index, 'text/plain']];
    for (let i = 0; i < bytes.length; i += BLOB_BYTES) out.push(['blob', index, bytes.subarray(i, i + BLOB_BYTES).toString('base64')]);
    out.push(['end', index]);
    send(...out);
  };
  const send = (...instructions) => { if (ws.readyState === ws.OPEN) ws.send(instructions.map(encode).join('')); };

  const scale = () => {
    if (layout.scale <= 1) return;
    clearTimeout(scaleTimer);
    // The virtual monitor appears when the encoder starts; scale it once it has.
    scaleTimer = setTimeout(() => {
      if (closed) return;
      session.setScale(layout.width, layout.height, layout.scale).then(
        (applied) => log(`direct: separate desktop ${layout.width}x${layout.height} at scale ${applied}`),
        (err) => log(`direct: could not scale the separate desktop: ${err.message.split('\n').at(-2) || err.message}`),
      );
    }, 1500);
  };

  const nop = setInterval(() => send(['nop']), NOP_MS);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(nop);
    clearTimeout(scaleTimer);
    if (uuid) video.withdraw(uuid);
    source?.close();
  };
  ws.on('close', close);

  session.ensureRunning().then(() => {
    if (ws.readyState !== ws.OPEN) return close();
    source = createVideoSource({
      bus: session.bus, monitor: 'virtual', direct: true, codec: encoding, speed, quality, priority, bitrate, log,
      onMessage: (msg) => { if (msg.type === 'clipboard' && typeof msg.text === 'string') clipToPage(msg.text); },
    });
    uuid = randomUUID();
    video.offer(uuid, source);
    log(`direct: separate desktop, ${encoding}, browser ${width}x${height}, desktop ${layout.width}x${layout.height} at GNOME scale ${layout.scale}`);
    // The tunnel's id first, then the display's size; the first sync marks
    // the connection as up in the page.
    send(['', uuid]);
    send(['size', '0', layout.width, layout.height], ['sync', Date.now()]);
    source.setSize(layout.width, layout.height, [layout.width, layout.height]);
    scale();
  }, (err) => {
    log(`direct: ${err.message}`);
    send(['error', `Could not start the separate desktop: ${err.message}`, '519']);
    if (ws.readyState === ws.OPEN) ws.close(1011, '519');
    close();
  });

  ws.on('message', (raw) => {
    const msg = raw.toString();
    if (msg.startsWith('0.,')) {
      if (msg.startsWith('0.,4.ping,')) ws.send(msg);
      return;
    }
    let instructions;
    try {
      instructions = parser.push(msg);
    } catch {
      return;
    }
    for (const { elements: [op, ...args] } of instructions) {
      if (!source) continue;
      if (op === 'key') {
        source.input({ k: [Number(args[0]) >>> 0, args[1] === '1'] });
      } else if (op === 'mouse') {
        const x = Math.max(0, Math.min(layout.width - 1, Number(args[0]) || 0));
        const y = Math.max(0, Math.min(layout.height - 1, Number(args[1]) || 0));
        const next = Number(args[2]) || 0;
        source.input({ p: [x, y] });
        for (const [bit, button] of BUTTONS) {
          if ((next & bit) !== (mask & bit)) source.input({ b: [button, Boolean(next & bit)] });
        }
        if (next & SCROLL_UP && !(mask & SCROLL_UP)) source.input({ a: [0, -1] });
        if (next & SCROLL_DOWN && !(mask & SCROLL_DOWN)) source.input({ a: [0, 1] });
        mask = next;
      } else if (op === 'size') {
        const next = sessionLayout(Number(args[0]) || width, Number(args[1]) || height, dpi);
        if (next.width === layout.width && next.height === layout.height) continue;
        layout = next;
        send(['size', '0', layout.width, layout.height], ['sync', Date.now()]);
        source.setSize(layout.width, layout.height, [layout.width, layout.height]);
        scale();
      } else if (op === 'clipboard') {
        clips.set(args[0], []);
        send(['ack', args[0], 'OK', '0']);
      } else if (op === 'blob' && clips.has(args[0])) {
        const parts = clips.get(args[0]);
        parts.push(args[1] || '');
        if (parts.reduce((n, p) => n + p.length, 0) > CLIP_MAX * 1.4) clips.delete(args[0]);
        send(['ack', args[0], 'OK', '0']);
      } else if (op === 'end' && clips.has(args[0])) {
        const text = Buffer.concat(clips.get(args[0]).map((p) => Buffer.from(p, 'base64'))).toString('utf8');
        clips.delete(args[0]);
        source.input({ clip: text });
      } else if (op === 'disconnect') {
        ws.close(1000);
      }
    }
  });
}
