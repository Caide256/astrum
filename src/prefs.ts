import { useSyncExternalStore } from "react";
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";

import { BRAND } from "./brand.ts";
import { LANGS, getLang, onLangChange, setLang, type Lang } from "./i18n/index.ts";
import { CUSTOM, THEMES, getCustomTheme, getTheme, importCustomTheme, onThemeChange, setTheme, type ThemeDef } from "./theme.ts";
import { setBlipVolumes } from "./voice/audio.ts";
import { voice, type VoicePrefs } from "./voice/voice.ts";

/**
 * Preferences that follow the account between installs and computers:
 * per-person and per-stream volumes, theme (the own theme included), language,
 * notifications with muted chats, servers and people, sound volumes, the
 * limiter. They live in localStorage and are mirrored to an account data
 * event named after the app id ("<appId>.prefs") on the homeserver, so signing in on a fresh install
 * brings them back. Device-specific settings (microphone, output device,
 * hotkeys) stay local.
 */

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept until restart
  }
}

/** A small observable value with a React hook. */
function cell<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
      listeners.forEach((l) => l());
    },
    on: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    use: () =>
      useSyncExternalStore(
        (cb) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
        () => value,
        () => value,
      ),
  };
}

/* ---------------------------------------------------------- notifications */

export type NotifyMode = "all" | "mentions" | "off";

const NOTIFY_KEY = "app.notify";

function loadNotify(): NotifyMode {
  try {
    const v = localStorage.getItem(NOTIFY_KEY);
    if (v === "all" || v === "mentions" || v === "off") return v;
  } catch {
    // storage unavailable
  }
  return "all";
}

const notify = cell<NotifyMode>(loadNotify());

export function getNotifyMode(): NotifyMode {
  return notify.get();
}

export function setNotifyMode(mode: NotifyMode): void {
  if (mode === notify.get()) return;
  try {
    localStorage.setItem(NOTIFY_KEY, mode);
  } catch {
    // kept until restart
  }
  notify.set(mode);
}

export const useNotifyMode = notify.use;

/* ------------------------------------------------------------------ mutes */

/** Chats, servers and people whose messages make no notification and no sound. */
export type Mutes = { rooms: string[]; servers: string[]; users: string[] };

const MUTES_KEY = "app.mutes";
const NO_MUTES: Mutes = { rooms: [], servers: [], users: [] };

function cleanMutes(raw: Partial<Mutes> | null | undefined): Mutes {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : []);
  return { rooms: list(raw?.rooms), servers: list(raw?.servers), users: list(raw?.users) };
}

const mutes = cell<Mutes>(cleanMutes(loadJson<Partial<Mutes>>(MUTES_KEY, NO_MUTES)));

export function getMutes(): Mutes {
  return mutes.get();
}

export const useMutes = mutes.use;

function saveMutes(next: Mutes): void {
  saveJson(MUTES_KEY, next);
  mutes.set(next);
}

export function isMuted(kind: keyof Mutes, id: string): boolean {
  return mutes.get()[kind].includes(id);
}

export function setMuted(kind: keyof Mutes, id: string, on: boolean): void {
  const cur = mutes.get();
  const had = cur[kind].includes(id);
  if (had === on || !id) return;
  saveMutes({ ...cur, [kind]: on ? [...cur[kind], id] : cur[kind].filter((x) => x !== id) });
}

/* ----------------------------------------------------------------- sounds */

/** Volumes in percent: interface sounds (calls, mute) and message notifications. */
export type SoundPrefs = { ui: number; notify: number; notifyOn: boolean };

const SOUND_KEY = "app.sound-prefs";
const SOUND_DEFAULTS: SoundPrefs = { ui: 70, notify: 60, notifyOn: true };

function cleanSound(raw: Partial<SoundPrefs> | null | undefined): SoundPrefs {
  const pct = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : d);
  return {
    ui: pct(raw?.ui, SOUND_DEFAULTS.ui),
    notify: pct(raw?.notify, SOUND_DEFAULTS.notify),
    notifyOn: typeof raw?.notifyOn === "boolean" ? raw.notifyOn : SOUND_DEFAULTS.notifyOn,
  };
}

const sound = cell<SoundPrefs>(cleanSound(loadJson<Partial<SoundPrefs>>(SOUND_KEY, SOUND_DEFAULTS)));

const applyVolumes = () => setBlipVolumes(sound.get().ui, sound.get().notifyOn ? sound.get().notify : 0);
applyVolumes();
sound.on(applyVolumes);

