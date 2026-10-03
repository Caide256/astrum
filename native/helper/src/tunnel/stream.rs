//! TCP connections through the tunnel: Sunshine's HTTP, HTTPS and RTSP.
//!
//! They carry little (pairing, the app list, the stream setup), so a simple
//! scheme does: numbered segments of up to 1100 bytes, a cumulative
//! acknowledgement for every segment received, resending after a timeout
//! that follows the measured round trip, at most 96 segments in flight.
//! Segment 0 of the viewer's side opens the connection; a segment flagged
//! FIN ends one direction, like TCP's half close. The other side connects
//! only to Sunshine's own ports: a stream names one of three ports by
//! number, never an address or a port of its own choosing.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::wire::{Link, Socks, ACK, RST, SEG};

pub const OPEN: u8 = 1;
pub const FIN: u8 = 2;
const PAYLOAD: usize = 1100;
const WINDOW: usize = 96;
const MAX_STREAMS: usize = 32;
const MAX_AHEAD: u32 = 256;
/// Chunks waiting for the local socket: an honest other side never gets near it.
const BACKLOG: usize = 512;
const GIVE_UP: u32 = 20;

enum Chunk {
    Data(Vec<u8>),
    End,
}

struct Seg {
    packet: Vec<u8>,
    sent: Instant,
    tries: u32,
}

struct Sending {
    next: u32,
    unacked: BTreeMap<u32, Seg>,
    fin: bool,
    srtt: Option<Duration>,
}

struct Receiving {
    next: u32,
    ahead: BTreeMap<u32, (u8, Vec<u8>)>,
    done: bool,
}

pub struct Stream {
    id: u16,
    port: u8,
    send: Mutex<Sending>,
    room: Condvar,
    recv: Mutex<Receiving>,
    out: Mutex<Option<mpsc::SyncSender<Chunk>>>,
    sock: Mutex<Option<TcpStream>>,
    dead: AtomicBool,
    /// Both directions ended: the stream stays a moment to answer resent segments.
    finished_at: Mutex<Option<Instant>>,
}

const LINGER: Duration = Duration::from_secs(3);

impl Stream {
    fn new(id: u16, port: u8, out: mpsc::SyncSender<Chunk>) -> Arc<Self> {
        Arc::new(Stream {
            id,
            port,
            send: Mutex::new(Sending { next: 0, unacked: BTreeMap::new(), fin: false, srtt: None }),
            room: Condvar::new(),
            recv: Mutex::new(Receiving { next: 0, ahead: BTreeMap::new(), done: false }),
            out: Mutex::new(Some(out)),
            sock: Mutex::new(None),
            dead: AtomicBool::new(false),
            finished_at: Mutex::new(None),
        })
    }

    fn segment(&self, seq: u32, flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut p = Vec::with_capacity(9 + payload.len());
        p.push(SEG);
        p.extend_from_slice(&self.id.to_be_bytes());
        p.push(self.port);
        p.extend_from_slice(&seq.to_be_bytes());
        p.push(flags);
        p.extend_from_slice(payload);
        p
    }

    /// Send bytes (or the end) to the other side; waits while the window is full.
    fn push(&self, link: &Link, socks: &Socks, flags: u8, payload: &[u8]) -> bool {
        let Ok(mut s) = self.send.lock() else { return false };
        while s.unacked.len() >= WINDOW && !self.dead.load(Ordering::Relaxed) {
            s = match self.room.wait_timeout(s, Duration::from_millis(200)) {
                Ok((g, _)) => g,
                Err(_) => return false,
            };
        }
        if self.dead.load(Ordering::Relaxed) || s.fin {
            return false;
        }
        let seq = s.next;
        s.next += 1;
        if flags & FIN != 0 {
            s.fin = true;
        }
        let packet = self.segment(seq, flags, payload);
        link.send(socks, &packet);
        s.unacked.insert(seq, Seg { packet, sent: Instant::now(), tries: 0 });
        true
    }

    fn on_ack(&self, next: u32) {
        let Ok(mut s) = self.send.lock() else { return };
        let done: Vec<u32> = s.unacked.range(..next).map(|(k, _)| *k).collect();
        for k in done {
            if let Some(seg) = s.unacked.remove(&k) {
                // only first sends measure the round trip: a resent one is ambiguous
                if seg.tries == 0 {
                    let sample = seg.sent.elapsed();
                    s.srtt = Some(match s.srtt {
                        Some(r) => (r * 7 + sample) / 8,
                        None => sample,
                    });
                }
            }
        }
        self.room.notify_all();
    }

