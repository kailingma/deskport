// Measures screen bandwidth for each quality preset against a running dev server
// (npm run dev). Opens one read-only session per preset; sends no input.
// Usage: node scripts/measure-screen.mjs [seconds] [url]
import WebSocket from 'ws';

const seconds = Number(process.argv[2] || 15);
const base = process.argv[3] || 'ws://127.0.0.1:7900';

function measure(quality) {
  return new Promise((resolve) => {
    const url = `${base}/ws/screen?width=1280&height=720&dpi=96&quality=${quality}`;
    const ws = new WebSocket(url, 'guacamole', { origin: base.replace(/^ws/, 'http'), perMessageDeflate: true });
    let payload = 0;
    let frames = 0;
    let start = 0;
    ws.on('message', (data) => {
      const s = data.toString();
      if (!start && s.includes('4.size,1.0,')) start = Date.now();
      if (start) payload += s.length;
      // Acknowledge frames, as the browser does, so guacd keeps sending.
      for (const m of s.matchAll(/4\.sync,(\d+)\.(\d+)[,;]/g)) {
        frames++;
        ws.send(`4.sync,${m[1]}.${m[2]};`);
      }
    });
    setTimeout(() => {
      const wire = ws._socket?.bytesRead ?? 0;
      ws.close();
      const secs = start ? (Date.now() - start) / 1000 : seconds;
      resolve({ quality, frames, fps: +(frames / secs).toFixed(1), payloadKBps: Math.round(payload / 1024 / secs), wireKBps: Math.round(wire / 1024 / secs) });
    }, seconds * 1000 + 3000);
  });
}

for (const q of ['fast', 'balanced', 'best']) {
  console.log(JSON.stringify(await measure(q)));
  await new Promise((r) => setTimeout(r, 4000));
}