export function getSoundPrefs(): SoundPrefs {
  return sound.get();
}

export const useSoundPrefs = sound.use;

export function setSoundPrefs(patch: Partial<SoundPrefs>): void {
  const next = cleanSound({ ...sound.get(), ...patch });
  saveJson(SOUND_KEY, next);
  sound.set(next);
}

/* ------------------------------------------------------------------- sync */

const TYPE = `${BRAND.appId}.prefs`;
const SYNCED_KEY = "app.prefs-synced";
const PUSH_DELAY_MS = 3000;

type Synced = VoicePrefs & {
  v: 1;
  theme: string;
  customTheme: ThemeDef;
  lang: Lang;
  notify: NotifyMode;
  mutes: Mutes;
  sound: SoundPrefs;
  origin: string;
};

let client: MatrixClient | null = null;
let timer = 0;
let applying = false;
let stops: (() => void)[] = [];

function collect(origin: string): Synced {
  return {
    v: 1,
    ...voice.exportPrefs(),
    theme: getTheme(),
    customTheme: getCustomTheme(),
    lang: getLang(),
    notify: notify.get(),
    mutes: mutes.get(),
    sound: sound.get(),
    origin,
  };
}

/** The synced part without bookkeeping fields, for comparison. */
function essence(p: Partial<Synced>): string {
  return JSON.stringify([
    p.volumes ?? {},
    p.streams ?? {},
    p.streamMutes ?? {},
    p.limiter,
    p.sounds,
    p.theme,
    p.customTheme ?? null,
    p.lang,
    p.notify,
    p.mutes ?? null,
    p.sound ?? null,
  ]);
}

async function push(): Promise<void> {
  timer = 0;
  const c = client;
  if (!c) return;
  await c.setAccountData(TYPE as never, collect(c.getDeviceId() ?? "") as never).catch(() => undefined);
}

function schedule(): void {
  if (!client || applying) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void push(), PUSH_DELAY_MS);
}

/**
 * Apply preferences from the account. Volumes, mutes and the own theme's
 * colors always follow; `all` (a fresh install) also takes the chosen theme,
 * the language, the notification mode and sound volumes.
 */
function apply(remote: Partial<Synced>, all: boolean): void {
  applying = true;
  try {
    voice.importPrefs(remote, all);
    if (remote.mutes) saveMutes(cleanMutes(remote.mutes));
    if (remote.customTheme && typeof remote.customTheme === "object") importCustomTheme(remote.customTheme);
    if (!all) return;
    if (remote.theme && (remote.theme === CUSTOM || THEMES.some((th) => th.id === remote.theme))) setTheme(remote.theme);
    if (remote.lang && LANGS.some((l) => l.id === remote.lang)) setLang(remote.lang);
    if (remote.notify === "all" || remote.notify === "mentions" || remote.notify === "off") setNotifyMode(remote.notify);
    if (remote.sound) setSoundPrefs(remote.sound);
  } finally {
    applying = false;
  }
}

/** Start mirroring after the first sync, when account data is already loaded. */
export function startPrefsSync(c: MatrixClient): void {
  stopPrefsSync();
  client = c;
  const me = c.getUserId() ?? "";
  const remote = (c.getAccountData(TYPE as never)?.getContent() ?? {}) as Partial<Synced>;

  // the first sign-in of this account in this install takes everything from the account
  let fresh = true;
  try {
    fresh = localStorage.getItem(SYNCED_KEY) !== me;
    localStorage.setItem(SYNCED_KEY, me);
  } catch {
    // storage unavailable
  }
  if (Object.keys(remote).length) apply(remote, fresh);
  if (essence(collect("")) !== essence(remote)) schedule();

  const onData = (ev: MatrixEvent) => {
    if (ev.getType() !== TYPE) return;
    const content = ev.getContent() as Partial<Synced>;
    // own echo, or a local change is about to be written anyway
    if (content.origin === c.getDeviceId() || timer) return;
    apply(content, false);
  };
  c.on(ClientEvent.AccountData, onData);
  stops = [
    () => c.off(ClientEvent.AccountData, onData),
    voice.onPrefsChange(schedule),
    onThemeChange(schedule),
    onLangChange(schedule),
    notify.on(schedule),
    mutes.on(schedule),
    sound.on(schedule),
  ];
}

export function stopPrefsSync(): void {
  if (timer) {
    window.clearTimeout(timer);
    void push();
  }
  stops.forEach((s) => s());
  stops = [];
  client = null;
}
