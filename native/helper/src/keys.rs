//! Global key and mouse-button bindings through low-level input hooks.
//!
//! Unlike RegisterHotKey, a low-level hook sees left and right modifiers as
//! different keys, reports key releases (needed for push-to-talk) and does not
//! take keys away from other programs.
//!
//! Commands on stdin, one per line:
//!   clear                        drop all bindings
//!   bind <id> <part>,<part>,...  add a binding; a part is one or more key
//!                                codes in hex joined by '|', any of which
//!                                satisfies the part
//! Events on stdout:
//!   ready                        hooks are installed
//!   down <id>                    every part is held and no extra modifier is
//!   up <id>                      a part of an active binding was released
//!
//! Key codes are Windows virtual-key codes with two exceptions: numpad keys are
//! matched by scan code, so they work with Num Lock on or off, and the numpad
//! Enter uses the pseudo code 0x10D. Mouse buttons use VK_MBUTTON, VK_XBUTTON1
//! and VK_XBUTTON2. The mouse hook is installed only while a binding uses a
//! mouse button. The process exits when stdin is closed.
//!
//! On layouts with AltGr the system sends a left Ctrl with scan code 0x21D
//! along with the right Alt. That Ctrl is not a key the user pressed and is
//! ignored, otherwise a right Alt binding would see an extra modifier.

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, MSG,
    MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

const KEY_SPACE: usize = 0x200;
const NUM_ENTER: u16 = 0x10D;
const VK_RETURN: u32 = 0x0D;
const VK_LCONTROL: u32 = 0xA2;
/// Scan code flag of the left Ctrl that the system adds for AltGr.
const ALTGR_CTRL: u32 = 0x200;
const MODIFIERS: [u16; 8] = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];
const MOUSE_KEYS: [u16; 3] = [0x04, 0x05, 0x06];
const WM_REHOOK: u32 = WM_APP + 1;

struct Binding {
    id: String,
    parts: Vec<Vec<u16>>,
    active: bool,
}

struct State {
    bindings: Vec<Binding>,
    held: [bool; KEY_SPACE],
    wants_mouse: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    bindings: Vec::new(),
    held: [false; KEY_SPACE],
    wants_mouse: false,
});
static OUT: OnceLock<Sender<String>> = OnceLock::new();
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);

fn emit(line: String) {
    if let Some(tx) = OUT.get() {
        let _ = tx.send(line);
    }
}

/// Numpad keys by scan code (non-extended), independent of Num Lock.
fn numpad(scan: u32) -> Option<u16> {
    Some(match scan {
        0x52 => 0x60,
        0x4F => 0x61,
        0x50 => 0x62,
        0x51 => 0x63,
        0x4B => 0x64,
        0x4C => 0x65,
        0x4D => 0x66,
        0x47 => 0x67,
        0x48 => 0x68,
        0x49 => 0x69,
        0x53 => 0x6E,
        _ => return None,
    })
}

fn key_id(vk: u32, scan: u32, extended: bool) -> u16 {
    if !extended {
        if let Some(k) = numpad(scan) {
            return k;
        }
    }
    if vk == VK_RETURN && extended {
        return NUM_ENTER;
    }
    (vk as usize % KEY_SPACE) as u16
}

fn part_held(part: &[u16], held: &[bool; KEY_SPACE]) -> bool {
    part.iter().any(|&k| held[k as usize])
}

fn uses(b: &Binding, key: u16) -> bool {
    b.parts.iter().any(|p| p.contains(&key))
}

/// All parts held and no modifier held that the binding does not ask for.
fn matches(b: &Binding, held: &[bool; KEY_SPACE]) -> bool {
    b.parts.iter().all(|p| part_held(p, held))
        && MODIFIERS.iter().all(|&m| !held[m as usize] || uses(b, m))
}

fn press(state: &mut State, key: u16) {
    let State { bindings, held, .. } = state;
    if held[key as usize] {
        return; // auto-repeat
    }
    // A key-up lost to the lock screen or a UAC prompt would leave a modifier
    // stuck and block every binding, so held modifiers are re-checked.
    for m in MODIFIERS {
        if m != key && held[m as usize] && unsafe { GetAsyncKeyState(m as i32) } >= 0 {
            held[m as usize] = false;
        }
    }
    held[key as usize] = true;
    for b in bindings.iter_mut() {
        if !b.active && uses(b, key) && matches(b, held) {
            b.active = true;
            emit(format!("down {}", b.id));
        }
    }
}

fn release(state: &mut State, key: u16) {
    let State { bindings, held, .. } = state;
    held[key as usize] = false;
    for b in bindings.iter_mut() {
        if b.active && uses(b, key) && !b.parts.iter().all(|p| part_held(p, held)) {
            b.active = false;
            emit(format!("up {}", b.id));
        }
    }
}

