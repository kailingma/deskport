//! A `screen` stream and its `video` stream (docs/protocol.md), served from
//! the portal helper (scripts/portal-screen.py).
//!
//! To the page this looks like the hub machine's direct path (shim/direct.js):
//! the bridge speaks the part of the Guacamole protocol the page uses (the
//! tunnel's id, the display size, sync, nop, clipboard and error out; key,
//! mouse, sync and clipboard in). With "Images" the picture goes on the same
//! socket as JPEG `img` instructions, at most two frames ahead of the page's
//! sync replies. With a video encoding it goes on /ws/video as in
//! shim/video.js, paced by the same rate control (rate.rs).
//!
//! While the portal asks at the machine, the bridge sends a `name`
//! instruction with a line the page shows. Once sharing starts it sends
//! another: view only, clipboard unavailable, or empty for full control.
//! Input and clipboard go to the helper only as far as the portal granted.
//!
//! A video encoder that fails (helper exit 4 or 5) is reported on the video
//! stream, so the page reconnects with images; other helper exits end the
//! screen stream with an error.
//!
//! One viewer at a time: a new screen stream ends the one before, so two
//! portal sessions never ask at once.

use super::guac::{Parser, encode};
use super::rate::RateControl;
use crate::Ws;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, interval, sleep_until};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const NOP: Duration = Duration::from_secs(2);
const STEP: Duration = Duration::from_millis(250);
const ASK_HINT: Duration = Duration::from_millis(1500);
// Guacamole's mouse mask bits and the evdev buttons they stand for: left, middle, right.
const BUTTONS: [(u32, u32); 3] = [(1, 272), (2, 274), (4, 273)];
const SCROLL_UP: u32 = 8;
const SCROLL_DOWN: u32 = 16;
const CLIP_MAX: usize = 1 << 20;
const CLIP_BLOB_BYTES: usize = 6144;
const IMG_BLOB_CHARS: usize = 8064;
const IMAGES_AHEAD: usize = 2;
// How long a failed video encoder waits for the page's video stream to report to.
const VIDEO_ERROR_WAIT: Duration = Duration::from_secs(10);
// Helper exit codes for a pipeline error and something not installed.
const EXIT_PIPELINE: i32 = 4;
const EXIT_MISSING: i32 = 5;

static VIDEOS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Ws>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static VIEWER: Mutex<Option<(u64, oneshot::Sender<()>)>> = Mutex::new(None);
static NEXT_VIEWER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct Query {
    width: u32,
    height: u32,
    res: String,
    quality: String,
    priority: String,
    encoding: String,
    speed: u32,
    bitrate: String,
    read_only: bool,
}

fn parse_query(query: &str) -> Query {
    let mut m = HashMap::new();
    for kv in query.trim_start_matches('?').split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            m.insert(k, v);
        }
    }
    let int = |k: &str, d: u32, lo: u32, hi: u32| m.get(k).and_then(|v| v.parse::<u32>().ok()).map_or(d, |n| n.clamp(lo, hi));
    let pick = |k: &str, allowed: &[&str], d: &str| m.get(k).filter(|v| allowed.contains(v)).map_or(d, |v| v).to_string();
    Query {
        width: int("width", 1280, 320, 7680),
        height: int("height", 720, 240, 4320),
        res: pick("res", &["auto", "1", "0.75", "0.5", "0.33"], "auto"),
        quality: pick("quality", &["low", "medium", "high", "lossless"], "high"),
        priority: pick("priority", &["speed", "data"], "speed"),
        encoding: pick("encoding", &["images", "av1", "h264"], "images"),
        speed: int("speed", 0, 0, 2),
        bitrate: pick("bitrate", &["auto", "500", "1000", "2000", "5000", "10000", "20000"], "auto"),
        read_only: crate::protocol::read_only(query),
    }
}

/// Highest bitrate Adapt chooses for a quality, as in shim/video.js.
fn ceiling(quality: &str, priority: &str) -> f64 {
    let c = match quality {
        "low" => 1500.0,
        "medium" => 4000.0,
        "lossless" => 16000.0,
        _ => 8000.0,
    };
    if priority == "data" { c / 2.0 } else { c }
}

