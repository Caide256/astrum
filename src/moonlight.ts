import { LocalVideoTrack } from "livekit-client";

import { moonlightBridge, type TunEvent } from "./desktop.ts";
import { createStore } from "./store.ts";
import { openPcmPlayer, type PcmPlayer } from "./voice/audio.ts";
import { voice, type SunPacket } from "./voice/voice.ts";

/**
 * Watching Sunshine streams of people in the call, through Moonlight's
 * protocol and a direct tunnel to the streamer's computer.
 *
 * Pressing "watch": the native helper opens this side's end of the tunnel
 * (its key and candidates go to the streamer in a "sun-hello"); the
 * streamer's app answers with its end once the streamer let this viewer in
 * (the first time it asks the streamer, afterwards it comes by itself). The
 * two ends punch through to each other, and the tunnel stands in for the
 * streamer's Sunshine on a loopback address here. Moonlight pairs with it
 * the first time (the PIN went along in the hello, nothing to type) and
 * plays: the picture is decoded with WebCodecs (on the GPU where possible)
 * into an ordinary video track, shown in the call like any screen share;
 * the sound comes as PCM through the tunnel into its own player. Only the
 * picture and the sound come: nothing goes back.
 *
 * The quality is a choice of this viewer: the source size or a fixed one, the
 * frame rate and the codec. The bitrate follows from them by itself.
 */

/** A Sunshine this app is paired with: whose it is and which one (its id). */
export type MlHost = {
  key: string;
  userId: string;
  uid: string;
  at: number;
};

export type MlCodec = "h264" | "hevc" | "av1";

/** 0 height means the size of the source. */
export type MlQuality = { height: number; fps: number; codec: MlCodec };

export type MlWatch = {
  identity: string;
  userId: string;
  status: "connecting" | "approval" | "live" | "ended" | "error";
  stage: string;
  error: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** How the tunnel goes: "lan", "v6" or "wan", and its round trip in ms. */
  path: string;
  rtt: number;
  track: LocalVideoTrack | null;
};

export type MlState = {
  hosts: MlHost[];
  quality: MlQuality;
  watching: MlWatch | null;
};

const KEY = "app.moonlight";
const DEFAULT_QUALITY: MlQuality = { height: 0, fps: 60, codec: "h264" };
/** Video packets through the tunnel: room for its header, under any usual MTU. */
const TUNNEL_PACKET = 1200;

export const ML_HEIGHTS = [0, 720, 1080, 1440, 2160];
export const ML_FPS = [30, 60, 120];
export const ML_CODECS: MlCodec[] = ["h264", "hevc", "av1"];

function load(): { hosts: MlHost[]; quality: MlQuality } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { hosts?: Partial<MlHost>[]; quality?: Partial<MlQuality> } | null;
    const hosts = (Array.isArray(raw?.hosts) ? raw.hosts : [])
      .filter((h): h is MlHost => !!h && typeof h.key === "string" && /^u[0-9a-f]{20}$/.test(h.key) && typeof h.userId === "string")
      .map((h) => ({ key: h.key, userId: h.userId, uid: String(h.uid ?? ""), at: Number(h.at) || 0 }));
    const q = raw?.quality ?? {};
    return {
      hosts,
      quality: {
        height: ML_HEIGHTS.includes(Number(q.height)) ? Number(q.height) : DEFAULT_QUALITY.height,
        fps: ML_FPS.includes(Number(q.fps)) ? Number(q.fps) : DEFAULT_QUALITY.fps,
        codec: ML_CODECS.includes(q.codec as MlCodec) ? (q.codec as MlCodec) : "h264",
      },
    };
  } catch {
    return { hosts: [], quality: DEFAULT_QUALITY };
  }
}

export const ml = createStore<MlState>({ ...load(), watching: null });

