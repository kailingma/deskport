#!/usr/bin/env python3
"""Sets the scale of one monitor in the separate desktop (desktop-session.sh).

GNOME makes each RDP client's monitor at scale 1, which is tiny on a phone or a
HiDPI laptop. deskport runs this after the monitor appears or changes size, on
the separate desktop's private D-Bus session bus, so the desktop on the physical
monitor is never touched. The change is temporary: nothing is written to
monitors.xml.

Usage: session-scale.py BUS_ADDRESS WIDTH HEIGHT SCALE
Prints the scale applied, the closest one GNOME supports for that size.
"""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

TEMPORARY = 1


def main():
    address, width, height, wanted = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
    bus = Gio.DBusConnection.new_for_address_sync(
        address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None,
        None,
    )

    def call(method, args, reply):
        return bus.call_sync(
            "org.gnome.Mutter.DisplayConfig",
            "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig",
            method,
            args,
            GLib.VariantType(reply) if reply else None,
            Gio.DBusCallFlags.NONE,
            10000,
            None,
        )

    serial, monitors, logical, _props = call(
        "GetCurrentState", None, "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"
    ).unpack()

    # connector -> (mode id, width, height, supported scales) of its current mode
    current = {}
    for (connector, _v, _p, _s), modes, _mprops in monitors:
        for mode_id, w, h, _rate, _pref, scales, mprops in modes:
            if mprops.get("is-current"):
                current[connector] = (mode_id, w, h, scales)

    # GNOME rounds the size the client asked for, so take the closest monitor.
    near = sorted(current.items(), key=lambda item: abs(item[1][1] - width) + abs(item[1][2] - height))
    target = near[0][0] if near and abs(near[0][1][1] - width) + abs(near[0][1][2] - height) <= 16 else None
    if target is None:
        print(f"no monitor at {width}x{height}", file=sys.stderr)
        sys.exit(2)
    supported = current[target][3]
    scale = min(supported, key=lambda s: (abs(s - wanted), -s))

    # Keep every monitor, left to right in their current order, with the new scale on ours.
    configs = []
    x = 0
    for _x, _y, lscale, transform, primary, specs, _lprops in sorted(logical, key=lambda m: m[0]):
        connector = specs[0][0]
        if connector not in current:
            continue
        mode_id, w, _h, _scales = current[connector]
        s = scale if connector == target else lscale
        configs.append((x, 0, s, transform, primary, [(connector, mode_id, {})]))
        x += round(w / s)

    call(
        "ApplyMonitorsConfig",
        GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (serial, TEMPORARY, configs, {})),
        None,
    )
    print(scale)


if __name__ == "__main__":
    main()
