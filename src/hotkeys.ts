import { t, type Key } from "./i18n/index.ts";

/**
 * Hotkeys: key combos bound to call actions.
 *
 * On Windows the native helper watches the keyboard and mouse through
 * low-level hooks (native/helper/src/keys.rs). It tells left and right
 * modifiers apart, reports releases for push-to-talk, and never takes a key
 * away from other programs. Without the helper (plain browser during
 * development, other platforms) the main process falls back to Electron
 * global shortcuts, and the page matches combos itself while it has focus.
 *
 * A combo is a "+"-joined list: modifiers in a fixed order, then at most one
 * main key or mouse button. A combo may consist of modifiers only.
 */

export type HotAction = "mute" | "deafen" | "ptt" | "camera" | "screen" | "leave";

export const ACTIONS: { id: HotAction; name: Key }[] = [
  { id: "mute", name: "hotkey.action.mute" },
  { id: "deafen", name: "hotkey.action.deafen" },
  { id: "ptt", name: "hotkey.action.ptt" },
  { id: "camera", name: "hotkey.action.camera" },
  { id: "screen", name: "hotkey.action.screen" },
  { id: "leave", name: "hotkey.action.leave" },
];

export function actionName(action: HotAction): string {
  const found = ACTIONS.find((a) => a.id === action);
  return found ? t(found.name) : action;
}

export type Binding = { id: string; action: HotAction; combo: string };

const STORE_KEY = "app.hotkeys";

/**
 * On layouts with AltGr, Windows sends a fake left Ctrl together with the
 * right Alt, and combos recorded there came out as "LCtrl+RAlt". Such a
 * combo means the right Alt alone.
 */
function withoutAltGrCtrl(combo: string): string {
  const parts = splitCombo(combo);
  if (!parts.includes("RAlt") || !parts.includes("LCtrl")) return combo;
  return joinCombo(parts.filter((p) => p !== "LCtrl"));
}

export function loadBindings(): Binding[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as Binding[]) : [];
    return Array.isArray(list)
      ? list.filter((b) => b && b.action && typeof b.combo === "string").map((b) => ({ ...b, combo: withoutAltGrCtrl(b.combo) }))
      : [];
  } catch {
    return [];
  }
}

