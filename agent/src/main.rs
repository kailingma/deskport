//! deskport-agent: one per machine. Dials out to a deskport hub, keeps a
//! control socket open, sends metrics, and serves the terminal on the
//! streams the hub asks for (docs/protocol.md).
//!
//!   deskport-agent join <hub url> <join token> [--name <name>]
//!   deskport-agent run
//!   deskport-agent version

mod config;
mod metrics;
mod protocol;
mod terminal;

use futures_util::{SinkExt, StreamExt};
use protocol::{PREFIX, SUBPROTOCOL};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{Instant, interval_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const BACKOFF_MS: &[u64] = &[0, 1000, 2000, 4000, 8000, 15000];
const STEADY: Duration = Duration::from_secs(60);
const SILENCE: Duration = Duration::from_secs(60);
const REMOVED: &str = "this machine was removed from the hub";

fn usage() -> ! {
    eprintln!("usage: deskport-agent join <hub url> <join token> [--name <name>]\n       deskport-agent run\n       deskport-agent version");
    std::process::exit(2);
}

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_string()).unwrap_or_else(|_| "machine".into())
}

fn os_name() -> &'static str {
    std::env::consts::OS
}

fn join(args: &[String]) -> Result<(), String> {
    let (hub, token) = match args {
        [h, t, ..] => (h.trim_end_matches('/').to_string(), t.clone()),
        _ => usage(),
    };
    let name = args.iter().position(|a| a == "--name").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(hostname);
    if !(hub.starts_with("https://") || hub.starts_with("http://127.0.0.1") || hub.starts_with("http://localhost") || hub.starts_with("http://[::1]")) {
        return Err("the hub URL must be https:// (plain http only on loopback)".into());
    }
    let seed = protocol::random::<32>();
    let body = json!({ "token": token, "name": name, "os": os_name(), "arch": std::env::consts::ARCH, "publicKey": protocol::public_key(&seed) });
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(20))).build().into();
    let mut res = agent.post(&format!("{hub}/agent/v1/join")).send_json(&body).map_err(|e| format!("join: {e}"))?;
    let status = res.status().as_u16();
    let v: Value = res.body_mut().read_json().unwrap_or(Value::Null);
    if status != 200 {
        return Err(format!("join refused ({status}): {}", v["error"].as_str().unwrap_or("no reason given")));
    }
    let id = v["id"].as_str().ok_or("join: no id in the answer")?.to_string();
    config::save(&config::Config { hub, id: id.clone(), name }, &seed)?;
    println!("joined as {id}; settings in {}", config::dir().display());
    Ok(())
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn dial(cfg: &config::Config, seed: &[u8; 32], path: &str) -> Result<Ws, String> {
    let mut req = protocol::ws_url(&cfg.hub, path).into_client_request().map_err(|e| e.to_string())?;
    let h = req.headers_mut();
    h.insert("Sec-WebSocket-Protocol", HeaderValue::from_static(SUBPROTOCOL));
    for (k, v) in protocol::sign_upgrade(&cfg.id, seed, path, protocol::now_ms()) {
        h.insert(k, HeaderValue::from_str(&v).map_err(|e| e.to_string())?);
    }
    let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| e.to_string())?;
    Ok(ws)
}

