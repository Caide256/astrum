import { LocalVideoTrack } from "livekit-client";

import { moonlightBridge, sunshineBridge, type NetCheck } from "./desktop.ts";
import { createStore } from "./store.ts";
import { openPcmPlayer, type PcmPlayer } from "./voice/audio.ts";
import { voice, type SunPacket } from "./voice/voice.ts";

/**
 * Watching Sunshine streams of people in the call, through Moonlight's
 * protocol.
 *
 * The streamer's app announces its Sunshine in the call. Pressing "watch"
 * connects here: the first time the app pairs with that Sunshine, and the
 * streamer is asked to let this viewer in (the request carries a one-time
 * name and the PIN goes over the call's data channel, nothing to type). The
 * native helper receives the stream; the picture is decoded with WebCodecs
 * (on the GPU where possible) into an ordinary video track, the sound with
 * WebCodecs Opus into its own player. The picture shows in the call like any
 * other screen share. Only the picture and the sound come: nothing goes back.
 *
 * The quality is a choice of this viewer: the source size or a fixed one, the
 * frame rate and the codec. The bitrate follows from them by itself.
 */

/** A Sunshine this app is paired with: whose it is, where it was last, and which one (its id). */
export type MlHost = {
  key: string;
  userId: string;
  address: string;
  uid: string;
  at: number;
};

/** 0 height means the size of the source. */
export type MlQuality = { height: number; fps: number; codec: "h264" | "hevc" };

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
  track: LocalVideoTrack | null;
};

export type MlState = {
  hosts: MlHost[];
  quality: MlQuality;
  watching: MlWatch | null;
};

const KEY = "app.moonlight";
const DEFAULT_QUALITY: MlQuality = { height: 0, fps: 60, codec: "h264" };

export const ML_HEIGHTS = [0, 720, 1080, 1440, 2160];
export const ML_FPS = [30, 60, 120];

