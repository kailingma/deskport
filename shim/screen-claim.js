// One screen viewer per source at a time. GNOME's RDP server takes one session
// per port and refuses a new one ("Session creation inhibited") while the old
// one is still closing, so two viewers that connect together fight: each
// connection drops the other and both show as failed. The newer viewer takes
// over: the older tunnel is closed as a normal close (status 0), which the page
// shows as ended without reconnecting, so two pages cannot keep replacing each
// other.

export const RELEASE_WAIT_MS = 1000;
const RELEASE_TIMEOUT_MS = 3000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes `ws` the current viewer for `source` and returns a promise that
 * resolves once it may open its RDP connection.
 * `claims` is a Map from source to { ws, released }.
 */
export function claimScreen(claims, source, ws, { wait = RELEASE_WAIT_MS, timeout = RELEASE_TIMEOUT_MS } = {}) {
  const previous = claims.get(source);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  claims.set(source, { ws, released });
  ws.on('close', release);

  if (!previous) return Promise.resolve();
  if (ws !== previous.ws && previous.ws.readyState === previous.ws.OPEN) {
    previous.ws.close(1000, '0');
  }
  return Promise.race([previous.released, delay(timeout)]).then(() => delay(wait));
}
