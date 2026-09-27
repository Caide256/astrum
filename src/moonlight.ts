import { LocalVideoTrack } from "livekit-client";

import { moonlightBridge, type MlApp } from "./desktop.ts";
import { createStore } from "./store.ts";

/**
 * Watching a friend's Sunshine stream through Moonlight's protocol.
 *
 * A host is added by its address and paired once: the app shows a PIN, the
 * host's owner types it into Sunshine. The host is then tied to one of the
 * user's contacts, so "watch via Moonlight" appears on that person. The
 * native helper receives the video; here it is decoded with WebCodecs (on
 * the GPU where possible) into an ordinary video track, shown like any other
 * screen share. Only the picture is streamed: no input goes back to the host.
 *
 * Hosts, the chosen app and the quality are kept on this computer only: the
 * pairing belongs to this install's certificate.
 */

export type MlHost = {
  id: string;
  address: string;
  name: string;
  paired: boolean;
  /** The contact whose stream this is; empty until chosen. */
  userId: string;
  appId: number;
  appTitle: string;
};

export type MlQuality = { height: number; fps: number; mbps: number; codec: "h264" | "hevc" };

export type MlWatch = {
  hostId: string;
  userId: string;
  status: "connecting" | "live" | "ended" | "error";
  stage: string;
  error: string;
  width: number;
  height: number;
  fps: number;
  track: LocalVideoTrack | null;
};

export type MlState = {
  hosts: MlHost[];
  quality: MlQuality;
  watching: MlWatch | null;
  /** Pairing in progress: the PIN to type into Sunshine. */
  pairing: { hostId: string; pin: string } | null;
  busy: string;
  error: string;
};

const KEY = "app.moonlight";
const DEFAULT_QUALITY: MlQuality = { height: 1080, fps: 60, mbps: 20, codec: "h264" };

export const ML_HEIGHTS = [720, 1080, 1440, 2160];
export const ML_FPS = [30, 60, 120];

function load(): { hosts: MlHost[]; quality: MlQuality } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { hosts?: MlHost[]; quality?: Partial<MlQuality> } | null;
    const hosts = Array.isArray(raw?.hosts) ? raw.hosts.filter((h) => h && typeof h.address === "string" && typeof h.id === "string") : [];
    const q = raw?.quality ?? {};
    return {
      hosts,
      quality: {
        height: ML_HEIGHTS.includes(Number(q.height)) ? Number(q.height) : DEFAULT_QUALITY.height,
        fps: ML_FPS.includes(Number(q.fps)) ? Number(q.fps) : DEFAULT_QUALITY.fps,
        mbps: Math.max(2, Math.min(150, Number(q.mbps) || DEFAULT_QUALITY.mbps)),
        codec: q.codec === "hevc" ? "hevc" : "h264",
      },
    };
  } catch {
    return { hosts: [], quality: DEFAULT_QUALITY };
  }
}

const saved = load();

export const ml = createStore<MlState>({ ...saved, watching: null, pairing: null, busy: "", error: "" });

function save(): void {
  const s = ml.get();
  try {
    localStorage.setItem(KEY, JSON.stringify({ hosts: s.hosts, quality: s.quality }));
  } catch {
    // kept until restart
  }
}

export const hasMoonlight = !!moonlightBridge();

