// Measures the Terminal over a simulated slow link, against a test server
// running with its own tmux session (DESKPORT_TMUX_SESSION=<throwaway>).
//
// A TCP proxy between this client and the server delays each direction by
// half of RTT_MS and limits the server-to-browser direction to LINK_KBPS. It
// buffers without limit, as Cloudflare's edge does, so the server cannot see
// the slow link through its own socket.
//
// Reports keystroke echo time at the shell prompt, then floods the terminal
// (seq, or the FLOOD command) and times how long Ctrl+C takes to bring the
// prompt back, and how many
// bytes crossed the link meanwhile.
// Usage: [LINK_KBPS=4000] [RTT_MS=150] [FLOOD="command"] node bench/measure-terminal.mjs [ws://127.0.0.1:7902] [query]
import net from 'node:net';
import WebSocket from 'ws';

const [base = 'ws://127.0.0.1:7902', query = ''] = process.argv.slice(2);
const linkKbps = Number(process.env.LINK_KBPS || 4000);
const rttMs = Number(process.env.RTT_MS || 150);
const target = new URL(base);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- slow link ----------

let downBytes = 0;
function pipe(from, to, kbps) {
  // One FIFO per direction drained by one timer: separate timers per chunk can
  // fire out of order and corrupt the stream.
  const queue = [];
  let busyUntil = 0;
  let timer = null;
  const drain = () => {
    timer = null;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) if (!to.destroyed) to.write(queue.shift().chunk); else queue.shift();
    if (queue.length) timer = setTimeout(drain, queue[0].at - now);
  };
  from.on('data', (chunk) => {
    if (kbps) downBytes += chunk.length;
    const now = Date.now();
    const start = Math.max(now, busyUntil);
    busyUntil = kbps ? start + (chunk.length * 8) / kbps : start;
    queue.push({ chunk, at: busyUntil + rttMs / 2 });
    if (!timer) timer = setTimeout(drain, queue[0].at - now);
  });
  from.on('close', () => setTimeout(() => to.destroy(), rttMs + (queue.at(-1)?.at ?? 0) - Math.min(Date.now(), queue.at(-1)?.at ?? 0)));
}
const proxy = net.createServer((client) => {
  const server = net.connect(Number(target.port), target.hostname);
  pipe(client, server, 0);
  pipe(server, client, linkKbps);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxied = `ws://127.0.0.1:${proxy.address().port}/ws/term${query ? `?${query}` : ''}`;

// ---------- client ----------

const ws = new WebSocket(proxied, { origin: `http://${target.host}`, headers: { host: target.host }, perMessageDeflate: true });
let text = '';
let waiter = null;
const send = (data) => ws.send(JSON.stringify({ type: 'input', data }));
ws.on('message', (data, isBinary) => {
  const s = isBinary ? Buffer.from(data).toString('utf8') : data.toString();
  // Acknowledge as a browser does after drawing (flow control, if offered).
  if (query.includes('flow=1')) ws.send(JSON.stringify({ type: 'ack', chars: s.length }));
  text = (text + s).slice(-4096);
  if (waiter && waiter.test(text)) { const w = waiter; waiter = null; w.resolve(Date.now()); }
});
const waitFor = (re, ms = 30000) => new Promise((resolve) => {
  waiter = { test: (t) => re.test(t), resolve };
  setTimeout(() => { if (waiter?.resolve === resolve) { waiter = null; resolve(null); } }, ms);
});
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
await sleep(1500);

// Echo: type at the prompt and time each character's echo.
const echo = [];
for (let i = 0; i < 15; i++) {
  const ch = 'abcdefghijklmno'[i];
  text = '';
  const t0 = Date.now();
  const got = waitFor(new RegExp(ch), 5000);
  send(ch);
  const t = await got;
  echo.push(t ? t - t0 : null);
  await sleep(100);
}
send('\x15'); // clear the line
await sleep(500);

// Flood, then interrupt.
const before = downBytes;
send(`${process.env.FLOOD || 'seq 1 50000000'}\r`);
await sleep(3000);
const t0 = Date.now();
text = '';
const back = waitFor(/DONE_42/);
send('\x03');
await sleep(50);
send('echo DONE_$((6*7))\r');
const t = await back;
const sorted = echo.filter((x) => x !== null).sort((a, b) => a - b);
console.log(JSON.stringify({
  query: query || '(none)',
  linkKbps,
  rttMs,
  echoMedianMs: sorted[Math.floor(sorted.length / 2)],
  echoMaxMs: sorted.at(-1),
  echoLost: echo.length - sorted.length,
  interruptMs: t ? t - t0 : 'timeout',
  ...(t ? {} : { tail: text.slice(-400) }),
  floodLinkKB: Math.round((downBytes - before) / 1024),
}));
ws.close();
proxy.close();
setTimeout(() => process.exit(0), 300);