function save(): void {
  const s = ml.get();
  try {
    localStorage.setItem(KEY, JSON.stringify({ hosts: s.hosts, quality: s.quality }));
  } catch {
    // kept until restart
  }
}

export const hasMoonlight = !!moonlightBridge();

export function setQuality(patch: Partial<MlQuality>): void {
  ml.set({ quality: { ...ml.get().quality, ...patch } });
  save();
}

/**
 * The bitrate for a picture: about what Moonlight itself picks (20 Mbit/s for
 * 1080p at 60), less for HEVC and AV1, which pack the same picture tighter.
 */
export function autoKbps(width: number, height: number, fps: number, codec: MlCodec): number {
  const pixels = (width * height) / (1920 * 1080);
  const rate = fps <= 30 ? 0.6 : fps <= 60 ? 1 : 1.5;
  const k = codec === "av1" ? 0.65 : codec === "hevc" ? 0.75 : 1;
  return Math.round(Math.max(3000, Math.min(150_000, 20_000 * pixels * rate * k)) / 500) * 500;
}

/** The picture size for a source: the chosen height, never bigger than the source, its shape kept. */
export function pictureFor(source: { w: number; h: number }, q: MlQuality): { width: number; height: number } {
  const aspect = source.w > 0 && source.h > 0 ? source.w / source.h : 16 / 9;
  const height = q.height === 0 ? source.h : Math.min(q.height, source.h || q.height);
  // even sizes: encoders want them
  return { width: Math.round((height * aspect) / 2) * 2, height: Math.round(height / 2) * 2 };
}

/* ------------------------------------------------------------- hosts list */

