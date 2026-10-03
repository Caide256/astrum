//! Runs the bundled Sunshine for the app and stops it cleanly.
//!
//! Programs started by Node ignore Ctrl+C (the flag is inherited), so a
//! Sunshine started by the app directly could only be killed, which leaves the
//! graphics driver settings it changes while running changed. Started from
//! here, with Ctrl+C handling switched back on, it gets a real Ctrl+C and
//! shuts down properly: it puts the settings back and closes its sessions.
//!
//! Sunshine runs in a job object of this process: if the helper dies, so does
//! Sunshine, and no stream server is left running without the app.
//!
//! Lines on stdin: "stop" (or the end of input, when the app is gone) stops
//! Sunshine. Sunshine's own output goes to stdout as it is.

use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::BOOL;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// The helper itself stays alive through the Ctrl+C it sends to Sunshine.
unsafe extern "system" fn keep_running(_kind: u32) -> BOOL {
    BOOL(1)
}

fn job_for(pid: u32) -> Option<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).ok()?;
        AssignProcessToJobObject(job, process).ok()?;
        // the job handle stays open for the life of this process on purpose
        Some(job)
    }
}

pub fn run(exe: &str, config: &str) -> Result<(), String> {
    unsafe {
        // the inherited "ignore Ctrl+C" is cleared for this process and its child
        SetConsoleCtrlHandler(None, false).map_err(|e| e.to_string())?;
        SetConsoleCtrlHandler(Some(keep_running), true).map_err(|e| e.to_string())?;
    }
    let dir = std::path::Path::new(exe).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut child = Command::new(exe)
        .arg(config)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("cannot start Sunshine: {e}"))?;
    let _job = job_for(child.id());
    println!("{{\"event\":\"started\",\"pid\":{}}}", child.id());

    let stopping = Arc::new(AtomicBool::new(false));
    {
        let stopping = stopping.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line.map(|l| l.trim().to_string()).as_deref() {
                    Ok("stop") | Err(_) => break,
                    _ => {}
                }
            }
            stopping.store(true, Ordering::SeqCst);
            unsafe {
                let _ = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
            }
        });
    }

    let mut asked_at: Option<Instant> = None;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            println!("{{\"event\":\"exited\",\"code\":{}}}", status.code().unwrap_or(-1));
            return Ok(());
        }
        if stopping.load(Ordering::SeqCst) {
            let at = *asked_at.get_or_insert_with(Instant::now);
            // a clean shutdown takes a second or two; past that it is ended by force
            if at.elapsed() > Duration::from_secs(15) {
                let _ = child.kill();
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
