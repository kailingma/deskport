#!/usr/bin/env python3
"""The screen of a machine running deskport-agent, through the desktop portal.

deskport-agent (agent/src/screen) carries this file inside its binary, writes
it next to its settings and runs it with the system's python3. It works on any
Wayland desktop whose xdg-desktop-portal has a RemoteDesktop backend: KDE
Plasma (xdg-desktop-portal-kde), GNOME (xdg-desktop-portal-gnome) and others.
The hub's own machine does not use it; that one keeps guacd, RDP and Mutter
(shim/, scripts/video-encoder.py).

The portal asks the person at the machine once which screen to share and
whether to allow control. The answer is kept as a restore token in
"tokenFile", so later connections start without asking until it is revoked.

Usage:
  portal-screen.py probe
      Prints one JSON line: {"screen": {"sources", "encodings", "backend"}}
      when the screen can be shared, or {"screen": null, "note": text} with
      what is missing.
  portal-screen.py run CONFIG_JSON
      {"codec": "images" | "h264" | "av1", "width": w, "height": h (device
       pixels the browser fills), "res": "auto" | "1" | "0.75" | "0.5" | "0.33",
       "quality": "low".."lossless", "speed": 0..2, "kbps": n, "fps": n,
       "tokenFile": path}

Commands on stdin, one JSON object per line:
  {"k": [keysym, pressed]}   a key
  {"p": [x, y]}              pointer position in the picture's pixels
  {"b": [button, pressed]}   a pointer button (Linux evdev code, BTN_LEFT 272)
  {"a": [axis, steps]}       scroll: axis 0 vertical, 1 horizontal
  {"clip": text}             make text the desktop's clipboard
  {"open": bool}             whether frames may be encoded; while closed, the
                             newest frame waits and is encoded once it opens
  {"fps": n}                 change the frame rate cap
  {"kbps": n}                change the video bitrate
  {"key": true}              make the next video frame a keyframe

Output on stdout, records of a 16-byte header and a payload, as in
scripts/video-encoder.py: u32 payload length, u8 kind (0 frame, 1 JSON
message), u8 keyframe, u16 zero, f64 capture time (CLOCK_MONOTONIC, ms). A
frame is a JPEG picture for "images", else an H.264 access unit (Annex B) or
an AV1 temporal unit. Messages:
  {"type": "asking"}         the portal is about to ask at the machine
  {"type": "started", "width", "height", "encoder", "clipboard", "control"}
                             (control false: the person at the machine shared
                             the screen without keyboard and pointer)
  {"type": "clipboard", "text"}   text copied on the desktop
  {"type": "error", "message"}
Exit codes: 0 stdin closed, 2 bad arguments, 3 the portal refused or the
session ended, 4 pipeline error, 5 something needed is not installed.
"""
import collections
import json
import os
import shutil
import struct
import sys
import threading
import time

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"
SC = "org.freedesktop.portal.ScreenCast"
CLIP = "org.freedesktop.portal.Clipboard"
KEYBOARD, POINTER = 1, 2
MONITOR = 1
CURSOR_HIDDEN, CURSOR_EMBEDDED = 1, 2
PERSIST_UNTIL_REVOKED = 2
ASK_TIMEOUT_S = 180
CALL_TIMEOUT_S = 15

# Packages that bring python3-gi, GStreamer's base and good plugins, the
# PipeWire source, the bad plugins (h264parse, av1parse, av1enc) and a
# software H.264 encoder, by package manager. scripts/install-agent.sh offers
# the same lists.
PACKAGES = {
    "apt-get": "python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly",
    "dnf": "python3-gobject gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free pipewire-gstreamer gstreamer1-plugin-openh264",
    "pacman": "python-gobject gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugin-pipewire gst-plugins-ugly",
    "zypper": "python3-gobject typelib-1_0-Gst-1_0 gstreamer-plugins-base gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugin-pipewire gstreamer-plugins-ugly",
}
INSTALL = {"apt-get": "sudo apt-get install -y", "dnf": "sudo dnf install -y", "pacman": "sudo pacman -S --needed", "zypper": "sudo zypper install -y"}

