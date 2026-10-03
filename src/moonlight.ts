import { LocalVideoTrack } from "livekit-client";

import { moonlightBridge, type TunEvent } from "./desktop.ts";
import { createStore } from "./store.ts";
import { openPcmPlayer, type PcmPlayer } from "./voice/audio.ts";
import { voice, type SunInfo, type SunPacket } from "./voice/voice.ts";

/**
 * Watching Sunshine streams of people in the call, through Moonlight's
 * protocol and a direct tunnel to each streamer's computer.
 *
 * Pressing "watch": the native helper opens this side's end of a tunnel (its
 * key and candidates go to the streamer in a "sun-hello"); the streamer's app
 * answers with its end once the streamer let this viewer in (the first time
 * it asks the streamer, afterwards it comes by itself). The two ends punch
 * through to each other, and the tunnel stands in for the streamer's
 * Sunshine on a loopback address here. Moonlight streams through it, pairing
 * first when the streamer's Sunshine does not know this computer yet (the
 * PIN went along in the hello, nothing to type). The picture is decoded with
 * WebCodecs (on the GPU where possible) into an ordinary video track, shown
 * in the call like any screen share; the sound comes as PCM through the
 * tunnel into its own player. Only the picture and the sound come: nothing
 * goes back.
 *
 * Several streams can be watched at once: each is a session of its own, with
 * its own tunnel, stream, decoder and player.
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
  /** The streams being watched, by the streamer's identity in the call. */
  watches: Record<string, MlWatch>;
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

export const ml = createStore<MlState>({ ...load(), watches: {} });

function save(): void {
  const s = ml.get();
  try {
    localStorage.setItem(KEY, JSON.stringify({ hosts: s.hosts, quality: s.quality }));
  } catch {
    // kept until restart
  }
}

const bridge = moonlightBridge();
export const hasMoonlight = !!bridge;

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
const forgetCert = (key: string) => bridge?.forget(`${key}@127.0.0.1`);

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

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomPin(): string {
  const v = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(v).padStart(4, "0");
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), ms));
}

/** Why a watch failed, in a form the interface turns into words. */
export type MlFail = "tunnel" | "off" | "timeout" | "denied" | "busy" | "punch" | "unreachable" | "pairing" | "no-app" | "start" | "no-helper";

type Answer = { ok: true; sid: number; key: string; nat: string; cands: string[] } | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;

type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };

/* -------------------------------------------------------------- a session */

/** One stream being watched: its tunnel, stream, decoder and player. */
class Session {
  readonly wid = randomHex(8);
  readonly userId: string;
  /** The one-time name of this viewer's request to the streamer. */
  readonly name = `astrum-${randomHex(8)}`;
  /** Used only if this computer still has to pair with the streamer's Sunshine. */
  readonly pin = randomPin();
  alive = true;
  private answer: ((a: Answer) => void) | null = null;
  private tunnelWait: ((ev: TunEvent) => void) | null = null;
  private host = "";
  private key = "";
  private startArgs: Parameters<NonNullable<typeof bridge>["start"]>[1] | null = null;
  private started = false;
  private repaired = false;

  private decoder: VideoDecoder | null = null;
  private decoderCodec = "";
  private waitKey = true;
  private lastIdrAsk = 0;
  private generator: Generator | null = null;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private fpsCount = 0;
  private fpsTimer = 0;
  private player: PcmPlayer | null = null;
  private opening = false;
  private lastSeq = -1;
  private lastFrame: Int16Array | null = null;
  private offVoice: (() => void) | null = null;
  readonly track: LocalVideoTrack;

  constructor(readonly identity: string) {
    this.userId = identity.split(":").slice(0, 2).join(":");
    this.track = new LocalVideoTrack(this.makeTrack(), undefined, false);
  }

  set(patch: Partial<MlWatch>): void {
    if (!this.alive) return;
    const w = ml.get().watches[this.identity];
    if (w) ml.set({ watches: { ...ml.get().watches, [this.identity]: { ...w, ...patch } } });
  }

  fail(reason: MlFail, detail = ""): void {
    this.set({ status: "error", error: detail ? `${reason}:${detail}` : reason });
    this.teardown();
  }

  /** The track the tile shows: frames go in through a track generator, or a canvas where there is none. */
  private makeTrack(): MediaStreamTrack {
    const Gen = (globalThis as unknown as { MediaStreamTrackGenerator?: new (o: { kind: string }) => Generator }).MediaStreamTrackGenerator;
    if (Gen) {
      this.generator = new Gen({ kind: "video" });
      this.writer = this.generator.writable.getWriter();
      return this.generator;
    }
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280;
    this.canvas.height = 720;
    return this.canvas.captureStream().getVideoTracks()[0];
  }

  /* --------------------------------------------------------------- joining */

