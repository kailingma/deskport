//! A metrics sample (docs/protocol.md, Metrics sample) from /proc, /sys and,
//! when it is installed, nvidia-smi. Counters are cumulative; the hub
//! computes rates. Only top processes need the previous sample.

use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;

pub struct Collector {
    prev_proc: HashMap<u32, u64>,
    prev_total: u64,
    nvidia_smi: bool,
    page: u64,
}

impl Collector {
    pub fn new() -> Self {
        Collector {
            prev_proc: HashMap::new(),
            prev_total: 0,
            nvidia_smi: which("nvidia-smi"),
            page: unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as u64,
        }
    }

    pub fn sample(&mut self) -> Value {
        let mut s = Map::new();
        if let Some(up) = read("/proc/uptime").and_then(|t| t.split_whitespace().next().and_then(|v| v.parse::<f64>().ok())) {
            s.insert("uptimeS".into(), json!(up as u64));
        }
        let stat = read("/proc/stat").unwrap_or_default();
        let (total, cores) = parse_stat(&stat);
        let mut cpu = Map::new();
        if let Some(t) = &total {
            cpu.insert("total".into(), json!(t));
        }
        cpu.insert("cores".into(), json!(cores));
        if let Some(l) = read("/proc/loadavg").map(|t| parse_loadavg(&t)) {
            cpu.insert("load".into(), json!(l));
        }
        s.insert("cpu".into(), Value::Object(cpu));
        if let Some(m) = read("/proc/meminfo") {
            s.insert("memory".into(), parse_meminfo(&m));
        }
        let mut pressure = Map::new();
        for r in ["cpu", "memory", "io"] {
            if let Some(p) = read(&format!("/proc/pressure/{r}")) {
                pressure.insert(r.into(), parse_pressure(&p));
            }
        }
        if !pressure.is_empty() {
            s.insert("pressure".into(), Value::Object(pressure));
        }
        if let Some(d) = read("/proc/diskstats") {
            s.insert("disks".into(), json!(parse_diskstats(&d, &whole_disks())));
        }
        if let Some(m) = read("/proc/mounts") {
            s.insert("mounts".into(), json!(mounts(&m)));
        }
        if let Some(n) = read("/proc/net/dev") {
            s.insert("net".into(), json!(parse_netdev(&n)));
        }
        let t = temps();
        if !t.is_empty() {
            s.insert("temps".into(), json!(t));
        }
        if self.nvidia_smi {
            match gpus() {
                Some(g) => {
                    s.insert("gpus".into(), json!(g));
                }
                None => self.nvidia_smi = false,
            }
        }
        let total_ticks: u64 = total.as_ref().map(|t| t.iter().sum()).unwrap_or(0);
        s.insert("top".into(), json!(self.top(total_ticks, cores.len().max(1))));
        Value::Object(s)
    }

    /// The five processes that used the most CPU since the last sample.
    fn top(&mut self, total: u64, ncpu: usize) -> Vec<Value> {
        let mut now = HashMap::new();
        let mut rows = Vec::new();
        let elapsed = total.saturating_sub(self.prev_total);
        if let Ok(dir) = fs::read_dir("/proc") {
            for e in dir.flatten() {
                let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
                let Some(stat) = read(&format!("/proc/{pid}/stat")) else { continue };
                let Some((name, ticks, rss_pages)) = parse_pid_stat(&stat) else { continue };
                now.insert(pid, ticks);
                if let Some(prev) = self.prev_proc.get(&pid) {
                    if elapsed > 0 {
                        // Share of all cores, scaled so one busy core is 100%.
                        let pct = (ticks.saturating_sub(*prev)) as f64 * 100.0 * ncpu as f64 / elapsed as f64;
                        rows.push((pct, pid, name, rss_pages * self.page));
                    }
                }
            }
        }
        self.prev_proc = now;
        self.prev_total = total;
        rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        rows.into_iter()
            .take(5)
            .map(|(pct, pid, name, rss)| json!({ "pid": pid, "name": name, "cpuPct": (pct * 10.0).round() / 10.0, "rssB": rss }))
            .collect()
    }
}

fn read(p: &str) -> Option<String> {
    fs::read_to_string(p).ok()
}

fn which(cmd: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
        .unwrap_or(false)
}

