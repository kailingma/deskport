# deskport-agent

One per machine. It dials out to the hub, so a machine needs no tunnel, Access application or open port of its own. It speaks [protocol.md](protocol.md). Source: `agent/` (Rust).

What it does today: the control socket, metrics, the terminal (tmux on Linux, a shell in a pseudo console on Windows) and, on Linux Wayland desktops, the screen through the desktop portal (below). The hub machine's own screen still comes from the agent shim (`shim/`, guacd, RDP and Mutter), which the hub starts itself; nothing about it changed.

This page describes Linux. The Windows build (install with PowerShell, a scheduled task at logon, ConPTY terminal, Windows metrics) is in [windows.md](windows.md); it has not run on Windows yet.

## Install and join

On the hub: build the agent (`npm run build:agent`, needs Rust) and mint a join token (see [setup.md](setup.md), step 9). Admins can also allow other people to add machines in Machines, People. A non-admin gets Edit on each machine joined with their token; the permission is rechecked when joining. On the machine:

```bash
curl -fsSL https://<hub>/agent/v1/install.sh | sh -s -- <join token> [--name "<name>"] [--rejoin] [--no-tmux] [--no-screen]
```

The hub writes its own address into the script it serves (from the request's `Host`; `hubOrigin()` in `hub/hosts.js`). `scripts/install-agent.sh <hub url> <join token>` does the same from a checkout, with `--binary <path>` to skip the download. Without a token it asks on the terminal, or takes `DESKPORT_JOIN_TOKEN`. It:

1. downloads the build for this machine (`/agent/v1/download/linux-x86_64` or `linux-aarch64`, which needs the join token in an `Authorization: Bearer` header) into `~/.local/bin/deskport-agent`; on a machine that has `agent.json` and `agent.key` already, it keeps the binary (the agent updates itself) and skips joining unless `--rejoin`,
2. runs `deskport-agent join`, which makes the machine's Ed25519 key and registers its public key with the hub,
3. offers to install tmux with apt, dnf, yum, pacman, zypper or apk (with sudo after asking; as root without asking), and, where a Wayland session is installed (`/usr/share/wayland-sessions`) and GStreamer is incomplete, the screen's packages (python3-gi, GStreamer base, good, bad and ugly plugins, the PipeWire plugin) with apt, dnf, pacman or zypper the same way; `--no-screen` skips that offer,
4. writes and starts the systemd user unit `deskport-agent.service`, and prints the `loginctl enable-linger` command if the agent would stop at logout. Without a systemd user session (a container, a minimal server) it writes `~/.local/bin/deskport-agent-loop`, which restarts the agent like the unit would and stops on exit status 3, starts it in the background with its log in the settings directory, and adds a crontab `@reboot` entry for it.

## Uninstall

```bash
curl -fsSL https://<hub>/agent/v1/uninstall.sh | sh
```

`scripts/uninstall-agent.sh` (served as `/agent/v1/uninstall.sh`, no token needed) stops the agent and removes everything step 4 above set up: the systemd user unit, or the restart loop (stopped through its pidfile, then any `deskport-agent-loop` or `deskport-agent run` left) and its crontab `@reboot` entry. Then it deletes `~/.local/bin/deskport-agent`, `deskport-agent-loop` and the settings directory with the machine's key. It works when the binary is already gone and leaves tmux installed. The hub lists the machine as offline until you use Remove on its dashboard. `deskport-agent uninstall` (below) does the same for the systemd unit but not for the restart loop or the crontab entry.

## Commands

| Command | What it does |
| --- | --- |
| `deskport-agent join <hub url> <token> [--name <name>]` | Joins the hub. The name defaults to the hostname; the hub makes the id from it. The hub URL must be https, or http on loopback. |
| `deskport-agent run` | Connects and stays connected, reconnecting with backoff (0, 1, 2, 4, 8, 15 s, 20% jitter). Exits with status 3 when the hub removed the machine; the unit does not restart it then. |
| `deskport-agent service` | Windows only: the runner the scheduled task starts ([windows.md](windows.md), How it runs). |
| `deskport-agent uninstall` | Stops and removes the systemd user unit (on Windows the scheduled task), the settings directory and the binary. Remove the machine on its dashboard to make the hub forget it too. |
| `deskport-agent version` | Version and protocol version. |

## Files and settings

| Path | What |
| --- | --- |
| `~/.config/deskport-agent/agent.json` | Hub URL, id and name. |
| `~/.config/deskport-agent/agent.key` | The private key seed (mode 600). Never leaves the machine. |
| `DESKPORT_AGENT_CONFIG_DIR` | Another directory for both files. |
| `DESKPORT_TMUX_SESSION` | tmux session the terminal attaches to (default `web`). |
| `DESKPORT_TERM_CWD` | Directory new sessions start in (default home). |
| `DESKPORT_TERM_WINDOW` | Flow control window in characters (default 131072). |
| `~/.config/deskport-agent/portal-screen.py` | The screen helper, written from the binary when it differs. |
| `~/.config/deskport-agent/screen-restore-token` | The portal's restore token (mode 600). Delete it to be asked again at the machine. |
| `~/.config/deskport-agent/screen-restore-token.readonly` | Separate ScreenCast-only consent for Read access; does not overwrite the control grant. |

## Screen

On a Wayland desktop with an xdg-desktop-portal RemoteDesktop backend (KDE Plasma with xdg-desktop-portal-kde, GNOME with xdg-desktop-portal-gnome, others), the agent shares the screen through the portal. `scripts/portal-screen.py`, carried in the binary, does the portal calls, PipeWire capture, encoding (JPEG for Images, x264enc or openh264enc with h264parse for H.264, av1enc with av1parse for AV1), input and clipboard with the system's python3 and GStreamer; `agent/src/screen/bridge.rs` turns that into the Guacamole subset the page already speaks (protocol.md, Streams).

- **Asking.** The first connection makes the portal ask at the machine which monitor to share and whether to allow control. The page shows "Waiting for someone at <machine> to allow screen sharing." meanwhile (up to 3 minutes). The answer is kept as a restore token, so later connections start without asking until it is revoked or the file is deleted.
- **Permissions.** Keyboard, pointer and clipboard are used only as far as the portal granted them, in the helper, the bridge and the page. A share without control is view only; a share whose clipboard was not explicitly allowed says "Clipboard unavailable". The page disables the matching buttons. Machine Read access starts a ScreenCast-only portal session, without requesting devices or clipboard; Edit never overrides the portal's own restrictions.
- **Video.** Images always work; H.264 and AV1 are offered only when the encoder and its parser are installed. If the encoder fails, the bridge reports it on the video stream and the page reconnects with images until the picture settings change.
- **One viewer.** Opening the screen with Edit in another window ends the earlier one with a message. A Read viewer cannot replace an existing viewer and is asked to try again after it disconnects.
- **What is missing.** The agent checks at start, then every 30 s while the screen is unavailable and every 5 minutes otherwise. The hub shows the reason and the install command on the machine's no-screen page.

Only My monitor is offered; extra monitors, separate desktops and Match this device stay with the hub machine.

## Terminal

The same messages as `shim/terminal.js` (architecture.md, Terminal): output batched for 4 ms after the first chunk, flow control with `?flow=1` (stops reading the pseudo-terminal above 128 K unacknowledged characters, counted as UTF-16 like the page does), pongs as binary JSON, a WebSocket ping every 25 s. Variables starting with `RDP_`, `CF_ACCESS_`, `DESKPORT_` or `GUACD_` (in any case) are not passed to tmux. There is no xdg-open forwarding yet (`files: false`).

With machine Read access, input and resize are dropped. Linux attaches to an existing tmux session with `read-only,ignore-size` and `-E` (no environment updates), without creating one. Windows subscribes to an existing shell without starting or resizing it. A person with Edit must open the terminal first if none is running. Version 0.4.0 adds the `readOnly` capability; older agents must update before the hub opens Read-only streams on them.

## Metrics

One sample per interval the hub sets: every 15 s, every second while someone has the machine's dashboard open. Fields as in protocol.md, "Metrics sample": `/proc/stat` (all cores and each core), `/proc/loadavg`, `/proc/meminfo`, `/proc/pressure/*`, `/proc/diskstats` (whole disks, not loop, ram, zram or dm devices), mounts of real filesystems with `statvfs`, `/proc/net/dev` (not `lo`), every `/sys/class/hwmon` temperature, GPUs from `nvidia-smi` when it is installed, and the five processes that used the most CPU since the last sample (100% is one core). The hub keeps an hour per machine in memory, at full rate for the last five minutes and one sample per 5 s before that (`GET /h/<id>/api/metrics?since=<ms>`).

## Updates

When an agent connects, the hub offers its own build for the agent's platform if that is newer than the agent (protocol.md, Updates). The agent downloads it with a signed request, checks its size, SHA-256 and the signature with the hub's release key (received when it joined, kept in `agent.json`), puts it in place of its own binary and exits with status 75; the systemd unit (`Restart=always`) starts the new version. So after `npm run build:agent` on the hub with a higher version in `agent/Cargo.toml`, every agent updates the next time it connects. The release key is `~/.config/deskport/release.key` on the hub (made on first start, mode 600). Agents that joined before release keys existed ignore offers until they join again.

## Build and test

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run test:agent     # cargo test
npm run build:agent           # static release binary, agent/target/x86_64-unknown-linux-musl/release/
npm run build:agent:aarch64   # static aarch64 build, with cargo-zigbuild through uvx (downloads Zig once)
npm run build:agent:windows   # x86_64 Windows .exe, also with cargo-zigbuild (rustup target add x86_64-pc-windows-gnu once)
```

The musl build compiles ring's C code with the system `gcc` (`CC_x86_64_unknown_linux_musl=gcc`). A release build peaks at about 0.5 GB of memory with 4 jobs.

Source layout: `metrics/` and `terminal/` have a module per platform (`linux.rs`/`unix.rs`, `windows.rs`) behind `cfg(windows)`; what both use and the arithmetic of the Windows collector are in each `mod.rs`, so `cargo test` on Linux covers them. `sys.rs` has the hostname, home directory and PATH lookup, `winsec.rs` the key file's access list, `runner.rs` the Windows runner. The hub serves the builds in `agent/target/<triple>/release/` (`hub/releases.js`).