JPEG_QUALITY = {"low": 40, "medium": 65, "high": 85, "lossless": 95}
X264_PRESET = ["ultrafast", "superfast", "veryfast"]
OPENH264_COMPLEXITY = ["low", "medium", "high"]
AV1_CPU_USED = [10, 8, 6]
AV1_Q = {"low": (40, 63), "medium": (28, 58), "high": (16, 52), "lossless": (4, 44)}
X264_QP = {"low": (32, 51), "medium": (24, 45), "high": (18, 40), "lossless": (12, 34)}
VBV_MS = 200
# Keyframes come when the browser asks; this caps the gap otherwise.
KEYINT = 3000

out_lock = threading.Lock()


def emit(kind, payload, key=False, captured=0.0):
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<IBBHd", len(payload), kind, 1 if key else 0, 0, captured) + payload)
        sys.stdout.buffer.flush()


def message(**fields):
    emit(1, json.dumps(fields).encode())


def fail(code, text):
    message(type="error", message=text)
    sys.stderr.write(f"portal-screen: {text}\n")
    sys.stderr.flush()
    # Some GStreamer encoders hang on a clean shutdown; the portal ends the
    # session when this process's bus connection closes.
    os._exit(code)


def install_hint():
    for tool, pkgs in PACKAGES.items():
        if shutil.which(tool):
            return f"{INSTALL[tool]} {pkgs}"
    return None


def missing_note(what):
    hint = install_hint()
    return f"{what} is not installed on this machine." + (f" Install it with: {hint}" if hint else "")


def wayland_running():
    if os.environ.get("WAYLAND_DISPLAY"):
        return True
    run = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    try:
        return any(n.startswith("wayland-") and not n.endswith(".lock") for n in os.listdir(run))
    except OSError:
        return False


# ---------- encoders ----------

def h264_encoder(Gst):
    # The parser (bad plugins) makes the byte stream the browser decodes.
    if not Gst.ElementFactory.find("h264parse"):
        return None
    for name in ("x264enc", "openh264enc"):
        if Gst.ElementFactory.find(name):
            return name
    return None


def av1_encoder(Gst):
    return "av1enc" if Gst.ElementFactory.find("av1enc") and Gst.ElementFactory.find("av1parse") else None


def encoder_description(cfg, Gst):
    """(raw format, encoder name, pipeline text from raw video to encoded frames)."""
    codec = cfg["codec"]
    speed = max(0, min(2, int(cfg.get("speed", 0))))
    quality = cfg.get("quality", "high")
    kbps = max(50, int(cfg.get("kbps", 2500)))
    w, h = cfg["width"], cfg["height"]
    if codec == "images":
        return "I420", "jpegenc", f"jpegenc name=enc quality={JPEG_QUALITY.get(quality, 85)} idct-method=ifast"
    if codec == "h264":
        name = h264_encoder(Gst)
        tail = "! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au"
        if name == "x264enc":
            qmin, qmax = X264_QP.get(quality, X264_QP["high"])
            return "I420", name, (f"x264enc name=enc tune=zerolatency speed-preset={X264_PRESET[speed]} bitrate={kbps} "
                                  f"vbv-buf-capacity={VBV_MS} key-int-max={KEYINT} bframes=0 byte-stream=true aud=false "
                                  f"qp-min={qmin} qp-max={qmax} threads={min(8, os.cpu_count() or 4)} {tail}")
        if name == "openh264enc":
            return "I420", name, (f"openh264enc name=enc usage-type=screen rate-control=bitrate bitrate={kbps * 1000} "
                                  f"complexity={OPENH264_COMPLEXITY[speed]} gop-size={KEYINT} {tail}")
        fail(5, missing_note("An H.264 encoder (x264enc or openh264enc) with h264parse"))
    if codec == "av1":
        if not av1_encoder(Gst):
            fail(5, missing_note("An AV1 encoder (av1enc) with av1parse"))
        qmin, qmax = AV1_Q.get(quality, AV1_Q["high"])
        tiles = 2 if w * h > 2500000 else 1 if w * h > 600000 else 0
        return "I420", "av1enc", (f"av1enc name=enc usage-profile=realtime cpu-used={AV1_CPU_USED[speed]} lag-in-frames=0 "
                                  f"end-usage=cbr target-bitrate={kbps} min-quantizer={qmin} max-quantizer={qmax} "
                                  "buf-sz=1000 buf-initial-sz=500 buf-optimal-sz=600 undershoot-pct=50 overshoot-pct=50 "
                                  f"keyframe-mode=disabled row-mt=true threads={min(8, os.cpu_count() or 4)} tile-columns={tiles} "
                                  "! av1parse ! video/x-av1,stream-format=obu-stream,alignment=tu")
    fail(2, f"unknown codec {codec}")


