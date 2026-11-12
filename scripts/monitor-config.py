#!/usr/bin/env python3
"""Reads or applies GNOME's monitor configuration through Mutter's DisplayConfig.

Used by src/monitors.js for "Match this device" on My monitor. Applied
configurations are temporary (method 1): nothing is written to monitors.xml,
and src/monitors.js puts the previous configuration back when the last viewer
disconnects.

Usage:
  monitor-config.py BUS_ADDRESS state
      Prints the current state as JSON.
  monitor-config.py BUS_ADDRESS apply SERIAL JSON
      Applies JSON, a list of logical monitors:
      [{"x", "y", "scale", "transform", "primary", "monitors": [{"connector", "mode"}]}]
"""
import json
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

TEMPORARY = 1
STATE = "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"


def connect(address):
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    return Gio.DBusConnection.new_for_address_sync(address, flags, None, None)


def call(bus, method, args, reply):
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


def state(bus):
    serial, monitors, logical, props = call(bus, "GetCurrentState", None, STATE).unpack()
    return {
        "serial": serial,
        "layoutMode": props.get("layout-mode", 1),
        "monitors": [
            {
                "connector": connector,
                "vendor": vendor,
                "product": product,
                "name": mprops.get("display-name", connector),
                "builtin": bool(mprops.get("is-builtin", False)),
                "modes": [
                    {
                        "id": mode_id,
                        "width": w,
                        "height": h,
                        "rate": rate,
                        "scales": list(scales),
                        "current": bool(p.get("is-current", False)),
                        "preferred": bool(p.get("is-preferred", False)),
                    }
                    for mode_id, w, h, rate, _pref, scales, p in modes
                ],
            }
            for (connector, vendor, product, _serial), modes, mprops in monitors
        ],
        "logical": [
            {
                "x": x,
                "y": y,
                "scale": scale,
                "transform": transform,
                "primary": bool(primary),
                "connectors": [spec[0] for spec in specs],
            }
            for x, y, scale, transform, primary, specs, _lprops in logical
        ],
    }


def apply(bus, serial, config):
    logical = [
        (
            int(m["x"]),
            int(m["y"]),
            float(m["scale"]),
            int(m.get("transform", 0)),
            bool(m["primary"]),
            [(mon["connector"], mon["mode"], {}) for mon in m["monitors"]],
        )
        for m in config
    ]
    call(
        bus,
        "ApplyMonitorsConfig",
        GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", (serial, TEMPORARY, logical, {})),
        None,
    )


def main():
    bus = connect(sys.argv[1])
    if sys.argv[2] == "state":
        print(json.dumps(state(bus)))
    elif sys.argv[2] == "apply":
        apply(bus, int(sys.argv[3]), json.loads(sys.argv[4]))
    else:
        sys.exit(f"unknown command {sys.argv[2]}")


if __name__ == "__main__":
    main()
