//! The streamer's end: one UDP socket for all viewers, a session per viewer.
//!
//! `native-helper tunnel host <base port> <udp port> <audio 0/1> <app pid> <lan ips> <ipv6 addrs>`
//!
//! Prints JSON lines: "ready" with this side's candidates once STUN answered,
//! then "offer", "up" and "down" per viewer. Lines on stdin:
//!   peer <id> <viewer key> <nat> <candidates>   a viewer the streamer let in
//!   cand <address>                               one more candidate (the router's port, a forwarded one)
//!   drop <id>                                    end that viewer's session
//!   stop                                         (or the end of input) end everything
//!
//! An "offer" carries this side's candidates as they are at that moment: the
//! NAT mapping is kept alive and checked every ten seconds, and a "cands"
//! event says when the outside address moved.
//!
//! Each session forwards to Sunshine on this computer only: its three TCP
//! ports and three UDP ports, nothing else. The sound of the computer, minus
//! the app's own process tree (the call), goes to every connected viewer as
//! PCM, so Sunshine's own capture, which would carry the call, stays off.

use std::collections::HashMap;
use std::io::BufRead;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::Rng;

use super::stream::Streams;
use super::wire::{self, Link, Socks, BYE, KEEPALIVE, PCM, PROBE, PROBE_ACK, SEG, ACK, RST, UDP};
use super::{json_line, path_of, predictions, stun, tcp_port, udp_port, Heard, Prober};

const MAX_SESSIONS: usize = 16;
/// How long the streamer waits for a viewer to knock first (see `Prober`).
/// The viewer's probes and these answers make the path, so a long wait
/// slows nothing down; the streamer's own probes are for when that fails.
const HOLD: Duration = Duration::from_secs(3);

struct Session {
    id: String,
    link: Arc<Link>,
    prober: Mutex<Prober>,
    heard: Heard,
    streams: Arc<Streams>,
    flows: Vec<Arc<UdpSocket>>,
    up: AtomicBool,
    born: Instant,
}

struct Host {
    base: u16,
    socks: Arc<Socks>,
    keeper: stun::Keeper,
    lan: Vec<SocketAddr>,
    extra: Mutex<Vec<SocketAddr>>,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    /// Addresses packets came from that were not a session's: reported once, for the stream log.
    stray: Heard,
    audio: bool,
    pid: u32,
    audio_running: AtomicBool,
    pcm_seq: AtomicU32,
}

impl Host {
    /// The candidates now: home network, IPv6, the outside address, and the ones added.
    fn cands(&self) -> Vec<SocketAddr> {
        let mut out = self.lan.clone();
        if let Some(m) = self.keeper.mapped() {
            out.push(SocketAddr::V4(m));
        }
        for c in self.extra.lock().map(|e| e.clone()).unwrap_or_default() {
            if !out.contains(&c) {
                out.push(c);
            }
        }
        out.dedup();
        out
    }

