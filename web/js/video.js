// The Screen view's video encodings (shim/video.js on the server).
//
// Frames arrive on their own WebSocket as binary messages: u32 frame number,
// u8 1 for a keyframe, 3 zero bytes, then the encoded frame. WebCodecs decodes
// them and each frame is drawn into Guacamole's default layer, whose own
// drawing the server leaves out, so the display's scaling, zoom and touch
// handling apply unchanged. Each decoded frame is acknowledged; the server
// paces the encoder and its bitrate on those acknowledgements.

const PROBE = { av1: 'av01.0.08M.08', h264: 'avc1.640034' };
const KEY_REQUEST_MS = 1000;
let support = null;

/** Resolves to { av1, h264 }: whether this browser can decode each. */
export function videoSupport() {
  support ??= (async () => {
    const result = { av1: false, h264: false };
    if (typeof VideoDecoder === 'undefined') return result;
    for (const [name, codec] of Object.entries(PROBE)) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true });
        result[name] = !!r.supported;
      } catch {}
    }
    return result;
  })();
  return support;
}

/**
 * @param {object} opts
 * @param {string} opts.url  /ws/video URL including ?tunnel=
 * @param {() => HTMLCanvasElement|null} opts.canvas  the layer to draw into
 * @param {(stats: object) => void} opts.onStats
 * @param {(message: string) => void} opts.onError
 */
export function createVideo({ url, canvas, onStats, onError }) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let decoder = null;
  let config = null;
  let needKey = true;
  let keyAskedAt = 0;
  let lastSeq = 0;
  let closed = false;

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const ack = (seq) => send({ type: 'ack', seq });

  function askForKey() {
    const now = performance.now();
    if (now - keyAskedAt < KEY_REQUEST_MS) return;
    keyAskedAt = now;
    send({ type: 'key' });
  }

  function draw(frame) {
    const seq = frame.timestamp;
    const c = canvas();
    if (c?.width && c.height) c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
    frame.close();
    ack(seq);
  }

  function reset() {
    try { decoder?.close(); } catch {}
    decoder = null;
    needKey = true;
    if (!config) return;
    decoder = new VideoDecoder({
      output: draw,
      error: (err) => {
        if (closed) return;
        // Acknowledge what arrived so the server does not wait on lost frames,
        // and start again from the next keyframe.
        console.warn('video: decoder error', err);
        ack(lastSeq);
        reset();
        askForKey();
      },
    });
    decoder.configure({ codec: config.codec, codedWidth: config.width, codedHeight: config.height, optimizeForLatency: true });
  }

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'config') { config = m; reset(); }
      else if (m.type === 'stats') onStats(m);
      else if (m.type === 'error') onError(m.message);
      return;
    }
    const view = new DataView(e.data);
    const seq = view.getUint32(0, true);
    const key = view.getUint8(4) === 1;
    lastSeq = seq;
    if (!decoder || decoder.state !== 'configured' || (needKey && !key)) {
      ack(seq);
      askForKey();
      return;
    }
    needKey = false;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data: new Uint8Array(e.data, 8) }));
  };
  ws.onclose = () => {
    if (!closed) onError('The video connection closed.');
  };

  return {
    close() {
      closed = true;
      try { decoder?.close(); } catch {}
      ws.close();
    },
  };
}