  async run(info: SunInfo): Promise<void> {
    const b = bridge;
    if (!b) return;
    const q = ml.get().quality;
    const size = pictureFor({ w: info.w, h: info.h }, q);
    const fps = Math.min(q.fps, Math.max(30, info.fps));
    const codec = (await decodes(q.codec)) ? q.codec : "h264";
    const kbps = autoKbps(size.width, size.height, fps, codec);
    this.set({ width: size.width, height: size.height, kbps });

    this.key = await hostKey(this.userId);
    const known = ml.get().hosts.find((h) => h.key === this.key);
    // another Sunshine answers for that person now (reinstalled): its old certificate is no good
    if (known && info.uid && known.uid && known.uid !== info.uid) await forgetCert(this.key);

    // this side's end of the tunnel
    const ready = await b.tunStart(this.wid, info.port);
    if (!this.alive) return;
    if (!ready.ok || !ready.key || !ready.cands?.length) {
      this.fail("tunnel", ready.error ?? "");
      return;
    }
    const mine = ready.nat ?? "";

    // ask the streamer
    const answer = await Promise.race([
      new Promise<Answer>((resolve) => {
        this.answer = resolve;
        voice.sendSun({ t: "sun-hello", name: this.name, pin: this.pin, key: ready.key ?? "", nat: mine, cands: ready.cands ?? [] }, this.identity);
      }),
      timeout<Answer>(120_000, { ok: false, reason: "timeout" }),
    ]);
    this.answer = null;
    if (!this.alive) return;
    if (!answer.ok) {
      this.fail(answer.reason as MlFail);
      return;
    }

    // punch through
    this.set({ status: "connecting", stage: "" });
    const path = await Promise.race([
      new Promise<TunEvent>((resolve) => {
        this.tunnelWait = resolve;
        void b.tunPeer(this.wid, answer.sid, answer.key, answer.nat, answer.cands);
      }),
      timeout<TunEvent>(28_000, { ev: "fail", reason: "punch" }),
    ]);
    this.tunnelWait = null;
    if (!this.alive) return;
    if (path.ev !== "up") {
      voice.sendSun({ t: "sun-fail", reason: path.ev === "fail" ? path.reason : "down" }, this.identity);
      // both NAT kinds go along: the message says which side is the hard one
      if (path.ev === "fail" && path.reason === "local") this.fail("tunnel");
      else this.fail("punch", `${mine || "unknown"}:${answer.nat || "unknown"}`);
      return;
    }
    this.set({ path: path.path, rtt: path.rtt });
    this.host = `${this.key}@${path.local}:${info.port}`;
    rememberHost({ key: this.key, userId: this.userId, uid: info.uid, at: Date.now() });

    this.offVoice = voice.subscribe(() => this.applyGain());
    this.fpsTimer = window.setInterval(() => {
      this.set({ fps: this.fpsCount });
      this.fpsCount = 0;
    }, 1000);
    this.startArgs = {
      host: this.host,
      // 0: the streamer's desktop, found by the helper itself
      app: 0,
      width: size.width,
      height: size.height,
      fps,
      kbps,
      // H264 always works; HEVC or AV1 is offered on top when chosen and decodable here
      formats: CODEC_FORMAT.h264 | CODEC_FORMAT[codec],
      hostAudio: true,
      packet: TUNNEL_PACKET,
    };
    // a known streamer is tried at once; pairing comes in only when the stream says it is needed
    if (!known) {
      const info2 = await b.info(this.host);
      if (!this.alive) return;
      if (!info2.ok || !info2.data) {
        this.fail("unreachable", info2.error ?? "");
        return;
      }
      if (!info2.data.paired && !(await this.pair())) return;
    }
    await this.startStream();
  }

  private async startStream(): Promise<void> {
    const b = bridge;
    if (!b || !this.startArgs || !this.alive) return;
    this.started = false;
    const res = await b.start(this.wid, this.startArgs);
    if (!res.ok && this.alive) this.fail("start", res.error || "");
  }

  /**
   * Pair with the streamer's Sunshine: the streamer's app lets the request
   * with this session's name in by itself. Sunshine cannot pair a certificate
   * it already knows a second time (the last step fails with 401, again and
   * again): that happens when this computer lost the streamer's pinned
   * certificate but the streamer kept its pairing. Then a new identity is
   * made and paired, once; other streamers pair it again by themselves.
   */
  private async pair(): Promise<boolean> {
    const b = bridge;
    if (!b) return false;
    this.set({ stage: "pair" });
    await forgetCert(this.key);
    let res = await b.pair(this.host, this.pin, this.name, this.wid);
    if (!this.alive) return false;
    if (!res.ok && /not authorized|401/i.test(res.error ?? "")) {
      await b.reset();
      if (!this.alive) return false;
      res = await b.pair(this.host, this.pin, this.name, this.wid);
      if (!this.alive) return false;
    }
    if (!res.ok) {
      this.fail("pairing", res.error ?? "");
      return false;
    }
    this.set({ stage: "" });
    return true;
  }