fn valid_stream_id(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

enum Ended {
    Removed,
    Dropped,
}

/// One control socket, from hello until it closes.
async fn control(cfg: &config::Config, seed: &[u8; 32], connected: &mut Option<Instant>) -> Result<Ended, String> {
    let ws = dial(cfg, seed, &format!("{PREFIX}control")).await?;
    *connected = Some(Instant::now());
    let (mut tx, mut rx) = ws.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let caps = json!({ "screen": null, "terminal": terminal::tmux_available(), "files": false, "metrics": true });
    let hello = json!({ "type": "hello", "agent": { "version": VERSION, "os": os_name(), "arch": std::env::consts::ARCH, "name": cfg.name }, "capabilities": caps });
    tx.send(Message::text(hello.to_string())).await.map_err(|e| e.to_string())?;

    let mut collector = metrics::Collector::new();
    let mut every = Duration::from_secs(15);
    let mut tick = interval_at(Instant::now() + Duration::from_secs(3600 * 24 * 365), every);
    let mut welcomed = false;
    let mut last_seen = Instant::now();
    let mut watchdog = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            msg = rx.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => return Err(e.to_string()),
                    None => return Ok(Ended::Dropped),
                };
                last_seen = Instant::now();
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Close(f) => {
                        if f.as_ref().map(|f| u16::from(f.code)) == Some(4001) { return Ok(Ended::Removed); }
                        return Ok(Ended::Dropped);
                    }
                    _ => continue,
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v["type"].as_str() {
                    Some("welcome") => {
                        welcomed = true;
                        eprintln!("connected to {} as {} (protocol {})", cfg.hub, cfg.id, v["protocol"]);
                        every = Duration::from_millis(v["metrics"]["intervalMs"].as_u64().unwrap_or(15000).clamp(500, 600_000));
                        tick = interval_at(Instant::now(), every);
                    }
                    Some("metrics-rate") => {
                        every = Duration::from_millis(v["intervalMs"].as_u64().unwrap_or(15000).clamp(500, 600_000));
                        tick = interval_at(Instant::now(), every);
                    }
                    Some("ping") if welcomed => {
                        let _ = out_tx.send(json!({ "type": "pong", "id": v["id"] }).to_string());
                    }
                    Some("request") if welcomed => {
                        let _ = out_tx.send(json!({ "type": "response", "id": v["id"], "status": 404, "body": { "error": "not available on this machine" } }).to_string());
                    }
                    Some("open") if welcomed => {
                        let stream = v["stream"].as_str().unwrap_or("").to_string();
                        let kind = v["kind"].as_str().unwrap_or("").to_string();
                        if !valid_stream_id(&stream) { continue; }
                        if kind != "term" {
                            let _ = out_tx.send(json!({ "type": "stream-failed", "stream": stream, "message": format!("this machine has no {kind}") }).to_string());
                            continue;
                        }
                        let query = v["query"].as_str().unwrap_or("").to_string();
                        let (cfg, seed, out_tx) = (cfg.clone(), *seed, out_tx.clone());
                        tokio::spawn(async move {
                            match dial(&cfg, &seed, &format!("{PREFIX}stream/{stream}")).await {
                                Ok(ws) => terminal::serve(ws, &query).await,
                                Err(e) => {
                                    eprintln!("stream {kind}: {e}");
                                    let _ = out_tx.send(json!({ "type": "stream-failed", "stream": stream, "message": e }).to_string());
                                }
                            }
                        });
                    }
                    _ => {}
                }
            }
            Some(out) = out_rx.recv() => { tx.send(Message::text(out)).await.map_err(|e| e.to_string())?; }
            _ = tick.tick(), if welcomed => {
                let sample = tokio::task::block_in_place(|| collector.sample());
                tx.send(Message::text(json!({ "type": "metrics", "t": protocol::now_ms() as u64, "sample": sample }).to_string())).await.map_err(|e| e.to_string())?;
            }
            _ = watchdog.tick() => {
                if last_seen.elapsed() > SILENCE { return Err("no message from the hub for 60 s".into()); }
            }
        }
    }
}

async fn run() -> Result<(), String> {
    let (cfg, seed) = config::load()?;
    let mut attempt = 0usize;
    loop {
        let mut connected = None;
        let r = control(&cfg, &seed, &mut connected).await;
        match r {
            Ok(Ended::Removed) => return Err(format!("{REMOVED}; join it again to reconnect")),
            Ok(Ended::Dropped) => eprintln!("control socket closed"),
            Err(e) => eprintln!("control: {e}"),
        }
        if connected.is_some_and(|t| t.elapsed() > STEADY) {
            attempt = 0;
        }
        let base = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
        attempt += 1;
        let jitter = 1.0 + (protocol::random::<1>()[0] as f64 / 255.0) * 0.2;
        tokio::time::sleep(Duration::from_millis((base as f64 * jitter) as u64)).await;
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("join") => join(&args[1..]),
        Some("run") => tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap().block_on(run()),
        Some("version") | Some("--version") => {
            println!("deskport-agent {VERSION} (protocol {})", protocol::PROTOCOL);
            Ok(())
        }
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("deskport-agent: {e}");
        // 3: removed from the hub; the systemd unit does not restart on it.
        std::process::exit(if e.starts_with(REMOVED) { 3 } else { 1 });
    }
}
