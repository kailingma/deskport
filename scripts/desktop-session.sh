#!/bin/sh
# Runs the "Separate session" screen source: a second, headless GNOME desktop
# for the same user, with its own gnome-shell (no physical monitors) and its own
# gnome-remote-desktop on the headless RDP port. GNOME gives the session one
# monitor, sized to the RDP client and resized with it.
#
# The session gets a private D-Bus session bus and a private runtime directory,
# so its shell, accessibility bus, Wayland socket, portals and gvfs mounts never
# replace the ones the desktop on the monitor uses. PipeWire, PulseAudio and the
# keyring stay shared. File indexing is left to the main desktop.
set -eu
uid_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
dir="$uid_dir/deskport-session"
services="$dir/dbus-services"
rm -rf "$services" "$dir/bus"
mkdir -p "$services"
chmod 700 "$dir"

# Everything per-user in the real runtime directory is shared through links:
# the systemd user manager (apps start in its scopes), snap and flatpak
# directories, gnupg, the keyring and ssh agents, PipeWire, PulseAudio. Only
# what belongs to one desktop session stays private.
private='^(bus|wayland-.*|at-spi|dconf|doc|gvfs|gvfsd|gnome-shell.*|gnome-remote-desktop|gnome-session-.*|dbus-1|deskport-session)$'
for f in "$dir"/*; do
  [ -L "$f" ] && rm -f "$f"
done
for f in "$uid_dir"/* "$uid_dir"/.[!.]*; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  printf '%s\n' "$name" | grep -qE "$private" && continue
  [ -e "$dir/$name" ] || ln -s "$f" "$dir/$name"
done

# D-Bus services the private bus may start: every session service, minus ones
# that must exist only once per user.
skip='^org\.freedesktop\.(Tracker3|LocalSearch3)\.|^org\.freedesktop\.systemd1\.'
data_dirs="${XDG_DATA_HOME:-$HOME/.local/share}:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
# Earlier directories win, so link the later ones first and let earlier ones overwrite.
for d in $(printf '%s\n' "$data_dirs" | tr ':' '\n' | tac); do
  [ -d "$d/dbus-1/services" ] || continue
  for f in "$d"/dbus-1/services/*.service; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    printf '%s\n' "$name" | grep -qE "$skip" && continue
    ln -sf "$f" "$services/$name"
  done
done
# The systemd user manager is only on the real bus. Apps that start themselves
# in a systemd scope through the session bus (every snap, and GNOME Shell for
# the apps it launches) reach it through this relay.
here=$(cd "$(dirname "$0")" && pwd)
cat > "$services/org.freedesktop.systemd1.service" <<EOF
[D-BUS Service]
Name=org.freedesktop.systemd1
Exec=/usr/bin/python3 $here/session-systemd-proxy.py unix:path=$uid_dir/bus
EOF

cat > "$dir/bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:path=$dir/bus</listen>
  <listen>unix:abstract=/tmp/dbus-deskport-session-$(id -u)</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$services</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF

unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
export XDG_RUNTIME_DIR="$dir"
export PIPEWIRE_RUNTIME_DIR="$uid_dir"
export PULSE_SERVER="unix:$uid_dir/pulse/native"
export GNOME_KEYRING_CONTROL="$uid_dir/keyring"
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-$uid_dir/keyring/ssh}"
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome

# Snaps' AppArmor profiles allow only /run/user/<uid>/bus or an abstract
# "@/tmp/dbus-*" socket for the session bus, and /run/user/<uid>/wayland-<n> for
# Wayland. The bus also listens on an abstract socket (clients fall back to it),
# and the compositor's socket sits in the real runtime directory under a name
# the main desktop does not use. Snaps given a relative WAYLAND_DISPLAY link
# "../wayland-0", which is the main desktop's compositor.
export DESKPORT_WAYLAND="$uid_dir/wayland-90"
rm -f "$DESKPORT_WAYLAND" "$DESKPORT_WAYLAND.lock"

exec dbus-run-session --config-file="$dir/bus.conf" -- sh -c '
  gnome-shell --headless --wayland-display="$DESKPORT_WAYLAND" &
  shell=$!
  i=0
  until gdbus introspect --session --dest org.gnome.Mutter.ScreenCast \
      --object-path /org/gnome/Mutter/ScreenCast >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 150 ] && { echo "gnome-shell did not start" >&2; exit 1; }
    kill -0 "$shell" 2>/dev/null || { echo "gnome-shell exited" >&2; exit 1; }
    sleep 0.2
  done
  /usr/libexec/gnome-remote-desktop-daemon --headless &
  wait "$shell"
'
