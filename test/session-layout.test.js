import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLayout } from '../src/guac.js';

test('a 3x phone gets full resolution at scale 2, in whole logical pixels', () => {
  assert.deepEqual(sessionLayout(1170, 2280, 288), { scale: 2, width: 1168, height: 2280, dpi: 288 });
});

test('a 2x laptop gets scale 2', () => {
  assert.deepEqual(sessionLayout(2880, 1640, 192), { scale: 2, width: 2880, height: 1640, dpi: 192 });
});

test('too small for scale 2: CSS-pixel size at scale 1', () => {
  assert.deepEqual(sessionLayout(750, 1414, 192), { scale: 1, width: 750, height: 1414, dpi: 96 });
});

test('a 1x or 1.5x screen stays at scale 1', () => {
  assert.equal(sessionLayout(1920, 1080, 96).scale, 1);
  assert.equal(sessionLayout(2031, 1032, 144).scale, 1);
});
