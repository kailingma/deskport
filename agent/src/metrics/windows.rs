//! The Windows sample: processor times per core from
//! NtQuerySystemInformation, memory and commit, physical disk counters,
//! fixed drives with GetDiskFreeSpaceEx, interfaces with GetIfTable2,
//! processes with the Tool Help snapshot, and GPUs from nvidia-smi.exe when
//! the NVIDIA driver installed it. No temperatures (they need WMI and
//! usually administrator rights), no load average and no pressure.

use super::{Interface, cpu_row, disk_busy_ms, gpus, net_rows, sum_rows, top_rows, wide};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::ptr::{null, null_mut};
use windows_sys::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessorPerformanceInformation};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, OPEN_EXISTING};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{DISK_PERFORMANCE, IOCTL_DISK_PERFORMANCE};
use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, K32GetProcessMemoryInfo, PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::{GetSystemTimeAsFileTime, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION};

pub struct Collector {
    prev_proc: HashMap<u32, u64>,
    prev_wall: u64,
    nvidia_smi: bool,
}

fn ft(t: &FILETIME) -> u64 {
    (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl Collector {
    pub fn new() -> Self {
        Collector { prev_proc: HashMap::new(), prev_wall: 0, nvidia_smi: crate::sys::which("nvidia-smi") }
    }

    pub fn sample(&mut self) -> Value {
        let mut s = Map::new();
        let uptime_ms = unsafe { GetTickCount64() };
        s.insert("uptimeS".into(), json!(uptime_ms / 1000));
        let cores = cores();
        let mut cpu = Map::new();
        if !cores.is_empty() {
            cpu.insert("total".into(), json!(sum_rows(&cores)));
        }
        cpu.insert("cores".into(), json!(cores));
        s.insert("cpu".into(), Value::Object(cpu));
        if let Some(m) = memory() {
            s.insert("memory".into(), m);
        }
        s.insert("disks".into(), json!(disks(uptime_ms)));
        s.insert("mounts".into(), json!(mounts()));
        s.insert("net".into(), json!(net()));
        if self.nvidia_smi {
            match gpus() {
                Some(g) => {
                    s.insert("gpus".into(), json!(g));
                }
                None => self.nvidia_smi = false,
            }
        }
        s.insert("top".into(), json!(self.top()));
        Value::Object(s)
    }

    /// The five processes that used the most CPU since the last sample, as a
    /// share of the wall-clock time between them (100% is one core).
    /// Processes this user may not open (other users', protected ones) are left out.
    fn top(&mut self) -> Vec<Value> {
        let mut wall = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        unsafe { GetSystemTimeAsFileTime(&mut wall) };
        let wall = ft(&wall);
        let elapsed = wall.saturating_sub(self.prev_wall);
        let mut now = HashMap::new();
        let mut rows = Vec::new();
        for (pid, name) in processes() {
            let Some((cpu, rss)) = process_usage(pid) else { continue };
            now.insert(pid, cpu);
            if let Some(prev) = self.prev_proc.get(&pid) {
                if elapsed > 0 && self.prev_wall > 0 {
                    rows.push((cpu.saturating_sub(*prev) as f64 * 100.0 / elapsed as f64, pid, name, rss));
                }
            }
        }
        self.prev_proc = now;
        self.prev_wall = wall;
        top_rows(rows)
    }
}

fn cores() -> Vec<Vec<u64>> {
    const MAX: usize = 256;
    let mut buf: Vec<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION> = vec![Default::default(); MAX];
    let size = (MAX * std::mem::size_of::<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION>()) as u32;
    let mut got = 0u32;
    let status = unsafe { NtQuerySystemInformation(SystemProcessorPerformanceInformation, buf.as_mut_ptr().cast(), size, &mut got) };
    if status < 0 {
        return Vec::new();
    }
    let n = got as usize / std::mem::size_of::<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION>();
    buf[..n.min(MAX)]
        .iter()
        .map(|p| {
            let u = |v: i64| v.max(0) as u64;
            // Reserved1 holds DpcTime and InterruptTime.
            cpu_row(u(p.IdleTime), u(p.KernelTime), u(p.UserTime), u(p.Reserved1[0]), u(p.Reserved1[1]))
        })
        .collect()
}

fn memory() -> Option<Value> {
    let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
        return None;
    }
    let mut v = json!({ "totalB": m.ullTotalPhys, "availableB": m.ullAvailPhys });
    let mut p: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
    p.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    if unsafe { GetPerformanceInfo(&mut p, p.cb) } != 0 {
        let page = p.PageSize as u64;
        v["cachedB"] = json!(p.SystemCache as u64 * page);
        v["commitB"] = json!(p.CommitTotal as u64 * page);
        v["commitLimitB"] = json!(p.CommitLimit as u64 * page);
    }
    Some(v)
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// \\.\PhysicalDrive0 and up. Opening a disk with no access rights is enough
/// for IOCTL_DISK_PERFORMANCE and needs no administrator.
fn disks(uptime_ms: u64) -> Vec<Value> {
    let mut out = Vec::new();
    let mut missing = 0;
    for n in 0..32 {
        let name = format!("PhysicalDrive{n}");
        let path = to_wide(&format!("\\\\.\\{name}"));
        let h = unsafe { CreateFileW(path.as_ptr(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, 0, null_mut()) };
        if h == INVALID_HANDLE_VALUE {
            missing += 1;
            if missing >= 4 {
                break;
            }
            continue;
        }
        missing = 0;
        let h = Handle(h);
        let mut perf: DISK_PERFORMANCE = Default::default();
        let mut got = 0u32;
        let ok = unsafe { DeviceIoControl(h.0, IOCTL_DISK_PERFORMANCE, null(), 0, (&mut perf as *mut DISK_PERFORMANCE).cast(), std::mem::size_of::<DISK_PERFORMANCE>() as u32, &mut got, null_mut()) };
        if ok == 0 {
            continue;
        }
        out.push(json!({ "name": name, "readB": perf.BytesRead.max(0), "writeB": perf.BytesWritten.max(0), "busyMs": disk_busy_ms(uptime_ms, perf.IdleTime.max(0) as u64) }));
    }
    out
}

/// Fixed drives (C:\ and so on), not removable, network or optical ones.
fn mounts() -> Vec<Value> {
    let mut buf = [0u16; 512];
    let n = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) } as usize;
    let mut out = Vec::new();
    for root in buf[..n.min(buf.len())].split(|&c| c == 0).filter(|r| !r.is_empty()) {
        let mut z: Vec<u16> = root.to_vec();
        z.push(0);
        if unsafe { GetDriveTypeW(z.as_ptr()) } != DRIVE_FIXED {
            continue;
        }
        let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
        if unsafe { GetDiskFreeSpaceExW(z.as_ptr(), &mut free, &mut total, &mut total_free) } == 0 {
            continue;
        }
        out.push(json!({ "path": wide(&z), "totalB": total, "freeB": free }));
    }
    out
}

fn net() -> Vec<Value> {
    let mut table: *mut MIB_IF_TABLE2 = null_mut();
    if unsafe { GetIfTable2(&mut table) } != 0 || table.is_null() {
        return Vec::new();
    }
    let rows = unsafe {
        let n = (*table).NumEntries as usize;
        std::slice::from_raw_parts((*table).Table.as_ptr(), n)
            .iter()
            .map(|r| Interface {
                name: wide(&r.Alias),
                if_type: r.Type,
                flags: r.InterfaceAndOperStatusFlags._bitfield,
                up: r.OperStatus == IfOperStatusUp,
                rx: r.InOctets,
                tx: r.OutOctets,
            })
            .collect::<Vec<_>>()
    };
    unsafe { FreeMibTable(table.cast()) };
    net_rows(&rows)
}

fn processes() -> Vec<(u32, String)> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let snap = Handle(snap);
    let mut out = Vec::new();
    let mut e: PROCESSENTRY32W = Default::default();
    e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snap.0, &mut e) };
    while ok != 0 {
        if e.th32ProcessID != 0 {
            out.push((e.th32ProcessID, wide(&e.szExeFile)));
        }
        ok = unsafe { Process32NextW(snap.0, &mut e) };
    }
    out
}

/// (kernel + user time in 100 ns units, working set bytes).
fn process_usage(pid: u32) -> Option<(u64, u64)> {
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        return None;
    }
    let h = Handle(h);
    let z = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut c, mut x, mut k, mut u) = (z(), z(), z(), z());
    if unsafe { GetProcessTimes(h.0, &mut c, &mut x, &mut k, &mut u) } == 0 {
        return None;
    }
    let mut m: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    m.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let rss = if unsafe { K32GetProcessMemoryInfo(h.0, &mut m, m.cb) } != 0 { m.WorkingSetSize as u64 } else { 0 };
    Some((ft(&k) + ft(&u), rss))
}
