import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDesktopLogin } from '../shim/guac.js';

// Shapes from `loginctl list-sessions -j`.
const manager = { session: '1', uid: 1000, user: 'owner', seat: null, class: 'manager', tty: null };
const greeter = { session: 'c1', uid: 60578, user: 'gdm-greeter', seat: 'seat0', class: 'greeter', tty: 'tty1' };
const desktop = { session: '3', uid: 1000, user: 'owner', seat: 'seat0', class: 'user', tty: 'tty2' };
const ssh = { session: '4', uid: 1000, user: 'owner', seat: null, class: 'user', tty: 'pts/0' };

test('after a restart with only the login screen, there is no desktop login', () => {
  assert.equal(hasDesktopLogin([manager, greeter], 1000), false);
});

test('an ssh login does not count as a desktop', () => {
  assert.equal(hasDesktopLogin([manager, greeter, ssh], 1000), false);
});

test('a signed-in seat session counts', () => {
  assert.equal(hasDesktopLogin([manager, desktop], 1000), true);
});

test('another user\'s desktop does not count', () => {
  assert.equal(hasDesktopLogin([{ ...desktop, uid: 1001 }], 1000), false);
});
