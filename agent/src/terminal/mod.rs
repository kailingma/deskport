//! A `term` stream (docs/protocol.md), with the messages of shim/terminal.js.
//! On Linux it attaches to the persistent tmux session through a
//! pseudo-terminal (unix.rs); on Windows to a shell in a pseudo console that
//! outlives the connection (windows.rs).
//!
//! Browser -> agent: JSON {type:"input", data} | {type:"resize", cols, rows},
//!   and with ?flow=1 {type:"ack", chars} (UTF-16 length) and {type:"ping", id}.
//! Agent -> browser: output as text messages; binary messages holding JSON
//!   {type:"pong", id} with ?flow=1.

#[cfg_attr(not(windows), allow(dead_code))]
mod fanout;
#[cfg(not(windows))]
mod unix;
#[cfg(not(windows))]
use unix as pty;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as pty;

pub use pty::available;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const BATCH: Duration = Duration::from_millis(4);
const PING: Duration = Duration::from_secs(25);

fn flow_high() -> usize {
    std::env::var("DESKPORT_TERM_WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(128 * 1024)
}

fn permits_input(read_only: bool, kind: Option<&str>) -> bool {
    !read_only || matches!(kind, Some("ack" | "ping"))
}

/// Why a connection's output ended.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum End {
    /// The terminal program exited.
    Exited,
    /// The connection fell too far behind the output and was let go; the
    /// page reconnects and gets the recent output again.
    Behind,
}

/// One connection's view of a terminal.
pub struct Attached {
    /// Output as it comes. While nothing is taken from it, the terminal
    /// program is slowed down (Linux) or the connection falls behind (Windows).
    pub output: mpsc::Receiver<Vec<u8>>,
    pub input: std::sync::mpsc::Sender<Vec<u8>>,
    /// Output to show before anything new (Windows: the recent output).
    pub replay: Vec<u8>,
    /// For the log: what was attached.
    pub label: String,
    pub conn: pty::Conn,
}

pub fn cwd() -> String {
    std::env::var("DESKPORT_TERM_CWD").unwrap_or_else(|_| crate::sys::home().to_string_lossy().into_owned())
}

/// A Windows environment block (UTF-16 `name=value` entries, each ending in
/// NUL, sorted by name without case, then one more NUL) without the secrets.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn env_block(vars: impl Iterator<Item = (String, String)>) -> Vec<u16> {
    let mut vars: Vec<(String, String)> = vars.filter(|(k, _)| !k.is_empty() && !crate::sys::is_secret(k)).collect();
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut out = Vec::new();
    for (k, v) in vars {
        out.extend(format!("{k}={v}").encode_utf16());
        out.push(0);
    }
    out.push(0);
    if out.len() == 1 {
        out.push(0);
    }
    out
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
    let read_only = crate::protocol::read_only(query);
    let (mut tx, mut rx) = ws.split();
    let Attached { output: mut out_rx, input: in_tx, replay, label, conn } = match pty::attach(&cwd(), read_only) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("terminal: did not start: {e}");
            let _ = tx.send(Message::Close(Some(CloseFrame { code: CloseCode::Error, reason: "the terminal did not start".into() }))).await;
            return;
        }
    };
    eprintln!("terminal: attached to {label}{}", if flow { " (flow control)" } else { "" });

    let high = flow_high();
    let low = high / 2;
    let mut carry = Vec::new();
    let mut pending = decode(&mut carry, &replay);
    let mut deadline: Option<Instant> = if pending.is_empty() { None } else { Some(Instant::now()) };
    let mut last_send = Instant::now() - BATCH;
    let mut unacked: usize = 0;
    let mut paused = false;
    let mut exited = false;
    let mut end = End::Exited;
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
                None => { exited = true; end = conn.end(); }
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
                if !permits_input(read_only, v["type"].as_str()) { continue; }
                match v["type"].as_str() {
                    Some("input") => if let Some(d) = v["data"].as_str() { let _ = in_tx.send(d.as_bytes().to_vec()); },
                    Some("resize") => {
                        let cols = v["cols"].as_i64().unwrap_or(100).clamp(2, 500) as u16;
                        let rows = v["rows"].as_i64().unwrap_or(30).clamp(2, 300) as u16;
                        conn.resize(cols, rows);
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
            let (code, reason) = match end {
                End::Exited => (CloseCode::Normal, "terminal exited"),
                End::Behind => (CloseCode::Again, "fell behind the terminal's output"),
            };
            eprintln!("terminal: {reason}");
            let _ = tx.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
            break;
        }
    }
    conn.detach();
}

#[cfg(test)]
mod tests {
    use super::{decode, env_block, permits_input};

    #[test]
    fn read_only_accepts_flow_control_not_terminal_control() {
        for kind in [Some("input"), Some("resize"), Some("future-command"), None] {
            assert!(!permits_input(true, kind));
            assert!(permits_input(false, kind));
        }
        assert!(permits_input(true, Some("ack")));
        assert!(permits_input(true, Some("ping")));
    }

    #[test]
    fn environment_block() {
        let vars = [("path", "C:\\x"), ("DESKPORT_TERM_SHELL", "cmd"), ("Apple", "1"), ("rdp_user", "u")].map(|(k, v)| (k.to_string(), v.to_string()));
        let block = env_block(vars.into_iter());
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "Apple=1\0path=C:\\x\0\0");
        assert_eq!(env_block(std::iter::empty()), vec![0, 0]);
    }

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
