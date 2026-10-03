import { sunshineBridge, type NetCheck, type SunClient, type SunDisplay, type SunPairing, type SunStartSettings, type SunStatus } from "./desktop.ts";
import { createStore } from "./store.ts";
import { blip } from "./voice/audio.ts";
import { voice, type SunPacket } from "./voice/voice.ts";

/**
 * The own screen through the Sunshine bundled with the app (see
 * electron/sunshine.cjs). Viewers reach it through a direct tunnel between
 * the two computers (native/helper/src/tunnel): no port to forward, no
 * public IP needed in most networks, and the call server is not in between,
 * so the picture can be as good as the link and the graphics card allow.
 *
 * Starting a stream starts Sunshine (downloading it once first) and the
 * streamer's end of the tunnel, then announces the stream in the call; it
 * shows like any share, with a yellow dot. A viewer who presses "watch"
 * sends a hello with its end of the tunnel. A viewer this user let in before
 * gets the streamer's end at once; anyone else first shows up here, and only
 * "allow" lets them in. The viewer then pairs with Sunshine through the
 * tunnel; that request is let in by itself, being the one just allowed.
 * Pairing requests that come from anywhere else are turned away.
 */

export type SunSettings = SunStartSettings;

/** A viewer asking to watch, by the one-time name of its request. */
export type SunRequest = { name: string; identity: string; userId: string; at: number };

export type SunState = {
  status: SunStatus | null;
  net: NetCheck | null;
  checking: boolean;
  settings: SunSettings;
  requests: SunRequest[];
  /** Viewers paired with Sunshine, while it runs: their names are their account ids. */
  clients: SunClient[] | null;
  /** Accounts let in: they watch without asking again. Kept on this computer. */
  allowed: string[];
  devices: { displays: SunDisplay[] } | null;
  /** The own stream is announced in the call. */
  live: boolean;
  /** Starting: downloading, starting Sunshine, waiting for it. */
  busy: "" | "install" | "start" | "stop";
  error: string;
  /** A viewer could not get through to this computer: the user of that viewer. */
  unreachable: string;
  /** The encoder Sunshine settled on, as it said in its log. */
  encoder: string;
  /** The sound of the computer could not be captured. */
  noSound: boolean;
};

const KEY = "app.sunshine";
const ALLOWED_KEY = "app.sunshine.allowed";
const DEFAULTS: SunSettings = {
  output: "",
  audio: true,
  encoder: "",
  maxKbps: 0,
  viewers: 4,
  udpPort: 0,
  upnp: true,
  address: "",
};

function load(): SunSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SunSettings> | null;
    const enc = raw?.encoder;
    const udp = Math.round(Number(raw?.udpPort) || 0);
    return {
      output: typeof raw?.output === "string" ? raw.output : "",
      audio: raw?.audio !== false,
      encoder: enc === "nvenc" || enc === "amdvce" || enc === "quicksync" || enc === "software" ? enc : "",
      maxKbps: Math.max(0, Math.min(500_000, Number(raw?.maxKbps) || 0)),
      viewers: Math.max(1, Math.min(8, Math.round(Number(raw?.viewers) || DEFAULTS.viewers))),
      udpPort: udp >= 1024 && udp <= 65535 ? udp : 0,
      upnp: raw?.upnp !== false,
      address: typeof raw?.address === "string" ? raw.address.trim().slice(0, 253) : "",
    };
  } catch {
    return DEFAULTS;
  }
}

function loadAllowed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ALLOWED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && /^@[^:\s]+:\S+$/.test(u)).slice(0, 200) : [];
  } catch {
    return [];
  }
}