def set_bitrate(enc, name, kbps):
    if name == "x264enc":
        enc.set_property("bitrate", kbps)
    elif name == "openh264enc":
        enc.set_property("bitrate", kbps * 1000)
    elif name == "av1enc":
        enc.set_property("target-bitrate", kbps)


def picture_size(native, target, res):
    """Picture size for a screen of `native` logical pixels: `res` of it, or
    with "auto" the largest size that fits `target` without enlarging."""
    nw, nh = native
    if res == "auto":
        s = min(1.0, target[0] / nw, target[1] / nh)
    else:
        try:
            s = max(0.1, min(1.0, float(res)))
        except ValueError:
            s = 1.0
    return max(2, int(nw * s) & ~1), max(2, int(nh * s) & ~1)


# ---------- the portal ----------

class Portal:
    def __init__(self, Gio, GLib, bus, loop):
        self.Gio, self.GLib, self.bus, self.loop = Gio, GLib, bus, loop
        self.sender = bus.get_unique_name()[1:].replace(".", "_")
        self.n = 0

    def prop(self, iface, name):
        GLib = self.GLib
        return self.bus.call_sync(PORTAL, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get",
                                  GLib.Variant("(ss)", (iface, name)), GLib.VariantType("(v)"),
                                  self.Gio.DBusCallFlags.NONE, CALL_TIMEOUT_S * 1000, None).unpack()[0]

    def call(self, iface, method, args, reply=None):
        GLib = self.GLib
        return self.bus.call_sync(PORTAL, PORTAL_PATH, iface, method, args,
                                  GLib.VariantType(reply) if reply else None,
                                  self.Gio.DBusCallFlags.NONE, CALL_TIMEOUT_S * 1000, None)

    def request(self, iface, method, build, timeout_s=CALL_TIMEOUT_S):
        """Calls a method that answers through a Request object; returns its results.
        build(options) returns the method's arguments as a Variant."""
        GLib = self.GLib
        self.n += 1
        token = f"deskport{os.getpid()}_{self.n}"
        path = f"{PORTAL_PATH}/request/{self.sender}/{token}"
        answer = {}

        def on_response(_c, _s, _p, _i, _sig, params):
            answer["code"], answer["results"] = params.unpack()
            self.loop.quit()

        sub = self.bus.signal_subscribe(PORTAL, "org.freedesktop.portal.Request", "Response", path, None,
                                        self.Gio.DBusSignalFlags.NONE, on_response)
        options = {"handle_token": GLib.Variant("s", token)}
        try:
            self.call(iface, method, build(options), "(o)")
        except GLib.Error as err:
            self.bus.signal_unsubscribe(sub)
            fail(3, f"the portal refused {method}: {err.message}")
        timed_out = []

        def on_timeout():
            timed_out.append(True)
            self.loop.quit()
            return False

        timer = GLib.timeout_add_seconds(timeout_s, on_timeout)
        self.loop.run()
        if not timed_out:
            GLib.source_remove(timer)
        self.bus.signal_unsubscribe(sub)
        code = answer.get("code", -1)
        if code == 0:
            return answer["results"]
        if code == 1:
            fail(3, "sharing was not allowed at the machine")
        if code == -1:
            fail(3, "nobody answered the sharing question at the machine in time" if method == "Start" else f"the portal did not answer {method}")
        fail(3, f"the portal could not {method}")


