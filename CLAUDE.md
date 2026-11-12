# Working on deskport

Read [docs/architecture.md](docs/architecture.md) for how it fits together, [docs/decisions.md](docs/decisions.md) for why, and [docs/multi-host.md](docs/multi-host.md) before touching hosts or paths. DESIGN.md and PRODUCT.md govern the UI.

## Run, test, deploy

- Node comes from fnm, and new shells may not have it on `PATH`. Prefix commands with `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"`.
- `npm test` runs the `node --test` suite. `npm run check` syntax-checks every file it lists; add new `src/` files to that script.
- Dev server: `.claude/launch.json` entry `deskport-dev` (port 7901, `--watch`, Access checks off), or `deskport-test` (port 7902, tmux session `deskport-test`, safe for terminal tests). The production server is `deskport.service` on 7900.
- Deploy: `systemctl --user restart deskport`. After changing a unit or `scripts/install-services.sh`, run that script instead; it also restarts the tunnel.
- Do not restart or stop `deskport-session.service` (the separate desktop) without asking: apps the owner has open in it close. Changes to `scripts/desktop-session.sh` apply on its next start.
- Commit and push to `main` when work is done (the owner has asked for that). Keep the repo machine-neutral: no hostnames, domains, emails or account IDs. Scan the staged diff for them before each commit.

## Testing without disturbing the owner

- **Never send input to My monitor** (`source=mirror`): it is the owner's live desktop. Read-only connections are fine. For anything that types or clicks, use the separate desktop (`source=session`); `scripts/measure-typing.mjs` does this.
- **Never change the main desktop's monitor configuration** (Mutter `DisplayConfig`, `monitors.xml`, display scale). It once left the display unable to draw until a re-login. Changing it on the separate desktop's private bus (`scripts/session-scale.py`, `scripts/monitor-config.py`) is safe. The Match this device setting changes it on purpose; do not turn it on in tests.
- **Terminal tests** resize the owner's tmux session `web`. Run a second server on another port with `DESKPORT_TMUX_SESSION=<throwaway>` and kill that tmux session afterwards.
- **Browser pane**: the page reconnects the last view on load, including the screen. On a fresh origin, first open `/api/host`, set `localStorage['deskport.view'] = 'term'`, then load `/`.
- **Stopping test servers**: kill the PID from `ss -ltnp`. `pkill -f <pattern>` matches your own shell's command line and kills it.
- Chrome's phone emulation has a device pixel ratio of 2, so it cannot show the 3x iPhone path. WebKitGTK cannot synthesise multi-touch. Touch behaviour and iPhone layout need the owner's phone to confirm.
- Do not print `rdp.env` or the gnome-remote-desktop credential files.

## Traps found the hard way

- `grdctl --headless rdp enable` also starts `gnome-remote-desktop-headless.service`, which conflicts with `gnome-remote-desktop.service` and stops desktop sharing. Set the headless settings with `gsettings` (see `scripts/setup-rdp.sh`).
- A second gnome-shell for the same user needs the private bus and runtime directory that `desktop-session.sh` sets up. Without them it replaces the main session's accessibility socket (`$XDG_RUNTIME_DIR/at-spi/bus`). The private runtime directory needs links to the real one's per-user entries; without the `systemd` link, terminal apps fail with "Failed to connect to user scope bus".
- Unix socket paths are limited to 108 bytes. A long `XDG_RUNTIME_DIR` fails with "Argument list too long".
- guacd turns the browser's size into a smaller desktop size using its `dpi` argument unless `dpi` is passed explicitly (a 2031 px wide window became 1352). `sessionLayout()` in `src/guac.js` passes it.
- GNOME ignores the client's DPI. Its virtual monitors offer only whole-number scales, and only when the scaled desktop keeps at least 800 × 480 logical pixels.
- GNOME mirror mode ignores the requested size, colour depth and most RDP experience flags. Measure with `scripts/measure-screen.mjs` before claiming a speed change.
- When pacing frames, coalesce held `sync` acknowledgements; never queue them. Queueing built up seconds of typing lag.
- Guacamole element lengths count code points, and `WebSocketTunnel` needs whole instructions per WebSocket frame.
- xterm's fit addon measures the terminal's parent including padding. Keep xterm inside the unpadded `.term-box`. Its viewport defaults to a black background, and xterm 6 draws its own scrollbar.
- Screen touch: Guacamole replaces canvas layers mid-gesture, so move and end are handled on the window and filtered by touch identifier. Synthetic wheel events use `DOM_DELTA_LINE`. The owner is happy with the current gestures; fix around them rather than reworking them.
- tmux closes its right-click menu when the button's release reaches it, and reads a button-less mouse motion as a release. The terminal's touch right click therefore sends only the press (`rightClick()` in `public/js/terminal.js`).
- iOS: assets are served under content-hash paths because Home Screen apps cache hard. A Home Screen app has its own cookies. iPhone Safari has no Fullscreen API. The CSP blocks inline scripts.

## Open items

- Not yet confirmed on an iPhone: copying a touch selection in the Terminal (the clipboard write waits on tmux), tmux's menu by long press or two-finger tap, xdg-open links from a Home Screen app, menus scrolling over the Screen view, the separate desktop at scale 2, the phone layout without a top bar, and the Add to Home Screen path.
- Multi-host: the steps under "What is left" in docs/multi-host.md.
- Separate desktop: Chromium browsers open on the main desktop while one is open there (one profile per process). A snap opened there holds its profile, so the same snap cannot start on the main desktop until it is closed.
- Match this device (My monitor) has never been run against the physical monitor. Never turn it on in a test; only the owner does.
- Windows XP clients: research only, docs/legacy-clients.md.
- Video encodings (Send as AV1 or H.264): tested only on the separate desktop and in headless Chromium. Not yet run on My monitor or an extra monitor, or decoded on an iPhone or in Safari. `scripts/video-encoder.py` exits with `os._exit`: GStreamer encoders here (svtav1enc at least) hang on a clean shutdown.