export const sun = createStore<SunState>({
  status: null,
  net: null,
  checking: false,
  settings: load(),
  requests: [],
  clients: null,
  allowed: loadAllowed(),
  devices: null,
  live: false,
  busy: "",
  error: "",
  unreachable: "",
  encoder: "",
  noSound: false,
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

function setAllowed(allowed: string[]): void {
  sun.set({ allowed });
  try {
    localStorage.setItem(ALLOWED_KEY, JSON.stringify(allowed));
  } catch {
    // kept until restart
  }
}

/* ------------------------------------------------------------------ checks */

let checkedAt = 0;

/** Look at the network again: the NAT in front of this computer, the router. */
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

/** The size and rate of the monitor that is streamed. */
function sourceOf(output: string): { w: number; h: number; fps: number } {
  const list = sun.get().devices?.displays ?? [];
  const d = list.find((x) => output && x.id === output) ?? list.find((x) => x.primary) ?? list[0];
  return d ? { w: d.w, h: d.h, fps: d.hz } : { w: 1920, h: 1080, fps: 60 };
}

/** The streamer's end of the tunnel, while the stream is on: what viewers get in an offer. */
let tunnel: { nat: string; cands: string[] } | null = null;
/** Accounts whose access was taken away while Sunshine was off: unpaired at the next start. */
let revoked: string[] = [];

/** Start streaming the screen through Sunshine in the current call. */
export async function startSunshineStream(): Promise<boolean> {
  if (!bridge || !voice.getState().connected) return false;
  sun.set({ error: "", unreachable: "", noSound: false });
  await refreshStatus();
  if (!sun.get().status?.installed && !(await installSunshine())) return false;
  // one stream at a time: a share through the call server stops first
  if (voice.getState().screen) await voice.stopScreen();
  if (!sun.get().devices) await loadDevices();

  sun.set({ busy: "start" });
  const settings = sun.get().settings;
  const res = await bridge.start(settings).catch((e) => ({ ok: false as const, error: String(e) }));
  if (!res.ok || !("cands" in res) || !res.cands?.length) {
    sun.set({ busy: "", error: res.error || "start" });
    if (res.ok) await bridge.stop();
    return false;
  }
  if (!voice.getState().connected) {
    // the call ended while Sunshine was starting
    await bridge.stop();
    sun.set({ busy: "" });
    return false;
  }
  tunnel = { nat: res.nat ?? "", cands: res.cands };
  const src = sourceOf(settings.output);
  voice.setSunshine({ v: 2, port: res.port ?? 49989, w: src.w, h: src.h, fps: src.fps, uid: res.uid ?? "" });
  sun.set({ busy: "", live: true, requests: [], encoder: res.encoder ?? "" });
  await refreshClients();
  // access taken away while Sunshine was off
  if (revoked.length) {
    const gone = revoked;
    revoked = [];
    for (const c of sun.get().clients ?? []) if (gone.includes(c.name)) await bridge.unpair(c.uuid);
    void refreshClients();
  }
  return true;
}

export async function stopSunshineStream(): Promise<void> {
  if (!bridge) return;
  voice.setSunshine(null);
  tunnel = null;
  hellos.clear();
  admitted.clear();
  sun.set({ busy: "stop", live: false, requests: [] });
  await bridge.stop().catch(() => undefined);
  sun.set({ busy: "" });
}

/* ---------------------------------------------------------------- viewers */

type Hello = { identity: string; userId: string; pin: string; key: string; nat: string; cands: string[]; at: number };

/** Hellos of viewers, by the name of their request, until they are let in or turned away. */
const hellos = new Map<string, Hello>();
/** Viewers let in, by the name of their request: their pairing in Sunshine is accepted with their PIN. */
const admitted = new Map<string, { userId: string; pin: string; at: number }>();
/** Pairing requests in Sunshine with no viewer behind them: since when, to turn them away. */
const strangers = new Map<string, number>();
let pending: SunPairing[] = [];

const NAME_RE = /^astrum-[0-9a-f]{8,32}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const CAND_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]{2,39}\]):\d{1,5}$/i;
const HELLO_TTL_MS = 5 * 60_000;
const ADMIT_TTL_MS = 5 * 60_000;
const STRANGER_MS = 15_000;

/** Give a viewer the streamer's end of the tunnel. */
async function admit(name: string): Promise<void> {
  const h = hellos.get(name);
  const t = tunnel;
  if (!bridge || !h || !t) return;
  hellos.delete(name);
  const res = await bridge.peer(name, h.key, h.nat, h.cands);
  if (!res.ok || !res.sid || !res.key) {
    voice.sendSun({ t: "sun-answer", name, ok: false, reason: "busy" }, h.identity);
    return;
  }
  if (/^\d{4}$/.test(h.pin)) admitted.set(name, { userId: h.userId, pin: h.pin, at: Date.now() });
  voice.sendSun({ t: "sun-offer", name, sid: res.sid, key: res.key, nat: t.nat, cands: t.cands }, h.identity);
  matchPairings();
}

