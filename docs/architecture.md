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
| `src/server.js` | Starts one host: authentication, security headers, and wiring of the API, the UI and the WebSocket upgrade router (by host and endpoint). |
| `src/api.js` | The JSON API of one host: `/api/me`, `/api/host`, `/api/hosts`, `/api/session`, `/api/session/stop`. |
| `src/ui.js` | The page, and every file it loads (its own and the vendored libraries) from memory under `/v/<content hash>/`, precompressed. Not mounted when `DESKPORT_UI=0`. |
| `src/hosts.js` | This host's identity, the list of other hosts, and `/h/<id>/` path routing (multi-host groundwork, see [multi-host.md](multi-host.md)). |
| `src/guac.js` | Guacamole protocol encoder and parser, and the bridge between a browser WebSocket and a guacd TCP connection. |
| `src/scaler.js` | Shrinks and re-encodes the screen stream for the Resolution and Quality settings. |
| `src/session.js` | Starts, checks and stops the separate desktop's systemd unit, and sets its monitor scale. |
| `src/monitors.js` | Lists the physical monitors, and for My monitor changes the monitor's mode to fit the viewer and the primary monitor while connected, then puts the configuration back. |
| `src/pacing.js` | Acknowledges frames to guacd ahead of the browser at Responsiveness. |
| `src/video.js`, `scripts/video-encoder.py` | The AV1 and H.264 encodings: records the monitor through Mutter's ScreenCast API, encodes it, and serves it on `/ws/video`. |
| `src/ratecontrol.js` | Bitrate and frame gating for the video encodings, from the browser's frame acknowledgements. |
| `src/terminal.js` | Attaches a WebSocket to tmux through a pseudo-terminal, with output batching and flow control, and sets PATH and BROWSER for the session. |
| `public/app.js` | Entry point: views, full screen and the floating toolbar, settings dialog, key row, viewport handling. |
| `public/js/screen.js` | Screen view: Guacamole client, scaling and zoom, touch gestures, soft keyboard. |
| `public/js/video.js` | Decodes the video encodings with WebCodecs into Guacamole's default layer. |
| `src/opener.js`, `bin/xdg-open` | Opens links and files from the terminal in the browser using it. |
| `public/js/terminal.js` | Terminal view: xterm.js, reconnects, touch scrolling, selection and tmux's menu, copy and paste, appearance settings. |
| `public/js/host.js` | The host a view talks to: builds every API and WebSocket URL, with an `/h/<id>` prefix for other hosts later. |
| `public/js/dialog.js` | The confirmation dialog. |
| `public/js/settings.js`, `themes.js`, `keys.js`, `gestures.js` | Per-device settings store, terminal colour schemes and fonts, key codes and sticky modifiers, scroll momentum. |
| `public/` (rest) | `index.html`, `style.css`, `theme-init.js` (applies a saved light/dark choice before first paint), icons, manifest. No build step. |
| `scripts/` | `setup-rdp.sh`, `install-services.sh`, `desktop-session.sh` (the separate desktop), `session-scale.py` (sets its monitor scale), `session-systemd-proxy.py` (systemd on its private bus), `monitor-config.py` (reads and applies Mutter's monitor configuration), `make-icons.mjs`. |
| `bench/` | Measurement: `measure-screen.mjs`, `measure-typing.mjs` (`LINK_KBPS` simulates a slow link), `measure-clear.mjs`, `measure-terminal.mjs` (Terminal echo and Ctrl+C during a flood, over a simulated slow link). |
| `deploy/` | guacd compose file and the cloudflared config example. |
| `test/` | `node --test` tests for the protocol parser, the scaler, the separate desktop's size and scale, the host registry and the page's asset serving. |

## Hosts and paths

Every endpoint can be addressed two ways: directly (`/api/host`, `/ws/screen`) or by host id (`/h/<id>/api/host`, `/h/<id>/ws/screen`). The id `local` and this host's own id (`DESKPORT_HOST_ID`, default the hostname as a slug) both mean this host. Ids listed in `hosts.json` get 501 Not Implemented, and other ids 404. This is the groundwork for one UI controlling several machines; [multi-host.md](multi-host.md) has the design.

## Page loading

`src/ui.js` reads every file under `public/` and the vendored libraries into memory at start, hashes them together, and serves them under `/v/<hash>/` with `Cache-Control: immutable` for a year, as brotli or gzip when the browser accepts it (compressed in the background about a second after start). Absolute `/vendor/` references in scripts, styles and the page are rewritten to the versioned path. The page (`/`) is `no-cache` and lists every script as a `modulepreload`, so a load is the page's round trip plus one for all files at once, and a repeat load only revalidates the page. A file asked for under an older hash is served from the current set, uncached. The dev server rebuilds the set on every request and caches nothing.

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
- `priority=speed` acknowledges each frame to guacd as soon as it is handed to the browser's socket, up to two frames ahead of the browser and while under 256 KB is waiting there (`src/pacing.js`). guacd holds frames back when an acknowledgement comes back later than usual, which a large frame on a slow link causes. The browser's own acknowledgements for frames already acknowledged are dropped.
- `priority=data` caps the frame rate at 10 fps. guacd sends the next frame only after the browser acknowledges the previous one with a `sync` instruction, so the bridge holds acknowledgements back until 100 ms have passed since the last one it forwarded. While one is held, newer ones replace it, and only the newest is sent: it covers every earlier frame. (Queueing each held acknowledgement 100 ms behind the previous one built up seconds of delay during bursts such as typing.)
- Every stream passes through `src/scaler.js` (unless `DESKPORT_LOSSLESS_WEBP=0` and nothing below needs it). At full size with quality `high` or `lossless`, it only re-encodes guacd's PNGs as lossless WebP (the same pixels, about a quarter smaller; effort 1 up to 65,536 pixels, effort 0 above) and passes guacd's lossy images through. An image that comes out larger is sent as it was. When `res` is below 1, or quality is `low` or `medium`:
  - Every coordinate in drawing instructions (`size`, `rect`, `copy`, `transfer`, `cursor`, `mouse`, `move`, path instructions) is multiplied by the scale. Spans are mapped edge by edge, so adjacent rectangles stay adjacent after rounding.
  - Each image stream (`img`, `blob`, `end`) is collected, resized with sharp (libvips), re-encoded (WebP at quality 35, 60 or 82; lossless WebP for lossless), and emitted where the original `end` was. Output stays in order because a queue waits on each image before sending what follows it.
  - Mouse instructions from the browser are divided by the scale on the way back.
  - For `auto`, the scale is chosen when guacd reports the desktop size: the largest picture that fits the browser's device pixels (twice that on touch screens, for pinch-zoom headroom). Output is held until then.
  - Moved regions (`copy`) are rounded to whole pixels at the smaller size, so a scrolled area can sit up to half a pixel off until it is redrawn.

### Video encodings

With `encoding=av1` or `encoding=h264` (Settings, Send as), the picture comes from a video stream and guacd's own drawing is not used:

1. The bridge drops every drawing instruction from guacd that targets a visible layer (layer 0 and above), and the image streams for them (`createDrawFilter()` in `src/video.js`). Layer sizes, off-screen buffers and the pointer (`cursor`, which draws from a buffer) pass through, so the browser's display keeps its size, pointer and input handling. The browser's frame acknowledgements are dropped too; the bridge acknowledges guacd's frames itself at most every 250 ms, which keeps guacd from encoding images nobody sees more often than that.
2. When guacd reports the desktop's size (after the scaler, so at the size the browser receives), `createVideoSource()` starts `scripts/video-encoder.py` with the bus of the desktop shown (the main session bus, or the separate desktop's private bus) and the monitor: the primary monitor or the one chosen for My monitor; for an extra monitor or the separate desktop, Mutter's virtual monitor of the size guacd reported.
3. The script asks `org.gnome.Mutter.ScreenCast` to record that monitor (`RecordMonitor`, pointer left out) and gets a PipeWire node. GStreamer scales and converts its frames, and encodes them: `av1enc` (libaom) with the realtime profile, no lookahead and CBR, or `nvh264enc` with the ultra-low-latency tune, CBR and no B-frames. Neither reorders frames. SVT-AV1 was tried first: its low-delay mode stalled in the GStreamer element here, and its default mode added about 1.1 s.
4. The page opens `/ws/video?tunnel=<the Guacamole tunnel's UUID>`. The server attaches it to that screen connection's video source and sends a `config` message (WebCodecs codec string and size), then each encoded frame as a binary message: a u32 frame number, a keyframe flag, three zero bytes, then the AV1 temporal unit or H.264 access unit (Annex B). No compression on this socket.
5. `public/js/video.js` decodes with `VideoDecoder` (`optimizeForLatency`) and draws each frame into the Guacamole display's default layer canvas, so zoom, scaling and touch work as with images. After each decoded frame it sends `{"type":"ack","seq":n}`; after a decoder error it acknowledges what arrived, starts a new decoder and asks for a keyframe.
6. `src/ratecontrol.js` uses the acknowledgements. The base round trip is the lowest acknowledgement time in 10 s. The delivery rate comes from frames that waited behind the frame before them (sent more than a base round trip before the previous acknowledgement arrived): the gap between the two acknowledgements is their own crossing time. Every 250 ms, Adapt lowers the bitrate to 85% of the delivery rate (or by 5% if already below) when the smoothed acknowledgement time rises 40 ms or 30% over the base or frames were skipped, and otherwise raises it by 8% (4% at Data use) while the encoder uses at least half of it, up to 95% of the delivery rate and a ceiling by quality (1.5, 4, 8 or 16 Mbit/s, halved at Data use). Changes reach the encoder on its stdin; both encoders take a new bitrate without restarting.
7. Frame gating applies to fixed bitrates too: the encoder may take a new frame only while the oldest unacknowledged one is younger than the base round trip plus 80 ms (250 ms at Data use; at least 1.5 times the base), and the bytes in flight would cross at the delivery rate within that time. Captured frames in between are dropped, except the newest, which is encoded as soon as the gate opens. The frame rate cap (30, or 10 at Data use) works the same way.

