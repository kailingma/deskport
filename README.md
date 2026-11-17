# deskport

A Linux desktop's live screen and a persistent terminal in one browser tab. It is served from the machine itself through a Cloudflare Tunnel and gated by Cloudflare Access.

- **Screen** shows the real logged-in GNOME session (what is on the monitor), with mouse, keyboard, touch and clipboard. It uses GNOME's built-in RDP desktop sharing and Apache guacd. It can instead show an extra monitor, or a separate GNOME desktop sized to your device.
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
| Show menu | Switches the Screen view between My monitor, Extra monitor and Separate desktop (see below). |
| Clipboard button | Sends your local clipboard to the remote desktop; paste there with Ctrl+V. Copying on the remote desktop fills your local clipboard. |
| Grid button | Presses Super (opens Activities). |
| Sliders button | Opens settings. |
| Ctrl+Alt+Del | Sends Ctrl+Alt+Delete. |
| Full screen button | Hides the browser chrome. The top bar becomes a floating toolbar that slides away after a few seconds; move the pointer to the top edge or click the handle to bring it back. In Chrome, full screen also passes Esc, Super and Alt+Tab to the remote desktop. |

### iPhone

- **No top bar**: the views use the whole screen. A bottom tab bar switches between Screen and Terminal; a dot on a tab means that view is connecting or disconnected.
- **More** opens a sheet with what to Show (My monitor, Extra monitor, Separate desktop), Show keyboard, Paste (Terminal), Send clipboard (Screen), Press Super, Send Ctrl+Alt+Delete, Reconnect, Settings and Full screen.
- **Key row**: Esc, Tab, Ctrl, Alt, the arrow keys, `/ - | ~`, and Paste in the Terminal view. It appears above the on-screen keyboard, and always in the Terminal view. Ctrl and Alt stay on for the next key you press, so Ctrl then `c` sends Ctrl+C.
- **Touch on the Screen view**:

  | Gesture | Does |
  | --- | --- |
  | Tap | Left click |
  | Drag | Scrolls the remote desktop, with momentum. When zoomed in, moves around the picture instead. |
  | Two-finger drag | Scrolls the remote desktop |
  | Pinch | Zooms this view |
  | Long press, then drag | Drags with the left button held (move windows, select text) |
  | Long press, then release | Right click |
  | Two-finger tap | Right click |

- **Touch in the Terminal view**: drag to scroll (tmux scrollback when tmux has the mouse, which it does with `set -g mouse on`), long press then drag to select. tmux copies the selection when you lift your finger, and it lands on the phone's clipboard. Long press and release, or a two-finger tap, opens tmux's menu; tap an item to pick it. Paste is on the key row and under More.
- **Links from the terminal**: `xdg-open` (and anything that uses `BROWSER`) in a new tmux window or pane shows the link or file in a toast with an Open button on the device you typed on. Windows opened before deskport was updated keep the old behaviour.
- **Full screen**: iPhone Safari has no full-screen mode for web pages. More, then Full screen, explains the alternative: Share, then Add to Home Screen. Opened from that icon, deskport fills the screen, including the area behind the status bar. The Home Screen app keeps its own cookies, so it asks you to sign in once. Android browsers use real full screen.

### Settings

The sliders button in the top bar (or More, then Settings, on a phone) opens the settings. They are saved in the browser, so each device keeps its own.