function saveBindings(list: Binding[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
}

/* ------------------------------------------------------------ key names */

/** Modifier names in combo order. Generic names match either side. */
const MODIFIER_ORDER = ["Ctrl", "LCtrl", "RCtrl", "Alt", "LAlt", "RAlt", "Shift", "LShift", "RShift", "Super", "LWin", "RWin"];

const MOD_BY_CODE: Record<string, string> = {
  ControlLeft: "LCtrl",
  ControlRight: "RCtrl",
  AltLeft: "LAlt",
  AltRight: "RAlt",
  ShiftLeft: "LShift",
  ShiftRight: "RShift",
  MetaLeft: "LWin",
  MetaRight: "RWin",
  OSLeft: "LWin",
  OSRight: "RWin",
};

/** Mouse buttons by MouseEvent.button. Left and right clicks are never bound. */
const MOUSE_BY_BUTTON: Record<number, string> = { 1: "Mouse3", 3: "Mouse4", 4: "Mouse5" };

/** Main keys by KeyboardEvent.code; the physical key, independent of layout. */
const KEY_BY_CODE: Record<string, string> = {
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "numenter",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  CapsLock: "CapsLock",
  ContextMenu: "ContextMenu",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Insert: "Insert",
  Delete: "Delete",
  PrintScreen: "PrintScreen",
  ScrollLock: "Scrolllock",
  Pause: "Pause",
  MediaPlayPause: "MediaPlayPause",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
  MediaStop: "MediaStop",
  AudioVolumeMute: "VolumeMute",
  AudioVolumeUp: "VolumeUp",
  AudioVolumeDown: "VolumeDown",
};

function keyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return `num${e.code.slice(6)}`;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  if (KEY_BY_CODE[e.code]) return KEY_BY_CODE[e.code];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

function isModifier(name: string): boolean {
  return MODIFIER_ORDER.includes(name);
}

function isMouse(name: string): boolean {
  return /^Mouse\d$/.test(name);
}

function splitCombo(combo: string): string[] {
  // "+" is not a key name of its own: numpad plus is "numadd"
  return combo ? combo.split("+").filter(Boolean) : [];
}

/** Modifiers in canonical order, then the main key. */
function joinCombo(parts: string[]): string {
  const mods = MODIFIER_ORDER.filter((m) => parts.includes(m));
  const rest = parts.filter((p) => !isModifier(p));
  return [...mods, ...rest.slice(0, 1)].join("+");
}

/* --------------------------------------------------------- virtual keys */

const MOD_VK: Record<string, number[]> = {
  Ctrl: [0xa2, 0xa3],
  LCtrl: [0xa2],
  RCtrl: [0xa3],
  Alt: [0xa4, 0xa5],
  LAlt: [0xa4],
  RAlt: [0xa5],
  Shift: [0xa0, 0xa1],
  LShift: [0xa0],
  RShift: [0xa1],
  Super: [0x5b, 0x5c],
  LWin: [0x5b],
  RWin: [0x5c],
};

const KEY_VK: Record<string, number> = {
  numadd: 0x6b,
  numsub: 0x6d,
  nummult: 0x6a,
  numdiv: 0x6f,
  numdec: 0x6e,
  numenter: 0x10d,
  "-": 0xbd,
  "=": 0xbb,
  "[": 0xdb,
  "]": 0xdd,
  ";": 0xba,
  "'": 0xde,
  ",": 0xbc,
  ".": 0xbe,
  "/": 0xbf,
  "\\": 0xdc,
  "`": 0xc0,
  Space: 0x20,
  Enter: 0x0d,
  Tab: 0x09,
  Backspace: 0x08,
  CapsLock: 0x14,
  ContextMenu: 0x5d,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  PageUp: 0x21,
  PageDown: 0x22,
  Home: 0x24,
  End: 0x23,
  Insert: 0x2d,
  Delete: 0x2e,
  PrintScreen: 0x2c,
  Scrolllock: 0x91,
  Pause: 0x13,
  MediaPlayPause: 0xb3,
  MediaNextTrack: 0xb0,
  MediaPreviousTrack: 0xb1,
  MediaStop: 0xb2,
  VolumeMute: 0xad,
  VolumeUp: 0xaf,
  VolumeDown: 0xae,
  Mouse3: 0x04,
  Mouse4: 0x05,
  Mouse5: 0x06,
};

function vkOf(name: string): number[] | null {
  if (MOD_VK[name]) return MOD_VK[name];
  if (/^[A-Z0-9]$/.test(name)) return [name.charCodeAt(0)];
  const num = /^num(\d)$/.exec(name);
  if (num) return [0x60 + Number(num[1])];
  const fn = /^F(\d{1,2})$/.exec(name);
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return [0x6f + Number(fn[1])];
  return KEY_VK[name] !== undefined ? [KEY_VK[name]] : null;
}

/** Combo as key-code parts for the native helper; null if some key is unknown. */
export function comboKeys(combo: string): number[][] | null {
  const parts = splitCombo(combo).map(vkOf);
  return parts.length && parts.every(Boolean) ? (parts as number[][]) : null;
}

/** Electron accelerator for the fallback path; null if it cannot express the combo. */
function accelerator(combo: string): string | null {
  const parts = splitCombo(combo);
  const main = parts.filter((p) => !isModifier(p));
  if (main.length !== 1 || isMouse(main[0])) return null;
  const mods = new Set(
    parts
      .filter(isModifier)
      .map((m) => ({ LCtrl: "Ctrl", RCtrl: "Ctrl", LAlt: "Alt", RAlt: "Alt", LShift: "Shift", RShift: "Shift", LWin: "Super", RWin: "Super" })[m] ?? m),
  );
  const key = main[0] === "numenter" ? "Enter" : main[0];
  return [...mods].map((m) => (m === "Ctrl" ? "CommandOrControl" : m)).concat(key).join("+");
}

/* --------------------------------------------------------------- checks */

const TYPING_KEYS = new Set(["Space", "Enter", "Tab", "Backspace", "-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"]);

function hasCommandModifier(combo: string): boolean {
  return splitCombo(combo).some((p) => /Ctrl|Alt|Super|Win/.test(p));
}

/** A combo that also types text: a letter, digit or punctuation without Ctrl, Alt or Win. */
export function typesText(combo: string): boolean {
  const main = splitCombo(combo).filter((p) => !isModifier(p));
  if (hasCommandModifier(combo) || main.length !== 1) return false;
  return /^[A-Z0-9]$/.test(main[0]) || TYPING_KEYS.has(main[0]) || /^num[\d]$|^numdec$/.test(main[0]);
}

/** Why the combo cannot be used right now, or "" if it can. */
export function comboProblem(combo: string): string {
  const parts = splitCombo(combo);
  const main = parts.filter((p) => !isModifier(p));
  if (native) return "";
  if (!main.length || main.some(isMouse)) return t("hotkey.problem.needsHelper");
  // RegisterHotKey takes the key away from every program
  if (typesText(combo) && !parts.some(isModifier)) return t("hotkey.problem.stolen");
  return "";
}

/** A note to show next to a combo that works but has side effects. */
export function comboWarning(combo: string): string {
  return native && typesText(combo) ? t("hotkey.warn.typing") : "";
}

/* -------------------------------------------------------------- display */

const PRETTY: Record<string, Key> = {
  Ctrl: "key.ctrl",
  LCtrl: "key.lctrl",
  RCtrl: "key.rctrl",
  Alt: "key.alt",
  LAlt: "key.lalt",
  RAlt: "key.ralt",
  Shift: "key.shift",
  LShift: "key.lshift",
  RShift: "key.rshift",
  Super: "key.win",
  LWin: "key.lwin",
  RWin: "key.rwin",
  Up: "key.up",
  Down: "key.down",
  Left: "key.left",
  Right: "key.right",
  Space: "key.space",
  VolumeMute: "key.volumeMute",
  VolumeUp: "key.volumeUp",
  VolumeDown: "key.volumeDown",
  Mouse3: "key.mouse3",
  Mouse4: "key.mouse4",
  Mouse5: "key.mouse5",
};

const PLAIN: Record<string, string> = {
  numadd: "Num +",
  numsub: "Num -",
  nummult: "Num *",
  numdiv: "Num /",
  numdec: "Num .",
  numenter: "Num Enter",
  Scrolllock: "Scroll Lock",
  CapsLock: "Caps Lock",
  PageUp: "Page Up",
  PageDown: "Page Down",
  PrintScreen: "Print Screen",
  MediaPlayPause: "Play/Pause",
  MediaNextTrack: "Next Track",
  MediaPreviousTrack: "Previous Track",
  MediaStop: "Stop",
};

export function prettyCombo(combo: string): string {
  return splitCombo(combo)
    .map((k) => (PRETTY[k] ? t(PRETTY[k]) : (PLAIN[k] ?? (/^num\d$/.test(k) ? `Num ${k.slice(3)}` : k))))
    .join(" + ");
}

/* ------------------------------------------------------------- matching */

type Handler = (down: boolean) => void;
type Bridge = {
  setHotkeys?: (
    list: { id: string; action: string; keys: number[][] | null; accelerator: string | null }[],
  ) => Promise<{ native: boolean; failed: string[] } | string[] | void>;
};

const bridge = (globalThis as unknown as { desktop?: Bridge }).desktop ?? null;

let handlers: Partial<Record<HotAction, Handler>> = {};
let current: Binding[] = loadBindings();
let listening = false;
let paused = false;
/** The native helper handles keys, including those pressed in this window. */
let native = false;
/** Combos Electron could not register: another program holds them. */
let failed: string[] = [];
/** Bindings currently held down, for push-to-talk release. */
const active = new Set<string>();

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable;
}

