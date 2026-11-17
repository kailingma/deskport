# Decisions

Choices made while building deskport, newest first, with the reason for each. Entries marked *autonomous* were made while the owner was away and asked for choices to be made and logged.

## 2026-11-16

### Windows agent without a screen (roadmap phase 7, first part)
The agent builds for x86_64 Windows with metrics, a ConPTY terminal, joining, updates, a runner at logon and uninstall; `scripts/install-agent.ps1` (served as `/agent/v1/install.ps1`) installs it, and Add machine has a Windows choice. Nothing has run on Windows: there is no Windows machine or Wine here. What was checked on Linux is listed in windows.md, "What has been checked". The screen is designed there and not built.

Choices (*autonomous*):
- **Cross-compiled with cargo-zigbuild for `x86_64-pc-windows-gnu`**, as for aarch64 Linux, because mingw-w64 is not installed and installing it needs sudo. Zig compiles ring and links; the result needs only DLLs that ship with Windows 10. The MSVC target would need the Windows SDK's libraries (cargo-xwin downloads them under Microsoft's licence), so it was not tried. An Arm build does not link with Zig (no unwinder for `aarch64-pc-windows-gnullvm`), so Windows on Arm uses the x86_64 build under emulation for now.
- **`windows-sys` for the system calls**, already in the dependency tree through tokio, rather than a crate such as sysinfo or portable-pty: the agent needs a dozen calls, and the Linux side reads `/proc` directly too.
- **A scheduled task at logon, not a Windows service**, as the task asked: a service runs in session 0, where neither the user's shell nor a later screen capture belongs. The cost is that the agent runs only while the user is logged on. A service that starts a helper in the console session is the later step for the lock screen and UAC prompts (windows.md, Screen).
- **The agent restarts itself with `deskport-agent service`**, a runner inside the same binary, instead of Task Scheduler's restart setting, whose handling of exit statuses could not be checked here and which has no way to say "do not restart after 3". It keeps the Linux unit's rules (75 at once, 3 never, else 5 s) and puts itself in a job object so ending the task ends the agent and its shells.
- **`conhost.exe --headless` hides the console window.** The agent stays one console program so `join`, `version` and `uninstall` print to the terminal they are run from. `--headless` is the mode the pseudo console uses and is not documented for direct use; windows.md names the fallback (a Windows-subsystem build of the runner) if it shows a window.
- **The terminal keeps one shell per agent that outlives connections** and replays the last 256 KB to a new one, instead of a shell per connection, because the page reconnects often on a phone and a shell per connection would lose its state each time. Several connections share the shell, as tmux clients do. A connection that falls far behind is closed (1013) and reconnects with the replay, rather than slowing the shell for every viewer, which is what tmux avoids too. A connection taking over from the previous one was rejected: the page reconnects on every close, so two open pages would take it from each other in a loop.
- **Commit instead of swap** in the memory sample (`commitB`, `commitLimitB`, protocol.md): Windows has no separate swap total that means the same thing, and the dashboard shows commit when it is present.
- **`dotfiles: 'allow'` on the hub's agent file routes.** Express's `sendFile` refused the install script and builds when the checkout's path has a dot directory (this worktree is under `~/.t3/`); the paths are fixed by the hub, not taken from the request.

### Machines per person, admins from the environment
The owner asked for computers limited to certain users, set in an admin interface, with admins chosen in the environment "or however you'd like". Admins are `DESKPORT_ADMIN_EMAILS`; when it is empty, everyone in `DESKPORT_ALLOWED_EMAILS` is an admin, so an existing setup keeps full access with no change. People and their machines live in `access.json`, edited from a People dialog in the Machines view, not in the environment, so giving someone a machine needs no restart. Someone on that list may sign in even if `DESKPORT_ALLOWED_EMAILS` leaves them out, so an admin adds a person in one place (plus the Access policy, which deskport cannot change). Access is per machine only, allow or deny; no view-only or terminal-only roles yet. Cloudflare Access cannot do this part: every machine sits behind the hub's one domain. Tested with unit tests over the API and against a server signed in as a non-admin (`DESKPORT_DEV_EMAIL`); closing a live stream when access is removed is covered by code only, not run end to end.

### Cloudflare Access team renamed
Sign-ins failed with `ERR_JOSE_GENERIC` after the owner changed the Zero Trust team domain: the old domain's `/cdn-cgi/access/certs` returns 404. `CF_ACCESS_TEAM_DOMAIN` was changed on this machine; the AUD tag stayed the same. The log now names the key URL when a check fails this way.

