#!/bin/sh
# Removes deskport-agent for the current user: what install-agent.sh put in place.
#
#   curl -fsSL https://<hub>/agent/v1/uninstall.sh | sh
#   scripts/uninstall-agent.sh                                (from a checkout)
#
# What it does: stops the agent, removes the systemd user unit or, on a
# machine without a systemd user session, the restart loop and its crontab
# @reboot entry, then deletes ~/.local/bin/deskport-agent and the settings
# (~/.config/deskport-agent, including the machine's key). It works when the
# binary is already gone. It leaves tmux installed.
#
# The hub keeps listing the machine (offline) until it is removed there:
# Remove on the machine's dashboard.
# Windows: & "$env:LOCALAPPDATA\Programs\deskport-agent\deskport-agent.exe" uninstall
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'deskport-agent uninstall: %s\n' "$*" >&2; exit 1; }

case ${1:-} in
  "") ;;
  *) die "usage: uninstall-agent.sh (takes no arguments)" ;;
esac
case $(uname -s) in
  Linux) ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows, run in PowerShell: & \"\$env:LOCALAPPDATA\\Programs\\deskport-agent\\deskport-agent.exe\" uninstall" ;;
  *) die "$(uname -s) is not supported by deskport-agent." ;;
esac

if [ -n "${DESKPORT_AGENT_CONFIG_DIR:-}" ]; then CONF=$DESKPORT_AGENT_CONFIG_DIR
else CONF="${XDG_CONFIG_HOME:-$HOME/.config}/deskport-agent"; fi
BIN_DIR="$HOME/.local/bin"
AGENT="$BIN_DIR/deskport-agent"
RUNNER="$BIN_DIR/deskport-agent-loop"
PIDFILE="$CONF/agent-loop.pid"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/deskport-agent.service"
FOUND=0

# For the closing message: which hub and id this machine joined as.
HUB=""; ID=""
if [ -f "$CONF/agent.json" ]; then
  HUB=$(sed -n 's/.*"hub" *: *"\([^"]*\)".*/\1/p' "$CONF/agent.json" | head -n 1)
  ID=$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' "$CONF/agent.json" | head -n 1)
fi

# ---------- stop it ----------

if [ -f "$UNIT" ]; then
  FOUND=1
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now deskport-agent.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl --user daemon-reload || true
  else
    rm -f "$UNIT"
    say "note: no systemd user session here, so the unit was removed without stopping it"
  fi
  say "removed $UNIT"
fi

# The restart loop: TERM makes it stop its agent and exit.
if [ -f "$PIDFILE" ]; then
  FOUND=1
  PID=$(cat "$PIDFILE" 2>/dev/null || true)
  case $PID in
    ''|*[!0-9]*) ;;
    *) if kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null || true; say "stopped the restart loop (pid $PID)"; fi ;;
  esac
fi
# Anything left: a loop without a pidfile, or an agent started by hand.
if command -v pkill >/dev/null 2>&1; then
  pkill -f "^/bin/sh $RUNNER" 2>/dev/null && say "stopped another restart loop" || true
  pkill -f "^$AGENT run" 2>/dev/null && say "stopped a running deskport-agent" || true
fi

if command -v crontab >/dev/null 2>&1; then
  CRON=$(crontab -l 2>/dev/null || true)
  case $CRON in
    *deskport-agent-loop*)
      FOUND=1
      printf '%s\n' "$CRON" | grep -v deskport-agent-loop | crontab -
      say "removed the crontab @reboot entry" ;;
  esac
fi

# ---------- files ----------

for f in "$RUNNER" "$AGENT"; do
  if [ -e "$f" ]; then FOUND=1; rm -f "$f"; say "removed $f"; fi
done
if [ -d "$CONF" ]; then
  FOUND=1
  rm -rf "$CONF"
  say "removed $CONF"
fi

if [ "$FOUND" -eq 0 ]; then
  say "deskport-agent is not installed for $(id -un) (nothing in $BIN_DIR, $CONF or the systemd user units)"
  exit 0
fi
if [ -n "$HUB" ]; then
  say "Done. The hub at $HUB still lists this machine${ID:+ ($ID)} until you use Remove on its dashboard."
else
  say "Done. If a hub still lists this machine, use Remove on its dashboard."
fi
