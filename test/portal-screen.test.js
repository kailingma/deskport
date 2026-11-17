import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pictureOptions, portalPermissions } from '../web/js/screen-options.js';

const helper = new URL('../scripts/portal-screen.py', import.meta.url).pathname;
const installer = new URL('../scripts/install-agent.sh', import.meta.url).pathname;

/** Runs Python against the helper's functions, with a stand-in for GStreamer that has only `elements`. */
function py(body, elements = []) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("portal_screen", ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
have = set(json.loads(sys.argv[1]))
class Factory:
    @staticmethod
    def find(name): return name in have
class Gst: ElementFactory = Factory
${body}
`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, JSON.stringify(elements)], { encoding: 'utf8' }));
}

test('portal notices: waiting, view only, clipboard unavailable and full control', () => {
  assert.deepEqual(portalPermissions('Waiting for someone at kde to allow screen sharing.'), { waiting: true, control: false, clipboard: false });
  assert.deepEqual(portalPermissions('View only: control was not allowed at kde.'), { waiting: false, control: false, clipboard: false });
  assert.deepEqual(portalPermissions('Clipboard unavailable: clipboard sharing was not allowed at kde.'), { waiting: false, control: true, clipboard: false });
  // The bridge clears the notice with an empty name on a start with full control.
  assert.deepEqual(portalPermissions(''), { waiting: false, control: true, clipboard: true });
});

test('joined machines never get the hub-only direct path or monitor choice', () => {
  const saved = { source: 'session', encoding: 'h264', direct: true, matchMonitor: true, monitor: 'HDMI-1' };
  const get = (k) => saved[k];
  const joined = { local: false, screen: true, access: 'edit', screenSources: ['mirror'], screenEncodings: ['images', 'h264'] };
  assert.deepEqual(pictureOptions(joined, get), { source: 'mirror', encoding: 'h264', matchMonitor: false, monitor: 'primary', direct: false });
  const hub = { local: true, screen: true, access: 'edit' };
  assert.equal(pictureOptions(hub, get).direct, true);
  assert.equal(pictureOptions(hub, (k) => (k === 'encoding' ? 'images' : saved[k])).direct, false);
});

test('video encoders count only with their parsers', () => {
  const pick = 'print(json.dumps([m.h264_encoder(Gst), m.av1_encoder(Gst)]))';
  assert.deepEqual(py(pick, ['x264enc', 'av1enc']), [null, null]);
  assert.deepEqual(py(pick, ['x264enc', 'h264parse', 'av1enc', 'av1parse']), ['x264enc', 'av1enc']);
  assert.deepEqual(py(pick, ['openh264enc', 'h264parse']), ['openh264enc', null]);
});

test('helper and installer offer the same screen packages', () => {
  const lists = py('print(json.dumps(m.PACKAGES))');
  const sh = readFileSync(installer, 'utf8');
  for (const [tool, pkgs] of Object.entries(lists)) {
    const line = sh.split('\n').find((l) => l.includes(`command -v ${tool} `) && l.includes('gst') && l.includes('PKG="'));
    assert.ok(line, `installer has a screen line for ${tool}`);
    for (const p of pkgs.split(' ')) assert.ok(line.includes(` ${p}`), `${tool}: installer offers ${p}`);
  }
  assert.match(sh, /--no-screen\) SCREEN_OFFER=0/);
});

test('the helper checks every pipeline element and needs an explicit clipboard grant', () => {
  const src = readFileSync(helper, 'utf8');
  for (const el of ['pipewiresrc', 'videoconvert', 'videoscale', 'appsrc', 'appsink', 'jpegenc']) {
    assert.match(src, new RegExp(`\\("${el}", "GStreamer`), `probe checks ${el}`);
  }
  assert.match(src, /started\.get\("clipboard_enabled"\) is True/);
  assert.doesNotMatch(src, /clipboard_enabled", True/);
});

test('portal Read startup asks only for ScreenCast, preserving the separate control token', () => {
  const trace = py(`
calls, reads, writes = [], [], []
class GLib:
    class Error(Exception): pass
    Variant = staticmethod(lambda signature, value: value)
class Gio:
    class DBusSignalFlags: NONE = 0
class Bus:
    def signal_subscribe(self, *args): pass
class Portal:
    def request(self, interface, method, args, **kwargs):
        calls.append([interface, method, args({})])
        return {"session_handle": "/session"} if method == "CreateSession" else {"restore_token": "new", "clipboard_enabled": True, "devices": 3}
    def call(self, interface, method, args): calls.append([interface, method, args])
m.read_token = lambda file: reads.append(file) or "saved"
m.write_token = lambda file, token: writes.append([file, token])
m.message = lambda **kwargs: None
_, _, clipboard = m.start_share(Portal(), Gio, GLib, Bus(), {"readOnly": True, "tokenFile": "/token"}, 2, 1)
print(json.dumps({"calls": calls, "reads": reads, "writes": writes, "clipboard": clipboard}))
`);
  assert.deepEqual(trace.calls.map(([iface, method]) => [iface, method]), [
    ['org.freedesktop.portal.ScreenCast', 'CreateSession'],
    ['org.freedesktop.portal.ScreenCast', 'SelectSources'],
    ['org.freedesktop.portal.ScreenCast', 'Start'],
  ]);
  assert.equal(trace.clipboard, false);
  assert.deepEqual(trace.reads, ['/token.readonly']);
  assert.deepEqual(trace.writes, [['/token.readonly', 'new']]);
  assert.equal(trace.calls[1][2][1].types, 1, 'only a real monitor, never a virtual monitor');
});
