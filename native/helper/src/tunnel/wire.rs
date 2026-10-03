//! The tunnel's packets: keys, sealing, the replay window and the sockets.
//!
//! Every packet is [0xC1][session u32][counter u64] followed by the sealed
//! body (AES-256-GCM, the 13-byte header as associated data). Each direction
//! has its own key, derived from an X25519 exchange made for this session
//! only, so the counter alone is a unique nonce. A packet that does not
//! open with the session's key is dropped without an answer: to anyone
//! without the key the socket stays silent.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf::{Salt, HKDF_SHA256};
use ring::rand::SystemRandom;

pub const MAGIC: u8 = 0xC1;
pub const HEADER: usize = 13;
pub const TAG: usize = 16;

/* inner packet kinds, the first byte of a sealed body */
pub const PROBE: u8 = 1;
pub const PROBE_ACK: u8 = 2;
pub const KEEPALIVE: u8 = 3;
pub const UDP: u8 = 4;
pub const SEG: u8 = 6;
pub const ACK: u8 = 7;
pub const RST: u8 = 9;
pub const PCM: u8 = 10;
pub const BYE: u8 = 11;
pub const SELECT: u8 = 12;

/// Microseconds since the helper started: probe timestamps, echoed back for the round trip.
pub fn now_us() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/* -------------------------------------------------------------------- keys */

pub struct Keypair {
    private: EphemeralPrivateKey,
    pub public: [u8; 32],
}

pub fn keypair() -> Result<Keypair, String> {
    let rng = SystemRandom::new();
    let private = EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| "no key")?;
    let pub_key = private.compute_public_key().map_err(|_| "no public key")?;
    let mut public = [0u8; 32];
    public.copy_from_slice(pub_key.as_ref());
    Ok(Keypair { private, public })
}

pub fn parse_key(hex_text: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(hex_text).ok()?;
    bytes.try_into().ok()
}

/// The keys of both directions: (host to viewer, viewer to host). Both public
/// keys go into the derivation, so the keys belong to this one exchange.
pub fn derive(own: Keypair, peer: &[u8; 32], host_pub: &[u8; 32], view_pub: &[u8; 32]) -> Result<(LessSafeKey, LessSafeKey), String> {
    let peer_key = UnparsedPublicKey::new(&X25519, peer);
    let mut transcript = [0u8; 64];
    transcript[..32].copy_from_slice(host_pub);
    transcript[32..].copy_from_slice(view_pub);
    agree_ephemeral(own.private, &peer_key, |shared| {
        let prk = Salt::new(HKDF_SHA256, b"astrum stream tunnel v1").extract(shared);
        let key = |label: &[u8]| -> Result<LessSafeKey, String> {
            let info = [label, &transcript[..]];
            let okm = prk.expand(&info, &AES_256_GCM).map_err(|_| "key derivation failed")?;
            Ok(LessSafeKey::new(UnboundKey::from(okm)))
        };
        Ok::<_, String>((key(b"host to viewer")?, key(b"viewer to host")?))
    })
    .map_err(|_| "key exchange failed".to_string())?
}

fn nonce(counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(n)
}

/* ----------------------------------------------------------------- sockets */

/// The tunnel's UDP sockets: IPv4 always, IPv6 when the computer has it.
pub struct Socks {
    pub v4: UdpSocket,
    pub v6: Option<UdpSocket>,
}

impl Socks {
    pub fn send_to(&self, buf: &[u8], to: SocketAddr) {
        let sock = match to {
            SocketAddr::V4(_) => Some(&self.v4),
            SocketAddr::V6(_) => self.v6.as_ref(),
        };
        if let Some(s) = sock {
            // a full buffer or an unreachable address: the packet is lost like any UDP packet
            let _ = s.send_to(buf, to);
        }
    }
}

/// Bigger socket buffers: a keyframe arrives as a burst of a few hundred
/// packets, more than the 64 KB Windows gives a socket by default.
pub fn tune(sock: &UdpSocket) {
    use std::os::windows::io::AsRawSocket;
    use windows::Win32::Networking::WinSock::{setsockopt, SOCKET, SOL_SOCKET, SO_RCVBUF, SO_SNDBUF};
    let size = (4i32 << 20).to_ne_bytes();
    let s = SOCKET(sock.as_raw_socket() as usize);
    unsafe {
        let _ = setsockopt(s, SOL_SOCKET, SO_RCVBUF, Some(&size));
        let _ = setsockopt(s, SOL_SOCKET, SO_SNDBUF, Some(&size));
    }
}

