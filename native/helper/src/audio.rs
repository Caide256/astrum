//! Per-process audio capture for screen sharing.
//!
//! Chromium can only share either the whole system mix, including the client
//! itself (viewers then hear their own voices echoed back), or nothing.
//! Windows 10 2004+ exposes process loopback capture: the audio of one process
//! tree, or everything except one process tree.
//!
//! Output on stdout: raw PCM, 48 kHz, stereo, signed 16-bit little-endian,
//! interleaved frames. The process exits when the stdout pipe is closed.

use std::collections::VecDeque;
use std::io::{self, Write};

use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const RATE: usize = 48_000;
const CHANNELS: usize = 2;
const BLOCK: usize = CHANNELS * 2;

/// Process that owns a window, 0 if the window does not exist.
pub fn window_pid(hwnd: isize) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid));
    }
    pid
}

/// Capture the process tree of `pid` (`include_tree`) or everything except it.
pub fn capture(pid: u32, include_tree: bool) -> Result<(), String> {
    initialize_mta().ok().map_err(|e| format!("COM init failed: {e}"))?;

    let format = WaveFormat::new(16, 16, &SampleType::Int, RATE, CHANNELS, None);
    let mut client = AudioClient::new_application_loopback_client(pid, include_tree)
        .map_err(|e| format!("loopback capture of process {pid} failed: {e}"))?;
    // Process loopback does not deliver buffer events reliably, so the stream
    // is polled every 10 ms with a 100 ms buffer.
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: 1_000_000,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("capture init failed: {e}"))?;

    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(RATE * BLOCK);
    // 10 ms chunks: smaller gains nothing, larger adds latency
    let chunk = RATE / 100 * BLOCK;
    let mut buf = vec![0u8; chunk];

    let debug = std::env::var_os("HELPER_AUDIO_DEBUG").is_some();
    loop {
        // several packets can pile up between polls
        loop {
            let frames = capture.get_next_packet_size().map_err(|e| e.to_string())?.unwrap_or(0);
            if frames == 0 {
                break;
            }
            let info = capture.read_from_device_to_deque(&mut queue).map_err(|e| e.to_string())?;
            if debug {
                eprintln!("packet {frames} frames, flags {:?}, queue {}", info.flags, queue.len());
            }
        }
        while queue.len() >= chunk {
            for b in buf.iter_mut() {
                *b = queue.pop_front().unwrap_or(0);
            }
            // reader closed the pipe
            if out.write_all(&buf).and_then(|_| out.flush()).is_err() {
                let _ = client.stop_stream();
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
