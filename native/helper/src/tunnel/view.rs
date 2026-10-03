//! The viewer's end: punches through to the streamer, then stands in for the
//! streamer's Sunshine on a loopback address of this computer.
//!
//! `native-helper tunnel view <base port> <lan ips> <ipv6 addrs>`
//!
//! Output: records of [kind u8][length u32 LE][payload], like the Moonlight
//! stream. Kind 2 is an event as JSON ("ready" with this side's key and
//! candidates, "up" with the local address once a path works, "fail",
//! "down"); kind 4 is a sound frame: [sequence u32 BE] and 5 ms of PCM,
//! 48 kHz stereo 16-bit. Lines on stdin:
//!   peer <session> <host key> <nat> <candidates>   the streamer's answer
//!   stop                                            (or the end of input) end it
//!
//! Moonlight then connects to the loopback address as if Sunshine were here:
//! its TCP connections and UDP packets go through the tunnel.

use std::io::{BufRead, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::Rng;

use super::stream::Streams;
use super::wire::{self, Link, Socks, ACK, BYE, KEEPALIVE, PCM, PROBE, PROBE_ACK, RST, SEG, SELECT, UDP};
use super::{path_of, predictions, stun, tcp_port, udp_port, Prober};

static OUT: Mutex<()> = Mutex::new(());

fn record(kind: u8, payload: &[u8]) {
    let _guard = OUT.lock();
    let mut out = std::io::stdout().lock();
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    // a closed pipe: the app is gone
    if out.write_all(&head).and_then(|_| out.write_all(payload)).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn event(json: String) {
    record(2, json.as_bytes());
}

/// A UDP port of Sunshine, stood in for here: Moonlight's packets go out, the streamer's come back to it.
struct Flow {
    sock: UdpSocket,
    client: Mutex<Option<SocketAddr>>,
}

struct View {
    base: u16,
    link: Arc<Link>,
    socks: Arc<Socks>,
    prober: Mutex<Prober>,
    streams: Arc<Streams>,
    flows: OnceLock<Vec<Arc<Flow>>>,
    selected: AtomicBool,
    started: Instant,
}

fn bye(view: &View) -> ! {
    for _ in 0..3 {
        view.link.send(&view.socks, &[BYE]);
    }
    std::thread::sleep(Duration::from_millis(50));
    std::process::exit(0);
}

impl View {
    fn handle(self: &Arc<Self>, from: SocketAddr, buf: &mut [u8]) {
        if wire::session_of(buf) != Some(self.link.sid) {
            return;
        }
        let Some((ctr, body)) = self.link.open(buf) else { return };
        let Some(&kind) = body.first() else { return };
        // before a path is picked, only probes count
        if self.selected.load(Ordering::Relaxed) || kind == PROBE || kind == PROBE_ACK {
            self.link.received(from, ctr, kind);
        }
        match kind {
            PROBE if body.len() >= 9 => {
                let mut ack = [0u8; 9];
                ack[0] = PROBE_ACK;
                ack[1..9].copy_from_slice(&body[1..9]);
                self.link.send_to(&self.socks, &ack, from);
                if let Ok(mut p) = self.prober.lock() {
                    p.add(from);
                }
            }
            PROBE_ACK if body.len() >= 9 => {
                let sent = u64::from_be_bytes(body[1..9].try_into().unwrap_or_default());
                if let Ok(mut p) = self.prober.lock() {
                    p.answered(from, wire::now_us().saturating_sub(sent));
                }
            }
            UDP if body.len() >= 2 => {
                if let Some(f) = self.flows.get().and_then(|f| f.get(body[1] as usize)) {
                    if let Some(to) = f.client.lock().ok().and_then(|c| *c) {
                        let _ = f.sock.send_to(&body[2..], to);
                    }
                }
            }
            SEG => self.streams.on_seg(&self.link, &self.socks, body, None),
            ACK => self.streams.on_ack(body),
            RST => self.streams.on_rst(body),
            // 5 ms of 48 kHz stereo is 960 bytes: anything far bigger is not a sound frame
            PCM if body.len() > 5 && body.len() <= 4096 => record(4, &body[1..]),
            BYE => {
                event("{\"ev\":\"down\",\"reason\":\"bye\"}".into());
                std::process::exit(0);
            }
            _ => {}
        }
    }

    /// Stand in for Sunshine on a loopback address no other program uses: its ports, on 127.x.y.z.
    fn open_local(self: &Arc<Self>) -> Result<Ipv4Addr, String> {
        for _ in 0..8 {
            let mut r = rand::thread_rng();
            let ip = Ipv4Addr::new(127, r.gen_range(16..250), r.gen(), r.gen_range(2..250));
            let mut listeners = Vec::new();
            let mut flows = Vec::new();
            let mut ok = true;
            for i in 0..3u8 {
                match tcp_port(self.base, i).map(|p| TcpListener::bind((ip, p))) {
                    Some(Ok(l)) => listeners.push((i, l)),
                    _ => ok = false,
                }
                match udp_port(self.base, i).map(|p| UdpSocket::bind((ip, p))) {
                    Some(Ok(s)) => flows.push(s),
                    _ => ok = false,
                }
            }
            if !ok {
                continue;
            }
            let flows: Vec<Arc<Flow>> = flows
                .into_iter()
                .map(|sock| {
                    wire::tune(&sock);
                    Arc::new(Flow { sock, client: Mutex::new(None) })
                })
                .collect();
            for (i, flow) in flows.iter().enumerate() {
                let (flow, view) = (flow.clone(), self.clone());
                std::thread::spawn(move || {
                    let mut buf = vec![0u8; 65536];
                    buf[0] = UDP;
                    buf[1] = i as u8;
                    loop {
                        match flow.sock.recv_from(&mut buf[2..]) {
                            Ok((n, from)) => {
                                if let Ok(mut c) = flow.client.lock() {
                                    *c = Some(from);
                                }
                                view.link.send(&view.socks, &buf[..2 + n]);
                            }
                            Err(_) => std::thread::sleep(Duration::from_millis(5)),
                        }
                    }
                });
            }
            let _ = self.flows.set(flows);
            for (i, listener) in listeners {
                let view = self.clone();
                std::thread::spawn(move || {
                    for conn in listener.incoming() {
                        match conn {
                            Ok(tcp) => view.streams.open_local(view.link.clone(), view.socks.clone(), i, tcp),
                            Err(_) => std::thread::sleep(Duration::from_millis(20)),
                        }
                    }
                });
            }
            return Ok(ip);
        }
        Err("no free loopback address for the stream".into())
    }

    fn tick(self: &Arc<Self>) {
        if !self.selected.load(Ordering::Relaxed) {
            let pick = {
                let Ok(mut p) = self.prober.lock() else { return };
                p.tick(&self.link, &self.socks);
                p.pick()
            };
            if let Some((to, rtt_us)) = pick {
                self.selected.store(true, Ordering::Relaxed);
                self.link.set_peer(to);
                for _ in 0..3 {
                    self.link.send(&self.socks, &[SELECT]);
                }
                match self.open_local() {
                    Ok(ip) => event(format!(
                        "{{\"ev\":\"up\",\"local\":\"{ip}\",\"path\":\"{}\",\"rtt\":{}}}",
                        path_of(&to),
                        rtt_us / 1000
                    )),
                    Err(e) => {
                        event(format!("{{\"ev\":\"fail\",\"reason\":\"local\",\"text\":{}}}", crate::moonlight::json_str(&e)));
                        bye(self);
                    }
                }
            } else if self.started.elapsed() > Duration::from_secs(15) {
                event("{\"ev\":\"fail\",\"reason\":\"punch\"}".into());
                bye(self);
            }
            return;
        }
        if self.link.idle_tx() > Duration::from_secs(2) {
            self.link.send(&self.socks, &[KEEPALIVE]);
        }
        if self.link.idle_rx() > Duration::from_secs(20) {
            event("{\"ev\":\"down\",\"reason\":\"timeout\"}".into());
            bye(self);
        }
        self.streams.tick(&self.link, &self.socks);
    }
}

pub fn run(args: &[String]) -> Result<(), String> {
    let base = args.get(0).and_then(|v| v.parse::<u16>().ok()).filter(|p| (1030..=65000).contains(p)).ok_or("bad base port")?;
    let lan: Vec<Ipv4Addr> = args.get(1).map(|l| l.split(',').filter_map(|p| p.parse().ok()).collect()).unwrap_or_default();
    let v6: Vec<Ipv6Addr> = args.get(2).map(|l| l.split(',').filter_map(|p| p.parse().ok()).collect()).unwrap_or_default();

    let v4 = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    wire::tune(&v4);
    let port = v4.local_addr().map_err(|e| e.to_string())?.port();
    let v6sock = if v6.is_empty() { None } else { UdpSocket::bind((Ipv6Addr::UNSPECIFIED, 0)).ok() };
    if let Some(s) = &v6sock {
        wire::tune(s);
    }
    let seen = stun::look(&v4, &lan);
    let mut cands: Vec<SocketAddr> = lan.iter().map(|ip| SocketAddr::new(IpAddr::V4(*ip), port)).collect();
    if let Some(s) = &v6sock {
        let p6 = s.local_addr().map(|a| a.port()).unwrap_or(0);
        cands.extend(v6.iter().map(|ip| SocketAddr::new(IpAddr::V6(*ip), p6)));
    }
    if let Some(m) = seen.mapped {
        let m = SocketAddr::V4(m);
        if !cands.contains(&m) {
            cands.push(m);
        }
    }
    let own = wire::keypair()?;
    let view_pub = own.public;
    let list: Vec<String> = cands.iter().map(|c| c.to_string()).collect();
    event(format!(
        "{{\"ev\":\"ready\",\"key\":\"{}\",\"nat\":\"{}\",\"cands\":\"{}\"}}",
        hex::encode(view_pub),
        seen.nat,
        list.join(",")
    ));

    // the streamer's answer
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let (sid, host_key, nat, targets) = loop {
        let Some(Ok(line)) = lines.next() else { std::process::exit(0) };
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["peer", sid, key, nat, cands] => {
                let sid: u32 = sid.parse().map_err(|_| "bad session")?;
                let key = wire::parse_key(key).ok_or("bad streamer key")?;
                break (sid, key, nat.to_string(), wire::parse_candidates(cands));
            }
            ["stop"] => std::process::exit(0),
            _ => {}
        }
    };
    if targets.is_empty() || sid == 0 {
        event("{\"ev\":\"fail\",\"reason\":\"punch\"}".into());
        std::process::exit(0);
    }
    let mut targets = targets;
    if nat == "symmetric" {
        targets.extend(predictions(&targets));
    }
    let (h2v, v2h) = wire::derive(own, &host_key, &host_key, &view_pub)?;
    let view = Arc::new(View {
        base,
        link: Arc::new(Link::new(sid, v2h, h2v)),
        socks: Arc::new(Socks { v4, v6: v6sock }),
        prober: Mutex::new(Prober::new(targets)),
        streams: Streams::new(),
        flows: OnceLock::new(),
        selected: AtomicBool::new(false),
        started: Instant::now(),
    });

    for v6 in [false, true] {
        let view = view.clone();
        let sock = if v6 { view.socks.v6.as_ref().and_then(|s| s.try_clone().ok()) } else { view.socks.v4.try_clone().ok() };
        let Some(sock) = sock else { continue };
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 65536];
            loop {
                if let Some((n, from)) = wire::recv(&sock, &mut buf) {
                    view.handle(from, &mut buf[..n]);
                }
            }
        });
    }
    {
        let view = view.clone();
        std::thread::spawn(move || loop {
            view.tick();
            std::thread::sleep(Duration::from_millis(20));
        });
    }

    for line in lines {
        match line.as_deref().map(str::trim) {
            Ok("stop") | Err(_) => break,
            _ => {}
        }
    }
    bye(&view);
}
