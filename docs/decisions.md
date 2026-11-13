# Decisions

Choices made while building deskport, newest first, with the reason for each. Entries marked *autonomous* were made while the owner was away and asked for choices to be made and logged.

## 2026-11-12

### Bench and baseline (roadmap phase 0)
`bench/run.mjs` is the yardstick for every speed change from here on (method in [bench/README.md](../bench/README.md)). It starts its own server from the checkout, measures on the separate desktop only, and saves results in `bench/results/`. Baseline: `bench/results/2026-11-12-baseline.json`, commit cbd1f49, three runs, medians below. 1280 × 720, quality High, Responsiveness, Adapt bitrate. Bytes are after WebSocket compression.

| Link | Case | Key to pixel (p90) | Overview press to pixel | Catch-up | Overview KB/min | Typing KB/min | Capture to encode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| loopback | images | 52 (64) ms | 47 ms | 0 | 34,114 | 5,356 | not reported |
| loopback | AV1 | 43 (57) ms | 37 ms | 0 | 6,673 | 1,062 | 8 ms |
| loopback | H.264 | 37 (41) ms | 26 ms | 0 | 1,255 | 1,683 | 1 ms |
| 4 Mbit/s, 150 ms | images | 202 (206) ms | 220 ms | 2.2 s | 35,278 | 4,245 | |
| 4 Mbit/s, 150 ms | AV1 | 198 (206) ms | 249 ms | 0 | 5,014 | 823 | 7 ms |
| 4 Mbit/s, 150 ms | H.264 | 190 (215) ms | 197 ms | 0 | 2,486 | 1,714 | 1 ms |
| 1 Mbit/s, 400 ms | images | 458 (467) ms | 1,105 ms | 42.4 s, then guacd disconnects | 36,618 | 3,172 | |
| 1 Mbit/s, 400 ms | AV1 | 467 (509) ms | 456 ms | 1.3 s | 520 | 549 | 7 ms |
| 1 Mbit/s, 400 ms | H.264 | 459 (935) ms | 439 ms | 0.1 s | 588 | 1,141 | 1 ms |

Terminal: echo 3, 151 and 402 ms; Ctrl+C during a `seq` flood 58, 277 and 530 ms; 923, 38 and 35 KB crossing the link meanwhile.

What it shows:
- On a slow link a keystroke costs about one round trip plus 40 to 60 ms on every path, so the remaining local delay to remove is those 40 to 60 ms: guacd and RDP for images, and for video the input path through guacd and RDP plus the capture.
- Images do not adapt to the link. They push about 35 MB a minute during large changes whatever the link; at 1 Mbit/s the picture fell 42 s behind and guacd then closed every connection ("User is not responding", its acknowledgements arrived after its 15 s timeout). The video paths kept up, with 1.3 s of catch-up at worst.
- H.264 on the graphics card is the fastest to encode (1 ms) and the quickest on loopback. AV1 used less data on typing.
- The page's decoding and drawing are not included (the bench acknowledges frames on arrival). GNOME on the separate desktop draws only one or two frames per overview press, so "overview" is large changes, not continuous animation.

Bench choices (*autonomous*): the three phases (idle, typing in the Activities search, opening and closing the overview every 350 ms) and their sizes; both directions of the simulated link limited, with one limit shared by a case's sockets; three runs per baseline, medians reported. A first version of the bench took updates already queued on the link for a key's answer (key to pixel came out under the round trip) and ended catch-up at the first quiet gap while bytes were still in flight; both fixed before the baseline. It also suggested H.264 took 110 ms on loopback, which the fixed bench did not reproduce (37 ms).