When the separate desktop resizes its monitor, Mutter ends the recording and the source restarts the encoder at the new size. If the encoder fails for good, the page is told, and it reconnects with images until the screen settings change. The browser checks `VideoDecoder.isConfigSupported()` first and sends images if it cannot decode the chosen codec.

`source` picks what the Screen view shows:

- `mirror` (default): GNOME desktop sharing in `mirror-primary` mode, the physical monitor.
- `virtual`: switches desktop sharing to extend mode through `gsettings` before connecting and sets `resize-method=display-update`. GNOME adds a virtual monitor next to the physical one, and `size` instructions the browser sends when its window changes resize it. guacd gets `dpi=96`, so the monitor is made at the browser's CSS-pixel size; GNOME's scale on the main desktop is never changed. `screen-share-mode` is global, so mirror sessions switch it back to `mirror-primary`.
- `session`: connects to the separate desktop on port 3391, starting `deskport-session.service` first if the port is closed.

The scaler never shrinks `virtual` or `session` pictures; they are already the browser's size.

With `source=mirror`, `match=1` makes `src/monitors.js` switch the monitor to the mode that best fits the browser (the largest that fits inside it, else the smallest; for outputs mirrored in one logical monitor, a size all of them offer), and `monitor=<connector>` makes that monitor primary, since desktop sharing streams the primary one. Both use Mutter's DisplayConfig with temporary configurations through `scripts/monitor-config.py`. The configuration before the change is kept in memory and in `$XDG_RUNTIME_DIR/deskport-monitors-<port>.json`, and put back 4 s after the last such viewer disconnects, or at the next server start. `GET /api/monitors` lists the monitors.

