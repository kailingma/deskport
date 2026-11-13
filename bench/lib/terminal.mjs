// One terminal measurement through a simulated link, against a server with
// its own tmux session. Times the echo of 15 characters typed at the prompt,
// then floods the terminal with `seq` and times how long Ctrl+C takes to
// bring the prompt back, and the bytes that crossed the link meanwhile.
// Acknowledges output on arrival, as the page does after drawing (flow=1).
import WebSocket from 'ws';
import { summary } from './screen.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function measureTerminal({ base, host, link }) {
  const ws = new WebSocket(`${base}/ws/term?flow=1`, { origin: `http://${host}`, headers: { host }, perMessageDeflate: true });
  let text = '';
  let waiter = null;
  const send = (data) => ws.send(JSON.stringify({ type: 'input', data }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // ping answers
    const s = data.toString();
    ws.send(JSON.stringify({ type: 'ack', chars: s.length }));
    text = (text + s).slice(-4096);
    if (waiter?.re.test(text)) { const w = waiter; waiter = null; w.resolve(performance.now()); }
  });
  const waitFor = (re, ms) => new Promise((resolve) => {
    const w = { re, resolve };
    waiter = w;
    setTimeout(() => { if (waiter === w) { waiter = null; resolve(null); } }, ms);
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await sleep(2000);

  const echo = [];
  for (const ch of 'abcdefghijklmno') {
    text = '';
    const t0 = performance.now();
    const got = waitFor(new RegExp(ch), 5000);
    send(ch);
    const t = await got;
    echo.push(t ? t - t0 : null);
    await sleep(100);
  }
  send('\x15');
  await sleep(1000);

  const before = link.bytes.down;
  send('seq 1 50000000\r');
  await sleep(3000);
  text = '';
  const t0 = performance.now();
  const back = waitFor(/DONE_42/, 60000);
  send('\x03');
  await sleep(50);
  send('echo DONE_$((6*7))\r');
  const t = await back;
  const floodKB = Math.round((link.bytes.down - before) / 1024);
  ws.close();
  await sleep(300);
  return { echo: summary(echo), interruptMs: t ? Math.round(t - t0) : null, floodKB };
}