function patchHost(id: string, patch: Partial<MlHost>): void {
  ml.set({ hosts: ml.get().hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
  save();
}

export function setQuality(patch: Partial<MlQuality>): void {
  ml.set({ quality: { ...ml.get().quality, ...patch } });
  save();
}

export function hostOf(userId: string): MlHost | null {
  return ml.get().hosts.find((h) => h.userId === userId && h.paired) ?? null;
}

/** Add a host by address and see what it is; pairing is a separate step. */
export async function addHost(address: string): Promise<MlHost | null> {
  const b = moonlightBridge();
  const addr = address.trim();
  if (!b || !addr) return null;
  ml.set({ busy: "info", error: "" });
  const res = await b.info(addr);
  ml.set({ busy: "" });
  if (!res.ok || !res.data) {
    ml.set({ error: res.error || "no answer" });
    return null;
  }
  const existing = ml.get().hosts.find((h) => h.address === addr);
  const host: MlHost = existing ?? { id: `h${Date.now().toString(36)}`, address: addr, name: "", paired: false, userId: "", appId: 0, appTitle: "" };
  const next = { ...host, name: res.data.hostname || addr, paired: res.data.paired };
  ml.set({ hosts: existing ? ml.get().hosts.map((h) => (h.id === host.id ? next : h)) : [...ml.get().hosts, next] });
  save();
  if (next.paired && !next.appId) await pickDefaultApp(next.id);
  return next;
}

/** The app to watch: Desktop if the host has it, else the first one. */
async function pickDefaultApp(id: string): Promise<MlApp[]> {
  const b = moonlightBridge();
  const host = ml.get().hosts.find((h) => h.id === id);
  if (!b || !host) return [];
  const res = await b.apps(host.address);
  const list = res.ok && Array.isArray(res.data) ? res.data : [];
  const pick = list.find((a) => /desktop/i.test(a.title)) ?? list[0];
  if (pick && !host.appId) patchHost(id, { appId: pick.id, appTitle: pick.title });
  return list;
}

export async function hostApps(id: string): Promise<MlApp[]> {
  const b = moonlightBridge();
  const host = ml.get().hosts.find((h) => h.id === id);
  if (!b || !host) return [];
  const res = await b.apps(host.address);
  return res.ok && Array.isArray(res.data) ? res.data : [];
}

export function setHostApp(id: string, app: MlApp): void {
  patchHost(id, { appId: app.id, appTitle: app.title });
}

export function setHostUser(id: string, userId: string): void {
  patchHost(id, { userId });
}

export function removeHost(id: string): void {
  if (ml.get().watching?.hostId === id) stopWatching();
  ml.set({ hosts: ml.get().hosts.filter((h) => h.id !== id) });
  save();
}

/**
 * Pair with a host: a random PIN is shown, the host's owner enters it in
 * Sunshine (Web UI, PIN page). The call waits for that up to three minutes.
 */
export async function pairHost(id: string): Promise<boolean> {
  const b = moonlightBridge();
  const host = ml.get().hosts.find((h) => h.id === id);
  if (!b || !host) return false;
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  ml.set({ pairing: { hostId: id, pin }, error: "" });
  const res = await b.pair(host.address, pin);
  ml.set({ pairing: null });
  if (!res.ok) {
    ml.set({ error: res.error || "pairing failed" });
    return false;
  }
  patchHost(id, { paired: true });
  await pickDefaultApp(id);
  return true;
}

/* ---------------------------------------------------------------- watching */

type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };

let decoder: VideoDecoder | null = null;
let decoderCodec = "";
let waitKey = true;
let lastIdrAsk = 0;
let generator: Generator | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let canvas: HTMLCanvasElement | null = null;
let offFrame: (() => void) | null = null;
let offEvent: (() => void) | null = null;
let fpsCount = 0;
let fpsTimer = 0;

/** WebCodecs name of a Moonlight video format. */
function codecOf(format: number): string {
  if (format & 0x0f00) return format & 0x0200 ? "hvc1.2.4.L153.B0" : "hvc1.1.6.L153.B0";
  if (format & 0xf000) return "av01.0.13M.08";
  return "avc1.640033";
}

function askKeyframe(): void {
  const now = performance.now();
  if (now - lastIdrAsk < 500) return;
  lastIdrAsk = now;
  void moonlightBridge()?.idr();
}

function setWatch(patch: Partial<MlWatch>): void {
  const w = ml.get().watching;
  if (w) ml.set({ watching: { ...w, ...patch } });
}

/** The track the tile shows: frames go in through a track generator, or a canvas where there is none. */
function makeTrack(): MediaStreamTrack {
  const Gen = (globalThis as unknown as { MediaStreamTrackGenerator?: new (o: { kind: string }) => Generator }).MediaStreamTrackGenerator;
  if (Gen) {
    generator = new Gen({ kind: "video" });
    writer = generator.writable.getWriter();
    return generator;
  }
  canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  return canvas.captureStream().getVideoTracks()[0];
}

function show(frame: VideoFrame): void {
  fpsCount += 1;
  if (writer) {
    // the writer takes the frame over and closes it
    void writer.write(frame).catch(() => frame.close());
    return;
  }
  const c = canvas;
  if (c) {
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth;
      c.height = frame.displayHeight;
    }
    c.getContext("2d")?.drawImage(frame, 0, 0);
  }
  frame.close();
}

