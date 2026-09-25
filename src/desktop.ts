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
};

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
  windowAction?: (action: "minimize" | "maximize" | "close" | "state") => Promise<WindowState | null>;
  onWindowState?: (cb: (s: WindowState) => void) => () => void;
  getUpdate?: () => Promise<UpdateState>;
  checkUpdate?: () => Promise<UpdateState>;
  startUpdate?: () => Promise<UpdateState>;
  installUpdate?: () => Promise<void>;
  openUpdatePage?: () => Promise<void>;
  onUpdate?: (cb: (s: UpdateState) => void) => () => void;
  onBeforeQuit?: (cb: () => Promise<void>) => () => void;
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