/// WebCodecs codec string for a stream of w x h, as in shim/video.js.
fn codec_string(codec: &str, w: u32, h: u32) -> String {
    if codec == "h264" {
        return "avc1.640034".into();
    }
    let area = w * h;
    let level = if area <= 2228224 { 8 } else if area <= 8912896 { 12 } else { 16 };
    format!("av01.0.{level:02}M.08")
}

/// CLOCK_MONOTONIC in milliseconds, the clock of the helper's capture times.
fn mono_ms() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

fn uuid() -> String {
    let b = crate::protocol::random::<16>();
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

enum Event {
    Record { kind: u8, key: bool, captured: f64, payload: Vec<u8> },
    Exit(Option<i32>),
}

/// The helper process: commands go to its stdin, records come from its stdout.
struct Helper {
    cmds: Option<std::sync::mpsc::Sender<String>>,
    child: Arc<Mutex<Child>>,
}

impl Helper {
    fn spawn(cfg: &Value, events: mpsc::UnboundedSender<Event>) -> Result<Helper, String> {
        let path = super::helper_path().map_err(|e| format!("the screen helper could not be written: {e}"))?;
        let mut child = Command::new("python3")
            .arg("-I")
            .arg(path)
            .arg("run")
            .arg(cfg.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("the screen helper did not start: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in rx {
                if stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("screen: {line}");
            }
        });
        let waiter = child.clone();
        std::thread::spawn(move || {
            let mut header = [0u8; 16];
            while stdout.read_exact(&mut header).is_ok() {
                let len = u32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
                let mut payload = vec![0; len];
                if stdout.read_exact(&mut payload).is_err() {
                    break;
                }
                let captured = f64::from_le_bytes(header[8..16].try_into().unwrap());
                if events.send(Event::Record { kind: header[4], key: header[5] != 0, captured, payload }).is_err() {
                    break;
                }
            }
            let code = loop {
                if let Ok(Some(st)) = waiter.lock().unwrap().try_wait() {
                    break st.code();
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            let _ = events.send(Event::Exit(code));
        });
        Ok(Helper { cmds: Some(tx), child })
    }

    fn send(&self, v: Value) {
        if let Some(c) = &self.cmds {
            let _ = c.send(v.to_string());
        }
    }
}

impl Drop for Helper {
    /// Closing stdin ends the helper; one that hangs is killed after 2 s.
    fn drop(&mut self) {
        self.cmds = None;
        let child = self.child.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let mut c = child.lock().unwrap();
            if matches!(c.try_wait(), Ok(None)) {
                let _ = c.kill();
            }
        });
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))
}

