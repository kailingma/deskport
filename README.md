# deskport

A Linux desktop's live screen and a persistent terminal in one browser tab. It is served from the machine itself through a Cloudflare Tunnel and gated by Cloudflare Access.

- **Screen** shows the real logged-in GNOME session (what is on the monitor), with mouse, keyboard, touch and clipboard. It uses GNOME's built-in RDP desktop sharing and Apache guacd.
- **Terminal** is a tmux session (`web` by default) in xterm.js. Closing the tab only detaches; programs keep running. You can attach to the same session locally with `tmux attach -t web`.
- **Access**: only Cloudflare Access can reach it, and the server checks the Access token itself on every request and WebSocket.

It works in desktop browsers, on iPad, and on iPhone. On a phone it uses a bottom tab bar and a row of extra keys, and you can add it to the home screen.

```
browser ──https──▶ Cloudflare Access ──tunnel──▶ cloudflared ──▶ deskport :7900 (loopback)
                                                                   ├─ /ws/screen ─▶ guacd :4822 ─RDP─▶ gnome-remote-desktop :3390
                                                                   └─ /ws/term   ─▶ node-pty ─▶ tmux
```

## Using it

### Desktop and iPad

| Control | What it does |
| --- | --- |
| Screen / Terminal (Alt+1 / Alt+2) | Switch views. Both stay connected in the background. |
| Clipboard button | Sends your local clipboard to the remote desktop; paste there with Ctrl+V. Copying on the remote desktop fills your local clipboard. |
| Grid button | Presses Super (opens Activities). |
| Sliders button | Opens settings. |
| Ctrl+Alt+Del | Sends Ctrl+Alt+Delete. |
| Full screen button | Hides the browser chrome. The top bar becomes a floating toolbar that slides away after a few seconds; move the pointer to the top edge or click the handle to bring it back. In Chrome, full screen also passes Esc, Super and Alt+Tab to the remote desktop. |

### iPhone

- **Bottom tab bar**: Screen, Terminal, and More. More opens a sheet with Show keyboard, Send clipboard, Press Super, Send Ctrl+Alt+Delete, Reconnect and Settings.
- **Key row**: Esc, Tab, Ctrl, Alt, the arrow keys, and `/ - | ~`. It appears above the on-screen keyboard, and always in the Terminal view. Ctrl and Alt stay on for the next key you press, so Ctrl then `c` sends Ctrl+C.
- **Touch on the Screen view**:

  | Gesture | Does |
  | --- | --- |
  | Tap | Left click |
  | Drag | Scrolls the remote desktop, with momentum |
  | Long press, then drag | Drags with the left button held (move windows, select text) |
  | Long press, then release | Right click |
  | Two-finger tap | Right click |
  | Pinch, or drag with two fingers | Zooms and pans this view |

- **Touch in the Terminal view**: drag to scroll (tmux scrollback when tmux has the mouse, which it does with `set -g mouse on`), long press then drag to select. tmux copies the selection to its buffer when you lift your finger.
- **Full screen**: iPhone Safari has no full-screen mode for web pages. Use Share, then Add to Home Screen, to get deskport without Safari's toolbars.

### Settings

The sliders button in the top bar (or More, then Settings, on a phone) opens the settings. They are saved in the browser, so each device keeps its own.

| Setting | Options |
| --- | --- |
| Theme | System, Light, Dark |
| Picture quality | Faster (about 10 frames per second), Balanced, Sharper (lossless). Applies when you close settings; the screen reconnects. |
| Touch scrolling | Natural or reversed direction |
| Terminal colours | deskport dark and light, Solarized dark and light, Nord, Gruvbox dark |
| Terminal font and size | System monospace, JetBrains Mono, IBM Plex Mono; 9 to 22 px |
| Cursor | Block, bar or underline; blinking on or off |
| Extra key row | Auto (on phones in the terminal and when a keyboard is up), always, never |

### Speed

GNOME desktop sharing in mirror mode always sends the monitor at its native resolution; it ignores the size the browser asks for. On a 4K monitor that is the main cost. What deskport does about it:

- Screen messages are compressed (permessage-deflate), which cut traffic by about a quarter in testing.
- The quality presets trade frame rate and lossless output for data. Measured on a mostly static 4K desktop: Faster about 310 KB/s at 10 fps, Balanced about 380 KB/s at 16 fps, Sharper 530 to 650 KB/s.
- Audio is not requested (GNOME's RDP audio channel does not work with guacd).

Lowering the monitor's own resolution during a session would cut traffic much further, but changing monitor modes broke the display on a machine with one monitor connected to two GPUs, so deskport does not do it. `node scripts/measure-screen.mjs [seconds] [ws://host:port]` measures the presets against a dev server.

### Connection states

The badge in the top bar shows the current view's connection state: Connecting, Connected, Reconnecting (the terminal retries with backoff), Disconnected, or Error. If the screen connects but no picture arrives within 12 seconds, deskport says so and tells you how to restart GNOME desktop sharing.

## Setup

[docs/setup.md](docs/setup.md) covers everything from a fresh machine to a working URL. In short:

```bash
npm install && npm test
./scripts/setup-rdp.sh                              # GNOME desktop sharing on port 3390
docker compose -f deploy/docker-compose.yml up -d   # guacd on 127.0.0.1:4822
npm run dev                                         # try it at http://127.0.0.1:7900, Access checks off
# create the tunnel and Access application (see docs/setup.md), then:
./scripts/install-services.sh                       # systemd user services
```

Configuration lives outside the repo in `~/.config/deskport/` (see [deskport.env.example](deskport.env.example)) and `~/.cloudflared/deskport.yml`.

## Documentation

- [docs/setup.md](docs/setup.md): install, Cloudflare Tunnel and Access, services, troubleshooting.
- [docs/architecture.md](docs/architecture.md): request flow, authentication, the Guacamole bridge, the terminal, and which process listens where.
- [PRODUCT.md](PRODUCT.md): who it is for and the constraints the UI follows.

## Development

```bash
npm run dev      # watch mode, Access checks off, loopback only
npm test         # protocol parser tests
npm run check    # syntax check of every source file
node scripts/make-icons.mjs   # regenerate public/icons/*.png from the icon geometry
node scripts/measure-screen.mjs 15 ws://127.0.0.1:7900   # bandwidth per quality preset
```

There is no build step. The page is plain ES modules; browser libraries (guacamole-common-js, xterm.js, Inter) are served from `node_modules` under `/vendor/`.

## Limits

- The desktop must have a logged-in GNOME session. A locked screen shows the lock screen, which you can unlock remotely.
- One screen is shared: the primary monitor, at its own resolution, scaled to fit your window.
- GNOME desktop sharing listens on all interfaces on its port. Firewall it if the machine is on an untrusted network.
- `node-pty` is a native module. After changing Node major versions, run `npm rebuild node-pty` and `./scripts/install-services.sh`.