    fn on_seg(&self, link: &Link, socks: &Socks, seq: u32, flags: u8, payload: &[u8]) {
        let next = {
            let Ok(mut r) = self.recv.lock() else { return };
            if !r.done && seq >= r.next && seq - r.next < MAX_AHEAD {
                r.ahead.entry(seq).or_insert_with(|| (flags, payload.to_vec()));
            }
            loop {
                let at = r.next;
                let Some((f, data)) = r.ahead.remove(&at) else { break };
                r.next += 1;
                if !data.is_empty() {
                    self.deliver(Chunk::Data(data));
                }
                if f & FIN != 0 {
                    r.done = true;
                    r.ahead.clear();
                    self.deliver(Chunk::End);
                    break;
                }
            }
            r.next
        };
        let mut ack = [0u8; 7];
        ack[0] = ACK;
        ack[1..3].copy_from_slice(&self.id.to_be_bytes());
        ack[3..7].copy_from_slice(&next.to_be_bytes());
        link.send(socks, &ack);
    }

    /// To the local socket's writer. A writer that cannot keep up means the other side ignores the window: the stream ends.
    fn deliver(&self, c: Chunk) {
        let full = match self.out.lock() {
            Ok(out) => matches!(out.as_ref().map(|tx| tx.try_send(c)), Some(Err(mpsc::TrySendError::Full(_)))),
            Err(_) => false,
        };
        if full {
            self.dead.store(true, Ordering::Relaxed);
        }
    }

    /// Resend what was not acknowledged in time. False: the other side stopped answering.
    fn tick(&self, link: &Link, socks: &Socks) -> bool {
        let Ok(mut s) = self.send.lock() else { return false };
        let rto = s.srtt.map(|r| (r * 2).clamp(Duration::from_millis(80), Duration::from_millis(1500))).unwrap_or(Duration::from_millis(300));
        for seg in s.unacked.values_mut() {
            if seg.sent.elapsed() >= rto * (1 << seg.tries.min(4)) {
                if seg.tries >= GIVE_UP {
                    return false;
                }
                seg.tries += 1;
                seg.sent = Instant::now();
                link.send(socks, &seg.packet);
            }
        }
        true
    }

    fn finished(&self) -> bool {
        let sent = self.send.lock().map(|s| s.fin && s.unacked.is_empty()).unwrap_or(true);
        let got = self.recv.lock().map(|r| r.done).unwrap_or(true);
        sent && got
    }

    fn kill(&self) {
        self.dead.store(true, Ordering::Relaxed);
        self.room.notify_all();
        if let Ok(mut out) = self.out.lock() {
            *out = None;
        }
        if let Ok(sock) = self.sock.lock() {
            if let Some(s) = sock.as_ref() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
    }
}

/// Connect a stream with its local socket: one thread writes what arrives, one reads what goes out.
fn pump(stream: Arc<Stream>, tcp: TcpStream, rx: mpsc::Receiver<Chunk>, link: Arc<Link>, socks: Arc<Socks>) {
    let _ = tcp.set_nodelay(true);
    let Ok(reader) = tcp.try_clone() else {
        stream.kill();
        return;
    };
    if let Ok(mut s) = stream.sock.lock() {
        *s = tcp.try_clone().ok();
    }
    {
        let stream = stream.clone();
        let mut tcp = tcp;
        std::thread::spawn(move || {
            for chunk in rx {
                match chunk {
                    Chunk::Data(d) => {
                        if tcp.write_all(&d).is_err() {
                            stream.kill();
                            break;
                        }
                    }
                    Chunk::End => {
                        let _ = tcp.shutdown(Shutdown::Write);
                    }
                }
            }
        });
    }
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; PAYLOAD];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    stream.push(&link, &socks, FIN, &[]);
                    break;
                }
                Ok(n) => {
                    if !stream.push(&link, &socks, 0, &buf[..n]) {
                        break;
                    }
                }
                Err(_) => {
                    stream.kill();
                    break;
                }
            }
        }
    });
}

/// The TCP connections of one session.
pub struct Streams {
    map: Mutex<HashMap<u16, Arc<Stream>>>,
    next: Mutex<u16>,
}

fn rst(link: &Link, socks: &Socks, id: u16) {
    let mut p = [0u8; 3];
    p[0] = RST;
    p[1..3].copy_from_slice(&id.to_be_bytes());
    link.send(socks, &p);
}

