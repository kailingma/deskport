//! A metrics sample (docs/protocol.md, Metrics sample). Counters are
//! cumulative; the hub computes rates. Only top processes need the previous
//! sample. Each platform has its own collector; what they share, and the
//! arithmetic of the Windows one (tested on every platform), is here.

#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
pub use linux::Collector;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Collector;

use serde_json::{Value, json};

/// GPUs from nvidia-smi (nvidia-smi.exe on Windows), or None when it fails.
pub fn gpus() -> Option<Vec<Value>> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
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

/// The five rows (cpu %, pid, name, resident bytes) with the most CPU.
pub fn top_rows(mut rows: Vec<(f64, u32, String, u64)>) -> Vec<Value> {
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    rows.into_iter()
        .take(5)
        .map(|(pct, pid, name, rss)| json!({ "pid": pid, "name": name, "cpuPct": (pct * 10.0).round() / 10.0, "rssB": rss }))
        .collect()
}

/// Windows counts processor time in 100 ns units; the protocol uses 100 Hz ticks.
#[cfg_attr(not(windows), allow(dead_code))]
pub const UNITS_PER_TICK: u64 = 100_000;

/// One processor's times (100 ns units, as SystemProcessorPerformanceInformation
/// gives them; kernel time includes idle, DPC and interrupt time) as the
/// protocol's row: user, nice, system, idle, iowait, irq, softirq, steal.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn cpu_row(idle: u64, kernel: u64, user: u64, dpc: u64, interrupt: u64) -> Vec<u64> {
    let system = kernel.saturating_sub(idle).saturating_sub(dpc).saturating_sub(interrupt);
    let t = |v: u64| v / UNITS_PER_TICK;
    vec![t(user), 0, t(system), t(idle), 0, t(interrupt), t(dpc), 0]
}

/// The sum of per-core rows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sum_rows(rows: &[Vec<u64>]) -> Vec<u64> {
    let mut total = vec![0u64; 8];
    for r in rows {
        for (t, v) in total.iter_mut().zip(r) {
            *t += v;
        }
    }
    total
}

/// A disk's busy time in ms. Windows counts the disk's idle time (100 ns
/// units) since it started counting, near boot; uptime minus idle grows by
/// the busy time between two samples, which is all the hub uses.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn disk_busy_ms(uptime_ms: u64, idle_100ns: u64) -> u64 {
    uptime_ms.saturating_sub(idle_100ns / 10_000)
}

/// What the Windows collector needs of a MIB_IF_ROW2.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Interface {
    pub name: String,
    pub if_type: u32,
    /// InterfaceAndOperStatusFlags: bit 1 is FilterInterface.
    pub flags: u8,
    pub up: bool,
    pub rx: u64,
    pub tx: u64,
}

/// Interfaces that are up, not loopback and not filter drivers (Windows lists
/// each filter, such as the QoS packet scheduler, as an interface of its own
/// with the same traffic as the adapter under it).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn net_rows(ifs: &[Interface]) -> Vec<Value> {
    const LOOPBACK: u32 = 24;
    const FILTER: u8 = 1 << 1;
    let mut seen = std::collections::HashSet::new();
    ifs.iter()
        .filter(|i| i.up && i.if_type != LOOPBACK && i.flags & FILTER == 0 && seen.insert(i.name.clone()))
        .map(|i| json!({ "name": i.name, "rxB": i.rx, "txB": i.tx }))
        .collect()
}

/// A NUL-terminated UTF-16 buffer as a String.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_smi_and_top() {
        let g = parse_nvidia_smi("NVIDIA GeForce GTX 1650 SUPER, 12, 3, 0, 512, 4096, 45, 20.50\n");
        assert_eq!(g[0]["encoderPct"], 3.0);
        assert_eq!(g[0]["memTotalB"], 4096u64 * 1024 * 1024);
        let rows = (0..7).map(|i| (i as f64 * 1.04, i, format!("p{i}"), 10)).collect();
        let t = top_rows(rows);
        assert_eq!(t.len(), 5);
        assert_eq!(t[0]["pid"], 6);
        assert_eq!(t[0]["cpuPct"], 6.2);
    }

    #[test]
    fn windows_processor_times_become_ticks() {
        // 10 s since boot on one core: 6 s idle, 3 s user, kernel 7 s of which
        // 6 s idle, 0.2 s DPC and 0.1 s interrupts.
        let s = 10_000_000u64;
        let row = cpu_row(6 * s, 7 * s, 3 * s, s / 5, s / 10);
        assert_eq!(row, vec![300, 0, 70, 600, 0, 10, 20, 0]);
        assert_eq!(row.iter().sum::<u64>(), 1000, "all of the 10 s at 100 Hz");
        assert_eq!(sum_rows(&[row.clone(), row]), vec![600, 0, 140, 1200, 0, 20, 40, 0]);
        assert_eq!(cpu_row(5, 1, 0, 0, 0)[2], 0, "never negative");
    }

    #[test]
    fn windows_disks_and_interfaces() {
        assert_eq!(disk_busy_ms(60_000, 50_000 * 10_000), 10_000);
        assert_eq!(disk_busy_ms(1_000, 2_000 * 10_000), 0);
        let i = |name: &str, if_type, flags, up| Interface { name: name.into(), if_type, flags, up, rx: 5, tx: 7 };
        let rows = net_rows(&[
            i("Ethernet", 6, 0b1, true),
            i("Ethernet-QoS Packet Scheduler-0000", 6, 0b11, true),
            i("Loopback Pseudo-Interface 1", 24, 0, true),
            i("Wi-Fi", 71, 0b1, false),
            i("Tailscale", 53, 0, true),
            i("Tailscale", 53, 0, true),
        ]);
        let names: Vec<_> = rows.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Ethernet", "Tailscale"]);
        assert_eq!(rows[0]["txB"], 7);
        assert_eq!(wide(&[67, 58, 92, 0, 65]), "C:\\");
    }
}
