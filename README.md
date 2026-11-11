# deskport

This computer's live screen and a persistent terminal in one browser tab, served from this machine through a Cloudflare Tunnel and gated by Cloudflare Access.

- **Screen**: GNOME's built-in desktop sharing (RDP, port 3390) → `guacd` (Docker, 127.0.0.1:4822) → WebSocket → `guacamole-common-js` in the browser. You see and control what is on the physical monitor.
- **Terminal**: `xterm.js` → WebSocket → `node-pty` → `tmux new-session -A -s web`. Closing the tab detaches; programs keep running. Reattach from any device, or locally with `tmux attach -t web`.
- **Auth**: Cloudflare Access in front, and the server itself verifies the `Cf-Access-Jwt-Assertion` JWT (issuer, audience, signature) on every request and WebSocket upgrade. WebSocket upgrades also need a same-origin `Origin`. The server only binds to loopback.

```
browser ──https──▶ Cloudflare Access ──tunnel──▶ cloudflared ──▶ deskport :7900
                                                                   ├─ /ws/screen ─▶ guacd :4822 ─RDP─▶ gnome-remote-desktop :3390
                                                                   └─ /ws/term   ─▶ node-pty ─▶ tmux "web"
```

## Keys

| Key | Action |
| --- | --- |
| Alt+1 / Alt+2 | Switch between Screen and Terminal |
| Full-screen button | Full screen. In Chrome it also captures Esc, Super and Alt+Tab for the remote side |
| Clipboard button | Sends your local clipboard to the remote desktop. Copying on the remote side fills your local clipboard |

## Files outside the repo

| Path | What |
| --- | --- |
| `~/.config/deskport/deskport.env` | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, optional `DESKPORT_ALLOWED_EMAILS` (see `deskport.env.example`) |
| `~/.config/deskport/rdp.env` | Generated RDP username/password that GNOME desktop sharing accepts |
| `~/.config/deskport/rdp-tls.{crt,key}` | Self-signed TLS cert for GNOME desktop sharing |
| `~/.cloudflared/deskport.yml` | Tunnel ingress (see `deploy/cloudflared.example.yml`) |

## Run

```bash
npm install
npm test
npm run dev        # http://127.0.0.1:7900, Access checks OFF, for local testing only
```

Production runs as systemd user services (lingering is on, so they run without a login):

```bash
docker compose -f deploy/docker-compose.yml up -d
ln -sf ~/code/deskport/deploy/deskport.service ~/.config/systemd/user/
ln -sf ~/code/deskport/deploy/deskport-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now deskport deskport-tunnel
journalctl --user -u deskport -f
```

GNOME desktop sharing setup (already done on this machine):

```bash
grdctl rdp set-tls-cert ~/.config/deskport/rdp-tls.crt
grdctl rdp set-tls-key ~/.config/deskport/rdp-tls.key
grdctl rdp set-credentials "$RDP_USERNAME" "$RDP_PASSWORD"
grdctl rdp set-port 3390 && grdctl rdp disable-port-negotiation
grdctl rdp disable-view-only && grdctl rdp enable
systemctl --user enable --now gnome-remote-desktop
```

## Notes

- `node-pty` is a native module built for the Node version in use (fnm `default`, Node 24). After changing the default Node major version, run `npm rebuild node-pty`.
- Desktop sharing needs a logged-in GNOME session. If the screen is locked, you see the lock screen and can unlock it remotely.
- GNOME desktop sharing listens on all interfaces on port 3390, protected by its own username/password and TLS. Block it in a firewall if this machine is on an untrusted LAN; deskport only needs it on loopback.
