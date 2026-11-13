#!/usr/bin/env python3
"""Records one monitor through Mutter's ScreenCast API and encodes it as video.

Used by shim/video.js for the Screen view's AV1 and H.264 encodings. Mutter hands
the monitor's frames to PipeWire; GStreamer scales them to the size the browser
receives and encodes them, AV1 with libaom's realtime profile on the processor,
or H.264 with NVENC on the graphics card. Recording is read-only: nothing about
the monitor changes. The mouse pointer is left out, since the browser draws it.

Usage: video-encoder.py CONFIG_JSON
  {"bus": address, "monitor": "primary" | "virtual" | connector,
   "match": [w, h] (prefer the monitor of this size), "width": w, "height": h,
   "codec": "av1" | "h264", "speed": 0..2, "quality": "low".."lossless",
   "kbps": n, "fps": n}

Commands on stdin, one JSON object per line:
  {"kbps": n}      change the target bitrate
  {"open": bool}   whether frames may be encoded; while closed, the newest frame
                   waits and is encoded as soon as it opens
  {"fps": n}       change the frame rate cap
  {"key": true}    make the next frame a keyframe

Output on stdout, records of a 16-byte header and a payload:
  u32 payload length, u8 kind (0 frame, 1 JSON message), u8 keyframe,
  u16 zero, f64 capture time (CLOCK_MONOTONIC, milliseconds).
Exit codes: 0 stdin closed, 2 bad arguments or no such monitor, 3 the monitor
or recording went away, 4 pipeline error.
"""
import collections
import json
import os
import struct
import sys
import threading
import time

import gi

gi.require_version("Gio", "2.0")
gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gio, GLib, Gst, GstVideo  # noqa: E402

STATE = "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"
CURSOR_HIDDEN = 0

# Speed 0 is the fastest. libaom realtime cpu-used: at 1920 x 1080 these took a
# median 13, 15 and 19 ms per frame here, at 3840 x 2160 39, 42 and 56 ms.
AV1_CPU_USED = [10, 8, 6]
NVENC_PRESET = ["p1", "p4", "p7"]
# Quantizer bounds per quality. The lowest bound also caps how many bits a
# still picture gets, so lower quality uses less data on a quiet desktop too.
AV1_Q = {"low": (40, 63), "medium": (28, 58), "high": (16, 52), "lossless": (4, 44)}
H264_QP = {"low": (32, 51), "medium": (24, 45), "high": (18, 40), "lossless": (12, 34)}

out_lock = threading.Lock()


def emit(kind, payload, key=False, captured=0.0):
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<IBBHd", len(payload), kind, 1 if key else 0, 0, captured) + payload)
        sys.stdout.buffer.flush()


def message(**fields):
    emit(1, json.dumps(fields).encode())


def fail(code, text):
    message(type="error", message=text)
    sys.stderr.write(f"video-encoder: {text}\n")
    sys.stderr.flush()
    # svtav1enc and some other encoders hang on a clean shutdown; nothing here
    # needs one, Mutter ends the recording when this connection closes.
    os._exit(code)


def connect(address):
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    return Gio.DBusConnection.new_for_address_sync(address, flags, None, None)


def pick_monitor(bus, wanted, match):
    """Connector name of the monitor to record."""
    state = bus.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                          "org.gnome.Mutter.DisplayConfig", "GetCurrentState", None,
                          GLib.VariantType(STATE), Gio.DBusCallFlags.NONE, 5000, None).unpack()
    _serial, monitors, logical, _props = state
    current = {}
    for (connector, vendor, _product, _serial), modes, _mprops in monitors:
        for mode in modes:
            if mode[6].get("is-current"):
                current[connector] = (mode[1], mode[2], vendor)
    if wanted not in ("primary", "virtual"):
        if wanted in current:
            return wanted
        fail(2, f"no monitor {wanted}")
    if wanted == "primary":
        for _x, _y, _scale, _transform, primary, members, _lprops in logical:
            if primary and members:
                return members[0][0]
    # The extra monitor and the separate desktop's monitors are Mutter's
    # virtual monitors; prefer one of the size guacd reported.
    candidates = [c for c, (_w, _h, vendor) in current.items() if wanted == "primary" or vendor == "MetaVendor"]
    for c in candidates:
        if match and current[c][:2] == tuple(match):
            return c
    if candidates:
        return candidates[0]
    fail(2, "no monitor to record")


