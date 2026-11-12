#!/usr/bin/env bash
# Configure GNOME desktop sharing (RDP) for deskport, as the logged-in user.
# Creates a self-signed TLS cert and random credentials in the config dir,
# then points gnome-remote-desktop at them on a loopback-only-use port.
set -euo pipefail

CONFIG_DIR="${DESKPORT_CONFIG_DIR:-$HOME/.config/deskport}"
RDP_PORT="${RDP_PORT:-3390}"
command -v grdctl >/dev/null || { echo "grdctl not found: install gnome-remote-desktop" >&2; exit 1; }

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/rdp-tls.key" ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=deskport-rdp" \
    -keyout "$CONFIG_DIR/rdp-tls.key" -out "$CONFIG_DIR/rdp-tls.crt" 2>/dev/null
  chmod 600 "$CONFIG_DIR/rdp-tls.key"
  echo "created TLS cert in $CONFIG_DIR"
fi

if [[ ! -f "$CONFIG_DIR/rdp.env" ]]; then
  umask 077
  printf 'RDP_USERNAME=deskport\nRDP_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)" > "$CONFIG_DIR/rdp.env"
  echo "created credentials in $CONFIG_DIR/rdp.env"
fi
# shellcheck disable=SC1091
source "$CONFIG_DIR/rdp.env"

grdctl rdp set-tls-cert "$CONFIG_DIR/rdp-tls.crt"
grdctl rdp set-tls-key "$CONFIG_DIR/rdp-tls.key"
grdctl rdp set-credentials "$RDP_USERNAME" "$RDP_PASSWORD"
grdctl rdp set-port "$RDP_PORT"
grdctl rdp disable-port-negotiation
grdctl rdp disable-view-only
grdctl rdp enable
systemctl --user enable --now gnome-remote-desktop.service
systemctl --user restart gnome-remote-desktop.service
echo "GNOME desktop sharing is on port $RDP_PORT"

# The separate desktop (scripts/desktop-session.sh) runs gnome-remote-desktop in
# headless mode with the same credentials. Its settings are written directly:
# "grdctl --headless rdp enable" would also start gnome-remote-desktop-headless,
# which stops the desktop sharing above.
RDP_SESSION_PORT="${RDP_SESSION_PORT:-3391}"
gsettings set org.gnome.desktop.remote-desktop.rdp.headless port "$RDP_SESSION_PORT"
gsettings set org.gnome.desktop.remote-desktop.rdp.headless negotiate-port false
gsettings set org.gnome.desktop.remote-desktop.rdp.headless enable true
grdctl --headless rdp set-credentials "$RDP_USERNAME" "$RDP_PASSWORD"
echo "the separate desktop will use port $RDP_SESSION_PORT"
