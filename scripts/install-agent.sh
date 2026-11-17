#!/bin/sh
# Installs deskport-agent for the current user and joins this machine to a hub.
#
#   curl -fsSL https://<hub>/agent/v1/install.sh | sh -s -- <join token>
#   curl -fsSL https://<hub>/agent/v1/install.sh | sh            (asks for the token)
#   scripts/install-agent.sh <hub url> <join token> [options]     (from a checkout)
#
# Options:
#   --name <name>     the name the hub shows (default: the hostname)
#   --binary <path>   install this build instead of downloading one
#   --rejoin          join again although this machine already joined a hub
#   --no-tmux         do not offer to install tmux
#   --no-screen       do not offer to install the screen's GStreamer packages
#
# The hub fills in its own address when it serves this script, so the hub
# argument is only needed from a checkout. A join token comes from Machines,
# Add machine in the hub, or DESKPORT_JOIN_TOKEN.
#
# What it does: downloads the build for this machine into ~/.local/bin, joins
# the hub (settings in ~/.config/deskport-agent), and keeps the agent running:
# a systemd user unit where there is a systemd user session, otherwise a
# crontab @reboot entry and a start in the background. On a machine that has
# already joined, it only updates the binary and restarts the agent.
# Windows: use install.ps1 from the same hub.
set -eu

HUB=""
# Replaced by the hub when it serves this file (hub/server.js).
SERVED_BY="__DESKPORT_HUB__"
case $SERVED_BY in __*) ;; *) HUB=$SERVED_BY ;; esac
TOKEN=${DESKPORT_JOIN_TOKEN:-}
NAME=""
BINARY=""
REJOIN=0
TMUX_OFFER=1
SCREEN_OFFER=1

say() { printf '%s\n' "$*"; }
die() { printf 'deskport-agent install: %s\n' "$*" >&2; exit 1; }
usage() { die "usage: install-agent.sh [<hub url>] [<join token>] [--name <name>] [--binary <path>] [--rejoin] [--no-tmux] [--no-screen]"; }
# Questions go to the terminal: stdin is this script when it is piped into sh.
ask() {
  { printf '%s' "$1" > /dev/tty; } 2>/dev/null || return 1
  IFS= read -r REPLY < /dev/tty || return 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --name) NAME=${2:?--name needs a value}; shift 2 ;;
    --binary) BINARY=${2:?--binary needs a path}; shift 2 ;;
    --rejoin) REJOIN=1; shift ;;
    --no-tmux) TMUX_OFFER=0; shift ;;
    --no-screen) SCREEN_OFFER=0; shift ;;
    -h|--help) usage ;;
    http://*|https://*) HUB=$1; shift ;;
    -*) usage ;;
    *) TOKEN=$1; shift ;;
  esac
done
HUB=${HUB%/}
[ -n "$HUB" ] || die "no hub address; pass it first, e.g. install-agent.sh https://desk.example.com <join token>"

# ---------- this machine ----------

case $(uname -s) in
  Linux) OS=linux ;;
  Darwin) die "macOS is not supported by deskport-agent." ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows, run in PowerShell: irm $HUB/agent/v1/install.ps1 | iex" ;;
  *) die "$(uname -s) is not supported by deskport-agent." ;;
esac
case $(uname -m) in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "no deskport-agent build for $(uname -m)." ;;
esac
[ "$(id -u)" -ne 0 ] || say "note: installing for root. The agent's terminal will be a root shell; run this as the user it should be instead if that is not what you want."

if [ -n "${DESKPORT_AGENT_CONFIG_DIR:-}" ]; then CONF=$DESKPORT_AGENT_CONFIG_DIR
else CONF="${XDG_CONFIG_HOME:-$HOME/.config}/deskport-agent"; fi
JOINED=0
[ -f "$CONF/agent.json" ] && [ -f "$CONF/agent.key" ] && [ "$REJOIN" -eq 0 ] && JOINED=1

if [ "$JOINED" -eq 0 ] && [ -z "$TOKEN" ]; then
  ask "Join token (Machines, Add machine in the hub): " || die "no join token; pass it after 'sh -s --' or set DESKPORT_JOIN_TOKEN"
  TOKEN=$REPLY
fi
[ "$JOINED" -eq 1 ] || [ -n "$TOKEN" ] || die "no join token"

# ---------- the binary ----------

command -v curl >/dev/null 2>&1 || [ -n "$BINARY" ] || die "curl is needed to download the agent"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if [ -n "$BINARY" ]; then
  cp "$BINARY" "$TMP"
elif [ "$JOINED" -eq 1 ]; then
  # Already joined: the agent updates itself from the hub with signed requests.
  [ -x "$BIN_DIR/deskport-agent" ] || die "$CONF exists but $BIN_DIR/deskport-agent does not; run again with --rejoin and a join token"
  cp "$BIN_DIR/deskport-agent" "$TMP"
  say "already joined ($CONF); keeping the agent, which updates itself from the hub"
else
  say "downloading deskport-agent for $OS-$ARCH from $HUB"
  curl -fsSL -H "Authorization: Bearer $TOKEN" "$HUB/agent/v1/download/$OS-$ARCH" -o "$TMP" \
    || die "download failed. The token may be used up or expired (mint a new one), or the hub's /agent/* path may be behind a Cloudflare Access login (docs/setup.md, step 9)."
fi
# A running agent keeps its file busy; install puts a new file in its place.
install -m 755 "$TMP" "$BIN_DIR/deskport-agent"
say "installed $BIN_DIR/deskport-agent ($("$BIN_DIR/deskport-agent" version))"

