import { t } from "./i18n/index.ts";

/**
 * Bridge to the Electron shell (electron/preload.cjs).
 *
 * Electron lists windows and screens itself, so the app draws its own source
 * picker with thumbnails, and share audio comes from the native helper: a
 * window shares only its own program, a screen shares everything except
 * this app. The tray, autostart and taskbar badges also go through here.
 *
 * Without the bridge (the page opened in a plain browser during development)
 * all of this is disabled and the browser shows its own share picker.
 */

export type ScreenSource = {
  id: string;
  name: string;
  thumbnail: string;
  kind: "screen" | "window";
  displayId?: string;
};

/** Tray menu captions in the interface language. */
export type TrayLabels = {
  open: string;
  mute: string;
  unmute: string;
  deafen: string;
  undeafen: string;
  quit: string;
  hintTitle: string;
  hintBody: string;
};

/** Tray and taskbar state. Images are ready PNG data URLs. */
export type TrayState = {
  icon16: string;
  icon32: string;
  overlay: string;
  tooltip: string;
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
  labels: TrayLabels;
};

/** Window behavior: tray, autostart, background color before the page loads. */
export type ShellSettings = {
  closeToTray: boolean;
  autostart: boolean;
  autostartAvailable: boolean;
  background?: string;
  /** Misspelled words are underlined in red. */
  spellcheck?: boolean;
};

/** Captions of the right click menu in text fields, drawn by the shell. */
export type MenuLabels = { cut: string; copy: string; paste: string; selectAll: string; addWord: string; noFixes: string };

/** A monitor in physical pixels with its refresh rate. */
export type DisplayInfo = { id: string; width: number; height: number; hz: number; primary: boolean };

/** The frameless window: the page draws the title bar and its buttons. */
export type WindowState = { frame: boolean; maximized: boolean; fullscreen: boolean; focused: boolean };

export type UpdateStatus = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";

/** Update check state from the main process (electron/updater.cjs). */
export type UpdateState = {
  enabled: boolean;
  current: string;
  status: UpdateStatus;
  version: string;
  notes: string;
  page: string;
  progress: number;
  error: string;
  portable: boolean;
  canInstall: boolean;
};

/* Moonlight: the native helper talks to a Sunshine host (see electron/main.cjs). */
export type MlAnswer<T> = { ok: boolean; data?: T; error?: string };
export type MlHostInfo = { paired: boolean; appVersion: string; hostname: string; codecs: number; busy: boolean };
export type MlStreamOptions = {
  host: string;
  app: number;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  formats: number;
  /** The streamer keeps hearing the own sound (default). */
  hostAudio?: boolean;
  /** Video packet size: smaller through the tunnel, which adds its own header to each. */
  packet?: number;
};

/** The viewer's end of the stream tunnel: this side's key and candidates. */
export type TunReady = { ok: boolean; error?: string; key?: string; nat?: string; cands?: string[] };
/** What the viewer's tunnel reports: a working path (with the local address Sunshine answers on), a failure, the end. */
export type TunEvent = { ev: "up"; local: string; path: string; rtt: number } | { ev: "fail"; reason: string; text?: string } | { ev: "down"; reason: string };

/** A step of a stream through Sunshine, for the stream log in the profile folder (electron/streamlog.cjs). */
export function streamLog(text: string): void {
  void bridge?.streamLog?.(text).catch(() => undefined);
}

/** The folder with the stream log, in the file manager. */
export function openLogs(): void {
  void bridge?.openLogs?.().catch(() => undefined);
}

/**
 * The Moonlight part of the shell, or null in a plain browser. Every watch has
 * an id: several streams can be watched at once, each with its own tunnel and
 * stream, and events say which watch they belong to.
 */
