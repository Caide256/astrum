import {
  AudioPresets,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublication,
  type VideoEncoding,
} from "livekit-client";

import { BRAND } from "../brand.ts";
import { hasAppAudio, setScreenSource, startScreenAudio } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import {
  blip,
  openMic,
  openPcmFeed,
  type Blip,
  type Denoise,
  type MicChain,
  type MicOptions,
  type MicState,
  type PcmFeed,
} from "./audio.ts";

/**
 * Voice channel client on top of LiveKit.
 *
 * The microphone is captured and processed locally (audio.ts) and handed to
 * LiveKit as a ready track, so changing the device or the suppressor rebuilds
 * the chain.
 *
 * Screen shares are not subscribed until someone asks to watch them: they are
 * heavy and often nobody watches. Voice and cameras arrive right away.
 *
 * Per-person and per-stream volumes are local: the other side never knows.
 * They are stored and restored on the next call. Mute and deafen are stored
 * too and work outside a call, like in Discord.
 *
 * Clients of this app also talk over the LiveKit data channel (topic
 * named after the app id): whether someone is deafened, who watches whose share, and a
 * moderator's request to leave the call. Other clients ignore these packets.
 */

export type VoiceMember = {
  id: string;
  userId: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  /** Hears nothing; reported by clients of this app only. */
  deafened: boolean;
  local: boolean;
  camera: boolean;
  screen: boolean;
  volume: number;
  localMuted: boolean;
};

export type VoiceVideo = {
  key: string;
  identity: string;
  userId: string;
  name: string;
  screen: boolean;
  local: boolean;
  track: LocalVideoTrack | RemoteVideoTrack;
};

export type VoiceStream = {
  identity: string;
  userId: string;
  name: string;
  local: boolean;
  watching: boolean;
  hasAudio: boolean;
  volume: number;
  /** Its sound is muted here. */
  muted: boolean;
  /** For the own share: who is watching it (identities). */
  viewers: string[];
};

export type DeviceInfo = { id: string; label: string };

export type InputMode = "voice" | "ptt";

export type AudioSettings = {
  micId: string;
  spkId: string;
  camId: string;
  denoise: Denoise;
  autoSensitivity: boolean;
  threshold: number;
  echo: boolean;
  gain: boolean;
  sounds: boolean;
  shareAudio: boolean;
  /** Screen share height, 0 means native. */
  shareHeight: number;
  shareFps: number;
  /** Limiter on other people's voices: how hard shouting is cut. */
  limiter: Limiter;
  inputMode: InputMode;
  /** Push-to-talk release delay, ms. */
  pttDelay: number;
  /** Share encoder: auto tries the GPU (H264) and falls back to VP8 on the CPU if it produces nothing. */
  shareCodec: ShareCodec;
};

export type ShareCodec = "auto" | "h264" | "vp8";

export type Limiter = "off" | "soft" | "medium" | "hard";

/**
 * Limiter threshold in dBFS. Normal speech sits around -20 dBFS and shouting
 * approaches 0; everything above the threshold is compressed 20:1, quieter
 * sound passes unchanged.
 *
 * The Web Audio compressor adds automatic makeup gain, which would make quiet
 * speakers louder. Only loud peaks should change, so the makeup is removed by
 * a gain node. The values were measured in Chromium with knee 4 and ratio 20:
 * speech and whispering come out at the input level.
 */
const LIMITER: Record<Limiter, { threshold: number; makeup: number } | null> = {
  off: null,
  soft: { threshold: -10, makeup: 5.0 },
  medium: { threshold: -16, makeup: 8.42 },
  hard: { threshold: -22, makeup: 11.84 },
};

/** The current share, for the share menu and its settings. */
export type ShareInfo = {
  sourceId: string;
  name: string;
  audio: boolean;
  width: number;
  height: number;
  fps: number;
};

export type ShareOptions = { audio: boolean; height: number; fps: number; name: string };

/** Who encodes or decodes the share video: the GPU or the CPU. */
export type CodecInfo = {
  codec: string;
  engine: string;
  gpu: boolean;
  fps: number;
  width: number;
  height: number;
  /** Video codecs enabled on the LiveKit server. Empty means all. */
  serverCodecs: string[];
};

/** Tell a hardware codec from a software one by its implementation name. */
function onGpu(name: string, flag: unknown): boolean {
  if (flag === true) return true;
  return /MediaFoundation|D3D11|DXVA|NVIDIA|NVENC|Intel|AMD|ExternalEncoder|ExternalDecoder/i.test(name);
}