/** The key a streamer's certificate is kept under: from the account, so it stays paired whatever the address. */
async function hostKey(userId: string): Promise<string> {
  const data = new TextEncoder().encode(userId);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `u${[...hash.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function rememberHost(host: MlHost): void {
  const rest = ml.get().hosts.filter((h) => h.key !== host.key);
  ml.set({ hosts: [host, ...rest].slice(0, 50) });
  save();
}

/** The pinned certificate is kept under the key; the address part does not matter for forgetting. */
const forgetCert = (key: string) => moonlightBridge()?.forget(`${key}@127.0.0.1`);

/** Forget a Sunshine: its certificate goes, the next stream pairs again. */
export async function forgetHost(key: string): Promise<void> {
  ml.set({ hosts: ml.get().hosts.filter((h) => h.key !== key) });
  save();
  await forgetCert(key);
}

/* ---------------------------------------------------------------- codecs */

const CODEC_FORMAT: Record<MlCodec, number> = { h264: 0x0001, hevc: 0x0100, av1: 0x1000 };
const CODEC_PROBE: Record<MlCodec, string> = { h264: "avc1.640033", hevc: "hvc1.1.6.L153.B0", av1: "av01.0.13M.08" };

/** Whether this computer decodes a codec on its graphics card: only then is it offered to the streamer. */
async function decodes(codec: MlCodec): Promise<boolean> {
  if (codec === "h264") return true;
  try {
    const r = await VideoDecoder.isConfigSupported({ codec: CODEC_PROBE[codec], hardwareAcceleration: "prefer-hardware" });
    return !!r.supported;
  } catch {
    return false;
  }
}

/** WebCodecs name of a Moonlight video format. */
function codecOf(format: number): string {
  if (format & 0x0f00) return format & 0x0200 ? "hvc1.2.4.L153.B0" : "hvc1.1.6.L153.B0";
  if (format & 0xf000) return "av01.0.13M.08";
  return "avc1.640033";
}

/* --------------------------------------------------------------- signals */

type Answer = { ok: true; sid: number; key: string; nat: string; cands: string[] } | { ok: false; reason: string };
type Waiting = { identity: string; name: string; resolve: (a: Answer) => void };
let waiting: Waiting | null = null;
let tunWaiting: ((ev: TunEvent) => void) | null = null;

const HEX64 = /^[0-9a-f]{64}$/;

/** The streamer's answers to our hello. */
function onPacket(packet: SunPacket, from: string): void {
  const w = waiting;
  if (!w || w.identity !== from) return;
  if (packet.t === "sun-wait" && packet.name === w.name) {
    setWatch({ status: "approval" });
  } else if (packet.t === "sun-offer" && packet.name === w.name) {
    const cands = Array.isArray(packet.cands) ? packet.cands.filter((c): c is string => typeof c === "string").slice(0, 16) : [];
    const sid = Number(packet.sid) >>> 0;
    if (!sid || !HEX64.test(String(packet.key)) || !cands.length) {
      w.resolve({ ok: false, reason: "denied" });
      return;
    }
    w.resolve({ ok: true, sid, key: String(packet.key), nat: String(packet.nat ?? ""), cands });
  } else if (packet.t === "sun-answer" && packet.name === w.name && !packet.ok) {
    w.resolve({ ok: false, reason: packet.reason === "off" ? "off" : packet.reason === "busy" ? "busy" : "denied" });
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomPin(): string {
  const v = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(v).padStart(4, "0");
}

/* --------------------------------------------------------------- watching */

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
let offVoice: (() => void) | null = null;
let fpsCount = 0;
let fpsTimer = 0;
let run = 0;

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
  if (buf.byteLength < 19) return;
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

/* ------------------------------------------------------------------ sound */

/**
 * The stream's sound: 5 ms frames of PCM through the tunnel, numbered. A lost
 * frame is covered by the one before it, fading, so a gap does not click.
 */
let player: PcmPlayer | null = null;
let opening = false;
let lastSeq = -1;
let lastFrame: Int16Array | null = null;
let offPcm: (() => void) | null = null;

/** The stream's volume: the stream volume of that person in the call, silent while deafened. */
function applyGain(): void {
  const w = ml.get().watching;
  if (!player || !w) return;
  const st = voice.getState();
  const off = st.deafened || voice.streamMuted(w.userId);
  player.setGain(off ? 0 : voice.streamVolume(w.userId) / 100);
}

async function openSound(): Promise<void> {
  const mine = run;
  opening = true;
  const p = await openPcmPlayer(voice.getState().settings.spkId).catch(() => null);
  opening = false;
  if (!p || mine !== run) {
    void p?.close();
    return;
  }
  player = p;
  applyGain();
}

function onPcm(buf: ArrayBuffer): void {
  if (buf.byteLength < 8) return;
  if (!player) {
    if (!opening) void openSound();
    return;
  }
  const seq = new DataView(buf).getUint32(0, false);
  if (lastSeq >= 0 && seq <= lastSeq && lastSeq - seq < 1_000_000) return;
  const gap = lastSeq >= 0 ? seq - lastSeq - 1 : 0;
  if (gap > 0 && gap <= 8 && lastFrame) {
    for (let i = 0; i < gap; i += 1) {
      const fade = new Int16Array(lastFrame.length);
      const k = 0.5 ** (i + 1);
      for (let j = 0; j < fade.length; j += 1) fade[j] = lastFrame[j] * k;
      player.push(fade.buffer);
    }
  }
  lastSeq = seq;
  lastFrame = new Int16Array(buf.slice(4));
  player.push(buf.slice(4));
}

function stopSound(): void {
  offPcm?.();
  offPcm = null;
  void player?.close();
  player = null;
  lastSeq = -1;
  lastFrame = null;
}

/* ---------------------------------------------------------------- session */

function onEvent(json: string): void {
  let ev: { event?: string; code?: number; text?: string };
  try {
    ev = JSON.parse(json);
  } catch {
    return;
  }
  if (ev.event === "stage") setWatch({ stage: ev.text ?? "" });
  else if (ev.event === "started") setWatch({ status: "live", stage: "" });
  else if (ev.event === "stageFailed") setWatch({ status: "error", error: `start:${ev.text ?? ""} (${ev.code ?? 0})` });
  else if (ev.event === "terminated" || ev.event === "ended") {
    const w = ml.get().watching;
    if (w && w.status !== "error") {
      setWatch({ status: ev.code && ev.code !== 0 ? "error" : "ended", error: ev.code ? `start:${ev.text || String(ev.code)}` : "" });
    }
    cleanup(false);
  }
}

/** The tunnel's own events: a path, a failure, or the streamer gone. */
function onTunnel(json: string): void {
  let ev: TunEvent;
  try {
    ev = JSON.parse(json) as TunEvent;
  } catch {
    return;
  }
  if (tunWaiting && (ev.ev === "up" || ev.ev === "fail" || ev.ev === "down")) {
    const resolve = tunWaiting;
    tunWaiting = null;
    resolve(ev);
    return;
  }
  if (ev.ev === "down") {
    const w = ml.get().watching;
    if (w && (w.status === "live" || w.status === "connecting")) {
      setWatch({ status: "ended", error: "" });
      cleanup(true);
    }
  }
}

function cleanup(stopHelper: boolean): void {
  offFrame?.();
  offEvent?.();
  offVoice?.();
  offFrame = null;
  offEvent = null;
  offVoice = null;
  window.clearInterval(fpsTimer);
  resetDecoder();
  stopSound();
  void writer?.close().catch(() => undefined);
  writer = null;
  generator = null;
  canvas = null;
  if (stopHelper) void moonlightBridge()?.stop();
  void moonlightBridge()?.tunStop();
}

/** Why a watch failed, in a form the interface turns into words. */
export type MlFail = "tunnel" | "off" | "timeout" | "denied" | "busy" | "punch" | "unreachable" | "pairing" | "no-app" | "start" | "no-helper";

function fail(reason: MlFail, detail = ""): void {
  setWatch({ status: "error", error: detail ? `${reason}:${detail}` : reason });
  cleanup(true);
  if (ml.get().watching) voice.setSunVideo(null, null);
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), ms));
}

/** Watch the Sunshine stream of a call participant: tunnel, pair if needed, play. */
async function watchSunshine(identity: string): Promise<void> {
  const b = moonlightBridge();
  const info = voice.sunOf(identity);
  if (!b || !info) return;
  stopSunshineWatch();
  const mine = ++run;
  const userId = identity.split(":").slice(0, 2).join(":");
  const media = makeTrack();
  const track = new LocalVideoTrack(media, undefined, false);
  const q = ml.get().quality;
  const size = pictureFor({ w: info.w, h: info.h }, q);
  const fps = Math.min(q.fps, Math.max(30, info.fps));
  const codec = (await decodes(q.codec)) ? q.codec : "h264";
  const kbps = autoKbps(size.width, size.height, fps, codec);
  ml.set({
    watching: {
      identity,
      userId,
      status: "connecting",
      stage: "",
      error: "",
      width: size.width,
      height: size.height,
      fps: 0,
      kbps,
      path: "",
      rtt: 0,
      track,
    },
  });
  voice.setSunVideo(identity, track);
  const alive = () => mine === run && ml.get().watching?.identity === identity;

  const key = await hostKey(userId);
  const known = ml.get().hosts.find((h) => h.key === key);
  // another Sunshine answers for that person now (reinstalled): its old certificate is no good
  if (known && info.uid && known.uid && known.uid !== info.uid) await forgetCert(key);

  // this side's end of the tunnel
  offEvent = b.onTunEvent(onTunnel);
  offPcm = b.onTunPcm(onPcm);
  const ready = await b.tunStart(info.port);
  if (!alive()) return;
  if (!ready.ok || !ready.key || !ready.cands?.length) {
    fail("tunnel", ready.error ?? "");
    return;
  }

  // ask the streamer; the PIN is used only if this computer still has to pair
  const name = `astrum-${randomHex(8)}`;
  const pin = randomPin();
  const answer = await Promise.race([
    new Promise<Answer>((resolve) => {
      waiting = { identity, name, resolve };
      voice.sendSun({ t: "sun-hello", name, pin, key: ready.key ?? "", nat: ready.nat ?? "", cands: ready.cands ?? [] }, identity);
    }),
    timeout<Answer>(120_000, { ok: false, reason: "timeout" }),
  ]);
  waiting = null;
  if (!alive()) return;
  if (!answer.ok) {
    fail(answer.reason as MlFail);
    return;
  }

  // punch through
  setWatch({ status: "connecting", stage: "" });
  const path = await Promise.race([
    new Promise<TunEvent>((resolve) => {
      tunWaiting = resolve;
      void b.tunPeer(answer.sid, answer.key, answer.nat, answer.cands);
    }),
    timeout<TunEvent>(25_000, { ev: "fail", reason: "punch" }),
  ]);
  tunWaiting = null;
  if (!alive()) return;
  if (path.ev !== "up") {
    voice.sendSun({ t: "sun-fail", reason: path.ev === "fail" ? path.reason : "down" }, identity);
    fail(path.ev === "fail" && path.reason === "local" ? "tunnel" : "punch");
    return;
  }
  setWatch({ path: path.path, rtt: path.rtt });
  const host = `${key}@${path.local}:${info.port}`;

  const hostInfo = await b.info(host);
  if (!alive()) return;
  if (!hostInfo.ok || !hostInfo.data) {
    fail("unreachable", hostInfo.error ?? "");
    return;
  }
  if (!hostInfo.data.paired) {
    const res = await b.pair(host, pin, name);
    if (!alive()) return;
    if (!res.ok) {
      fail("pairing", res.error ?? "");
      return;
    }
  }

  const apps = await b.apps(host);
  if (!alive()) return;
  const list = apps.ok && Array.isArray(apps.data) ? apps.data : [];
  const app = list.find((a) => /desktop/i.test(a.title)) ?? list[0];
  if (!app) {
    fail("no-app");
    return;
  }
  rememberHost({ key, userId, uid: info.uid, at: Date.now() });

  const offTunnelEvents = offEvent;
  const offStream = b.onEvent(onEvent);
  offEvent = () => {
    offTunnelEvents?.();
    offStream();
  };
  offFrame = b.onFrame(onFrame);
  offVoice = voice.subscribe(applyGain);
  fpsCount = 0;
  fpsTimer = window.setInterval(() => {
    setWatch({ fps: fpsCount });
    fpsCount = 0;
  }, 1000);
  const res = await b.start({
    host,
    app: app.id,
    width: size.width,
    height: size.height,
    fps,
    kbps,
    // H264 always works; HEVC or AV1 is offered on top when chosen and decodable here
    formats: CODEC_FORMAT.h264 | CODEC_FORMAT[codec],
    hostAudio: true,
    packet: TUNNEL_PACKET,
  });
  if (!res.ok && alive()) fail("start", res.error || "");
}

/** Stop watching the Sunshine stream, whoever's it was. */
export function stopSunshineWatch(): void {
  run += 1;
  if (waiting) {
    waiting.resolve({ ok: false, reason: "denied" });
    waiting = null;
  }
  if (tunWaiting) {
    tunWaiting({ ev: "down", reason: "stop" });
    tunWaiting = null;
  }
  void moonlightBridge()?.cancel();
  const w = ml.get().watching;
  cleanup(true);
  if (!w) return;
  w.track?.stop();
  ml.set({ watching: null });
  voice.setSunVideo(null, null);
}

// "watch" on a Sunshine stream in the call comes here, and so does its end
voice.onSunWatch = (identity, on) => {
  if (on) void watchSunshine(identity);
  else if (ml.get().watching?.identity === identity) stopSunshineWatch();
};

voice.onSunPacket(onPacket);
