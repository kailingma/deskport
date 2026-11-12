# How deskport works

```
browser ──https──▶ Cloudflare Access ──tunnel──▶ cloudflared ──▶ deskport :7900 (loopback)
                                                                   ├─ /ws/screen ─▶ guacd :4822 ─RDP─▶ gnome-remote-desktop :3390
                                                                   └─ /ws/term   ─▶ node-pty ─▶ tmux "web"
```

One Node process (`src/server.js`) serves the page, the vendored browser libraries, and two WebSocket endpoints. Nothing listens on a public interface: cloudflared makes an outbound connection to Cloudflare and forwards requests for the hostname to 127.0.0.1:7900.

## Source layout

| File | What it does |
| --- | --- |
| `src/config.js` | Loads `deskport.env` and `rdp.env` from `~/.config/deskport` (or `DESKPORT_CONFIG_DIR`), builds the config object, and validates it. Variables already in the environment win over the files. |
| `src/auth.js` | Verifies the Cloudflare Access JWT, and checks WebSocket `Origin`. |
| `src/server.js` | Express app, security headers, `/api/me`, `/vendor/*` routes, the page and its assets under `/v/<content hash>/` (so browsers never mix old and new files), and the WebSocket upgrade router. |
| `src/guac.js` | Guacamole protocol encoder and parser, and the bridge between a browser WebSocket and a guacd TCP connection. |
| `src/scaler.js` | Shrinks and re-encodes the screen stream for the Resolution and Quality settings. |
| `src/session.js` | Starts, checks and stops the separate desktop's systemd unit, and sets its monitor scale. |
| `src/terminal.js` | Attaches a WebSocket to tmux through a pseudo-terminal. |
| `public/app.js` | Entry point: views, full screen and the floating toolbar, settings dialog, key row, viewport handling. |
| `public/js/screen.js` | Screen view: Guacamole client, scaling and zoom, touch gestures, soft keyboard. |
| `public/js/terminal.js` | Terminal view: xterm.js, reconnects, touch scrolling and selection, appearance settings. |
| `public/js/settings.js`, `themes.js`, `keys.js`, `gestures.js` | Per-device settings store, terminal colour schemes and fonts, key codes and sticky modifiers, scroll momentum. |
| `public/` (rest) | `index.html`, `style.css`, `theme-init.js` (applies a saved light/dark choice before first paint), icons, manifest. No build step. |
| `scripts/` | `setup-rdp.sh`, `install-services.sh`, `desktop-session.sh` (the separate desktop), `session-scale.py` (sets its monitor scale), `make-icons.mjs`, `measure-screen.mjs`, `measure-typing.mjs`. |
| `deploy/` | guacd compose file and the cloudflared config example. |
| `test/` | `node --test` tests for the protocol parser and the scaler. |

## Authentication

Every HTTP request and every WebSocket upgrade passes through `createAuthenticator()`:

1. The token comes from the `Cf-Access-Jwt-Assertion` header that Access adds, or the `CF_Authorization` cookie.
2. `jose` verifies its signature against the team's JWKS at `https://<team>/cdn-cgi/access/certs` (fetched and cached), and checks that the issuer is `https://<team>` and that the audience is the application's AUD tag.
3. If `DESKPORT_ALLOWED_EMAILS` is set, the token's `email` claim must be in it.

A request that fails gets a 403 and a log line saying why. This check matters even behind Access: it stops anything else on the machine, or a misrouted tunnel, from reaching the screen without a token Cloudflare signed for this application.

WebSocket upgrades also need an `Origin` whose host equals the `Host` header, so a page on another site cannot open the sockets with the user's cookie.

`DESKPORT_INSECURE_DEV=1` (set by `npm run dev`) skips the token check and labels the session as dev. The server refuses to start on a non-loopback address in any mode.