  /** The streamer's answers to our hello. */
  onPacket(packet: SunPacket): void {
    const resolve = this.answer;
    if (!resolve) return;
    if (packet.t === "sun-wait" && packet.name === this.name) {
      this.set({ status: "approval" });
    } else if (packet.t === "sun-offer" && packet.name === this.name) {
      const cands = Array.isArray(packet.cands) ? packet.cands.filter((c): c is string => typeof c === "string").slice(0, 16) : [];
      const sid = Number(packet.sid) >>> 0;
      if (!sid || !HEX64.test(String(packet.key)) || !cands.length) resolve({ ok: false, reason: "denied" });
      else resolve({ ok: true, sid, key: String(packet.key), nat: String(packet.nat ?? ""), cands });
    } else if (packet.t === "sun-answer" && packet.name === this.name && !packet.ok) {
      resolve({ ok: false, reason: packet.reason === "off" ? "off" : packet.reason === "busy" ? "busy" : "denied" });
    }
  }

  /* ---------------------------------------------------------------- events */

  onTunnel(ev: TunEvent): void {
    const wait = this.tunnelWait;
    if (wait && (ev.ev === "up" || ev.ev === "fail" || ev.ev === "down")) {
      this.tunnelWait = null;
      wait(ev);
      return;
    }
    if (ev.ev === "down") {
      const w = ml.get().watches[this.identity];
      if (w && (w.status === "live" || w.status === "connecting")) {
        this.set({ status: "ended", error: "" });
        this.teardown();
      }
    }
  }

  onEvent(json: string): void {
    let ev: { event?: string; code?: number; text?: string };
    try {
      ev = JSON.parse(json);
    } catch {
      return;
    }
    if (ev.event === "stage") this.set({ stage: ev.text ?? "" });
    else if (ev.event === "started") {
      this.started = true;
      this.set({ status: "live", stage: "" });
    } else if (ev.event === "stageFailed") this.set({ status: "error", error: `start:${ev.text ?? ""} (${ev.code ?? 0})` });
    else if (ev.event === "terminated" || ev.event === "ended") {
      const text = ev.text ?? "";
      // the streamer's Sunshine does not know this computer (any more): pair, then once more
      if (!this.started && !this.repaired && /not paired|not authorized|401/i.test(text)) {
        this.repaired = true;
        void this.pair().then((ok) => {
          if (ok) void this.startStream();
        });
        return;
      }
      if (/no-app/.test(text)) {
        this.fail("no-app");
        return;
      }
      const w = ml.get().watches[this.identity];
      if (w && w.status !== "error") this.set({ status: ev.code ? "error" : "ended", error: ev.code ? `start:${text || String(ev.code)}` : "" });
      this.teardown();
    }
  }

  /* ----------------------------------------------------------------- video */

  private askKeyframe(): void {
    const now = performance.now();
    if (now - this.lastIdrAsk < 500) return;
    this.lastIdrAsk = now;
    void bridge?.idr(this.wid);
  }

