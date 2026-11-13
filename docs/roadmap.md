# Roadmap: fast path, hub and agents

Status: phases 0 and 1 done, phase 2 next (2026-11-13). This page is the map for the next stage of deskport. Each phase ends with something that works and is measured; nothing is removed until its replacement matches it. Update the status column as phases land, and log choices in [decisions.md](decisions.md).

## Goals

1. **As fast as possible.** Lowest delay from a key or touch to the changed pixels, at the least data, on fast and slow links.
2. **Many machines.** Install one thing on a machine, join it to a hub with a token, and it shows up in the UI with its screen, terminal and metrics.
3. **Machine overview.** A picker (list or grid, sorting, search, own order) and a dashboard per machine: CPU, memory and swap, pressure, GPU, disks, network, temperatures.
4. **Organized code and docs.** One protocol spec that the hub and every agent follow, code split by role, docs split the same way.

Platforms: Linux now (GNOME desktops and machines without a desktop). Windows is on the roadmap, so nothing in the protocol or hub may assume Linux. macOS is not planned.

## Where the time goes today

Measured so far (see decisions.md, 2026-11-11 and 2026-11-12):

| Stage | Today | Notes |
| --- | --- | --- |
| Images path | GNOME RDP encode → guacd decodes and re-encodes as PNG/JPEG → base64 text → bridge re-encodes as WebP → browser decodes | Up to four encodes per frame. 7.2 MB of base64 for a 10 s test that took 660 KB as AV1. |
| Video path | Mutter ScreenCast → GStreamer → `nvh264enc` (1.3 ms at 1280 × 720) or `av1enc` (8 ms) → WebCodecs | Already skips guacd for the picture. Input, pointer and clipboard still go browser → guacd → RDP → GNOME. |
| Keystroke to pixel | Bench baseline (decisions.md, "Bench and baseline"): 52 ms images, 43 ms AV1, 37 ms H.264 on loopback; one round trip plus 40 to 60 ms on slow links | Images fall 42 s behind on 1 Mbit/s during large changes, and guacd then disconnects. |
| Node's own work | Parsing and forwarding Guacamole text, WebP via sharp (libvips) | Not profiled. Rewriting this layer in another language alone is not expected to matter; removing stages is. |

## Target shape

```
browser ─▶ Cloudflare Access ─▶ hub (UI, auth, registry, metrics store, relay)
                                  ▲            ▲             ▲
                       control WS │  stream WS │   stream WS │   (all dialled out by the agent)
                                  │            │             │
                           agent (this desktop)   agent (server)   agent (Windows, later)
                           capture, encode,       terminal,        capture, encode,
                           input, terminal,       metrics          input, ConPTY, metrics
                           metrics
```

- **Hub.** Serves the page, checks Cloudflare Access, keeps the host registry, stores recent metrics, mints join tokens, and relays bytes between browsers and agents without decoding them. Stays Node: it is I/O and already has the auth, UI serving and tests. It can run on any machine; it starts on this desktop.
- **Agent.** One binary per machine, run as a systemd user service (a Windows service later). Dials out to the hub, so a machine needs no tunnel, Access application or open port of its own. Does capture, encode, input, terminal and metrics for its machine. Written in Rust (see "Language" below).
- **Local mode.** A machine with the hub and an agent works as today with no other machines. A hub can also run with no local agent.

This replaces the earlier design in [multi-host.md](multi-host.md), where the controller dialled each host's own tunnel with a Cloudflare service token. The owner chose dial-out on 2026-11-12. The groundwork there (`/h/<id>/` routing, `public/js/host.js`, `/api/host`) carries over.

## Protocol

Specified in [protocol.md](protocol.md) (version 1, phase 1) and versioned. Both sides reject versions they do not know.