export function moonlightBridge() {
  const b = bridge;
  if (!b?.mlStart || !b.mlInfo || !b.mlPair || !b.mlStop || !b.mlIdr || !b.onMlEvent || !b.onMlFrame || !b.tunStart) return null;
  return {
    info: b.mlInfo,
    pair: b.mlPair,
    forget: b.mlForget ?? (async () => ({ ok: false })),
    reset: b.mlReset ?? (async () => ({ ok: false })),
    cancel: b.mlCancel ?? (async () => undefined),
    start: b.mlStart,
    stop: b.mlStop,
    idr: b.mlIdr,
    onEvent: b.onMlEvent,
    onFrame: b.onMlFrame,
    tunStart: b.tunStart,
    tunPeer: b.tunPeer ?? (async () => ({ ok: false })),
    onTunEvent: b.onTunEvent ?? (() => () => undefined),
    onTunPcm: b.onTunPcm ?? (() => () => undefined),
  };
}

/* Sunshine bundled with the app: own streams, sent to viewers through the tunnel (electron/sunshine.cjs). */

export type SunStatus = {
  installed: boolean;
  version: string;
  size: number;
  /** 0..1 while the component downloads, null otherwise. */
  installing: number | null;
  running: boolean;
  ready: boolean;
  starting: boolean;
  error: string;
  port: number;
  uid: string;
  /** The streamer's end of the tunnel while Sunshine runs: its NAT and candidates. */
  tunnel: { nat: string; cands: string[] } | null;
};

export type SunStartSettings = {
  output: string;
  /** The computer's sound, without the app's own, goes to viewers. */
  audio: boolean;
  encoder: "" | "nvenc" | "amdvce" | "quicksync" | "software";
  maxKbps: number;
  /** How many viewers at once: each has a session and an encoder of its own. */
  viewers: number;
  /** The tunnel's UDP port, fixed for a port forwarded by hand; 0 picks any. */
  udpPort: number;
  upnp: boolean;
  /** The outside address (an IP or a DynDNS name) of a port forwarded by hand. */
  address: string;
};

export type SunStarted = {
  ok: boolean;
  error?: string;
  port?: number;
  uid?: string;
  nat?: string;
  cands?: string[];
  encoder?: string;
};

export type SunPairing = { id: string; name: string; address: string };
export type SunClient = { uuid: string; name: string };
export type SunDisplay = { id: string; name: string; w: number; h: number; hz: number; primary: boolean };

export type SunEvent =
  | { type: "state"; state: SunStatus }
  | { type: "install"; progress: number }
  | { type: "pairings"; list: SunPairing[] }
  | { type: "stopped" }
  | { type: "tunnel"; ev: "up" | "down" | "gone" | "audio-error"; id?: string; path?: string; reason?: string };

/** The NAT this computer is behind and whether the router opens ports: see electron/netcheck.cjs. */
export type NetCheck = { nat: "open" | "cone" | "symmetric" | "blocked" | "unknown"; ip: string; upnp: boolean; v6: boolean; lan: string[] };

export function sunshineBridge() {
  const b = bridge;
  if (!b?.sunStatus || !b.sunStart || !b.sunStop || !b.onSunEvent || !b.netCheck) return null;
  return {
    status: b.sunStatus,
    install: b.sunInstall ?? (async () => ({ ok: false, error: "no-shell" })),
    start: b.sunStart,
    stop: b.sunStop,
    devices: b.sunDevices ?? (async () => ({ displays: [] })),
    approve: b.sunApprove ?? (async () => ({ ok: false })),
    deny: b.sunDeny ?? (async () => ({ ok: false })),
    clients: b.sunClients ?? (async () => null),
    unpair: b.sunUnpair ?? (async () => ({ ok: false })),
    onEvent: b.onSunEvent,
    netCheck: b.netCheck,
    peer: b.sunPeer ?? (async () => ({ ok: false, error: "no-shell" })),
    drop: b.sunDrop ?? (async () => undefined),
    prewarm: b.sunPrewarm ?? (async () => undefined),
  };
}

/** A link preview from the shell: the page's tags and its picture as bytes. */
export type RawPreview = {
  url: string;
  site: string;
  title: string;
  description: string;
  color: string;
  youtube: string;
  image: { data: Uint8Array; mime: string } | null;
};

