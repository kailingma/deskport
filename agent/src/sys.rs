//! Small differences between the platforms: the machine's name, the home
//! directory and finding a program on PATH.

use std::path::PathBuf;

pub fn hostname() -> String {
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(windows))]
    let name = std::fs::read_to_string("/proc/sys/kernel/hostname").ok();
    name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "machine".into())
}

pub fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

/// Whether `cmd` is a file in a PATH directory (with `.exe` added on Windows).
pub fn which(cmd: &str) -> bool {
    let names: Vec<String> = if cfg!(windows) && !cmd.ends_with(".exe") { vec![format!("{cmd}.exe"), cmd.to_string()] } else { vec![cmd.to_string()] };
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| names.iter().any(|n| d.join(n).is_file())))
        .unwrap_or(false)
}

/// Environment variables the terminal does not pass on: the hub's and the
/// remote desktop's secrets.
pub const SECRET_PREFIXES: &[&str] = &["RDP_", "CF_ACCESS_", "DESKPORT_", "GUACD_"];

pub fn is_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    SECRET_PREFIXES.iter().any(|p| upper.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_matched_without_case() {
        assert!(is_secret("DESKPORT_TMUX_SESSION"));
        assert!(is_secret("Rdp_Password"));
        assert!(!is_secret("PATH"));
    }
}
