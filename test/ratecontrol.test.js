import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateControl } from '../shim/ratecontrol.js';

/**
 * Simulates a link of `linkKbps` with round trip `rttMs`: frames are produced
 * every 33 ms at the controller's bitrate while its gate is open, cross the
 * link one after another, and are acknowledged half a round trip after they
 * arrive. Returns the bitrates chosen and how late each acknowledgement was.
 */
function simulate({ linkKbps, rttMs, seconds = 20, ...opts }) {
  const rc = createRateControl({ ceiling: 20000, ...opts });
  let linkFreeAt = 0;
  let seq = 0;
  let pending = [];
  const kbpsLog = [];
  const delays = [];
  for (let t = 0; t < seconds * 1000; t++) {
    pending = pending.filter((a) => {
      if (a.at > t) return true;
      rc.acked(a.seq, t);
      delays.push({ t, delay: t - a.sent });
      return false;
    });
    if (t % 250 === 0) kbpsLog.push({ t, kbps: rc.step(t) });
    if (t % 33 === 0 && rc.open(t)) {
      const bytes = Math.round((rc.stats(t).kbps * 1000) / 8 / 30);
      seq++;
      rc.sent(seq, bytes, t);
      const start = Math.max(t + rttMs / 2, linkFreeAt);
      linkFreeAt = start + (bytes * 8) / linkKbps;
      pending.push({ seq, sent: t, at: linkFreeAt + rttMs / 2 });
    }
  }
  return { kbpsLog, delays };
}

const late = (delays, from) => Math.max(...delays.filter((d) => d.t >= from).map((d) => d.delay));
const final = (log) => log.at(-1).kbps;

test('Adapt settles below a slow link and keeps frames from queueing', () => {
  const { kbpsLog, delays } = simulate({ linkKbps: 2000, rttMs: 150, bitrate: 'auto', priority: 'speed', start: 6000 });
  const kbps = final(kbpsLog);
  assert.ok(kbps < 2000 && kbps > 800, `settled at ${kbps} kbit/s on a 2000 kbit/s link`);
  assert.ok(late(delays, 10000) < 150 + 250, `acknowledgements up to ${late(delays, 10000)} ms late`);
});

test('Adapt climbs on a fast link', () => {
  const { kbpsLog } = simulate({ linkKbps: 50000, rttMs: 30, bitrate: 'auto', priority: 'speed', start: 1000 });
  assert.ok(final(kbpsLog) > 8000, `reached ${final(kbpsLog)} kbit/s`);
});

test('Data use climbs more slowly and stays at or under the ceiling', () => {
  const speed = simulate({ linkKbps: 50000, rttMs: 30, bitrate: 'auto', priority: 'speed', start: 1000, seconds: 5 });
  const data = simulate({ linkKbps: 50000, rttMs: 30, bitrate: 'auto', priority: 'data', start: 1000, seconds: 5, ceiling: 3000 });
  assert.ok(final(data.kbpsLog) <= 3000);
  assert.ok(final(data.kbpsLog) < final(speed.kbpsLog));
});

test('a fixed bitrate does not change, but the gate still bounds the delay', () => {
  const { kbpsLog, delays } = simulate({ linkKbps: 1000, rttMs: 100, bitrate: 4000, priority: 'speed' });
  assert.ok(kbpsLog.every((k) => k.kbps === 4000));
  // A 4000 kbit/s frame takes 133 ms on this link. Frames are skipped rather
  // than queued, so the delay stays bounded: the round trip with one frame
  // (233 ms), plus the gate's limit (350 ms), plus one more frame.
  assert.ok(late(delays, 5000) < 233 + 350 + 133 + 50, `acknowledgements up to ${late(delays, 5000)} ms late`);
});

test('the gate stays open with nothing in flight', () => {
  const rc = createRateControl({ bitrate: 'auto', priority: 'speed', ceiling: 8000 });
  assert.equal(rc.open(0), true);
  rc.sent(1, 1000, 0);
  assert.equal(rc.open(100), true);
  assert.equal(rc.open(1000), false);
  rc.acked(1, 1000);
  assert.equal(rc.open(1000), true);
});

test('an idle desktop between frames does not lower the bitrate', () => {
  const rc = createRateControl({ bitrate: 'auto', priority: 'speed', ceiling: 8000, start: 3000 });
  // One small frame a second on a fast, short link.
  for (let i = 1; i <= 20; i++) {
    const t = i * 1000;
    assert.equal(rc.open(t), true);
    rc.sent(i, 5000, t);
    rc.acked(i, t + 3);
    rc.step(t + 250);
  }
  assert.ok(rc.stats(21000).kbps >= 3000, `fell to ${rc.stats(21000).kbps} kbit/s`);
});
