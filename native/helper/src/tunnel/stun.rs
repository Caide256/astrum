//! Where this computer is seen from the internet, and what kind of NAT is in between.
//!
//! STUN binding requests (RFC 5389) go out from the tunnel's own socket to
//! public STUN servers, as every WebRTC call does: the answer is the outside
//! address and port of that socket, a candidate the other side can aim at.
//! Two servers at different addresses tell the NAT apart: the same outside
//! port for both means a "cone" NAT, which keeps one mapping per socket and
//! lets hole punching work; a new port per destination is a "symmetric" NAT,
//! the hard case. An outside address that is the computer's own means no NAT.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use rand::RngCore;

const SERVERS: [(&str, u16); 3] = [("stun.l.google.com", 19302), ("stun1.l.google.com", 19302), ("stun.cloudflare.com", 3478)];
const COOKIE: u32 = 0x2112_A442;

pub struct Seen {
    /// "open", "cone", "symmetric" or "blocked" (no answer: UDP does not get out).
    pub nat: &'static str,
    /// The outside address of the socket, as the first server saw it.
    pub mapped: Option<SocketAddrV4>,
}

fn request(id: &[u8; 12]) -> [u8; 20] {
    let mut r = [0u8; 20];
    r[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    r[4..8].copy_from_slice(&COOKIE.to_be_bytes());
    r[8..20].copy_from_slice(id);
    r
}

/// The mapped address in a binding response, if `msg` is the answer to `id`.
pub fn parse_response(msg: &[u8], id: &[u8; 12]) -> Option<SocketAddrV4> {
    if msg.len() < 20 || msg[0..2] != [0x01, 0x01] || msg[4..8] != COOKIE.to_be_bytes() || &msg[8..20] != id {
        return None;
    }
    let mut at = 20;
    let mut plain = None;
    while at + 4 <= msg.len() {
        let kind = u16::from_be_bytes([msg[at], msg[at + 1]]);
        let len = u16::from_be_bytes([msg[at + 2], msg[at + 3]]) as usize;
        let body = msg.get(at + 4..at + 4 + len)?;
        if body.len() >= 8 && body[1] == 0x01 {
            let port = u16::from_be_bytes([body[2], body[3]]);
            let ip = [body[4], body[5], body[6], body[7]];
            if kind == 0x0020 {
                let c = COOKIE.to_be_bytes();
                let x = Ipv4Addr::new(ip[0] ^ c[0], ip[1] ^ c[1], ip[2] ^ c[2], ip[3] ^ c[3]);
                return Some(SocketAddrV4::new(x, port ^ 0x2112));
            }
            if kind == 0x0001 {
                plain = Some(SocketAddrV4::new(Ipv4Addr::from(ip), port));
            }
        }
        at += 4 + len + (4 - len % 4) % 4;
    }
    plain
}

/// Ask the STUN servers from `sock`. Takes up to two seconds; the socket's read timeout is changed.
pub fn look(sock: &UdpSocket, own: &[Ipv4Addr]) -> Seen {
    let mut servers: Vec<SocketAddr> = Vec::new();
    for (host, port) in SERVERS {
        if let Ok(list) = (host, port).to_socket_addrs() {
            if let Some(a) = list.into_iter().find(|a| a.is_ipv4()) {
                if !servers.iter().any(|s| s.ip() == a.ip()) {
                    servers.push(a);
                }
            }
        }
    }
    let mut ids: Vec<[u8; 12]> = Vec::new();
    for _ in &servers {
        let mut id = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut id);
        ids.push(id);
    }
    let mut answers: Vec<Option<SocketAddrV4>> = vec![None; servers.len()];
    let _ = sock.set_read_timeout(Some(Duration::from_millis(100)));
    let start = Instant::now();
    let mut sent_at: Option<Instant> = None;
    let mut buf = [0u8; 1500];
    while start.elapsed() < Duration::from_millis(2000) && answers.iter().any(Option::is_none) && !servers.is_empty() {
        // first send, then again every 500 ms to the servers that did not answer
        if sent_at.map(|t| t.elapsed() >= Duration::from_millis(500)).unwrap_or(true) {
            for (i, s) in servers.iter().enumerate() {
                if answers[i].is_none() {
                    let _ = sock.send_to(&request(&ids[i]), s);
                }
            }
            sent_at = Some(Instant::now());
        }
        if let Some((n, from)) = super::wire::recv(sock, &mut buf) {
            if let Some(i) = servers.iter().position(|s| *s == from) {
                if let Some(m) = parse_response(&buf[..n], &ids[i]) {
                    answers[i] = Some(m);
                }
            }
        }
    }
    let _ = sock.set_read_timeout(None);

    let got: Vec<SocketAddrV4> = answers.into_iter().flatten().collect();
    let mapped = got.first().copied();
    let nat = match mapped {
        None => "blocked",
        Some(m) if own.contains(m.ip()) => "open",
        Some(_) if got.iter().any(|a| a.port() != got[0].port()) => "symmetric",
        Some(_) => "cone",
    };
    Seen { nat, mapped }
}

/// `native-helper tunnel probe <lan ips>`: what a stream tunnel of this computer would see.
pub fn probe(args: &[String]) -> Result<(), String> {
    let own: Vec<Ipv4Addr> = args.first().map(|l| l.split(',').filter_map(|p| p.parse().ok()).collect()).unwrap_or_default();
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    let seen = look(&sock, &own);
    let ip = seen.mapped.map(|m| IpAddr::V4(*m.ip()).to_string()).unwrap_or_default();
    println!("{{\"nat\":\"{}\",\"ip\":\"{ip}\"}}", seen.nat);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_mapped_address() {
        let id = [7u8; 12];
        let mut msg = vec![0x01, 0x01, 0x00, 0x0c];
        msg.extend_from_slice(&COOKIE.to_be_bytes());
        msg.extend_from_slice(&id);
        // XOR-MAPPED-ADDRESS 203.0.113.9:50000
        let c = COOKIE.to_be_bytes();
        let ip = [203u8, 0, 113, 9];
        msg.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        msg.extend_from_slice(&(50000u16 ^ 0x2112).to_be_bytes());
        msg.extend_from_slice(&[ip[0] ^ c[0], ip[1] ^ c[1], ip[2] ^ c[2], ip[3] ^ c[3]]);
        assert_eq!(parse_response(&msg, &id), Some("203.0.113.9:50000".parse().unwrap()));
        assert_eq!(parse_response(&msg, &[8u8; 12]), None);
    }
}
