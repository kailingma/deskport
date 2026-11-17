//! The screen of this machine, through the desktop portal (docs/agent.md,
//! Screen). Works on Wayland desktops whose xdg-desktop-portal offers
//! RemoteDesktop and ScreenCast, KDE Plasma and GNOME among them.
//!
//! The capture, the encoders and the portal calls are in a Python helper,
//! scripts/portal-screen.py, carried inside this binary and run with the
//! system's python3 and GStreamer (a static binary cannot load PipeWire or
//! GStreamer itself). This side speaks to the browser: the part of the
//! Guacamole protocol the page uses on `screen` streams, and the video
//! stream on `video` streams (bridge.rs).
//!
//! What the screen needs is checked by `probe`; what is missing is reported
//! to the hub as a note, which the page shows instead of the Screen view.

#[cfg(unix)]
mod bridge;
#[cfg_attr(not(unix), allow(dead_code))]
mod guac;
#[cfg_attr(not(unix), allow(dead_code))]
mod rate;

use serde_json::{Value, json};
use std::sync::RwLock;

#[cfg(unix)]
pub const HELPER: &str = include_str!("../../../scripts/portal-screen.py");

/// The last probe's result: the `screen` capability (or null) and a note.
static CURRENT: RwLock<(Value, Option<String>)> = RwLock::new((Value::Null, None));

/// The `screen` capability and the note from the last probe.
pub fn current() -> (Value, Option<String>) {
    CURRENT.read().unwrap().clone()
}

/// Encodings the last probe found, for checking a browser's choice.
#[cfg_attr(not(unix), allow(dead_code))]
fn encodings() -> Vec<String> {
    CURRENT.read().unwrap().0["encodings"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Checks again what the screen needs. Blocks for up to 20 s. Returns
/// whether the result differs from the one before.
pub fn probe() -> bool {
    let next = check();
    let mut cur = CURRENT.write().unwrap();
    if *cur == next {
        return false;
    }
    match &next {
        (Value::Null, Some(note)) => eprintln!("screen: not available: {note}"),
        (caps, _) => eprintln!("screen: available ({})", caps["encodings"]),
    }
    *cur = next;
    true
}

#[cfg(not(unix))]
fn check() -> (Value, Option<String>) {
    (Value::Null, None)
}

#[cfg(unix)]
fn check() -> (Value, Option<String>) {
    if std::env::var("DESKPORT_AGENT_SCREEN").is_ok_and(|v| v == "0") {
        return (Value::Null, Some("The screen is turned off on this machine (DESKPORT_AGENT_SCREEN=0).".into()));
    }
    if !crate::sys::which("python3") {
        return (Value::Null, Some("The screen needs Python 3 and GStreamer on this machine; python3 is not installed.".into()));
    }
    let path = match helper_path() {
        Ok(p) => p,
        Err(e) => return (Value::Null, Some(format!("The screen helper could not be written: {e}"))),
    };
    let out = match run_with_timeout(std::process::Command::new("python3").arg("-I").arg(&path).arg("probe"), std::time::Duration::from_secs(20)) {
        Ok(o) => o,
        Err(e) => return (Value::Null, Some(format!("The screen check failed: {e}"))),
    };
    let v: Value = out.lines().rev().find_map(|l| serde_json::from_str(l).ok()).unwrap_or(Value::Null);
    if v["screen"].is_object() {
        return (v["screen"].clone(), None);
    }
    (Value::Null, Some(v["note"].as_str().unwrap_or("The screen check gave no answer.").to_string()))
}

/// Runs a command and returns its standard output, killing it after `limit`.
#[cfg(unix)]
fn run_with_timeout(cmd: &mut std::process::Command, limit: std::time::Duration) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let start = std::time::Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err("it did not finish in time".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(reader.join().unwrap_or_default())
}

/// Writes the helper next to the agent's settings (again when this build's
/// copy differs) and returns its path.
#[cfg(unix)]
fn helper_path() -> std::io::Result<std::path::PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = crate::config::dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("portal-screen.py");
    if std::fs::read_to_string(&path).is_ok_and(|s| s == HELPER) {
        return Ok(path);
    }
    let tmp = dir.join("portal-screen.py.new");
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(HELPER.as_bytes())?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Where the portal's restore token is kept, so the person at the machine
/// is asked once rather than on every connection.
#[cfg(unix)]
fn token_path() -> std::path::PathBuf {
    crate::config::dir().join("screen-restore-token")
}

/// The capabilities object for `hello` and `capabilities` (docs/protocol.md).
pub fn capabilities(terminal: bool) -> Value {
    let (screen, note) = current();
    let mut caps = json!({ "screen": screen, "terminal": terminal, "files": false, "metrics": true, "readOnly": true });
    if let Some(note) = note {
        caps["notes"] = json!({ "screen": note });
    }
    caps
}

#[cfg(unix)]
pub use bridge::{serve_screen, serve_video};

#[cfg(not(unix))]
pub async fn serve_screen(ws: crate::Ws, _query: &str) {
    let mut ws = ws;
    let _ = ws.close(None).await;
}

#[cfg(not(unix))]
pub async fn serve_video(ws: crate::Ws, _query: &str) {
    let mut ws = ws;
    let _ = ws.close(None).await;
}
