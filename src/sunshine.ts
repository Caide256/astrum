import {
  sunshineBridge,
  type NetCheck,
  type SunAudioDevice,
  type SunClient,
  type SunDisplay,
  type SunPairing,
  type SunStartSettings,
  type SunStatus,
} from "./desktop.ts";
import { createStore } from "./store.ts";
import { blip } from "./voice/audio.ts";
import { voice, type SunPacket } from "./voice/voice.ts";

/**
 * The own screen through the Sunshine bundled with the app (see
 * electron/sunshine.cjs). It needs a public ("white") IP: viewers connect
 * straight to this computer, the call server is not in between, so the
 * picture can be as good as the link and the graphics card allow.
 *
 * Starting a stream starts Sunshine (downloading it once first), announces it
 * in the call and shows it like any share, with a yellow dot. A viewer who
 * presses "watch" for the first time sends a pairing request; it shows up
 * here with their name, and only "allow" lets them in. Pairing requests that
 * come from anywhere else are turned away.
 */

export type SunSettings = SunStartSettings & {
  /** The router says nothing, but the user knows the IP is public and the ports are forwarded. */
  manualWhite: boolean;
  /** Address for viewers, typed by the user: an IP or a host name (a DynDNS name). Empty: found by itself. */
  address: string;
};

/** A viewer who asked to be let in: their request in Sunshine and their packet in the call. */
export type SunRequest = { id: string; identity: string; userId: string; pin: string; name: string; at: number };

export type SunState = {
  status: SunStatus | null;
  net: NetCheck | null;
  checking: boolean;
  settings: SunSettings;
  requests: SunRequest[];
  clients: SunClient[] | null;
  devices: { audio: SunAudioDevice[]; displays: SunDisplay[] } | null;
  /** The own stream is announced in the call. */
  live: boolean;
  /** Starting: downloading, starting Sunshine, waiting for it. */
  busy: "" | "install" | "start" | "stop";
  error: string;
  /** A viewer could not reach this Sunshine: the user of that viewer. */
  unreachable: string;
};

const KEY = "app.sunshine";
const DEFAULTS: SunSettings = {
  output: "",
  audioSink: "",
  audio: true,
  encoder: "",
  maxKbps: 0,
  port: 49989,
  upnp: true,
  manualWhite: false,
  address: "",
};

function load(): SunSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SunSettings> | null;
    const enc = raw?.encoder;
    return {
      output: typeof raw?.output === "string" ? raw.output : "",
      audioSink: typeof raw?.audioSink === "string" ? raw.audioSink : "",
      audio: raw?.audio !== false,
      encoder: enc === "nvenc" || enc === "amdvce" || enc === "quicksync" || enc === "software" ? enc : "",
      maxKbps: Math.max(0, Math.min(500_000, Number(raw?.maxKbps) || 0)),
      port: Number(raw?.port) >= 1100 && Number(raw?.port) <= 64000 ? Number(raw?.port) : DEFAULTS.port,
      upnp: raw?.upnp !== false,
      manualWhite: raw?.manualWhite === true,
      address: typeof raw?.address === "string" ? raw.address.trim().slice(0, 253) : "",
    };
  } catch {
    return DEFAULTS;
  }
}

export const sun = createStore<SunState>({
  status: null,
  net: null,
  checking: false,
  settings: load(),
  requests: [],
  clients: null,
  devices: null,
  live: false,
  busy: "",
  error: "",
  unreachable: "",
});

const bridge = sunshineBridge();
export const hasSunshine = !!bridge;

export function setSunSettings(patch: Partial<SunSettings>): void {
  const settings = { ...sun.get().settings, ...patch };
  sun.set({ settings });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // kept until restart
  }
}

/** Whether this computer may stream through Sunshine: a public IP, found or confirmed by hand. */
export function sunshineAllowed(s: SunState = sun.get()): boolean {
  return s.net?.verdict === "white" || (s.net?.verdict !== "gray" && s.settings.manualWhite);
}

/* ------------------------------------------------------------------ checks */

let checkedAt = 0;