async function readCodec(
  pc: RTCRtpSender | RTCRtpReceiver,
  kind: "outbound-rtp" | "inbound-rtp",
): Promise<Omit<CodecInfo, "serverCodecs"> | null> {
  const stats = await pc.getStats();
  let found: Record<string, any> | null = null;
  stats.forEach((s: Record<string, any>) => {
    if (s.type === kind && s.kind === "video") found = s;
  });
  if (!found) return null;
  const f = found as Record<string, any>;
  const engine = String(f.encoderImplementation ?? f.decoderImplementation ?? "");
  const codec = String((stats.get(f.codecId) as Record<string, any> | undefined)?.mimeType ?? "").replace(/^video\//i, "");
  return {
    codec: codec.toUpperCase(),
    engine,
    gpu: onGpu(engine, f.powerEfficientEncoder ?? f.powerEfficientDecoder),
    fps: Math.round(Number(f.framesPerSecond ?? 0)),
    width: Number(f.frameWidth ?? 0),
    height: Number(f.frameHeight ?? 0),
  };
}

export type VoiceState = {
  roomId: string | null;
  connected: boolean;
  connecting: boolean;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  members: VoiceMember[];
  videos: VoiceVideo[];
  streams: VoiceStream[];
  share: ShareInfo | null;
  devices: { mics: DeviceInfo[]; speakers: DeviceInfo[]; cams: DeviceInfo[] };
  settings: AudioSettings;
  error: string;
};

const DEFAULT_SETTINGS: AudioSettings = {
  micId: "",
  spkId: "",
  camId: "",
  denoise: "rnnoise",
  autoSensitivity: true,
  threshold: -50,
  echo: true,
  gain: true,
  sounds: true,
  shareAudio: true,
  shareHeight: 1080,
  shareFps: 60,
  limiter: "medium",
  inputMode: "voice",
  pttDelay: 200,
  shareCodec: "auto",
};

/**
 * Capture constraints. The height is strict, the width has room to spare:
 * windows come in any shape and must fit whole.
 */
function shareConstraints(q: { height: number; fps: number }): MediaTrackConstraints {
  const c: MediaTrackConstraints = { frameRate: { ideal: q.fps, max: q.fps } };
  if (q.height > 0) {
    c.height = { max: q.height };
    c.width = { max: Math.round(q.height * 2.4) };
  }
  return c;
}

/**
 * Share bitrate from size and frame rate. LiveKit's screen share default caps
 * at 15 fps and 2.5 Mbit/s, which looks blurry and choppy. The share gets a
 * high network priority, so a camera or a congested link cuts other video
 * first.
 */
function shareEncoding(width: number, height: number, fps: number): VideoEncoding {
  const bits = width * height * fps * 0.05;
  return { maxBitrate: Math.round(Math.max(1_500_000, Math.min(12_000_000, bits))), maxFramerate: fps, priority: "high" };
}

/**
 * When the encoder cannot keep up, Chromium lowers either the frame rate or
 * the resolution. Fast shares let it trade both a little instead of dropping
 * the picture size in steps; slow ones keep text sharp.
 */
function degradation(fps: number): RTCDegradationPreference {
  return fps > 30 ? "balanced" : "maintain-resolution";
}

function hasH264(): boolean {
  try {
    return !!RTCRtpSender.getCapabilities?.("video")?.codecs.some((c) => /h264/i.test(c.mimeType));
  } catch {
    return false;
  }
}

/** H264 is encoded by the GPU, VP8 only by the CPU. */
function screenCodec(pref: ShareCodec): "h264" | "vp8" {
  if (pref === "vp8") return "vp8";
  return hasH264() ? "h264" : "vp8";
}

/** A camera: 720p at a bitrate that keeps faces sharp, with two lower layers for small tiles. */
const CAMERA_ENCODING: VideoEncoding = { maxBitrate: 2_500_000, maxFramerate: 30 };

/** Packets between clients of this app over the LiveKit data channel. */
type Packet = { t: "state"; deaf: boolean } | { t: "watch"; on: boolean } | { t: "kick" };

const TOPIC = BRAND.appId;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How long the GPU encoder may stay silent while viewers wait before the share moves to VP8. */
const ENCODER_STALL_MS = 5000;

function isCancel(e: unknown): boolean {
  return /Permission denied|NotAllowedError|AbortError|canceled|cancelled/i.test(String(e));
}

const SETTINGS_KEY = "app.audio";
const VOLUME_KEY = "app.volumes";
const STREAM_VOLUME_KEY = "app.stream-volumes";
const STREAM_MUTE_KEY = "app.stream-mutes";
const SELF_KEY = "app.voice-state";
const SPEAK_HOLD_MS = 400;

export type VolumeEntry = { volume: number; muted: boolean };

/** What the account keeps across installs, see prefs.ts. */
export type VoicePrefs = {
  volumes: Record<string, VolumeEntry>;
  streams: Record<string, number>;
  streamMutes: Record<string, boolean>;
  limiter: Limiter;
  sounds: boolean;
};

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
    // storage unavailable
  }
}

/** lk-jwt-service identities look like "@user:server:DEVICEID". */
function matrixUserFromIdentity(identity: string): string {
  if (!identity.startsWith("@")) return "";
  const parts = identity.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : "";
}

function blank(): Omit<VoiceState, "devices" | "settings" | "muted" | "deafened"> {
  return {
    roomId: null,
    connected: false,
    connecting: false,
    camera: false,
    screen: false,
    members: [],
    videos: [],
    streams: [],
    share: null,
    error: "",
  };
}

/** How long a restarted share may take to come back before watching stops. */
const WATCH_GRACE_MS = 10_000;

const QUIET: MicState = { db: -120, open: false, threshold: -50 };

type SelfState = { muted: boolean; deafened: boolean };

export class VoiceClient {
  private room: Room | null = null;
  private audioBox: HTMLDivElement | null = null;
  /**
   * Remote audio goes through an own AudioContext: every voice gets a limiter
   * in its chain, and volumes above 100% are really louder.
   */
  private mixCtx: AudioContext | null = null;
  private limiters = new Map<string, { comp: DynamicsCompressorNode; trim: GainNode }>();
  private listeners = new Set<() => void>();
  private meterListeners = new Set<(s: MicState) => void>();
  private prefsListeners = new Set<() => void>();
  private volumes: Record<string, VolumeEntry> = loadJson(VOLUME_KEY, {} as Record<string, VolumeEntry>);
  private streamVolumes: Record<string, number> = loadJson(STREAM_VOLUME_KEY, {} as Record<string, number>);
  private streamMutes: Record<string, boolean> = loadJson(STREAM_MUTE_KEY, {} as Record<string, boolean>);
  private mic: MicChain | null = null;
  private micOff: (() => void) | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private screenFeed: PcmFeed | null = null;
  private screenAudio: LocalAudioTrack | null = null;
  private stopHelper: (() => Promise<void>) | null = null;
  private screenTrack: LocalVideoTrack | null = null;
  private engineAudio: LocalAudioTrack | null = null;
  private watching = new Set<string>();
  private peeking = new Set<string>();
  private lostAt = new Map<string, number>();
  private holdTimer = 0;
  private speakHold = new Map<string, number>();
  private mutedBeforeDeaf = false;
  private pttHeld = false;
  /** Deafened flags of others, from their packets. */
  private remoteDeaf = new Map<string, boolean>();
  /** Who watches the own share. */
  private viewers = new Set<string>();
  /** State before listening to oneself in settings, restored afterwards. */
  private testHold: SelfState | null = null;
  private codecWatch = 0;
  private shareFps = 30;
  /** Moderation hooks from the app: may this person make us leave, and what to do then. */
  kickAllowed: (fromUserId: string) => boolean = () => false;
  onKicked: (fromUserId: string) => void = () => undefined;
  private signature = "";
  private meterState: MicState = QUIET;
  private state: VoiceState;

  constructor() {
    const self = loadJson<SelfState>(SELF_KEY, { muted: false, deafened: false });
    this.mutedBeforeDeaf = self.muted;
    this.state = {
      ...blank(),
      muted: self.muted || self.deafened,
      deafened: self.deafened,
      devices: { mics: [], speakers: [], cams: [] },
      settings: loadJson(SETTINGS_KEY, DEFAULT_SETTINGS),
    };
  }

  getState = (): VoiceState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /**
   * The mic level changes twenty times a second and is kept apart from the
   * main state so it does not re-render the whole window. Only meters
   * subscribe to it.
   */
  meter = (): MicState => this.meterState;

  onMeter = (cb: (s: MicState) => void): (() => void) => {
    this.meterListeners.add(cb);
    return () => {
      this.meterListeners.delete(cb);
    };
  };

