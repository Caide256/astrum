//! Requests to a GameStream host (Sunshine): plain HTTP for pairing, HTTPS
//! with the client certificate for everything else. The host's certificate
//! is self-signed; it is pinned at pairing and only that exact certificate
//! is accepted afterwards (its handshake signature is still verified).

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};

pub struct Response {
    pub body: String,
}

fn split_response(raw: &[u8]) -> Result<Response, String> {
    let text = String::from_utf8_lossy(raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").ok_or("malformed HTTP response")?;
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or("no HTTP status")?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = if chunked { dechunk(body) } else { body.to_string() };
    // an error page without the usual XML: nothing to parse
    if status >= 400 && !body.contains("<root") {
        return Err(format!("HTTP {status}"));
    }
    Ok(Response { body })
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    loop {
        let Some((size, rest)) = s.split_once("\r\n") else { break };
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest[n..].trim_start_matches("\r\n");
    }
    out
}

fn connect(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host}: no address"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("{host}:{port}: {e}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    Ok(stream)
}

/// Host answers are a few kilobytes of XML (the app list with its pictures a bit
/// more): anything past this is not an answer, and must not fill the memory.
const MAX_ANSWER: u64 = 8 * 1024 * 1024;

fn request_text(host: &str, port: u16, path: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: Moonlight\r\nConnection: close\r\n\r\n")
}

/// Plain HTTP GET. `timeout` covers the wait for the answer: the first pairing
/// request only returns once the PIN is entered on the host.
pub fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> Result<Response, String> {
    let mut stream = connect(host, port, timeout)?;
    stream.write_all(request_text(host, port, path).as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    (&mut stream).take(MAX_ANSWER).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    split_response(&raw)
}

/// The host's certificate must be exactly the one pinned at pairing.
#[derive(Debug)]
struct Pinned {
    cert: Vec<u8>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.cert.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("the host's certificate changed since pairing".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// HTTPS GET with the client certificate, to a host whose certificate is pinned.
pub fn https_get(
    host: &str,
    port: u16,
    path: &str,
    client_cert_der: &[u8],
    client_key_pkcs8: &[u8],
    server_cert_der: &[u8],
    timeout: Duration,
) -> Result<Response, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { cert: server_cert_der.to_vec(), provider }))
        .with_client_auth_cert(
            vec![CertificateDer::from(client_cert_der.to_vec())],
            PrivateKeyDer::Pkcs8(client_key_pkcs8.to_vec().into()),
        )
        .map_err(|e| e.to_string())?;
    // hosts are reached by address; the name only has to be valid, the certificate is pinned
    let name = ServerName::try_from(host.to_string()).unwrap_or_else(|_| ServerName::try_from("gamestream".to_string()).expect("static name"));
    let conn = ClientConnection::new(Arc::new(config), name).map_err(|e| e.to_string())?;
    let sock = connect(host, port, timeout)?;
    let mut tls = StreamOwned::new(conn, sock);
    tls.write_all(request_text(host, port, path).as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    match (&mut tls).take(MAX_ANSWER).read_to_end(&mut raw) {
        Ok(_) => {}
        // some hosts close without a TLS close_notify; what arrived is the answer
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && !raw.is_empty() => {}
        Err(e) => return Err(e.to_string()),
    }
    split_response(&raw)
}

/// The value of `<tag>value</tag>` in a host answer.
pub fn xml_value(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open)? + open.len();
    let end = body[start..].find(&close)? + start;
    Some(body[start..end].trim().to_string())
}

/// Every `<tag>...</tag>` block of an answer, in order.
pub fn xml_blocks<'a>(body: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(s) = rest.find(&open) {
        let after = &rest[s + open.len()..];
        let Some(e) = after.find(&close) else { break };
        out.push(&after[..e]);
        rest = &after[e + close.len()..];
    }
    out
}

/// Status of an answer: the root carries status_code and status_message.
pub fn xml_status(body: &str) -> Result<(), String> {
    let root = body.find("<root").map(|i| &body[i..]).unwrap_or("");
    let attr = |name: &str| -> Option<String> {
        let key = format!("{name}=\"");
        let s = root.find(&key)? + key.len();
        let e = root[s..].find('"')? + s;
        Some(root[s..e].to_string())
    };
    match attr("status_code").as_deref() {
        Some("200") | None => Ok(()),
        Some(code) => Err(format!("{code} {}", attr("status_message").unwrap_or_default())),
    }
}