function fire(binding: Binding, down: boolean): void {
  if (down) active.add(binding.id);
  else if (!active.delete(binding.id)) return;
  // toggles fire on press only; push-to-talk also needs the release
  if (!down && binding.action !== "ptt") return;
  handlers[binding.action]?.(down);
}

function releaseAll(): void {
  for (const id of [...active]) {
    const b = current.find((x) => x.id === id);
    active.delete(id);
    if (b?.action === "ptt") handlers.ptt?.(false);
  }
}

/* In-window matching, used only without the native helper. */

const held = new Set<string>();

const SIDES: Record<string, string[]> = {
  Ctrl: ["LCtrl", "RCtrl"],
  Alt: ["LAlt", "RAlt"],
  Shift: ["LShift", "RShift"],
  Super: ["LWin", "RWin"],
};

/** A combo part matches a pressed key: the same key, or a generic modifier and one of its sides. */
function covers(part: string, name: string): boolean {
  return part === name || (SIDES[part]?.includes(name) ?? false);
}

function satisfied(part: string): boolean {
  return held.has(part) || (SIDES[part] ?? []).some((s) => held.has(s));
}

function localMatch(b: Binding): boolean {
  const parts = splitCombo(b.combo);
  if (!parts.length || !parts.every(satisfied)) return false;
  return [...held].filter(isModifier).every((m) => parts.some((p) => covers(p, m)));
}