### Hub and agents, dialled out from each machine
The owner asked for the fastest possible screen, several machines with one install each, a coordination server, and a picker and metrics dashboard per machine. Hosts will keep an outbound connection to a hub (the owner's choice over the controller dialling each host's own tunnel, and over Tailscale only), so a new machine needs no tunnel or Access application. Linux first, Windows later, macOS not planned. The agent will be Rust (single binary, Windows later, no garbage collector in the frame path) and the hub stays Node. Speed is expected from removing guacd, RDP and the extra encodes (GNOME's RemoteDesktop and ScreenCast APIs, already present on the separate desktop), not from the language. The plan and phases are in [roadmap.md](roadmap.md).

### AV1 and H.264 video for the Screen view
The owner asked to consider AV1, with settings for its speed and how the screen is transmitted, and a mode that adapts to the connection for the least delay or data, using the existing Prioritize choice.

- **Where the frames come from.** guacd only produces images, so the picture is recorded separately through Mutter's ScreenCast API, the interface GNOME desktop sharing itself records with. It is read-only: no monitor configuration changes. Input, the pointer and the clipboard stay on the Guacamole connection, whose picture is dropped in the bridge. Rebuilding frames from guacd's images instead was rejected: guacd would still compress every frame as PNG first, which is the cost video should remove.
- **libaom, not SVT-AV1** (*autonomous*). SVT-AV1 2.3's low-delay mode stalled inside the GStreamer element here, and its default mode added about 1.1 s at 30 frames a second. libaom's realtime profile, the one browsers use for AV1 calls, took a median 13 to 19 ms per 1920 × 1080 frame and 39 to 56 ms at 3840 × 2160 (test pattern, 30 frames a second offered; at 3840 × 2160 it managed 15 to 20). This machine's graphics cards cannot encode AV1 (Turing and Maxwell), so AV1 runs on the processor.
- **H.264 on the graphics card as a second choice** (*autonomous*). Safari decodes AV1 only on devices with a hardware AV1 decoder (iPhone 15 Pro and later), so AV1 alone could leave the owner's phone with images. NVENC on the GTX 1650 SUPER encodes a 1920 × 1080 frame in 2 to 5 ms and 3840 × 2160 at 30 frames a second, nearly without processor use. On the test below it also used less data than AV1 (347 against 660 KB), likely because libaom's fastest realtime setting gives up compression for speed; picture quality was not compared.
- **"How it is transmitted"** became Send as: Images, AV1 video or H.264 video, with Bitrate (Adapt or a fixed rate) for the video choices (*autonomous*: the request did not say which aspect of transmission). A WebRTC transport was not built: the Cloudflare tunnel carries no UDP, so it would only help on Tailscale or the local network.
- **Adapting.** The browser acknowledges each decoded frame, since Cloudflare's edge buffers without limit and the server cannot see a slow phone from its socket (the same reason as the terminal's flow control). Adapt raises the bitrate while frames come back on time and drops it to below the measured delivery rate when they queue; Responsiveness climbs faster and allows 30 frames a second, Data use climbs at half the speed, stops at half the ceiling and allows 10. Independently, a new frame is encoded only while what was sent is arriving on time, and the newest captured frame waits instead of a queue forming. Two first versions of the delivery-rate estimate were wrong in live tests: one counted idle time between bursts as a slow link (the bitrate fell to the 150 kbit/s floor on loopback), the other mistook a large frame's own transfer time for queueing. The current one counts only frames that waited behind the frame before them.
- **Measured** on the separate desktop at 1280 × 720 (Activities overview opened and closed every 350 ms for 10 s): images at High 7.2 MB of base64 text before compression, AV1 at High 660 KB, at Medium 265 KB, H.264 at High 347 KB. Through a simulated 1.5 Mbit/s link with a 150 ms round trip (three runs of 15 s), Adapt settled at 0.9 to 1.3 Mbit/s, and frames were acknowledged a median 172 to 298 ms after sending, at most 631 to 777 ms. Capture to encoded frame took a median 8 ms for AV1 and 1.3 ms for H.264 at 1280 × 720. Headless Chromium decoded and drew the AV1 stream. Not yet tried: My monitor (nobody was signed in on the main desktop during this work), an extra monitor, and any iPhone, iPad or Safari.

### Copy, paste, tmux's menu and xdg-open in the terminal
The owner asked for xdg-open, copying and pasting, and tmux's right-click menu to work in the Terminal view.