type Bridge = {
  getScreenSources: () => Promise<ScreenSource[]>;
  setScreenSource: (id: string, loopback: boolean) => Promise<void>;
  getDisplays?: () => Promise<DisplayInfo[]>;
  idleSeconds?: () => Promise<number>;
  getShellSettings?: () => Promise<ShellSettings>;
  setShellSettings?: (patch: Partial<ShellSettings>) => Promise<ShellSettings>;
  setTrayState?: (state: TrayState) => Promise<void>;
  showWindow?: () => Promise<void>;
  flashWindow?: () => Promise<void>;
  startScreenAudio?: (sourceId: string) => Promise<{ ok: boolean; error?: string }>;
  stopScreenAudio?: () => Promise<void>;
  onScreenAudio?: (cb: (chunk: ArrayBuffer) => void) => () => void;
  onScreenAudioEnd?: (cb: (reason: string) => void) => () => void;
  copyText?: (text: string) => Promise<void>;
  copyImage?: (png: Uint8Array) => Promise<void>;
  sealSecret?: (text: string) => Promise<string | null>;
  openSecret?: (sealed: string) => Promise<string | null>;
  linkPreview?: (url: string) => Promise<RawPreview | null>;
  mlInfo?: (host: string) => Promise<MlAnswer<MlHostInfo>>;
  mlPair?: (host: string, pin: string, name: string, wid: string) => Promise<MlAnswer<{ paired: boolean }>>;
  mlForget?: (host: string) => Promise<MlAnswer<unknown>>;
  mlReset?: () => Promise<MlAnswer<unknown>>;
  mlCancel?: (wid: string) => Promise<void>;
  sunStatus?: () => Promise<SunStatus>;
  sunInstall?: () => Promise<{ ok: boolean; error?: string }>;
  sunStart?: (settings: SunStartSettings) => Promise<SunStarted>;
  sunStop?: () => Promise<void>;
  sunDevices?: () => Promise<{ displays: SunDisplay[] }>;
  sunPeer?: (
    id: string,
    key: string,
    nat: string,
    cands: string[],
  ) => Promise<{ ok: boolean; error?: string; sid?: number; key?: string; nat?: string; cands?: string[] }>;
  sunDrop?: (id: string) => Promise<void>;
  sunPrewarm?: (settings: SunStartSettings) => Promise<void>;
  streamLog?: (text: string) => Promise<void>;
  openLogs?: () => Promise<string>;
  tunStart?: (wid: string, base: number) => Promise<TunReady>;
  tunPeer?: (wid: string, sid: number, key: string, nat: string, cands: string[]) => Promise<{ ok: boolean }>;
  onTunEvent?: (cb: (wid: string, json: string) => void) => () => void;
  onTunPcm?: (cb: (wid: string, frame: ArrayBuffer) => void) => () => void;
  sunApprove?: (id: string, pin: string, name: string) => Promise<{ ok: boolean }>;
  sunDeny?: (id: string) => Promise<{ ok: boolean }>;
  sunClients?: () => Promise<SunClient[] | null>;
  sunUnpair?: (uuid: string) => Promise<{ ok: boolean }>;
  onSunEvent?: (cb: (event: SunEvent) => void) => () => void;
  netCheck?: () => Promise<NetCheck>;
  mlStart?: (wid: string, opts: MlStreamOptions) => Promise<{ ok: boolean; error?: string }>;
  mlStop?: (wid: string) => Promise<void>;
  mlIdr?: (wid: string) => Promise<void>;
  onMlEvent?: (cb: (wid: string, json: string) => void) => () => void;
  onMlFrame?: (cb: (wid: string, frame: ArrayBuffer) => void) => () => void;
  windowAction?: (action: "minimize" | "maximize" | "close" | "state") => Promise<WindowState | null>;
  onWindowState?: (cb: (s: WindowState) => void) => () => void;
  getUpdate?: () => Promise<UpdateState>;
  checkUpdate?: () => Promise<UpdateState>;
  startUpdate?: () => Promise<UpdateState>;
  installUpdate?: () => Promise<void>;
  openUpdatePage?: () => Promise<void>;
  onUpdate?: (cb: (s: UpdateState) => void) => () => void;
  onBeforeQuit?: (cb: () => Promise<void>) => () => void;
  setMenuLabels?: (labels: MenuLabels) => Promise<void>;
};

