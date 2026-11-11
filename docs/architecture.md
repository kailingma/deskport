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
| `src/server.js` | Express app, security headers, `/api/me`, `/vendor/*` routes, static files, and the WebSocket upgrade router. |
| `src/guac.js` | Guacamole protocol encoder and parser, and the bridge between a browser WebSocket and a guacd TCP connection. |
| `src/terminal.js` | Attaches a WebSocket to tmux through a pseudo-terminal. |
| `public/` | The page: `index.html`, `style.css`, `app.js`, fonts and icons. No build step. |
| `scripts/` | `setup-rdp.sh` and `install-services.sh`. |
| `deploy/` | guacd compose file and the cloudflared config example. |
| `test/` | `node --test` tests for the protocol parser. |

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
2. On guacd's `args` reply, answers each requested argument from the config: host, port, username, password, `security=any`, `ignore-cert=true`, `resize-method=display-update`, 24-bit colour, and the desktop-experience options (wallpaper, theming, font smoothing, full-window drag, composition).
3. Sends `size`, `audio`, `video`, `image`, `timezone`, then `connect`, echoing guacd's protocol version.
4. Sends the browser the tunnel's UUID instruction (`0.,36.<uuid>;`), which `WebSocketTunnel` expects first.

From then on it forwards complete instructions both ways. Guacamole element lengths count Unicode code points, so `GuacParser` handles surrogate pairs and instructions split across TCP chunks; `WebSocketTunnel` requires whole instructions per frame. Internal `ping` instructions from the browser are answered directly, other internal instructions are dropped.

`resize-method=display-update` lets the browser ask GNOME to change its resolution to fit the window. The credentials never reach the browser.

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
| tmux server | started on first terminal connection | Unix socket |
