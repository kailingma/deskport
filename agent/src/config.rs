//! The agent's files: `agent.json` (hub URL, id, name) and `agent.key` (the
//! Ed25519 private key seed, base64url, readable by this user only), in
//! `$DESKPORT_AGENT_CONFIG_DIR`, else on Linux `$XDG_CONFIG_HOME/deskport-agent`
//! or `~/.config/deskport-agent`, on Windows `%APPDATA%\deskport-agent`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    /// The hub's base URL, e.g. https://desk.example.com
    pub hub: String,
    pub id: String,
    pub name: String,
    /// The hub's release key (raw Ed25519, base64url); builds it offers must be signed with it.
    #[serde(default, rename = "releaseKey", skip_serializing_if = "Option::is_none")]
    pub release_key: Option<String>,
}

pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("DESKPORT_AGENT_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    #[cfg(windows)]
    if let Some(d) = std::env::var_os("APPDATA") {
        return PathBuf::from(d).join("deskport-agent");
    }
    #[cfg(not(windows))]
    if let Some(d) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(d).join("deskport-agent");
    }
    crate::sys::home().join(".config").join("deskport-agent")
}

/// Opens `path` for writing, empty, so that only this user can read it
/// (`private`) or with the usual permissions.
#[cfg(not(windows))]
fn create(path: &std::path::Path, private: bool) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(if private { 0o600 } else { 0o644 }).open(path)
}

#[cfg(windows)]
fn create(path: &std::path::Path, private: bool) -> std::io::Result<fs::File> {
    let f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    if private {
        crate::winsec::owner_only(path)?;
    }
    Ok(f)
}

pub fn load() -> Result<(Config, [u8; 32]), String> {
    let d = dir();
    let cfg: Config = serde_json::from_str(
        &fs::read_to_string(d.join("agent.json")).map_err(|e| format!("{}: {e}. Join a hub first: deskport-agent join <hub url> <token>", d.join("agent.json").display()))?,
    )
    .map_err(|e| format!("agent.json: {e}"))?;
    let key = fs::read_to_string(d.join("agent.key")).map_err(|e| format!("agent.key: {e}"))?;
    let seed = crate::protocol::b64d(key.trim()).map_err(|_| "agent.key: not base64url".to_string())?;
    let seed: [u8; 32] = seed.try_into().map_err(|_| "agent.key: not 32 bytes".to_string())?;
    Ok((cfg, seed))
}

pub fn save(cfg: &Config, seed: &[u8; 32]) -> Result<(), String> {
    let d = dir();
    fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    let write = |name: &str, body: &str, private: bool| -> Result<(), String> {
        let tmp = d.join(format!("{name}.tmp"));
        let _ = fs::remove_file(&tmp);
        let mut f = create(&tmp, private).map_err(|e| format!("{name}: {e}"))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("{name}: {e}"))?;
        drop(f);
        fs::rename(&tmp, d.join(name)).map_err(|e| format!("{name}: {e}"))
    };
    write("agent.key", &format!("{}\n", crate::protocol::b64(seed)), true)?;
    write("agent.json", &format!("{}\n", serde_json::to_string_pretty(cfg).unwrap()), false)
}
