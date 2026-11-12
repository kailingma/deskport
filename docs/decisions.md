# Decisions

Choices made while building deskport, newest first, with the reason for each. Entries marked *autonomous* were made while the owner was away and asked for choices to be made and logged.

## 2026-11-11 (night)

### Multi-host groundwork, no visible change
The owner wants deskport to grow into a system where each machine runs its own server, the UI is optional per machine, and one host can control several. Asked for the possibility and stubs only. The server is now split into `api.js`, `ui.js` and `hosts.js`; every endpoint also answers under `/h/<id>/`; `DESKPORT_UI=0` drops the page; `/api/host` describes a host's capabilities; and every URL in the page goes through a host object. Requests for other hosts return 501. The chosen design, forwarding through the controller with a Cloudflare Access service token instead of the browser opening each host directly, and the remaining steps are in docs/multi-host.md.

### Terminal drawn past its area
The owner saw the terminal and tmux's status bar end up off screen. xterm's fit addon sizes the terminal from its parent's computed height, which with `box-sizing: border-box` includes the parent's padding, and subtracts only the terminal element's own padding. The 20 px of vertical padding on the container therefore made the terminal up to a row too tall (and up to a column too wide). The padding moved onto the terminal element. Checked in phone emulation: the last row ends 19 px above the area's bottom edge and the status bar is fully visible.

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
