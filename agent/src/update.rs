//! Updates offered by the hub (docs/protocol.md, Updates), and uninstalling.

use crate::config::{self, Config};
use crate::protocol;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
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
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &exe).map_err(|e| format!("{}: {e}", exe.display()))?;
    Ok(version.to_string())
}

/// Stops and removes the systemd user unit, the binary and the settings.
pub fn uninstall() -> Result<(), String> {
    let unit_dir = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| config::home().join(".config")).join("systemd/user");
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
