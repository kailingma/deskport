# deskport-agent

One per machine. It dials out to the hub, so a machine needs no tunnel, Access application or open port of its own. It speaks [protocol.md](protocol.md). Source: `agent/` (Rust).

What it does today: the control socket, metrics, and the terminal (tmux). It has no screen yet (roadmap phase 4); this desktop's screen still comes from the agent shim (`shim/`), which the hub starts itself.

## Install and join

On the hub: build the agent (`npm run build:agent`, needs Rust) and mint a join token (see [setup.md](setup.md), step 9). On the machine:

```bash
curl -fsSL https://<hub>/agent/v1/install.sh | sh -s -- https://<hub> <join token> [--name "<name>"]
```

`scripts/install-agent.sh` does the same from a checkout, with `--binary <path>` to skip the download. It:

1. downloads the build for this machine (`/agent/v1/download/linux-x86_64`, which needs the join token in an `Authorization: Bearer` header) into `~/.local/bin/deskport-agent`,
2. runs `deskport-agent join`, which makes the machine's Ed25519 key and registers its public key with the hub,
3. writes and starts the systemd user unit `deskport-agent.service`, and prints the `loginctl enable-linger` command if the agent would stop at logout.

Without a systemd user session (a container, for example) it prints the command to start the agent instead.

## Commands

| Command | What it does |
| --- | --- |
| `deskport-agent join <hub url> <token> [--name <name>]` | Joins the hub. The name defaults to the hostname; the hub makes the id from it. The hub URL must be https, or http on loopback. |
| `deskport-agent run` | Connects and stays connected, reconnecting with backoff (0, 1, 2, 4, 8, 15 s, 20% jitter). Exits with status 3 when the hub removed the machine; the unit does not restart it then. |
| `deskport-agent uninstall` | Stops and removes the systemd user unit, the settings directory and the binary. Remove the machine on its dashboard to make the hub forget it too. |
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

## Terminal

The same messages as `shim/terminal.js` (architecture.md, Terminal): output batched for 4 ms after the first chunk, flow control with `?flow=1` (stops reading the pseudo-terminal above 128 K unacknowledged characters, counted as UTF-16 like the page does), pongs as binary JSON, a WebSocket ping every 25 s. Variables starting with `RDP_`, `CF_ACCESS_`, `DESKPORT_` or `GUACD_` are not passed to tmux. There is no xdg-open forwarding yet (`files: false`).

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
```

The musl build compiles ring's C code with the system `gcc` (`CC_x86_64_unknown_linux_musl=gcc`). A release build peaks at about 0.5 GB of memory with 4 jobs.
