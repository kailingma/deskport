import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuacParser, encode } from '../src/guac.js';

test('encode counts code points', () => {
  assert.equal(encode(['select', 'rdp']), '6.select,3.rdp;');
  assert.equal(encode(['clip', 'a😀b']), '4.clip,3.a😀b;');
  assert.equal(encode(['', 'x']), '0.,1.x;');
});

test('parser returns complete instructions and keeps partial ones', () => {
  const p = new GuacParser();
  assert.deepEqual(p.push('4.args,13.VERSION_1_5_0,8.host'), []);
  const out = p.push('name;5.ready,3.$ab;4.sy');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].elements, ['args', 'VERSION_1_5_0', 'hostname']);
  assert.equal(out[1].raw, '5.ready,3.$ab;');
  assert.equal(p.buf, '4.sy');
});

test('parser handles astral characters split across chunks', () => {
  const p = new GuacParser();
  const s = encode(['blob', '0', 'a😀b']);
  const mid = s.indexOf('😀') + 1; // split inside the surrogate pair
  assert.deepEqual(p.push(s.slice(0, mid)), []);
  const out = p.push(s.slice(mid));
  assert.deepEqual(out[0].elements, ['blob', '0', 'a😀b']);
});

test('parser rejects garbage', () => {
  assert.throws(() => new GuacParser().push('xx.abc;'));
});