- **Copy through OSC 52**, the way terminals receive tmux's copies; tmux here already has `set-clipboard on`. iPhone Safari only writes the clipboard during a tap, and tmux's copy arrives a round trip after the finger lifts, so the page starts the write at the end of the selection with a promise of the text. When that is not possible, a toast offers a Copy button rather than dropping the text. Tested in headless Chromium: a touch selection reached the clipboard and an OSC 52 from `printf` did too. Not yet tried on an iPhone.
- **Paste is a button**, because a page can only read the clipboard from a tap or click, and long press in the terminal already selects. It pastes as one bracketed paste.
- **tmux's menu on touch.** Long press and release, and two-finger tap, are a right click, matching the Screen view. tmux closes the menu again when the right button's release reaches it (a quick click whose press and release arrive together never shows the menu), so the touch right click sends only the press and the menu waits for a tap. The browser's button-less mousemove before each tap is dropped, since tmux read it as a release. Tested in headless Chromium: both gestures opened the menu and a tap on Horizontal Split split the pane. On a desktop browser a real right click behaves as in any terminal: tmux keeps the menu if the mode change reaches xterm before the button comes up.
- **xdg-open opens on the device that typed the command** (*autonomous*: the alternative was the desk's monitor, which the person on the phone cannot see). It goes there only when a deskport terminal was the tmux client used last; otherwise the system xdg-open runs as before. The script reaches the server over a Unix socket that only this user can open, so no Access token is needed. Opened files are served under a random token for 15 minutes, and HTML, SVG and XML are sandboxed so a downloaded page cannot run scripts with deskport's access. The shell already gives full access to the same files, so serving one the user asked to open adds nothing new. Existing shells in `web` do not have the new PATH or BROWSER; new windows and panes do.

### Speed on slow links and through the tunnel
The owner asked for the fastest experience on slow connections and through Cloudflare, the terminal included, with as few compromises as possible. Measured with `scripts/measure-terminal.mjs` (a proxy that delays each direction by half the round trip, limits the download rate and buffers without limit, as Cloudflare's edge does) and `scripts/measure-clear.mjs`.

- **Terminal compression.** The terminal socket had no compression. With permessage-deflate (level 6, context kept), Ctrl+C during `seq` output on a 4 Mbps, 150 ms link brought the prompt back in 0.2 s instead of 7.6 s, and 0.87 MB crossed the link instead of 5.1 MB.
- **Terminal flow control.** Output that does not compress (`head -c 200M /dev/urandom | base64`) still queued 44 MB at Cloudflare, and Ctrl+C had no visible effect within 120 s. The page now acknowledges drawn output and the bridge stops reading tmux beyond 128 K unacknowledged characters, so tmux skips output and redraws. Ctrl+C now takes 0.25 s on 4 Mbps and 150 ms, and 0.47 to 0.56 s over eight runs on 1 Mbps and 400 ms, with about 0.2 MB crossing the link. Keystroke echo is the round trip in every case (151 and 402 ms). A first suspicion that tmux sometimes failed to redraw came from the test proxy reordering data; with that fixed, eight of eight runs ended on a correct screen, rendered with headless xterm.
- **Dead connections.** Phones drop sockets silently in the background, and the terminal had no check, so it could show Connected on a dead socket until TCP gave up. It now pings while visible and on becoming visible, and reconnects if nothing arrives within 5 s. Tested in headless Chromium by freezing the server: reconnected 5.0 s after the page woke; a healthy connection did not reconnect. The first reconnect is now immediate.
- **Screen drops.** `Guacamole.Client` does not watch its tunnel, so a dead or closed screen socket left the last picture up, marked Connected. The page now watches the tunnel, retries lost connections (at once, then 1, 2, 4, 8 s), and lowers the receive timeout from 15 to 8 s. Tested by freezing the server: the drop was noticed 8 s later, the reconnect started at once, and the picture came back when the server resumed.
- **Lossless WebP instead of PNG.** At high quality, guacd's PNGs made up most of the bytes of a recorded window redraw. Re-encoded as lossless WebP they came out at 76% of the size with the same pixels, with the slowest image at 26 ms (effort 1 up to 65,536 pixels, effort 0 above; a full 4K image takes about 180 ms at effort 0). On a fast LAN this roughly breaks even; on slow links it is a clear gain, so it is on by default and `DESKPORT_LOSSLESS_WEBP=0` turns it off. Lossy images from guacd are passed through untouched. An A/B run of the live redraw was not done.
- **Screen compression unchanged.** On the recorded traffic, deflate already removes most of the base64 overhead (3651 to 2747 KB); keeping the context between messages saved 4% more, not worth the memory.
- **Page loading.** Scripts and styles were 624 KB uncompressed, loaded in three rounds of imports, and the vendored libraries were revalidated daily. Everything is now served from memory under the content-hash path, immutable, brotli-compressed (147 KB), with every module preloaded from the page.
- **Terminal drawing.** xterm now uses its WebGL renderer, which redraws a full screen far faster than the DOM renderer on phones. Checked in headless Chromium (SwiftShader); not yet seen on an iPhone.

## 2026-11-11 (late night)

### Apps that did not open on the separate desktop
Firefox and every other snap failed with "cannot create transient scope: org.freedesktop.systemd1 was not provided": `snap run` puts each app in a systemd scope through the session bus, and the separate desktop's private bus has no systemd. A relay (`scripts/session-systemd-proxy.py`) now owns that name on the private bus and forwards to the real user manager. It refuses everything except starting scopes and reading state, because GNOME Shell calls SetEnvironment at startup and that would point the main desktop's apps at the separate one. Tested: a scope started through the relay, and SetEnvironment was refused.

With the scope fixed, Firefox started but opened on the main desktop: snaps link `../wayland-0`, the main compositor, and their AppArmor profiles allow only `/run/user/<uid>/wayland-<n>` and `/run/user/<uid>/bus` or an abstract `@/tmp/dbus-*` socket. The separate desktop's compositor socket is now `/run/user/<uid>/wayland-90` (an absolute WAYLAND_DISPLAY, which snaps then use as is), and its bus also listens on an abstract socket. Tested after a restart: Firefox started in its scope with that WAYLAND_DISPLAY, logged no AppArmor denials or bus errors, and its only compositor connection was to the separate desktop's GNOME Shell. (A test Firefox window was open on the main desktop for about a minute while this was found.)

Helium (and any Chromium browser) hands a new window to the copy already running on the main desktop, because one profile can only be open in one process. Only a separate profile for the separate desktop (Chromium honours `CHROME_CONFIG_HOME`) would change that; left to the owner.

### Frame acknowledgements ahead of the browser (*autonomous*)
The owner reported the picture freezing for over a second after `clear` in a terminal. On localhost the redraw arrived in about 25 ms, and the Terminal view had no main-thread stalls, so the delay is on the network path. guacd paces itself on the browser's frame acknowledgements and holds frames back when one comes back late, as a large frame over a slow link does. At Responsiveness the bridge now acknowledges frames itself as they leave, up to two ahead of the browser and only while under 256 KB waits in the socket (`src/pacing.js`). On a simulated 4 Mbps link, the median time for a keypress to show dropped from 380 to 485 ms to 309 to 355 ms over three runs each; the slowest tenth (about 1.3 s) is bandwidth and did not change. `DESKPORT_ACK_AHEAD=0` turns it off.

### WebP instead of JPEG when re-encoding (*autonomous*)
On captured desktop text, WebP was 15% smaller than JPEG at quality 60 and 39% smaller than 4:4:4 JPEG at quality 82, for about 20% more encoding time. The scaler now re-encodes lossy images as WebP.

### Matching My monitor's resolution to the viewer
The owner asked for it despite the earlier incident. It is off by default, asks before turning on (naming the incident), applies GNOME's temporary configuration only while someone is connected, and puts the previous one back four seconds after the last viewer leaves, also on the next server start if the server died. With several monitors, the chosen one is made primary for the session, since GNOME desktop sharing streams only the primary monitor; showing all monitors at once is not possible with it. Planning is unit-tested and applying and restoring was tested on the separate desktop's virtual monitor; it has never been run against the physical monitor.

### Keyboard and the screen size
New setting, Touch, When the keyboard opens: Fit above it (as before) or Keep size. Keep size leaves the picture and the remote desktop's size alone, and one finger moves the picture while it is taller than the space above the keyboard (*autonomous*: the alternative was no way to see what the keyboard covers).

### One confirmation dialog, toolbar, reload
Confirmations use the card of the screen's Disconnected message instead of the browser's `confirm()`. The desktop toolbar's sides now shrink instead of running into the view switch; the status sits next to the host name, Ctrl+Alt+Del is an icon, and narrow windows drop the labels. The More sheet has Reload page, which fetches every file the page loaded past the browser cache before reloading.

## 2026-11-11 (night)

### Multi-host groundwork, no visible change
The owner wants deskport to grow into a system where each machine runs its own server, the UI is optional per machine, and one host can control several. Asked for the possibility and stubs only. The server is now split into `api.js`, `ui.js` and `hosts.js`; every endpoint also answers under `/h/<id>/`; `DESKPORT_UI=0` drops the page; `/api/host` describes a host's capabilities; and every URL in the page goes through a host object. Requests for other hosts return 501. The chosen design, forwarding through the controller with a Cloudflare Access service token instead of the browser opening each host directly, and the remaining steps are in docs/multi-host.md.

### Terminal drawn past its area
The owner saw the terminal and tmux's status bar end up off screen. xterm's fit addon sizes the terminal from its parent's computed height, which with `box-sizing: border-box` includes the parent's padding, and subtracts only the terminal element's own padding. The 20 px of vertical padding on the container therefore made the terminal up to a row too tall (and up to a column too wide). xterm now opens in an unpadded box inside the padded container, so the addon measures the real space. A first attempt moved the padding onto the terminal element instead; that showed xterm's black viewport background as bars around the terminal, so it was replaced. The viewport now takes the terminal theme's background (it shows in the space below the last row), and its native scrollbar is hidden because xterm 6 draws its own. Checked in emulation at phone and tablet sizes and with a light theme: no bars, and tmux's status bar is fully visible.

### Menus over the Screen view
On a phone, menus over the Screen view would not scroll, and the remote desktop moved behind them. The screen's touch handlers now act only on touches that started on the screen (tracked by touch identifier), ignore new touches while a menu is open, and end any gesture in progress when the More sheet or Settings opens. Sheets have an explicit maximum height and scroll, and the page itself can no longer scroll or bounce. The gestures themselves are unchanged. Checked in emulation (the More sheet on a landscape phone scrolls through 641 px of content in 347 px); not yet on an iPhone.

### Separate desktop could not reach the systemd user manager
Terminal apps in the separate desktop failed with "Failed to connect to user scope bus via local transport". They start shells in systemd scopes, which needs `$XDG_RUNTIME_DIR/systemd/private`, and the private runtime directory had none. Every per-user entry in the real runtime directory is now linked into the private one, except those that belong to one desktop session. Reproduced the error with `systemd-run --user --scope` and confirmed the link fixes it. It applies the next time the separate desktop starts.

## 2026-11-11 (evening)

### Separate desktop instead of fixing the extra monitor
The owner found that the virtual display (extend mode) works but shows only wallpaper, and asked for a screen sized to the device that does not conflict with the main one. GNOME draws the top bar and dock only on the primary monitor, so an extend-mode monitor will always be bare unless it becomes primary, which would rearrange the physical desktop. Instead, deskport now runs a second, headless GNOME Shell for the same user with its own headless gnome-remote-desktop on port 3391. GNOME's supported headless setup (`gnome-headless-session@.service` through GDM) needs root and a separate login session, which GNOME does not allow alongside an existing one for the same user, so the session runs as a user unit on a private D-Bus bus and runtime directory instead. Tested here: it starts in about 5 seconds, uses 350 to 600 MB, shows GNOME's top bar, dock and desktop icons, and the main desktop's Wayland and accessibility sockets stay untouched once the runtime directory is private. The extend-mode option stays, renamed Extra monitor, with help text saying it has no top bar.

During the first test runs, before the runtime directory was made private, the second session's accessibility bus replaced the main desktop's socket at `$XDG_RUNTIME_DIR/at-spi/bus`; the socket file is now gone. Apps started on the main desktop since then may have no accessibility support (screen reader, some on-screen keyboard features) until the next login.

### Monitor scale in the separate desktop
GNOME made each client's monitor at scale 1 regardless of the DPI guacd passes, which made a 3x iPhone show text at a third of its normal size. Because the separate desktop's GNOME has its own bus and no physical monitors, deskport sets the scale there through Mutter's DisplayConfig, a temporary change that writes nothing to `monitors.xml`. Virtual monitors only offered whole-number scales that leave at least 800 × 480 logical pixels, so a 3x iPhone gets scale 2 (about 584 × 1140 logical pixels) and smaller screens get a CSS-pixel-sized desktop at scale 1. This is never done for the main desktop. Checked with a simulated 3x phone connection (GNOME reported 1168 × 2280 at scale 2); not yet seen on a real iPhone.

### Typing stalls in Data use mode
The owner reported the picture freezing while typing. Measured on the separate desktop: at Responsiveness a key took 20 ms (median) to show up, but in Data use 5 of 24 keys produced no update within 3 s and the 90th percentile was 1.5 s. The bridge queued each held frame acknowledgement 100 ms after the previous one, so a burst of frames built up a backlog. It now keeps only the newest held acknowledgement; Data use measured 39 ms median and 47 ms at the 90th percentile afterwards. If the freezes also happened at Responsiveness, the likely remaining cause is the network: at My monitor the full 4K picture can exceed a mobile connection, and frames queue behind it. Auto resolution and Low quality reduce that.

### Phone layout without the top bar
The owner said the top bar wastes space on a phone. Phones (and touch screens under 500 px tall, so landscape phones too) no longer show it; the bottom tab bar carries a status dot, and the More sheet gained the Show choice. iPhone Safari cannot hide its own bars for a page, so More, Full screen explains Add to Home Screen; from the Home Screen the page now draws behind the status bar (`black-translucent`) with a dark strip under the clock. The manifest asks for `fullscreen` display, which Android honours.

### Settings help text
The owner found the help text too long to skim but did not want shorthand. Each help line is now one or two specific sentences (for example "JPEG at 60% quality. Text is readable."), and quality and priority each have their own line.

## 2026-11-11

### Screen touch gestures reworked (*autonomous*)
Report: scrolling on the Screen view broke on iPhone. Server logs showed normal sessions and no input errors, and the gestures worked in desktop Chrome's phone emulation, so the iOS failure could not be reproduced here. An off-screen WebKitGTK run confirmed the page works in WebKit, but WebKitGTK cannot synthesise multi-touch events, so it could not exercise the gestures.

Two causes were plausible, and both are now addressed:

- **Gesture change.** The previous release made two fingers zoom and pan only, which removed the earlier two-finger scroll. Now two fingers moving together scroll the desktop and spreading or pinching zooms. One finger scrolls the desktop when not zoomed and moves around the picture when zoomed in.
- **Stuck gestures.** Guacamole creates and removes canvas layers as the desktop redraws. A touch that starts on a layer that is then removed sends its later events to a detached element, so the end of the gesture never arrived and every later one-finger gesture was ignored. Now the layers inside the display do not take pointer events (touches land on the stable display element), move and end are also watched on the window, and any new single touch clears leftover gesture state.

Verified in Chrome's phone emulation with mouse messages captured and dropped (nothing reached the desktop): one- and two-finger scroll send wheel events, a gesture whose end was lost recovers on the next tap, and one finger pans after zooming without sending input. Not yet verified on an iPhone.

### Virtual display mode built, off by default, untested (*autonomous*, with the owner's instruction "build it, test later")
The owner wants the desktop's resolution to follow the client device. In GNOME that means desktop sharing's extend mode: a virtual monitor sized to the client for the session, resized with the browser window (`resize-method=display-update`). It is a second monitor, not a mirror, and enabling it reconfigures GNOME's monitors, the kind of change that left this machine's display (one monitor connected to two GPUs) unable to draw until a re-login. So it is behind Settings, Screen, Show: Virtual display, labelled experimental, and has not been run on this machine. Mirror sessions set `screen-share-mode` back to `mirror-primary` if it was changed.

### Shrinking the picture in the bridge instead of changing the monitor
GNOME's mirror mode streams the monitor at native size and ignores the requested size. Changing the monitor mode during sessions was tried once and broke the display (above), and that code was removed. The bridge now scales coordinates and re-encodes images instead (`src/scaler.js`), which needs no change to the desktop.

### Assets under a content-hash path
The iPhone kept an old stylesheet that hid the settings toggles. Page assets are now served under `/v/<hash>/` with the page itself uncached.

### Quality presets measured, not assumed
GNOME ignores colour depth and most RDP experience flags, so a 16-bit "fast" preset did nothing. Presets were rebuilt around what measurably changes traffic: frame pacing, lossless output, re-encoding quality, and resolution.

### Look: the category standard, modelled on the Cloudflare dashboard
The owner rejected decorative directions and asked for simple and corporate, next to Cloudflare (then Vercel, Tailscale). See DESIGN.md.

### My monitor after a restart
After the computer restarts, GDM shows the login screen and nobody is signed in, so GNOME has no desktop to share and nothing listens on the desktop sharing port. guacd then reported only a generic upstream error. Before connecting My monitor or an Extra monitor, the bridge now checks the port. If it is closed and `loginctl` shows no signed-in seat session for this user, the browser is told that someone has to sign in at the computer or use the separate desktop, which needs no login. If a desktop login exists, the bridge starts `gnome-remote-desktop.service` and waits up to 3 seconds for it. GDM automatic login would avoid the wait for a physical sign-in, but it needs root and was left to the owner.