## 2026-11-14

### My monitor while the screen is locked
The owner reported My monitor as broken. The main desktop's screen was locked (logind `LockedHint=yes`), and gnome-remote-desktop logged "Session creation inhibited" for each viewer. GNOME Shell 50 calls `inhibit_remote_access()` whenever its session mode does not allow screencasts, and the lock screen (`unlock-dialog`) inherits `allowScreencast: false`. While locked, Mutter refuses every new RemoteDesktop and ScreenCast session (a read-only `ScreenCast.CreateSession` on the main bus failed the same way) and ends running ones. So no path, RDP or direct, can show My monitor or an Extra monitor until someone unlocks it at the computer; the separate desktop is not affected. The bridge now checks `LockedHint` of this user's seat sessions before connecting, and again when guacd reports an error, and tells the browser the screen is locked instead of passing on guacd's generic error. Tested against the locked screen: the message arrives before connecting (22 ms) and, with the first check skipped, after guacd's error (1.9 s). Not changed: GNOME's automatic screen lock (`org.gnome.desktop.screensaver lock-enabled`); turning it off would keep My monitor reachable but is the owner's call.

## 2026-11-13

### Agent updates, uninstall and aarch64 builds (roadmap phase 5)
The hub offers its agent build to every joined agent that runs an older version, when it connects; the agent checks size, SHA-256 and an Ed25519 signature with the hub's release key before it replaces itself and exits with 75 for systemd to restart it. `deskport-agent uninstall` removes the unit, settings and binary. `npm run build:agent:aarch64` cross-builds a static aarch64 binary.

Checked: a 0.1.0 agent joined a test hub that had a 0.2.0 build; on connecting it was offered 0.2.0, downloaded it with a signed request (an unsigned one got 401), installed it and exited with 75; the binary then reported 0.2.0, and the next connection got no offer. Unit tests cover a changed body, a changed version and another key. `uninstall` removed the settings and the binary. Not checked: running the aarch64 build (no arm64 machine or emulator here; `file` reports a static ARM aarch64 executable), an update under systemd on another machine.

Choices (*autonomous*):
- **The hub signs builds when it serves them**, with a release key it makes on first start, rather than signing at build time with a separate offline key. Whoever controls the hub already has a shell on every agent through the terminal, so a separate key would not narrow who can push code; the signature guards against a build changed on the way or on disk, and the agent pins the key it got when it joined.
- **Updates are automatic** when an agent connects; there is no button. A version bump in `agent/Cargo.toml` and a build on the hub reach every agent.
- **cargo-zigbuild through `uvx`** for aarch64, since the machine has no cross compiler and installing one needs sudo. Zig (96 MB) went into uv's cache.
- **The agent version is 0.2.0** with this change; the shim keeps the package version and is never offered agent builds.

### Direct screen path for the separate desktop, behind a setting (roadmap phase 4, first step)
Checked first, as the roadmap asked: GNOME Shell 50.1's RemoteDesktop session (version 1) on the separate desktop's bus has keysym and keycode input, absolute and relative pointer, buttons, axis (also discrete), touch, `EnableClipboard` with `SetSelection`, `SelectionWrite` and `SelectionRead`, `ConnectToEIS` and `SetKeymap`; ScreenCast (version 4) has `RecordVirtual`. Nothing the roadmap assumed is missing.

With Settings, Screen, Direct connection (separate desktop and a video encoding only, off by default), the shim skips guacd and RDP: `scripts/video-encoder.py` creates a RemoteDesktop session with a linked virtual monitor at the browser's size and takes keys, pointer, buttons, scroll and clipboard on stdin; `shim/direct.js` speaks the few Guacamole instructions the page uses, so the page and its touch gestures are unchanged. Clipboard both ways checked: text sent from the page pasted on the desktop (`wl-paste`), and text copied from GNOME Shell's search field arrived in the page. Read in the owner-changed signal itself, the selection came back empty; reading 100 ms later works.

Bench, three runs (`bench/results/2026-11-13-direct.json`, `--query path=direct`, against the baseline). Medians:

| Link | Case | Key to pixel (p90) | Overview press | Catch-up | Overview fps | Overview KB/min | Typing KB/min | First picture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| loopback | AV1 | 43 (57) → 38 (50) ms | 37 → 23 ms | 0 → 0 | 5.1 → 17.4 | 6,673 → 11,627 | 1,062 → 1,188 | 2.2 → 0.35 s |
| loopback | H.264 | 37 (41) → 33 (36) ms | 26 → 21 ms | 0 → 0 | 4.4 → 17.1 | 1,255 → 22,898 | 1,683 → 1,968 | 2.3 → 0.47 s |
| 4 Mbit/s | AV1 | 198 (206) → 192 (194) ms | 249 → 177 ms | 0 → 69 ms | 5.2 → 17.5 | 5,014 → 11,320 | 823 → 962 | 2.6 → 0.87 s |
| 4 Mbit/s | H.264 | 190 (215) → 186 (525) ms | 197 → 176 ms | 0 → 17 ms | 4.3 → 16.1 | 2,486 → 10,629 | 1,714 → 2,110 | 2.6 → 0.93 s |
| 1 Mbit/s | AV1 | 467 (509) → 461 (467) ms | 456 → 439 ms | 1.3 → 1.2 s | 4.6 → 13.4 | 520 → 5,639 | 549 → 639 | 3.5 → 2.1 s |
| 1 Mbit/s | H.264 | 459 (935) → 458 (769) ms | 439 → 439 ms | 0.1 → 0.3 s | 4.3 → 14.4 | 588 → 4,218 | 1,141 → 964 | 3.4 → 2.0 s |

Keystrokes are 4 to 6 ms faster at the median, large changes up to 72 ms faster, and the picture starts two to six times sooner. The direct path also shows what the RDP path skipped: GNOME's overview animation at 13 to 17 frames a second instead of 4 to 5, which costs two to eighteen times the data during large changes and a little catch-up on slow links. On 4 Mbit/s with H.264, two of three runs had their slowest tenth of keys at about 525 ms (one round trip plus 340 ms), against 215 ms before.

So it stays off by default: it is not at least as good everywhere (data during motion, the H.264 tail at 4 Mbit/s).

The H.264 tail was NVENC's buffer: `vbv-buffer-size` was one second of the bitrate, so after a quiet moment one frame could take most of a second's bits, about 230 KB at 1.8 Mbit/s, or 460 ms on a 4 Mbit/s link. With 200 ms (three runs each, `2026-11-13-direct-vbv200.json`, `-direct-vbv200-1m.json`): 4 Mbit/s key p90 525 → 197 ms, typing 2,110 → 1,443 KB/min; 1 Mbit/s key p90 769 → 484 ms, median 458 → 455 ms, catch-up 291 → 348 ms. The direct path now uses 200 ms. On the RDP H.264 path the same change was mixed (`2026-11-13-rdp-vbv200.json` against the baseline: p90 41 → 48 ms on loopback, 215 → 212 on 4 Mbit/s, 935 → 799 on 1 Mbit/s; 1 Mbit/s median 459 → 467 ms and catch-up 82 → 187 ms), so that path keeps one second.

Next for the direct path: cap the frame rate during large changes by the link (the rate control already sees the queue), a pointer drawn by the browser from cursor metadata, and touch events.

Choices (*autonomous*):
- **The direct path lives in the shim and the Python encoder helper**, reusing the GStreamer pipeline that already records ScreenCast for the video encodings, not yet in the Rust agent. The bench decides first whether the path is worth it; the Rust agent can take it over once it is.
- **The bridge emulates the Guacamole instructions the page uses** instead of a new page client, so `screen.js`, its scaling, zoom and touch gestures (which the owner wants kept) stay as they are.
- **The pointer is drawn into the video** (`cursor-mode` embedded) for now; it moves with the picture, not at input speed.
- **Only the separate desktop.** A RemoteDesktop session on the main desktop injects real input into the owner's screen; the direct path never opens one there.

### Machines view and dashboard (roadmap phase 3)
Machines is the first view (Alt+1, and the first tab on phones), and deskport opens on it. It lists every machine with status, processor and memory, as a list or a grid, with search, sort and the person's own order. Choosing Screen or Terminal on a machine points both views at it; a dashboard per machine shows processor (each core too), memory, pressure, network, disks, storage, graphics, temperatures and the busiest processes, with ten-minute sparklines, sampling every second while it is open. Add machine mints a token and shows the install command. Dashboard tables have fixed column widths, so values that change every second do not move the columns. This machine's own metrics come from the shim (`shim/metrics.js`).

Checked in headless Chromium against a test hub with the Rust agent joined: list and grid at 1280 × 800, a 390 × 844 phone in light and dark, the dashboard filling in, the sparkline crosshair, the terminal of the joined machine (an echo arrived in its tmux session), the no-screen message, Add machine, reordering with arrow keys (saved to `/api/prefs`), search, and no console errors. Not checked: dragging with a finger on a real phone, iPhone Safari, and the Screen view switching between two machines that both have screens (only this machine has one).