/// A packet on a socket may be an error report of an earlier send (Windows
/// reports an unreachable port on the next receive): those are skipped.
pub fn recv(sock: &UdpSocket, buf: &mut [u8]) -> Option<(usize, SocketAddr)> {
    loop {
        match sock.recv_from(buf) {
            Ok(r) => return Some(r),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return None,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(20));
                return None;
            }
        }
    }
}

/// Private addresses: the same home network, the best path there is.
pub fn is_lan(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// Where a candidate may point: never this computer's loopback, a multicast
/// group or an unspecified address. Ports below 1024 are not ours either.
pub fn candidate_ok(addr: &SocketAddr) -> bool {
    let ip = addr.ip();
    addr.port() >= 1024 && !ip.is_loopback() && !ip.is_multicast() && !ip.is_unspecified()
        && !matches!(ip, IpAddr::V4(v4) if v4.is_broadcast() || v4.octets()[0] == 0)
}

/// "a.b.c.d:port,[v6]:port": the candidates of the other side, at most 16.
pub fn parse_candidates(list: &str) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for part in list.split(',').filter(|p| !p.is_empty()).take(16) {
        if let Ok(a) = part.parse::<SocketAddr>() {
            if candidate_ok(&a) && !out.contains(&a) {
                out.push(a);
            }
        }
    }
    out
}

/* ------------------------------------------------------------------ replay */

/// Counters already seen: the last 1024 below the highest one.
struct Replay {
    top: u64,
    bits: [u64; 16],
}

impl Replay {
    fn fresh(&self, ctr: u64) -> bool {
        if ctr > self.top {
            return true;
        }
        let back = self.top - ctr;
        back < 1024 && self.bits[(ctr % 1024 / 64) as usize] & (1 << (ctr % 64)) == 0
    }

    fn mark(&mut self, ctr: u64) {
        if ctr > self.top {
            let jump = ctr - self.top;
            if jump >= 1024 {
                self.bits = [0; 16];
            } else {
                for c in self.top + 1..=ctr {
                    self.bits[(c % 1024 / 64) as usize] &= !(1 << (c % 64));
                }
            }
            self.top = ctr;
        }
        self.bits[(ctr % 1024 / 64) as usize] |= 1 << (ctr % 64);
    }
}

/* -------------------------------------------------------------------- link */

/// One end of a session: its keys, counters and the address of the other end.
pub struct Link {
    pub sid: u32,
    tx: LessSafeKey,
    rx: LessSafeKey,
    counter: AtomicU64,
    replay: Mutex<Replay>,
    /// Where data goes: the path chosen by the viewer, then wherever the other end's newest packet came from.
    peer: Mutex<Option<SocketAddr>>,
    roam_top: AtomicU64,
    pub last_rx: Mutex<Instant>,
    pub last_tx: Mutex<Instant>,
    pub closed: AtomicBool,
}

impl Link {
    pub fn new(sid: u32, tx: LessSafeKey, rx: LessSafeKey) -> Self {
        Link {
            sid,
            tx,
            rx,
            counter: AtomicU64::new(1),
            replay: Mutex::new(Replay { top: 0, bits: [0; 16] }),
            peer: Mutex::new(None),
            roam_top: AtomicU64::new(0),
            last_rx: Mutex::new(Instant::now()),
            last_tx: Mutex::new(Instant::now()),
            closed: AtomicBool::new(false),
        }
    }

    pub fn seal(&self, inner: &[u8]) -> Vec<u8> {
        let ctr = self.counter.fetch_add(1, Ordering::Relaxed);
        let mut header = [0u8; HEADER];
        header[0] = MAGIC;
        header[1..5].copy_from_slice(&self.sid.to_be_bytes());
        header[5..13].copy_from_slice(&ctr.to_be_bytes());
        let mut out = Vec::with_capacity(HEADER + inner.len() + TAG);
        out.extend_from_slice(&header);
        out.extend_from_slice(inner);
        match self.tx.seal_in_place_separate_tag(nonce(ctr), Aad::from(header), &mut out[HEADER..]) {
            Ok(tag) => out.extend_from_slice(tag.as_ref()),
            Err(_) => out.clear(),
        }
        out
    }