/// (all cores, per core): user, nice, system, idle, iowait, irq, softirq, steal.
pub fn parse_stat(s: &str) -> (Option<Vec<u64>>, Vec<Vec<u64>>) {
    let mut total = None;
    let mut cores = Vec::new();
    for line in s.lines() {
        let mut it = line.split_whitespace();
        let Some(label) = it.next() else { continue };
        if !label.starts_with("cpu") {
            continue;
        }
        let v: Vec<u64> = it.take(8).map(|x| x.parse().unwrap_or(0)).collect();
        if label == "cpu" {
            total = Some(v);
        } else {
            cores.push(v);
        }
    }
    (total, cores)
}

pub fn parse_loadavg(s: &str) -> Vec<f64> {
    s.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect()
}

pub fn parse_meminfo(s: &str) -> Value {
    let kv: HashMap<&str, u64> = s
        .lines()
        .filter_map(|l| {
            let (k, rest) = l.split_once(':')?;
            Some((k, rest.split_whitespace().next()?.parse::<u64>().ok()? * 1024))
        })
        .collect();
    let g = |k: &str| kv.get(k).copied().unwrap_or(0);
    json!({
        "totalB": g("MemTotal"),
        "availableB": g("MemAvailable"),
        "cachedB": g("Cached"),
        "swapTotalB": g("SwapTotal"),
        "swapFreeB": g("SwapFree"),
    })
}

/// {"some10": .., "full10": ..} from a /proc/pressure file.
pub fn parse_pressure(s: &str) -> Value {
    let mut m = Map::new();
    for line in s.lines() {
        let mut it = line.split_whitespace();
        let Some(kind) = it.next() else { continue };
        for f in it {
            if let Some(v) = f.strip_prefix("avg10=").and_then(|v| v.parse::<f64>().ok()) {
                m.insert(format!("{kind}10"), json!(v));
            }
        }
    }
    Value::Object(m)
}

fn whole_disks() -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(dir) = fs::read_dir("/sys/block") {
        for e in dir.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if !(n.starts_with("loop") || n.starts_with("ram") || n.starts_with("zram") || n.starts_with("dm-")) {
                set.insert(n);
            }
        }
    }
    set
}

/// Whole disks only: bytes read and written (512-byte sectors) and busy time.
pub fn parse_diskstats(s: &str, disks: &HashSet<String>) -> Vec<Value> {
    s.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 13 || !disks.contains(f[2]) {
                return None;
            }
            let n = |i: usize| f[i].parse::<u64>().unwrap_or(0);
            Some(json!({ "name": f[2], "readB": n(5) * 512, "writeB": n(9) * 512, "busyMs": n(12) }))
        })
        .collect()
}

const REAL_FS: &[&str] = &["ext4", "ext3", "ext2", "xfs", "btrfs", "vfat", "exfat", "f2fs", "zfs", "ntfs3", "bcachefs"];

fn mounts(s: &str) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for l in s.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 3 || !REAL_FS.contains(&f[2]) || !seen.insert(f[0].to_string()) {
            continue;
        }
        let path = f[1].replace("\\040", " ");
        let Ok(c) = std::ffi::CString::new(path.clone()) else { continue };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            continue;
        }
        let bs = st.f_frsize as u64;
        out.push(json!({ "path": path, "totalB": st.f_blocks as u64 * bs, "freeB": st.f_bavail as u64 * bs }));
    }
    out
}

/// Every interface but loopback, containers' and bridges: bytes received and sent.
pub fn parse_netdev(s: &str) -> Vec<Value> {
    s.lines()
        .skip(2)
        .filter_map(|l| {
            let (name, rest) = l.split_once(':')?;
            let name = name.trim();
            // Container and bridge interfaces; their traffic is also counted on the real interface.
            if name == "lo" || ["veth", "br-", "docker", "virbr"].iter().any(|p| name.starts_with(p)) {
                return None;
            }
            let f: Vec<u64> = rest.split_whitespace().map(|x| x.parse().unwrap_or(0)).collect();
            if f.len() < 9 {
                return None;
            }
            Some(json!({ "name": name, "rxB": f[0], "txB": f[8] }))
        })
        .collect()
}

