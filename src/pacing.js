// Frame acknowledgements between guacd and the browser.
//
// guacd ends each frame with "sync" and paces itself on the browser's reply:
// a reply that comes back later than usual is taken as the client falling
// behind, and guacd holds the next frames back by that much. Over a slow link a
// large frame (a cleared or scrolled window) takes long to arrive, so its reply
// is late and the picture stops for about as long again.
//
// The bridge therefore acknowledges a frame itself once it has handed the frame
// to the browser's socket, up to `max` frames ahead of the browser's own
// replies, and only while little is waiting in the socket. When the browser
// falls further behind, its own replies are passed on and guacd paces on them
// as before, so the delay that can build up is bounded.

/**
 * @param {object} opts
 * @param {(timestamp: string) => void} opts.ack  sends a sync reply to guacd
 * @param {number} [opts.max]  frames acknowledged ahead of the browser
 * @param {number} [opts.maxBuffered]  bytes waiting in the socket above which the bridge stops acknowledging
 */
export function createAckAhead({ ack, max = 2, maxBuffered = 256 * 1024 }) {
  const ahead = []; // timestamps acknowledged for the browser, not yet confirmed by it
  let newest = -Infinity; // newest timestamp guacd has been told about

  return {
    /** A frame ending at `timestamp` was handed to the browser's socket. */
    sent(timestamp, buffered) {
      const t = Number(timestamp);
      if (!(t > newest) || ahead.length >= max || buffered > maxBuffered) return;
      ahead.push(t);
      newest = t;
      ack(timestamp);
    },

    /** The browser acknowledged `timestamp`. Returns whether to pass it on to guacd. */
    fromBrowser(timestamp) {
      const t = Number(timestamp);
      while (ahead.length && ahead[0] <= t) ahead.shift();
      if (!(t > newest)) return false;
      newest = t;
      return true;
    },

    /** Frames acknowledged ahead of the browser (for tests). */
    get pending() { return ahead.length; },
  };
}

/** Timestamp of the last "sync" instruction in a batch of instruction text, or null. */
export function lastSyncTimestamp(text) {
  const i = text.lastIndexOf('4.sync,');
  if (i === -1 || (i > 0 && text[i - 1] !== ';')) return null;
  const m = /^4\.sync,\d+\.(\d+)/.exec(text.slice(i, i + 40));
  return m ? m[1] : null;
}
