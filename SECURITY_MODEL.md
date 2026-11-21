# Security model

How deskport is meant to be attacked and defended. Security scans read this file to judge their findings. Sections marked *(owner)* record what the owner decided; everything else is read from the code and docs. Keep it up to date when a trust boundary changes.

## System overview and trust boundaries

deskport serves a Linux desktop's live screen and a tmux terminal to a browser, plus a hub that relays to other machines running an agent. Path: browser → Cloudflare Access → cloudflared tunnel → hub on 127.0.0.1:7900 → agent shim (child process, loopback) → guacd (127.0.0.1:4822) → gnome-remote-desktop RDP (*:3390, separate desktop *:3391) / node-pty → tmux. Joined machines run the Rust agent (`agent/`) and dial the hub over the tunnel.

Trust boundaries:
1. Internet → Cloudflare Access (outside this repo; configured in the Cloudflare dashboard).
2. Access → hub: hub re-verifies the Access JWT (`hub/auth.js`) on every request/WebSocket; WebSocket `Origin` must equal `Host`; mutating API routes are same-origin only.
3. Signed-in person → machine: Read/Edit grants and admin role (`hub/access.js`, `hub/api.js`, `hub/stream-access.js`, `shim/readonly.js`).
4. Hub ↔ agent: Ed25519-signed upgrades with nonces (`hub/protocol.js`, `hub/agents.js`), one-use join tokens (`hub/registry.js`), signed agent updates (`hub/releases.js`, `agent/src/update.rs`).
5. Host processes ↔ other local users: unix sockets in `$XDG_RUNTIME_DIR` (xdg-open socket, `shim/opener.js`), RDP ports bound on all interfaces, guacd on loopback.

## Components

| Component | Code | Side of boundary |
| --- | --- | --- |
| Web client | `web/` | Browser |
| Hub auth & access | `hub/auth.js`, `hub/access.js`, `hub/stream-access.js`, `hub/config.js` | Hub |
| Hub API & UI | `hub/api.js`, `hub/server.js`, `hub/ui.js`, `hub/hosts.js`, `hub/machines.js`, `hub/prefs.js` | Hub |
| Agent relay & joining | `hub/agents.js`, `hub/protocol.js`, `hub/registry.js`, `hub/releases.js`, `shim/agent.js` | Hub ↔ agent |
| Host shim | `shim/` (guac, scaler, video, direct, terminal, files, opener, session, monitors), `bin/xdg-open` | Host |
| Rust agent | `agent/` | Joined machine |
| Host scripts & deploy | `scripts/`, `deploy/`, `deskport.env.example` | Host / install |

## Entry points and who can reach them

- `/`, `/v/<hash>/*`, `/api/*`, `/h/<id>/api/*`, `/ws/screen|video|term` — anyone Cloudflare Access lets through, then `mayEnter()` and per-machine grants.
- `/agent/v1/join` — unauthenticated except for the one-use join token in the body.
- `/agent/v1/install.sh`, `/install.ps1`, `/uninstall.sh` — served before the person check (whether Access fronts them depends on the Access policy).
- `/agent/v1/download/:platform` — join token or agent signature.
- `/agent/v1/control`, `/agent/v1/stream/<id>` — signed agent upgrades.
- Local: `$XDG_RUNTIME_DIR/deskport/open-<port>.sock` (mode 600), RDP 3390/3391 on all interfaces, guacd 127.0.0.1:4822.

## Assets

- Full control of the host desktop and a shell as the owner (terminal = arbitrary code execution as that user).
- Joined machines' desktops and shells via agents.
- `access.json` grants, admin role, join tokens.
- Release signing key (`release.key`) and the agent update channel — compromise reaches every joined machine.
- RDP credentials (`rdp.env`), Access config, agent private keys (`agents.json` holds public keys).
- Files on the host reachable through xdg-open tokens.

## Attacker profiles

- Internet attacker without an Access identity (blocked at boundary 1/2; relevant for `/agent/v1/*` routes and any JWT/Origin bypass).
- Signed-in non-admin with Read on some machines trying to gain Edit, other machines, or admin.
- Malicious or compromised joined agent trying to reach the hub, other machines or browsers.
- Malicious web page in the user's browser (CSRF/cross-site WebSocket).
- Local user on the host (RDP ports, unix sockets).

Who can get an account: *(owner: not yet stated)*

## Existing controls

JWT verification with issuer/audience (jose, JWKS); Origin check on upgrades; same-origin checks on mutating routes; CSP `default-src 'self'`, X-Frame-Options DENY, nosniff, no-referrer; server refuses non-loopback bind; secrets stripped from the terminal environment; read-only input filtering in the hub and again in local/Rust handlers; stream close on grant change; join tokens hashed, 15 min, one use, issuer rechecked; Ed25519 upgrade signatures with nonce replay protection; signed agent builds; xdg-open files served under random tokens with a sandbox CSP for scriptable types; config files mode 600.

## Out of scope / accepted risk

*(owner: not yet stated)*

## Open questions

- Who can get past Cloudflare Access?
- Which assets matter most?
- What is out of scope or accepted risk (local users, Windows agent, dev mode)?
- Does the Access policy cover `/agent/v1/*`, or is it bypassed for agents?