Responses carry `Content-Security-Policy: default-src 'self'` (plus `'unsafe-inline'` styles, which xterm.js needs), `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.

## Screen

The browser runs `guacamole-common-js`. Its `WebSocketTunnel` connects to `/ws/screen` with the `guacamole` subprotocol, passing the display size, DPI and timezone in the query string.

`handleScreen()` opens a TCP connection to guacd and runs the handshake itself:

1. Sends `select rdp`.
2. On guacd's `args` reply, answers each requested argument from the config: host, port, username, password, `security=any`, `ignore-cert=true`, `disable-audio=true`, 24-bit colour, the desktop-experience options (wallpaper, theming, font smoothing, full-window drag, composition), and the quality preset below.
3. Sends `size`, `audio`, `video`, `image`, `timezone`, then `connect`, echoing guacd's protocol version.
4. Sends the browser the tunnel's UUID instruction (`0.,36.<uuid>;`), which `WebSocketTunnel` expects first.

From then on it forwards complete instructions both ways. Guacamole element lengths count Unicode code points, so `GuacParser` handles surrogate pairs and instructions split across TCP chunks; `WebSocketTunnel` requires whole instructions per frame. Internal `ping` instructions from the browser are answered directly, other internal instructions are dropped.

The browser passes three picture settings in the query string: `res` (`auto`, `1`, `0.75`, `0.5`, `0.33`), `quality` (`low`, `medium`, `high`, `lossless`) and `priority` (`speed`, `data`).

- `quality=lossless` sets guacd's `force-lossless`.
- `priority=data` caps the frame rate at 10 fps. guacd sends the next frame only after the browser acknowledges the previous one with a `sync` instruction, so the bridge holds acknowledgements back until 100 ms have passed since the last one it forwarded. While one is held, newer ones replace it, and only the newest is sent: it covers every earlier frame. (Queueing each held acknowledgement 100 ms behind the previous one built up seconds of delay during bursts such as typing.)
- When `res` is below 1, or quality is `low` or `medium`, the bridge passes guacd's output through `src/scaler.js`:
  - Every coordinate in drawing instructions (`size`, `rect`, `copy`, `transfer`, `cursor`, `mouse`, `move`, path instructions) is multiplied by the scale. Spans are mapped edge by edge, so adjacent rectangles stay adjacent after rounding.
  - Each image stream (`img`, `blob`, `end`) is collected, resized with sharp (libvips), re-encoded (JPEG; WebP when the image has alpha; PNG for lossless), and emitted where the original `end` was. Output stays in order because a queue waits on each image before sending what follows it.
  - Mouse instructions from the browser are divided by the scale on the way back.
  - For `auto`, the scale is chosen when guacd reports the desktop size: the largest picture that fits the browser's device pixels (twice that on touch screens, for pinch-zoom headroom). Output is held until then.
  - Moved regions (`copy`) are rounded to whole pixels at the smaller size, so a scrolled area can sit up to half a pixel off until it is redrawn.

`source` picks what the Screen view shows:

- `mirror` (default): GNOME desktop sharing in `mirror-primary` mode, the physical monitor.
- `virtual`: switches desktop sharing to extend mode through `gsettings` before connecting and sets `resize-method=display-update`. GNOME adds a virtual monitor next to the physical one, and `size` instructions the browser sends when its window changes resize it. guacd gets `dpi=96`, so the monitor is made at the browser's CSS-pixel size; GNOME's scale on the main desktop is never changed. `screen-share-mode` is global, so mirror sessions switch it back to `mirror-primary`.
- `session`: connects to the separate desktop on port 3391, starting `deskport-session.service` first if the port is closed.

The scaler never shrinks `virtual` or `session` pictures; they are already the browser's size.

### The separate desktop

`scripts/desktop-session.sh` runs a second GNOME Shell for the same user with `gnome-shell --headless` (no physical outputs, so it cannot touch the monitors) and `gnome-remote-desktop-daemon --headless` on port 3391. Each RDP client gets its own virtual monitor, sized to the client and resized with it.

Two GNOME Shells for one user would collide on the session bus and in the runtime directory, so the script gives this one:

- a private D-Bus session bus at `$XDG_RUNTIME_DIR/deskport-session/bus`, whose service directory lists every session service except file indexing (Tracker/LocalSearch) and `systemd1`;
- a private runtime directory, `$XDG_RUNTIME_DIR/deskport-session`, for its Wayland socket, accessibility bus, portals, dconf notifications and gvfs mounts. (Without it, the second session's accessibility bus replaced the main one's socket.) PipeWire, PulseAudio and the keyring point back at the main session's sockets.

Files, settings (dconf) and the keyring are shared with the main desktop.

GNOME creates each client's monitor at scale 1, which is tiny on a phone. `sessionLayout()` in `src/guac.js` picks the largest whole scale up to the device's pixel ratio that GNOME allows (it needs at least 800 × 480 logical pixels) and rounds the size so the logical size is whole. With a scale of 2 or more, guacd gets the browser's real DPI (full device pixels), and once guacd reports the new desktop size, `scripts/session-scale.py` sets that monitor's scale through `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig` on the private bus (temporary method, nothing written to `monitors.xml`). Resizes from the browser are rounded the same way. Otherwise guacd gets `dpi=96` and makes the desktop at CSS-pixel size.

`GET /api/session` reports the unit's state and memory; `POST /api/session/stop` (same-origin only) stops it.

Audio is not requested. The screen WebSocket uses permessage-deflate at zlib level 1: the images travel as base64, and compression wins back most of that overhead. The credentials never reach the browser.

GNOME's mirror mode always streams the monitor at its native size. An earlier version switched the physical monitor to a lower mode during sessions; on a monitor connected to two GPUs that left one output unable to draw until the user logged out, so that code was removed.

## Terminal

`handleTerminal()` spawns `tmux new-session -A -s web -c ~` in a pseudo-terminal: it attaches to the session if it exists and creates it otherwise. The child environment has every `RDP_*`, `CF_ACCESS_*`, `DESKPORT_*` and `GUACD_*` variable removed so secrets do not leak into the shell.

Messages from the browser are JSON, `{"type":"input","data":"..."}` or `{"type":"resize","cols":N,"rows":N}` (clamped). Output goes back as text frames. Closing the socket kills the tmux client only; the session and its programs keep running, and the browser reconnects with exponential backoff (0.5 s up to 10 s).

## Processes on the host

| Process | Managed by | Listens on |
| --- | --- | --- |
| deskport | `deskport.service` (systemd user) | 127.0.0.1:7900 |
| cloudflared | `deskport-tunnel.service` (systemd user) | outbound only |
| guacd | Docker, `restart: unless-stopped` | 127.0.0.1:4822 |
| gnome-remote-desktop | `gnome-remote-desktop.service` (systemd user) | *:3390 |
| separate desktop (gnome-shell and gnome-remote-desktop, headless) | `deskport-session.service` (systemd user, started on demand) | *:3391 |
| tmux server | started on first terminal connection | Unix socket |