- **Control socket.** One WebSocket per agent, kept open, JSON messages: hello (agent id, version, OS, capabilities), heartbeats, metrics samples, "open stream" requests from the hub, configuration changes, update offers.
- **Stream sockets.** One WebSocket per screen, terminal or file session, dialled by the agent when the hub asks, so a video frame never queues in front of a keystroke. The hub pairs it with the browser's socket and copies frames through unchanged.
- **Screen stream.** Binary video frames in the format `/ws/video` uses today (frame number, keyframe flag, codec data), JSON for configuration, acknowledgements, input, pointer shape and clipboard. Acknowledgements keep driving `ratecontrol.js`'s logic, which moves into the agent.
- **Terminal stream.** The current `/ws/term` messages, including flow control and pings.
- **Authentication.** A join token minted in the hub UI (one use, expires in 15 minutes) is exchanged for a per-agent key pair; the hub stores the public key and the agent signs each connection. The agent's path into the hub (`/agent/*`) gets its own Access application with a Bypass policy, since an agent cannot sign in as a person; the hub checks the agent's signature (decided in phase 1, decisions.md 2026-11-13).

## Fast screen path

Replace RDP and guacd with GNOME's own APIs, which the separate desktop already exposes on its private bus (checked 2026-11-12: `org.gnome.Mutter.RemoteDesktop` version 1 with keyboard, pointer and touchscreen, and `org.gnome.Mutter.ScreenCast` version 4):

- **Picture.** A RemoteDesktop session with a linked ScreenCast session (`RecordMonitor` for My monitor, `RecordVirtual` for the separate desktop and extra monitors, sized and scaled to the browser) → PipeWire → encoder → stream socket → WebCodecs.
- **Input.** `NotifyKeyboardKeysym`, `NotifyPointerMotionAbsolute`, buttons, axis and touch on the same session. No RDP, no guacd, one hop fewer each way.
- **Clipboard.** RemoteDesktop's selection methods. Verify they exist in GNOME 50 before relying on them.
- **Pointer.** Draw it in the browser from cursor metadata (ScreenCast `cursor-mode` metadata) instead of into the video, so it moves at input speed.
- **Encoders.** NVENC H.264 first (the GTX 1650 SUPER encodes 3840 × 2160 at 30 fps). Measure NVENC HEVC, which Safari decodes in hardware on Apple devices, and H.264 4:4:4 for sharper text. AV1 stays on the processor (libaom realtime) since neither card encodes AV1.
- **Text sharpness.** Measure a lossless refresh of still regions after motion stops (encode an I-frame at high quality once the picture is idle), compared against higher bitrate.
- **Fallback.** An images mode from the agent (WebP or JPEG tiles of changed regions) for browsers without a working decoder, so guacd can be retired.
- **Direct links later.** WebRTC over Tailscale or the local network (UDP, no Cloudflare hop) when both ends can reach each other; the hub relay stays the default.

Each change is measured with the bench (phase 0) against the current path before it becomes the default.

## Metrics

Collected by the agent, sent on the control socket every second while someone is viewing that machine's dashboard and every 15 s otherwise.

- Linux sources: `/proc/stat` (per core), `/proc/meminfo` (memory, swap, cache), `/proc/pressure/{cpu,memory,io}`, `/proc/loadavg`, `/proc/diskstats` and mounts, `/proc/net/dev`, `/sys/class/hwmon` (k10temp, nvme and others), NVML for NVIDIA GPUs (utilization, encoder and decoder utilization, memory, temperature, power), top processes by CPU and memory, uptime, systemd units deskport cares about.
- Windows later: PDH counters and NVML.
- The hub keeps one hour at 5 s resolution in memory per host; SQLite for longer history only if the owner wants it.
- Dashboard per machine: current values and short sparklines, built to DESIGN.md (Cloudflare-dashboard style).
- Picker: list or grid, sort by name, status, CPU, memory, last seen or the owner's own order (drag), search by name, OS, tags and address. Order and view are stored on the hub per person, so they follow the owner across devices.

