//! The agent's files: `agent.json` (hub URL, id, name) and `agent.key` (the
//! Ed25519 private key seed, base64url, mode 600), in
//! `$DESKPORT_AGENT_CONFIG_DIR`, else `$XDG_CONFIG_HOME/deskport-agent`, else
//! `~/.config/deskport-agent`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    /// The hub's base URL, e.g. https://desk.example.com
    pub hub: String,
    pub id: String,
    pub name: String,
}

pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("DESKPORT_AGENT_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(d).join("deskport-agent");
    }
    home().join(".config").join("deskport-agent")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
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
    let write = |name: &str, body: &str, mode: u32| -> Result<(), String> {
        let tmp = d.join(format!("{name}.tmp"));
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp).map_err(|e| format!("{name}: {e}"))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("{name}: {e}"))?;
        fs::rename(&tmp, d.join(name)).map_err(|e| format!("{name}: {e}"))
    };
    write("agent.key", &format!("{}\n", crate::protocol::b64(seed)), 0o600)?;
    write("agent.json", &format!("{}\n", serde_json::to_string_pretty(cfg).unwrap()), 0o644)
}
