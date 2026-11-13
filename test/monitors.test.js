import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSize, currentConfig, describe, plan } from '../shim/monitors.js';

const mode = (w, h, rate, current = false) => ({ id: `${w}x${h}@${rate}`, width: w, height: h, rate, scales: w >= 1920 ? [1, 1.5, 2] : [1], current });
const SIZES = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [1024, 768], [800, 600]];

function oneMonitor() {
  return {
    serial: 4,
    layoutMode: 1,
    monitors: [{ connector: 'DP-1', name: 'LG', modes: SIZES.map(([w, h]) => mode(w, h, 60, w === 3840)) }],
    logical: [{ x: 0, y: 0, scale: 1.5, transform: 0, primary: true, connectors: ['DP-1'] }],
  };
}

test('picks the largest size that fits the viewer, or the smallest one', () => {
  const sizes = SIZES.map(([width, height]) => ({ width, height }));
  assert.deepEqual(chooseSize(sizes, 2560, 1600), { width: 2560, height: 1440 });
  assert.deepEqual(chooseSize(sizes, 1170, 2532), { width: 1024, height: 768 });
  assert.deepEqual(chooseSize(sizes, 640, 480), { width: 800, height: 600 });
});

test('matches a laptop-sized viewer and keeps the scale when the mode allows it', () => {
  const next = plan(oneMonitor(), { width: 2560, height: 1600 });
  assert.equal(next[0].monitors[0].mode, '2560x1440@60');
  assert.equal(next[0].scale, 1.5);
});

test('falls back to a scale the new mode supports', () => {
  const next = plan(oneMonitor(), { width: 1100, height: 800 });
  assert.equal(next[0].monitors[0].mode, '1024x768@60');
  assert.equal(next[0].scale, 1);
});

test('returns null when nothing changes', () => {
  assert.equal(plan(oneMonitor(), { width: 3840, height: 2160 }), null);
  assert.equal(plan(oneMonitor(), {}), null);
});

test('mirrored outputs get a size both offer', () => {
  const s = oneMonitor();
  s.monitors.push({ connector: 'HDMI-1', name: 'LG', modes: [mode(3840, 2160, 30, true), mode(1920, 1080, 60), mode(800, 600, 60)] });
  s.logical[0].connectors.push('HDMI-1');
  const next = plan(s, { width: 2560, height: 1600 });
  assert.deepEqual(next[0].monitors, [{ connector: 'DP-1', mode: '1920x1080@60' }, { connector: 'HDMI-1', mode: '1920x1080@60' }]);
});

test('with two monitors, shows the chosen one as primary and moves the one to its right', () => {
  const s = oneMonitor();
  s.monitors.push({ connector: 'HDMI-2', name: 'Dell', modes: [mode(1920, 1080, 60, true), mode(1280, 720, 60)] });
  s.logical[0].x = 1920;
  s.logical.unshift({ x: 0, y: 0, scale: 1, transform: 0, primary: false, connectors: ['HDMI-2'] });
  const next = plan(s, { width: 1280, height: 800, monitor: 'HDMI-2' });
  assert.equal(next[0].primary, true);
  assert.equal(next[1].primary, false);
  assert.equal(next[0].monitors[0].mode, '1280x720@60');
  assert.equal(next[1].x, 1280);
  assert.deepEqual(describe(s).map((m) => m.connector), ['HDMI-2', 'DP-1']);
});

test('the current configuration round-trips', () => {
  assert.deepEqual(currentConfig(oneMonitor()), [
    { x: 0, y: 0, scale: 1.5, transform: 0, primary: true, monitors: [{ connector: 'DP-1', mode: '3840x2160@60' }] },
  ]);
});
