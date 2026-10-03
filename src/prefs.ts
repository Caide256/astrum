import { useSyncExternalStore } from "react";
import { ClientEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";

import { BRAND } from "./brand.ts";
import { isMxc } from "./mxc.ts";
import { LANGS, getLang, onLangChange, setLang, type Lang } from "./i18n/index.ts";
import {
  THEMES,
  getCustomTheme,
  getTheme,
  importCustomTheme,
  importOwnThemes,
  isOwnTheme,
  listOwnThemes,
  onThemeChange,
  setTheme,
  type ThemeDef,
} from "./theme.ts";
import { setBlipVolumes } from "./voice/audio.ts";
import { cleanEmoji, cleanTile as cleanVoiceTile, voice, type TileLook, type VoicePrefs } from "./voice/voice.ts";

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

/**
 * Smaller notification choices. `voiceChats`: plain messages in the chats of
 * voice channels make a sound and a popup too; off by default, those chats
 * are mostly talk next to the call. Mentions there notify either way.
 */
export type NotifyPrefs = { voiceChats: boolean };

const NOTIFY_PREFS_KEY = "app.notify-prefs";

function cleanNotifyPrefs(raw: Partial<NotifyPrefs> | null | undefined): NotifyPrefs {
  return { voiceChats: raw?.voiceChats === true };
}

const notifyPrefs = cell<NotifyPrefs>(cleanNotifyPrefs(loadJson<Partial<NotifyPrefs>>(NOTIFY_PREFS_KEY, { voiceChats: false })));

export function getNotifyPrefs(): NotifyPrefs {
  return notifyPrefs.get();
}

export const useNotifyPrefs = notifyPrefs.use;

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  const next = cleanNotifyPrefs({ ...notifyPrefs.get(), ...patch });
  saveJson(NOTIFY_PREFS_KEY, next);
  notifyPrefs.set(next);
}

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

/** Volumes in percent: interface sounds (calls, mute), message notifications and the soundboard. */
export type SoundPrefs = { ui: number; notify: number; notifyOn: boolean; board: number };

const SOUND_KEY = "app.sound-prefs";
const SOUND_DEFAULTS: SoundPrefs = { ui: 70, notify: 60, notifyOn: true, board: 60 };

function cleanSound(raw: Partial<SoundPrefs> | null | undefined): SoundPrefs {
  const pct = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : d);
  return {
    ui: pct(raw?.ui, SOUND_DEFAULTS.ui),
    notify: pct(raw?.notify, SOUND_DEFAULTS.notify),
    notifyOn: typeof raw?.notifyOn === "boolean" ? raw.notifyOn : SOUND_DEFAULTS.notifyOn,
    board: pct(raw?.board, SOUND_DEFAULTS.board),
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

/* -------------------------------------------------------- server profiles */

/**
 * A name and a picture for one server only, like a server nickname in
 * Discord. Matrix allows a different name per room: it is written into the
 * own membership in the server's rooms. The list is kept with the account so
 * it can be written again after the global profile changes, which resets
 * every room.
 */
export type ServerProfile = { name: string; avatar: string };
export type ServerProfiles = Record<string, ServerProfile>;

const SERVER_PROFILES_KEY = "app.server-profiles";

function cleanServerProfiles(raw: unknown): ServerProfiles {
  const out: ServerProfiles = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [space, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<ServerProfile> | null;
    if (!space.startsWith("!") || !p) continue;
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 64) : "";
    const avatar = isMxc(p.avatar) ? p.avatar : "";
    if (name || avatar) out[space] = { name, avatar };
  }
  return out;
}

const serverProfiles = cell<ServerProfiles>(cleanServerProfiles(loadJson<ServerProfiles>(SERVER_PROFILES_KEY, {})));

export function getServerProfiles(): ServerProfiles {
  return serverProfiles.get();
}

export const useServerProfiles = serverProfiles.use;

export const onServerProfilesChange = (cb: () => void) => serverProfiles.on(cb);