Choices (*autonomous*):
- **Order, layout and sort are stored on the hub per person** (`prefs.json`, keyed by the Access email), as the roadmap says, so they follow the owner across devices. The machine being shown and the view are per device (`localStorage`).
- **Picture settings per machine:** the hub's own machine keeps them under `deskport.settings` as before, so nothing saved is lost; other machines under `deskport.settings.<id>`. Appearance and terminal look stay per device.
- **Charts follow DESIGN.md:** one series per sparkline in the secondary ink, no fills or second hue, a crosshair readout on hover; meters are grey, never coloured by level, since green, amber and red mean connection state only.
- **The dashboard redraws every second** but skips the redraw while the pointer is on a chart, so its crosshair stays put.
- **No machine picker in the top bar.** Machines is a view of its own, and the bar names the machine being shown.

### deskport-agent, joining, and metrics (roadmap phase 2)
Other machines run deskport-agent (`agent/`, Rust, [agent.md](agent.md)): one control socket to the hub, metrics, and the tmux terminal. A machine joins with a token minted on the hub (`POST /api/join-tokens`) and `curl <hub>/agent/v1/install.sh | sh -s -- <hub> <token>`, which downloads the agent from the hub, joins, and starts a systemd user unit. The hub keeps joined machines in `agents.json`, relays `/h/<id>/ws/term` and answers `/h/<id>/api/host` and `/h/<id>/api/metrics`.

Checked: an Alpine container (`alpine:3`, no desktop, `--network host`) joined a test hub through `install.sh` alone (download with the token, join, run), showed up online in `/api/hosts`, sent metrics (every second while asked for live, all sample fields but GPUs), and its terminal echoed through the hub in 5 ms; a screen upgrade for it got 404. A token works once; a refused join leaves the agent's saved key alone; removing the machine closes its socket with 4001 and the agent exits with status 3; after a hub restart the agent reconnected within about a second. Not checked: a second physical machine, a hub behind Cloudflare with the Bypass application, aarch64.

Choices (*autonomous*):
- **Rust installed with rustup** in the home directory (`~/.cargo`, `~/.rustup`, `--no-modify-path`, so shell profiles are unchanged). The roadmap's agent is Rust and the machine had no toolchain.
- **A static musl binary** (`x86_64-unknown-linux-musl`, 4.3 MB) so one build runs on any x86_64 Linux. ring's C code is compiled with the system `gcc`, which works for this target without musl-gcc. A release build peaked at 0.5 GB with 4 jobs.
- **The hub hands out the agent.** `/agent/v1/install.sh` is public under the Bypass policy (a shell script with nothing secret); `/agent/v1/download/<os>-<arch>` needs a join token that is still usable, in an `Authorization` header so it stays out of URLs and logs, and does not use it up.
- **Crates:** tokio, tokio-tungstenite with rustls and webpki roots, ed25519-dalek, ureq for the one join request, libc for the pseudo-terminal (`openpty`, `setsid`, `TIOCSCTTY`) instead of a pty crate. tokio-tungstenite has no permessage-deflate, so the protocol now says an agent *may* offer compression; the hub still compresses for the browser.
- **GPU figures from `nvidia-smi`** once per sample when it is installed, rather than NVML through dlopen: simpler, and a sample is once a second at most and only while a dashboard is open. About 40 ms per call here.
- **Metrics in the hub's memory**: an hour per machine, every sample for five minutes, then one per 5 s. Nothing on disk.
- **Network interfaces** from containers and bridges (`veth*`, `br-*`, `docker*`, `virbr*`) are left out of samples: this machine has twenty, and their traffic is counted on the real interface too.
- **The agent's terminal** has no xdg-open forwarding yet (`files: false`) and passes no `DESKPORT_`, `RDP_`, `CF_ACCESS_` or `GUACD_` variables to tmux, as the shim does.
- **`hosts.json` entries** (the earlier design, controller dials each host) are no longer listed in `/api/hosts`; their `/h/<id>/` paths still answer 501 with a pointer to joining instead.

### Hub and agent protocol, and the relay on loopback (roadmap phase 1)
The code is split into `hub/`, `shim/` and `web/`, and this machine's host work now reaches the browser through the protocol in [protocol.md](protocol.md): the hub starts the agent shim (`shim/agent.js`) as a child process, the shim dials the hub on loopback with signed upgrades, and the hub relays every screen, video and terminal socket unchanged. `DESKPORT_RELAY=0` keeps the in-process path for now.

