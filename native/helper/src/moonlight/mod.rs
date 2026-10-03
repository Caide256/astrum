//! Moonlight client: watch a stream from a GameStream host (Sunshine).
//!
//! Commands (all answers are one JSON line on stdout unless noted):
//!   moonlight info <dir> <host>                what the host is, whether we are paired
//!   moonlight pair <dir> <host> <pin> [name]   pair; blocks until the PIN is entered on the host.
//!                                              `name` is the device name the host shows for the
//!                                              request, so the host's owner can tell requests apart
//!   moonlight apps <dir> <host>                the host's apps
//!   moonlight stream <dir> <host> <app> <w> <h> <fps> <kbps> <formats> [host audio 0/1] [packet size]
//!                                              stream to stdout in records (see below)
//!   moonlight quit <dir> <host>                end the running session on the host
//!   moonlight forget <dir> <host>              drop the pinned certificate of a host
//!
//! `dir` keeps this client's identity: key, certificate, unique id, and the
//! certificates of paired hosts. `host` is an address, optionally with the
//! HTTP port (address:47989), optionally prefixed with a key ("key@address"):
//! the host's certificate is then kept under the key, so a host that changes
//! its address (a new public IP) stays paired.
//!
//! Stream output: records of [kind u8][length u32 LE][payload]. Kind 1 is a
//! video frame: [format u16 LE][flags u8, 1 = keyframe][width u16][height u16]
//! [frame number u32][pts microseconds u64] and the Annex B bitstream. Kind 2
//! is an event as JSON. Kind 3 is one Opus audio packet. Lines on stdin:
//! "idr" asks for a keyframe, "stop" or the end of input ends the stream.

pub mod crypto;
mod net;

use std::fs;
use std::io::{BufRead, Write};
use std::os::raw::{c_char, c_int, c_uchar, c_ulonglong};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use rand::RngCore;
use rsa::pkcs1v15::{Signature, SigningKey, VerifyingKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, LineEnding};
use rsa::signature::{SignatureEncoding, Signer, Verifier};
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::der::{DecodePem, Encode, EncodePem};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::spki::SubjectPublicKeyInfoOwned;
use x509_cert::time::Validity;
use x509_cert::Certificate;

use net::{http_get, https_get, xml_blocks, xml_status, xml_value};

const DEFAULT_HTTP_PORT: u16 = 47989;
const DEFAULT_HTTPS_PORT: u16 = 47984;
const QUICK: Duration = Duration::from_secs(10);

/* ---------------------------------------------------------------- identity */

struct Identity {
    unique_id: String,
    cert_pem: String,
    cert_der: Vec<u8>,
    cert_signature: Vec<u8>,
    key: RsaPrivateKey,
    key_pkcs8: Vec<u8>,
}

pub(crate) fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn uuid() -> String {
    let h = random_hex(16);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// This client's key and certificate, made once and kept in `dir`.
fn identity(dir: &Path) -> Result<Identity, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let id_path = dir.join("uniqueid");
    let key_path = dir.join("client.key");
    let cert_path = dir.join("client.pem");

    let unique_id = match fs::read_to_string(&id_path) {
        Ok(s) if s.trim().len() == 16 => s.trim().to_string(),
        _ => {
            let id = random_hex(8).to_uppercase();
            fs::write(&id_path, &id).map_err(|e| e.to_string())?;
            id
        }
    };

    let (key, cert_pem) = match (fs::read_to_string(&key_path), fs::read_to_string(&cert_path)) {
        (Ok(k), Ok(c)) => (RsaPrivateKey::from_pkcs8_pem(&k).map_err(|e| e.to_string())?, c),
        _ => {
            let key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).map_err(|e| e.to_string())?;
            let pem = make_cert(&key)?;
            fs::write(&key_path, key.to_pkcs8_pem(LineEnding::LF).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
            fs::write(&cert_path, &pem).map_err(|e| e.to_string())?;
            (key, pem)
        }
    };

    let cert = Certificate::from_pem(cert_pem.as_bytes()).map_err(|e| e.to_string())?;
    let cert_der = cert.to_der().map_err(|e| e.to_string())?;
    let cert_signature = cert.signature.raw_bytes().to_vec();
    let key_pkcs8 = key.to_pkcs8_der().map_err(|e| e.to_string())?.as_bytes().to_vec();
    Ok(Identity { unique_id, cert_pem, cert_der, cert_signature, key, key_pkcs8 })
}

