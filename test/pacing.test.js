import test from 'node:test';
import assert from 'node:assert/strict';
import { createAckAhead, lastSyncTimestamp } from '../src/pacing.js';

test('acknowledges frames ahead of the browser, up to the limit', () => {
  const acked = [];
  const p = createAckAhead({ ack: (t) => acked.push(t), max: 2 });
  p.sent('100', 0);
  p.sent('200', 0);
  p.sent('300', 0); // two already ahead: wait for the browser
  assert.deepEqual(acked, ['100', '200']);
  assert.equal(p.fromBrowser('100'), false); // already acknowledged
  assert.equal(p.pending, 1);
  p.sent('400', 0);
  assert.deepEqual(acked, ['100', '200', '400']);
});

test('passes on browser acknowledgements of frames it did not acknowledge', () => {
  const acked = [];
  const p = createAckAhead({ ack: (t) => acked.push(t), max: 1 });
  p.sent('100', 0);
  p.sent('200', 0); // limit reached
  assert.equal(p.fromBrowser('100'), false);
  assert.equal(p.fromBrowser('200'), true);
  // Older than what guacd already has: dropped.
  assert.equal(p.fromBrowser('150'), false);
});

test('stops acknowledging while the socket has a backlog', () => {
  const acked = [];
  const p = createAckAhead({ ack: (t) => acked.push(t), maxBuffered: 1000 });
  p.sent('100', 5000);
  assert.deepEqual(acked, []);
  assert.equal(p.fromBrowser('100'), true);
});

test('finds the last sync timestamp in a batch', () => {
  assert.equal(lastSyncTimestamp('4.rect,1.0;4.sync,13.1794453000000,1.1;'), '1794453000000');
  assert.equal(lastSyncTimestamp('4.sync,3.100;3.img,1.1;4.sync,3.200;'), '200');
  assert.equal(lastSyncTimestamp('4.blob,1.1,4.abcd;'), null);
  assert.equal(lastSyncTimestamp('4.name,11.x4.sync,3.1;'), null);
});