def probe():
    if not wayland_running():
        return {"screen": None, "note": "No Wayland desktop is signed in on this machine. "
                "The screen works once someone signs in to a Wayland session (KDE Plasma, GNOME or another desktop with a remote desktop portal)."}
    try:
        import gi
        gi.require_version("Gio", "2.0")
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gio, GLib, Gst  # noqa: F401
    except (ImportError, ValueError):
        return {"screen": None, "note": missing_note("GStreamer's Python bindings (python3-gi with the Gst typelibs)")}
    Gst.init(None)
    for el, what in (("pipewiresrc", "GStreamer's PipeWire plugin"), ("videoconvert", "GStreamer's base plugins"),
                     ("videoscale", "GStreamer's base plugins"), ("appsrc", "GStreamer's base plugins"),
                     ("appsink", "GStreamer's base plugins"), ("jpegenc", "GStreamer's good plugins")):
        if not Gst.ElementFactory.find(el):
            return {"screen": None, "note": missing_note(what)}
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        portal = Portal(Gio, GLib, bus, None)
        devices = portal.prop(RD, "AvailableDeviceTypes")
        sources = portal.prop(SC, "AvailableSourceTypes")
    except GLib.Error:
        return {"screen": None, "note": "This desktop has no remote desktop portal. It needs xdg-desktop-portal with a backend "
                "that offers RemoteDesktop, such as xdg-desktop-portal-kde on Plasma or xdg-desktop-portal-gnome on GNOME."}
    if devices & (KEYBOARD | POINTER) != (KEYBOARD | POINTER) or not sources & MONITOR:
        return {"screen": None, "note": "This desktop's portal cannot share a monitor with keyboard and pointer control."}
    encodings = ["images"] + (["av1"] if av1_encoder(Gst) else []) + (["h264"] if h264_encoder(Gst) else [])
    return {"screen": {"sources": ["mirror"], "encodings": encodings, "backend": "portal"}}


# ---------- run ----------

TEXT_TYPES = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"]
CLIP_MAX = 1 << 20


def watch_clipboard(Gio, GLib, bus, session):
    """The desktop's clipboard both ways through the portal. Returns set_text(text)."""
    offered = {"text": None}

    def call(method, args, reply=None, fds=False):
        if fds:
            return bus.call_with_unix_fd_list_sync(PORTAL, PORTAL_PATH, CLIP, method, args, GLib.VariantType(reply),
                                                   Gio.DBusCallFlags.NONE, 5000, None, None)
        bus.call(PORTAL, PORTAL_PATH, CLIP, method, args, None, Gio.DBusCallFlags.NONE, -1, None, None, None)

    def on_transfer(_c, _s, _p, _i, _sig, params):
        sess, _mime, serial = params.unpack()
        if sess != session:
            return
        ok = False
        try:
            res, fds = call("SelectionWrite", GLib.Variant("(ou)", (session, serial)), "(h)", fds=True)
            with os.fdopen(fds.get(res.unpack()[0]), "wb") as f:
                f.write((offered["text"] or "").encode())
            ok = True
        except (GLib.Error, OSError) as err:
            sys.stderr.write(f"portal-screen: clipboard write: {err}\n")
        call("SelectionWriteDone", GLib.Variant("(oub)", (session, serial, ok)))

    def read_text(mime):
        try:
            res, fds = call("SelectionRead", GLib.Variant("(os)", (session, mime)), "(h)", fds=True)
            fd = fds.get(res.unpack()[0])
        except GLib.Error as err:
            sys.stderr.write(f"portal-screen: clipboard read: {err.message}\n")
            return

        def drain():
            data = b""
            with os.fdopen(fd, "rb") as f:
                while len(data) <= CLIP_MAX:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    data += chunk
            if len(data) <= CLIP_MAX:
                message(type="clipboard", text=data.decode("utf-8", "replace"))
        threading.Thread(target=drain, daemon=True).start()

    def on_owner(_c, _s, _p, _i, _sig, params):
        sess, options = params.unpack()
        if sess != session or options.get("session_is_owner"):
            return
        types = options.get("mime_types") or []
        if isinstance(types, tuple) and len(types) == 1 and isinstance(types[0], list):
            types = types[0]
        mime = next((t for t in TEXT_TYPES if t in types), None)
        if mime:
            # The new owner's data may not be there yet inside the signal.
            GLib.timeout_add(100, lambda: read_text(mime) and False)

    bus.signal_subscribe(PORTAL, CLIP, "SelectionTransfer", PORTAL_PATH, None, Gio.DBusSignalFlags.NONE, on_transfer)
    bus.signal_subscribe(PORTAL, CLIP, "SelectionOwnerChanged", PORTAL_PATH, None, Gio.DBusSignalFlags.NONE, on_owner)

    def set_text(text):
        offered["text"] = str(text)[:CLIP_MAX]
        call("SetSelection", GLib.Variant("(oa{sv})", (session, {"mime_types": GLib.Variant("as", TEXT_TYPES)})))
    return set_text


def read_token(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def write_token(path, token):
    try:
        fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token)
        os.replace(path + ".new", path)
    except OSError as err:
        sys.stderr.write(f"portal-screen: could not keep the restore token: {err}\n")