function resetDecoder(): void {
  try {
    decoder?.close();
  } catch {
    // already closed
  }
  decoder = null;
  decoderCodec = "";
  waitKey = true;
}

function onFrame(buf: ArrayBuffer): void {
  const view = new DataView(buf);
  const format = view.getUint16(0, true);
  const key = (view.getUint8(2) & 1) === 1;
  const width = view.getUint16(3, true);
  const height = view.getUint16(5, true);
  const pts = Number(view.getBigUint64(11, true));
  const data = new Uint8Array(buf, 19);
  const codec = codecOf(format);

  if (!decoder || decoderCodec !== codec) {
    if (!key) {
      askKeyframe();
      return;
    }
    resetDecoder();
    decoder = new VideoDecoder({
      output: show,
      error: () => {
        // a broken frame or a decoder reset: start again from the next keyframe
        resetDecoder();
        askKeyframe();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    decoderCodec = codec;
    setWatch({ width, height });
  }
  if (waitKey && !key) {
    askKeyframe();
    return;
  }
  // too far behind: skip to the next keyframe rather than show the past
  if (decoder.decodeQueueSize > 6 && !key) {
    waitKey = true;
    askKeyframe();
    return;
  }
  waitKey = false;
  try {
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: pts, data }));
  } catch {
    resetDecoder();
    askKeyframe();
  }
}

function onEvent(json: string): void {
  let ev: { event?: string; code?: number; text?: string };
  try {
    ev = JSON.parse(json);
  } catch {
    return;
  }
  if (ev.event === "stage") setWatch({ stage: ev.text ?? "" });
  else if (ev.event === "started") setWatch({ status: "live", stage: "" });
  else if (ev.event === "stageFailed") setWatch({ status: "error", error: `${ev.text ?? ""} (${ev.code ?? 0})` });
  else if (ev.event === "terminated" || ev.event === "ended") {
    const w = ml.get().watching;
    if (w && w.status !== "error") {
      setWatch({ status: ev.code && ev.code !== 0 ? "error" : "ended", error: ev.code ? ev.text || String(ev.code) : "" });
    }
    cleanup(false);
  }
}

function cleanup(stopHelper: boolean): void {
  offFrame?.();
  offEvent?.();
  offFrame = null;
  offEvent = null;
  window.clearInterval(fpsTimer);
  resetDecoder();
  void writer?.close().catch(() => undefined);
  writer = null;
  generator = null;
  canvas = null;
  if (stopHelper) void moonlightBridge()?.stop();
}

/** Watch the stream of a contact tied to a paired host. */
export async function startWatching(userId: string): Promise<void> {
  const b = moonlightBridge();
  const host = hostOf(userId);
  if (!b || !host) return;
  stopWatching();
  const q = ml.get().quality;
  const height = q.height;
  const width = Math.round((height * 16) / 9);
  const media = makeTrack();
  const track = new LocalVideoTrack(media, undefined, false);
  ml.set({
    watching: { hostId: host.id, userId, status: "connecting", stage: "", error: "", width, height, fps: 0, track },
    error: "",
  });
  offFrame = b.onFrame(onFrame);
  offEvent = b.onEvent(onEvent);
  fpsCount = 0;
  fpsTimer = window.setInterval(() => {
    setWatch({ fps: fpsCount });
    fpsCount = 0;
  }, 1000);
  const res = await b.start({
    host: host.address,
    app: host.appId,
    width,
    height,
    fps: q.fps,
    kbps: q.mbps * 1000,
    // H264 always works; HEVC is offered on top when chosen
    formats: q.codec === "hevc" ? 0x0101 : 0x0001,
  });
  if (!res.ok) {
    setWatch({ status: "error", error: res.error || "no helper" });
    cleanup(false);
  }
}

export function stopWatching(): void {
  if (!ml.get().watching) return;
  cleanup(true);
  const w = ml.get().watching;
  w?.track?.stop();
  ml.set({ watching: null });
}
