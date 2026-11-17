//! Updates offered by the hub (docs/protocol.md, Updates), and uninstalling.

use crate::config::{self, Config};
use crate::protocol;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// Exit status after replacing the binary; the service manager starts the new one.
pub const RESTART: i32 = 75;
const MAX_SIZE: u64 = 64 << 20;

pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Dotted version numbers: whether a is newer than b.
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Checks a build against the release key: SHA-256 and the signature over
/// "deskport-agent-build-1\n<platform>\n<version>\n<sha256 hex>".
pub fn check(release_key: &str, platform: &str, version: &str, sha256_hex: &str, signature: &str, body: &[u8]) -> Result<(), String> {
    let digest = hex(&Sha256::digest(body));
    if digest != sha256_hex {
        return Err("SHA-256 does not match".into());
    }
    let key: [u8; 32] = protocol::b64d(release_key).ok().and_then(|k| k.try_into().ok()).ok_or("bad release key")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "bad release key")?;
    let sig = Signature::from_slice(&protocol::b64d(signature).map_err(|_| "bad signature")?).map_err(|_| "bad signature")?;
    let msg = format!("deskport-agent-build-1\n{platform}\n{version}\n{sha256_hex}");
    key.verify(msg.as_bytes(), &sig).map_err(|_| "signature does not match the hub's release key".to_string())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Downloads, checks and installs the offered build. Returns its version.
pub fn apply(cfg: &Config, seed: &[u8; 32], offer: &Value) -> Result<String, String> {
    let release_key = cfg.release_key.as_deref().ok_or("no release key from joining; join again to get updates")?;
    let version = offer["version"].as_str().ok_or("no version")?;
    let path = offer["path"].as_str().ok_or("no path")?;
    let sha = offer["sha256"].as_str().ok_or("no sha256")?;
    let sig = offer["signature"].as_str().ok_or("no signature")?;
    let size = offer["size"].as_u64().ok_or("no size")?;
    let platform = platform();
    if path != format!("{}download/{platform}", protocol::PREFIX) {
        return Err(format!("offered a build for another platform ({path})"));
    }
    if !newer(version, env!("CARGO_PKG_VERSION")) {
        return Err(format!("{version} is not newer than {}", env!("CARGO_PKG_VERSION")));
    }
    if size > MAX_SIZE {
        return Err("too large".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(300))).build().into();
    let mut req = agent.get(&format!("{}{path}", cfg.hub.trim_end_matches('/')));
    for (k, v) in protocol::sign_upgrade(&cfg.id, seed, path, protocol::now_ms()) {
        req = req.header(k, &v);
    }
    let mut res = req.call().map_err(|e| format!("download: {e}"))?;
    if res.status().as_u16() != 200 {
        return Err(format!("download: HTTP {}", res.status().as_u16()));
    }
    let mut body = Vec::with_capacity(size as usize);
    res.body_mut().as_reader().take(MAX_SIZE + 1).read_to_end(&mut body).map_err(|e| format!("download: {e}"))?;
    if body.len() as u64 != size {
        return Err(format!("download: {} bytes, expected {size}", body.len()));
    }
    check(release_key, &platform, version, sha, sig, &body)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, &body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    replace(&tmp, &exe)?;
    Ok(version.to_string())
}

#[cfg(not(windows))]
fn replace(new: &Path, exe: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(new, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(new, exe).map_err(|e| format!("{}: {e}", exe.display()))
}

/// Windows does not let a running program's file be replaced or deleted,
/// but it may be renamed: the running one becomes `<name>.<time>.old`, which
/// `remove_old_builds` deletes once nothing runs from it.
#[cfg(windows)]
fn replace(new: &Path, exe: &Path) -> Result<(), String> {
    let old = old_name(exe, protocol::now_ms() as u64);
    std::fs::rename(exe, &old).map_err(|e| format!("{}: {e}", exe.display()))?;
    if let Err(e) = std::fs::rename(new, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("{}: {e}", exe.display()));
    }
    Ok(())
}

/// `C:\...\deskport-agent.exe` -> `C:\...\deskport-agent.<stamp>.old`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn old_name(exe: &Path, stamp: u64) -> std::path::PathBuf {
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "deskport-agent".into());
    exe.with_file_name(format!("{stem}.{stamp}.old"))
}

/// Deletes the builds `replace` renamed; those still running stay.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn remove_old_builds(exe: &Path) {
    let (Some(dir), Some(stem)) = (exe.parent(), exe.file_stem()) else { return };
    let prefix = format!("{}.", stem.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".old") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Stops and removes the systemd user unit, the binary and the settings.