pub async fn serve_screen(ws: Ws, query: &str) {
    let q = parse_query(query);
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || close {
                break;
            }
        }
    });
    let out = |s: String| {
        let _ = out_tx.send(Message::text(s));
    };
    let fail = |message: &str| {
        let _ = out_tx.send(Message::text(encode(&["error", message, "519"])));
        let _ = out_tx.send(close_frame(1011, "519"));
    };

    // One viewer at a time.
    let me = NEXT_VIEWER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (bye_tx, mut bye_rx) = oneshot::channel();
    {
        let mut viewer = VIEWER.lock().unwrap();
        if q.read_only && viewer.as_ref().is_some_and(|(_, old)| !old.is_closed()) {
            fail("This screen is already being viewed. Try again after the other viewer disconnects.");
            return;
        }
        if let Some((_, old)) = viewer.replace((me, bye_tx)) {
            let _ = old.send(());
        }
    }

    let video_mode = q.encoding != "images";
    let supported = super::encodings().contains(&q.encoding);
    let codec = if video_mode && supported { q.encoding.as_str() } else { "images" };
    let images = codec == "images";
    let mut video_error = (video_mode && !supported).then(|| format!("This machine cannot encode {} video.", if q.encoding == "av1" { "AV1" } else { "H.264" }));
    let start = Instant::now();
    let now = || start.elapsed().as_secs_f64() * 1000.0;
    let mut rc = RateControl::new(&q.bitrate, q.priority != "data", ceiling(&q.quality, &q.priority));
    let mut sent_kbps = rc.step(now()).max(1);
    let fps = if q.priority == "data" { 10 } else { 30 };
    let cfg = json!({
        "codec": codec, "width": q.width, "height": q.height, "res": q.res, "quality": q.quality,
        "speed": q.speed, "kbps": sent_kbps, "fps": fps, "tokenFile": super::token_path(),
        "readOnly": q.read_only,
    });
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let helper = match Helper::spawn(&cfg, ev_tx) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("screen: {e}");
            fail(&format!("The screen could not start: {e}."));
            return;
        }
    };
    eprintln!("screen: {codec}, browser {}x{}, resolution {}, {}, {}", q.width, q.height, q.res, q.quality, q.priority);

    let tunnel = uuid();
    let (vtx, mut vrx) = mpsc::unbounded_channel::<Ws>();
    VIDEOS.lock().unwrap().insert(tunnel.clone(), vtx);
    // The tunnel's id first; the size and the first sync follow once the portal has started.
    out(encode(&["", &tunnel]));

    let machine = crate::sys::hostname();
    let mut parser = Parser::default();
    let mut started: Option<(u32, u32)> = None;
    let mut control = false;
    let mut clipboard = false;
    let mut helper_running = true;
    let mut give_up_at: Option<Instant> = None;
    let mut ask_at: Option<Instant> = None;
    let mut last_error = String::new();
    let mut mask = 0u32;
    let mut clips: HashMap<String, Vec<String>> = HashMap::new();
    let mut clip_index = 0u32;
    let mut last_ts = 0u64;
    let mut ts = move || {
        last_ts = (crate::protocol::now_ms() as u64).max(last_ts + 1);
        last_ts
    };
    let mut images_ahead: VecDeque<u64> = VecDeque::new();
    let mut encoder_open = true;
    let mut video_tx: Option<mpsc::UnboundedSender<Message>> = None;
    let mut video_rx: Option<futures_util::stream::SplitStream<Ws>> = None;
    let mut need_key = false;
    let mut seq = 0u32;
    let mut frames = 0u32;
    let mut encode_ms: Vec<f64> = Vec::new();
    let mut last_stats = now();
    let mut nop = interval(NOP);
    let mut step = interval(STEP);

    let send_video = |tx: &Option<mpsc::UnboundedSender<Message>>, v: Value| {
        if let Some(tx) = tx {
            let _ = tx.send(Message::text(v.to_string()));
        }
    };

    loop {
        tokio::select! {
            _ = &mut bye_rx => {
                fail("The screen was opened in another window.");
                break;
            }
            msg = stream.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => continue,
                };
                if text.starts_with("0.,") {
                    if text.starts_with("0.,4.ping,") { out(text); }
                    continue;
                }
                let Ok(instructions) = parser.push(&text) else { continue };
                for ins in instructions {
                    let arg = |i: usize| ins.get(i).map(String::as_str).unwrap_or("");
                    match arg(0) {
                        "key" if started.is_some() && control => {
                            let keysym: u32 = arg(1).parse().unwrap_or(0);
                            helper.send(json!({ "k": [keysym, arg(2) == "1"] }));
                        }
                        "mouse" if control => {
                            let Some((w, h)) = started else { continue };
                            let x = arg(1).parse::<f64>().unwrap_or(0.0).clamp(0.0, (w - 1) as f64);
                            let y = arg(2).parse::<f64>().unwrap_or(0.0).clamp(0.0, (h - 1) as f64);
                            let next: u32 = arg(3).parse().unwrap_or(0);
                            helper.send(json!({ "p": [x, y] }));
                            for (bit, button) in BUTTONS {
                                if next & bit != mask & bit { helper.send(json!({ "b": [button, next & bit != 0] })); }
                            }
                            if next & SCROLL_UP != 0 && mask & SCROLL_UP == 0 { helper.send(json!({ "a": [0, -1] })); }
                            if next & SCROLL_DOWN != 0 && mask & SCROLL_DOWN == 0 { helper.send(json!({ "a": [0, 1] })); }
                            mask = next;
                        }
                        "sync" => {
                            let t: u64 = arg(1).parse().unwrap_or(0);
                            while images_ahead.front().is_some_and(|&f| f <= t) { images_ahead.pop_front(); }
                            if images && !encoder_open && images_ahead.len() < IMAGES_AHEAD {
                                encoder_open = true;
                                helper.send(json!({ "open": true }));
                            }
                        }
                        "clipboard" if clipboard => {
                            clips.insert(arg(1).to_string(), Vec::new());
                            out(encode(&["ack", arg(1), "OK", "0"]));
                        }
                        "blob" if clips.contains_key(arg(1)) => {
                            let parts = clips.get_mut(arg(1)).unwrap();
                            parts.push(arg(2).to_string());
                            if parts.iter().map(String::len).sum::<usize>() > CLIP_MAX * 14 / 10 { clips.remove(arg(1)); }
                            out(encode(&["ack", arg(1), "OK", "0"]));
                        }
                        "end" if clips.contains_key(arg(1)) => {
                            let mut bytes = Vec::new();
                            for p in clips.remove(arg(1)).unwrap() {
                                bytes.extend(B64.decode(p.as_bytes()).unwrap_or_default());
                            }
                            if clipboard { helper.send(json!({ "clip": String::from_utf8_lossy(&bytes) })); }
                        }
                        "disconnect" => {
                            let _ = out_tx.send(close_frame(1000, ""));
                        }
                        _ => {}
                    }
                }
            }
            ev = ev_rx.recv(), if helper_running => {
                let Some(ev) = ev else { break };
                match ev {
                    Event::Exit(code) => {
                        let message = if last_error.is_empty() { format!("The screen helper stopped (exit code {}).", code.map_or("none".into(), |c| c.to_string())) } else { sentence(&last_error) };
                        eprintln!("screen: helper exited with {code:?}");
                        if !video_failure(images, code) {
                            fail(&message);
                            break;
                        }
                        // Keep the screen stream until the page hears on the
                        // video stream and reconnects with images.
                        helper_running = false;
                        ask_at = None;
                        if video_tx.is_some() {
                            send_video(&video_tx, json!({ "type": "error", "message": message }));
                        } else {
                            video_error = Some(message);
                        }
                        give_up_at = Some(Instant::now() + VIDEO_ERROR_WAIT);
                    }
                    Event::Record { kind: 1, payload, .. } => {
                        let Ok(m) = serde_json::from_slice::<Value>(&payload) else { continue };
                        match m["type"].as_str() {
                            Some("asking") => ask_at = Some(Instant::now() + ASK_HINT),
                            Some("started") => {
                                ask_at = None;
                                let (w, h) = (m["width"].as_u64().unwrap_or(2) as u32, m["height"].as_u64().unwrap_or(2) as u32);
                                started = Some((w, h));
                                control = !q.read_only && m["control"] == true;
                                clipboard = control && m["clipboard"] == true;
                                eprintln!("screen: started, {}x{} with {}{}", w, h, m["encoder"].as_str().unwrap_or("?"), if control { "" } else { ", view only" });
                                out(encode(&["size", "0", &w.to_string(), &h.to_string()]) + &encode(&["sync", &ts().to_string()]));
                                out(encode(&["name", &start_notice(q.read_only, control, clipboard, &machine)]));
                                if !images && video_tx.is_some() {
                                    send_video(&video_tx, json!({ "type": "config", "codec": codec_string(codec, w, h), "width": w, "height": h }));
                                    helper.send(json!({ "key": true }));
                                }
                            }
                            Some("clipboard") if clipboard => {
                                if let Some(text) = m["text"].as_str() {
                                    let index = (clip_index % 1000).to_string();
                                    clip_index += 1;
                                    let mut s = encode(&["clipboard", &index, "text/plain"]);
                                    for piece in text.as_bytes().chunks(CLIP_BLOB_BYTES) {
                                        s += &encode(&["blob", &index, &B64.encode(piece)]);
                                    }
                                    s += &encode(&["end", &index]);
                                    out(s);
                                }
                            }
                            Some("error") => last_error = m["message"].as_str().unwrap_or("").to_string(),
                            _ => {}
                        }
                    }
                    Event::Record { payload, key, captured, .. } if images => {
                        let t = ts();
                        let b64 = B64.encode(&payload);
                        let mut s = encode(&["img", "1", "14", "0", "image/jpeg", "0", "0"]);
                        for chunk in b64.as_bytes().chunks(IMG_BLOB_CHARS) {
                            s += &encode(&["blob", "1", std::str::from_utf8(chunk).unwrap()]);
                        }
                        s += &encode(&["end", "1"]);
                        s += &encode(&["sync", &t.to_string()]);
                        out(s);
                        let _ = (key, captured);
                        images_ahead.push_back(t);
                        if images_ahead.len() >= IMAGES_AHEAD && encoder_open {
                            encoder_open = false;
                            helper.send(json!({ "open": false }));
                        }
                    }
                    Event::Record { payload, key, captured, .. } => {
                        let Some(tx) = &video_tx else {
                            need_key = true;
                            continue;
                        };
                        seq += 1;
                        frames += 1;
                        if captured > 0.0 { encode_ms.push(mono_ms() - captured); }
                        let mut frame = Vec::with_capacity(payload.len() + 8);
                        frame.extend_from_slice(&seq.to_le_bytes());
                        frame.extend_from_slice(&[key as u8, 0, 0, 0]);
                        frame.extend_from_slice(&payload);
                        let _ = tx.send(Message::binary(frame));
                        let t = now();
                        rc.sent(seq, payload.len() + 8, t);
                        if encoder_open && !rc.open(t) {
                            encoder_open = false;
                            helper.send(json!({ "open": false }));
                        }
                    }
                }
            }
            ws = vrx.recv() => {
                let Some(ws) = ws else { continue };
                if video_tx.is_some() {
                    let mut ws = ws;
                    let _ = ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: "already attached".into() })).await;
                    continue;
                }
                let (mut vsink, vstream) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
                tokio::spawn(async move {
                    while let Some(m) = rx.recv().await {
                        let close = matches!(m, Message::Close(_));
                        if vsink.send(m).await.is_err() || close { break; }
                    }
                });
                video_tx = Some(tx);
                video_rx = Some(vstream);
                if let Some(e) = &video_error {
                    send_video(&video_tx, json!({ "type": "error", "message": e }));
                } else if let Some((w, h)) = started {
                    send_video(&video_tx, json!({ "type": "config", "codec": codec_string(codec, w, h), "width": w, "height": h }));
                    helper.send(json!({ "key": true }));
                    need_key = false;
                } else if need_key {
                    helper.send(json!({ "key": true }));
                }
            }
            vmsg = async { match video_rx.as_mut() { Some(s) => s.next().await, None => std::future::pending().await } } => {
                let text = match vmsg {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        video_tx = None;
                        video_rx = None;
                        continue;
                    }
                    _ => continue,
                };
                let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
                match m["type"].as_str() {
                    Some("ack") => {
                        if let Some(n) = m["seq"].as_u64() {
                            let t = now();
                            rc.acked(n as u32, t);
                            if !encoder_open && rc.open(t) {
                                encoder_open = true;
                                helper.send(json!({ "open": true }));
                            }
                        }
                    }
                    Some("key") => helper.send(json!({ "key": true })),
                    _ => {}
                }
            }
            _ = sleep_until(ask_at.unwrap_or_else(Instant::now)), if ask_at.is_some() => {
                ask_at = None;
                out(encode(&["name", &format!("Waiting for someone at {machine} to allow screen sharing.")]));
            }
            _ = sleep_until(give_up_at.unwrap_or_else(Instant::now)), if give_up_at.is_some() => {
                fail(&video_error.clone().unwrap_or_else(|| "The video encoder stopped.".into()));
                break;
            }
            _ = nop.tick() => out(encode(&["nop"])),
            _ = step.tick(), if !images && video_tx.is_some() && started.is_some() => {
                let t = now();
                if !encoder_open && rc.open(t) {
                    encoder_open = true;
                    helper.send(json!({ "open": true }));
                }
                let next = rc.step(t);
                if (next as f64 - sent_kbps as f64).abs() / sent_kbps as f64 > 0.03 {
                    sent_kbps = next.max(1);
                    helper.send(json!({ "kbps": next }));
                }
                if t - last_stats >= 1000.0 {
                    encode_ms.sort_by(|a, b| a.total_cmp(b));
                    let mut stats = rc.stats(t);
                    stats["type"] = json!("stats");
                    stats["fps"] = json!((frames as f64 * 1000.0 / (t - last_stats)).round() as u32);
                    stats["encodeMs"] = encode_ms.get(encode_ms.len() / 2).map_or(Value::Null, |m| json!(m.round() as i64));
                    send_video(&video_tx, stats);
                    frames = 0;
                    encode_ms.clear();
                    last_stats = t;
                }
            }
        }
    }

    VIDEOS.lock().unwrap().remove(&tunnel);
    {
        let mut v = VIEWER.lock().unwrap();
        if v.as_ref().is_some_and(|(id, _)| *id == me) {
            *v = None;
        }
    }
    if let Some(tx) = video_tx {
        let _ = tx.send(close_frame(1000, ""));
    }
    let _ = out_tx.send(close_frame(1000, ""));
    drop(helper);
}