/** Look at the network again: public address, router, local addresses. */
export async function checkNet(force = false): Promise<void> {
  if (!bridge || sun.get().checking) return;
  if (!force && sun.get().net && Date.now() - checkedAt < 10 * 60_000) return;
  sun.set({ checking: true });
  const net = await bridge.netCheck().catch(() => null);
  checkedAt = Date.now();
  sun.set({ net, checking: false });
}

export async function refreshStatus(): Promise<void> {
  if (!bridge) return;
  const status = await bridge.status().catch(() => null);
  sun.set({ status });
}

export async function loadDevices(): Promise<void> {
  if (!bridge) return;
  const devices = await bridge.devices().catch(() => null);
  sun.set({ devices });
}

export async function installSunshine(): Promise<boolean> {
  if (!bridge) return false;
  sun.set({ busy: "install", error: "" });
  const res = await bridge.install().catch((e) => ({ ok: false, error: String(e) }));
  sun.set({ busy: "", error: res.ok ? "" : res.error || "install" });
  await refreshStatus();
  return res.ok;
}

/* ----------------------------------------------------------------- stream */

/** The address viewers get: typed by the user (a name is looked up here), else the one found. */
async function publicAddress(): Promise<string> {
  const typed = sun.get().settings.address.trim();
  if (typed) {
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(typed)) return typed;
    const ip = await bridge?.resolvePublic(typed).catch(() => "");
    if (ip) return ip;
  }
  return sun.get().net?.ip ?? "";
}

/** The size and rate of the monitor that is streamed. */
function sourceOf(output: string): { w: number; h: number; fps: number } {
  const list = sun.get().devices?.displays ?? [];
  const d = list.find((x) => output && x.id === output) ?? list.find((x) => x.primary) ?? list[0];
  return d ? { w: d.w, h: d.h, fps: d.hz } : { w: 1920, h: 1080, fps: 60 };
}

/** Start streaming the screen through Sunshine in the current call. */
export async function startSunshineStream(): Promise<boolean> {
  if (!bridge || !voice.getState().connected) return false;
  sun.set({ error: "", unreachable: "" });
  await checkNet();
  if (!sunshineAllowed()) {
    sun.set({ error: "not-white" });
    return false;
  }
  await refreshStatus();
  if (!sun.get().status?.installed && !(await installSunshine())) return false;
  // one stream at a time: a share through the call server stops first
  if (voice.getState().screen) await voice.stopScreen();
  if (!sun.get().devices) await loadDevices();

  sun.set({ busy: "start" });
  const settings = sun.get().settings;
  const res = await bridge.start(settings).catch((e) => ({ ok: false, error: String(e), port: 0, uid: "" }));
  if (!res.ok) {
    sun.set({ busy: "", error: res.error || "start" });
    return false;
  }
  if (!voice.getState().connected) {
    // the call ended while Sunshine was starting
    await bridge.stop();
    sun.set({ busy: "" });
    return false;
  }
  const pub = await publicAddress();
  const lan = sun.get().net?.lan ?? [];
  const addrs = [...new Set([pub, ...lan].filter(Boolean))];
  const src = sourceOf(settings.output);
  voice.setSunshine({ addrs, port: res.port ?? settings.port, w: src.w, h: src.h, fps: src.fps, uid: res.uid ?? "" });
  sun.set({ busy: "", live: true, requests: [] });
  void refreshClients();
  return true;
}

export async function stopSunshineStream(): Promise<void> {
  if (!bridge) return;
  voice.setSunshine(null);
  sun.set({ busy: "stop", live: false, requests: [] });
  await bridge.stop().catch(() => undefined);
  sun.set({ busy: "" });
}

/* ---------------------------------------------------------------- pairing */

/** Pairing packets from viewers in the call, by the device name of their request. */
const asked = new Map<string, { identity: string; userId: string; pin: string; at: number }>();
/** Requests in Sunshine with no viewer behind them yet: since when, to turn them away later. */
const strangers = new Map<string, number>();
let pending: SunPairing[] = [];

