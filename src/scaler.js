import sharp from 'sharp';
import { encode } from './guac.js';

// Rewrites the Guacamole stream between guacd and the browser so the browser
// receives a smaller and/or more compressed picture than the desktop sends.
//
// GNOME desktop sharing mirrors the monitor at its native size and ignores the
// size a client asks for. Instead of changing the monitor, every coordinate in
// drawing instructions is multiplied by `scale`, every image is resized and
// re-encoded at the requested quality, and mouse input from the browser is
// divided by `scale` on the way back.

const LOSSY_QUALITY = { low: 35, medium: 60, high: 82 };
const BLOB_CHUNK = 8064; // base64 characters per blob, the size guacd uses

/**
 * @param {object} opts
 * @param {number|null} opts.scale  fixed scale, or null to pick one from `target` once the desktop size is known
 * @param {{width:number,height:number}} opts.target  device pixels the picture should fill (for auto)
 * @param {'low'|'medium'|'high'|'lossless'} opts.quality
 * @param {(s: string) => void} opts.send  receives batched instruction text for the browser
 * @param {(s: string) => void} opts.log
 */
export function createScaler({ scale, target, quality, send, log }) {
  let s = scale; // null until the desktop size is known (auto)
  // At full size with high or lossless quality, guacd's own images are already right.
  const passthrough = () => s === 1 && (quality === 'high' || quality === 'lossless');
  const holding = []; // instructions received before `s` is known
  const streams = new Map(); // image streams being collected, by stream index
  const queue = []; // strings and promises of strings, in output order
  let flushing = false;
  let closed = false;

  const R = (v) => Math.round(Number(v) * s);
  /** Maps a span so that adjacent spans stay adjacent after rounding. */
  const span = (start, length) => {
    const a = R(start);
    return [a, Math.max(0, R(Number(start) + Number(length)) - a)];
  };

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length && !closed) {
        let batch = '';
        while (queue.length && typeof queue[0] === 'string') batch += queue.shift();
        if (batch) send(batch);
        if (queue.length) {
          const text = await queue[0];
          queue.shift();
          if (text) send(text);
        }
      }
    } finally {
      flushing = false;
    }
  }

  const emit = (item) => {
    queue.push(item);
    flush();
  };

  async function renderImage({ index, mask, layer, x, y, chunks }) {
    try {
      const input = Buffer.from(chunks.join(''), 'base64');
      const meta = await sharp(input).metadata();
      const [x2, w] = span(x, meta.width);
      const [y2, h] = span(y, meta.height);
      if (!w || !h) return '';

      let img = sharp(input);
      if (s !== 1) img = img.resize(w, h, { fit: 'fill', kernel: s < 0.6 ? 'mitchell' : 'cubic' });
      let mime;
      if (quality === 'lossless') {
        img = img.png({ compressionLevel: 2 });
        mime = 'image/png';
      } else {
        // WebP: on desktop text it came out 15% smaller than JPEG at quality 60
        // and 39% smaller than 4:4:4 JPEG at 82, for about 20% more encoding time.
        img = img.webp({ quality: LOSSY_QUALITY[quality], alphaQuality: 90, effort: 0 });
        mime = 'image/webp';
      }
      const data = (await img.toBuffer()).toString('base64');

      let out = encode(['img', index, mask, layer, mime, x2, y2]);
      for (let i = 0; i < data.length; i += BLOB_CHUNK) out += encode(['blob', index, data.slice(i, i + BLOB_CHUNK)]);
      return out + encode(['end', index]);
    } catch (err) {
      log(`scaler: dropped an image: ${err.message}`);
      return encode(['end', index]);
    }
  }

  /** Rewrites one instruction; returns its text, or '' when it is consumed. */
  function rewrite({ raw, elements: e }) {
    const op = e[0];
    switch (op) {
      case 'img': {
        if (!/^image\//.test(e[4])) return raw;
        streams.set(e[1], { index: e[1], mask: e[2], layer: e[3], x: e[5], y: e[6], chunks: [] });
        return '';
      }
      case 'blob': {
        const st = streams.get(e[1]);
        if (!st) return raw;
        st.chunks.push(e[2]);
        return '';
      }
      case 'end': {
        const st = streams.get(e[1]);
        if (!st) return raw;
        streams.delete(e[1]);
        return renderImage(st);
      }
      case 'size':
        if (e.length < 4) return raw;
        return encode(['size', e[1], Math.max(1, Math.ceil(e[2] * s)), Math.max(1, Math.ceil(e[3] * s))]);
      case 'rect':
        return encode(['rect', e[1], ...interleave(span(e[2], e[4]), span(e[3], e[5]))]);
      case 'copy':
      case 'transfer': {
        const [sx, w] = span(e[2], e[4]);
        const [sy, h] = span(e[3], e[5]);
        return encode([op, e[1], sx, sy, w, h, e[6], e[7], R(e[8]), R(e[9])]);
      }
      case 'cursor': {
        const [sx, w] = span(e[4], e[6]);
        const [sy, h] = span(e[5], e[7]);
        return encode(['cursor', R(e[1]), R(e[2]), e[3], sx, sy, w, h]);
      }
      case 'mouse':
        return encode(['mouse', R(e[1]), R(e[2]), ...e.slice(3)]);
      case 'move':
        return encode(['move', e[1], e[2], R(e[3]), R(e[4]), ...e.slice(5)]);
      case 'start':
      case 'line':
        return encode([op, e[1], R(e[2]), R(e[3])]);
      case 'arc':
        return encode(['arc', e[1], R(e[2]), R(e[3]), R(e[4]), ...e.slice(5)]);
      case 'curve':
        return encode(['curve', e[1], ...e.slice(2, 8).map(R)]);
      case 'cstroke':
      case 'lstroke':
        return encode([op, ...e.slice(1, 5), Math.max(1, R(e[5])), ...e.slice(6)]);
      default:
        return raw;
    }
  }

  function interleave([x, w], [y, h]) {
    return [x, y, w, h];
  }

  function handle(instruction) {
    if (s === null) {
      const e = instruction.elements;
      if (e[0] === 'size' && e[1] === '0') {
        const fit = Math.min(target.width / Number(e[2]), target.height / Number(e[3]));
        s = fit >= 0.9 ? 1 : Math.max(0.2, Math.round(fit * 100) / 100);
        log(`scaler: desktop ${e[2]}x${e[3]}, sending at ${Math.round(e[2] * s)}x${Math.round(e[3] * s)} (${quality})`);
        for (const held of holding.splice(0)) handle(held);
      } else {
        holding.push(instruction);
        return;
      }
    }
    const out = passthrough() ? instruction.raw : rewrite(instruction);
    if (out) emit(out);
  }

  return {
    /** Feeds instructions from guacd, in order. */
    push(instructions) {
      for (const i of instructions) handle(i);
    },

    /** Maps mouse coordinates in a message from the browser back to desktop pixels. */
    mapInput(msg) {
      if (!s || s === 1 || !msg.includes('5.mouse,')) return msg;
      return msg.replace(/5\.mouse,(\d+)\.(-?\d+),(\d+)\.(-?\d+)/g, (_, _l1, x, _l2, y) => {
        const X = String(Math.round(Number(x) / s));
        const Y = String(Math.round(Number(y) / s));
        return `5.mouse,${X.length}.${X},${Y.length}.${Y}`;
      });
    },

    close() {
      closed = true;
      queue.length = 0;
      streams.clear();
    },
  };
}