const bridge = (globalThis as unknown as { desktop?: Bridge }).desktop ?? null;

export const hasOwnScreenPicker = !!bridge;

/** The shell can capture audio per program: a window alone, a screen without this app. */
export const hasAppAudio = !!bridge?.startScreenAudio;

export function getScreenSources(): Promise<ScreenSource[]> {
  return bridge ? bridge.getScreenSources() : Promise.resolve([]);
}

/**
 * Remember the picked source for the next getDisplayMedia. `loopback` asks
 * the engine for system audio with the picture; it is used only without the
 * native helper.
 */
export function setScreenSource(id: string, loopback: boolean): Promise<void> {
  return bridge ? bridge.setScreenSource(id, loopback) : Promise.resolve();
}

function helperError(code: string): string {
  if (code === "no-helper") return t("desktop.err.noHelper");
  const exit = /^exit (\d+)$/.exec(code);
  return exit ? t("desktop.err.helperExit", { code: exit[1] }) : code;
}

export async function startScreenAudio(
  sourceId: string,
  onChunk: (chunk: ArrayBuffer) => void,
  onEnd: (reason: string) => void,
): Promise<(() => Promise<void>) | null> {
  if (!bridge?.startScreenAudio || !bridge.onScreenAudio || !bridge.stopScreenAudio) return null;
  const offData = bridge.onScreenAudio(onChunk);
  const offEnd = bridge.onScreenAudioEnd?.((reason) => onEnd(reason && helperError(reason))) ?? (() => undefined);
  const res = await bridge.startScreenAudio(sourceId);
  if (!res.ok) {
    offData();
    offEnd();
    throw new Error(helperError(res.error || "no-helper"));
  }
  return async () => {
    offData();
    offEnd();
    await bridge.stopScreenAudio?.();
  };
}

/** Refresh rate of the monitor under the window, measured from animation frames. */
function measureHz(): Promise<number> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const step = (ts: number) => {
      stamps.push(ts);
      if (stamps.length < 40) {
        requestAnimationFrame(step);
        return;
      }
      const gaps = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)] || 16.7;
      resolve(Math.round(1000 / median));
    };
    requestAnimationFrame(step);
    // a minimized window gets no frames
    window.setTimeout(() => resolve(60), 1500);
  });
}

/** Monitors: exact in Electron, otherwise the one the window is on. */
export async function getDisplays(): Promise<DisplayInfo[]> {
  if (bridge?.getDisplays) {
    try {
      const list = await bridge.getDisplays();
      if (list.length) return list;
    } catch {
      // older shell without this call
    }
  }
  const dpr = window.devicePixelRatio || 1;
  return [
    {
      id: "",
      width: Math.round(window.screen.width * dpr),
      height: Math.round(window.screen.height * dpr),
      hz: await measureHz(),
      primary: true,
    },
  ];
}

/** Seconds without input: system-wide in Electron, this window elsewhere. */
let lastInput = Date.now();
if (typeof window !== "undefined") {
  const touch = () => {
    lastInput = Date.now();
  };
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  }
}

export async function idleSeconds(): Promise<number> {
  if (bridge?.idleSeconds) {
    try {
      return await bridge.idleSeconds();
    } catch {
      // fall back to this window
    }
  }
  return Math.round((Date.now() - lastInput) / 1000);
}

/* ---------------------------------------------------------- tray and window */

export const hasShell = !!bridge?.getShellSettings;

export function getShellSettings(): Promise<ShellSettings | null> {
  return bridge?.getShellSettings ? bridge.getShellSettings().catch(() => null) : Promise.resolve(null);
}

