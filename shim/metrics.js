import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A metrics sample (docs/protocol.md, Metrics sample) for this machine, the
// same fields as deskport-agent's (agent/src/metrics.rs) from /proc, /sys and
// nvidia-smi. Only top processes need the previous sample.

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const REAL_FS = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'vfat', 'exfat', 'f2fs', 'zfs', 'ntfs3', 'bcachefs']);
const PAGE = 4096;
// Container and bridge interfaces, one per container; their traffic is also counted on the real interface.
const VIRTUAL_NET = /^(veth|br-|docker|virbr)/;

export function parseStat(s) {
  let total = null;
  const cores = [];
  for (const line of s.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (!f[0]?.startsWith('cpu')) continue;
    const v = f.slice(1, 9).map((x) => Number(x) || 0);
    if (f[0] === 'cpu') total = v;
    else cores.push(v);
  }
  return { total, cores };
}

export function parseMeminfo(s) {
  const kv = {};
  for (const line of s.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  return { totalB: kv.MemTotal ?? 0, availableB: kv.MemAvailable ?? 0, cachedB: kv.Cached ?? 0, swapTotalB: kv.SwapTotal ?? 0, swapFreeB: kv.SwapFree ?? 0 };
}

export function parsePressure(s) {
  const out = {};
  for (const line of s.split('\n')) {
    const m = /^(some|full) avg10=([\d.]+)/.exec(line);
    if (m) out[`${m[1]}10`] = Number(m[2]);
  }
  return out;
}

export function parseDiskstats(s, disks) {
  const out = [];
  for (const line of s.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 13 || !disks.has(f[2])) continue;
    out.push({ name: f[2], readB: Number(f[5]) * 512, writeB: Number(f[9]) * 512, busyMs: Number(f[12]) });
  }
  return out;
}

export function parseNetdev(s) {
  return s.split('\n').slice(2).flatMap((line) => {
    const i = line.indexOf(':');
    if (i < 0) return [];
    const name = line.slice(0, i).trim();
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    return name === 'lo' || VIRTUAL_NET.test(name) || f.length < 9 ? [] : [{ name, rxB: f[0], txB: f[8] }];
  });
}

export function parsePidStat(s) {
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const f = s.slice(close + 2).split(' ');
  const n = (i) => Number(f[i - 3]);
  return { name: s.slice(open + 1, close), ticks: n(14) + n(15), rssPages: n(24) };
}

function wholeDisks() {
  try {
    return new Set(fs.readdirSync('/sys/block').filter((n) => !/^(loop|ram|zram|dm-)/.test(n)));
  } catch {
    return new Set();
  }
}

function mounts(s) {
  const seen = new Set();
  const out = [];
  for (const line of s.split('\n')) {
    const f = line.split(' ');
    if (f.length < 3 || !REAL_FS.has(f[2]) || seen.has(f[0])) continue;
    seen.add(f[0]);
    const p = f[1].replace(/\\040/g, ' ');
    try {
      const st = fs.statfsSync(p);
      out.push({ path: p, totalB: st.blocks * st.bsize, freeB: st.bavail * st.bsize });
    } catch { /* unreadable mount */ }
  }
  return out;
}

function temps() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync('/sys/class/hwmon').sort(); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join('/sys/class/hwmon', d);
    const chip = (read(path.join(dir, 'name')) || '').trim();
    let files;
    try { files = fs.readdirSync(dir).filter((n) => /^temp\d+_input$/.test(n)).sort(); } catch { continue; }
    for (const f of files) {
      const milli = Number((read(path.join(dir, f)) || '').trim());
      if (!Number.isFinite(milli)) continue;
      const label = (read(path.join(dir, f.replace('_input', '_label'))) || f.replace('_input', '')).trim();
      out.push({ sensor: `${chip} ${label}`, c: milli / 1000 });
    }
  }
  return out;
}

export function parseNvidiaSmi(s) {
  return s.split('\n').filter((l) => l.trim()).map((l) => {
    const f = l.split(',').map((x) => x.trim());
    const num = (i) => (f[i] === undefined || Number.isNaN(Number(f[i])) ? null : Number(f[i]));
    const mib = (i) => (num(i) === null ? null : num(i) * 1024 * 1024);
    return { name: f[0] || '', utilPct: num(1), encoderPct: num(2), decoderPct: num(3), memUsedB: mib(4), memTotalB: mib(5), c: num(6), powerW: num(7) };
  });
}

const gpus = () => new Promise((resolve) => {
  execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
    { timeout: 3000 }, (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout)));
});

export function createCollector() {
  let prevProc = new Map();
  let prevTotal = 0;
  let nvidia = true;

  function top(total, ncpu) {
    const now = new Map();
    const rows = [];
    const elapsed = total - prevTotal;
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { /* none */ }
    for (const pid of pids) {
      const st = read(`/proc/${pid}/stat`);
      const p = st && parsePidStat(st);
      if (!p) continue;
      now.set(pid, p.ticks);
      const prev = prevProc.get(pid);
      if (prev !== undefined && elapsed > 0) rows.push({ pid: Number(pid), name: p.name, cpuPct: Math.round(((p.ticks - prev) * 1000 * ncpu) / elapsed) / 10, rssB: p.rssPages * PAGE });
    }
    prevProc = now;
    prevTotal = total;
    return rows.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 5);
  }

  return {
    async sample() {
      const s = {};
      const up = Number((read('/proc/uptime') || '').split(' ')[0]);
      if (Number.isFinite(up)) s.uptimeS = Math.floor(up);
      const { total, cores } = parseStat(read('/proc/stat') || '');
      s.cpu = { ...(total ? { total } : {}), cores, load: os.loadavg().map((x) => Math.round(x * 100) / 100) };
      const mem = read('/proc/meminfo');
      if (mem) s.memory = parseMeminfo(mem);
      const pressure = {};
      for (const r of ['cpu', 'memory', 'io']) {
        const p = read(`/proc/pressure/${r}`);
        if (p) pressure[r] = parsePressure(p);
      }
      if (Object.keys(pressure).length) s.pressure = pressure;
      const ds = read('/proc/diskstats');
      if (ds) s.disks = parseDiskstats(ds, wholeDisks());
      const m = read('/proc/mounts');
      if (m) s.mounts = mounts(m);
      const nd = read('/proc/net/dev');
      if (nd) s.net = parseNetdev(nd);
      const t = temps();
      if (t.length) s.temps = t;
      if (nvidia) {
        const g = await gpus();
        if (g) s.gpus = g;
        else nvidia = false;
      }
      s.top = top(total ? total.reduce((a, b) => a + b, 0) : 0, Math.max(1, cores.length));
      return s;
    },
  };
}