/// A self-signed RSA certificate, as Moonlight clients present to hosts.
fn make_cert(key: &RsaPrivateKey) -> Result<String, String> {
    let signer = SigningKey::<Sha256>::new(key.clone());
    let spki = SubjectPublicKeyInfoOwned::from_key(key.to_public_key()).map_err(|e| e.to_string())?;
    let serial = SerialNumber::new(&[1]).map_err(|e| e.to_string())?;
    let validity = Validity::from_now(Duration::from_secs(20 * 365 * 24 * 3600)).map_err(|e| e.to_string())?;
    let subject = Name::from_str("CN=NVIDIA GameStream Client").map_err(|e| e.to_string())?;
    let builder = CertificateBuilder::new(Profile::Root, serial, validity, subject, spki, &signer).map_err(|e| e.to_string())?;
    let cert = builder.build::<Signature>().map_err(|e| e.to_string())?;
    cert.to_pem(LineEnding::LF).map_err(|e| e.to_string())
}

/// "key@address" keeps the certificate under the key; a bare address under itself.
fn host_cert_path(dir: &Path, host: &str) -> PathBuf {
    let name = host.split_once('@').map(|(k, _)| k).unwrap_or(host);
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    dir.join("hosts").join(format!("{safe}.pem"))
}

fn split_host(host: &str) -> (String, u16) {
    let host = host.split_once('@').map(|(_, a)| a).unwrap_or(host);
    // [v6]:port, v4:port or a bare address
    if let Some(rest) = host.strip_prefix('[') {
        if let Some((addr, port)) = rest.split_once("]:") {
            return (addr.to_string(), port.parse().unwrap_or(DEFAULT_HTTP_PORT));
        }
        return (rest.trim_end_matches(']').to_string(), DEFAULT_HTTP_PORT);
    }
    match host.rsplit_once(':') {
        Some((addr, port)) if !addr.contains(':') => (addr.to_string(), port.parse().unwrap_or(DEFAULT_HTTP_PORT)),
        _ => (host.to_string(), DEFAULT_HTTP_PORT),
    }
}

/* -------------------------------------------------------------- host info */

struct HostInfo {
    paired: bool,
    app_version: String,
    gfe_version: String,
    codec_support: i32,
    https_port: u16,
    current_game: i32,
    hostname: String,
}

fn parse_info(body: &str) -> HostInfo {
    let https_port = xml_value(body, "HttpsPort").and_then(|v| v.parse().ok()).filter(|p| *p != 0).unwrap_or(DEFAULT_HTTPS_PORT);
    let state = xml_value(body, "state").unwrap_or_default();
    let mut current_game = xml_value(body, "currentgame").and_then(|v| v.parse().ok()).unwrap_or(0);
    if !state.contains("_SERVER_BUSY") {
        current_game = 0;
    }
    HostInfo {
        paired: xml_value(body, "PairStatus").as_deref() == Some("1"),
        app_version: xml_value(body, "appversion").unwrap_or_default(),
        gfe_version: xml_value(body, "GfeVersion").unwrap_or_default(),
        codec_support: xml_value(body, "ServerCodecModeSupport").and_then(|v| v.parse().ok()).unwrap_or(1),
        https_port,
        current_game,
        hostname: xml_value(body, "hostname").unwrap_or_default(),
    }
}

/// Host info over HTTPS when paired (only then does it say "paired"), else over HTTP.
fn host_info(dir: &Path, id: &Identity, host: &str) -> Result<HostInfo, String> {
    let (addr, port) = split_host(host);
    let path = format!("/serverinfo?uniqueid={}&uuid={}", id.unique_id, uuid());
    let plain = http_get(&addr, port, &path, QUICK)?;
    xml_status(&plain.body)?;
    let mut info = parse_info(&plain.body);
    info.paired = false;
    if let Ok(pem) = fs::read_to_string(host_cert_path(dir, host)) {
        if let Ok(server) = Certificate::from_pem(pem.as_bytes()).and_then(|c| c.to_der()) {
            if let Ok(res) = https_get(&addr, info.https_port, &path, &id.cert_der, &id.key_pkcs8, &server, QUICK) {
                if xml_status(&res.body).is_ok() {
                    info = parse_info(&res.body);
                }
            }
        }
    }
    Ok(info)
}

fn pinned_cert(dir: &Path, host: &str) -> Result<Vec<u8>, String> {
    let pem = fs::read_to_string(host_cert_path(dir, host)).map_err(|_| "not paired with this host".to_string())?;
    Certificate::from_pem(pem.as_bytes()).and_then(|c| c.to_der()).map_err(|e| e.to_string())
}