/** The own name and picture on one server, or null to use the global profile there. */
export function setServerProfilePref(spaceId: string, profile: ServerProfile | null): void {
  const next = { ...serverProfiles.get() };
  if (profile && (profile.name.trim() || profile.avatar)) next[spaceId] = { name: profile.name.trim(), avatar: profile.avatar };
  else delete next[spaceId];
  saveJson(SERVER_PROFILES_KEY, next);
  serverProfiles.set(next);
}

/* ---------------------------------------------------------------- privacy */

/**
 * `hideIds`: user ids, homeserver domains and addresses are not shown, for
 * screenshots. `streamer`: the same plus no notifications and no sounds for
 * messages, for streaming the screen. Both stay on this computer.
 */
export type Privacy = { hideIds: boolean; streamer: boolean };

const PRIVACY_KEY = "app.privacy";
const PRIVACY_DEFAULT: Privacy = { hideIds: false, streamer: false };

function cleanPrivacy(raw: Partial<Privacy> | null | undefined): Privacy {
  return { hideIds: raw?.hideIds === true, streamer: raw?.streamer === true };
}

const privacy = cell<Privacy>(cleanPrivacy(loadJson<Partial<Privacy>>(PRIVACY_KEY, PRIVACY_DEFAULT)));

function applyPrivacy(p: Privacy): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("streamer", p.streamer);
  // anything marked "sensitive" (ids, domains, addresses) is hidden by the stylesheet
  document.documentElement.classList.toggle("hide-ids", p.hideIds || p.streamer);
}
applyPrivacy(privacy.get());

export function getPrivacy(): Privacy {
  return privacy.get();
}

export const usePrivacy = privacy.use;

export function setPrivacy(patch: Partial<Privacy>): void {
  const next = cleanPrivacy({ ...privacy.get(), ...patch });
  saveJson(PRIVACY_KEY, next);
  privacy.set(next);
  applyPrivacy(next);
}

/** Ids and domains are hidden right now: by the setting or by the streamer mode. */
export function idsHidden(): boolean {
  const p = privacy.get();
  return p.hideIds || p.streamer;
}

/** A hook form of idsHidden: the component redraws when it changes. */
export function useIdsHidden(): boolean {
  const p = privacy.use();
  return p.hideIds || p.streamer;
}

/* ----------------------------------------------------------- stream player */

/**
 * The small player of a watched share while another chat is open: whether it
 * shows at all, and whether it snaps to the nearest corner when let go.
 */
export type PlayerPrefs = { mini: boolean; magnet: boolean };

const PLAYER_KEY = "app.player";
const PLAYER_DEFAULT: PlayerPrefs = { mini: true, magnet: true };

function cleanPlayer(raw: Partial<PlayerPrefs> | null | undefined): PlayerPrefs {
  return { mini: raw?.mini !== false, magnet: raw?.magnet !== false };
}

const player = cell<PlayerPrefs>(cleanPlayer(loadJson<Partial<PlayerPrefs>>(PLAYER_KEY, PLAYER_DEFAULT)));

export const usePlayerPrefs = player.use;

export function setPlayerPrefs(patch: Partial<PlayerPrefs>): void {
  const next = cleanPlayer({ ...player.get(), ...patch });
  saveJson(PLAYER_KEY, next);
  player.set(next);
}

/* ------------------------------------------------------------------- sync */

/* -------------------------------------------------------------- call tile */

const TILE_KEY = "app.tile";
const TILE_DEFAULT: TileLook = { mode: "dominant", color: "#5865f2" };

function cleanTile(raw: Partial<TileLook> | null | undefined): TileLook {
  const color = typeof raw?.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : TILE_DEFAULT.color;
  // a picture mode without a picture falls back to the avatar color
  const valid = cleanVoiceTile({ ...raw, color });
  return valid ?? { mode: TILE_DEFAULT.mode, color, ...(cleanEmoji(raw?.emoji) ? { emoji: cleanEmoji(raw?.emoji) } : {}) };
}

export function getTileLook(): TileLook {
  return tile.get();
}

export const onTileLookChange = (cb: () => void) => tile.on(cb);

const tile = cell<TileLook>(cleanTile(loadJson<Partial<TileLook>>(TILE_KEY, TILE_DEFAULT)));
// others see the tile background from the first call on
voice.setTile(tile.get());