    /// The body of a packet of this session, or None: not ours, broken, or seen before.
    pub fn open<'a>(&self, packet: &'a mut [u8]) -> Option<(u64, &'a [u8])> {
        if packet.len() < HEADER + TAG || packet[0] != MAGIC {
            return None;
        }
        let mut header = [0u8; HEADER];
        header.copy_from_slice(&packet[..HEADER]);
        let ctr = u64::from_be_bytes(header[5..13].try_into().ok()?);
        // the window is checked before and marked after opening: garbage cannot burn counters
        if !self.replay.lock().ok()?.fresh(ctr) {
            return None;
        }
        let plain = self.rx.open_in_place(nonce(ctr), Aad::from(header), &mut packet[HEADER..]).ok()?;
        let mut replay = self.replay.lock().ok()?;
        if !replay.fresh(ctr) {
            return None;
        }
        replay.mark(ctr);
        Some((ctr, &*plain))
    }

    /// A packet came from `from`: the link is alive; anything but probes moves the path there.
    pub fn received(&self, from: SocketAddr, ctr: u64, kind: u8) {
        if let Ok(mut t) = self.last_rx.lock() {
            *t = Instant::now();
        }
        if kind != PROBE && kind != PROBE_ACK && ctr > self.roam_top.load(Ordering::Relaxed) {
            self.roam_top.store(ctr, Ordering::Relaxed);
            if let Ok(mut p) = self.peer.lock() {
                *p = Some(from);
            }
        }
    }

    pub fn peer(&self) -> Option<SocketAddr> {
        self.peer.lock().ok().and_then(|p| *p)
    }

    pub fn set_peer(&self, to: SocketAddr) {
        if let Ok(mut p) = self.peer.lock() {
            *p = Some(to);
        }
    }

    pub fn send_to(&self, socks: &Socks, inner: &[u8], to: SocketAddr) {
        let packet = self.seal(inner);
        if packet.is_empty() {
            return;
        }
        socks.send_to(&packet, to);
        if let Ok(mut t) = self.last_tx.lock() {
            *t = Instant::now();
        }
    }

    /// To the other end over the current path; nothing while there is none yet.
    pub fn send(&self, socks: &Socks, inner: &[u8]) -> bool {
        match self.peer() {
            Some(to) if !self.closed.load(Ordering::Relaxed) => {
                self.send_to(socks, inner, to);
                true
            }
            _ => false,
        }
    }

    pub fn idle_rx(&self) -> Duration {
        self.last_rx.lock().map(|t| t.elapsed()).unwrap_or_default()
    }

    pub fn idle_tx(&self) -> Duration {
        self.last_tx.lock().map(|t| t.elapsed()).unwrap_or_default()
    }
}

/// The session id of a packet, before it is opened.
pub fn session_of(packet: &[u8]) -> Option<u32> {
    if packet.len() < HEADER + TAG || packet[0] != MAGIC {
        return None;
    }
    Some(u32::from_be_bytes(packet[1..5].try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Link, Link) {
        let host = keypair().unwrap();
        let view = keypair().unwrap();
        let (hp, vp) = (host.public, view.public);
        let (h2v, v2h) = derive(host, &vp, &hp, &vp).unwrap();
        let (h2v_b, v2h_b) = derive(view, &hp, &hp, &vp).unwrap();
        (Link::new(7, h2v, v2h), Link::new(7, v2h_b, h2v_b))
    }

    #[test]
    fn sealed_packets_open_once_on_the_other_side() {
        let (host, view) = pair();
        let mut p = host.seal(b"\x04\x00hello");
        assert_eq!(session_of(&p), Some(7));
        let mut copy = p.clone();
        let (_, body) = view.open(&mut p).expect("opens");
        assert_eq!(body, b"\x04\x00hello");
        // the same packet again is a replay
        assert!(view.open(&mut copy).is_none());
        // the sender cannot open its own packets: each direction has its own key
        let mut own = host.seal(b"x");
        assert!(host.open(&mut own).is_none());
    }

    #[test]
    fn tampered_packets_are_dropped() {
        let (host, view) = pair();
        let mut p = host.seal(b"secret");
        let n = p.len();
        p[n - 1] ^= 1;
        assert!(view.open(&mut p).is_none());
        let mut q = host.seal(b"secret");
        q[3] ^= 1; // the session id is covered too
        assert!(view.open(&mut q).is_none());
    }

    #[test]
    fn replay_window() {
        let mut r = Replay { top: 0, bits: [0; 16] };
        for c in [5u64, 3, 9, 1500, 1200] {
            assert!(r.fresh(c));
            r.mark(c);
            assert!(!r.fresh(c));
        }
        // far behind the newest: too old to tell, dropped
        assert!(!r.fresh(9));
        assert!(r.fresh(1499));
    }

    #[test]
    fn candidates_are_checked() {
        let list = parse_candidates("203.0.113.5:50000,127.0.0.1:5000,0.0.0.0:7,[2001:db8::1]:40000,224.0.0.1:5000,10.0.0.2:80,bad");
        assert_eq!(list.len(), 2);
    }
}