/* ----------------------------------------------------------------- pairing */

fn aes_ecb(key: &[u8], data: &[u8], encrypt: bool) -> Vec<u8> {
    let cipher = Aes128::new_from_slice(&key[..16]).expect("16 byte key");
    let mut out = data.to_vec();
    for block in out.chunks_mut(16) {
        let b = aes::Block::from_mut_slice(block);
        if encrypt {
            cipher.encrypt_block(b);
        } else {
            cipher.decrypt_block(b);
        }
    }
    out
}

fn pair_step(addr: &str, port: u16, id: &Identity, name: &str, query: &str, timeout: Duration) -> Result<String, String> {
    let path = format!("/pair?uniqueid={}&uuid={}&devicename={}&updateState=1&{}", id.unique_id, uuid(), name, query);
    let res = http_get(addr, port, &path, timeout)?;
    xml_status(&res.body)?;
    if xml_value(&res.body, "paired").as_deref() != Some("1") {
        return Err("the host refused pairing (wrong PIN?)".into());
    }
    Ok(res.body)
}

/// Device names go into a URL: letters, digits, dot, dash and underscore only.
fn device_name(raw: &str) -> String {
    let clean: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(64).collect();
    if clean.is_empty() {
        "roth".into()
    } else {
        clean
    }
}

/// The GameStream pairing handshake. The PIN is shown to the user, who enters
/// it on the host; the first request waits for that.
fn pair(dir: &Path, host: &str, pin: &str, name: &str) -> Result<(), String> {
    let name = device_name(name);
    let id = identity(dir)?;
    let (addr, port) = split_host(host);
    let info = host_info(dir, &id, host)?;
    let major: i32 = info.app_version.split('.').next().and_then(|v| v.parse().ok()).unwrap_or(7);
    if major < 7 {
        return Err("the host is too old (GameStream before version 7)".into());
    }

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let body = pair_step(
        &addr,
        port,
        &id,
        &name,
        &format!("phrase=getservercert&salt={}&clientcert={}", hex::encode(salt), hex::encode(id.cert_pem.as_bytes())),
        Duration::from_secs(180),
    )?;
    let plaincert = hex::decode(xml_value(&body, "plaincert").ok_or("the host sent no certificate")?).map_err(|e| e.to_string())?;
    let server_pem = String::from_utf8(plaincert).map_err(|e| e.to_string())?;
    let server = Certificate::from_pem(server_pem.as_bytes()).map_err(|e| e.to_string())?;

    let mut salted = salt.to_vec();
    salted.extend_from_slice(pin.as_bytes());
    let aes_key = Sha256::digest(&salted);

    let mut challenge = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut challenge);
    let enc = aes_ecb(&aes_key, &challenge, true);
    let result = pair_step(&addr, port, &id, &name, &format!("clientchallenge={}", hex::encode(enc)), QUICK);
    let body = match result {
        Ok(b) => b,
        Err(e) => {
            unpair(&addr, port, &id);
            return Err(e);
        }
    };
    let resp = hex::decode(xml_value(&body, "challengeresponse").ok_or("no challenge response")?).map_err(|e| e.to_string())?;
    let resp = aes_ecb(&aes_key, &resp, false);
    if resp.len() < 48 {
        unpair(&addr, port, &id);
        return Err("short challenge response".into());
    }
    let server_challenge = &resp[32..48];

    let mut client_secret = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut client_secret);
    let mut hashed = server_challenge.to_vec();
    hashed.extend_from_slice(&id.cert_signature);
    hashed.extend_from_slice(&client_secret);
    let digest = Sha256::digest(&hashed);
    let enc = aes_ecb(&aes_key, &digest, true);
    let body = match pair_step(&addr, port, &id, &name, &format!("serverchallengeresp={}", hex::encode(enc)), QUICK) {
        Ok(b) => b,
        Err(e) => {
            unpair(&addr, port, &id);
            return Err(e);
        }
    };

    // the host proves it knows the PIN too: its secret is signed by its certificate
    let secret = hex::decode(xml_value(&body, "pairingsecret").ok_or("no pairing secret")?).map_err(|e| e.to_string())?;
    if secret.len() <= 16 {
        unpair(&addr, port, &id);
        return Err("short pairing secret".into());
    }
    let spki = server.tbs_certificate.subject_public_key_info.to_der().map_err(|e| e.to_string())?;
    let server_key = RsaPublicKey::from_public_key_der(&spki).map_err(|e| e.to_string())?;
    let verifier = VerifyingKey::<Sha256>::new(server_key);
    let sig = Signature::try_from(&secret[16..]).map_err(|e| e.to_string())?;
    if verifier.verify(&secret[..16], &sig).is_err() {
        unpair(&addr, port, &id);
        return Err("the host's answer is not signed by its certificate: someone may be in the middle".into());
    }

    let signer = SigningKey::<Sha256>::new(id.key.clone());
    let mut client_pairing = client_secret.to_vec();
    client_pairing.extend_from_slice(&signer.sign(&client_secret).to_vec());
    if let Err(e) = pair_step(&addr, port, &id, &name, &format!("clientpairingsecret={}", hex::encode(client_pairing)), QUICK) {
        unpair(&addr, port, &id);
        return Err(e);
    }

    // the last step goes over HTTPS with our certificate, which the host now trusts
    let server_der = server.to_der().map_err(|e| e.to_string())?;
    let path = format!("/pair?uniqueid={}&uuid={}&devicename={}&updateState=1&phrase=pairchallenge", id.unique_id, uuid(), name);
    let res = https_get(&addr, info.https_port, &path, &id.cert_der, &id.key_pkcs8, &server_der, QUICK)?;
    xml_status(&res.body)?;
    if xml_value(&res.body, "paired").as_deref() != Some("1") {
        unpair(&addr, port, &id);
        return Err("pairing was not confirmed".into());
    }

    let cert_path = host_cert_path(dir, host);
    fs::create_dir_all(cert_path.parent().unwrap_or(dir)).map_err(|e| e.to_string())?;
    fs::write(&cert_path, server_pem).map_err(|e| e.to_string())?;
    Ok(())
}