export function useTileLook(): TileLook {
  return tile.use();
}

export function setTileLook(patch: Partial<TileLook>): void {
  const next = cleanTile({ ...tile.get(), ...patch });
  saveJson(TILE_KEY, next);
  tile.set(next);
  voice.setTile(next);
}

/* ------------------------------------------------------------- view prefs */

/** `bannerImages`: other people's banner pictures are shown; off, their banners use the avatar color. */
export type ViewPrefs = { bannerImages: boolean };

const VIEW_KEY = "app.view";

function cleanView(raw: Partial<ViewPrefs> | null | undefined): ViewPrefs {
  return { bannerImages: raw?.bannerImages !== false };
}

const view = cell<ViewPrefs>(cleanView(loadJson<Partial<ViewPrefs>>(VIEW_KEY, { bannerImages: true })));

export function getViewPrefs(): ViewPrefs {
  return view.get();
}

export const useViewPrefs = view.use;

export function setViewPrefs(patch: Partial<ViewPrefs>): void {
  const next = cleanView({ ...view.get(), ...patch });
  saveJson(VIEW_KEY, next);
  view.set(next);
}

/* --------------------------------------------------------------- ui scale */

/**
 * The size of the whole interface in percent, like the zoom of a browser.
 * It depends on the monitor, so it stays on this computer.
 */
export const UI_SCALES = [75, 80, 90, 100, 110, 125, 150];
const SCALE_KEY = "app.ui-scale";

function cleanScale(raw: unknown): number {
  const n = Math.round(Number(raw));
  return UI_SCALES.includes(n) ? n : 100;
}

const scale = cell<number>(cleanScale(typeof localStorage !== "undefined" ? localStorage.getItem(SCALE_KEY) : 100));

function applyScale(n: number): void {
  const bridge = (globalThis as unknown as { desktop?: { setZoom?: (f: number) => void } }).desktop;
  if (bridge?.setZoom) bridge.setZoom(n / 100);
  else if (typeof document !== "undefined") (document.documentElement.style as unknown as { zoom: string }).zoom = n === 100 ? "" : String(n / 100);
}
applyScale(scale.get());

export const useUiScale = scale.use;

export function setUiScale(n: number): void {
  const next = cleanScale(n);
  try {
    localStorage.setItem(SCALE_KEY, String(next));
  } catch {
    // kept until restart
  }
  scale.set(next);
  applyScale(next);
}

/* ------------------------------------------------------------ chat look */

/**
 * How messages are laid out, apart from the theme: where messages stand
 * (all on the left, own on the right, all on the right), how dense the
 * timeline is and the text size.
 */
export type ChatLook = { align: "left" | "own-right" | "right"; density: "cozy" | "compact"; size: number };

const LOOK_KEY = "app.chat-look";
const LOOK_DEFAULT: ChatLook = { align: "left", density: "cozy", size: 14 };

function cleanLook(raw: Partial<ChatLook> | null | undefined): ChatLook {
  const align = raw?.align === "own-right" || raw?.align === "right" ? raw.align : "left";
  const density = raw?.density === "compact" ? "compact" : "cozy";
  const size = Math.max(12, Math.min(20, Math.round(Number(raw?.size ?? 14)) || 14));
  return { align, density, size };
}

const look = cell<ChatLook>(cleanLook(loadJson<Partial<ChatLook>>(LOOK_KEY, LOOK_DEFAULT)));

function applyLook(l: ChatLook): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.msgAlign = l.align;
  root.dataset.msgDensity = l.density;
  root.style.setProperty("--msg-size", `${l.size}px`);
}
applyLook(look.get());

export function useChatLook(): ChatLook {
  return look.use();
}

export function setChatLook(patch: Partial<ChatLook>): void {
  const next = cleanLook({ ...look.get(), ...patch });
  saveJson(LOOK_KEY, next);
  look.set(next);
  applyLook(next);
}

/* -------------------------------------------------------- own channel order */

/**
 * Everyone may arrange a server's channels for themselves by dragging them.
 * Only the own copy changes; the order the server set stays for the others
 * and comes back with "reset".
 */
export type ChannelOrders = Record<string, string[]>;