/// Whether a helper exit is a video encoder failure the page can recover
/// from with images, rather than a refused or ended share.
fn video_failure(images: bool, code: Option<i32>) -> bool {
    !images && matches!(code, Some(EXIT_PIPELINE | EXIT_MISSING))
}

/// The `name` notice once sharing starts; empty clears the waiting notice.
fn start_notice(read_only: bool, control: bool, clipboard: bool, machine: &str) -> String {
    if read_only {
        "View only: you have Read access to this machine.".into()
    } else if !control {
        format!("View only: control was not allowed at {machine}.")
    } else if !clipboard {
        format!("Clipboard unavailable: clipboard sharing was not allowed at {machine}.")
    } else {
        String::new()
    }
}

/// The helper's error text as a sentence for the page.
fn sentence(s: &str) -> String {
    let mut c = s.chars();
    let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
    let mut out = first + c.as_str();
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

/// A browser's /ws/video?tunnel=<id>: handed to the screen stream that made the id.
pub async fn serve_video(ws: Ws, query: &str) {
    let tunnel = query.trim_start_matches('?').split('&').find_map(|kv| kv.strip_prefix("tunnel=")).unwrap_or("").to_string();
    let target = VIDEOS.lock().unwrap().get(&tunnel).cloned();
    match target {
        Some(tx) => {
            if let Err(e) = tx.send(ws) {
                let mut ws = e.0;
                let _ = ws.close(None).await;
            }
        }
        None => {
            let mut ws = ws;
            let _ = ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: "unknown tunnel".into() })).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_checked() {
        let q = parse_query("?width=99999&height=10&res=2&quality=high&encoding=h264&speed=7&bitrate=123");
        assert_eq!((q.width, q.height), (7680, 240));
        assert_eq!(q.res, "auto");
        assert_eq!(q.encoding, "h264");
        assert_eq!(q.speed, 2);
        assert_eq!(q.bitrate, "auto");
        assert!(!q.read_only);
        assert!(parse_query("?readonly=1&readonly=0").read_only);
    }

    #[test]
    fn codec_strings_match_the_shim() {
        assert_eq!(codec_string("h264", 1920, 1080), "avc1.640034");
        assert_eq!(codec_string("av1", 1920, 1080), "av01.0.08M.08");
        assert_eq!(codec_string("av1", 3840, 2160), "av01.0.12M.08");
    }

    #[test]
    fn only_video_encoder_failures_fall_back() {
        assert!(video_failure(false, Some(EXIT_PIPELINE)));
        assert!(video_failure(false, Some(EXIT_MISSING)));
        assert!(!video_failure(false, Some(3)));
        assert!(!video_failure(false, None));
        assert!(!video_failure(true, Some(EXIT_PIPELINE)));
    }

    #[test]
    fn start_notices_match_the_page() {
        assert_eq!(start_notice(false, true, true, "kde"), "");
        assert!(start_notice(false, false, true, "kde").starts_with("View only:"));
        assert!(start_notice(false, true, false, "kde").starts_with("Clipboard unavailable:"));
        assert!(start_notice(true, true, true, "kde").contains("Read access"));
    }

    #[test]
    fn errors_read_as_sentences() {
        assert_eq!(sentence("sharing was not allowed at the machine"), "Sharing was not allowed at the machine.");
    }
}