#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
    let unit_dir = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| crate::sys::home().join(".config")).join("systemd/user");
    let unit = unit_dir.join("deskport-agent.service");
    if unit.exists() {
        let _ = std::process::Command::new("systemctl").args(["--user", "disable", "--now", "deskport-agent.service"]).status();
        std::fs::remove_file(&unit).map_err(|e| format!("{}: {e}", unit.display()))?;
        let _ = std::process::Command::new("systemctl").args(["--user", "daemon-reload"]).status();
        println!("removed {}", unit.display());
    }
    let dir = config::dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        println!("removed {}", dir.display());
    }
    if let Ok(exe) = std::env::current_exe() {
        std::fs::remove_file(&exe).map_err(|e| format!("{}: {e}", exe.display()))?;
        println!("removed {}", exe.display());
    }
    println!("To remove this machine from the hub too, use Remove on its dashboard.");
    Ok(())
}

/// Removes the scheduled task (or Startup shortcut), the settings, the log
/// and the binary, then ends the running agent.
#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
    use std::process::{Command, Stdio};
    let quiet = |cmd: &mut Command| cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if quiet(Command::new("schtasks.exe").args(["/Delete", "/TN", crate::runner::TASK, "/F"])) {
        println!("removed the scheduled task {}", crate::runner::TASK);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let lnk = std::path::PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs\\Startup").join(format!("{}.lnk", crate::runner::TASK));
        if lnk.exists() {
            std::fs::remove_file(&lnk).map_err(|e| format!("{}: {e}", lnk.display()))?;
            println!("removed {}", lnk.display());
        }
    }
    let dir = config::dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        println!("removed {}", dir.display());
    }
    // The running agent may hold its log open; tried again after it has ended.
    let logs = crate::runner::log_dir();
    let logs_left = logs.exists() && std::fs::remove_dir_all(&logs).is_err();
    if logs.exists() && !logs_left {
        println!("removed {}", logs.display());
    }
    if let Ok(exe) = std::env::current_exe() {
        // A running program cannot be deleted, but it can be moved out of the
        // way: to the temporary folder, else next to itself.
        let stamp = protocol::now_ms() as u64;
        let temp = std::env::temp_dir().join(format!("deskport-agent-{stamp}.old"));
        let gone = if std::fs::rename(&exe, &temp).is_ok() { temp } else {
            let old = old_name(&exe, stamp);
            std::fs::rename(&exe, &old).map_err(|e| format!("{}: {e}", exe.display()))?;
            old
        };
        remove_old_builds(&exe);
        if let Some(dir) = exe.parent().filter(|d| d.file_name().is_some_and(|n| n == "deskport-agent")) {
            let _ = std::fs::remove_dir(dir);
        }
        println!("removed {} (what is left is {}, deleted with the temporary files or by hand)", exe.display(), gone.display());
    }
    println!("To remove this machine from the hub too, use Remove on its dashboard.");
    // Last, since a terminal opened through the agent ends with it.
    let me = std::process::id().to_string();
    quiet(Command::new("taskkill.exe").args(["/F", "/IM", "deskport-agent.exe", "/FI", &format!("PID ne {me}")]));
    if logs_left {
        std::thread::sleep(std::time::Duration::from_secs(1));
        match std::fs::remove_dir_all(&logs) {
            Ok(()) => println!("removed {}", logs.display()),
            Err(e) => println!("could not remove {}: {e}", logs.display()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn versions() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1", "0.1.0"));
    }

    #[test]
    fn old_builds_are_renamed_then_removed() {
        let dir = std::env::temp_dir().join(format!("deskport-old-{}", protocol::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("deskport-agent.exe");
        let old = old_name(&exe, 42);
        assert_eq!(old.file_name().unwrap(), "deskport-agent.42.old");
        for f in [&exe, &old, &dir.join("deskport-agent.json")] {
            std::fs::write(f, b"x").unwrap();
        }
        remove_old_builds(&exe);
        assert!(exe.exists() && !old.exists() && dir.join("deskport-agent.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn builds_are_checked_against_the_release_key() {
        let key = SigningKey::from_bytes(&protocol::random::<32>());
        let body = b"new agent";
        let sha = hex(&Sha256::digest(body));
        let sig = protocol::b64(&key.sign(format!("deskport-agent-build-1\nlinux-x86_64\n0.2.0\n{sha}").as_bytes()).to_bytes());
        let pubkey = protocol::b64(key.verifying_key().as_bytes());
        assert!(check(&pubkey, "linux-x86_64", "0.2.0", &sha, &sig, body).is_ok());
        assert!(check(&pubkey, "linux-x86_64", "0.3.0", &sha, &sig, body).is_err(), "version is signed");
        assert!(check(&pubkey, "linux-x86_64", "0.2.0", &sha, &sig, b"tampered").is_err());
        let other = protocol::b64(SigningKey::from_bytes(&protocol::random::<32>()).verifying_key().as_bytes());
        assert!(check(&other, "linux-x86_64", "0.2.0", &sha, &sig, body).is_err());
    }
}