## Language

- **Hub: Node**, as now.
- **Agent: Rust.** The deciding reasons are a single static binary to install, Windows later (Desktop Duplication or Windows.Graphics.Capture, Media Foundation or NVENC, SendInput, ConPTY), and no garbage collector pauses in the frame path. GStreamer has maintained Rust bindings, so the current encoder pipelines carry over. Go was considered: simpler, but GStreamer through cgo is awkward and Windows capture bindings are thinner.
- The language is not where the speed comes from. Removing guacd, RDP and the extra encodes is. The bench must show each gain.

## Repository layout (target)

```
hub/        Node: server, auth, registry, relay, metrics store
shim/       Node agent shim: today's host code, speaking the protocol on loopback until the Rust agent replaces it
agent/      Rust crate: capture, encode, input, terminal, metrics, install and update
web/        the page
docs/       architecture.md (overview), hub.md, agent.md, protocol.md, roadmap.md, decisions.md, setup.md
bench/      the bench, older measurement scripts and saved baselines
scripts/    host helpers still needed (desktop-session.sh and friends) until the agent absorbs them
test/       hub tests; agent tests live in agent/
```

Moves happen in their own commits with no behaviour change, so history stays readable.

## Phases

| # | Phase | Done when | Status |
| --- | --- | --- | --- |
| 0 | **Bench.** One harness that records keystroke-to-pixel, capture-to-encode, frame delivery and bytes per minute on the separate desktop, at simulated links (loopback, 4 Mbit/s and 150 ms, 1 Mbit/s and 400 ms), and saves results under `bench/results/`. | Baseline for images, AV1 and H.264 saved. | done (2026-11-12, `bench/results/2026-11-12-baseline.json`) |
| 1 | **Protocol and split.** Write `docs/protocol.md`. Move code into `hub/` and `web/`. The current host code talks to the hub over the protocol on loopback (a Node "agent shim"), so nothing visible changes. | Tests pass, bench unchanged within noise. | done (2026-11-13, `bench/results/2026-11-13-relay.json`; the relay is the default, `DESKPORT_RELAY=0` keeps the in-process path until the owner has run it) |
| 2 | **Rust agent: metrics and terminal; join flow.** Agent binary with control socket, metrics and the tmux terminal; join tokens in the hub UI; install script that puts the binary and a systemd user unit in place. A second Linux machine joins. | A machine without a desktop shows in the hub with its terminal and metrics. | planned |
| 3 | **Picker and dashboard.** Host list or grid, sorting, search, own order, status; dashboard per machine; per-host settings (`deskport.settings.<id>`) and the remembered host. | Usable on phone and desktop; checked in emulation, iPhone by the owner. | planned |
| 4 | **Fast screen path in the agent.** Mutter RemoteDesktop and ScreenCast, encoders, pointer, clipboard, separate desktop scale, images fallback. Behind a setting until the bench shows it at least as good as the current path everywhere. | Default for the separate desktop; then My monitor after the owner tries it. guacd removed when nothing uses it. | planned |
| 5 | **Updates and packaging.** Agent self-update offered by the hub (signed builds), uninstall, release builds for x86_64 and aarch64 Linux. | A version bump reaches every agent. | planned |
| 6 | **Direct links.** WebRTC over Tailscale or LAN with the hub relay as fallback. | Bench shows the gain on the tailnet. | planned |
| 7 | **Windows agent.** Capture, encode, input, ConPTY terminal, metrics, Windows service. | A Windows machine joins and streams. | later |

## Rules that still apply

Everything in `CLAUDE.md`: no input into My monitor in tests (the RemoteDesktop session on the main desktop injects real input, so test input only on the separate desktop's private bus), no display configuration changes on the main desktop, at most a few heavy builds at once (15 GB of memory; a Rust release build counts as heavy), stop test servers, keep the repo machine-neutral, commit and push to `main`.