if [ "$JOINED" -eq 0 ]; then
  if [ -n "$NAME" ]; then "$BIN_DIR/deskport-agent" join "$HUB" "$TOKEN" --name "$NAME"
  else "$BIN_DIR/deskport-agent" join "$HUB" "$TOKEN"; fi
fi

# ---------- tmux, for the terminal ----------

if ! command -v tmux >/dev/null 2>&1 && [ "$TMUX_OFFER" -eq 1 ]; then
  PKG=""
  if command -v apt-get >/dev/null 2>&1; then PKG="apt-get install -y tmux"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf install -y tmux"
  elif command -v yum >/dev/null 2>&1; then PKG="yum install -y tmux"
  elif command -v pacman >/dev/null 2>&1; then PKG="pacman -S --noconfirm tmux"
  elif command -v zypper >/dev/null 2>&1; then PKG="zypper install -y tmux"
  elif command -v apk >/dev/null 2>&1; then PKG="apk add tmux"
  fi
  if [ -z "$PKG" ]; then
    say "note: tmux is not installed; the hub shows no terminal for this machine until it is"
  elif [ "$(id -u)" -eq 0 ]; then
    sh -c "$PKG" || say "note: '$PKG' failed; the terminal needs tmux"
  elif command -v sudo >/dev/null 2>&1 && ask "tmux is needed for the terminal. Install it with 'sudo $PKG'? [Y/n] " && [ "${REPLY:-y}" != n ] && [ "${REPLY:-y}" != N ]; then
    sudo sh -c "$PKG" || say "note: '$PKG' failed; the terminal needs tmux"
  else
    say "note: tmux is not installed; the terminal needs it: sudo $PKG"
  fi
fi

# ---------- GStreamer, for the screen ----------

# The screen of a Wayland desktop (KDE Plasma, GNOME and others) goes through
# the desktop portal with the system's Python and GStreamer
# (scripts/portal-screen.py, which lists the same packages). Offered only
# where a Wayland desktop is installed; servers are left alone.
screen_ready() {
  python3 - <<'PY' >/dev/null 2>&1
import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gst
Gst.init(None)
need = ["pipewiresrc", "videoconvert", "videoscale", "appsrc", "appsink", "jpegenc", "h264parse"]
raise SystemExit(0 if all(Gst.ElementFactory.find(e) for e in need) else 1)
PY
}
if [ "$SCREEN_OFFER" -eq 1 ] && [ "$OS" = linux ] && command -v python3 >/dev/null 2>&1 \
  && ls /usr/share/wayland-sessions/*.desktop >/dev/null 2>&1 && ! screen_ready; then
  PKG=""
  if command -v apt-get >/dev/null 2>&1; then PKG="apt-get install -y python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf install -y python3-gobject gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free pipewire-gstreamer gstreamer1-plugin-openh264"
  elif command -v pacman >/dev/null 2>&1; then PKG="pacman -S --needed --noconfirm python-gobject gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugin-pipewire gst-plugins-ugly"
  elif command -v zypper >/dev/null 2>&1; then PKG="zypper install -y python3-gobject typelib-1_0-Gst-1_0 gstreamer-plugins-base gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugin-pipewire gstreamer-plugins-ugly"
  fi
  if [ -z "$PKG" ]; then
    say "note: the screen needs python3-gi and GStreamer with its PipeWire plugin; the hub shows what is missing"
  elif [ "$(id -u)" -eq 0 ]; then
    sh -c "$PKG" || say "note: '$PKG' failed; the screen needs these packages"
  elif command -v sudo >/dev/null 2>&1 && ask "The screen needs GStreamer packages. Install them with 'sudo $PKG'? [Y/n] " && [ "${REPLY:-y}" != n ] && [ "${REPLY:-y}" != N ]; then
    sudo sh -c "$PKG" || say "note: '$PKG' failed; the screen needs these packages"
  else
    say "note: the screen needs: sudo $PKG"
  fi
fi

# ---------- keep it running ----------

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
  say "started deskport-agent.service"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" = "no" ]; then
    say "To keep it running while you are logged out and after a reboot, run once: sudo loginctl enable-linger $(id -un)"
  fi
else
  # No systemd user session (a container, a minimal server): a loop that
  # restarts the agent like the unit would, started now and at every boot.
  RUNNER="$BIN_DIR/deskport-agent-loop"
  PIDFILE="$CONF/agent-loop.pid"
  cat > "$RUNNER" <<LOOP
#!/bin/sh
# Runs deskport-agent and restarts it, as deskport-agent.service would.
# Exit 3: the hub removed this machine, so stop. TERM stops the agent too.
echo \$\$ > "$PIDFILE"
child=""
trap '[ -n "\$child" ] && kill "\$child" 2>/dev/null; rm -f "$PIDFILE"; exit 0' TERM INT
while :; do
  "$BIN_DIR/deskport-agent" run &
  child=\$!
  wait "\$child"
  code=\$?
  child=""
  [ "\$code" -eq 3 ] && { rm -f "$PIDFILE"; exit 0; }
  sleep 5
done
LOOP
  chmod 755 "$RUNNER"
  LOG="$CONF/agent.log"
  # A loop from an earlier install: stop it and its agent first.
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  nohup "$RUNNER" >> "$LOG" 2>&1 &
  say "started deskport-agent in the background (log: $LOG)"
  if command -v crontab >/dev/null 2>&1; then
    { crontab -l 2>/dev/null | grep -v deskport-agent-loop || true; echo "@reboot $RUNNER >> $LOG 2>&1"; } | crontab - \
      && say "added a crontab @reboot entry so it starts at boot"
  else
    say "No systemd user session or crontab here; after a reboot start it with: nohup $RUNNER >> $LOG 2>&1 &"
  fi
fi
say "Done. This machine shows up under Machines in $HUB."