def start_share(portal, Gio, GLib, bus, cfg, cursor_modes, clip_version):
    """Read access uses ScreenCast only, never requests devices or clipboard."""
    V = GLib.Variant
    read_only = cfg.get("readOnly") is True
    interface = SC if read_only else RD
    results = portal.request(interface, "CreateSession", lambda o: V("(a{sv})", ({**o, "session_handle_token": V("s", f"deskport{os.getpid()}")},)))
    session = results["session_handle"]
    bus.signal_subscribe(PORTAL, "org.freedesktop.portal.Session", "Closed", session, None,
                         Gio.DBusSignalFlags.NONE, lambda *a: fail(3, "the screen sharing session ended"))

    token_file = cfg.get("tokenFile")
    if token_file and read_only:
        token_file += ".readonly"
    token = read_token(token_file) if token_file else None

    def persistent(o):
        o = {**o, "persist_mode": V("u", PERSIST_UNTIL_REVOKED)}
        if token:
            o["restore_token"] = V("s", token)
        return o

    if not read_only:
        portal.request(RD, "SelectDevices", lambda o: V("(oa{sv})", (session, {**persistent(o), "types": V("u", KEYBOARD | POINTER)})))
    cursor = CURSOR_EMBEDDED if cursor_modes & CURSOR_EMBEDDED else CURSOR_HIDDEN
    portal.request(SC, "SelectSources", lambda o: V("(oa{sv})", (session, {**(persistent(o) if read_only else o), "types": V("u", MONITOR),
                                                                       "multiple": V("b", False), "cursor_mode": V("u", cursor)})))
    clipboard = False
    if clip_version and not read_only:
        try:
            portal.call(CLIP, "RequestClipboard", V("(oa{sv})", (session, {})))
            clipboard = True
        except GLib.Error as err:
            sys.stderr.write(f"portal-screen: no clipboard: {err.message}\n")
    message(type="asking")
    started = portal.request(interface, "Start", lambda o: V("(osa{sv})", (session, "", o)), timeout_s=ASK_TIMEOUT_S)
    if token_file and started.get("restore_token"):
        write_token(token_file, started["restore_token"])
    clipboard = clipboard and started.get("clipboard_enabled") is True
    return session, started, clipboard