function load(): { hosts: MlHost[]; quality: MlQuality } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { hosts?: Partial<MlHost>[]; quality?: Partial<MlQuality> } | null;
    // hosts of the old manual pairing (by address) are not kept: streams find their Sunshine by themselves now
    const hosts = (Array.isArray(raw?.hosts) ? raw.hosts : [])
      .filter((h): h is MlHost => !!h && typeof h.key === "string" && typeof h.userId === "string")
      .map((h) => ({ key: h.key, userId: h.userId, address: String(h.address ?? ""), uid: String(h.uid ?? ""), at: Number(h.at) || 0 }));
    const q = raw?.quality ?? {};
    return {
      hosts,
      quality: {
        height: ML_HEIGHTS.includes(Number(q.height)) ? Number(q.height) : DEFAULT_QUALITY.height,
        fps: ML_FPS.includes(Number(q.fps)) ? Number(q.fps) : DEFAULT_QUALITY.fps,
        codec: q.codec === "hevc" ? "hevc" : "h264",
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
 * 1080p at 60), less for HEVC, which packs the same picture tighter.
 */
export function autoKbps(width: number, height: number, fps: number, codec: MlQuality["codec"]): number {
  const pixels = (width * height) / (1920 * 1080);
  const rate = fps <= 30 ? 0.6 : fps <= 60 ? 1 : 1.5;
  const k = codec === "hevc" ? 0.75 : 1;
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

/** The key a streamer's certificate is kept under: from the account, so a new address keeps the pairing. */
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

/** Forget a Sunshine: its certificate goes, the next stream pairs again. */
export async function forgetHost(key: string): Promise<void> {
  const b = moonlightBridge();
  const host = ml.get().hosts.find((h) => h.key === key);
  ml.set({ hosts: ml.get().hosts.filter((h) => h.key !== key) });
  save();
  if (b && host) await b.forget(`${key}@${host.address || "0.0.0.0"}`);
}

/* ---------------------------------------------------------------- network */

let ownNet: { at: number; value: NetCheck | null } = { at: 0, value: null };

/** This computer's own public address, to tell whether a streamer is in the same network. */
async function myNet(): Promise<NetCheck | null> {
  if (Date.now() - ownNet.at < 10 * 60_000) return ownNet.value;
  const value = await sunshineBridge()?.netCheck().catch(() => null) ?? null;
  ownNet = { at: Date.now(), value };
  return value;
}

const PRIVATE = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Where to try a streamer's Sunshine. Local addresses only when the streamer
 * has the same public address (the same home network); never this machine.
 */
async function candidates(addrs: string[]): Promise<string[]> {
  const pub = addrs.filter((a) => !PRIVATE.test(a));
  const local = addrs.filter((a) => PRIVATE.test(a) && !a.startsWith("127.") && !a.startsWith("169.254."));
  const me = await myNet();
  const sameHome = !!me && pub.some((a) => a === me.ip || a === me.stunIp || a === me.upnpIp);
  return sameHome ? [...local, ...pub] : pub;
}

/* ---------------------------------------------------------------- pairing */

type Waiting = { identity: string; name: string; resolve: (ok: boolean) => void };
let waiting: Waiting | null = null;

/** The streamer's answer to our pairing request. */
function onPacket(packet: SunPacket, from: string): void {
  if (packet.t !== "sun-answer" || !waiting || waiting.identity !== from || packet.name !== waiting.name) return;
  if (!packet.ok) {
    waiting.resolve(false);
    // the helper is still waiting for the PIN that will never come
    void moonlightBridge()?.cancel();
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
let offAudio: (() => void) | null = null;
let offVoice: (() => void) | null = null;
let fpsCount = 0;
let fpsTimer = 0;
let audioDecoder: AudioDecoder | null = null;
let player: PcmPlayer | null = null;
let run = 0;

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

/* ------------------------------------------------------------------ sound */

let audioTs = 0;

/** The stream's volume: the stream volume of that person in the call, silent while deafened. */
function applyGain(): void {
  const w = ml.get().watching;
  if (!player || !w) return;
  const st = voice.getState();
  const off = st.deafened || voice.streamMuted(w.userId);
  player.setGain(off ? 0 : voice.streamVolume(w.userId) / 100);
}

async function startAudio(config: { rate: number; channels: number }): Promise<void> {
  const mine = run;
  if (audioDecoder || typeof AudioDecoder === "undefined") return;
  const p = await openPcmPlayer(voice.getState().settings.spkId).catch(() => null);
  if (!p || mine !== run) {
    void p?.close();
    return;
  }
  player = p;
  applyGain();
  const channels = config.channels === 1 ? 1 : 2;
  audioDecoder = new AudioDecoder({
    output: (data) => {
      // to 16-bit stereo for the shared PCM player
      const frames = data.numberOfFrames;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      try {
        data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
        if (channels > 1) data.copyTo(right, { planeIndex: 1, format: "f32-planar" });
        else right.set(left);
      } catch {
        data.close();
        return;
      }
      data.close();
      const pcm = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i += 1) {
        pcm[i * 2] = Math.max(-1, Math.min(1, left[i])) * 32767;
        pcm[i * 2 + 1] = Math.max(-1, Math.min(1, right[i])) * 32767;
      }
      player?.push(pcm.buffer);
    },
    error: () => {
      try {
        audioDecoder?.close();
      } catch {
        // already closed
      }
      audioDecoder = null;
    },
  });
  audioDecoder.configure({ codec: "opus", sampleRate: config.rate || 48000, numberOfChannels: channels });
  audioTs = 0;
}

function onAudio(packet: ArrayBuffer): void {
  const d = audioDecoder;
  if (!d || d.state !== "configured") return;
  try {
    d.decode(new EncodedAudioChunk({ type: "key", timestamp: audioTs, data: packet }));
    audioTs += 5000;
  } catch {
    // a broken packet: the next one plays
  }
}

function stopAudio(): void {
  try {
    audioDecoder?.close();
  } catch {
    // already closed
  }
  audioDecoder = null;
  void player?.close();
  player = null;
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
  else if (ev.event === "audio") {
    try {
      const cfg = JSON.parse(ev.text ?? "{}") as { rate?: number; channels?: number };
      void startAudio({ rate: Number(cfg.rate) || 48000, channels: Number(cfg.channels) || 2 });
    } catch {
      // the stream plays without sound
    }
  } else if (ev.event === "stageFailed") setWatch({ status: "error", error: `${ev.text ?? ""} (${ev.code ?? 0})` });
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
  offAudio?.();
  offVoice?.();
  offFrame = null;
  offEvent = null;
  offAudio = null;
  offVoice = null;
  window.clearInterval(fpsTimer);
  resetDecoder();
  stopAudio();
  void writer?.close().catch(() => undefined);
  writer = null;
  generator = null;
  canvas = null;
  if (stopHelper) void moonlightBridge()?.stop();
}

/** Why a watch failed, in a form the interface turns into words. */
export type MlFail = "unreachable" | "denied" | "pairing" | "no-app" | "start" | "no-helper";

function fail(reason: MlFail, detail = ""): void {
  setWatch({ status: "error", error: detail ? `${reason}:${detail}` : reason });
  cleanup(true);
  const w = ml.get().watching;
  if (w) voice.setSunVideo(null, null);
}

/** Watch the Sunshine stream of a call participant: connect, pair if needed, play. */
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
  const kbps = autoKbps(size.width, size.height, fps, q.codec);
  ml.set({
    watching: { identity, userId, status: "connecting", stage: "", error: "", width: size.width, height: size.height, fps: 0, kbps, track },
  });
  voice.setSunVideo(identity, track);
  const alive = () => mine === run && ml.get().watching?.identity === identity;

  const key = await hostKey(userId);
  const known = ml.get().hosts.find((h) => h.key === key);
  // another Sunshine answers for that person now (reinstalled): its old certificate is no good
  if (known && info.uid && known.uid && known.uid !== info.uid) await b.forget(`${key}@${known.address || "0.0.0.0"}`);

  let host = "";
  let paired = false;
  for (const addr of await candidates(info.addrs)) {
    const h = `${key}@${addr.includes(":") ? `[${addr}]` : addr}:${info.port}`;
    const res = await b.info(h);
    if (!alive()) return;
    if (res.ok && res.data) {
      host = h;
      paired = res.data.paired;
      break;
    }
  }
  if (!host) {
    voice.sendSun({ t: "sun-fail", reason: "unreachable" }, identity);
    fail("unreachable");
    return;
  }

  if (!paired) {
    const name = `astrum-${randomHex(6)}`;
    const pin = randomPin();
    setWatch({ status: "approval" });
    let denied = false;
    const answer = new Promise<boolean>((resolve) => {
      waiting = { identity, name, resolve: (ok) => (denied = !ok, resolve(ok)) };
    });
    voice.sendSun({ t: "sun-pair", name, pin }, identity);
    const res = await Promise.race([b.pair(host, pin, name), answer.then((ok) => ({ ok, error: ok ? "" : "denied" }))]);
    waiting = null;
    if (!alive()) return;
    if (denied || !res.ok) {
      fail(denied ? "denied" : "pairing", denied ? "" : String((res as { error?: string }).error ?? ""));
      return;
    }
    setWatch({ status: "connecting" });
  }

  const apps = await b.apps(host);
  if (!alive()) return;
  const list = apps.ok && Array.isArray(apps.data) ? apps.data : [];
  const app = list.find((a) => /desktop/i.test(a.title)) ?? list[0];
  if (!app) {
    fail("no-app");
    return;
  }
  rememberHost({ key, userId, address: host.split("@")[1]?.replace(/:\d+$/, "").replace(/^\[|\]$/g, "") ?? "", uid: info.uid, at: Date.now() });

  offFrame = b.onFrame(onFrame);
  offEvent = b.onEvent(onEvent);
  offAudio = b.onAudio(onAudio);
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
    // H264 always works; HEVC is offered on top when chosen
    formats: q.codec === "hevc" ? 0x0101 : 0x0001,
    hostAudio: true,
  });
  if (!res.ok && alive()) fail("start", res.error || "");
}

/** Stop watching the Sunshine stream, whoever's it was. */
export function stopSunshineWatch(): void {
  run += 1;
  if (waiting) {
    waiting.resolve(false);
    waiting = null;
    void moonlightBridge()?.cancel();
  }
  const w = ml.get().watching;
  if (!w) return;
  cleanup(true);
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