fn unpair(addr: &str, port: u16, id: &Identity) {
    let path = format!("/unpair?uniqueid={}&uuid={}", id.unique_id, uuid());
    let _ = http_get(addr, port, &path, QUICK);
}

/* -------------------------------------------------------------- apps, quit */

fn apps(dir: &Path, host: &str) -> Result<String, String> {
    let id = identity(dir)?;
    let (addr, _) = split_host(host);
    let info = host_info(dir, &id, host)?;
    let server = pinned_cert(dir, host)?;
    let path = format!("/applist?uniqueid={}&uuid={}", id.unique_id, uuid());
    let res = https_get(&addr, info.https_port, &path, &id.cert_der, &id.key_pkcs8, &server, QUICK)?;
    xml_status(&res.body)?;
    let list: Vec<String> = xml_blocks(&res.body, "App")
        .into_iter()
        .map(|b| {
            let title = xml_value(b, "AppTitle").unwrap_or_default();
            let id = xml_value(b, "ID").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            format!("{{\"id\":{id},\"title\":{}}}", json_str(&title))
        })
        .collect();
    Ok(format!("[{}]", list.join(",")))
}

fn quit(dir: &Path, host: &str) -> Result<(), String> {
    let id = identity(dir)?;
    let (addr, _) = split_host(host);
    let info = host_info(dir, &id, host)?;
    let server = pinned_cert(dir, host)?;
    let path = format!("/cancel?uniqueid={}&uuid={}", id.unique_id, uuid());
    let res = https_get(&addr, info.https_port, &path, &id.cert_der, &id.key_pkcs8, &server, QUICK)?;
    xml_status(&res.body)
}

/* ----------------------------------------------------------------- stream */

type FrameCb = extern "C" fn(*const c_uchar, c_int, c_int, c_int, c_int, c_int, c_int, c_ulonglong);
type EventCb = extern "C" fn(c_int, c_int, *const c_char);
type AudioCb = extern "C" fn(*const c_uchar, c_int);

extern "C" {
    fn ml_launch_query() -> *const c_char;
    #[allow(clippy::too_many_arguments)]
    fn ml_start(
        address: *const c_char,
        app_version: *const c_char,
        gfe_version: *const c_char,
        rtsp_url: *const c_char,
        server_codec_mode_support: c_int,
        width: c_int,
        height: c_int,
        fps: c_int,
        bitrate_kbps: c_int,
        packet_size: c_int,
        video_formats: c_int,
        aes_key: *const c_uchar,
        aes_iv: *const c_uchar,
        frame_cb: FrameCb,
        event_cb: EventCb,
        audio_cb: AudioCb,
    ) -> c_int;
    fn ml_stop();
    fn ml_request_idr();
}