  private patch(next: Partial<VoiceState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  private container(): HTMLDivElement {
    if (!this.audioBox) {
      this.audioBox = document.createElement("div");
      this.audioBox.style.display = "none";
      document.body.appendChild(this.audioBox);
    }
    return this.audioBox;
  }

  private sound(kind: Blip): void {
    if (this.state.settings.sounds) blip(kind, this.state.settings.spkId);
  }

  private saveSelf(): void {
    const s = this.state;
    saveJson(SELF_KEY, { muted: s.deafened ? this.mutedBeforeDeaf : s.muted, deafened: s.deafened } satisfies SelfState);
  }

  /* ------------------------------------------------------ synced preferences */

  onPrefsChange = (cb: () => void): (() => void) => {
    this.prefsListeners.add(cb);
    return () => {
      this.prefsListeners.delete(cb);
    };
  };

  private prefsChanged(): void {
    this.prefsListeners.forEach((l) => l());
  }

  exportPrefs(): VoicePrefs {
    const s = this.state.settings;
    return {
      volumes: { ...this.volumes },
      streams: { ...this.streamVolumes },
      streamMutes: { ...this.streamMutes },
      limiter: s.limiter,
      sounds: s.sounds,
    };
  }

  /**
   * Take preferences from the account. Volumes are merged, remote entries
   * win; the rest is applied only when `all` is set (a fresh install).
   */
  importPrefs(p: Partial<VoicePrefs>, all: boolean): void {
    if (p.volumes && typeof p.volumes === "object") {
      this.volumes = { ...this.volumes, ...p.volumes };
      saveJson(VOLUME_KEY, this.volumes);
    }
    if (p.streams && typeof p.streams === "object") {
      this.streamVolumes = { ...this.streamVolumes, ...p.streams };
      saveJson(STREAM_VOLUME_KEY, this.streamVolumes);
    }
    if (p.streamMutes && typeof p.streamMutes === "object") {
      this.streamMutes = { ...this.streamMutes, ...p.streamMutes };
      saveJson(STREAM_MUTE_KEY, this.streamMutes);
    }
    const patch: Partial<AudioSettings> = {};
    if (all && p.limiter && p.limiter in LIMITER) patch.limiter = p.limiter;
    if (all && typeof p.sounds === "boolean") patch.sounds = p.sounds;
    if (Object.keys(patch).length) {
      const settings = { ...this.state.settings, ...patch };
      saveJson(SETTINGS_KEY, settings);
      this.patch({ settings });
      this.applyLimiter();
    }
    this.applyVolumes();
    this.refreshMembers(true);
  }

  /* -------------------------------------------------------- per-person volume */

  userVolume(userId: string): number {
    return this.volumes[userId]?.volume ?? 100;
  }

  userMuted(userId: string): boolean {
    return this.volumes[userId]?.muted ?? false;
  }

  streamVolume(userId: string): number {
    return this.streamVolumes[userId] ?? 100;
  }

  streamMuted(userId: string): boolean {
    return this.streamMutes[userId] ?? false;
  }

  setStreamMuted(userId: string, muted: boolean): void {
    if (!userId) return;
    if (muted) this.streamMutes[userId] = true;
    else delete this.streamMutes[userId];
    saveJson(STREAM_MUTE_KEY, this.streamMutes);
    this.applyVolumes();
    this.refreshMembers(true);
    this.prefsChanged();
  }

  private entry(userId: string): VolumeEntry {
    return this.volumes[userId] ?? { volume: 100, muted: false };
  }

  setUserVolume(userId: string, volume: number): void {
    if (!userId) return;
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    this.volumes[userId] = { ...this.entry(userId), volume: clamped };
    saveJson(VOLUME_KEY, this.volumes);
    this.applyVolumes();
    this.refreshMembers(true);
    this.prefsChanged();
  }

  setUserMuted(userId: string, muted: boolean): void {
    if (!userId) return;
    this.volumes[userId] = { ...this.entry(userId), muted };
    saveJson(VOLUME_KEY, this.volumes);
    this.applyVolumes();
    this.refreshMembers(true);
    this.prefsChanged();
  }

  setStreamVolume(userId: string, volume: number): void {
    if (!userId) return;
    this.streamVolumes[userId] = Math.max(0, Math.min(200, Math.round(volume)));
    saveJson(STREAM_VOLUME_KEY, this.streamVolumes);
    this.applyVolumes();
    this.refreshMembers(true);
    this.prefsChanged();
  }

  /** Apply per-person and per-stream volumes. Deafen is volume 0 for everyone. */
  private applyVolumes(): void {
    const room = this.room;
    if (!room) return;
    const deaf = this.state.deafened;
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      const userId = matrixUserFromIdentity(p.identity);
      const e = this.entry(userId);
      p.setVolume(deaf || e.muted ? 0 : e.volume / 100, Track.Source.Microphone);
      p.setVolume(deaf || this.streamMuted(userId) ? 0 : this.streamVolume(userId) / 100, Track.Source.ScreenShareAudio);
    });
  }

  /* ----------------------------------------------------------------- limiter */

  /** Limiter on one voice: a fast 20:1 compressor with the makeup gain removed. */
  private limitVoice(track: RemoteAudioTrack, sid: string): void {
    const ctx = this.mixCtx;
    const level = LIMITER[this.state.settings.limiter];
    if (!ctx) return;
    if (!level) {
      const old = this.limiters.get(sid);
      if (old) {
        this.limiters.delete(sid);
        track.setWebAudioPlugins([]);
        old.comp.disconnect();
        old.trim.disconnect();
      }
      return;
    }
    let chain = this.limiters.get(sid);
    if (!chain) {
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 4;
      comp.ratio.value = 20;
      // 3 ms attack catches a shout before it hurts, the release is smooth
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      chain = { comp, trim: ctx.createGain() };
      this.limiters.set(sid, chain);
      track.setWebAudioPlugins([chain.comp, chain.trim]);
    }
    chain.comp.threshold.setTargetAtTime(level.threshold, ctx.currentTime, 0.05);
    chain.trim.gain.setTargetAtTime(Math.pow(10, -level.makeup / 20), ctx.currentTime, 0.05);
  }

  /** The setting changed: rebuild the limiter on everyone already talking. */
  private applyLimiter(): void {
    this.room?.remoteParticipants.forEach((p) => {
      const pub = p.getTrackPublication(Track.Source.Microphone);
      if (pub?.track instanceof RemoteAudioTrack) this.limitVoice(pub.track, pub.trackSid);
    });
  }

  /* ----------------------------------------------------------- subscriptions */

  /**
   * Voice and cameras always; screen shares only of those being watched. The
   * video of the person under the mouse in the channel list is subscribed
   * too, without audio, for the hover preview.
   */
  private policy(pub: RemoteTrackPublication, p: RemoteParticipant): void {
    const id = p.identity;
    const want =
      pub.source === Track.Source.ScreenShare
        ? this.watching.has(id) || this.peeking.has(id)
        : pub.source === Track.Source.ScreenShareAudio
          ? this.watching.has(id)
          : true;
    if (pub.isSubscribed !== want) pub.setSubscribed(want);
  }

  private applyPolicy(): void {
    this.room?.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.policy(pub, p)));
  }

  watch(identity: string): void {
    const was = this.watching.has(identity);
    this.watching.add(identity);
    this.applyPolicy();
    if (!was) this.send({ t: "watch", on: true }, identity);
    this.refreshMembers(true);
  }

  unwatch(identity: string): void {
    const was = this.watching.has(identity);
    this.watching.delete(identity);
    this.lostAt.delete(identity);
    this.applyPolicy();
    if (was) this.send({ t: "watch", on: false }, identity);
    this.refreshMembers(true);
  }

  isWatching(identity: string): boolean {
    return this.watching.has(identity);
  }

  /** Hover preview: subscribe to the share video while the mouse is over the person. */
  peek(identity: string, on: boolean): void {
    if (on) this.peeking.add(identity);
    else this.peeking.delete(identity);
    this.applyPolicy();
  }

  /** Share video of a participant: the own one always, a remote one once subscribed. */
  screenTrackOf(identity: string): LocalVideoTrack | RemoteVideoTrack | null {
    const room = this.room;
    if (!room) return null;
    if (identity === room.localParticipant.identity) return this.screenTrack;
    const pub = room.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.ScreenShare);
    return (pub?.track as RemoteVideoTrack | undefined) ?? null;
  }

  /* ---------------------------------------------------------- participants */

  private held(identity: string, speaking: boolean, now: number): boolean {
    if (speaking) {
      this.speakHold.set(identity, now + SPEAK_HOLD_MS);
      return true;
    }
    return (this.speakHold.get(identity) ?? 0) > now;
  }

  private refreshMembers(force = false): void {
    const room = this.room;
    if (!room) {
      if (this.state.members.length || this.state.videos.length || this.state.streams.length) {
        this.signature = "";
        this.patch({ members: [], videos: [], streams: [] });
      }
      return;
    }

    const now = performance.now();
    const members: VoiceMember[] = [];
    const videos: VoiceVideo[] = [];
    const streams: VoiceStream[] = [];

    const collect = (p: Participant, local: boolean): void => {
      const userId = matrixUserFromIdentity(p.identity);
      const name = p.name || userId || p.identity;
      const cam = p.getTrackPublication(Track.Source.Camera);
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      const screenAudio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const muted = local ? this.state.muted : !mic || mic.isMuted;
      const deafened = local ? this.state.deafened : !!this.remoteDeaf.get(p.identity);
      // the own speaking flag comes from the gate: exactly what was sent;
      // a deafened user hears nobody, so nobody lights up for them either
      const talking = local ? this.meterState.open : !this.state.deafened && p.isSpeaking;
      const sharing = !!screen && !screen.isMuted;
      const watching = this.watching.has(p.identity);

      members.push({
        id: p.identity,
        userId,
        name,
        speaking: muted ? false : this.held(p.identity, talking, now),
        muted,
        deafened,
        local,
        camera: !!cam && !cam.isMuted,
        screen: sharing,
        volume: local ? 100 : this.userVolume(userId),
        localMuted: local ? false : this.userMuted(userId),
      });

      if (sharing) {
        streams.push({
          identity: p.identity,
          userId,
          name,
          local,
          watching,
          hasAudio: !!screenAudio,
          volume: this.streamVolume(userId),
          muted: !local && this.streamMuted(userId),
          viewers: local ? [...this.viewers] : [],
        });
      }

      const tile = (pub: TrackPublication | undefined, isScreen: boolean) => {
        if (!pub?.track || pub.isMuted) return;
        if (isScreen && !watching) return;
        videos.push({
          key: `${p.identity}|${pub.source}`,
          identity: p.identity,
          userId,
          name,
          screen: isScreen,
          local,
          track: pub.track as LocalVideoTrack | RemoteVideoTrack,
        });
      };
      tile(cam, false);
      tile(screen, true);
    };

    collect(room.localParticipant, true);
    room.remoteParticipants.forEach((p) => collect(p, false));

    // A stopped share has nothing to watch, but a restart should not make
    // viewers press "watch" again, so watching ends after a grace period.
    for (const id of [...this.watching]) {
      if (streams.some((s) => s.identity === id)) {
        this.lostAt.delete(id);
        continue;
      }
      const since = this.lostAt.get(id);
      if (since === undefined) this.lostAt.set(id, now);
      else if (now - since > WATCH_GRACE_MS) {
        this.watching.delete(id);
        this.lostAt.delete(id);
      }
    }

    const signature =
      members
        .map((m) => `${m.id}${+m.speaking}${+m.muted}${+m.deafened}${+m.camera}${+m.screen}${m.volume}${+m.localMuted}`)
        .join("|") +
      "//" +
      videos.map((v) => v.key).join("|") +
      "//" +
      streams.map((s) => `${s.identity}${+s.watching}${+s.hasAudio}${s.volume}${+s.muted}${s.viewers.join(",")}`).join("|");

    if (!force && signature === this.signature) return;
    this.signature = signature;

    const me = members[0];
    this.patch({ members, videos, streams, camera: me?.camera ?? false, screen: me?.screen ?? false });
  }

  /* ---------------------------------------------------------------- devices */

  /** Device labels are hidden until media access is granted, so ask first. */
  async unlockDevices(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // access denied: the list stays unnamed but usable
    }
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const pick = (kind: MediaDeviceKind): DeviceInfo[] =>
        all
          .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
          .map((d, i) => ({ id: d.deviceId, label: d.label || t("voice.device", { n: i + 1 }) }));

      this.patch({
        devices: { mics: pick("audioinput"), speakers: pick("audiooutput"), cams: pick("videoinput") },
      });
    } catch {
      // enumeration unavailable: the system default stays
    }
  }

  /* ------------------------------------------------------------- microphone */

  micOptions(overrides: Partial<AudioSettings> = {}): MicOptions {
    const s = { ...this.state.settings, ...overrides };
    return {
      deviceId: s.micId,
      denoise: s.denoise,
      autoSensitivity: s.autoSensitivity,
      threshold: s.threshold,
      echo: s.echo,
      gain: s.gain,
      ptt: s.inputMode === "ptt",
      pttDelay: s.pttDelay,
    };
  }

  private setMeter(s: MicState): void {
    const flipped = s.open !== this.meterState.open;
    this.meterState = s;
    this.meterListeners.forEach((l) => l(s));
    if (flipped) this.refreshMembers();
  }

  private async closeMic(): Promise<void> {
    const room = this.room;
    if (this.micTrack && room) {
      try {
        await room.localParticipant.unpublishTrack(this.micTrack);
      } catch {
        // already disconnected
      }
    }
    this.micTrack = null;
    this.micOff?.();
    this.micOff = null;
    await this.mic?.close();
    this.mic = null;
    this.setMeter(QUIET);
  }

  /** Build the chain and publish it. Also used after settings change. */
  private async publishMic(): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    await this.closeMic();

    this.mic = await openMic(this.micOptions());
    this.micOff = this.mic.onState((s) => this.setMeter(s));
    this.mic.setPtt(this.state.settings.inputMode === "ptt", this.pttHeld, this.state.settings.pttDelay);
    if (this.mic.fellBack) {
      // forget the missing device so it does not fail every time
      const settings = { ...this.state.settings, micId: "" };
      saveJson(SETTINGS_KEY, settings);
      this.patch({ settings, error: t("voice.err.micGone") });
    }
    this.micTrack = new LocalAudioTrack(this.mic.track);
    await room.localParticipant.publishTrack(this.micTrack, { source: Track.Source.Microphone });
    if (this.state.muted) await this.micTrack.mute();
  }

  /**
   * The microphone did not open. The call goes on: listening works without
   * it, and unmuting retries.
   */
  private micFailed(e: unknown): void {
    const err = e as { name?: string; message?: string };
    const why = /NotAllowed|Permission/i.test(err?.name ?? "")
      ? t("voice.err.micDenied")
      : /NotFound/i.test(err?.name ?? "")
        ? t("voice.err.micNone")
        : err?.message || String(e);
    this.patch({ muted: true, error: t("voice.err.micFailed", { why }) });
  }

  async applySettings(patch: Partial<AudioSettings>): Promise<void> {
    const next = { ...this.state.settings, ...patch };
    saveJson(SETTINGS_KEY, next);
    this.patch({ settings: next });

    // sensitivity and push-to-talk change in place, without rebuilding the chain
    if (patch.autoSensitivity !== undefined || patch.threshold !== undefined) {
      this.mic?.setSensitivity(next.autoSensitivity, next.threshold);
    }
    if (patch.inputMode !== undefined || patch.pttDelay !== undefined) {
      if (next.inputMode !== "ptt") this.pttHeld = false;
      this.mic?.setPtt(next.inputMode === "ptt", this.pttHeld, next.pttDelay);
    }
    if (patch.limiter !== undefined) this.applyLimiter();
    if (patch.limiter !== undefined || patch.sounds !== undefined) this.prefsChanged();

    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;

    if (patch.spkId !== undefined && patch.spkId) {
      try {
        await room.switchActiveDevice("audiooutput", patch.spkId);
      } catch (e) {
        this.patch({ error: t("voice.err.output", { error: String(e) }) });
      }
    }

    const recapture =
      patch.micId !== undefined || patch.denoise !== undefined || patch.echo !== undefined || patch.gain !== undefined;
    if (recapture) {
      try {
        await this.publishMic();
        this.patch({ error: "" });
      } catch (e) {
        this.micFailed(e);
      }
    }
    this.refreshMembers(true);
  }

  /** Push-to-talk key pressed or released. Ignored in voice activity mode. */
  setPttHeld(held: boolean): void {
    if (this.state.settings.inputMode !== "ptt" || held === this.pttHeld) return;
    this.pttHeld = held;
    this.mic?.setPtt(true, held, this.state.settings.pttDelay);
  }

  /* ------------------------------------------------------------ data channel */

  /** Send a packet to everyone, or to one participant. */
  private send(packet: Packet, to?: string): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    void room.localParticipant
      .publishData(encoder.encode(JSON.stringify(packet)), {
        reliable: true,
        topic: TOPIC,
        destinationIdentities: to ? [to] : undefined,
      })
      .catch(() => undefined);
  }

  private sendState(to?: string): void {
    this.send({ t: "state", deaf: this.state.deafened }, to);
  }

  private receive(payload: Uint8Array, from: RemoteParticipant | undefined, topic: string | undefined): void {
    if (topic !== TOPIC || !from) return;
    let packet: Packet;
    try {
      packet = JSON.parse(decoder.decode(payload)) as Packet;
    } catch {
      return;
    }
    if (packet.t === "state") {
      this.remoteDeaf.set(from.identity, !!packet.deaf);
      this.refreshMembers(true);
    } else if (packet.t === "watch") {
      if (!this.screenTrack) return;
      if (packet.on && !this.viewers.has(from.identity)) {
        this.viewers.add(from.identity);
        this.sound("viewerJoin");
      } else if (!packet.on) this.viewers.delete(from.identity);
      this.refreshMembers(true);
    } else if (packet.t === "kick") {
      // the sender's identity is signed by the JWT service; its role is checked in the room
      const userId = matrixUserFromIdentity(from.identity);
      if (userId && this.kickAllowed(userId)) this.onKicked(userId);
    }
  }

  /** Ask a participant's client to leave the call. Moderators only; the target checks the role itself. */
  kick(identity: string): void {
    this.send({ t: "kick" }, identity);
  }

  /** Identities connected to the call right now, the own one included. */
  presentIdentities(): string[] {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return [];
    return [room.localParticipant.identity, ...room.remoteParticipants.keys()];
  }

  /**
   * Listening to oneself in settings: while it runs the call hears nothing
   * from us and we hear nothing from it. The previous state comes back after.
   */
  async holdForTest(on: boolean): Promise<void> {
    if (on) {
      // outside a call there is nobody to protect
      if (this.testHold || !this.state.connected) return;
      this.testHold = { muted: this.state.muted, deafened: this.state.deafened };
      await this.micTrack?.mute();
      this.patch({ muted: true, deafened: true });
    } else {
      const hold = this.testHold;
      if (!hold) return;
      this.testHold = null;
      if (!hold.muted) await this.micTrack?.unmute();
      this.patch({ muted: hold.muted, deafened: hold.deafened });
    }
    this.applyVolumes();
    this.sendState();
    this.refreshMembers(true);
  }

  /* -------------------------------------------------------------- connection */

  private attach(track: RemoteTrack, publication: RemoteTrackPublication): void {
    if (!(track instanceof RemoteAudioTrack)) return;
    // the limiter goes in before attaching so LiveKit builds the chain with it
    if (publication.source === Track.Source.Microphone) this.limitVoice(track, publication.trackSid);
    // Chromium needs a media element before WebRTC audio reaches an AudioContext; it stays silent itself
    const el = track.attach();
    el.dataset.sid = publication.trackSid;
    this.container().appendChild(el);
    this.applyVolumes();
  }

  private detach(track: RemoteTrack, publication: RemoteTrackPublication): void {
    const chain = this.limiters.get(publication.trackSid);
    chain?.comp.disconnect();
    chain?.trim.disconnect();
    this.limiters.delete(publication.trackSid);
    track.detach().forEach((el) => el.remove());
  }

  async connect(roomId: string, url: string, token: string): Promise<void> {
    await this.disconnect();
    this.patch({ ...blank(), roomId, connecting: true });
    this.watching.clear();
    this.peeking.clear();
    this.lostAt.clear();

    this.mixCtx = new AudioContext({ latencyHint: "interactive" });
    // Adaptive stream would pick video layers by tile size and pause hidden
    // tiles; every size change then costs a keyframe and a blurry second.
    // Cameras are few and shares are subscribed on demand anyway, so the best
    // layer is always received.
    const room = new Room({ adaptiveStream: false, dynacast: true, webAudioMix: { audioContext: this.mixCtx } });
    this.room = room;
    this.remoteDeaf.clear();
    this.viewers.clear();

    const refresh = () => this.refreshMembers();
    const force = () => this.refreshMembers(true);

    room
      .on(RoomEvent.TrackSubscribed, (track, publication) => {
        this.attach(track, publication);
        force();
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        this.detach(track, publication);
        force();
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        this.policy(publication, participant);
        if (publication.source === Track.Source.ScreenShare) {
          this.sound("streamStart");
          // a restarted share: the sharer forgot its viewers
          if (this.watching.has(participant.identity)) this.send({ t: "watch", on: true }, participant.identity);
        }
        force();
      })
      .on(RoomEvent.TrackUnpublished, (publication) => {
        if (publication.source === Track.Source.ScreenShare) this.sound("streamStop");
        force();
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.applyVolumes();
        this.sound("userJoin");
        this.sendState(participant.identity);
        force();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.sound("userLeave");
        this.remoteDeaf.delete(participant.identity);
        this.viewers.delete(participant.identity);
        force();
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => this.receive(payload, participant, topic))
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.LocalTrackPublished, force)
      .on(RoomEvent.LocalTrackUnpublished, (publication) => {
        // the shared window was closed or the system stopped the capture: drop the audio too
        if (publication.source === Track.Source.ScreenShare && this.screenTrack && publication.track === this.screenTrack) {
          void this.stopScreen();
        }
        force();
      })
      .on(RoomEvent.MediaDevicesChanged, () => void this.refreshDevices())
      .on(RoomEvent.Disconnected, () => {
        this.patch({ connected: false, connecting: false, members: [], videos: [], streams: [] });
      });

    try {
      // remote screen shares are subscribed on demand
      await room.connect(url, token, { autoSubscribe: false });
      this.applyPolicy();
      this.patch({ connected: true, connecting: false });
      try {
        await this.publishMic();
      } catch (e) {
        this.micFailed(e);
      }
      if (this.state.settings.spkId) {
        try {
          await room.switchActiveDevice("audiooutput", this.state.settings.spkId);
        } catch {
          // the saved output device is gone, the system default stays
        }
      }
    } catch (e) {
      this.patch({ connecting: false, error: String(e) });
      await this.disconnect();
      throw e;
    }

    this.sound("join");
    this.sendState();
    // remote speaking flags are held for a moment and must be released on time
    this.holdTimer = window.setInterval(() => this.refreshMembers(), 150);
    this.applyVolumes();
    this.refreshMembers(true);
    void this.refreshDevices();
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    const live = !!room && room.state === ConnectionState.Connected;

    if (live && !muted && !this.micTrack) {
      // the microphone failed on join: try again
      try {
        await this.publishMic();
      } catch (e) {
        this.micFailed(e);
        return;
      }
    }
    if (muted) await this.micTrack?.mute();
    else await this.micTrack?.unmute();
    // a manual change ends listening to oneself: its state is not restored over it
    this.testHold = null;

    // unmuting also undeafens, like in Discord
    const wasDeaf = this.state.deafened;
    this.patch({ muted, deafened: muted ? this.state.deafened : false });
    if (!muted && wasDeaf) {
      this.applyVolumes();
      this.sendState();
    }
    this.saveSelf();
    this.sound(muted ? "mute" : "unmute");
    this.refreshMembers(true);
  }

  toggleMuted(): Promise<void> {
    return this.setMuted(!this.state.muted);
  }

  async setDeafened(deafened: boolean): Promise<void> {
    this.testHold = null;
    if (deafened) {
      // deafened implies muted
      this.mutedBeforeDeaf = this.state.muted;
      await this.micTrack?.mute();
      this.patch({ deafened: true, muted: true });
    } else {
      const restore = this.mutedBeforeDeaf;
      if (!restore) await this.micTrack?.unmute();
      this.patch({ deafened: false, muted: restore });
    }
    this.applyVolumes();
    this.sendState();
    this.saveSelf();
    this.sound(deafened ? "deafen" : "undeafen");
    this.refreshMembers(true);
  }

  toggleDeafened(): Promise<void> {
    return this.setDeafened(!this.state.deafened);
  }

  /* ------------------------------------------------------------------ camera */

  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    if (deviceId !== undefined && deviceId !== this.state.settings.camId) {
      const settings = { ...this.state.settings, camId: deviceId };
      saveJson(SETTINGS_KEY, settings);
      this.patch({ settings });
      // the camera is already on: switching the device is enough
      if (on && this.state.camera) {
        try {
          await room.switchActiveDevice("videoinput", deviceId);
          this.refreshMembers(true);
          return;
        } catch {
          await room.localParticipant.setCameraEnabled(false);
        }
      }
    }

    const enable = (camId: string) =>
      room.localParticipant.setCameraEnabled(
        on,
        { deviceId: camId ? { exact: camId } : undefined, resolution: VideoPresets.h720.resolution },
        { videoEncoding: CAMERA_ENCODING, simulcast: true, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360] },
      );
    try {
      try {
        await enable(this.state.settings.camId);
      } catch (e) {
        // the saved camera is gone: try the system default
        if (!on || !this.state.settings.camId || !/NotFound|Overconstrained|not found/i.test(String(e))) throw e;
        await enable("");
        const settings = { ...this.state.settings, camId: "" };
        saveJson(SETTINGS_KEY, settings);
        this.patch({ settings });
      }
      this.patch({ error: "" });
    } catch (e) {
      this.patch({ error: t("voice.err.camera", { error: String(e) }) });
    }
    this.refreshMembers(true);
  }

  /* ------------------------------------------------------------ screen share */

  /**
   * Share audio through the native helper: a window shares only its own
   * program, a screen shares everything except this app, so viewers do not hear
   * their own voices echoed from the speakers.
   *
   * Switching windows keeps the same audio track and restarts only the
   * helper, so viewers do not resubscribe.
   */
  private async startScreenAudio(sourceId: string): Promise<void> {
    const room = this.room;
    if (!room) return;

    const stop = this.stopHelper;
    this.stopHelper = null;
    await stop?.();

    let feed = this.screenFeed;
    const fresh = !feed;
    if (!feed) {
      feed = await openPcmFeed();
      this.screenFeed = feed;
    }
    try {
      this.stopHelper = await startScreenAudio(
        sourceId,
        (chunk) => this.screenFeed?.push(chunk),
        (reason) => {
          if (reason) this.patch({ error: t("voice.err.shareAudioStopped", { reason }) });
        },
      );
    } catch (e) {
      await this.stopScreenAudio();
      this.patch({ error: t("voice.err.shareNoAudio", { error: String((e as Error)?.message ?? e) }) });
      return;
    }
    if (!fresh) return;
    this.screenAudio = new LocalAudioTrack(feed.track);
    await room.localParticipant.publishTrack(this.screenAudio, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
  }

  private async stopScreenAudio(): Promise<void> {
    const room = this.room;
    const track = this.screenAudio;
    this.screenAudio = null;
    if (track && room) {
      try {
        await room.localParticipant.unpublishTrack(track);
      } catch {
        // already unpublished
      }
    }
    const stop = this.stopHelper;
    this.stopHelper = null;
    await stop?.();
    const feed = this.screenFeed;
    this.screenFeed = null;
    await feed?.close();
  }

  /** Capture a screen or window. In Electron the source was picked by our own dialog. */
  private async captureScreen(sourceId: string | null, engineAudio: boolean, q: ShareOptions): Promise<MediaStream> {
    if (sourceId) await setScreenSource(sourceId, engineAudio);
    return navigator.mediaDevices.getDisplayMedia({
      video: shareConstraints(q),
      audio: engineAudio,
      systemAudio: engineAudio ? "include" : "exclude",
      selfBrowserSurface: "exclude",
    } as DisplayMediaStreamOptions);
  }

  /** Bitrate and frame rate for the current picture size. Called after every capture change. */
  private async tuneScreen(track: LocalVideoTrack, fps: number): Promise<{ width: number; height: number }> {
    const mst = track.mediaStreamTrack;
    this.shareFps = fps;
    // games want smoothness, text and code want sharpness
    mst.contentHint = fps > 30 ? "motion" : "detail";
    const s = mst.getSettings();
    const width = s.width ?? 1920;
    const height = s.height ?? 1080;
    const enc = shareEncoding(width, height, fps);
    const pref = degradation(fps);
    if (track.publishOptions) track.publishOptions = { ...track.publishOptions, screenShareEncoding: enc, degradationPreference: pref };
    await track.setDegradationPreference(pref).catch(() => undefined);
    const sender = track.sender;
    if (sender) {
      try {
        const params = sender.getParameters();
        params.encodings?.forEach((e) => {
          e.maxBitrate = enc.maxBitrate;
          e.maxFramerate = enc.maxFramerate;
          e.priority = "high";
          e.networkPriority = "high";
        });
        await sender.setParameters(params);
      } catch {
        // sender not ready yet: LiveKit applies publishOptions itself
      }
    }
    return { width, height };
  }

  /** Start sharing. `sourceId` comes from our picker; null lets the system ask. */
  async startScreen(sourceId: string | null, opts: ShareOptions): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.patch({ error: t("voice.err.noCapture") });
      return;
    }
    if (this.screenTrack) await this.stopScreen(true);

    const helper = opts.audio && hasAppAudio && !!sourceId;
    const engineAudio = opts.audio && !helper;

    let stream: MediaStream;
    try {
      stream = await this.captureScreen(sourceId, engineAudio, opts);
    } catch (e) {
      // closing the system picker is not an error
      if (!isCancel(e)) this.patch({ error: t("voice.err.shareFailed", { error: String(e) }) });
      return;
    }

    const video = stream.getVideoTracks()[0];
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      this.patch({ error: t("voice.err.shareNoVideo") });
      return;
    }

    const codec = screenCodec(this.state.settings.shareCodec);
    let track: LocalVideoTrack;
    try {
      track = await this.publishScreen(video, opts.fps, codec);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      this.patch({ error: t("voice.err.shareFailed", { error: String(e) }) });
      return;
    }
    this.screenTrack = track;
    this.viewers.clear();
    const dims = await this.tuneScreen(track, opts.fps);
    if (codec === "h264" && this.state.settings.shareCodec === "auto") this.watchEncoder(track);

    const sysAudio = stream.getAudioTracks()[0];
    if (sysAudio) {
      this.engineAudio = new LocalAudioTrack(sysAudio, undefined, false);
      try {
        await room.localParticipant.publishTrack(this.engineAudio, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          forceStereo: true,
          audioPreset: AudioPresets.musicHighQualityStereo,
        });
      } catch {
        this.engineAudio.stop();
        this.engineAudio = null;
      }
    }
    if (helper && sourceId) await this.startScreenAudio(sourceId);

    this.patch({
      error: "",
      share: { sourceId: sourceId ?? "", name: opts.name, audio: opts.audio, ...dims, fps: opts.fps },
    });
    this.sound("streamStart");
    this.refreshMembers(true);
  }

  private async publishScreen(video: MediaStreamTrack, fps: number, codec: "h264" | "vp8"): Promise<LocalVideoTrack> {
    const room = this.room;
    if (!room) throw new Error("not connected");
    const track = new LocalVideoTrack(video, undefined, false);
    track.source = Track.Source.ScreenShare;
    const first = video.getSettings();
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShare,
      // one layer: nobody watches the lower ones and upload is limited
      simulcast: false,
      videoCodec: codec,
      screenShareEncoding: shareEncoding(first.width ?? 1920, first.height ?? 1080, fps),
      degradationPreference: degradation(fps),
    });
    return track;
  }

  /**
   * Some GPUs accept the H264 encoder and then produce nothing: viewers get a
   * black tile while the sharer sees the local preview. Once somebody watches
   * (the layer is active) and not a single frame came out for a few seconds,
   * the same capture is published again as VP8 on the CPU.
   */
  private watchEncoder(track: LocalVideoTrack): void {
    window.clearInterval(this.codecWatch);
    let silentFor = 0;
    let last = performance.now();
    this.codecWatch = window.setInterval(() => {
      if (this.screenTrack !== track) {
        window.clearInterval(this.codecWatch);
        return;
      }
      const sender = track.sender;
      if (!sender) return;
      void sender.getStats().then((stats) => {
        const now = performance.now();
        const step = now - last;
        last = now;
        let frames = 0;
        stats.forEach((s: Record<string, any>) => {
          if (s.type === "outbound-rtp" && s.kind === "video") frames += Number(s.framesEncoded ?? 0);
        });
        const active = sender.getParameters().encodings?.some((e) => e.active !== false) ?? false;
        if (frames > 0) {
          window.clearInterval(this.codecWatch);
          return;
        }
        silentFor = active ? silentFor + step : 0;
        if (silentFor >= ENCODER_STALL_MS) {
          window.clearInterval(this.codecWatch);
          void this.moveToVp8(track);
        }
      });
    }, 1000);
  }

  private async moveToVp8(old: LocalVideoTrack): Promise<void> {
    const room = this.room;
    if (!room || this.screenTrack !== old) return;
    const video = old.mediaStreamTrack;
    // not the own stop: the unpublish handler must not end the share
    this.screenTrack = null;
    try {
      await room.localParticipant.unpublishTrack(old, false);
    } catch {
      // already gone
    }
    try {
      const track = await this.publishScreen(video, this.shareFps, "vp8");
      this.screenTrack = track;
      await this.tuneScreen(track, this.shareFps);
      this.patch({ error: t("voice.err.gpuFallback") });
    } catch (e) {
      video.stop();
      await this.stopScreenAudio();
      this.patch({ share: null, error: t("voice.err.shareFailed", { error: String(e) }) });
    }
    this.refreshMembers(true);
  }

  /** Switch to another window without stopping: the picture is replaced in the same track. */
  async switchScreen(sourceId: string | null, opts: ShareOptions): Promise<void> {
    const room = this.room;
    const track = this.screenTrack;
    if (!room || !track) {
      await this.startScreen(sourceId, opts);
      return;
    }
    const helper = opts.audio && hasAppAudio && !!sourceId;
    // engine audio comes bundled with the picture, such a share is simpler to restart
    if (this.engineAudio || (opts.audio && !helper)) {
      await this.startScreen(sourceId, opts);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await this.captureScreen(sourceId, false, opts);
    } catch (e) {
      if (!isCancel(e)) this.patch({ error: t("voice.err.switchFailed", { error: String(e) }) });
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (!video) return;
    stream.getAudioTracks().forEach((t) => t.stop());

    // LiveKit reads publishOptions during the replacement to recompute the bitrate
    const guess = video.getSettings();
    if (track.publishOptions) {
      track.publishOptions = {
        ...track.publishOptions,
        screenShareEncoding: shareEncoding(guess.width ?? 1920, guess.height ?? 1080, opts.fps),
      };
    }
    try {
      await track.replaceTrack(video, false);
    } catch (e) {
      video.stop();
      this.patch({ error: t("voice.err.switchFailed", { error: String(e) }) });
      return;
    }
    const dims = await this.tuneScreen(track, opts.fps);

    if (helper && sourceId) await this.startScreenAudio(sourceId);
    else await this.stopScreenAudio();

    this.patch({
      error: "",
      share: { sourceId: sourceId ?? "", name: opts.name, audio: opts.audio, ...dims, fps: opts.fps },
    });
    this.refreshMembers(true);
  }

  /** Change quality on the fly with the same source: no restart, no flicker for viewers. */
  async setShareQuality(opts: ShareOptions): Promise<void> {
    const track = this.screenTrack;
    const share = this.state.share;
    if (!track || !share) return;

    // without the helper, audio comes with the picture: turning it on needs a new capture
    const helperAudio = !!share.sourceId && hasAppAudio && !this.engineAudio;
    if (opts.audio !== share.audio && !helperAudio) {
      await this.startScreen(share.sourceId || null, opts);
      return;
    }

    try {
      await track.mediaStreamTrack.applyConstraints(shareConstraints(opts));
    } catch {
      // the capture rejected the new constraints: recapture the same source
      await this.switchScreen(share.sourceId || null, opts);
      return;
    }
    const dims = await this.tuneScreen(track, opts.fps);

    if (opts.audio !== share.audio) {
      if (opts.audio) await this.startScreenAudio(share.sourceId);
      else await this.stopScreenAudio();
    }
    this.patch({ share: { ...share, ...dims, fps: opts.fps, audio: opts.audio } });
  }

  async stopScreen(quiet = false): Promise<void> {
    const room = this.room;
    if (!room) return;
    const track = this.screenTrack;
    const engine = this.engineAudio;
    this.screenTrack = null;
    this.engineAudio = null;
    this.viewers.clear();
    window.clearInterval(this.codecWatch);
    await this.stopScreenAudio();
    for (const tr of [engine, track]) {
      if (!tr) continue;
      try {
        await room.localParticipant.unpublishTrack(tr);
      } catch {
        // already unpublished
      }
      tr.stop();
    }
    this.watching.delete(room.localParticipant.identity);
    this.patch({ share: null });
    if (track && !quiet) this.sound("streamStop");
    this.refreshMembers(true);
  }

  /** Video codecs enabled on the LiveKit server: without H264 it silently falls back to VP8. */
  private serverCodecs(): string[] {
    const lp = this.room?.localParticipant as unknown as { enabledPublishVideoCodecs?: { mime: string }[] } | undefined;
    return (lp?.enabledPublishVideoCodecs ?? []).map((c) => c.mime.replace(/^video\//i, "").toUpperCase());
  }

  /** How the own share is being encoded right now. */
  async shareCodec(): Promise<CodecInfo | null> {
    const sender = this.screenTrack?.sender;
    if (!sender) return null;
    const info = await readCodec(sender, "outbound-rtp").catch(() => null);
    return info ? { ...info, serverCodecs: this.serverCodecs() } : null;
  }

  /** How a watched share is being decoded. */
  async watchCodec(identity: string): Promise<CodecInfo | null> {
    const pub = this.room?.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.ScreenShare);
    const receiver = (pub?.track as RemoteVideoTrack | undefined)?.receiver;
    if (!receiver) return null;
    const info = await readCodec(receiver, "inbound-rtp").catch(() => null);
    return info ? { ...info, serverCodecs: this.serverCodecs() } : null;
  }

  localIdentity(): string {
    return this.room?.localParticipant.identity ?? "";
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    const wasConnected = this.state.connected;
    window.clearInterval(this.holdTimer);
    window.clearInterval(this.codecWatch);
    this.holdTimer = 0;
    this.remoteDeaf.clear();
    this.viewers.clear();
    await this.stopScreenAudio();
    await this.closeMic();
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.engineAudio?.stop();
    this.engineAudio = null;
    this.room = null;
    this.watching.clear();
    this.peeking.clear();
    this.lostAt.clear();
    this.speakHold.clear();
    this.signature = "";
    if (this.audioBox) this.audioBox.innerHTML = "";
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.limiters.clear();
    const mix = this.mixCtx;
    this.mixCtx = null;
    await mix?.close().catch(() => undefined);
    if (wasConnected) this.sound("leave");
    this.patch({ ...blank() });
  }
}

export const voice = new VoiceClient();
