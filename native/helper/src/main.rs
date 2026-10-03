//! Native helper of the desktop client.
//!
//! Modes:
//!   native-helper exclude <pid>   capture all system audio except the process tree
//!   native-helper include <pid>   capture only the process tree
//!   native-helper window <hwnd>   capture only the program that owns the window
//!   native-helper keys            global key bindings, see keys.rs
//!   native-helper press <vk,...>  press and release keys (self-test aid)
//!   native-helper moonlight ...   watch a Moonlight (Sunshine) stream, see moonlight/mod.rs
//!   native-helper ctrlc <pid>     ask a console program to quit as on Ctrl+C
//!   native-helper sunshine <exe> <config>
//!                                 run Sunshine for the app, see sunshine.rs

mod audio;
mod keys;
mod moonlight;
mod sunshine;

use std::process::ExitCode;

/// A console program quits cleanly on Ctrl+C: Sunshine then puts back the
/// graphics driver settings it changed while running. Killing it would leave
/// them changed until its next start. The helper joins the program's console,
/// ignores the event itself and sends it there.
fn ctrl_c(pid: u32) -> Result<(), String> {
    use windows::Win32::System::Console::{AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT};
    unsafe {
        let _ = FreeConsole();
        AttachConsole(pid).map_err(|e| format!("cannot reach the program's console: {e}"))?;
        SetConsoleCtrlHandler(None, true).map_err(|e| e.to_string())?;
        let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
        // the handlers run on their own threads: stay attached a moment
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = FreeConsole();
        sent.map_err(|e| format!("cannot send Ctrl+C: {e}"))
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let arg = args.get(2).map(String::as_str).unwrap_or("");
    let target: i64 = arg.parse().unwrap_or(0);

    let result = match mode {
        "exclude" if target > 0 => audio::capture(target as u32, false),
        // Windows builds the process tree itself, so child processes of the
        // window's program are included. Walking up to a parent by pid is
        // unsafe: a dead parent's pid may already belong to another program.
        "include" if target > 0 => audio::capture(target as u32, true),
        "window" if target != 0 => match audio::window_pid(target as isize) {
            0 => Err(format!("window {target} not found")),
            pid => audio::capture(pid, true),
        },
        "keys" => keys::run(),
        "press" if !arg.is_empty() => keys::press_keys(arg),
        "moonlight" => moonlight::run(&args[2..]),
        "ctrlc" if target > 0 => ctrl_c(target as u32),
        "sunshine" if args.len() >= 4 => sunshine::run(&args[2], &args[3]),
        _ => Err("usage: native-helper exclude|include <pid> | window <hwnd> | keys | press <vk,...> | moonlight ... | ctrlc <pid>".into()),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