    fn cands_text(&self) -> String {
        self.cands().iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",")
    }

    fn session(&self, sid: u32) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(&sid).cloned()
    }

    fn list(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().map(|m| m.values().cloned().collect()).unwrap_or_default()
    }

    fn close(&self, sid: u32, reason: &str) {
        let Some(s) = self.sessions.lock().ok().and_then(|mut m| m.remove(&sid)) else { return };
        s.link.send(&self.socks, &[BYE]);
        s.link.closed.store(true, Ordering::Relaxed);
        s.streams.close_all();
        json_line(&format!("{{\"ev\":\"down\",\"id\":\"{}\",\"reason\":\"{reason}\"}}", s.id));
    }

    /// The sound starts with the first viewer and stops when the last one is gone.
    fn wake_audio(self: &Arc<Self>) {
        if !self.audio || self.audio_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let host = self.clone();
        std::thread::spawn(move || {
            let mut idle_since: Option<Instant> = None;
            let res = crate::audio::capture_to(host.pid, false, &mut |chunk| {
                let up: Vec<Arc<Session>> = host.list().into_iter().filter(|s| s.up.load(Ordering::Relaxed)).collect();
                if up.is_empty() {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    return since.elapsed() < Duration::from_secs(2);
                }
                idle_since = None;
                // 5 ms frames: one packet each, well under the path's MTU
                for frame in chunk.chunks(crate::audio::CHUNK / 2) {
                    let seq = host.pcm_seq.fetch_add(1, Ordering::Relaxed);
                    let mut p = Vec::with_capacity(5 + frame.len());
                    p.push(PCM);
                    p.extend_from_slice(&seq.to_be_bytes());
                    p.extend_from_slice(frame);
                    for s in &up {
                        s.link.send(&host.socks, &p);
                    }
                }
                true
            });
            if let Err(e) = res {
                json_line(&format!("{{\"ev\":\"audio-error\",\"text\":{}}}", crate::moonlight::json_str(&e)));
            }
            host.audio_running.store(false, Ordering::SeqCst);
        });
    }

    fn handle(self: &Arc<Self>, from: SocketAddr, buf: &mut [u8]) {
        if stun::is_stun(buf) {
            if self.keeper.answer(buf, from).is_some() {
                json_line(&format!("{{\"ev\":\"cands\",\"cands\":\"{}\"}}", self.cands_text()));
            }
            return;
        }
        let Some(sid) = wire::session_of(buf) else { return self.stray(from, "not the tunnel's") };
        let Some(s) = self.session(sid) else { return self.stray(from, "no such session") };
        let Some((ctr, body)) = s.link.open(buf) else { return self.stray(from, "does not open") };
        let Some(&kind) = body.first() else { return };
        s.link.received(from, ctr, kind);
        match kind {
            PROBE if body.len() >= 9 => {
                let mut ack = [0u8; 9];
                ack[0] = PROBE_ACK;
                ack[1..9].copy_from_slice(&body[1..9]);
                s.link.send_to(&self.socks, &ack, from);
                if let Ok(mut p) = s.prober.lock() {
                    p.add(from);
                    p.release();
                }
                if s.heard.note(from) {
                    json_line(&format!("{{\"ev\":\"probe-in\",\"id\":\"{}\",\"from\":\"{from}\"}}", s.id));
                }
            }
            UDP if body.len() >= 2 => {
                if let Some(f) = s.flows.get(body[1] as usize) {
                    let _ = f.send(&body[2..]);
                }
            }
            SEG => {
                let base = self.base;
                let to_sunshine = move |port: u8| tcp_port(base, port).map(|p| SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), p));
                s.streams.on_seg(&s.link, &self.socks, body, Some(&to_sunshine));
            }
            ACK => s.streams.on_ack(body),
            RST => s.streams.on_rst(body),
            BYE => {
                self.close(sid, "bye");
                return;
            }
            _ => {}
        }
        // the viewer picked a path and talks over it: the session is up
        if kind != PROBE && kind != PROBE_ACK && !s.up.swap(true, Ordering::SeqCst) {
            if let Ok(mut p) = s.prober.lock() {
                p.done = true;
            }
            json_line(&format!("{{\"ev\":\"up\",\"id\":\"{}\",\"path\":\"{}\"}}", s.id, path_of(&from)));
            self.wake_audio();
        }
    }

    /// A packet that is no session's: an old viewer, a stranger, or a viewer whose keys differ.
    fn stray(&self, from: SocketAddr, why: &str) {
        if self.stray.note(from) {
            json_line(&format!("{{\"ev\":\"stray\",\"from\":\"{from}\",\"why\":\"{why}\"}}"));
        }
    }

    fn add_peer(self: &Arc<Self>, id: &str, key: &str, nat: &str, cands: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
            return Err("bad viewer id".into());
        }
        let viewer = wire::parse_key(key).ok_or("bad viewer key")?;
        let mut targets = wire::parse_candidates(cands);
        if targets.is_empty() {
            return Err("the viewer has no candidates".into());
        }
        if nat == "symmetric" {
            targets.extend(predictions(&targets));
        }
        if self.sessions.lock().map(|m| m.len()).unwrap_or(MAX_SESSIONS) >= MAX_SESSIONS {
            return Err("too many viewers".into());
        }
        let own = wire::keypair()?;
        let host_pub = own.public;
        let (h2v, v2h) = wire::derive(own, &viewer, &host_pub, &viewer)?;

        let mut flows = Vec::new();
        for i in 0..3u8 {
            let to = udp_port(self.base, i).ok_or("bad port")?;
            let sock = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
            sock.connect((Ipv4Addr::LOCALHOST, to)).map_err(|e| e.to_string())?;
            wire::tune(&sock);
            let _ = sock.set_read_timeout(Some(Duration::from_millis(250)));
            flows.push(Arc::new(sock));
        }

        let session = {
            let mut map = self.sessions.lock().map_err(|_| "lock")?;
            let mut sid: u32 = rand::thread_rng().gen();
            while sid == 0 || map.contains_key(&sid) {
                sid = rand::thread_rng().gen();
            }
            let s = Arc::new(Session {
                id: id.to_string(),
                link: Arc::new(Link::new(sid, h2v, v2h)),
                prober: Mutex::new(Prober::new(targets, Some(HOLD))),
                heard: Heard::default(),
                streams: Streams::new(),
                flows,
                up: AtomicBool::new(false),
                born: Instant::now(),
            });
            map.insert(sid, s.clone());
            s
        };

        // what Sunshine sends goes to the viewer
        for (i, flow) in session.flows.iter().enumerate() {
            let (flow, s, socks) = (flow.clone(), session.clone(), self.socks.clone());
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 65536];
                buf[0] = UDP;
                buf[1] = i as u8;
                while !s.link.closed.load(Ordering::Relaxed) {
                    match flow.recv(&mut buf[2..]) {
                        Ok(n) => {
                            s.link.send(&socks, &buf[..2 + n]);
                        }
                        Err(_) => continue,
                    }
                }
            });
        }

        json_line(&format!(
            "{{\"ev\":\"offer\",\"id\":\"{id}\",\"sid\":{},\"key\":\"{}\",\"cands\":\"{}\"}}",
            session.link.sid,
            hex::encode(host_pub),
            self.cands_text()
        ));
        let targets = session.prober.lock().map(|p| p.targets_text()).unwrap_or_default();
        json_line(&format!("{{\"ev\":\"probing\",\"id\":\"{id}\",\"nat\":{},\"targets\":\"{targets}\"}}", crate::moonlight::json_str(nat)));
        Ok(())
    }

    fn tick(self: &Arc<Self>) {
        for s in self.list() {
            if !s.up.load(Ordering::Relaxed) {
                if let Ok(mut p) = s.prober.lock() {
                    p.tick(&s.link, &self.socks);
                }
                if s.born.elapsed() > Duration::from_secs(45) {
                    json_line(&format!("{{\"ev\":\"punch-failed\",\"id\":\"{}\",\"heard\":\"{}\"}}", s.id, s.heard.text()));
                    self.close(s.link.sid, "punch");
                    continue;
                }
            } else {
                if s.link.idle_tx() > Duration::from_secs(2) {
                    s.link.send(&self.socks, &[KEEPALIVE]);
                }
                if s.link.idle_rx() > Duration::from_secs(20) {
                    self.close(s.link.sid, "timeout");
                    continue;
                }
            }
            s.streams.tick(&s.link, &self.socks);
        }
    }
}