impl Streams {
    pub fn new() -> Arc<Self> {
        Arc::new(Streams { map: Mutex::new(HashMap::new()), next: Mutex::new(1) })
    }

    /// A connection accepted on the viewer's side: the other end connects to Sunshine's port `port`.
    pub fn open_local(&self, link: Arc<Link>, socks: Arc<Socks>, port: u8, tcp: TcpStream) {
        let (tx, rx) = mpsc::sync_channel(BACKLOG);
        let stream = {
            let Ok(mut map) = self.map.lock() else { return };
            if map.len() >= MAX_STREAMS {
                return;
            }
            let Ok(mut next) = self.next.lock() else { return };
            while map.contains_key(&*next) || *next == 0 {
                *next = next.wrapping_add(1);
            }
            let id = *next;
            *next = next.wrapping_add(1);
            let stream = Stream::new(id, port, tx);
            map.insert(id, stream.clone());
            stream
        };
        stream.push(&link, &socks, OPEN, &[]);
        pump(stream, tcp, rx, link, socks);
    }

    /// A segment from the other side. `connect` (the host's side) turns a port
    /// number into an address and lets new streams open; the viewer's side opens none.
    pub fn on_seg(&self, link: &Arc<Link>, socks: &Arc<Socks>, body: &[u8], connect: Option<&dyn Fn(u8) -> Option<SocketAddr>>) {
        if body.len() < 9 {
            return;
        }
        let id = u16::from_be_bytes([body[1], body[2]]);
        let port = body[3];
        let seq = u32::from_be_bytes([body[4], body[5], body[6], body[7]]);
        let flags = body[8];
        let payload = &body[9..];
        // segments are at most PAYLOAD bytes: anything bigger is not from our other end
        if payload.len() > PAYLOAD {
            return;
        }
        let found = self.map.lock().ok().and_then(|m| m.get(&id).cloned());
        let stream = match found {
            Some(s) => s,
            None => {
                let target = connect.and_then(|c| c(port));
                let opening = seq == 0 && flags & OPEN != 0;
                let Some(addr) = target.filter(|_| opening) else {
                    // a late segment of a closed stream, or one that may not open: answer with a reset
                    if !opening || connect.is_some() {
                        rst(link, socks, id);
                    }
                    return;
                };
                let (tx, rx) = mpsc::sync_channel(BACKLOG);
                let stream = Stream::new(id, port, tx);
                {
                    let Ok(mut map) = self.map.lock() else { return };
                    if map.len() >= MAX_STREAMS {
                        drop(map);
                        rst(link, socks, id);
                        return;
                    }
                    map.insert(id, stream.clone());
                }
                let (s2, l2, k2) = (stream.clone(), link.clone(), socks.clone());
                std::thread::spawn(move || match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
                    Ok(tcp) => pump(s2, tcp, rx, l2, k2),
                    Err(_) => s2.kill(),
                });
                stream
            }
        };
        stream.on_seg(link, socks, seq, flags, payload);
    }

    pub fn on_ack(&self, body: &[u8]) {
        if body.len() < 7 {
            return;
        }
        let id = u16::from_be_bytes([body[1], body[2]]);
        let next = u32::from_be_bytes([body[3], body[4], body[5], body[6]]);
        if let Some(s) = self.map.lock().ok().and_then(|m| m.get(&id).cloned()) {
            s.on_ack(next);
        }
    }

    pub fn on_rst(&self, body: &[u8]) {
        if body.len() < 3 {
            return;
        }
        let id = u16::from_be_bytes([body[1], body[2]]);
        if let Some(s) = self.map.lock().ok().and_then(|mut m| m.remove(&id)) {
            s.kill();
        }
    }

    /// Resends, and the end of finished or broken streams.
    pub fn tick(&self, link: &Link, socks: &Socks) {
        let list: Vec<Arc<Stream>> = self.map.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
        for s in list {
            let broken = s.dead.load(Ordering::Relaxed) || !s.tick(link, socks);
            let gone = broken
                || (s.finished() && s.finished_at.lock().map(|mut f| f.get_or_insert_with(Instant::now).elapsed() >= LINGER).unwrap_or(true));
            if gone {
                if broken {
                    rst(link, socks, s.id);
                }
                s.kill();
                if let Ok(mut m) = self.map.lock() {
                    m.remove(&s.id);
                }
            }
        }
    }

    pub fn close_all(&self) {
        let list: Vec<Arc<Stream>> = self.map.lock().map(|mut m| m.drain().map(|(_, s)| s).collect()).unwrap_or_default();
        for s in list {
            s.kill();
        }
    }
}
