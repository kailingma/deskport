//! Bitrate and frame gating for the video encodings: the logic of
//! shim/ratecontrol.js (which explains it), kept the same so the agent and
//! the hub's own machine behave alike. Times are milliseconds.

const MIN_RTT_WINDOW_MS: f64 = 10000.0;
const RATE_WINDOW_MS: f64 = 3000.0;
const HOLD_AFTER_DROP_MS: f64 = 1500.0;
const FLOOR: f64 = 150.0;

struct Sent {
    seq: u32,
    bytes: usize,
    at: f64,
}

pub struct RateControl {
    fixed: bool,
    speed: bool,
    slack: f64,
    ceiling: f64,
    kbps: f64,
    inflight: Vec<Sent>,
    last_ack_at: Option<f64>,
    rtts: Vec<(f64, f64)>,
    rates: Vec<(f64, f64)>,
    sent_log: Vec<(f64, usize)>,
    srtt: Option<f64>,
    hold_until: f64,
    last_step: f64,
    closed_at: f64,
}

impl RateControl {
    /// `bitrate`: "auto" adapts, a number is a fixed kbit/s. `ceiling`: highest kbit/s Adapt may choose.
    pub fn new(bitrate: &str, speed: bool, ceiling: f64) -> Self {
        let fixed = bitrate.parse::<f64>().ok();
        RateControl {
            fixed: fixed.is_some(),
            speed,
            slack: if speed { 80.0 } else { 250.0 },
            ceiling,
            kbps: fixed.unwrap_or_else(|| ceiling.min(if speed { 2500.0 } else { 800.0 })),
            inflight: Vec::new(),
            last_ack_at: None,
            rtts: Vec::new(),
            rates: Vec::new(),
            sent_log: Vec::new(),
            srtt: None,
            hold_until: 0.0,
            last_step: f64::NEG_INFINITY,
            closed_at: f64::NEG_INFINITY,
        }
    }

    fn min_rtt(&self) -> Option<f64> {
        self.rtts.iter().map(|r| r.1).reduce(f64::min)
    }

    fn max_rate(&self) -> Option<f64> {
        self.rates.iter().map(|r| r.1).reduce(f64::max)
    }

    fn sent_rate(&mut self, now: f64) -> f64 {
        self.sent_log.retain(|s| s.0 >= now - 1000.0);
        self.sent_log.iter().map(|s| s.1).sum::<usize>() as f64 * 8.0 / 1000.0
    }

    pub fn sent(&mut self, seq: u32, bytes: usize, now: f64) {
        self.inflight.push(Sent { seq, bytes, at: now });
        self.sent_log.push((now, bytes));
    }

    pub fn acked(&mut self, seq: u32, now: f64) {
        let base = self.min_rtt();
        let mut bytes = 0;
        let mut queued = false;
        while self.inflight.first().is_some_and(|f| f.seq <= seq) {
            let f = self.inflight.remove(0);
            bytes += f.bytes;
            if f.seq != seq {
                continue;
            }
            let rtt = now - f.at;
            self.rtts.push((now, rtt));
            self.srtt = Some(self.srtt.map_or(rtt, |s| s * 0.8 + rtt * 0.2));
            queued = matches!((base, self.last_ack_at), (Some(b), Some(l)) if f.at < l - b);
        }
        if bytes == 0 {
            return;
        }
        if let Some(last) = self.last_ack_at
            && queued
            && now - last >= 2.0
        {
            self.rates.push((now, bytes as f64 * 8.0 / (now - last)));
        }
        self.last_ack_at = Some(now);
        self.rtts.retain(|r| r.0 >= now - MIN_RTT_WINDOW_MS);
        self.rates.retain(|r| r.0 >= now - RATE_WINDOW_MS);
    }

    /// Whether the encoder may encode a new frame now.
    pub fn open(&mut self, now: f64) -> bool {
        let Some(oldest) = self.inflight.first() else { return true };
        let base = self.min_rtt().unwrap_or(300.0);
        let limit = (base * 1.5).max(base + self.slack);
        let bytes: usize = self.inflight.iter().map(|f| f.bytes).sum();
        let open = now - oldest.at < limit && self.max_rate().is_none_or(|rate| bytes as f64 * 8.0 / rate < limit);
        if !open {
            self.closed_at = now;
        }
        open
    }

    /// Called every 250 ms or so; returns the bitrate the encoder should use.
    pub fn step(&mut self, now: f64) -> u32 {
        if self.fixed || now - self.last_step < 200.0 {
            return self.kbps as u32;
        }
        self.last_step = now;
        let (Some(base), Some(srtt)) = (self.min_rtt(), self.srtt) else { return self.kbps as u32 };
        let queueing = srtt > base + 40f64.max(base * 0.3) || self.closed_at > now - 300.0 || !self.open(now);
        let rate = self.max_rate();
        if queueing {
            if now >= self.hold_until {
                let next = match rate {
                    Some(r) if r * 0.85 < self.kbps => r * 0.85,
                    _ => self.kbps * 0.95,
                };
                self.kbps = FLOOR.max(next.round());
                self.hold_until = now + HOLD_AFTER_DROP_MS;
            }
        } else if now >= self.hold_until && self.sent_rate(now) >= self.kbps * 0.5 {
            let cap = rate.map_or(self.ceiling, |r| self.ceiling.min(r * 0.95));
            if self.kbps < cap {
                self.kbps = cap.min((self.kbps * if self.speed { 1.08 } else { 1.04 }).round());
            }
        }
        self.kbps as u32
    }

    /// The numbers the page shows: kbps, sentKbps, rttMs, inflight.
    pub fn stats(&mut self, now: f64) -> serde_json::Value {
        serde_json::json!({
            "kbps": self.kbps as u32,
            "sentKbps": self.sent_rate(now).round() as u32,
            "rttMs": self.min_rtt().map(|r| r.round() as u32),
            "inflight": self.inflight.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_bitrate_stays() {
        let mut rc = RateControl::new("2000", true, 8000.0);
        assert_eq!(rc.step(0.0), 2000);
        rc.sent(1, 10000, 0.0);
        rc.acked(1, 50.0);
        assert_eq!(rc.step(1000.0), 2000);
    }

    #[test]
    fn gate_closes_on_an_old_frame_and_opens_on_its_ack() {
        let mut rc = RateControl::new("auto", true, 8000.0);
        rc.sent(1, 1000, 0.0);
        rc.acked(1, 40.0);
        rc.sent(2, 1000, 100.0);
        assert!(rc.open(150.0));
        assert!(!rc.open(300.0));
        rc.acked(2, 310.0);
        assert!(rc.open(320.0));
    }

    #[test]
    fn rises_while_on_time_and_falls_when_queueing() {
        let mut rc = RateControl::new("auto", true, 8000.0);
        let mut t = 0.0;
        let mut seq = 0;
        for _ in 0..20 {
            seq += 1;
            rc.sent(seq, 100_000, t);
            rc.acked(seq, t + 30.0);
            t += 250.0;
            rc.step(t);
        }
        let up = rc.step(t + 250.0);
        assert!(up > 2500, "{up}");
        for _ in 0..10 {
            seq += 1;
            rc.sent(seq, 100_000, t);
            rc.acked(seq, t + 400.0);
            t += 250.0;
            rc.step(t);
        }
        assert!(rc.step(t + 2000.0) < up);
    }
}