function localPress(name: string): void {
  if (held.has(name)) return;
  held.add(name);
  for (const b of current) {
    if (!active.has(b.id) && splitCombo(b.combo).some((p) => covers(p, name)) && localMatch(b)) {
      fire(b, true);
    }
  }
}

function localRelease(name: string): void {
  held.delete(name);
  for (const b of current) {
    if (active.has(b.id) && !splitCombo(b.combo).every(satisfied)) fire(b, false);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (native || paused || e.repeat) return;
  const name = MOD_BY_CODE[e.code] ?? keyName(e);
  // plain keys typed into a text field are text, not hotkeys
  if (!isModifier(name) && isEditable(e.target as Element) && !(e.ctrlKey || e.altKey || e.metaKey)) return;
  const before = active.size;
  localPress(name);
  if (active.size > before && !isModifier(name)) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  if (native) return;
  localRelease(MOD_BY_CODE[e.code] ?? keyName(e));
}

function onMouseDown(e: MouseEvent): void {
  const name = MOUSE_BY_BUTTON[e.button];
  if (native || paused || !name) return;
  localPress(name);
}

function onMouseUp(e: MouseEvent): void {
  const name = MOUSE_BY_BUTTON[e.button];
  if (!native && name) localRelease(name);
}

function onBlur(): void {
  // keys released outside the window never report a keyup here
  held.clear();
  if (!native) releaseAll();
}

/** An event from the main process: the native helper, a global shortcut or the tray menu. */
function onGlobal(e: Event): void {
  const detail = (e as CustomEvent<{ id?: string; action?: string; down?: boolean } | string>).detail;
  const info = typeof detail === "string" ? { action: detail, down: true } : (detail ?? {});
  const down = info.down !== false;
  const binding = info.id ? current.find((b) => b.id === info.id) : undefined;
  if (binding) {
    if (paused && down) return;
    // a toggle on a typing key while typing in this window would fire on every keystroke
    if (down && binding.action !== "ptt" && document.hasFocus() && isEditable(document.activeElement) && typesText(binding.combo)) {
      return;
    }
    fire(binding, down);
    return;
  }
  if (!paused && down) handlers[info.action as HotAction]?.(true);
}

async function registerGlobal(list: Binding[]): Promise<string[]> {
  const items = list
    .filter((b) => !!b.combo)
    .map((b) => ({ id: b.id, action: b.action, keys: comboKeys(b.combo), accelerator: accelerator(b.combo) }));
  const res = await bridge?.setHotkeys?.(items).catch(() => undefined);
  if (res && !Array.isArray(res) && typeof res === "object") {
    native = res.native;
    failed = list.filter((b) => res.failed.includes(accelerator(b.combo) ?? "")).map((b) => b.combo);
  } else {
    native = false;
    const busy = Array.isArray(res) ? res : [];
    failed = list.filter((b) => busy.includes(accelerator(b.combo) ?? "")).map((b) => b.combo);
  }
  return failed;
}

export function busyCombos(): string[] {
  return failed;
}

export function nativeHotkeys(): boolean {
  return native;
}

export function startHotkeys(map: Partial<Record<HotAction, Handler>>): void {
  handlers = map;
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("app:hotkey", onGlobal as EventListener);
  void registerGlobal(current);
}

export function getBindings(): Binding[] {
  return current;
}

export function setBindings(list: Binding[]): Promise<string[]> {
  releaseAll();
  current = list;
  saveBindings(list);
  return registerGlobal(paused ? [] : list);
}

/** While a new combo is being recorded, existing ones must not fire. */
export function pauseHotkeys(on: boolean): Promise<string[]> {
  paused = on;
  if (on) releaseAll();
  return registerGlobal(on ? [] : current);
}

export function newBindingId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------ recording */

/**
 * Record a combo from the next key press. A modifier pressed and released on
 * its own becomes a modifier-only combo; middle and side mouse buttons count
 * as main keys. Escape always cancels and cannot be bound.
 */
export function recordCombo(done: (combo: string) => void, cancel: () => void): () => void {
  const mods: string[] = [];
  let usedMain = false;
  // AltGr: the fake left Ctrl arrives right before the right Alt, with the same time stamp
  let ctrlAt = -1;
  let fakeCtrl = false;

  const finish = (main: string) => done(joinCombo([...mods, main]));

  const onDown = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.code === "Escape") {
      cancel();
      return;
    }
    const mod = MOD_BY_CODE[e.code];
    if (mod === "LCtrl") ctrlAt = e.timeStamp;
    if (mod === "RAlt" && mods.includes("LCtrl") && (e.key === "AltGraph" || e.timeStamp - ctrlAt < 60)) {
      mods.splice(mods.indexOf("LCtrl"), 1);
      fakeCtrl = true;
    }
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
      usedMain = false;
      return;
    }
    usedMain = true;
    finish(keyName(e));
  };
  const onUp = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const mod = MOD_BY_CODE[e.code];
    if (!mod) return;
    if (mod === "LCtrl" && fakeCtrl) {
      fakeCtrl = false;
      return;
    }
    const alone = mods.length > 0 && !usedMain;
    const combo = joinCombo([...mods]);
    // the released modifier is gone either way, even if the combo gets refused
    if (mods.includes(mod)) mods.splice(mods.indexOf(mod), 1);
    if (alone) done(combo);
  };
  const onMouse = (e: MouseEvent) => {
    const name = MOUSE_BY_BUTTON[e.button];
    if (!name) return;
    e.preventDefault();
    e.stopPropagation();
    finish(name);
  };
  const stopMenu = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", onDown, true);
  window.addEventListener("keyup", onUp, true);
  window.addEventListener("mousedown", onMouse, true);
  window.addEventListener("auxclick", stopMenu, true);
  return () => {
    window.removeEventListener("keydown", onDown, true);
    window.removeEventListener("keyup", onUp, true);
    window.removeEventListener("mousedown", onMouse, true);
    window.removeEventListener("auxclick", stopMenu, true);
  };
}