  private show(frame: VideoFrame): void {
    this.fpsCount += 1;
    if (this.writer) {
      // the writer takes the frame over and closes it
      void this.writer.write(frame).catch(() => frame.close());
      return;
    }
    const c = this.canvas;
    if (c) {
      if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
        c.width = frame.displayWidth;
        c.height = frame.displayHeight;
      }
      c.getContext("2d")?.drawImage(frame, 0, 0);
    }
    frame.close();
  }

  private resetDecoder(): void {
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
    this.decoder = null;
    this.decoderCodec = "";
    this.waitKey = true;
  }

  onFrame(buf: ArrayBuffer): void {
    if (buf.byteLength < 19) return;
    const view = new DataView(buf);
    const format = view.getUint16(0, true);
    const key = (view.getUint8(2) & 1) === 1;
    const width = view.getUint16(3, true);
    const height = view.getUint16(5, true);
    const pts = Number(view.getBigUint64(11, true));
    const data = new Uint8Array(buf, 19);
    const codec = codecOf(format);

    if (!this.decoder || this.decoderCodec !== codec) {
      if (!key) {
        this.askKeyframe();
        return;
      }
      this.resetDecoder();
      this.decoder = new VideoDecoder({
        output: (f) => this.show(f),
        error: () => {
          // a broken frame or a decoder reset: start again from the next keyframe
          this.resetDecoder();
          this.askKeyframe();
        },
      });
      this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
      this.decoderCodec = codec;
      this.set({ width, height });
    }
    if (this.waitKey && !key) {
      this.askKeyframe();
      return;
    }
    // too far behind: skip to the next keyframe rather than show the past
    if (this.decoder.decodeQueueSize > 6 && !key) {
      this.waitKey = true;
      this.askKeyframe();
      return;
    }
    this.waitKey = false;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: pts, data }));
    } catch {
      this.resetDecoder();
      this.askKeyframe();
    }
  }

  /* ----------------------------------------------------------------- sound */

  /** The stream's volume: the stream volume of that person in the call, silent while deafened. */
  private applyGain(): void {
    if (!this.player) return;
    const st = voice.getState();
    const off = st.deafened || voice.streamMuted(this.userId);
    this.player.setGain(off ? 0 : voice.streamVolume(this.userId) / 100);
  }

  private async openSound(): Promise<void> {
    this.opening = true;
    const p = await openPcmPlayer(voice.getState().settings.spkId).catch(() => null);
    this.opening = false;
    if (!p || !this.alive) {
      void p?.close();
      return;
    }
    this.player = p;
    this.applyGain();
  }

  /**
   * 5 ms frames of PCM through the tunnel, numbered. A lost frame is covered
   * by the one before it, fading, so a gap does not click.
   */
  onPcm(buf: ArrayBuffer): void {
    if (buf.byteLength < 8) return;
    const player = this.player;
    if (!player) {
      if (!this.opening) void this.openSound();
      return;
    }
    const seq = new DataView(buf).getUint32(0, false);
    if (this.lastSeq >= 0 && seq <= this.lastSeq && this.lastSeq - seq < 1_000_000) return;
    const gap = this.lastSeq >= 0 ? seq - this.lastSeq - 1 : 0;
    if (gap > 0 && gap <= 8 && this.lastFrame) {
      for (let i = 0; i < gap; i += 1) {
        const fade = new Int16Array(this.lastFrame.length);
        const k = 0.5 ** (i + 1);
        for (let j = 0; j < fade.length; j += 1) fade[j] = this.lastFrame[j] * k;
        player.push(fade.buffer);
      }
    }
    this.lastSeq = seq;
    this.lastFrame = new Int16Array(buf.slice(4));
    player.push(buf.slice(4));
  }

  /* ------------------------------------------------------------------- end */

  /** Stop the helpers and the decoding; the tile keeps the last status. */
  teardown(): void {
    this.answer?.({ ok: false, reason: "denied" });
    this.answer = null;
    this.tunnelWait?.({ ev: "down", reason: "stop" });
    this.tunnelWait = null;
    this.offVoice?.();
    this.offVoice = null;
    window.clearInterval(this.fpsTimer);
    this.resetDecoder();
    void this.player?.close();
    this.player = null;
    void bridge?.stop(this.wid);
    byWid.delete(this.wid);
  }

  close(): void {
    this.teardown();
    this.alive = false;
    void this.writer?.close().catch(() => undefined);
    this.writer = null;
    this.track.stop();
  }
}

/* --------------------------------------------------------------- sessions */

const sessions = new Map<string, Session>();
const byWid = new Map<string, Session>();

/** Watch the Sunshine stream of a call participant. */
function watchSunshine(identity: string): void {
  const info = voice.sunOf(identity);
  if (!bridge || !info) return;
  stopSunshineWatch(identity);
  const s = new Session(identity);
  sessions.set(identity, s);
  byWid.set(s.wid, s);
  ml.set({
    watches: {
      ...ml.get().watches,
      [identity]: {
        identity,
        userId: s.userId,
        status: "connecting",
        stage: "",
        error: "",
        width: 0,
        height: 0,
        fps: 0,
        kbps: 0,
        path: "",
        rtt: 0,
        track: s.track,
      },
    },
  });
  voice.setSunVideo(identity, s.track);
  void s.run(info);
}

/** Stop watching one Sunshine stream. */
export function stopSunshineWatch(identity: string): void {
  const s = sessions.get(identity);
  if (s) {
    sessions.delete(identity);
    s.close();
  }
  const { [identity]: gone, ...rest } = ml.get().watches;
  if (gone) ml.set({ watches: rest });
  voice.setSunVideo(identity, null);
}

if (bridge) {
  bridge.onFrame((wid, buf) => byWid.get(wid)?.onFrame(buf));
  bridge.onEvent((wid, json) => byWid.get(wid)?.onEvent(json));
  bridge.onTunPcm((wid, buf) => byWid.get(wid)?.onPcm(buf));
  bridge.onTunEvent((wid, json) => {
    try {
      byWid.get(wid)?.onTunnel(JSON.parse(json) as TunEvent);
    } catch {
      // not an event
    }
  });
}

// "watch" on a Sunshine stream in the call comes here, and so does its end
voice.onSunWatch = (identity, on) => {
  if (on) watchSunshine(identity);
  else stopSunshineWatch(identity);
};

voice.onSunPacket((packet, from) => sessions.get(from)?.onPacket(packet));
