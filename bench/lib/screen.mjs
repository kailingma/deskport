// One screen measurement on the separate desktop (source=session), so no
// input reaches the desktop on the monitor. Connects like the page does
// (/ws/screen, and /ws/video for the video encodings) through a simulated
// link and runs four phases:
//
//   start   socket open until the first picture arrives
//   idle    5 s with no input: bytes and frames
//   typing  opens the Activities search and types 12 letters and 12
//           backspaces; key to pixel is the time from sending a key until the
//           first picture update arrives after it. Before each key the bench
//           waits until the link is empty and the picture quiet, and updates
//           sooner than one round trip after the key are not counted, so an
//           update queued before the key cannot be taken for its answer
//   motion  opens and closes the Activities overview every 350 ms for about
//           10 s: bytes, frames, and the time from each press to the first
//           update after it (at least one round trip); then the time until
//           the link has delivered everything (catch-up)
//
// Frames are acknowledged when they arrive, as if drawing took no time, so
// the numbers leave out the browser's decoding and drawing.
import WebSocket from 'ws';

const KEYS = { superL: 0xffeb, esc: 0xff1b, backspace: 0xff08 };
const DRAW = /(^|;)\d+\.(img|png|jpeg|rect|copy|cfill|transfer|blob),/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (...el) => el.map((e) => `${[...String(e)].length}.${e}`).join(',') + ';';

export const ENCODINGS = {
  images: 'encoding=images',
  av1: 'encoding=av1&speed=0&bitrate=auto',
  h264: 'encoding=h264&speed=0&bitrate=auto',
};

