# Hub and agent protocol, version 1

The contract between the hub and every agent. Change this page before changing either side. Nothing here may assume Linux: Windows agents follow the same protocol.

Status: version 1. The local agent (a Node shim around the current host code, `shim/`) speaks it on loopback; deskport-agent (`agent/`, [agent.md](agent.md)) speaks it from other machines, with metrics, the terminal and, on supported Wayland desktops, the screen through the desktop portal. The hub machine's existing screen paths are unchanged.

## Roles

- **Hub.** Serves the page, signs people in (Cloudflare Access), keeps the registry of agents, mints join tokens, relays streams. Never decodes a stream.
- **Agent.** One per machine. Dials out to the hub and keeps one control socket open; opens a stream socket each time the hub asks.
- **Browser.** Talks only to the hub, with the same endpoints it uses today (`/ws/screen`, `/ws/video`, `/ws/term`, `/api/...`), directly for the local machine or under `/h/<agent id>/` for any machine.

## Transport

WebSocket over HTTPS (or plain HTTP on loopback). Every agent path is under `/agent/v1/`.

The agent offers the subprotocol `deskport.1` on every socket. The hub accepts only versions it knows and otherwise answers the upgrade with 426 Upgrade Required and a `Deskport-Protocols` header listing the ones it accepts. An agent that gets a version back it did not offer closes the socket.

### Access in front of `/agent/*`

An agent cannot sign in as a person, so the hub's Cloudflare Access application gets a second, path-scoped application for `<hub hostname>/agent/*` with a **Bypass** policy, and the hub authenticates these requests itself with the agent's key (below). The hub never applies its person check to `/agent/*` and never serves anything but this protocol there. See decisions.md, 2026-11-12, "Access for agents".

## Joining

1. A signed-in person mints a join token in the hub UI (`POST /api/join-tokens`, same origin). A token is 32 random bytes, base64url, usable once, valid for 15 minutes. The hub keeps only its SHA-256.
2. The agent creates an Ed25519 key pair, keeps the private key in its config directory (mode 600), and sends:

```
POST /agent/v1/join
Content-Type: application/json

{ "token": "<join token>", "name": "<machine name>", "os": "linux", "arch": "x86_64",
  "publicKey": "<base64url of the 32-byte raw Ed25519 public key>" }
```