const NAME_RE = /^astrum-[0-9a-f]{8,32}$/;
const ASK_TTL_MS = 120_000;
const STRANGER_MS = 15_000;

function matchRequests(): void {
  const now = Date.now();
  for (const [name, a] of asked) if (now - a.at > ASK_TTL_MS) asked.delete(name);
  const requests: SunRequest[] = [];
  for (const p of pending) {
    const a = asked.get(p.name);
    if (a) {
      strangers.delete(p.id);
      requests.push({ id: p.id, identity: a.identity, userId: a.userId, pin: a.pin, name: p.name, at: a.at });
      continue;
    }
    // a request nobody in the call made: from the internet, or a viewer that gave up long ago
    const since = strangers.get(p.id) ?? now;
    strangers.set(p.id, since);
    if (now - since > STRANGER_MS) {
      strangers.delete(p.id);
      void bridge?.deny(p.id);
    }
  }
  for (const id of strangers.keys()) if (!pending.some((p) => p.id === id)) strangers.delete(id);
  const before = sun.get().requests.map((r) => r.id).join(",");
  sun.set({ requests });
  if (requests.length && requests.map((r) => r.id).join(",") !== before) {
    blip("viewerJoin", voice.getState().settings.spkId);
  }
}

function onPacket(packet: SunPacket, from: string): void {
  if (!sun.get().live) return;
  const userId = from.split(":").slice(0, 2).join(":");
  if (packet.t === "sun-pair") {
    if (!NAME_RE.test(packet.name) || !/^\d{4}$/.test(packet.pin)) return;
    asked.set(packet.name, { identity: from, userId, pin: packet.pin, at: Date.now() });
    matchRequests();
  } else if (packet.t === "sun-fail") {
    sun.set({ unreachable: userId });
  }
}

voice.onSunPacket(onPacket);

/** Let the viewer in: Sunshine takes the PIN, the viewer's app finishes pairing and plays. */
export async function allowViewer(req: SunRequest, label: string): Promise<void> {
  if (!bridge) return;
  asked.delete(req.name);
  sun.set({ requests: sun.get().requests.filter((r) => r.id !== req.id) });
  const res = await bridge.approve(req.id, req.pin, label);
  voice.sendSun({ t: "sun-answer", name: req.name, ok: res.ok }, req.identity);
  void refreshClients();
}

export async function denyViewer(req: SunRequest): Promise<void> {
  if (!bridge) return;
  asked.delete(req.name);
  sun.set({ requests: sun.get().requests.filter((r) => r.id !== req.id) });
  voice.sendSun({ t: "sun-answer", name: req.name, ok: false }, req.identity);
  await bridge.deny(req.id);
}

/** Viewers that may watch without asking again. Known only while Sunshine runs. */
export async function refreshClients(): Promise<void> {
  if (!bridge) return;
  const clients = await bridge.clients().catch(() => null);
  sun.set({ clients });
}

export async function removeViewer(uuid: string): Promise<void> {
  if (!bridge) return;
  await bridge.unpair(uuid);
  await refreshClients();
}

/* ----------------------------------------------------------------- events */

if (bridge) {
  bridge.onEvent((ev) => {
    if (ev.type === "state") sun.set({ status: ev.state });
    else if (ev.type === "install") {
      const status = sun.get().status;
      if (status) sun.set({ status: { ...status, installing: ev.progress < 1 ? ev.progress : null } });
    } else if (ev.type === "pairings") {
      pending = ev.list;
      matchRequests();
    } else if (ev.type === "stopped" && sun.get().live) {
      // Sunshine went down on its own: the stream is over
      voice.setSunshine(null);
      sun.set({ live: false, requests: [], error: "stopped" });
    }
  });

  // the call ended: the stream ends with it
  let wasConnected = false;
  voice.subscribe(() => {
    const connected = voice.getState().connected;
    if (wasConnected && !connected && sun.get().live) void stopSunshineStream();
    wasConnected = connected;
  });

  // a stale request still waiting in Sunshine is turned away even when nothing else changes
  window.setInterval(() => {
    if (sun.get().live && pending.length) matchRequests();
  }, 5000);
}