/** Runs one case. `ws` is the link's ws:// base, `host` the server's host:port. */
export async function measureScreen({ base, host, link, encoding, query = '', timeoutMs = 5000 }) {
  const q = `width=1280&height=720&dpi=96&source=session&quality=high&res=1&priority=speed&${ENCODINGS[encoding]}${query ? `&${query}` : ''}`;
  const opts = { origin: `http://${host}`, headers: { host }, perMessageDeflate: true };
  const screen = new WebSocket(`${base}/ws/screen?${q}`, 'guacamole', opts);
  const video = encoding === 'images' ? null : { ws: null, stats: [], codec: null };
  const t0 = performance.now();
  let firstPicture = null;
  let frames = 0;
  let lastPicture = performance.now();
  const waiters = new Set(); // { at, resolve }, each answered by the next update
  let error = null;

  const picture = () => {
    const now = performance.now();
    lastPicture = now;
    frames++;
    firstPicture ??= now - t0;
    for (const w of waiters) {
      if (now - w.at < link.rttMs) continue;
      waiters.delete(w);
      w.resolve(now - w.at);
    }
  };

  screen.on('message', (data) => {
    const s = data.toString();
    const id = /^0\.,36\.([0-9a-f-]{36});/.exec(s);
    if (id && video) openVideo(id[1]);
    for (const f of s.matchAll(/4\.sync,(\d+)\.(\d+)[,;]/g)) {
      if (screen.readyState === screen.OPEN) screen.send(`4.sync,${f[1]}.${f[2]};`);
      if (!video) frames++;
    }
    if (!video && DRAW.test(s)) {
      frames--; // counted by picture() instead of the sync
      picture();
    }
    const err = /(?:^|;)5\.error,\d+\.([^;]*?),/.exec(s);
    if (err) error = err[1];
  });

  function openVideo(uuid) {
    video.ws = new WebSocket(`${base}/ws/video?tunnel=${uuid}`, { origin: `http://${host}`, headers: { host } });
    video.ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stats') video.stats.push(msg);
        else if (msg.type === 'config') video.codec = msg.codec;
        else if (msg.type === 'error') error = msg.message;
        return;
      }
      const seq = data.readUInt32LE(0);
      picture();
      video.ws.send(JSON.stringify({ type: 'ack', seq }));
    });
  }

  /** Waits until the link is empty and no picture arrived for `ms` (at most 10 s). */
  const quiet = async (ms = 300) => {
    const until = performance.now() + 10000;
    while (performance.now() < until && (link.queued() > 0 || performance.now() - lastPicture < ms)) await sleep(20);
  };
  const key = (keysym) => { screen.send(enc('key', keysym, 1)); screen.send(enc('key', keysym, 0)); };
  const timed = (keysym, ms = timeoutMs) => new Promise((resolve) => {
    const w = { at: performance.now(), resolve };
    waiters.add(w);
    key(keysym);
    setTimeout(() => { if (waiters.delete(w)) resolve(null); }, ms);
  });
  const window = async (fn) => {
    const b0 = link.bytes.down;
    const f0 = frames;
    const w0 = performance.now();
    await fn();
    const secs = (performance.now() - w0) / 1000;
    return { secs: +secs.toFixed(1), kB: Math.round((link.bytes.down - b0) / 1024), fps: +((frames - f0) / secs).toFixed(1) };
  };

  await new Promise((resolve, reject) => { screen.on('open', resolve); screen.on('error', reject); });
  for (let i = 0; i < 200 && firstPicture === null && !error; i++) await sleep(100);
  if (firstPicture === null) {
    screen.close();
    video?.ws?.close();
    return { encoding, error: error || 'no picture within 20 s' };
  }
  await sleep(3000);

  const idle = await window(() => sleep(5000));

  const keyTimes = [];
  const typing = await window(async () => {
    key(KEYS.superL);
    await sleep(1500);
    for (let i = 0; i < 12; i++) {
      await quiet();
      keyTimes.push(await timed(0x61 + i));
      await quiet();
      keyTimes.push(await timed(KEYS.backspace));
    }
    key(KEYS.esc);
    await sleep(1000);
  });

  // Motion: bytes and frames count until the picture has caught up (the
  // link empty and no update for 1.5 s, at most 60 s); rates are per second
  // of pressing. Bytes are those the server sent into the link.
  const pressTimes = [];
  const b0 = link.bytes.down;
  const f0 = frames;
  const m0 = performance.now();
  const presses = [];
  for (let i = 0; i < 28; i++) {
    presses.push(timed(KEYS.superL, 3000));
    await sleep(350);
  }
  const end = performance.now();
  for (const p of presses) pressTimes.push(await p);
  while ((link.queued() > 0 || performance.now() - lastPicture < 1500) && performance.now() - end < 60000) await sleep(50);
  const catchUpMs = Math.round(Math.max(0, lastPicture - end));
  const pressSecs = (end - m0) / 1000;
  const motion = {
    secs: +pressSecs.toFixed(1),
    kB: Math.round((link.bytes.down - b0) / 1024),
    fps: +((frames - f0) / ((lastPicture > end ? lastPicture : end) - m0) * 1000).toFixed(1),
  };

  // The video socket first: closing the screen ends the RDP session and its
  // monitor, which would stop the encoder with an error.
  video?.ws?.close();
  await sleep(200);
  screen.close();
  await sleep(500);

  const s = video?.stats ?? [];
  const pick = (k) => s.map((x) => x[k]).filter((x) => typeof x === 'number');
  return {
    encoding,
    firstPictureMs: Math.round(firstPicture),
    keyToPixel: summary(keyTimes),
    pressToPixel: summary(pressTimes),
    idle,
    typing,
    motion,
    motionKBPerMin: Math.round((motion.kB / motion.secs) * 60),
    idleKBPerMin: Math.round((idle.kB / idle.secs) * 60),
    typingKBPerMin: Math.round((typing.kB / typing.secs) * 60),
    catchUpMs,
    ...(video ? {
      codec: video.codec,
      encodeMs: summary(pick('encodeMs')),
      kbps: summary(pick('kbps')),
      rttMs: summary(pick('rttMs')),
    } : {}),
    ...(error ? { error } : {}),
  };
}

/** Median, 90th percentile, maximum and count of misses (nulls). */
export function summary(values) {
  const ok = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (!ok.length) return { n: values.length, missed: values.length };
  const at = (p) => Math.round(ok[Math.min(ok.length - 1, Math.floor(ok.length * p))]);
  return { n: values.length, missed: values.length - ok.length, median: at(0.5), p90: at(0.9), max: Math.round(ok.at(-1)) };
}
