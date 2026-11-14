#!/bin/sh
# Installs deskport-agent for the current user and joins this machine to a hub.
#
#   curl -fsSL <hub>/agent/v1/install.sh | sh -s -- <hub> <join token> [--name <name>]
#   scripts/install-agent.sh <hub> <join token> [--name <name>] [--binary <path>]
#
# Puts the binary in ~/.local/bin, joins the hub (the settings go to
# ~/.config/deskport-agent), and runs it as the systemd user unit
# deskport-agent.service. Without --binary it downloads the build for this
# machine from the hub, which needs the join token, so mint a fresh one in the
# hub first.
set -eu

usage() { echo "usage: install-agent.sh <hub url> <join token> [--name <name>] [--binary <path>]" >&2; exit 2; }
[ $# -ge 2 ] || usage
HUB=${1%/}
TOKEN=$2
shift 2
NAME=""
BINARY=""
while [ $# -gt 0 ]; do
  case $1 in
    --name) NAME=${2:?}; shift 2 ;;
    --binary) BINARY=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if [ -n "$BINARY" ]; then
  cp "$BINARY" "$TMP"
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  echo "downloading deskport-agent for $OS-$ARCH from $HUB"
  curl -fsSL -H "Authorization: Bearer $TOKEN" "$HUB/agent/v1/download/$OS-$ARCH" -o "$TMP"
fi
# A running agent keeps its file busy; install puts a new file in its place.
install -m 755 "$TMP" "$BIN_DIR/deskport-agent"
echo "installed $BIN_DIR/deskport-agent ($("$BIN_DIR/deskport-agent" version))"

if [ -n "$NAME" ]; then
  "$BIN_DIR/deskport-agent" join "$HUB" "$TOKEN" --name "$NAME"
else
  "$BIN_DIR/deskport-agent" join "$HUB" "$TOKEN"
fi

command -v tmux >/dev/null 2>&1 || echo "note: tmux is not installed; the hub shows no terminal for this machine until it is"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/deskport-agent.service" <<'UNIT'
[Unit]
Description=deskport agent (this machine in a deskport hub)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/deskport-agent run
Restart=always
RestartSec=5
# 3: the hub removed this machine; join again before it may restart.
RestartPreventExitStatus=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable deskport-agent.service >/dev/null 2>&1
  systemctl --user restart deskport-agent.service
  echo "started deskport-agent.service"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" = "no" ]; then
    echo "To keep it running while you are logged out, run once: sudo loginctl enable-linger $(id -un)"
  fi
else
  echo "No systemd user session here. Start the agent with: $BIN_DIR/deskport-agent run"
fi