export function setShellSettings(patch: Partial<ShellSettings>): Promise<ShellSettings | null> {
  return bridge?.setShellSettings ? bridge.setShellSettings(patch).catch(() => null) : Promise.resolve(null);
}

export function setMenuLabels(labels: MenuLabels): void {
  void bridge?.setMenuLabels?.(labels).catch(() => undefined);
}

export function pushTrayState(state: TrayState): void {
  void bridge?.setTrayState?.(state).catch(() => undefined);
}

/** Bring the window back from the tray, for example on a notification click. */
export function showWindow(): void {
  if (bridge?.showWindow) void bridge.showWindow().catch(() => undefined);
  else window.focus();
}

/** Flash the taskbar button while the window is not focused. */
export function flashWindow(): void {
  void bridge?.flashWindow?.().catch(() => undefined);
}

/** Copy text. The shell writes the system clipboard directly; a page uses the async clipboard API. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (bridge?.copyText) await bridge.copyText(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a picture. Any format is turned into PNG first: the system clipboard
 * of Windows takes a bitmap, and PNG is what both the shell and the browser
 * clipboard accept. An animation keeps its first frame.
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
    const png = await canvas.convertToBlob({ type: "image/png" });
    if (bridge?.copyImage) await bridge.copyImage(new Uint8Array(await png.arrayBuffer()));
    else await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/** Whether secrets can be sealed by the operating system here: only in the desktop shell. */
export const canSeal = !!bridge?.sealSecret;

/** Seal a secret with the system's per-user encryption; null when the shell cannot. */
export async function sealSecret(text: string): Promise<string | null> {
  try {
    return (await bridge?.sealSecret?.(text)) ?? null;
  } catch {
    return null;
  }
}

/** Open a sealed secret; null if it cannot be opened (another user, another computer). */
export async function openSecret(sealed: string): Promise<string | null> {
  try {
    return (await bridge?.openSecret?.(sealed)) ?? null;
  } catch {
    return null;
  }
}

/** Preview of a link, fetched by the shell. A plain browser has no way around CORS and gets none. */
export async function fetchLinkPreview(url: string): Promise<RawPreview | null> {
  try {
    return (await bridge?.linkPreview?.(url)) ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- window frame */

export const hasOwnFrame = !!bridge?.windowAction;

export function windowAction(action: "minimize" | "maximize" | "close"): void {
  void bridge?.windowAction?.(action).catch(() => null);
}

export function getWindowState(): Promise<WindowState | null> {
  return bridge?.windowAction ? bridge.windowAction("state").catch(() => null) : Promise.resolve(null);
}

export function onWindowState(cb: (s: WindowState) => void): () => void {
  return bridge?.onWindowState?.(cb) ?? (() => undefined);
}

/* ------------------------------------------------------------------ updates */

export const hasUpdater = !!bridge?.getUpdate;

export function getUpdate(): Promise<UpdateState | null> {
  return bridge?.getUpdate ? bridge.getUpdate().catch(() => null) : Promise.resolve(null);
}

export function checkUpdate(): Promise<UpdateState | null> {
  return bridge?.checkUpdate ? bridge.checkUpdate().catch(() => null) : Promise.resolve(null);
}

export function startUpdate(): Promise<UpdateState | null> {
  return bridge?.startUpdate ? bridge.startUpdate().catch(() => null) : Promise.resolve(null);
}

export function installUpdateNow(): void {
  void bridge?.installUpdate?.().catch(() => undefined);
}

export function openUpdatePage(): void {
  void bridge?.openUpdatePage?.().catch(() => undefined);
}

export function onUpdate(cb: (s: UpdateState) => void): () => void {
  return bridge?.onUpdate?.(cb) ?? (() => undefined);
}

/** Run `cb` when the app really quits (not when it hides into the tray). */
export function onBeforeQuit(cb: () => Promise<void>): void {
  bridge?.onBeforeQuit?.(cb);
}
