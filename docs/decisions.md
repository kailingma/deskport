# Decisions

Choices made while building deskport, newest first, with the reason for each. Entries marked *autonomous* were made while the owner was away and asked for choices to be made and logged.

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
