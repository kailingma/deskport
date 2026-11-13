// Measures screen bandwidth and frame rate for picture settings against a running
// dev server (npm run dev). Opens one read-only session per case and sends no input.
// Usage: node bench/measure-screen.mjs [seconds] [ws://host:port] [query ...]
//   each query is extra URL parameters, e.g. "res=0.5&quality=low"
import WebSocket from 'ws';

const [seconds = '15', base = 'ws://127.0.0.1:7900', ...queries] = process.argv.slice(2);
const cases = queries.length ? queries : [
  'res=1&quality=high', 'res=1&quality=lossless', 'res=1&quality=low',
  'res=0.5&quality=high', 'res=0.5&quality=low', 'res=0.5&quality=low&priority=data',
];

function measure(query) {
  return new Promise((resolve) => {
    const url = `${base}/ws/screen?width=1280&height=720&dpi=96&${query}`;
    const ws = new WebSocket(url, 'guacamole', { origin: base.replace(/^ws/, 'http'), perMessageDeflate: true });
    let payload = 0;
    let frames = 0;
    let start = 0;
    let size = '';
    ws.on('message', (data) => {
      const s = data.toString();
      const m = /4\.size,1\.0,\d+\.(\d+),\d+\.(\d+);/.exec(s);
      if (m && !start) { start = Date.now(); size = `${m[1]}x${m[2]}`; }
      if (start) payload += s.length;
      // Acknowledge frames as the browser does, so guacd keeps sending.
      for (const f of s.matchAll(/4\.sync,(\d+)\.(\d+)[,;]/g)) {
        frames++;
        ws.send(`4.sync,${f[1]}.${f[2]};`);
      }
    });
    setTimeout(() => {
      const wire = ws._socket?.bytesRead ?? 0;
      ws.close();
      const secs = start ? (Date.now() - start) / 1000 : Number(seconds);
      resolve({ query, size, fps: +(frames / secs).toFixed(1), payloadKBps: Math.round(payload / 1024 / secs), wireKBps: Math.round(wire / 1024 / secs) });
    }, Number(seconds) * 1000 + 3000);
  });
}

for (const q of cases) {
  console.log(JSON.stringify(await measure(q)));
  await new Promise((r) => setTimeout(r, 4000));
}
