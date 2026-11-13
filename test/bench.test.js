import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startLink } from '../bench/lib/link.mjs';
import { rows, compare } from '../bench/lib/report.mjs';
import { summary } from '../bench/lib/screen.mjs';

async function echoServer() {
  const server = net.createServer((s) => s.pipe(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('link delays by the round trip, keeps order and limits the rate', async () => {
  const server = await echoServer();
  const link = await startLink(`127.0.0.1:${server.address().port}`, { kbps: 800, rttMs: 100 });
  const client = net.connect(link.port, '127.0.0.1');
  await new Promise((r) => client.on('connect', r));
  const chunks = Array.from({ length: 20 }, (_, i) => Buffer.alloc(500, i));
  const expected = Buffer.concat(chunks);
  let got = Buffer.alloc(0);
  const t0 = performance.now();
  const done = new Promise((r) => client.on('data', (d) => {
    got = Buffer.concat([got, d]);
    if (got.length >= expected.length) r(performance.now() - t0);
  }));
  for (const c of chunks) client.write(c);
  const ms = await done;
  assert.deepEqual(got, expected);
  // 10,000 bytes at 800 kbit/s take 100 ms each way, plus the 100 ms round trip.
  assert.ok(ms >= 280, `took ${ms} ms`);
  assert.ok(ms < 600, `took ${ms} ms`);
  assert.equal(link.bytes.up, 10000);
  assert.equal(link.bytes.down, 10000);
  client.destroy();
  link.close();
  server.close();
});

test('summary and report take medians and count misses', () => {
  assert.deepEqual(summary([30, null, 10, 20]), { n: 4, missed: 1, median: 20, p90: 30, max: 30 });
  const out = (k) => ({ results: [
    { link: 'loopback', encoding: 'av1', keyToPixel: { median: k, missed: 0 } },
    { link: 'loopback', encoding: 'av1', keyToPixel: { median: k + 10, missed: 0 } },
    { link: 'loopback', encoding: 'av1', keyToPixel: { median: k + 20, missed: 0 } },
  ] });
  assert.equal(rows(out(30))['loopback av1']['key ms'], 40);
  assert.match(compare(out(30), out(10)), /40 → 20/);
});
