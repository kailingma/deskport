// The bench: keystroke to pixel, capture to encode, frame delivery and bytes
// per minute for each screen encoding, and the terminal's echo and Ctrl+C,
// at simulated links. Uses the separate desktop only (source=session).
//
// Starts its own server from this checkout on a spare port with Access checks
// off and a throwaway tmux session, and stops both at the end. --base points
// it at a server that is already running instead.
//
// Usage: node bench/run.mjs [--label name] [--runs n] [--links loopback,4m,1m]
//          [--cases images,av1,h264,term] [--query extra=params] [--base host:port]
// Writes bench/results/<date>-<label>.json and prints a table.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINKS, startLink } from './lib/link.mjs';
import { measureScreen, ENCODINGS } from './lib/screen.mjs';
import { measureTerminal } from './lib/terminal.mjs';
import { table } from './lib/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const label = args.label || 'run';
const runs = Number(args.runs || 1);
const links = (args.links || 'loopback,4m,1m').split(',');
const cases = (args.cases || 'images,av1,h264,term').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const l of links) if (!LINKS[l]) throw new Error(`unknown link ${l}`);
for (const c of cases) if (c !== 'term' && !ENCODINGS[c]) throw new Error(`unknown case ${c}`);

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startServer() {
  const port = await freePort();
  const tmux = `bench-${process.pid}`;
  const child = spawn(process.execPath, ['hub/server.js'], {
    cwd: root,
    env: { ...process.env, DESKPORT_PORT: String(port), DESKPORT_INSECURE_DEV: '1', DESKPORT_TMUX_SESSION: tmux },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = fs.createWriteStream(path.join(root, 'bench/results/.server.log'));
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const up = await new Promise((r) => net.connect(port, '127.0.0.1').on('connect', function () { this.destroy(); r(true); }).on('error', () => r(false)));
    if (up) break;
    if (child.exitCode !== null) throw new Error('bench server exited; see bench/results/.server.log');
  }
  return {
    host: `127.0.0.1:${port}`,
    stop() {
      child.kill('SIGTERM');
      try { execFileSync('tmux', ['kill-session', '-t', tmux], { stdio: 'ignore' }); } catch { /* never started */ }
    },
  };
}

function gitInfo() {
  const run = (...a) => execFileSync('git', a, { cwd: root }).toString().trim();
  return { commit: run('rev-parse', '--short', 'HEAD'), dirty: run('status', '--porcelain', '--untracked-files=no') !== '' };
}

fs.mkdirSync(path.join(root, 'bench/results'), { recursive: true });
const server = args.base ? { host: args.base, stop() {} } : await startServer();
const results = [];
process.on('SIGINT', () => { server.stop(); process.exit(130); });
try {
  for (let run = 1; run <= runs; run++) {
    for (const linkName of links) {
      for (const c of cases) {
        const link = await startLink(server.host, LINKS[linkName]);
        const base = `ws://127.0.0.1:${link.port}`;
        const t = Date.now();
        let r;
        try {
          r = c === 'term'
            ? { encoding: 'term', ...(await measureTerminal({ base, host: server.host, link })) }
            : await measureScreen({ base, host: server.host, link, encoding: c, query: args.query });
        } catch (err) {
          r = { encoding: c, error: String(err.message || err) };
        }
        link.close();
        r = { run, link: linkName, ...r, wallS: Math.round((Date.now() - t) / 1000) };
        results.push(r);
        console.error(JSON.stringify(r));
        await sleep(2000);
      }
    }
  }
} finally {
  server.stop();
}

const out = {
  label,
  date: new Date().toISOString(),
  ...gitInfo(),
  query: args.query || '',
  // Server settings that change the measured path.
  settings: { relay: process.env.DESKPORT_RELAY === '1' },
  links: Object.fromEntries(links.map((l) => [l, LINKS[l]])),
  results,
};
const day = new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
const file = path.join(root, 'bench/results', `${day}-${label}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(table(out));
console.log(`\nsaved ${path.relative(root, file)}`);
