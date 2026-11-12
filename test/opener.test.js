import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { classify, createOpener } from '../src/opener.js';
import { sessionVars, tmuxArgs } from '../src/terminal.js';

test('classify accepts web, mail and phone links and absolute paths only', () => {
  assert.deepEqual(classify('https://example.com/a b'), { url: 'https://example.com/a%20b' });
  assert.deepEqual(classify('mailto:someone@example.com'), { url: 'mailto:someone@example.com' });
  assert.deepEqual(classify('/tmp/x.pdf'), { file: '/tmp/x.pdf' });
  assert.deepEqual(classify('file:///tmp/a%20b.txt'), { file: '/tmp/a b.txt' });
  assert.equal(classify('javascript:alert(1)'), null);
  assert.equal(classify('data:text/html,hi'), null);
  assert.equal(classify('relative/path'), null);
});

test('the tmux client sets PATH and BROWSER for the session', () => {
  const vars = sessionVars('/repo/bin', '/usr/bin:/repo/bin:/bin');
  assert.deepEqual(vars, { PATH: '/repo/bin:/usr/bin:/bin', BROWSER: '/repo/bin/xdg-open' });
  const args = tmuxArgs('web', '/home/u', vars);
  assert.deepEqual(args.slice(0, 6), ['new-session', '-A', '-s', 'web', '-c', '/home/u']);
  assert.ok(args.includes('-e') && args.includes('PATH=/repo/bin:/usr/bin:/bin'));
  assert.deepEqual(args.slice(-5), ['set-environment', '-t', '=web', 'BROWSER', '/repo/bin/xdg-open']);
});

function post(socketPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/open', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(new URLSearchParams(body).toString());
  });
}

test('xdg-open requests reach the registered terminal, and files are served by token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskport-open-'));
  const opener = createOpener({ dir, port: 1, log: () => {} });
  const server = await new Promise((r) => {
    const app = express().get('/api/files/:token/:name', (req, res) => opener.serveFile(req, res));
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((fs.statSync(opener.socketPath).mode & 0o777), 0o600);
    const got = [];
    const unregister = opener.register(4242, (msg) => got.push(msg));

    assert.equal(await post(opener.socketPath, { target: 'https://example.com/', client: '1' }), 404);
    assert.equal(await post(opener.socketPath, { target: 'javascript:alert(1)', client: '4242' }), 415);
    assert.equal(await post(opener.socketPath, { target: 'https://example.com/', client: '4242' }), 200);
    assert.deepEqual(got[0], { type: 'open', url: 'https://example.com/', label: 'https://example.com/' });

    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<script>1</script>');
    assert.equal(await post(opener.socketPath, { target: file, client: '4242' }), 200);
    assert.equal(got[1].file, true);
    assert.match(got[1].url, /^\/api\/files\/[\w-]{24}\/page\.html$/);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${got[1].url}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /^sandbox;/);
    assert.equal(await res.text(), '<script>1</script>');
    const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/files/nope/page.html`);
    assert.equal(bad.status, 404);

    assert.equal(await post(opener.socketPath, { target: dir, client: '4242' }), 404);
    unregister();
    assert.equal(await post(opener.socketPath, { target: 'https://example.com/', client: '4242' }), 404);
  } finally {
    server.close();
    opener.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