| Setting | Options |
| --- | --- |
| Theme | System, Light, Dark |
| Show | My monitor (default), Extra monitor, Separate desktop (see below) |
| Resolution | Auto (fits this screen, with room to pinch-zoom 2x on touch screens), Full size, 75%, 50%, 33%. Only for My monitor; the other two are always made at this device's size. |
| Send as | Images (as before), AV1 video or H.264 video. See [Video](#video). |
| Encoder speed | Video only: Fastest, Balanced, Smallest |
| Bitrate | Video only: Adapt to the connection, or a fixed 0.5 to 20 Mbit/s |
| Picture quality | Low, Medium, High, Lossless. With video, the encoder's quality range instead. |
| Prioritize | Responsiveness (every frame) or Data use (about 10 frames per second). With video: up to 30 or 10 frames a second, and what Adapt aims for. |
| Touch scrolling | Natural or reversed direction |
| Terminal colours | deskport dark and light, Solarized dark and light, Nord, Gruvbox dark |
| Terminal font and size | System monospace, JetBrains Mono, IBM Plex Mono; 9 to 22 px |
| Cursor | Block, bar or underline; blinking on or off |
| Extra key row | Auto (on phones in the terminal and when a keyboard is up), always, never |

Screen settings apply when you close settings; the screen reconnects.

### What the Screen view shows

| Show | What you get |
| --- | --- |
| My monitor | Exactly what is on the physical monitor, at its resolution, shrunk to fit. |
| Extra monitor | GNOME adds a second monitor next to the physical one, sized to your window in CSS pixels and resized when the window changes or the phone rotates. It is a secondary monitor, so it has only the wallpaper: no top bar, dock or icons. Drag windows onto it from the main monitor. Only one device can use desktop sharing in one mode at a time, so switching a device to this mode changes it for any other device showing My monitor. |
| Separate desktop | A second GNOME desktop for the same user, with its own top bar, dock and windows, sized to your device. It runs headless (no physical monitor), so it never changes the monitor or what is on it, and any number of devices can use it next to My monitor. On high-density screens (iPhones, Retina laptops) GNOME draws it at scale 2, so text is sharp and readable; on screens too small for that, it is made at CSS-pixel size and the browser enlarges it. It starts the first time you pick it (a few seconds) and keeps running, with any apps you opened, until you end it in Settings. It uses about 400 to 600 MB of memory. |

The separate desktop shares your files, settings and keyring with the main desktop. Apps that allow only one copy per user, such as Firefox with the same profile, cannot run in both at once. File indexing runs only on the main desktop.

### Speed

GNOME desktop sharing in mirror mode always sends the monitor at its native resolution and ignores the size the browser asks for. deskport never changes the monitor; instead the server reshapes the picture before it leaves the machine:

- **Resolution**: below Full size, the server shrinks every image guacd produces and scales every drawing coordinate, then scales your mouse back up. Auto picks the smallest size that still fills your screen's pixels.
- **Quality**: Low and Medium re-encode images as JPEG at quality 35 and 60. High keeps guacd's own images. Lossless makes guacd send exact pixels.
- **Prioritize**: Responsiveness sends every frame as soon as it is ready. Data use holds frame acknowledgements back so guacd sends at most 10 frames per second. Only the newest held acknowledgement is sent, so typing never waits more than 100 ms for it.
- Screen messages are compressed (permessage-deflate), and audio is not requested.

Measured on this 4K desktop while it was busy (read-only sessions, 10 seconds each):

| Setting | Picture | Traffic |
| --- | --- | --- |
| Full size, High | 3840 × 2160 | 1,450 KB/s |
| Full size, Lossless | 3840 × 2160 | 1,960 KB/s |
| Full size, Low | 3840 × 2160 | 410 KB/s |
| 50%, High | 1920 × 1080 | 330 KB/s |
| 50%, Low | 1920 × 1080 | 220 KB/s |
| 50%, Low, Data use | 1920 × 1080 | 180 KB/s |

Re-encoding did not lower the frame rate in these runs. `node bench/measure-screen.mjs [seconds] [ws://host:port] [query ...]` repeats the measurement against a dev server.

Time from a key press to the first screen update reaching the browser, measured on the separate desktop on this machine (no network in between; 24 keys each):

| Setting | Median | 90th percentile |
| --- | --- | --- |
| High, Responsiveness | 20 ms | 28 ms |
| Low, Responsiveness | 45 ms | 50 ms |
| High, Data use | 39 ms | 47 ms |

Before the fix described under Prioritize, Data use had a 90th percentile of 1.5 s and 5 of 24 keys showed no update within 3 s. `node bench/measure-typing.mjs [ws://host:port] [query ...]` repeats this; it types only into the separate desktop.

### Video

Send as AV1 video or H.264 video sends the screen as a video stream instead of images. The Guacamole connection stays up for the keyboard, mouse, pointer and clipboard; the picture comes from GNOME's screen recording interface (the same one desktop sharing uses), is encoded on the computer, and travels on a second WebSocket. GNOME shows its screen recording indicator in the top bar while it runs. Nothing about the monitor changes.

- **AV1** is encoded on the processor (libaom, realtime mode). It needs a browser that decodes AV1: Chrome, Edge and Firefox on computers do; Safari only on devices with an AV1 decoder in hardware (iPhone 15 Pro and later, Macs and iPads with an M3 or later). Elsewhere deskport says so and sends images.
- **H.264** is encoded on the graphics card (NVENC), so it barely uses the processor, and most browsers decode it, including Safari on iPhone.
- **Encoder speed**: time to encode one 1920 × 1080 frame on this computer. AV1: 13, 15 and 19 ms; at 3840 × 2160 39, 42 and 56 ms. H.264: 2, 3 and 5 ms; 8 to 21 ms at 3840 × 2160.
- **Bitrate, Adapt**: the browser acknowledges each decoded frame. While frames come back as fast as the connection's base round trip, the bitrate rises (8% every quarter second at Responsiveness, 4% at Data use, which also stops at half the ceiling); as soon as they start to queue it drops to below what the connection delivered. A fixed bitrate does not change.
- With either bitrate, a new frame is encoded only while the frames already sent are arriving on time. Otherwise the newest captured frame waits and the ones before it are skipped, so a slow connection shows fewer frames instead of an older picture.

On the separate desktop, opening and closing the Activities overview every 350 ms for 10 seconds at 1280 × 720 sent 7.2 MB as images at High (base64 text before compression), 660 KB as AV1 at High, 265 KB as AV1 at Medium and 347 KB as H.264 at High. Through a simulated 1.5 Mbit/s connection with a 150 ms round trip, Adapt settled at 0.9 to 1.3 Mbit/s over three runs, and frames were acknowledged a median 172 to 298 ms after they were sent (at most 631 to 777 ms).

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

### Add another machine

On the hub, open Machines, Add machine for a join token (it works once, for 15 minutes; Cloudflare needs the `/agent/*` Bypass application from [docs/setup.md](docs/setup.md), step 9). Then on the other machine, as the user the agent should run as:

```bash
curl -fsSL https://<your hub>/agent/v1/install.sh | sh -s -- <join token>
```

It downloads the agent for the machine, joins it to the hub, installs tmux if you agree, and starts the agent at boot. Without the token it asks for one.

On Windows 10 1809 or later, in PowerShell as that user (not as administrator), after `npm run build:agent:windows` on the hub:

```powershell
$env:DESKPORT_JOIN_TOKEN='<join token>'; irm https://<your hub>/agent/v1/install.ps1 | iex
```

It installs the agent with a scheduled task that starts it at each logon; its terminal is PowerShell. The Windows agent has not yet been run on a real Windows machine ([docs/windows.md](docs/windows.md)).

Configuration lives outside the repo in `~/.config/deskport/` (see [deskport.env.example](deskport.env.example)) and `~/.cloudflared/deskport.yml`.

## Documentation

- [docs/setup.md](docs/setup.md): install, Cloudflare Tunnel and Access, services, troubleshooting.
- [docs/architecture.md](docs/architecture.md): request flow, authentication, the Guacamole bridge, the terminal, and which process listens where.
- [PRODUCT.md](PRODUCT.md): who it is for and the constraints the UI follows.
- [DESIGN.md](DESIGN.md): the design system.
- [docs/decisions.md](docs/decisions.md): why things are the way they are.
- [docs/multi-host.md](docs/multi-host.md): the planned design for one UI controlling several machines, and the groundwork for it that exists now.

## Development

```bash
npm run dev      # watch mode, Access checks off, loopback only
npm test         # protocol parser tests
npm run check    # syntax check of every source file
node scripts/make-icons.mjs   # regenerate web/icons/*.png from the icon geometry
node bench/measure-screen.mjs 15 ws://127.0.0.1:7900   # bandwidth per quality preset
node bench/measure-typing.mjs ws://127.0.0.1:7900      # key-to-screen latency, on the separate desktop
```

There is no build step. The page is plain ES modules; browser libraries (guacamole-common-js, xterm.js, Inter) are served from `node_modules` under `/vendor/`.

## Limits

- The desktop must have a logged-in GNOME session. A locked screen shows the lock screen, which you can unlock remotely.
- My monitor shares the primary monitor only, at its own resolution, scaled to fit your window.
- The video encodings need GStreamer with its Python bindings (`python3-gi`, `gir1.2-gstreamer-1.0`), the `aom`, `pipewire` and `videoparsersbad` plugins (gstreamer1.0-plugins-good and -bad), and for H.264 an NVIDIA graphics card with NVENC (`nvcodec`, in gstreamer1.0-plugins-bad).
- GNOME desktop sharing listens on all interfaces on its port. Firewall it if the machine is on an untrusted network.
- `node-pty` is a native module. After changing Node major versions, run `npm rebuild node-pty` and `./scripts/install-services.sh`.
