//! Output of a terminal that outlives its connections (Windows): kept as a
//! tail of recent bytes for the next connection, and copied to every
//! connection attached now. The terminal is never slowed down for a
//! connection; one that falls a queue behind is let go and reconnects.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Clears the screen and scrollback before a replay, so the page does not
/// show the output twice.
const CLEAR: &[u8] = b"\x1b[H\x1b[2J\x1b[3J";

pub struct Fanout {
    inner: Mutex<Inner>,
    tail_cap: usize,
    queue: usize,
}

struct Inner {
    tail: VecDeque<u8>,
    /// Whether bytes have been dropped from the front of the tail.
    cut: bool,
    subs: Vec<(u64, mpsc::Sender<Vec<u8>>)>,
    behind: HashSet<u64>,
    next: u64,
    closed: bool,
}

impl Fanout {
    /// `tail_cap` bytes are kept for replay; each connection may be `queue`
    /// chunks behind.
    pub fn new(tail_cap: usize, queue: usize) -> Self {
        Fanout { inner: Mutex::new(Inner { tail: VecDeque::new(), cut: false, subs: Vec::new(), behind: HashSet::new(), next: 0, closed: false }), tail_cap, queue }
    }

    /// A new connection: its id, its output, and what to show it first. None
    /// once the terminal has ended.
    pub fn subscribe(&self) -> Option<(u64, mpsc::Receiver<Vec<u8>>, Vec<u8>)> {
        let mut s = self.inner.lock().unwrap();
        if s.closed {
            return None;
        }
        let (tx, rx) = mpsc::channel(self.queue);
        let id = s.next;
        s.next += 1;
        s.subs.push((id, tx));
        let mut tail: Vec<u8> = s.tail.iter().copied().collect();
        if s.cut {
            // Start at a line, not inside a character or an escape sequence.
            match tail.iter().position(|&b| b == b'\n') {
                Some(i) => drop(tail.drain(..=i)),
                None => tail.clear(),
            }
        }
        let replay = if tail.is_empty() { Vec::new() } else { [CLEAR, &tail].concat() };
        Some((id, rx, replay))
    }

    pub fn push(&self, chunk: &[u8]) {
        let mut s = self.inner.lock().unwrap();
        s.tail.extend(chunk);
        if s.tail.len() > self.tail_cap {
            let extra = s.tail.len() - self.tail_cap;
            s.tail.drain(..extra);
            s.cut = true;
        }
        let mut behind = Vec::new();
        s.subs.retain(|(id, tx)| match tx.try_send(chunk.to_vec()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                behind.push(*id);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
        s.behind.extend(behind);
    }

    /// The terminal ended: every connection's output ends.
    pub fn close(&self) {
        let mut s = self.inner.lock().unwrap();
        s.closed = true;
        s.subs.clear();
    }

    pub fn is_closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    pub fn unsubscribe(&self, id: u64) {
        let mut s = self.inner.lock().unwrap();
        s.subs.retain(|(i, _)| *i != id);
        s.behind.remove(&id);
    }

    /// Whether this connection's output ended because it fell behind.
    pub fn was_behind(&self, id: u64) -> bool {
        self.inner.lock().unwrap().behind.contains(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_the_tail_from_a_line_start() {
        let f = Fanout::new(8, 4);
        let (_, _rx, replay) = f.subscribe().unwrap();
        assert!(replay.is_empty(), "nothing to replay yet");
        f.push(b"ab\ncd");
        let (_, _rx2, replay) = f.subscribe().unwrap();
        assert_eq!(replay, [CLEAR, b"ab\ncd"].concat());
        f.push(b"\x1b[1mxyz\nok");
        // The tail is the last 8 bytes, "1mxyz\nok", cut to the line start.
        let (_, _rx3, replay) = f.subscribe().unwrap();
        assert_eq!(replay, [CLEAR, b"ok"].concat());
    }

    #[test]
    fn copies_to_every_connection_and_lets_slow_ones_go() {
        let f = Fanout::new(1024, 2);
        let (a, mut ra, _) = f.subscribe().unwrap();
        let (b, mut rb, _) = f.subscribe().unwrap();
        f.push(b"1");
        assert_eq!(ra.try_recv().unwrap(), b"1");
        f.push(b"2");
        f.push(b"3");
        // a took one chunk and has room; b has two queued and gets let go on the third.
        assert_eq!(ra.try_recv().unwrap(), b"2");
        assert_eq!(ra.try_recv().unwrap(), b"3");
        f.push(b"4");
        assert!(!f.was_behind(a));
        assert!(f.was_behind(b));
        assert_eq!(rb.try_recv().unwrap(), b"1");
        assert_eq!(rb.try_recv().unwrap(), b"2");
        assert!(rb.try_recv().is_err(), "b's output ended");
        assert_eq!(ra.try_recv().unwrap(), b"4");
        f.unsubscribe(a);
        f.push(b"5");
        assert!(ra.try_recv().is_err());
    }

    #[test]
    fn closing_ends_every_output() {
        let f = Fanout::new(16, 2);
        let (id, mut rx, _) = f.subscribe().unwrap();
        f.close();
        assert!(f.is_closed());
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)));
        assert!(!f.was_behind(id));
        assert!(f.subscribe().is_none());
    }
}