fn handle(key: u16, down: bool) {
    let mut state = match STATE.lock() {
        Ok(s) => s,
        Err(poisoned) => poisoned.into_inner(),
    };
    if down {
        press(&mut state, key);
    } else {
        release(&mut state, key);
    }
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let fake_ctrl = info.vkCode == VK_LCONTROL && info.scanCode & ALTGR_CTRL != 0;
        if !fake_ctrl {
            let key = key_id(info.vkCode, info.scanCode, info.flags.contains(LLKHF_EXTENDED));
            match wparam.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => handle(key, true),
                WM_KEYUP | WM_SYSKEYUP => handle(key, false),
                _ => {}
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        let key = match msg {
            WM_MBUTTONDOWN | WM_MBUTTONUP => Some(0x04),
            WM_XBUTTONDOWN | WM_XBUTTONUP => {
                let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                Some(if (info.mouseData >> 16) & 0xFFFF == 1 { 0x05 } else { 0x06 })
            }
            _ => None,
        };
        if let Some(k) = key {
            handle(k, matches!(msg, WM_MBUTTONDOWN | WM_XBUTTONDOWN));
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn parse_part(text: &str) -> Option<Vec<u16>> {
    let keys: Vec<u16> = text
        .split('|')
        .filter_map(|k| u16::from_str_radix(k.trim(), 16).ok())
        .filter(|&k| (k as usize) < KEY_SPACE)
        .collect();
    (!keys.is_empty()).then_some(keys)
}

fn apply(line: &str) {
    let mut words = line.split_whitespace();
    let mut state = match STATE.lock() {
        Ok(s) => s,
        Err(poisoned) => poisoned.into_inner(),
    };
    match words.next() {
        Some("clear") => state.bindings.clear(),
        Some("bind") => {
            let (Some(id), Some(spec)) = (words.next(), words.next()) else { return };
            let parts: Option<Vec<Vec<u16>>> = spec.split(',').map(parse_part).collect();
            if let Some(parts) = parts.filter(|p| !p.is_empty()) {
                state.bindings.push(Binding { id: id.to_string(), parts, active: false });
            }
        }
        _ => return,
    }
    let wants = state.bindings.iter().any(|b| MOUSE_KEYS.iter().any(|&m| uses(b, m)));
    if wants != state.wants_mouse {
        state.wants_mouse = wants;
        let thread = HOOK_THREAD.load(Ordering::SeqCst);
        if thread != 0 {
            let _ = unsafe { PostThreadMessageW(thread, WM_REHOOK, WPARAM(0), LPARAM(0)) };
        }
    }
}

fn module() -> Option<HINSTANCE> {
    unsafe { GetModuleHandleW(None) }.ok().map(|m| HINSTANCE(m.0))
}

pub fn run() -> Result<(), String> {
    let (tx, rx) = channel::<String>();
    let _ = OUT.set(tx);

    // Hook callbacks must return quickly, so writing to the pipe happens here.
    std::thread::spawn(move || {
        let stdout = io::stdout();
        for line in rx {
            let mut out = stdout.lock();
            if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                std::process::exit(0);
            }
        }
    });

    HOOK_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let keyboard_hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module(), 0) }
        .map_err(|e| format!("keyboard hook failed: {e}"))?;

    std::thread::spawn(|| {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(l) => apply(&l),
                Err(_) => break,
            }
        }
        std::process::exit(0);
    });
    emit("ready".into());

    let mut mouse_hook: Option<HHOOK> = None;
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
        if msg.message == WM_REHOOK {
            let wants = STATE.lock().map(|s| s.wants_mouse).unwrap_or(false);
            if wants && mouse_hook.is_none() {
                mouse_hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module(), 0) }.ok();
            } else if !wants {
                if let Some(h) = mouse_hook.take() {
                    let _ = unsafe { UnhookWindowsHookEx(h) };
                }
            }
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    let _ = unsafe { UnhookWindowsHookEx(keyboard_hook) };
    Ok(())
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Self-test aid: press the keys in order, then release them in reverse.
pub fn press_keys(spec: &str) -> Result<(), String> {
    let keys: Vec<u16> = spec
        .split(',')
        .filter_map(|k| u16::from_str_radix(k.trim(), 16).ok())
        .collect();
    if keys.is_empty() {
        return Err("no keys given".into());
    }
    let size = std::mem::size_of::<INPUT>() as i32;
    let down: Vec<INPUT> = keys.iter().map(|&k| key_input(k, false)).collect();
    let up: Vec<INPUT> = keys.iter().rev().map(|&k| key_input(k, true)).collect();
    unsafe {
        SendInput(&down, size);
    }
    std::thread::sleep(Duration::from_millis(80));
    unsafe {
        SendInput(&up, size);
    }
    Ok(())
}
