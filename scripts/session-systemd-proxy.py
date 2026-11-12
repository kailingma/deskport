#!/usr/bin/env python3
"""Answers org.freedesktop.systemd1 on the separate desktop's private bus.

The separate desktop (desktop-session.sh) has its own D-Bus session bus, and
the systemd user manager is only on the real one. Apps that start themselves in
a systemd scope through the session bus then fail: `snap run` refuses to start
any snap ("cannot create transient scope"), and GNOME Shell cannot put the apps
it launches in scopes. This process owns the name on the private bus, relays
every method call to the user manager on the real bus, sends back the reply, and
re-emits the manager's signals.

The private bus starts it on demand (see the service file desktop-session.sh
writes). Usage: session-systemd-proxy.py REAL_BUS_ADDRESS
"""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "org.freedesktop.systemd1"
FLAGS = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION

# Only what starting an app in a scope needs. Everything else is refused, above
# all SetEnvironment and friends: GNOME Shell calls them at startup, and on the
# real manager they would point the main desktop's apps at this desktop.
ALLOWED = {
    "org.freedesktop.systemd1.Manager": {
        "StartTransientUnit", "Subscribe", "Unsubscribe", "GetUnit", "GetUnitByPID",
        "GetUnitByControlGroup", "GetJob", "ListUnitsByNames",
    },
    "org.freedesktop.DBus.Properties": {"Get", "GetAll"},
    "org.freedesktop.DBus.Introspectable": {"Introspect"},
    "org.freedesktop.DBus.Peer": {"Ping", "GetMachineId"},
}


def allowed(msg):
    return msg.get_member() in ALLOWED.get(msg.get_interface(), ())


def main():
    real = Gio.DBusConnection.new_for_address_sync(sys.argv[1], FLAGS, None, None)
    private = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    ours = {NAME, private.get_unique_name()}

    def relay_reply(conn, result, call):
        try:
            reply = conn.send_message_with_reply_finish(result)
        except GLib.Error as err:
            out = Gio.DBusMessage.new_method_error_literal(call, "org.freedesktop.DBus.Error.Failed", err.message)
        else:
            if reply.get_message_type() == Gio.DBusMessageType.ERROR:
                out = Gio.DBusMessage.new_method_error_literal(call, reply.get_error_name(), "")
            else:
                out = Gio.DBusMessage.new_method_reply(call)
            if reply.get_body() is not None:
                out.set_body(reply.get_body())
            out.set_unix_fd_list(reply.get_unix_fd_list())
        private.send_message(out, Gio.DBusSendMessageFlags.NONE)

    def forward(msg):
        if not allowed(msg):
            out = Gio.DBusMessage.new_method_error_literal(
                msg, "org.freedesktop.DBus.Error.AccessDenied",
                "The separate desktop may only start scopes and read state through this relay.")
            private.send_message(out, Gio.DBusSendMessageFlags.NONE)
            return GLib.SOURCE_REMOVE
        fwd =Gio.DBusMessage.new_method_call(NAME, msg.get_path(), msg.get_interface(), msg.get_member())
        if msg.get_body() is not None:
            fwd.set_body(msg.get_body())
        fwd.set_unix_fd_list(msg.get_unix_fd_list())
        fwd.set_flags(msg.get_flags())
        if msg.get_flags() & Gio.DBusMessageFlags.NO_REPLY_EXPECTED:
            real.send_message(fwd, Gio.DBusSendMessageFlags.NONE)
        else:
            real.send_message_with_reply(fwd, Gio.DBusSendMessageFlags.NONE, -1, None, relay_reply, msg)
        return GLib.SOURCE_REMOVE

    # Filters run on GDBus's worker thread; the relaying happens on the main loop.
    def on_message(conn, msg, incoming):
        if not incoming or msg.get_message_type() != Gio.DBusMessageType.METHOD_CALL:
            return msg
        if msg.get_destination() not in ours:
            return msg
        GLib.idle_add(forward, msg)
        return None

    def on_signal(conn, sender, path, iface, member, params):
        private.emit_signal(None, path, iface, member, params)

    private.add_filter(on_message)
    real.signal_subscribe(NAME, None, None, None, None, Gio.DBusSignalFlags.NONE, on_signal)
    # Exit with the private bus, and if the real user manager goes away.
    private.connect("closed", lambda *_: loop.quit())
    real.connect("closed", lambda *_: loop.quit())
    Gio.bus_own_name_on_connection(private, NAME, Gio.BusNameOwnerFlags.NONE, None, lambda *_: loop.quit())
    loop.run()


if __name__ == "__main__":
    main()
