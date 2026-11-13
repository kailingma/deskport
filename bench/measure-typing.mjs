// Measures how long a typed key takes to show up on the screen, against a
// running dev server, using the separate desktop (source=session) so no input
// reaches the desktop on the monitor. Opens the Activities search, types
// letters and backspaces, and times each key press until guacd's next drawing
// instruction reaches this client.
// Usage: [ACK_DELAY=ms] [LINK_KBPS=n] node bench/measure-typing.mjs [ws://host:port] [query ...]
import WebSocket from 'ws';

const [base = 'ws://127.0.0.1:7900', ...queries] = process.argv.slice(2);
const cases = queries.length ? queries : ['quality=high&res=1', 'quality=low&res=1', 'quality=high&res=1&priority=data'];
const ackDelay = Number(process.env.ACK_DELAY || 0);
const linkKbps = Number(process.env.LINK_KBPS || 0);
const KEYS = { superL: 0xffeb, esc: 0xff1b, backspace: 0xff08 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (...el) => el.map((e) => `${[...String(e)].length}.${e}`).join(',') + ';';

function measure(query) {
  return new Promise((resolve) => {
    const url = `${base}/ws/screen?width=1280&height=720&dpi=96&source=session&${query}`;
    const ws = new WebSocket(url, 'guacamole', { origin: base.replace(/^ws/, 'http'), perMessageDeflate: true });
    let waiting = null; // { t0, resolve }
    // LINK_KBPS simulates a slow link: each message arrives after the ones
    // before it at that rate (plus ACK_DELAY), and frames are acknowledged and
    // timed on arrival. ACK_DELAY alone delays acknowledgements by a fixed time.
    let busyUntil = 0;
    ws.on('message', (data) => {
      const s = data.toString();
      let arrive = Date.now();
      if (linkKbps) {
        arrive = Math.max(arrive, busyUntil) + (s.length * 8) / linkKbps;
        busyUntil = arrive;
      }
      const at = (fn) => setTimeout(fn, Math.max(0, arrive + ackDelay - Date.now()));
      for (const f of s.matchAll(/4\.sync,(\d+)\.(\d+)[,;]/g)) {
        at(() => ws.readyState === ws.OPEN && ws.send(`4.sync,${f[1]}.${f[2]};`));
      }
      if (waiting && /(^|;)\d+\.(img|png|rect|copy|cfill|transfer|blob),/.test(s)) {
        const w = waiting;
        waiting = null;
        w.resolve(Math.round(arrive - w.t0));
      }
    });
    const key = (keysym) => { ws.send(enc('key', keysym, 1)); ws.send(enc('key', keysym, 0)); };
    const timed = (keysym) => new Promise((res) => {
      const w = { t0: Date.now(), resolve: res };
      waiting = w;
      key(keysym);
      setTimeout(() => { if (waiting === w) { waiting = null; res(null); } }, 3000);
    });
    ws.on('open', async () => {
      await sleep(4000);
      key(KEYS.superL);
      await sleep(1500);
      const times = [];
      for (let i = 0; i < 12; i++) {
        times.push(await timed(0x61 + (i % 26)));
        await sleep(150);
        times.push(await timed(KEYS.backspace));
        await sleep(150);
      }
      key(KEYS.esc);
      await sleep(300);
      ws.close();
      const ok = times.filter((t) => t !== null).sort((a, b) => a - b);
      resolve({
        query,
        keys: times.length,
        noUpdate: times.length - ok.length,
        medianMs: ok[Math.floor(ok.length / 2)],
        p90Ms: ok[Math.floor(ok.length * 0.9)],
        maxMs: ok.at(-1),
      });
    });
  });
}

for (const q of cases) console.log(JSON.stringify(await measure(q)));