Bench, three runs each (`bench/results/2026-11-12-baseline.json`, commit cbd1f49, against `bench/results/2026-11-13-relay.json`, commit 6aa755b with the relay on). Medians:

| Link | Case | Key to pixel | Overview press | Catch-up | Typing KB/min |
| --- | --- | --- | --- | --- | --- |
| loopback | images | 52 → 52 ms | 47 → 47 ms | 0 → 0 | 5,356 → 5,296 |
| loopback | AV1 | 43 → 44 ms | 37 → 38 ms | 0 → 0 | 1,062 → 1,028 |
| loopback | H.264 | 37 → 36 ms | 26 → 25 ms | 0 → 0 | 1,683 → 1,683 |
| 4 Mbit/s, 150 ms | images | 202 → 201 ms | 220 → 233 ms | 2.2 → 2.7 s | 4,245 → 4,259 |
| 4 Mbit/s, 150 ms | AV1 | 198 → 200 ms | 249 → 284 ms | 0 → 0 | 823 → 823 |
| 4 Mbit/s, 150 ms | H.264 | 190 → 189 ms | 197 → 283 ms | 0 → 0 | 1,714 → 1,714 |
| 1 Mbit/s, 400 ms | images | 458 → 457 ms | 1,105 → 1,107 ms | 42.4 → 45.0 s, guacd disconnects in both | 3,172 → 3,163 |
| 1 Mbit/s, 400 ms | AV1 | 467 → 469 ms | 456 → 455 ms | 1.3 → 0.1 s | 549 → 563 |
| 1 Mbit/s, 400 ms | H.264 | 459 → 465 ms | 439 → 438 ms | 0.1 → 0.1 s | 1,141 → 1,071 |

Terminal echo 3, 151, 402 ms in both; Ctrl+C 58 → 59, 277 → 276, 530 → 525 ms. Capture to encode unchanged (8, 1 ms).

Key to pixel, echo and Ctrl+C are within 6 ms everywhere. The overview press on 4 Mbit/s looked slower (AV1 249 → 284 ms, H.264 197 → 283 ms). H.264 alternates between about 190 and 280 ms per run in both sets. For AV1, a same-day check with the relay off and on (`2026-11-13-check-direct.json`, `2026-11-13-check-relay.json`, 4 Mbit/s AV1, three runs each) gave 267 ms without and 256 ms with the relay, and both showed the same two kinds of run: about 800 KB/min with a press near 190 ms, or about 6,000 KB/min near 270 ms. So the difference from the baseline is the separate desktop's state on the day (how much the overview draws), not the relay. The bench's overview workload is bimodal; read its press and motion columns across runs, not as one median.

So the relay is the default. The in-process path stays behind `DESKPORT_RELAY=0` until the owner has run the relay in production (deskport.service, My monitor, the iPhone), and is removed in its own commit after that.

Choices (*autonomous*):
- **`shim/` for the Node agent shim**, a top-level directory beside `hub/`, since `agent/` is reserved for the Rust crate. The shim reads the same config as the hub (`hub/config.js`) and imports `hub/protocol.js`; both go when the Rust agent replaces it.
- **Access for agents.** `/agent/*` gets its own path-scoped Cloudflare Access application with a Bypass policy, and the hub checks each agent's Ed25519 signature itself (protocol.md), instead of every agent holding a shared Access service token. A token leaked from one machine would open every agent path; a key is per machine and removable on its own. Nothing changes in Cloudflare yet: the local shim talks to the hub on loopback. The Bypass application is needed when the first other machine joins (phase 2).
- **The local agent's key** is made at each hub start, kept only in memory, and handed to the shim in its environment, which the shim deletes before it starts tmux or anything else.
- **`src/server.js` stays** as a one-line import of `hub/server.js`, because the installed `deskport.service` runs that path. `scripts/install-services.sh` now writes `hub/server.js`; rerunning it restarts the tunnel, so that is left to the owner.
- **Protocol changes before the code:** file streams carry the browser's range headers and answer single ranges with 206 (Safari needs ranges for video); close codes a peer may send pass through, 1006 and other codes become 1011; no compression between hub and agent on loopback; the hub answers `/api/host` itself.
- **No flow control in the relay.** The hub copies messages as they come, and what the browser's socket has not sent waits in the hub. `pacing.js` still sees only the first local hop's `bufferedAmount`, as before the relay, when that hop was cloudflared.

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
