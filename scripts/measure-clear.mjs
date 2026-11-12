// Measures how long a full-window redraw takes to reach the browser: opens a
// terminal (Ptyxis) on the separate desktop (source=session, so no input reaches the
// desktop on the monitor), maximizes it, fills it with text and runs `clear`,
// then times from Enter until the first drawing instruction and the last large
// message (over 4 KB) of the redraw, and counts the bytes sent. Closes the terminal at the end.
// Usage: node scripts/measure-clear.mjs [ws://host:port] [query ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const [base = 'ws://127.0.0.1:7900', ...queries] = process.argv.slice(2);
const cases = queries.length ? queries : ['quality=high&res=1', 'quality=medium&res=1'];
const KS = { ctrl: 0xffe3, alt: 0xffe9, superL: 0xffeb, up: 0xff52, enter: 0xff0d };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (...el) => el.map((e) => `${[...String(e)].length}.${e}`).join(',') + ';';
const DRAW = /(^|;)\d+\.(img|png|jpeg|rect|copy|cfill|transfer|blob|end),/;

/** Opens a terminal window on the separate desktop, using its gnome-shell's environment. */
function openTerminal() {
  const pid = execFileSync('pgrep', ['-f', '^gnome-shell --headless']).toString().trim().split('\n')[0];
  const shellEnv = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
    .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const keep = ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE'];
  const env = { ...process.env };
  delete env.DISPLAY;
  for (const k of keep) if (shellEnv[k]) env[k] = shellEnv[k];
  execFileSync('gio', ['launch', '/usr/share/applications/org.gnome.Ptyxis.desktop'], { env });
}

function measure(query) {
  return new Promise((resolve) => {
    const url = `${base}/ws/screen?${process.env.SIZE || "width=2400&height=1600&dpi=192"}&source=session&${query}`;
    const ws = new WebSocket(url, 'guacamole', { origin: base.replace(/^ws/, 'http'), perMessageDeflate: true });
    let watch = null; // { t0, first, last, bytes }
    ws.on('message', (data) => {
      const s = data.toString();
      for (const f of s.matchAll(/4\.sync,(\d+)\.(\d+)[,;]/g)) ws.send(`4.sync,${f[1]}.${f[2]};`);
      if (watch && DRAW.test(s)) {
        const t = Date.now() - watch.t0;
        watch.first ??= t;
        // The cursor keeps blinking; only large messages belong to the redraw.
        if (s.length > 4096) watch.last = t;
        watch.bytes += s.length;
        if (process.env.DUMP) fs.appendFileSync(process.env.DUMP, JSON.stringify({ t, s }) + '\n');
        if (process.env.TIMELINE) watch.events.push(`${t}ms ${s.length}B ${[...s.matchAll(/(?:^|;)\d+\.(\w+),/g)].map((m) => m[1]).slice(0, 6).join(' ')}`);
      }
    });
    const down = (k) => ws.send(enc('key', k, 1));
    const up = (k) => ws.send(enc('key', k, 0));
    const press = (...keys) => { keys.forEach(down); [...keys].reverse().forEach(up); };
    const type = async (text) => { for (const ch of text) { press(ch.codePointAt(0)); await sleep(15); } };

    ws.on('open', async () => {
      await sleep(4000);
      openTerminal();
      await sleep(3000);
      press(KS.superL, KS.up); // maximize
      await sleep(1000);
      const runs = [];
      for (let i = 0; i < 5; i++) {
        await type('seq 1 400');
        press(KS.enter);
        await sleep(1500);
        await type('clear');
        watch = { t0: Date.now(), first: null, last: null, bytes: 0, events: [] };
        press(KS.enter);
        await sleep(3000);
        runs.push(watch);
        if (process.env.TIMELINE) console.error(watch.events.join('\n'), '\n---');
        watch = null;
      }
      await type('exit');
      press(KS.enter);
      await sleep(500);
      ws.close();
      const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[2];
      resolve({ query, firstMs: med('first'), lastMs: med('last'), kB: Math.round(med('bytes') / 1024), runs: runs.map((r) => r.last) });
    });
  });
}

for (const q of cases) console.log(JSON.stringify(await measure(q)));