def start_recording(bus, connector, loop):
    def call(path, iface, method, args, reply):
        return bus.call_sync("org.gnome.Mutter.ScreenCast", path, iface, method, args,
                             GLib.VariantType(reply) if reply else None, Gio.DBusCallFlags.NONE, 5000, None)

    session = call("/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast", "CreateSession",
                   GLib.Variant("(a{sv})", ({},)), "(o)")[0]
    stream = call(session, "org.gnome.Mutter.ScreenCast.Session", "RecordMonitor",
                  GLib.Variant("(sa{sv})", (connector, {"cursor-mode": GLib.Variant("u", CURSOR_HIDDEN)})), "(o)")[0]
    node = {}

    def added(_conn, _sender, _path, _iface, _signal, params):
        node["id"] = params[0]
        loop.quit()

    bus.signal_subscribe(None, "org.gnome.Mutter.ScreenCast.Stream", "PipeWireStreamAdded", stream, None,
                         Gio.DBusSignalFlags.NONE, added)
    bus.signal_subscribe(None, "org.gnome.Mutter.ScreenCast.Session", "Closed", session, None,
                         Gio.DBusSignalFlags.NONE, lambda *a: fail(3, "the recording ended"))
    call(session, "org.gnome.Mutter.ScreenCast.Session", "Start", None, None)
    timeout = GLib.timeout_add(5000, lambda: fail(3, "the monitor did not start recording"))
    loop.run()
    GLib.source_remove(timeout)
    return node["id"]


def encoder_description(cfg):
    w, h = cfg["width"], cfg["height"]
    speed = max(0, min(2, int(cfg.get("speed", 0))))
    quality = cfg.get("quality", "high")
    kbps = int(cfg["kbps"])
    if cfg["codec"] == "h264":
        qmin, qmax = H264_QP.get(quality, H264_QP["high"])
        return ("NV12",
                f"nvh264enc name=enc preset={NVENC_PRESET[speed]} tune=ultra-low-latency rc-mode=cbr "
                f"bitrate={kbps} vbv-buffer-size={kbps} gop-size=-1 bframes=0 zerolatency=true "
                f"repeat-sequence-header=true aud=false qp-min-i={qmin} qp-min-p={qmin} qp-max-i={qmax} qp-max-p={qmax} "
                "! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au")
    qmin, qmax = AV1_Q.get(quality, AV1_Q["high"])
    tiles = 2 if w * h > 2500000 else 1 if w * h > 600000 else 0  # log2 of tile columns
    return ("I420",
            f"av1enc name=enc usage-profile=realtime cpu-used={AV1_CPU_USED[speed]} lag-in-frames=0 "
            f"end-usage=cbr target-bitrate={kbps} min-quantizer={qmin} max-quantizer={qmax} "
            "buf-sz=1000 buf-initial-sz=500 buf-optimal-sz=600 undershoot-pct=50 overshoot-pct=50 "
            f"keyframe-mode=disabled row-mt=true threads={min(8, os.cpu_count() or 4)} tile-columns={tiles} "
            "! av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu")