`os` is `linux` or `windows` and `arch` is `x86_64` or `aarch64` (Rust's names for them); the hub treats both as opaque text and uses `<os>-<arch>` as the platform of updates.

3. The hub answers `200 {"id": "<agent id>", "protocol": 1, "releaseKey": "<base64url raw Ed25519 public key>"}` and stores the public key under that id, `401 {"error": ...}` for an unknown, used or expired token, or `400 {"error": ...}` for a missing name or a bad key. The token is used up by any answer but 400. The id is a slug of the name, made unique by the hub (`a-z`, `0-9`, `-`, at most 63 characters, never `local`).

`POST /agent/v1/join` is the only plain HTTP request under `/agent/`; the token is its authentication. Removing a machine in the hub (`DELETE /api/hosts/<id>`, same origin) deletes its key; its control socket is closed with 4001, after which the agent stops reconnecting, and later connections are refused.

## Signed connections

Every upgrade to `/agent/v1/control` or `/agent/v1/stream/<stream id>` carries:

| Header | Value |
| --- | --- |
| `Deskport-Agent` | agent id |
| `Deskport-Time` | Unix time in milliseconds |
| `Deskport-Nonce` | 16 random bytes, base64url |
| `Deskport-Signature` | base64url Ed25519 signature of the UTF-8 string `deskport-agent-1\n<path and query>\n<time>\n<nonce>` |

The hub refuses (401) an unknown id, a time more than 60 s from its own clock, a nonce it has seen in the last 120 s, or a bad signature. The local agent is registered by the hub at start with a key it generates and hands to the agent process; its id is the hub's own host id. Nothing about it is special after that.

## Control socket

`GET /agent/v1/control`, one per agent, kept open. JSON text messages, each an object with a `type`. Unknown types are ignored, so either side can add messages within a version; removing or changing one needs a new version.

The agent reconnects after a drop at once, then after 1, 2, 4, 8 and 15 s (resetting after 60 s connected), with up to 20% random jitter. A new control socket from the same id replaces the old one, which the hub closes with 4000.

### Agent to hub

| type | Fields | When |
| --- | --- | --- |
| `hello` | `agent: {version, os, arch, name}`, `capabilities` (below) | First message on every control socket. |
| `capabilities` | `capabilities` (below, the complete object, not a patch) | After `welcome`, when available features or their notes change, without reconnecting. |
| `metrics` | `t` (Unix ms), `sample` (below) | Every `intervalMs` (from `welcome` or `metrics-rate`). |
| `pong` | `id` | Answer to `ping`. |
| `response` | `id`, `status`, `body` (JSON, at most 1 MB) | Answer to `request`. |
| `stream-failed` | `stream`, `message` | An `open` the agent could not serve. |

`capabilities`:

```json
{ "screen": { "sources": ["mirror", "virtual", "session"], "encodings": ["images", "av1", "h264"] },
  "terminal": true, "files": true, "metrics": true }
```

A machine without an available screen sends `"screen": null`. Optional `notes` gives plain-text explanations keyed by feature, for example:

```json
{ "screen": null, "terminal": true, "files": false, "metrics": true,
  "notes": { "screen": "No Wayland desktop is signed in on this machine." } }
```

The hub replaces the complete capability object on a `capabilities` message, including removing old notes. Malformed updates are ignored: capabilities and notes must be objects, screen must be null or an object with string arrays for sources and encodings, feature flags must be booleans, and notes and backend must be strings. Fields may be omitted by older agents; unknown fields are kept. `/api/host` returns that object; `/api/hosts` exposes `screen` as a boolean, `screenSources` and `screenEncodings` as arrays (empty when unavailable), `screenBackend` when supplied, and `screenNote` from `notes.screen` (null when absent). Older agents need not send `notes`, `backend` or capability updates.

A portal screen advertises `"screen": {"sources": ["mirror"], "encodings": ["images", ...], "backend": "portal"}`. Only installed encoders are listed. `mirror` shares the monitor chosen in the machine's portal dialog; `virtual`, `session`, monitor switching and `match=1` are not supported by this backend. The hub never interprets `backend` as an operating system.

### Hub to agent

| type | Fields | When |
| --- | --- | --- |
| `welcome` | `protocol`, `hub: {version}`, `id`, `metrics: {intervalMs}` | Answer to `hello`. The agent sends nothing else before it. |
| `ping` | `id` | Every 20 s. Either side closes a control socket that has received nothing for 60 s. |
| `open` | `stream`, `kind`, `query`, `user: {email}`, and for `file` `headers` | A browser opened a stream; the agent dials it within 10 s. |
| `request` | `id`, `method`, `path`, `query`, `body`, `user: {email}` | A browser called the machine's API. |
| `metrics-rate` | `intervalMs` | 1000 while someone views the machine's dashboard, 15000 otherwise. |
| `update` | `version`, `path`, `sha256`, `size`, `signature` | After `hello`, when the hub has a newer build for the agent's `os` and `arch` than `agent.version`. |

`stream` is 16 random bytes, base64url, made by the hub. `query` is the browser's query string unchanged (with the leading `?`, or empty); the agent validates it exactly as the endpoint does today, since the browser is not trusted to send sane values. For `file`, `query` is `token=<token>&name=<name>` from the path, and `headers` carries the browser's `range`, `if-none-match` and `if-modified-since` when present.

### Requests

The machine's API (today's `/api/session`, `/api/session/stop`, `/api/monitors`) goes over `request` and `response`, with `path` as the browser used it without the `/h/<id>` prefix. The hub answers `/api/host` itself from the agent's `hello`. The hub answers the browser with `status` and `body` as JSON, `Cache-Control: no-store`, and 504 if no response arrives within 10 s. The hub has already checked the person and, for anything but `GET`, that the request is same-origin.

## Stream sockets

`GET /agent/v1/stream/<stream id>`, dialled by the agent after `open`. The hub pairs it with the browser's socket and from then on copies every message in both directions unchanged, text as text and binary as binary, in order. A close on one side closes the other with the same code and reason. Codes a peer may send (1000, 1001, 1007 to 1014, 3000 to 4999) are passed as they are, a close without a code (1005) is passed without one, and anything else, such as a dropped connection (1006), becomes 1011. The hub sends its own WebSocket pings to the browser every 25 s; WebSocket pings and pongs are not relayed. Messages are relayed as they come, without flow control of their own: what the browser's socket has not sent yet waits in the hub.

Messages from the browser that arrive before the agent's socket are held, up to 64 messages or 256 KB, then the browser's socket is closed with 1013. If no agent socket arrives within 10 s, or the agent sends `stream-failed`, the browser's socket is closed with 1011 and the reason.

Each kind uses the messages of today's endpoint, documented in [architecture.md](architecture.md):

| kind | Browser endpoint | Messages |
| --- | --- | --- |
| `screen` | `/ws/screen` (subprotocol `guacamole`) | Guacamole instructions, as text. |
| `video` | `/ws/video?tunnel=<uuid>` | Binary frames and JSON text, as in architecture.md, Video encodings. |
| `term` | `/ws/term` | JSON text in both directions, binary control frames to the browser. |
| `file` | `GET /api/files/<token>/<name>` | First a text message `{"status", "headers"}`, then the body as binary messages of at most 64 KB, then a close with 1000. The agent answers a single byte range with 206 and `Content-Range`, and `Accept-Ranges: bytes` always. |

