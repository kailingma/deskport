import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawFilter, codecString } from '../src/video.js';
import { GuacParser, encode } from '../src/guac.js';

const parse = (...instructions) => new GuacParser().push(instructions.map((i) => encode(i)).join(''));
const ops = (list) => list.map((i) => i.elements[0]);

test('drops drawing on visible layers and keeps buffers, sizes and the pointer', () => {
  const filter = createDrawFilter();
  const kept = filter(parse(
    ['size', '0', '1920', '1080'],
    ['img', '1', '14', '0', 'image/png', '0', '0'],
    ['blob', '1', 'AAAA'],
    ['end', '1'],
    ['img', '2', '14', '-1', 'image/png', '0', '0'],
    ['blob', '2', 'BBBB'],
    ['end', '2'],
    ['copy', '0', '0', '0', '10', '10', '12', '0', '5', '5'],
    ['copy', '-1', '0', '0', '10', '10', '12', '-2', '5', '5'],
    ['rect', '0', '0', '0', '10', '10'],
    ['cfill', '14', '0', '0', '0', '0', '255'],
    ['cursor', '0', '0', '-1', '0', '0', '16', '16'],
    ['sync', '123'],
  ));
  assert.deepEqual(ops(kept), ['size', 'img', 'blob', 'end', 'copy', 'cursor', 'sync']);
  assert.equal(kept[1].elements[3], '-1');
  assert.equal(kept[4].elements[7], '-2');
});

test('an image stream split across batches is dropped to its end', () => {
  const filter = createDrawFilter();
  assert.deepEqual(ops(filter(parse(['img', '5', '14', '0', 'image/webp', '0', '0'], ['blob', '5', 'AA']))), []);
  assert.deepEqual(ops(filter(parse(['blob', '5', 'BB'], ['end', '5'], ['sync', '1']))), ['sync']);
  // The stream index can be reused for a buffer afterwards.
  assert.deepEqual(ops(filter(parse(['img', '5', '14', '-3', 'image/png', '0', '0'], ['end', '5']))), ['img', 'end']);
});

test('AV1 codec strings name a level that fits the size', () => {
  assert.equal(codecString('av1', 1280, 720), 'av01.0.08M.08');
  assert.equal(codecString('av1', 1920, 1080), 'av01.0.08M.08');
  assert.equal(codecString('av1', 3840, 2160), 'av01.0.12M.08');
  assert.equal(codecString('h264', 3840, 2160), 'avc1.640034');
});