def run(cfg):
    try:
        import gi
        gi.require_version("Gio", "2.0")
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gio, GLib, Gst, GstVideo
    except (ImportError, ValueError):
        fail(5, missing_note("GStreamer's Python bindings (python3-gi with the Gst typelibs)"))
    Gst.init(None)
    loop = GLib.MainLoop()
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as err:
        fail(3, f"no session bus: {err.message}")
    portal = Portal(Gio, GLib, bus, loop)
    V = GLib.Variant

    try:
        cursor_modes = portal.prop(SC, "AvailableCursorModes")
    except GLib.Error:
        cursor_modes = 0
    try:
        clip_version = portal.prop(CLIP, "version")
    except GLib.Error:
        clip_version = 0

    session, started, clipboard = start_share(portal, Gio, GLib, bus, cfg, cursor_modes, clip_version)
    control = cfg.get("readOnly") is not True and (started.get("devices", 0) & (KEYBOARD | POINTER)) == (KEYBOARD | POINTER)
    if not control:
        sys.stderr.write("portal-screen: keyboard and pointer control were not allowed; view only\n")
    streams = started.get("streams") or []
    if not streams:
        fail(3, "no screen was chosen to share")
    node, props = streams[0]
    native = tuple(props.get("size") or (1920, 1080))
    res, fds = bus.call_with_unix_fd_list_sync(PORTAL, PORTAL_PATH, SC, "OpenPipeWireRemote", V("(oa{sv})", (session, {})),
                                               GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 5000, None, None)
    pw_fd = fds.get(res.unpack()[0])

    w, h = picture_size(native, (int(cfg["width"]), int(cfg["height"])), str(cfg.get("res", "auto")))
    cfg["width"], cfg["height"] = w, h
    fmt, enc_name, encoder = encoder_description(cfg, Gst)

    probe_src = Gst.ElementFactory.make("pipewiresrc", None)
    # The portal gives a node id: "path" takes one; newer "target-object"
    # wants a serial or name, so it is only the fallback.
    target = f"path={node}" if not probe_src or probe_src.find_property("path") else f"target-object={node}"
    try:
        capture = Gst.parse_launch(
            f"pipewiresrc fd={pw_fd} {target} do-timestamp=true ! videoscale n-threads=4 add-borders=false "
            f"! videoconvert n-threads=4 ! video/x-raw,format={fmt},width={w},height={h},pixel-aspect-ratio=1/1 "
            "! appsink name=raw max-buffers=1 drop=true sync=false emit-signals=true")
        fps = [max(1, int(cfg.get("fps", 30)))]
        encode = Gst.parse_launch(
            f"appsrc name=src is-live=true format=time do-timestamp=false "
            f"caps=video/x-raw,format={fmt},width={w},height={h},framerate={fps[0]}/1,pixel-aspect-ratio=1/1 "
            f"! {encoder} ! appsink name=out sync=false emit-signals=true")
    except GLib.Error as err:
        fail(4, f"could not build the pipeline: {err.message}")
    src = encode.get_by_name("src")
    enc = encode.get_by_name("enc")
    video = cfg["codec"] != "images"

    gate = threading.Lock()
    state = {"open": True, "pending": None, "last": 0.0, "pts": 0, "key": False, "timer": False}
    captured_at = collections.deque()

    def push(sample, now):
        """Hands one captured frame to the encoder. Called with `gate` held."""
        buf = sample.get_buffer().copy()
        frame = Gst.SECOND // fps[0]
        gap = int((now - state["last"]) * Gst.SECOND) if state["last"] else frame
        buf.pts = state["pts"]
        buf.duration = max(frame, min(3 * frame, gap))
        state["pts"] += buf.duration
        state["last"] = now
        captured_at.append(now * 1000)
        if state["key"] and video:
            state["key"] = False
            src.send_event(GstVideo.video_event_new_downstream_force_key_unit(buf.pts, buf.pts, buf.pts, True, 0))
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
            key = not video or not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
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

    clipboard = clipboard and control
    set_clipboard = watch_clipboard(Gio, GLib, bus, session) if clipboard else None
    sx, sy = native[0] / w, native[1] / h

    def notify(method, signature, args):
        # Input does not wait for the portal's reply.
        bus.call(PORTAL, PORTAL_PATH, RD, method, V(signature, (session, {}, *args)), None,
                 Gio.DBusCallFlags.NONE, -1, None, None, None)

    def on_command(line):
        try:
            cmd = json.loads(line)
        except ValueError:
            return
        if not isinstance(cmd, dict):
            return
        if not control and any(k in cmd for k in ("k", "p", "b", "a")):
            return
        try:
            if "k" in cmd:
                notify("NotifyKeyboardKeysym", "(oa{sv}iu)", (int(cmd["k"][0]), 1 if cmd["k"][1] else 0))
            elif "p" in cmd:
                x = max(0.0, min(native[0] - 1, float(cmd["p"][0]) * sx))
                y = max(0.0, min(native[1] - 1, float(cmd["p"][1]) * sy))
                notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (node, x, y))
            elif "b" in cmd:
                notify("NotifyPointerButton", "(oa{sv}iu)", (int(cmd["b"][0]), 1 if cmd["b"][1] else 0))
            elif "a" in cmd:
                notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", (int(cmd["a"][0]), int(cmd["a"][1])))
            elif "clip" in cmd:
                if set_clipboard:
                    set_clipboard(cmd["clip"])
            else:
                if "kbps" in cmd and video:
                    set_bitrate(enc, enc_name, max(50, int(cmd["kbps"])))
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
        except (TypeError, ValueError, IndexError, KeyError):
            return

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
    message(type="started", width=w, height=h, encoder=enc_name, clipboard=clipboard, control=control)
    loop.run()


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "probe":
        print(json.dumps(probe()), flush=True)
        return
    if len(sys.argv) < 3 or sys.argv[1] != "run":
        sys.stderr.write("usage: portal-screen.py probe | run CONFIG_JSON\n")
        os._exit(2)
    try:
        cfg = json.loads(sys.argv[2])
        int(cfg["width"]), int(cfg["height"]), cfg["codec"]
    except (KeyError, ValueError, TypeError) as err:
        sys.stderr.write(f"portal-screen: bad arguments: {err}\n")
        os._exit(2)
    run(cfg)


if __name__ == "__main__":
    main()