Portal `screen` streams use the same Guacamole subset as the local direct path: the tunnel id first, then `size` and `sync`, with `nop` and replies to internal `ping` while the portal waits for approval. `name` carries a plain-text session notice (waiting for approval, view only or unavailable clipboard); an empty `name` clears it when sharing starts with full control. The page shows notices as status and a toast, never as markup. A refused or ended share sends `error` and closes; it is not automatically retried. The stream socket still dials within 10 s: the approval wait happens after pairing, not before it.

With `encoding=images`, the portal bridge sends JPEG `img`/`blob`/`end` instructions followed by `sync`, paced by the browser's sync acknowledgements. With video it sends the picture on the paired `video` stream, with configuration, frame acknowledgements and keyframe requests as in architecture.md. If the video encoder fails, it sends a video `error` so the page can reconnect with images. Keyboard, pointer and text clipboard use the `screen` stream. The portal's granted devices and clipboard permission determine what input it accepts. One viewer is allowed per portal agent; opening another screen ends the earlier one with an explicit error.

Compression on the agent's side is negotiated per socket with permessage-deflate. An agent on another machine may offer it for `screen` and `term`, never for `video`; an agent on the hub's own machine (loopback) offers none. The hub accepts it when offered. The hub compresses for the browser independently, as today.

### Updates

`releaseKey` (from joining) is the hub's release key; the agent keeps it with its settings. A build the hub offers is signed with it: `signature` is the base64url Ed25519 signature of the UTF-8 string `deskport-agent-build-1\n<os>-<arch>\n<version>\n<sha256 hex>`. The agent fetches `path` (`/agent/v1/download/<os>-<arch>`) with the signature headers of "Signed connections" (they work on that GET as on upgrades), checks size, SHA-256 and signature, puts the new binary in place of its own, and exits with status 75 so its service manager starts the new one. It reports the result in the next `hello`. An agent that cannot check the signature (no `releaseKey`, from before this field) ignores `update`. Versions compare as dotted numbers.

## Metrics sample

Sent as `metrics.sample`. Every field is optional; an agent sends what its platform has. Counters are cumulative since boot, so the hub can compute rates from two samples and a lost sample costs nothing.

```json
{
  "uptimeS": 1234,
  "cpu": { "total": [user, nice, system, idle, iowait, irq, softirq, steal], "cores": [[...], ...], "load": [1.2, 0.8, 0.5] },
  "memory": { "totalB": 0, "availableB": 0, "cachedB": 0, "swapTotalB": 0, "swapFreeB": 0, "commitB": 0, "commitLimitB": 0 },
  "pressure": { "cpu": {"some10": 0.0}, "memory": {"some10": 0.0, "full10": 0.0}, "io": {"some10": 0.0, "full10": 0.0} },
  "disks": [ { "name": "nvme0n1", "readB": 0, "writeB": 0, "busyMs": 0 } ],
  "mounts": [ { "path": "/", "totalB": 0, "freeB": 0 } ],
  "net": [ { "name": "eth0", "rxB": 0, "txB": 0 } ],
  "temps": [ { "sensor": "k10temp Tctl", "c": 54.2 } ],
  "gpus": [ { "name": "...", "utilPct": 0, "encoderPct": 0, "decoderPct": 0, "memUsedB": 0, "memTotalB": 0, "c": 0, "powerW": 0 } ],
  "top": [ { "pid": 1, "name": "...", "cpuPct": 0.0, "rssB": 0 } ],
  "units": [ { "name": "deskport-agent.service", "active": "active" } ]
}
```

CPU times are in clock ticks as `/proc/stat` gives them (Windows agents convert to the same 100 Hz scale). Byte counts are bytes. Temperatures are degrees Celsius.

What a Windows agent sends: `cpu.total` and `cpu.cores` as user, 0, system (kernel time less idle, DPC and interrupt time), idle, 0, interrupt, DPC, 0; no `load`. `memory` has `commitB` and `commitLimitB` (committed memory and the commit limit) instead of `swapTotalB` and `swapFreeB`. `disks` are `PhysicalDrive<n>`, with `busyMs` as uptime less the disk's idle time, which grows by the busy time between samples. `mounts` are fixed drives (`C:\`). `net` names are the adapters' aliases (`Ethernet`, `Wi-Fi`). No `pressure`, `temps` or `units`.

## Changes

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-11-12 | First version. |
| 1 | 2026-11-13 | Added within version 1 (unknown fields and types are ignored): `releaseKey` in the join answer, the `update` message, signed GETs of `/agent/v1/download/`. |
| 1 | 2026-11-16 | Added within version 1: `os: "windows"`, the platform `windows-x86_64`, `memory.commitB` and `memory.commitLimitB`. |
| 1 | 2026-11-16 | Added within version 1: complete `capabilities` updates, optional capability `notes` and `screen.backend`, and portal screen session notices through Guacamole `name`. |
