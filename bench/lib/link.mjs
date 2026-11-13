// A simulated network link: a TCP proxy that delays each direction by half
// the round trip and limits each direction to a rate. It buffers without
// limit, as Cloudflare's edge does, so the server cannot see a slow link
// through its own socket. Counts the bytes that cross in each direction.
import net from 'node:net';

/** Link profiles the bench runs at. kbps 0 means no rate limit. */
export const LINKS = {
  loopback: { kbps: 0, rttMs: 0 },
  '4m': { kbps: 4000, rttMs: 150 },
  '1m': { kbps: 1000, rttMs: 400 },
};

/**
 * Starts a proxy to `target` (host:port). Returns { port, bytes, rttMs, queued, close }.
 * bytes.down counts server-to-client bytes, bytes.up client-to-server.
 */
export async function startLink(target, { kbps, rttMs }) {
  const [host, port] = [target.split(':')[0], Number(target.split(':')[1])];
  const bytes = { down: 0, up: 0 };
  const sockets = new Set();
  // One rate limit per direction, shared by every connection, as on a real link.
  const busy = { down: 0, up: 0 };
  // Bytes accepted from the server and not yet delivered to the client.
  let queuedDown = 0;

  function pipe(from, to, dir) {
    // One FIFO per direction drained by one timer: separate timers per chunk
    // can fire out of order and corrupt the stream.
    const queue = [];
    let timer = null;
    const drain = () => {
      timer = null;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) {
        const { chunk } = queue.shift();
        if (dir === 'down') queuedDown -= chunk.length;
        if (!to.destroyed) to.write(chunk);
      }
      if (queue.length) timer = setTimeout(drain, queue[0].at - now);
    };
    from.on('data', (chunk) => {
      bytes[dir] += chunk.length;
      if (dir === 'down') queuedDown += chunk.length;
      const now = performance.now();
      const start = Math.max(now, busy[dir]);
      busy[dir] = kbps ? start + (chunk.length * 8) / kbps : start;
      queue.push({ chunk, at: busy[dir] + rttMs / 2 });
      if (!timer) timer = setTimeout(drain, Math.max(0, queue[0].at - now));
    });
    from.on('close', () => {
      const last = queue.at(-1)?.at ?? 0;
      setTimeout(() => to.destroy(), Math.max(0, last - performance.now()) + 5);
    });
    from.on('error', () => {});
  }

  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    sockets.add(client).add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    pipe(client, upstream, 'up');
    pipe(upstream, client, 'down');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    bytes,
    rttMs,
    /** Bytes from the server still on their way to the client. */
    queued: () => queuedDown,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