def main():
    try:
        cfg = json.loads(sys.argv[1])
        w, h = int(cfg["width"]) & ~1, int(cfg["height"]) & ~1
        cfg["width"], cfg["height"] = w, h
    except (IndexError, KeyError, ValueError) as err:
        sys.stderr.write(f"video-encoder: bad arguments: {err}\n")
        os._exit(2)

    Gst.init(None)
    loop = GLib.MainLoop()
    try:
        bus = connect(cfg["bus"])
        connector = pick_monitor(bus, cfg.get("monitor", "primary"), cfg.get("match"))
        node = start_recording(bus, connector, loop)
    except GLib.Error as err:
        fail(3, f"could not record the monitor: {err.message}")

    fmt, encoder = encoder_description(cfg)
    capture = Gst.parse_launch(
        f"pipewiresrc path={node} do-timestamp=true ! videoscale n-threads=4 add-borders=false "
        f"! videoconvert n-threads=4 ! video/x-raw,format={fmt},width={w},height={h},pixel-aspect-ratio=1/1 "
        "! appsink name=raw max-buffers=1 drop=true sync=false emit-signals=true")
    fps = [max(1, int(cfg.get("fps", 30)))]
    encode = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time do-timestamp=false "
        f"caps=video/x-raw,format={fmt},width={w},height={h},framerate={fps[0]}/1,pixel-aspect-ratio=1/1 "
        f"! {encoder} ! appsink name=out sync=false emit-signals=true")
    src = encode.get_by_name("src")
    enc = encode.get_by_name("enc")

    gate = threading.Lock()
    state = {"open": True, "pending": None, "last": 0.0, "pts": 0, "key": False, "timer": False}
    # Neither encoder reorders frames, so capture times leave in the order they came.
    captured_at = collections.deque()

    def push(sample, now):
        """Hands one captured frame to the encoder. Called with `gate` held."""
        buf = sample.get_buffer().copy()
        # Durations follow the real gaps between frames (within 1 to 3 frame
        # times), so the bitrate holds when the desktop changes less often.
        frame = Gst.SECOND // fps[0]
        gap = int((now - state["last"]) * Gst.SECOND) if state["last"] else frame
        buf.pts = state["pts"]
        buf.duration = max(frame, min(3 * frame, gap))
        state["pts"] += buf.duration
        state["last"] = now
        captured_at.append(now * 1000)
        if state["key"]:
            state["key"] = False
            src.send_event(GstVideo.video_event_new_downstream_force_key_unit(
                buf.pts, buf.pts, buf.pts, True, 0))
        src.emit("push-buffer", buf)

    def release_pending():
        with gate:
            state["timer"] = False
            sample = state["pending"]
            if not sample or not state["open"]:
                return False
            now = time.monotonic()
            wait = state["last"] + 1 / fps[0] - now
            if wait > 0.002:
                state["timer"] = True
                GLib.timeout_add(int(wait * 1000) + 1, release_pending)
                return False
            state["pending"] = None
            push(sample, now)
        return False

    def on_raw(sink):
        sample = sink.emit("pull-sample")
        with gate:
            now = time.monotonic()
            if state["open"] and now - state["last"] >= 1 / fps[0] - 0.002 and not state["pending"]:
                push(sample, now)
            else:
                # Keep only the newest frame; it is sent once the gate opens or
                # the frame rate cap allows.
                state["pending"] = sample
                if state["open"] and not state["timer"]:
                    state["timer"] = True
                    GLib.idle_add(release_pending)
        return Gst.FlowReturn.OK

    def on_encoded(sink):
        sample = sink.emit("pull-sample")
        buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            key = not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
            emit(0, bytes(info.data), key, captured_at.popleft() if captured_at else 0.0)
        finally:
            buf.unmap(info)
        return Gst.FlowReturn.OK

    capture.get_by_name("raw").connect("new-sample", on_raw)
    encode.get_by_name("out").connect("new-sample", on_encoded)

    def on_error(_bus, msg):
        err, _debug = msg.parse_error()
        fail(4, f"{msg.src.get_name()}: {err.message}")

    for p in (capture, encode):
        b = p.get_bus()
        b.add_signal_watch()
        b.connect("message::error", on_error)

    def on_command(line):
        try:
            cmd = json.loads(line)
        except ValueError:
            return
        if "kbps" in cmd:
            kbps = max(50, int(cmd["kbps"]))
            if cfg["codec"] == "h264":
                enc.set_property("bitrate", kbps)
                enc.set_property("vbv-buffer-size", kbps)
            else:
                enc.set_property("target-bitrate", kbps)
        if "fps" in cmd:
            fps[0] = max(1, int(cmd["fps"]))
        if cmd.get("key"):
            with gate:
                state["key"] = True
        if "open" in cmd:
            with gate:
                state["open"] = bool(cmd["open"])
            if cmd["open"]:
                release_pending()

    stdin = GLib.IOChannel.unix_new(sys.stdin.fileno())

    def on_stdin(channel, condition):
        if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
            os._exit(0)
        status, line, _len, _term = channel.read_line()
        if status == GLib.IOStatus.EOF:
            os._exit(0)
        if line:
            on_command(line)
        return True

    GLib.io_add_watch(stdin, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, on_stdin)

    encode.set_state(Gst.State.PLAYING)
    capture.set_state(Gst.State.PLAYING)
    message(type="started", connector=connector, width=w, height=h)
    loop.run()


if __name__ == "__main__":
    main()
