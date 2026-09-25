//! Native helper of the desktop client.
//!
//! Modes:
//!   native-helper exclude <pid>   capture all system audio except the process tree
//!   native-helper include <pid>   capture only the process tree
//!   native-helper window <hwnd>   capture only the program that owns the window
//!   native-helper keys            global key bindings, see keys.rs
//!   native-helper press <vk,...>  press and release keys (self-test aid)

mod audio;
mod keys;

use std::process::ExitCode;

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
        _ => Err("usage: native-helper exclude|include <pid> | window <hwnd> | keys | press <vk,...>".into()),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
