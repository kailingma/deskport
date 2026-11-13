import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Opens links and files from the terminal on the device that is using it.
//
// bin/xdg-open is first on PATH in the tmux session and is its BROWSER. It
// finds the tmux client that was used last in its session and posts the
// target to every deskport server's socket in $XDG_RUNTIME_DIR/deskport/.
// The server whose terminal bridge owns that tmux client tells the browser,
// which offers the link; any other answer makes the script run the system
// xdg-open, so programs behave as before when the desk's own terminal was
// used last.
//
// Files are served once asked for, under a random token, for FILE_TTL_MS.

const SCHEMES = /^(https?|mailto|tel|sms):/i;
const FILE_TTL_MS = 15 * 60 * 1000;
// Types a browser could run scripts in; they are served in a sandbox.
const SCRIPTABLE = /\.(html?|xhtml|shtml|svgz?|xml|xsl|mht(ml)?)$/i;

/** Turns what xdg-open was given into a path or a link, or null if the browser can't open it. */
export function classify(target) {
  if (/^file:/i.test(target)) {
    try { target = fileURLToPath(target); } catch { return null; }
  }
  if (path.isAbsolute(target)) return { file: target };
  if (SCHEMES.test(target)) {
    try { return { url: new URL(target).href }; } catch { return null; }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.dir   directory for the socket, e.g. $XDG_RUNTIME_DIR/deskport
 * @param {number} opts.port  this server's port, which names the socket
 * @param {(msg: string) => void} opts.log
 */
export function createOpener({ dir, port, log }) {
  const clients = new Map(); // tmux client pid -> send(message)
  const files = new Map(); // token -> { file, expires }
  const socketPath = path.join(dir, `open-${port}.sock`);

  function shareFile(file) {
    const now = Date.now();
    for (const [t, f] of files) if (f.expires < now) files.delete(t);
    const token = crypto.randomBytes(18).toString('base64url');
    files.set(token, { file, expires: now + FILE_TTL_MS });
    return `/api/files/${token}/${encodeURIComponent(path.basename(file))}`;
  }

  async function open(target, pid) {
    const send = clients.get(pid);
    if (!send) return [404, 'no deskport terminal is the active tmux client'];
    const t = classify(target);
    if (!t) return [415, 'not a link or file the browser can open'];
    if (t.url) {
      send({ type: 'open', url: t.url, label: t.url });
      return [200, 'sent'];
    }
    const st = await fs.promises.stat(t.file).catch(() => null);
    if (!st?.isFile()) return [404, 'not a file'];
    send({ type: 'open', url: shareFile(t.file), label: path.basename(t.file), file: true });
    return [200, 'sent'];
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/open') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      const params = new URLSearchParams(body);
      const [status, text] = await open(params.get('target') || '', Number(params.get('client')));
      if (status === 200) log(`open: sent ${params.get('target')} to the browser`);
      res.writeHead(status, { 'Content-Type': 'text/plain' }).end(`${text}\n`);
    });
  });

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A socket left by an earlier run on this port.
    fs.rmSync(socketPath, { force: true });
    server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
    server.on('error', (err) => log(`open: socket failed: ${err.message}`));
  } catch (err) {
    log(`open: no socket, xdg-open will open on the desktop: ${err.message}`);
  }

  return {
    socketPath,
    /** Registers a terminal bridge's tmux client; returns the function that removes it. */
    register(pid, send) {
      clients.set(pid, send);
      return () => { if (clients.get(pid) === send) clients.delete(pid); };
    },
    /** The file shared under token, or null once it has expired; sandbox for types a browser could run scripts in. */
    fileFor(token) {
      const f = files.get(token);
      if (!f || f.expires < Date.now()) return null;
      return { file: f.file, sandbox: SCRIPTABLE.test(f.file) };
    },
    /** Express handler for GET /api/files/:token/:name. */
    serveFile(req, res) {
      const f = files.get(req.params.token);
      if (!f || f.expires < Date.now()) return res.status(404).type('text/plain').send('This link has expired. Run xdg-open again.');
      res.set('Cache-Control', 'private, no-store');
      // A page or image opened from disk must not run scripts on deskport's origin.
      if (SCRIPTABLE.test(f.file)) res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
      res.sendFile(f.file, { dotfiles: 'allow', headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(f.file))}` } }, (err) => {
        if (err && !res.headersSent) res.status(404).type('text/plain').send('The file is gone.');
      });
    },
    close() {
      server.close();
      fs.rmSync(socketPath, { force: true });
    },
  };
}