### The separate desktop

`scripts/desktop-session.sh` runs a second GNOME Shell for the same user with `gnome-shell --headless` (no physical outputs, so it cannot touch the monitors) and `gnome-remote-desktop-daemon --headless` on port 3391. Each RDP client gets its own virtual monitor, sized to the client and resized with it.

Two GNOME Shells for one user would collide on the session bus and in the runtime directory, so the script gives this one the following. Everything else in the real runtime directory (the systemd user manager's sockets, snap and flatpak directories, gnupg, keyring and ssh agents, PipeWire, PulseAudio) is linked into the private one, so apps there can start in systemd scopes and snaps keep their confinement paths.

- a private D-Bus session bus at `$XDG_RUNTIME_DIR/deskport-session/bus`, whose service directory lists every session service except file indexing (Tracker/LocalSearch) and `systemd1`;
- a private runtime directory, `$XDG_RUNTIME_DIR/deskport-session`, for its Wayland socket, accessibility bus, portals, dconf notifications and gvfs mounts. (Without it, the second session's accessibility bus replaced the main one's socket.) PipeWire, PulseAudio and the keyring point back at the main session's sockets.

Files, settings (dconf) and the keyring are shared with the main desktop.

Snaps need three more things there. `snap run` starts each app in a systemd scope through the session bus, so `scripts/session-systemd-proxy.py` owns `org.freedesktop.systemd1` on the private bus (started on demand) and relays to the real user manager, refusing anything but starting scopes and reading state. Snap AppArmor profiles allow only `/run/user/<uid>/wayland-<n>` for Wayland and `/run/user/<uid>/bus` or an abstract `@/tmp/dbus-*` socket for the session bus, so the compositor's socket is `/run/user/<uid>/wayland-90` (an absolute WAYLAND_DISPLAY) and the private bus also listens on an abstract socket. A Chromium browser already open on the main desktop still takes new windows there: one profile can be open in only one process.

GNOME creates each client's monitor at scale 1, which is tiny on a phone. `sessionLayout()` in `src/guac.js` picks the largest whole scale up to the device's pixel ratio that GNOME allows (it needs at least 800 × 480 logical pixels) and rounds the size so the logical size is whole. With a scale of 2 or more, guacd gets the browser's real DPI (full device pixels), and once guacd reports the new desktop size, `scripts/session-scale.py` sets that monitor's scale through `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig` on the private bus (temporary method, nothing written to `monitors.xml`). Resizes from the browser are rounded the same way. Otherwise guacd gets `dpi=96` and makes the desktop at CSS-pixel size.

`GET /api/session` reports the unit's state and memory; `POST /api/session/stop` (same-origin only) stops it.

In the browser, the tunnel's receive timeout is 8 s (Guacamole pings every 500 ms). `Guacamole.Client` does not watch its tunnel, so `public/js/screen.js` does: a lost connection is retried at once, then after 1, 2, 4 and 8 s (the count resets after 10 s connected), and in the background it waits until the page is shown. A connection the server closes normally, or five failed tries, show the Disconnected card. Errors the server sends (nobody signed in, guacd unreachable) are shown and not retried.

Audio is not requested. The screen WebSocket uses permessage-deflate at zlib level 1: the images travel as base64, and compression wins back most of that overhead. The credentials never reach the browser.

GNOME's mirror mode always streams the monitor at its native size. An earlier version switched the physical monitor to a lower mode during sessions; on a monitor connected to two GPUs that left one output unable to draw until the user logged out, so that code was removed.

## Terminal

`handleTerminal()` spawns `tmux new-session -A -s web -c ~` in a pseudo-terminal: it attaches to the session if it exists and creates it otherwise. The child environment has every `RDP_*`, `CF_ACCESS_*`, `DESKPORT_*` and `GUACD_*` variable removed so secrets do not leak into the shell.

Messages from the browser are JSON, `{"type":"input","data":"..."}` or `{"type":"resize","cols":N,"rows":N}` (clamped). Output goes back as text frames, compressed with permessage-deflate (level 6, context kept across messages). Output that arrives within 4 ms of the last send is batched into one message; the first chunk after a pause, such as a keystroke's echo, goes out at once.

The page connects with `?flow=1`, which turns on flow control. Once xterm has drawn output, the page acknowledges it (`{"type":"ack","chars":N}`, in batches of 16 K characters or after 50 ms). When more than 128 K characters (`DESKPORT_TERM_WINDOW`) are unacknowledged, the bridge stops reading the pseudo-terminal until half of that is acknowledged. tmux then sees a slow client, skips the output in between and redraws the screen. Cloudflare's edge buffers without limit, so the server's own socket buffer cannot show a slow phone; the acknowledgements can.

With `?flow=1`, the page also sends `{"type":"ping","id":N}` every 15 s while visible and right after it becomes visible or comes back online; the bridge answers with a binary frame. If nothing at all arrives within 5 s, the page reconnects. The server sends WebSocket pings every 25 s so idle connections stay open through proxies.

Closing the socket kills the tmux client only; the session and its programs keep running. The browser reconnects at once, then with backoff (0.5 s up to 10 s), and skips the rest of a wait when the page becomes visible or the network returns.

xterm draws with its WebGL renderer, and falls back to the DOM renderer if WebGL is missing or its context is lost (iOS drops it in the background); WebGL is tried again when the page is shown.

### Copy, paste and xdg-open

- **Copy.** Programs copy with OSC 52, and tmux (`set-clipboard on`) sends one whenever it copies a selection. The page handles OSC 52 and writes the text to the browser's clipboard. A touch selection ends inside the gesture, but tmux's copy comes back a round trip later, so the page starts a clipboard write at once with a promise of the text (`ClipboardItem`), which keeps the gesture's permission. When the browser refuses a write outside a gesture (iPhone Safari does), a toast offers a Copy button. Ctrl+Shift+C copies xterm's own selection (Shift+drag while a program has the mouse).
- **Paste.** The Paste button (top bar, key row, More) reads the browser's clipboard and pastes it as one bracketed paste. Ctrl+Shift+V is left to the browser, which pastes.
- **tmux's menu.** Right click goes to tmux, not the browser's menu, while a program has the mouse. On touch, a long press released without moving, or a two-finger tap, sends a right press without its release: tmux closes the menu it opens on the press if a release follows, and keeps it until a tap picks an item or lands outside. The button-less mousemove a browser sends before a tap's mousedown is dropped for the same reason.
- **xdg-open.** The bridge starts the tmux client with `bin/` first on PATH and `BROWSER=bin/xdg-open`, and sets both in the session's environment (`tmuxArgs()`), so new windows and panes get them; shells that were already running keep their own. `bin/xdg-open` asks tmux which client was used last in its session and posts the target to each deskport server's socket, `$XDG_RUNTIME_DIR/deskport/open-<port>.sock` (mode 600, `src/opener.js`). The server whose bridge owns that client sends `{"type":"open"}` to its page, which shows the link in a toast with an Open button, since browsers only open tabs from a tap. Files are served at `/api/files/<random token>/<name>` for 15 minutes; HTML, SVG and XML files get a `sandbox` CSP so they cannot run scripts on deskport's origin. Only http, https, mailto, tel and sms links are passed on. In every other case (no deskport client was used last, no server answers, a directory) the script runs the system `xdg-open`.

## Processes on the host

| Process | Managed by | Listens on |
| --- | --- | --- |
| deskport | `deskport.service` (systemd user) | 127.0.0.1:7900 |
| cloudflared | `deskport-tunnel.service` (systemd user) | outbound only |
| guacd | Docker, `restart: unless-stopped` | 127.0.0.1:4822 |
| video encoder (`scripts/video-encoder.py`) | deskport, one per screen connection with a video encoding | none (stdin and stdout) |
| gnome-remote-desktop | `gnome-remote-desktop.service` (systemd user) | *:3390 |
| separate desktop (gnome-shell and gnome-remote-desktop, headless) | `deskport-session.service` (systemd user, started on demand) | *:3391 |
| tmux server | started on first terminal connection | Unix socket |