static OUT: Mutex<()> = Mutex::new(());

fn emit(kind: u8, payload: &[u8]) {
    let _guard = OUT.lock();
    let mut out = std::io::stdout().lock();
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    // a closed pipe means the app is gone: the stream ends with the process
    if out.write_all(&head).and_then(|_| out.write_all(payload)).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

fn emit_event(json: String) {
    emit(2, json.as_bytes());
}

extern "C" fn on_frame(data: *const c_uchar, length: c_int, number: c_int, frame_type: c_int, format: c_int, width: c_int, height: c_int, pts: c_ulonglong) {
    if data.is_null() || length <= 0 {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
    let mut payload = Vec::with_capacity(19 + bytes.len());
    payload.extend_from_slice(&(format as u16).to_le_bytes());
    payload.push(if frame_type == 1 { 1 } else { 0 });
    payload.extend_from_slice(&(width as u16).to_le_bytes());
    payload.extend_from_slice(&(height as u16).to_le_bytes());
    payload.extend_from_slice(&(number as u32).to_le_bytes());
    payload.extend_from_slice(&(pts as u64).to_le_bytes());
    payload.extend_from_slice(bytes);
    emit(1, &payload);
}

extern "C" fn on_audio(data: *const c_uchar, length: c_int) {
    if data.is_null() || length <= 0 {
        return;
    }
    emit(3, unsafe { std::slice::from_raw_parts(data, length as usize) });
}

extern "C" fn on_event(kind: c_int, code: c_int, text: *const c_char) {
    let text = if text.is_null() { String::new() } else { unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy().trim_end().to_string() };
    let name = match kind {
        1 => "setup",
        2 => "stage",
        3 => "stageDone",
        4 => "stageFailed",
        5 => "started",
        6 => "terminated",
        7 => "log",
        8 => "status",
        9 => "audio",
        _ => "other",
    };
    emit_event(format!("{{\"event\":\"{name}\",\"code\":{code},\"text\":{}}}", json_str(&text)));
    if kind == 6 {
        // the host ended the stream: nothing more will come
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(200));
            std::process::exit(0);
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn stream(dir: &Path, host: &str, app: i64, width: i32, height: i32, fps: i32, kbps: i32, formats: i32, host_audio: bool, packet: i32) -> Result<(), String> {
    let id = identity(dir)?;
    let (addr, _) = split_host(host);
    let info = host_info(dir, &id, host)?;
    if !info.paired {
        return Err("not paired with this host".into());
    }
    let server = pinned_cert(dir, host)?;

    let mut rikey = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut rikey);
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv[..4]);
    let rikeyid = i32::from_be_bytes([iv[0], iv[1], iv[2], iv[3]]);

    // a running session (the host already streams the same app) is joined, not restarted
    let verb = if info.current_game != 0 { "resume" } else { "launch" };
    let extra = unsafe { std::ffi::CStr::from_ptr(ml_launch_query()) }.to_string_lossy().into_owned();
    let path = format!(
        "/{verb}?uniqueid={}&uuid={}&appid={app}&mode={width}x{height}x{fps}&additionalStates=1&sops=0&rikey={}&rikeyid={rikeyid}&localAudioPlayMode={}&surroundAudioInfo=196610&remoteControllersBitmap=0&gcmap=0{extra}",
        id.unique_id,
        uuid(),
        hex::encode(rikey),
        // the streamer keeps hearing the own sound unless the viewer asks otherwise
        if host_audio { 1 } else { 0 },
    );
    let res = https_get(&addr, info.https_port, &path, &id.cert_der, &id.key_pkcs8, &server, Duration::from_secs(30))?;
    xml_status(&res.body)?;
    let ok = xml_value(&res.body, "gamesession").or_else(|| xml_value(&res.body, "resume")).unwrap_or_default();
    if ok == "0" || ok.is_empty() {
        return Err("the host did not start the stream".into());
    }
    let rtsp = xml_value(&res.body, "sessionUrl0").unwrap_or_default();

    let c = |s: &str| std::ffi::CString::new(s).unwrap_or_default();
    let (c_addr, c_app, c_gfe, c_rtsp) = (c(&addr), c(&info.app_version), c(&info.gfe_version), c(&rtsp));
    emit_event(format!("{{\"event\":\"launched\",\"code\":{},\"text\":{}}}", info.codec_support, json_str(&info.hostname)));
    let rc = unsafe {
        ml_start(
            c_addr.as_ptr(),
            c_app.as_ptr(),
            c_gfe.as_ptr(),
            if rtsp.is_empty() { std::ptr::null() } else { c_rtsp.as_ptr() },
            info.codec_support,
            width,
            height,
            fps,
            kbps,
            packet,
            formats,
            rikey.as_ptr(),
            iv.as_ptr(),
            on_frame,
            on_event,
            on_audio,
        )
    };
    if rc != 0 {
        return Err(format!("the stream did not start (error {rc})"));
    }

    // the app talks to us over stdin: a keyframe request, or the end
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        match line.map(|l| l.trim().to_string()).as_deref() {
            Ok("idr") => unsafe { ml_request_idr() },
            Ok("stop") | Err(_) => break,
            _ => {}
        }
    }
    unsafe { ml_stop() };
    Ok(())
}

