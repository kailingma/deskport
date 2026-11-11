#!/usr/bin/env bash
# Write and start the deskport systemd user services.
#   deskport.service         the web server, using the node currently on PATH
#   deskport-tunnel.service  cloudflared, if ~/.cloudflared/deskport.yml exists
# Re-run after moving the repo or changing Node versions.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE="$(readlink -f "$(command -v node)")"
TUNNEL_CONFIG="${DESKPORT_TUNNEL_CONFIG:-$HOME/.cloudflared/deskport.yml}"
mkdir -p "$UNIT_DIR"

# fnm and nvm put node under a per-version path; prefer a stable alias when there is one.
for alias in "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.nvm/alias/default"; do
  [[ -x "$alias" && "$(readlink -f "$alias")" == "$NODE" ]] && NODE="$alias" && break
done

rm -f "$UNIT_DIR/deskport.service" "$UNIT_DIR/deskport-tunnel.service"
cat > "$UNIT_DIR/deskport.service" <<UNIT
[Unit]
Description=deskport (screen and terminal in the browser)
After=network-online.target gnome-remote-desktop.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$NODE src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT
echo "wrote deskport.service (node: $NODE)"

units=(deskport.service)
if [[ -f "$TUNNEL_CONFIG" ]]; then
  CLOUDFLARED="$(command -v cloudflared || true)"
  [[ -n "$CLOUDFLARED" ]] || { echo "cloudflared not on PATH" >&2; exit 1; }
  cat > "$UNIT_DIR/deskport-tunnel.service" <<UNIT
[Unit]
Description=Cloudflare Tunnel for deskport
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$CLOUDFLARED tunnel --no-autoupdate --config $TUNNEL_CONFIG run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  echo "wrote deskport-tunnel.service (config: $TUNNEL_CONFIG)"
  units+=(deskport-tunnel.service)
else
  echo "no $TUNNEL_CONFIG, skipping the tunnel service"
fi

systemctl --user daemon-reload
systemctl --user enable "${units[@]}"
systemctl --user restart "${units[@]}"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "note: run 'sudo loginctl enable-linger $USER' so the services start at boot without a login"
fi
systemctl --user --no-pager status "${units[@]}" | grep -E '●|Active:'
