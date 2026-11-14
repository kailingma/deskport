//! A `term` stream (docs/protocol.md): attaches to the persistent tmux session
//! through a pseudo-terminal, with the messages of shim/terminal.js.
//!
//! Browser -> agent: JSON {type:"input", data} | {type:"resize", cols, rows},
//!   and with ?flow=1 {type:"ack", chars} (UTF-16 length) and {type:"ping", id}.
//! Agent -> browser: output as text messages; binary messages holding JSON
//!   {type:"pong", id} with ?flow=1.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const BATCH: Duration = Duration::from_millis(4);
const PING: Duration = Duration::from_secs(25);
const SECRET_PREFIXES: &[&str] = &["RDP_", "CF_ACCESS_", "DESKPORT_", "GUACD_"];

fn flow_high() -> usize {
    std::env::var("DESKPORT_TERM_WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(128 * 1024)
}

pub fn tmux_session() -> String {
    std::env::var("DESKPORT_TMUX_SESSION").unwrap_or_else(|_| "web".into())
}

pub fn tmux_available() -> bool {
    Command::new("tmux").arg("-V").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

struct Pty {
    master: File,
    child: Child,
}

fn set_size(fd: i32, cols: u16, rows: u16) {
    let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) };
}

fn spawn_tmux(session: &str, cwd: &str) -> std::io::Result<Pty> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = libc::winsize { ws_row: 30, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &ws) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    let mut cmd = Command::new("tmux");
    cmd.args(["new-session", "-A", "-s", session, "-c", cwd]).current_dir(cwd);
    cmd.env_clear();
    for (k, v) in std::env::vars_os() {
        let ks = k.to_string_lossy();
        if !SECRET_PREFIXES.iter().any(|p| ks.starts_with(p)) {
            cmd.env(&k, &v);
        }
    }
    cmd.env("TERM", "xterm-256color").env("COLORTERM", "truecolor");
    cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    Ok(Pty { master: File::from(master), child })
}

/// Splits bytes into the valid UTF-8 text and the bytes of a character that is not complete yet.
pub fn decode(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                return out;
            }
            Err(e) => {
                let good = e.valid_up_to();
                out.push_str(std::str::from_utf8(&carry[..good]).unwrap());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        carry.drain(..good + n);
                    }
                    None => {
                        carry.drain(..good);
                        return out;
                    }
                }
            }
        }
    }
}

pub async fn serve<S>(ws: tokio_tungstenite::WebSocketStream<S>, query: &str)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let flow = query.trim_start_matches('?').split('&').any(|kv| kv == "flow=1");
    let session = tmux_session();
    let cwd = std::env::var("DESKPORT_TERM_CWD").unwrap_or_else(|_| crate::config::home().to_string_lossy().into_owned());
    let (mut tx, mut rx) = ws.split();
    let mut pty = match spawn_tmux(&session, &cwd) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("terminal: tmux did not start: {e}");
            let _ = tx.send(Message::Close(Some(CloseFrame { code: CloseCode::Error, reason: "tmux did not start".into() }))).await;
            return;
        }
    };
    eprintln!("terminal: attached to tmux session \"{session}\" (pid {}{})", pty.child.id(), if flow { ", flow control" } else { "" });
    let fd = pty.master.as_raw_fd();

    // The pseudo-terminal is read on its own thread. The channel holds a few
    // chunks; while flow control pauses, nothing is taken from it, the thread
    // blocks, and tmux sees a slow client.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(4);
    let mut reader = pty.master.try_clone().expect("pty clone");
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let mut writer = pty.master.try_clone().expect("pty clone");
    std::thread::spawn(move || {
        while let Ok(b) = in_rx.recv() {
            if writer.write_all(&b).is_err() {
                break;
            }
        }
    });

    let high = flow_high();
    let low = high / 2;
    let mut carry = Vec::new();
    let mut pending = String::new();
    let mut deadline: Option<Instant> = None;
    let mut last_send = Instant::now() - BATCH;
    let mut unacked: usize = 0;
    let mut paused = false;
    let mut exited = false;
    let mut ping = tokio::time::interval_at(Instant::now() + PING, PING);

    loop {
        tokio::select! {
            chunk = out_rx.recv(), if !paused && !exited => match chunk {
                Some(c) => {
                    pending.push_str(&decode(&mut carry, &c));
                    if deadline.is_none() {
                        if last_send.elapsed() >= BATCH { deadline = Some(Instant::now()); } else { deadline = Some(last_send + BATCH); }
                    }
                }
                None => exited = true,
            },
            _ = async { sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                deadline = None;
                if !pending.is_empty() {
                    let data = std::mem::take(&mut pending);
                    if flow {
                        unacked += data.encode_utf16().count();
                        if unacked > high { paused = true; }
                    }
                    last_send = Instant::now();
                    if tx.send(Message::text(data)).await.is_err() { break; }
                }
            },
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v["type"].as_str() {
                    Some("input") => if let Some(d) = v["data"].as_str() { let _ = in_tx.send(d.as_bytes().to_vec()); },
                    Some("resize") => {
                        let cols = v["cols"].as_i64().unwrap_or(100).clamp(2, 500) as u16;
                        let rows = v["rows"].as_i64().unwrap_or(30).clamp(2, 300) as u16;
                        set_size(fd, cols, rows);
                    }
                    Some("ack") if flow => {
                        unacked = unacked.saturating_sub(v["chars"].as_f64().unwrap_or(0.0) as usize);
                        if paused && unacked < low { paused = false; }
                    }
                    Some("ping") if flow => {
                        let pong = json!({ "type": "pong", "id": v["id"] }).to_string();
                        if tx.send(Message::binary(pong.into_bytes())).await.is_err() { break; }
                    }
                    _ => {}
                }
            },
            _ = ping.tick() => { if tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; } },
        }
        if exited && deadline.is_none() && pending.is_empty() {
            eprintln!("terminal: tmux client exited");
            let _ = tx.send(Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "terminal exited".into() }))).await;
            break;
        }
    }
    // Closing detaches the tmux client; the session keeps running.
    let _ = pty.child.kill();
    let _ = pty.child.wait();
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn utf8_split_across_reads() {
        let mut carry = Vec::new();
        let bytes = "aé€😀".as_bytes();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&decode(&mut carry, std::slice::from_ref(b)));
        }
        assert_eq!(out, "aé€😀");
        assert!(carry.is_empty());
        assert_eq!(decode(&mut carry, b"a\xffb"), "a\u{FFFD}b");
    }
}
