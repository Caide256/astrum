//! A direct, encrypted tunnel between two computers for streams through Sunshine.
//!
//! Sunshine is a server: a viewer has to reach its ports, which a router lets
//! through only when they are forwarded by hand, and never behind a
//! provider's NAT. The tunnel makes that unnecessary, the way WebRTC calls
//! and P2P games do it:
//!
//! 1. Each side opens one UDP socket and asks STUN servers how the internet
//!    sees it. Its local, IPv6 and outside addresses are its candidates.
//! 2. The apps swap candidates and fresh X25519 public keys through the call
//!    (the streamer only for viewers it let in).
//! 3. Both sides send probes to all of the other's candidates at once. Each
//!    router then takes the other side's probes for answers to its own and
//!    lets them in: the hole is punched. The viewer keeps the best path that
//!    answered (the home network, then IPv6, then the fastest).
//! 4. Everything then goes through that path, sealed with AES-256-GCM:
//!    Sunshine's TCP connections (stream.rs) and UDP packets, and the
//!    computer's sound without the call (Sunshine's own capture would carry
//!    the call too).
//!
//! On the viewer's computer the tunnel stands in for Sunshine on a loopback
//! address, so Moonlight connects there as if Sunshine were local. On the
//! streamer's computer it forwards to Sunshine's ports and nowhere else.
//! Sunshine itself needs no open port: nothing from outside reaches it but
//! the tunnel of a viewer the streamer let in.
//!
//! It fails only when both sides are behind NATs that give every
//! destination a new outside port ("symmetric"); a few ports past the seen
//! one are tried for those, which catches the common sequential kind.

mod host;
mod stream;
mod stun;
mod view;
mod wire;

use std::cmp::Reverse;
use std::io::Write;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use wire::{Link, Socks, PROBE};

/// Sunshine's TCP ports, by number: HTTPS, HTTP, RTSP.
pub fn tcp_port(base: u16, idx: u8) -> Option<u16> {
    match idx {
        0 => base.checked_sub(5),
        1 => Some(base),
        2 => base.checked_add(21),
        _ => None,
    }
}

/// Sunshine's UDP ports, by number: video, control, audio.
pub fn udp_port(base: u16, idx: u8) -> Option<u16> {
    match idx {
        0..=2 => base.checked_add(9 + idx as u16),
        _ => None,
    }
}

/// One JSON event line on stdout.
pub fn json_line(s: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{s}");
    let _ = out.flush();
}

pub fn path_of(addr: &SocketAddr) -> &'static str {
    if wire::is_lan(addr) {
        "lan"
    } else if addr.is_ipv6() {
        "v6"
    } else {
        "wan"
    }
}

/// A symmetric NAT gives each destination the next free port or so: the ports after the seen ones.
pub fn predictions(targets: &[SocketAddr]) -> Vec<SocketAddr> {
    let mut out = Vec::new();
    for t in targets.iter().filter(|t| t.is_ipv4() && !wire::is_lan(t)) {
        for step in 1..=16u16 {
            if let Some(p) = t.port().checked_add(step) {
                let a = SocketAddr::new(t.ip(), p);
                if !targets.contains(&a) && !out.contains(&a) {
                    out.push(a);
                }
            }
        }
    }
    out.truncate(32);
    out
}

/// Probes to the other side's candidates until a path answers.
pub struct Prober {
    targets: Vec<SocketAddr>,
    start: Instant,
    last: Option<Instant>,
    answers: Vec<(SocketAddr, u64)>,
    first: Option<Instant>,
    pub done: bool,
}

impl Prober {
    pub fn new(targets: Vec<SocketAddr>) -> Self {
        Prober { targets, start: Instant::now(), last: None, answers: Vec::new(), first: None, done: false }
    }

    /// An address a probe came from that was not on the list: the other side's NAT shows it this way.
    pub fn add(&mut self, a: SocketAddr) {
        if !self.done && !self.targets.contains(&a) && self.targets.len() < 64 && wire::candidate_ok(&a) {
            self.targets.push(a);
        }
    }

    pub fn targets_text(&self) -> String {
        self.targets.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(",")
    }

    pub fn answers(&self) -> usize {
        self.answers.len()
    }

    /// Every 50 ms at first, every 100 ms up to the eighth second, then every 300 ms.
    pub fn tick(&mut self, link: &Link, socks: &Socks) {
        if self.done {
            return;
        }
        let age = self.start.elapsed();
        let every = if age < Duration::from_secs(3) {
            50
        } else if age < Duration::from_secs(8) {
            100
        } else {
            300
        };
        if self.last.map(|t| t.elapsed() < Duration::from_millis(every)).unwrap_or(false) {
            return;
        }
        self.last = Some(Instant::now());
        let mut p = [0u8; 9];
        p[0] = PROBE;
        p[1..9].copy_from_slice(&wire::now_us().to_be_bytes());
        for t in &self.targets {
            link.send_to(socks, &p, *t);
        }
    }

    /// An answer to a probe; true the first time this address answered.
    pub fn answered(&mut self, from: SocketAddr, rtt_us: u64) -> bool {
        self.first.get_or_insert_with(Instant::now);
        if self.answers.iter().any(|(a, _)| *a == from) {
            return false;
        }
        self.answers.push((from, rtt_us));
        true
    }

    /// The path to use, once answers had 100 ms to come in: a path through the home network answers about as fast.
    pub fn pick(&mut self) -> Option<(SocketAddr, u64)> {
        let first = self.first?;
        if first.elapsed() < Duration::from_millis(100) {
            return None;
        }
        let class = |a: &SocketAddr| if wire::is_lan(a) { 3 } else if a.is_ipv6() { 2 } else { 1 };
        let best = self.answers.iter().max_by_key(|(a, rtt)| (class(a), Reverse(*rtt))).copied();
        self.done = true;
        best
    }
}

/// Addresses probes came from: each is reported once, for the stream log.
#[derive(Default)]
pub struct Heard(std::sync::Mutex<Vec<SocketAddr>>);

impl Heard {
    /// True the first time an address is heard.
    pub fn note(&self, a: SocketAddr) -> bool {
        let Ok(mut list) = self.0.lock() else { return false };
        if list.contains(&a) || list.len() >= 64 {
            return false;
        }
        list.push(a);
        true
    }

    pub fn text(&self) -> String {
        self.0.lock().map(|l| l.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default()
    }
}

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("host") => host::run(&args[1..]),
        Some("view") => view::run(&args[1..]),
        Some("probe") => stun::probe(&args[1..]),
        _ => Err("usage: tunnel host|view|probe ...".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sunshine_ports() {
        assert_eq!(tcp_port(49989, 0), Some(49984));
        assert_eq!(tcp_port(49989, 2), Some(50010));
        assert_eq!(tcp_port(49989, 3), None);
        assert_eq!(udp_port(49989, 0), Some(49998));
        assert_eq!(udp_port(49989, 2), Some(50000));
        assert_eq!(udp_port(49989, 9), None);
    }

    #[test]
    fn predictions_skip_home_addresses() {
        let t: Vec<SocketAddr> = vec!["192.168.1.5:5000".parse().unwrap(), "203.0.113.4:40000".parse().unwrap()];
        let p = predictions(&t);
        assert_eq!(p.len(), 16);
        assert!(p.iter().all(|a| a.ip().to_string() == "203.0.113.4"));
    }
}