/** Pairing requests in Sunshine: the admitted viewer's goes in by itself, anything else is turned away. */
function matchPairings(): void {
  if (!bridge) return;
  const now = Date.now();
  for (const [name, a] of admitted) if (now - a.at > ADMIT_TTL_MS) admitted.delete(name);
  for (const p of pending) {
    const a = admitted.get(p.name);
    if (a) {
      admitted.delete(p.name);
      strangers.delete(p.id);
      // the viewer's account is the name Sunshine keeps for it: access can be taken back by account
      void bridge.approve(p.id, a.pin, a.userId).then(() => refreshClients());
      continue;
    }
    // a request nobody let in: from the internet, or a viewer that gave up long ago
    const since = strangers.get(p.id) ?? now;
    strangers.set(p.id, since);
    if (now - since > STRANGER_MS) {
      strangers.delete(p.id);
      void bridge.deny(p.id);
    }
  }
  for (const id of strangers.keys()) if (!pending.some((p) => p.id === id)) strangers.delete(id);
}

function onPacket(packet: SunPacket, from: string): void {
  const userId = from.split(":").slice(0, 2).join(":");
  if (packet.t === "sun-hello") {
    if (!NAME_RE.test(String(packet.name)) || !KEY_RE.test(String(packet.key)) || !Array.isArray(packet.cands)) return;
    if (!sun.get().live || !tunnel) {
      voice.sendSun({ t: "sun-answer", name: packet.name, ok: false, reason: "off" }, from);
      return;
    }
    const cands = packet.cands.filter((c): c is string => typeof c === "string" && CAND_RE.test(c)).slice(0, 16);
    if (!cands.length) return;
    const now = Date.now();
    for (const [name, h] of hellos) if (now - h.at > HELLO_TTL_MS) hellos.delete(name);
    // one waiting hello per person: a new one replaces the old
    for (const [name, h] of hellos) if (h.userId === userId) hellos.delete(name);
    hellos.set(packet.name, {
      identity: from,
      userId,
      pin: /^\d{4}$/.test(String(packet.pin)) ? String(packet.pin) : "",
      key: String(packet.key),
      nat: String(packet.nat ?? ""),
      cands,
      at: now,
    });
    if (sun.get().allowed.includes(userId)) {
      void admit(packet.name);
      return;
    }
    const before = sun.get().requests;
    const others = before.filter((r) => r.userId !== userId);
    sun.set({ requests: [...others, { name: packet.name, identity: from, userId, at: now }] });
    voice.sendSun({ t: "sun-wait", name: packet.name }, from);
    // a sound for a new request, not for every repeat of one already on screen
    if (others.length === before.length) blip("viewerJoin", voice.getState().settings.spkId);
  } else if (packet.t === "sun-fail" && sun.get().live) {
    sun.set({ unreachable: userId });
  }
}

voice.onSunPacket(onPacket);

/** Let the viewer in, now and next time. */
export async function allowViewer(req: SunRequest): Promise<void> {
  sun.set({ requests: sun.get().requests.filter((r) => r.name !== req.name) });
  const allowed = sun.get().allowed;
  if (!allowed.includes(req.userId)) setAllowed([req.userId, ...allowed]);
  await admit(req.name);
}

export function denyViewer(req: SunRequest): void {
  sun.set({ requests: sun.get().requests.filter((r) => r.name !== req.name) });
  hellos.delete(req.name);
  voice.sendSun({ t: "sun-answer", name: req.name, ok: false, reason: "denied" }, req.identity);
}

/** Viewers paired with Sunshine. Known only while Sunshine runs. */
export async function refreshClients(): Promise<void> {
  if (!bridge) return;
  const clients = await bridge.clients().catch(() => null);
  sun.set({ clients });
}

/** Take access away: the account has to ask again, and its pairing in Sunshine goes. "*" is everyone. */
export async function removeViewer(userId: string): Promise<void> {
  if (!bridge) return;
  const all = userId === "*";
  const gone = all ? sun.get().allowed : [userId];
  setAllowed(all ? [] : sun.get().allowed.filter((u) => u !== userId));
  if (!sun.get().status?.ready) {
    revoked = [...new Set([...revoked, ...gone])];
    return;
  }
  if (all) await bridge.unpair("*");
  else for (const c of sun.get().clients ?? []) if (c.name === userId) await bridge.unpair(c.uuid);
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
      matchPairings();
    } else if (ev.type === "stopped" && sun.get().live) {
      // Sunshine went down on its own: the stream is over
      voice.setSunshine(null);
      tunnel = null;
      sun.set({ live: false, requests: [], error: "stopped" });
    } else if (ev.type === "tunnel") {
      if (ev.ev === "gone" && sun.get().live) {
        // the tunnel is gone: nobody can reach Sunshine any more
        sun.set({ error: "tunnel" });
        void stopSunshineStream();
      } else if (ev.ev === "audio-error") sun.set({ noSound: true });
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
    if (sun.get().live && pending.length) matchPairings();
  }, 5000);
}
