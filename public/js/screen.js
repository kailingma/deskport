import Guacamole from '/vendor/guacamole-common.js';
import { settings } from './settings.js';
import { KS, keysymFor, takeMods } from './keys.js';
import { createScroller, touchMid, touchDist } from './gestures.js';

const $ = (id) => document.getElementById(id);
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

/**
 * The Screen view: RDP through guacd, drawn by guacamole-common-js.
 *
 * Touch, handled here instead of by Guacamole's own touch modes:
 *   tap                      left click
 *   drag                     scroll the remote desktop (with momentum);
 *                            when zoomed in, move around the picture instead
 *   two-finger drag          scroll the remote desktop
 *   pinch                    zoom this view (and pan while pinching)
 *   long press, then drag    drag with the left button held
 *   long press, release      right click
 *   two-finger tap           right click
 */
export function createScreen({ wsBase, setStatus, toast }) {
  const wrap = $('display-wrap');
  const ime = $('screen-ime');
  const ring = $('touch-ring');
  wrap.tabIndex = 0;
  let client = null;
  let keyboard = null;
  let wantConnected = false;
  let zoom = 1; // relative to fit-to-window
  let stale = false; // settings changed while another view was showing

  const overlay = (title, body) => {
    $('screen-overlay-title').textContent = title;
    $('screen-overlay-body').textContent = body || '';
    $('screen-overlay').hidden = false;
  };

  // ---------- scaling and zoom ----------

  function fitScale() {
    const display = client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    return w && h ? Math.min(wrap.clientWidth / w, wrap.clientHeight / h) : 0;
  }

  function rescale() {
    if (!client) return;
    const fit = fitScale();
    if (fit) client.getDisplay().scale(fit * zoom);
  }

  // The display is centred in the wrap on any axis where it fits.
  function contentOffset() {
    const el = client.getDisplay().getElement();
    return { x: el.offsetLeft, y: el.offsetTop };
  }

  // ---------- mouse output ----------

  /** Remote pixel position for a point on this page. */
  function remotePos(clientX, clientY) {
    const display = client.getDisplay();
    const rect = display.getElement().getBoundingClientRect();
    const scale = display.getScale() || 1;
    return {
      x: Math.max(0, Math.min(display.getWidth() - 1, (clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(display.getHeight() - 1, (clientY - rect.top) / scale)),
    };
  }

  function mouse(clientX, clientY, buttons = {}) {
    if (!client) return;
    client.sendMouseState({ ...remotePos(clientX, clientY), ...buttons });
  }

  function click(clientX, clientY, button = 'left') {
    mouse(clientX, clientY);
    mouse(clientX, clientY, { [button]: true });
    mouse(clientX, clientY);
  }

  function wheel(steps, clientX, clientY) {
    const dir = steps > 0 ? 'down' : 'up';
    for (let i = 0; i < Math.abs(steps); i++) {
      mouse(clientX, clientY, { [dir]: true });
      mouse(clientX, clientY);
    }
  }

  // ---------- touch ----------

  let g = null; // current gesture
  let scrollAt = { x: 0, y: 0 };
  const scroller = createScroller({
    stepPx: 28,
    onStep: (steps) => wheel(settings.get('touchScroll') === 'natural' ? -steps : steps, scrollAt.x, scrollAt.y),
  });

  const showRing = (x, y, state) => {
    ring.style.transform = `translate(${x}px, ${y}px)`;
    ring.dataset.state = state;
    ring.hidden = false;
  };
  const hideRing = () => { ring.hidden = true; };

  // Touch listeners: start on the wrap; move/end on the window, because the
  // element a touch started on can be removed by the display mid-gesture, and
  // its later events would then never reach the wrap.
  const PAN_STEP = 1;

  function startTwo(t, timeStamp) {
    const mid = touchMid(t);
    const rect = wrap.getBoundingClientRect();
    const scale = client.getDisplay().getScale() || 1;
    const off = contentOffset();
    g = {
      kind: 'two', t0: timeStamp, mode: null, dist: touchDist(t), zoom, mid, lastY: mid.y,
      // content point under the fingers, in remote pixels
      cx: (wrap.scrollLeft + mid.x - rect.left - off.x) / scale,
      cy: (wrap.scrollTop + mid.y - rect.top - off.y) / scale,
    };
  }

  function onTouchStart(e) {
    if (!client) return;
    e.stopPropagation();
    e.preventDefault();
    scroller.stop();
    const t = e.touches;

    if (t.length === 1) {
      // A lone new finger always starts a fresh gesture, whatever state was left behind.
      if (g?.timer) clearTimeout(g.timer);
      if (g?.mode === 'drag') mouse(g.x, g.y);
      hideRing();
      const p = t[0];
      g = { kind: 'one', x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY, lastX: p.clientX, lastY: p.clientY, mode: null };
      g.timer = setTimeout(() => {
        if (g?.kind === 'one' && !g.mode) {
          g.mode = 'armed';
          showRing(g.x0, g.y0, 'armed');
        }
      }, LONG_PRESS_MS);
      return;
    }

    if (t.length === 2) {
      if (g?.kind === 'one') {
        clearTimeout(g.timer);
        if (g.mode === 'drag') mouse(g.x, g.y);
        hideRing();
      }
      startTwo(t, e.timeStamp);
    }
  }

  function onTouchMove(e) {
    if (!g) return;
    if (document.getElementById('view-screen').hidden) { g = null; return; }
    e.preventDefault();
    const t = e.touches;

    if (g.kind === 'one' && t.length === 1) {
      const p = t[0];
      g.x = p.clientX;
      g.y = p.clientY;
      if (!g.mode && Math.hypot(g.x - g.x0, g.y - g.y0) > MOVE_SLOP) {
        clearTimeout(g.timer);
        // Zoomed in, one finger moves around the picture; otherwise it scrolls the desktop.
        g.mode = zoom > 1 ? 'pan' : 'scroll';
        scrollAt = { x: g.x0, y: g.y0 };
        scroller.start(e.timeStamp);
      }
      if (g.mode === 'scroll') {
        scroller.move(g.y - g.lastY, e.timeStamp);
      } else if (g.mode === 'pan') {
        wrap.scrollLeft -= (g.x - g.lastX) * PAN_STEP;
        wrap.scrollTop -= (g.y - g.lastY) * PAN_STEP;
      } else if (g.mode === 'armed' && Math.hypot(g.x - g.x0, g.y - g.y0) > 4) {
        g.mode = 'drag';
        mouse(g.x0, g.y0);
        mouse(g.x0, g.y0, { left: true });
      }
      if (g.mode === 'drag') {
        mouse(g.x, g.y, { left: true });
        showRing(g.x, g.y, 'drag');
      }
      g.lastX = g.x;
      g.lastY = g.y;
      return;
    }

    if (g.kind === 'two' && t.length === 2) {
      const mid = touchMid(t);
      const ratio = touchDist(t) / g.dist;
      // Fingers spreading or pinching zoom; fingers moving together scroll the desktop.
      if (!g.mode) {
        if (Math.abs(ratio - 1) > 0.08) g.mode = 'zoom';
        else if (Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > MOVE_SLOP) {
          g.mode = 'scroll';
          scrollAt = { x: g.mid.x, y: g.mid.y };
          scroller.start(e.timeStamp);
        } else return;
      }
      if (g.mode === 'scroll') {
        scroller.move(mid.y - g.lastY, e.timeStamp);
        g.lastY = mid.y;
        return;
      }
      zoom = Math.min(5, Math.max(1, g.zoom * ratio));
      rescale();
      const scale = client.getDisplay().getScale();
      const rect = wrap.getBoundingClientRect();
      const off = contentOffset();
      wrap.scrollLeft = g.cx * scale - (mid.x - rect.left) + off.x;
      wrap.scrollTop = g.cy * scale - (mid.y - rect.top) + off.y;
    }
  }

  function onTouchEnd(e) {
    if (!g) return;
    if (document.getElementById('view-screen').hidden) { g = null; return; }
    e.preventDefault();
    if (e.touches.length) {
      // Two fingers down to one: stop that gesture; the remaining finger does nothing until lifted.
      if (g.kind === 'two' && g.mode === 'scroll') scroller.release(e.timeStamp);
      if (g.kind === 'two') g = { kind: 'done' };
      return;
    }

    if (g.kind === 'one') {
      clearTimeout(g.timer);
      if (!g.mode) click(g.x0, g.y0);
      else if (g.mode === 'scroll') scroller.release(e.timeStamp);
      else if (g.mode === 'armed') click(g.x0, g.y0, 'right');
      else if (g.mode === 'drag') mouse(g.x, g.y);
      hideRing();
    } else if (g.kind === 'two') {
      if (!g.mode && e.timeStamp - g.t0 < 350) click(g.mid.x, g.mid.y, 'right');
      else if (g.mode === 'scroll') scroller.release(e.timeStamp);
    }
    if (zoom < 1.05 && zoom !== 1) { zoom = 1; rescale(); }
    g = null;
  }

  wrap.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });

  // ---------- connection ----------

  function connect() {
    disconnect();
    wantConnected = true;
    stale = false;
    zoom = 1;
    $('screen-overlay').hidden = true;

    const tunnel = new Guacamole.WebSocketTunnel(`${wsBase}/ws/screen`);
    const c = new Guacamole.Client(tunnel);
    client = c;
    const display = c.getDisplay();
    const el = display.getElement();
    wrap.replaceChildren(el);

    c.onstatechange = (state) => {
      switch (state) {
        case 1: case 2: setStatus('screen', 'busy', 'Connecting'); break;
        case 3:
          setStatus('screen', 'ok', 'Connected');
          // GNOME desktop sharing can accept a session and then send no picture.
          setTimeout(() => {
            if (client === c && wantConnected && !c.getDisplay().getWidth()) {
              setStatus('screen', 'bad', 'No picture');
              overlay('No picture from the desktop',
                'GNOME desktop sharing accepted the connection but is not sending the screen. '
                + 'Restart it on the host with: systemctl --user restart gnome-remote-desktop');
            }
          }, 12000);
          break;
        case 4: setStatus('screen', 'busy', 'Closing'); break;
        case 5:
          if (!wantConnected) break; // onerror already reported why
          setStatus('screen', 'bad', 'Disconnected');
          overlay('Disconnected', 'The remote desktop session ended.');
          break;
      }
    };
    c.onerror = (st) => {
      setStatus('screen', 'bad', 'Error');
      overlay('Could not connect', st.message || `Guacamole status ${st.code}`);
      wantConnected = false;
    };
    display.onresize = rescale;

    c.onclipboard = (stream, mimetype) => {
      if (!/^text\//.test(mimetype)) return;
      const reader = new Guacamole.StringReader(stream);
      let text = '';
      reader.ontext = (t) => { text += t; };
      reader.onend = () => {
        navigator.clipboard?.writeText(text).then(() => toast('Copied from the remote desktop'), () => {});
      };
    };

    // Mouse only; touch is handled above.
    const m = new Guacamole.Mouse(el);
    m.onEach(['mousedown', 'mouseup', 'mousemove', 'mousewheel'], (ev) => {
      wrap.focus({ preventScroll: true });
      c.sendMouseState(ev.state, true);
    });
    m.on('mouseout', () => display.showCursor(false));

    keyboard = new Guacamole.Keyboard(wrap);
    keyboard.onkeydown = (keysym) => { client?.sendKeyEvent(1, keysym); return false; };
    keyboard.onkeyup = (keysym) => { client?.sendKeyEvent(0, keysym); };

    // Device pixels to fill. On touch screens leave room to pinch-zoom 2x and stay
    // sharp, except for an extra monitor or separate desktop, which GNOME makes
    // at exactly this size.
    const ratio = window.devicePixelRatio || 1;
    const sized = settings.get('source') !== 'mirror';
    const headroom = !sized && matchMedia('(pointer: coarse)').matches ? 2 : 1;
    const params = new URLSearchParams({
      width: String(Math.round(wrap.clientWidth * ratio * headroom)),
      height: String(Math.round(wrap.clientHeight * ratio * headroom)),
      dpi: String(Math.round(96 * ratio)),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      quality: settings.get('quality'),
      priority: settings.get('priority'),
      res: settings.get('resolution'),
      source: settings.get('source'),
    });
    c.connect(params.toString());
  }

  function disconnect() {
    wantConnected = false;
    keyboard?.reset();
    if (keyboard) keyboard.onkeydown = keyboard.onkeyup = null;
    keyboard = null;
    if (client) {
      client.onstatechange = client.onerror = null;
      try { client.disconnect(); } catch {}
    }
    client = null;
  }

  // ---------- keys ----------

  function chord(...keys) {
    if (!client) return;
    for (const k of keys) client.sendKeyEvent(1, k);
    for (const k of [...keys].reverse()) client.sendKeyEvent(0, k);
  }

  function press(keysym) {
    const m = takeMods();
    chord(...[m.ctrl && KS.ctrl, m.alt && KS.alt].filter(Boolean), keysym);
  }

  // The soft keyboard types into a hidden textarea; forward what it produces.
  ime.addEventListener('keydown', (e) => {
    const special = { Enter: KS.enter, Backspace: KS.backspace, Tab: KS.tab, Escape: KS.esc,
      ArrowLeft: KS.left, ArrowRight: KS.right, ArrowUp: KS.up, ArrowDown: KS.down }[e.key];
    if (special) {
      e.preventDefault();
      press(special);
    }
  });
  ime.addEventListener('input', (e) => {
    if (e.inputType === 'deleteContentBackward') press(KS.backspace);
    else if (e.inputType === 'insertLineBreak') press(KS.enter);
    else if (e.data) for (const ch of e.data) press(keysymFor(ch));
    ime.value = '';
  });

  async function sendClipboard() {
    if (!client) return;
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('The browser blocked clipboard access');
      return;
    }
    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    toast(`Sent ${text.length} characters. Paste with Ctrl+V on the remote desktop`);
  }

  // For an extra monitor or separate desktop, ask GNOME to resize it when this
  // window changes size or the device rotates.
  let resizeTimer;
  new ResizeObserver(() => {
    rescale();
    if (!client || settings.get('source') === 'mirror') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const ratio = window.devicePixelRatio || 1;
      client?.sendSize(Math.round(wrap.clientWidth * ratio), Math.round(wrap.clientHeight * ratio));
    }, 600);
  }).observe(wrap);
  window.addEventListener('blur', () => keyboard?.reset());

  return {
    ensureConnected() { if (!client || stale) connect(); },
    markStale() { stale = true; },
    reconnect: connect,
    focus() { wrap.focus({ preventScroll: true }); },
    releaseKeys() { keyboard?.reset(); },
    showKeyboard() { ime.focus({ preventScroll: true }); },
    key(name) { press(KS[name] ?? keysymFor(name)); },
    superKey() { chord(KS.superL); },
    ctrlAltDel() { chord(KS.ctrl, KS.alt, KS.del); },
    sendClipboard,
    rescale,
    resetZoom() { zoom = 1; rescale(); },
    /** Size of the picture being received, or null before the first frame. */
    pictureSize() {
      const d = client?.getDisplay();
      return d?.getWidth() ? [d.getWidth(), d.getHeight()] : null;
    },
  };
}