fn temps() -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(dir) = fs::read_dir("/sys/class/hwmon") else { return out };
    let mut hw: Vec<_> = dir.flatten().map(|e| e.path()).collect();
    hw.sort();
    for h in hw {
        let chip = read(&h.join("name").to_string_lossy()).map(|s| s.trim().to_string()).unwrap_or_default();
        let Ok(files) = fs::read_dir(&h) else { continue };
        let mut inputs: Vec<String> = files
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("temp") && n.ends_with("_input"))
            .collect();
        inputs.sort();
        for i in inputs {
            let Some(milli) = read(&h.join(&i).to_string_lossy()).and_then(|v| v.trim().parse::<i64>().ok()) else { continue };
            let label = read(&h.join(i.replace("_input", "_label")).to_string_lossy()).map(|s| s.trim().to_string()).unwrap_or_else(|| i.replace("_input", ""));
            out.push(json!({ "sensor": format!("{chip} {label}"), "c": milli as f64 / 1000.0 }));
        }
    }
    out
}

fn gpus() -> Option<Vec<Value>> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout)))
}

pub fn parse_nvidia_smi(s: &str) -> Vec<Value> {
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split(',').map(|x| x.trim()).collect();
            let num = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok());
            let mib = |i: usize| num(i).map(|v| (v * 1024.0 * 1024.0) as u64);
            json!({
                "name": f.first().copied().unwrap_or(""),
                "utilPct": num(1), "encoderPct": num(2), "decoderPct": num(3),
                "memUsedB": mib(4), "memTotalB": mib(5), "c": num(6), "powerW": num(7),
            })
        })
        .collect()
}

/// (name, utime + stime in ticks, resident pages) from /proc/<pid>/stat.
pub fn parse_pid_stat(s: &str) -> Option<(String, u64, u64)> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let name = s[open + 1..close].to_string();
    let f: Vec<&str> = s[close + 2..].split_whitespace().collect();
    // Fields after the name start at field 3 (state); utime is 14, stime 15, rss 24.
    let n = |i: usize| f.get(i - 3).and_then(|v| v.parse::<u64>().ok());
    Some((name, n(14)? + n(15)?, n(24)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_and_load() {
        let (t, c) = parse_stat("cpu  10 1 5 100 2 0 1 0 0 0\ncpu0 5 0 2 50 1 0 0 0 0 0\ncpu1 5 1 3 50 1 0 1 0 0 0\nintr 1\n");
        assert_eq!(t.unwrap(), vec![10, 1, 5, 100, 2, 0, 1, 0]);
        assert_eq!(c.len(), 2);
        assert_eq!(parse_loadavg("1.20 0.80 0.50 2/300 1234"), vec![1.2, 0.8, 0.5]);
    }

    #[test]
    fn meminfo_and_pressure() {
        let m = parse_meminfo("MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\nCached: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
        assert_eq!(m["totalB"], 16_384_000_000u64);
        assert_eq!(m["cachedB"], 102_400);
        let p = parse_pressure("some avg10=1.50 avg60=0.10 avg300=0.00 total=1\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=1\n");
        assert_eq!(p["some10"], 1.5);
        assert_eq!(p["full10"], 0.25);
    }

    #[test]
    fn disks_net_gpu_and_processes() {
        let disks: HashSet<String> = ["nvme0n1".to_string()].into();
        let d = parse_diskstats("259 0 nvme0n1 10 0 200 5 20 0 400 9 0 30 14 0 0 0 0\n259 1 nvme0n1p1 1 0 2 0 0 0 0 0 0 0 0\n", &disks);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["readB"], 200 * 512);
        assert_eq!(d[0]["writeB"], 400 * 512);
        assert_eq!(d[0]["busyMs"], 30);
        let n = parse_netdev("Inter-|\n face |\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\nveth1a2b: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n");
        assert_eq!(n.len(), 1);
        assert_eq!(n[0]["rxB"], 100);
        assert_eq!(n[0]["txB"], 200);
        let g = parse_nvidia_smi("NVIDIA GeForce GTX 1650 SUPER, 12, 3, 0, 512, 4096, 45, 20.50\n");
        assert_eq!(g[0]["encoderPct"], 3.0);
        assert_eq!(g[0]["memTotalB"], 4096u64 * 1024 * 1024);
        let p = parse_pid_stat("42 (tmux: server) S 1 42 42 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 1 0 100 1000000 250 18446744073709551615").unwrap();
        assert_eq!(p, ("tmux: server".to_string(), 10, 250));
    }
}