pub fn run(args: &[String]) -> Result<(), String> {
    let num = |i: usize| args.get(i).and_then(|v| v.parse::<u32>().ok());
    let base = num(0).filter(|p| (1030..=65000).contains(p)).ok_or("bad base port")? as u16;
    let port = num(1).filter(|p| *p == 0 || (1024..=65535).contains(p)).ok_or("bad udp port")? as u16;
    let audio = args.get(2).map(String::as_str) == Some("1");
    let pid = num(3).unwrap_or(0);
    let lan: Vec<Ipv4Addr> = args.get(4).map(|l| l.split(',').filter_map(|p| p.parse().ok()).collect()).unwrap_or_default();
    let v6: Vec<Ipv6Addr> = args.get(5).map(|l| l.split(',').filter_map(|p| p.parse().ok()).collect()).unwrap_or_default();

    let v4 = wire::bind_v4(port).map_err(|e| format!("cannot open UDP port {port}: {e}"))?;
    wire::tune(&v4);
    let local_port = v4.local_addr().map_err(|e| e.to_string())?.port();
    let v6sock = if v6.is_empty() {
        None
    } else {
        UdpSocket::bind((Ipv6Addr::UNSPECIFIED, local_port)).or_else(|_| UdpSocket::bind((Ipv6Addr::UNSPECIFIED, 0))).ok()
    };
    if let Some(s) = &v6sock {
        wire::tune(s);
    }

    let seen = stun::look(&v4, &lan);
    let mut home: Vec<SocketAddr> = lan.iter().map(|ip| SocketAddr::new(IpAddr::V4(*ip), local_port)).collect();
    if let Some(s) = &v6sock {
        let p6 = s.local_addr().map(|a| a.port()).unwrap_or(0);
        home.extend(v6.iter().map(|ip| SocketAddr::new(IpAddr::V6(*ip), p6)));
    }

    let host = Arc::new(Host {
        base,
        keeper: stun::Keeper::new(&seen),
        lan: home,
        extra: Mutex::new(Vec::new()),
        socks: Arc::new(Socks::new(v4, v6sock)),
        sessions: Mutex::new(HashMap::new()),
        stray: Heard::default(),
        audio,
        pid,
        audio_running: AtomicBool::new(false),
        pcm_seq: AtomicU32::new(0),
    });
    json_line(&format!(
        "{{\"ev\":\"ready\",\"port\":{local_port},\"nat\":\"{}\",\"ip\":\"{}\",\"seen\":\"{}\",\"cands\":\"{}\"}}",
        seen.nat,
        seen.mapped.map(|m| m.ip().to_string()).unwrap_or_default(),
        seen.text(),
        host.cands_text()
    ));

    for v6 in [false, true] {
        let host = host.clone();
        let sock = if v6 { host.socks.v6.as_ref().and_then(|s| s.try_clone().ok()) } else { host.socks.v4.try_clone().ok() };
        let Some(sock) = sock else { continue };
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 65536];
            loop {
                if let Some((n, from)) = wire::recv(&sock, &mut buf) {
                    host.handle(from, &mut buf[..n]);
                }
            }
        });
    }
    {
        let host = host.clone();
        std::thread::spawn(move || {
            let mut asked = Instant::now();
            loop {
                host.tick();
                if asked.elapsed() >= Duration::from_secs(10) {
                    asked = Instant::now();
                    host.socks.with_v4(|s| host.keeper.ask(s));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["peer", id, key, nat, cands] => {
                if let Err(e) = host.add_peer(id, key, nat, cands) {
                    json_line(&format!("{{\"ev\":\"refused\",\"id\":{},\"text\":{}}}", crate::moonlight::json_str(id), crate::moonlight::json_str(&e)));
                }
            }
            ["cand", addr] => {
                if let Ok(a) = addr.parse::<SocketAddr>() {
                    if wire::candidate_ok(&a) {
                        if let Ok(mut e) = host.extra.lock() {
                            if !e.contains(&a) && e.len() < 4 {
                                e.push(a);
                            }
                        }
                    }
                }
            }
            ["drop", id] => {
                for s in host.list().into_iter().filter(|s| s.id == *id) {
                    host.close(s.link.sid, "dropped");
                }
            }
            ["stop"] => break,
            _ => {}
        }
    }
    for s in host.list() {
        host.close(s.link.sid, "stop");
    }
    std::thread::sleep(Duration::from_millis(100));
    std::process::exit(0);
}
