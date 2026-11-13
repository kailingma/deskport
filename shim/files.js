import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';

// A file stream (docs/protocol.md, kind "file"): the file xdg-open shared
// under a token, as a text message with the status and headers, then the body
// in binary messages, then a close with 1000. One byte range is answered with
// 206, as Safari needs for video.

const CHUNK = 64 * 1024;
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

/** Parses a single "bytes=a-b" range against size; null for none or several, false if unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

export async function serveFileStream(ws, query, headers, opener) {
  const head = (status, h) => ws.send(JSON.stringify({ status, headers: h }));
  const text = (status, msg) => {
    head(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
    ws.send(Buffer.from(msg), { binary: true });
    ws.close(1000);
  };
  const q = new URLSearchParams(query);
  const f = opener.fileFor(q.get('token') || '');
  if (!f) return text(404, 'This link has expired. Run xdg-open again.');
  const st = await fs.promises.stat(f.file).catch(() => null);
  if (!st?.isFile()) return text(404, 'The file is gone.');

  const h = {
    'Cache-Control': 'private, no-store',
    'Content-Type': mime.contentType(path.extname(f.file)) || 'application/octet-stream',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(f.file))}`,
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ...(f.sandbox ? { 'Content-Security-Policy': SANDBOX_CSP } : {}),
  };
  const range = parseRange(headers?.range, st.size);
  if (range === false) {
    head(416, { ...h, 'Content-Range': `bytes */${st.size}` });
    return ws.close(1000);
  }
  const { start, end } = range || { start: 0, end: st.size - 1 };
  head(range ? 206 : 200, {
    ...h,
    'Content-Length': String(Math.max(0, end - start + 1)),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
  });
  if (st.size === 0) return ws.close(1000);
  const stream = fs.createReadStream(f.file, { start, end, highWaterMark: CHUNK });
  ws.on('close', () => stream.destroy());
  stream.on('data', (chunk) => {
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > 4 * CHUNK) {
      stream.pause();
      const wait = setInterval(() => {
        if (ws.readyState !== ws.OPEN) { clearInterval(wait); return; }
        if (ws.bufferedAmount <= CHUNK) { clearInterval(wait); stream.resume(); }
      }, 10);
    }
  });
  stream.on('end', () => { if (ws.readyState === ws.OPEN) ws.close(1000); });
  stream.on('error', () => { if (ws.readyState === ws.OPEN) ws.close(1011, 'read failed'); });
}