/* ------------------------------------------------------------------- entry */

pub fn run(args: &[String]) -> Result<(), String> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let dir = PathBuf::from(args.get(1).cloned().unwrap_or_default());
    let host = args.get(2).cloned().unwrap_or_default();
    if dir.as_os_str().is_empty() || host.is_empty() {
        return Err("usage: moonlight info|pair|apps|stream|quit <dir> <host> ...".into());
    }
    let num = |i: usize, default: i64| args.get(i).and_then(|v| v.parse::<i64>().ok()).unwrap_or(default);
    match cmd {
        "info" => {
            let id = identity(&dir)?;
            let info = host_info(&dir, &id, &host)?;
            println!(
                "{{\"paired\":{},\"appVersion\":{},\"hostname\":{},\"codecs\":{},\"busy\":{}}}",
                info.paired,
                json_str(&info.app_version),
                json_str(&info.hostname),
                info.codec_support,
                info.current_game != 0
            );
            Ok(())
        }
        "pair" => {
            let pin = args.get(3).cloned().unwrap_or_default();
            if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
                return Err("the PIN must be 4 digits".into());
            }
            pair(&dir, &host, &pin, args.get(4).map(String::as_str).unwrap_or(""))?;
            println!("{{\"paired\":true}}");
            Ok(())
        }
        "apps" => {
            println!("{}", apps(&dir, &host)?);
            Ok(())
        }
        "quit" => {
            quit(&dir, &host)?;
            println!("{{\"quit\":true}}");
            Ok(())
        }
        "forget" => {
            let _ = fs::remove_file(host_cert_path(&dir, &host));
            println!("{{\"forgot\":true}}");
            Ok(())
        }
        "stream" => stream(
            &dir,
            &host,
            num(3, 0),
            num(4, 1920) as i32,
            num(5, 1080) as i32,
            num(6, 60) as i32,
            num(7, 20_000) as i32,
            num(8, 1) as i32,
            num(9, 1) != 0,
            // through the tunnel each packet gets a header and a tag: smaller video packets keep it under the MTU
            num(10, 1392).clamp(512, 1392) as i32,
        ),
        _ => Err(format!("unknown moonlight command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyed_hosts() {
        assert_eq!(split_host("u-12ab@203.0.113.7:49989"), ("203.0.113.7".to_string(), 49989));
        let dir = Path::new("x");
        assert_eq!(host_cert_path(dir, "u-12ab@203.0.113.7:49989"), dir.join("hosts").join("u-12ab.pem"));
        assert_eq!(device_name("astrum-1f2e!x"), "astrum-1f2ex");
        assert_eq!(device_name(""), "roth");
    }

    #[test]
    fn host_and_port() {
        assert_eq!(split_host("192.168.1.5"), ("192.168.1.5".to_string(), 47989));
        assert_eq!(split_host("192.168.1.5:48000"), ("192.168.1.5".to_string(), 48000));
        assert_eq!(split_host("[fe80::1]:47989"), ("fe80::1".to_string(), 47989));
        assert_eq!(split_host("fe80::1"), ("fe80::1".to_string(), 47989));
    }

    #[test]
    fn identity_is_made_once() {
        let dir = std::env::temp_dir().join(format!("ml-test-{}", random_hex(4)));
        let a = identity(&dir).unwrap();
        let b = identity(&dir).unwrap();
        assert_eq!(a.unique_id, b.unique_id);
        assert_eq!(a.cert_der, b.cert_der);
        assert!(!a.cert_signature.is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