const ORDER_KEY = "app.channel-order";

function cleanOrders(raw: unknown): ChannelOrders {
  const out: ChannelOrders = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [space, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!space.startsWith("!") || !Array.isArray(list)) continue;
    const ids = list.filter((x): x is string => typeof x === "string" && x.startsWith("!")).slice(0, 300);
    if (ids.length) out[space] = ids;
  }
  return out;
}

const orders = cell<ChannelOrders>(cleanOrders(loadJson<ChannelOrders>(ORDER_KEY, {})));

export function useChannelOrders(): ChannelOrders {
  return orders.use();
}

export function hasOwnOrder(spaceId: string): boolean {
  return !!orders.get()[spaceId];
}

/** The own order of a server's channels, or null to go back to the server's. */
export function setChannelOrder(spaceId: string, ids: string[] | null): void {
  const next = { ...orders.get() };
  if (ids && ids.length) next[spaceId] = ids;
  else delete next[spaceId];
  saveJson(ORDER_KEY, next);
  orders.set(next);
}

const TYPE = `${BRAND.appId}.prefs`;
const SYNCED_KEY = "app.prefs-synced";
const PUSH_DELAY_MS = 3000;

type Synced = VoicePrefs & {
  v: 1;
  theme: string;
  /** Older versions read this one; newer ones use the list. */
  customTheme: ThemeDef;
  customThemes: ThemeDef[];
  lang: Lang;
  notify: NotifyMode;
  mutes: Mutes;
  sound: SoundPrefs;
  tile: TileLook;
  look: ChatLook;
  order: ChannelOrders;
  serverProfiles: ServerProfiles;
  notifyMore: NotifyPrefs;
  view: ViewPrefs;
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
    customThemes: listOwnThemes(),
    lang: getLang(),
    notify: notify.get(),
    mutes: mutes.get(),
    sound: sound.get(),
    tile: tile.get(),
    look: look.get(),
    order: orders.get(),
    serverProfiles: serverProfiles.get(),
    notifyMore: notifyPrefs.get(),
    view: view.get(),
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
    p.customThemes ?? p.customTheme ?? null,
    p.lang,
    p.notify,
    p.mutes ?? null,
    p.sound ?? null,
    p.tile ?? null,
    p.look ?? null,
    p.order ?? null,
    p.serverProfiles ?? null,
    p.notifyMore ?? null,
    p.view ?? null,
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
    if (Array.isArray(remote.customThemes)) importOwnThemes(remote.customThemes);
    else if (remote.customTheme && typeof remote.customTheme === "object") importCustomTheme(remote.customTheme);
    if (remote.order && typeof remote.order === "object") {
      const next = cleanOrders(remote.order);
      saveJson(ORDER_KEY, next);
      orders.set(next);
    }
    if (remote.serverProfiles && typeof remote.serverProfiles === "object") {
      const next = cleanServerProfiles(remote.serverProfiles);
      saveJson(SERVER_PROFILES_KEY, next);
      serverProfiles.set(next);
    }
    if (remote.look && typeof remote.look === "object") {
      const next = cleanLook(remote.look);
      saveJson(LOOK_KEY, next);
      look.set(next);
      applyLook(next);
    }
    if (remote.view && typeof remote.view === "object") {
      const next = cleanView(remote.view);
      saveJson(VIEW_KEY, next);
      view.set(next);
    }
    if (remote.notifyMore && typeof remote.notifyMore === "object") {
      const next = cleanNotifyPrefs(remote.notifyMore);
      saveJson(NOTIFY_PREFS_KEY, next);
      notifyPrefs.set(next);
    }
    if (remote.tile && typeof remote.tile === "object") {
      const next = cleanTile(remote.tile);
      saveJson(TILE_KEY, next);
      tile.set(next);
      voice.setTile(next);
    }
    if (!all) return;
    if (remote.theme && (isOwnTheme(remote.theme) || THEMES.some((th) => th.id === remote.theme))) setTheme(remote.theme);
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
    tile.on(schedule),
    look.on(schedule),
    orders.on(schedule),
    serverProfiles.on(schedule),
    notifyPrefs.on(schedule),
    view.on(schedule),
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
