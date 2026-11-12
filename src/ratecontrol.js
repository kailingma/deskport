// Bitrate and frame gating for the video encodings (video.js).
//
// The browser acknowledges each frame once it has decoded it. Cloudflare's
// edge buffers without limit, so the server's own socket cannot show a slow
// link or a slow phone; the time from sending a frame to its acknowledgement
// can. From those times this keeps:
//
//   - the base round trip: the lowest acknowledgement time in the last 10 s;
//   - the delivery rate, from frames that waited behind the one before them:
//     a frame sent more than a base round trip before the previous
//     acknowledgement came back reached the slowest part of the path while the
//     previous frame was still crossing it, so the time between the two
//     acknowledgements is its own crossing time. The highest in the last 3 s;
//   - a smoothed acknowledgement time.
//
// When the smoothed time rises well above the base, frames are queueing
// somewhere on the path, and in Adapt mode the bitrate drops to 85% of the
// delivery rate (or by 5% if it is already lower). While frames arrive on time and the encoder uses most of the
// bitrate it has, the bitrate rises 8% (Responsiveness) or 4% (Data use) each
// step, up to the ceiling for the chosen quality and 95% of the delivery rate.
//
// Independent of the bitrate, the encoder may only encode a new frame while the
// oldest frame not yet acknowledged is younger than the base round trip plus a
// margin, and the bytes in flight would cross the link at the delivery rate
// within that time. Frames captured while it may not are dropped, except the newest,
// which is encoded as soon as the gate opens, so a backlog cannot build up.

const MIN_RTT_WINDOW_MS = 10000;
const RATE_WINDOW_MS = 3000;
const HOLD_AFTER_DROP_MS = 1500;

/**
 * @param {object} opts
 * @param {'auto'|number} opts.bitrate  'auto' adapts; a number is a fixed kbit/s
 * @param {'speed'|'data'} opts.priority
 * @param {number} opts.ceiling  highest kbit/s Adapt may choose
 * @param {number} [opts.floor]
 * @param {number} [opts.start]  first kbit/s in Adapt mode
 */
export function createRateControl({ bitrate, priority, ceiling, floor = 150, start }) {
  const fixed = bitrate !== 'auto';
  const speed = priority !== 'data';
  // Margin over the base round trip before the gate closes.
  const slack = speed ? 80 : 250;
  let kbps = fixed ? Number(bitrate) : Math.min(ceiling, start ?? (speed ? 2500 : 800));
  const inflight = []; // { seq, bytes, at }, oldest first
  let lastAckAt = null;
  const rtts = []; // { at, rtt }
  const rates = []; // { at, rate } in kbit/s
  const sentLog = []; // { at, bytes } for the recent send rate
  let srtt = null;
  let holdUntil = 0;
  let lastStep = 0;

  const minRtt = () => (rtts.length ? Math.min(...rtts.map((r) => r.rtt)) : null);
  const maxRate = () => (rates.length ? Math.max(...rates.map((r) => r.rate)) : null);

  function sentRate(now) {
    while (sentLog.length && sentLog[0].at < now - 1000) sentLog.shift();
    return sentLog.reduce((n, s) => n + s.bytes, 0) * 8 / 1000; // kbit in the last second
  }

  let closedAt = -Infinity;
  function gateOpen(now) {
    if (!inflight.length) return true;
    const base = minRtt() ?? 300;
    const limit = Math.max(base * 1.5, base + slack);
    // Both the oldest frame's age and the time the bytes in flight take at
    // the measured rate must stay within the limit.
    const rate = maxRate();
    const bytes = inflight.reduce((n, f) => n + f.bytes, 0);
    const open = now - inflight[0].at < limit && (!rate || (bytes * 8) / rate < limit);
    if (!open) closedAt = now;
    return open;
  }

  return {
    /** A frame left for the browser. */
    sent(seq, bytes, now) {
      inflight.push({ seq, bytes, at: now });
      sentLog.push({ at: now, bytes });
    },

    /** The browser decoded every frame up to `seq`. */
    acked(seq, now) {
      const base = minRtt();
      let bytes = 0;
      let queued = false;
      while (inflight.length && inflight[0].seq <= seq) {
        const f = inflight.shift();
        bytes += f.bytes;
        if (f.seq !== seq) continue;
        const rtt = now - f.at;
        rtts.push({ at: now, rtt });
        srtt = srtt === null ? rtt : srtt * 0.8 + rtt * 0.2;
        queued = base !== null && lastAckAt !== null && f.at < lastAckAt - base;
      }
      if (!bytes) return;
      // Below 2 ms apart the gap is mostly timer noise.
      if (queued && now - lastAckAt >= 2) rates.push({ at: now, rate: (bytes * 8) / (now - lastAckAt) });
      lastAckAt = now;
      while (rtts.length && rtts[0].at < now - MIN_RTT_WINDOW_MS) rtts.shift();
      while (rates.length && rates[0].at < now - RATE_WINDOW_MS) rates.shift();
    },

    /** Whether the encoder may encode a new frame now. */
    open: gateOpen,

    /** Called every 250 ms or so; returns the bitrate the encoder should use. */
    step(now) {
      if (fixed || now - lastStep < 200) return kbps;
      lastStep = now;
      const base = minRtt();
      if (base === null || srtt === null) return kbps;
      // Frames skipped since the last step also mean the link is full.
      const queueing = srtt > base + Math.max(40, base * 0.3) || closedAt > now - 300 || !gateOpen(now);
      const rate = maxRate();
      if (queueing) {
        if (now >= holdUntil) {
          // Down to below what the link delivered, or a little if already there
          // (a short burst can queue at any bitrate).
          kbps = Math.max(floor, Math.round(rate && rate * 0.85 < kbps ? rate * 0.85 : kbps * 0.95));
          holdUntil = now + HOLD_AFTER_DROP_MS;
        }
      } else if (now >= holdUntil && sentRate(now) >= kbps * 0.5) {
        // Not past what the link was measured to carry.
        const cap = rate ? Math.min(ceiling, rate * 0.95) : ceiling;
        if (kbps < cap) kbps = Math.min(cap, Math.round(kbps * (speed ? 1.08 : 1.04)));
      }
      return kbps;
    },

    /** Numbers for the settings page. */
    stats(now) {
      return {
        kbps,
        sentKbps: Math.round(sentRate(now)),
        rttMs: minRtt() === null ? null : Math.round(minRtt()),
        inflight: inflight.length,
      };
    },
  };
}
