import {
  GtcrnWorkletNode,
  RnnoiseWorkletNode,
  SpeexWorkletNode,
  loadGtcrn,
  loadRnnoise,
  loadSpeex,
} from "@sapphi-red/web-noise-suppressor";

import gtcrnWasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import speexWasmUrl from "@sapphi-red/web-noise-suppressor/speex.wasm?url";
import gtcrnWorkletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import speexWorkletUrl from "@sapphi-red/web-noise-suppressor/speexWorklet.js?url";
import type { Key } from "../i18n/index.ts";
import gateWorkletUrl from "./vad-gate.worklet.js?url";
import feedWorkletUrl from "./pcm-feed.worklet.js?url";

/**
 * Microphone chain:
 *
 *   device -> noise suppression (optional) -> gate -> LiveKit
 *
 * The browser suppressor only handles steady noise such as fans and barely
 * touches keyboard and mouse clicks, hence the neural options in AudioWorklet.
 * The gate (vad-gate.worklet.js) mutes everything below the threshold, decides
 * whether the user is speaking and implements push-to-talk, so the speaking
 * indicator shows exactly what is sent.
 */

export type Denoise = "off" | "browser" | "rnnoise" | "gtcrn" | "speex";

export const DENOISE_LIST: { id: Denoise; name: Key; hint: Key }[] = [
  { id: "off", name: "denoise.off", hint: "denoise.off.hint" },
  { id: "browser", name: "denoise.browser", hint: "denoise.browser.hint" },
  { id: "rnnoise", name: "denoise.rnnoise", hint: "denoise.rnnoise.hint" },
  { id: "gtcrn", name: "denoise.gtcrn", hint: "denoise.gtcrn.hint" },
  { id: "speex", name: "denoise.speex", hint: "denoise.speex.hint" },
];

export type MicOptions = {
  deviceId: string;
  denoise: Denoise;
  autoSensitivity: boolean;
  threshold: number;
  echo: boolean;
  gain: boolean;
  /** Push-to-talk: the gate opens only while the key is held. */
  ptt: boolean;
  /** How long the gate stays open after the push-to-talk key is released, ms. */
  pttDelay: number;
};

/** Gate report: level in dB, whether the user is speaking, current threshold. */
export type MicState = { db: number; open: boolean; threshold: number };

export type MicChain = {
  track: MediaStreamTrack;
  /** The saved device is gone and the system default was used instead. */
  fellBack: boolean;
  state: () => MicState;
  onState: (cb: (s: MicState) => void) => () => void;
  setSensitivity: (auto: boolean, threshold: number) => void;
  setPtt: (ptt: boolean, held: boolean, delayMs: number) => void;
  close: () => Promise<void>;
};

/** Level in dB mapped to 0..1 over -80..0 dB. */
export function dbToUnit(db: number): number {
  return Math.max(0, Math.min(1, (db + 80) / 80));
}

const wasmCache: Partial<Record<Denoise, ArrayBuffer>> = {};
const loadedWorklets = new WeakMap<AudioContext, Set<string>>();

async function addWorklet(ctx: AudioContext, url: string): Promise<void> {
  const done = loadedWorklets.get(ctx) ?? new Set<string>();
  loadedWorklets.set(ctx, done);
  if (done.has(url)) return;
  await ctx.audioWorklet.addModule(url);
  done.add(url);
}

async function denoiseNode(ctx: AudioContext, kind: Denoise): Promise<AudioNode | null> {
  if (kind === "rnnoise") {
    await addWorklet(ctx, rnnoiseWorkletUrl);
    wasmCache.rnnoise ??= await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasmCache.rnnoise });
  }
  if (kind === "gtcrn") {
    await addWorklet(ctx, gtcrnWorkletUrl);
    wasmCache.gtcrn ??= await loadGtcrn({ url: gtcrnWasmUrl });
    return new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasmCache.gtcrn });
  }
  if (kind === "speex") {
    await addWorklet(ctx, speexWorkletUrl);
    wasmCache.speex ??= await loadSpeex({ url: speexWasmUrl });
    return new SpeexWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasmCache.speex });
  }
  return null;
}

function isMissingDevice(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return /NotFound|Overconstrained/i.test(err?.name ?? "") || /not found/i.test(err?.message ?? "");
}

/**
 * Open the microphone. Device ids do not survive every reconnect of a
 * headset, so a missing saved device falls back to the system default.
 */
async function capture(opts: MicOptions): Promise<{ stream: MediaStream; fellBack: boolean }> {
  const ask = (deviceId: string) =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // the browser suppressor and a neural one together smear the voice
        noiseSuppression: opts.denoise === "browser",
        echoCancellation: opts.echo,
        autoGainControl: opts.gain,
      },
    });

  try {
    return { stream: await ask(opts.deviceId), fellBack: false };
  } catch (e) {
    if (!opts.deviceId || !isMissingDevice(e)) throw e;
    return { stream: await ask(""), fellBack: true };
  }
}

export async function openMic(opts: MicOptions): Promise<MicChain> {
  const { stream, fellBack } = await capture(opts);

  // RNNoise requires 48 kHz; the other suppressors accept it too
  const ctx = new AudioContext({ sampleRate: 48000 });
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createMediaStreamDestination();
  sink.channelCount = 1;

  let tail: AudioNode = source;
  const extra: AudioNode[] = [];
  try {
    const nd = await denoiseNode(ctx, opts.denoise);
    if (nd) {
      tail.connect(nd);
      tail = nd;
      extra.push(nd);
    }
  } catch (e) {
    // a broken suppressor must not cost the microphone
    console.warn("noise suppressor failed to load, continuing without it", e);
  }

  await addWorklet(ctx, gateWorkletUrl);
  const gate = new AudioWorkletNode(ctx, "vad-gate", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { auto: opts.autoSensitivity, threshold: opts.threshold, ptt: opts.ptt, pttDelay: opts.pttDelay },
  });
  tail.connect(gate);
  gate.connect(sink);

  let last: MicState = { db: -120, open: false, threshold: opts.threshold };
  const listeners = new Set<(s: MicState) => void>();
  gate.port.onmessage = (e: MessageEvent) => {
    last = { db: e.data.db, open: e.data.open, threshold: e.data.threshold };
    listeners.forEach((l) => l(last));
  };

  // the page may not have had a user gesture yet
  if (ctx.state === "suspended") void ctx.resume();

  const track = sink.stream.getAudioTracks()[0];
  return {
    track,
    fellBack,
    state: () => last,
    onState: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setSensitivity: (auto, threshold) => gate.port.postMessage({ auto, threshold }),
    setPtt: (ptt, held, delayMs) => gate.port.postMessage({ ptt, pttHeld: held, pttDelay: delayMs }),
    close: async () => {
      listeners.clear();
      stream.getTracks().forEach((t) => t.stop());
      track.stop();
      extra.forEach((n) => (n as AudioWorkletNode & { destroy?: () => void }).destroy?.());
      await ctx.close().catch(() => undefined);
    },
  };
}

/* --------------------------------------------------------------- mic test */

export type MicTest = { chain: MicChain; stop: () => Promise<void> };

/** Play the processed microphone back into the chosen output device. */
export async function startMicTest(opts: MicOptions, sinkId: string): Promise<MicTest> {
  const chain = await openMic({ ...opts, ptt: false });
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = new MediaStream([chain.track]);
  const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && withSink.setSinkId) {
    await withSink.setSinkId(sinkId).catch(() => undefined);
  }
  await el.play().catch(() => undefined);
  return {
    chain,
    stop: async () => {
      el.pause();
      el.srcObject = null;
      await chain.close();
    },
  };
}

/* ------------------------------------------------------ screen share audio */

export type PcmFeed = {
  track: MediaStreamTrack;
  push: (chunk: ArrayBuffer) => void;
  close: () => Promise<void>;
};

/**
 * Sink for raw PCM from the native helper (16-bit stereo, 48 kHz). Chunks go
 * into a ring buffer inside a worklet; the output is a regular track that can
 * be published as screen share audio.
 */
export async function openPcmFeed(): Promise<PcmFeed> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  await addWorklet(ctx, feedWorkletUrl);
  const node = new AudioWorkletNode(ctx, "pcm-feed", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const sink = ctx.createMediaStreamDestination();
  node.connect(sink);
  if (ctx.state === "suspended") void ctx.resume();

  const track = sink.stream.getAudioTracks()[0];
  return {
    track,
    push: (chunk) => node.port.postMessage(chunk, [chunk]),
    close: async () => {
      track.stop();
      node.disconnect();
      await ctx.close().catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------- UI sounds */

export type Blip =
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "join"
  | "leave"
  | "userJoin"
  | "userLeave"
  | "streamStart"
  | "streamStop"
  | "viewerJoin"
  | "message"
  | "mention";

/** Sounds that belong to message notifications and follow their volume. */
const NOTIFY_SOUNDS = new Set<Blip>(["message", "mention"]);

/** One tone: `bell` adds the octave partial that makes it ring instead of beep. */
type Note = { f: number; at: number; len: number; wave?: OscillatorType; vol?: number; bell?: number };

const seq = (freqs: number[], step: number, len: number, wave: OscillatorType, vol: number, bell = 0): Note[] =>
  freqs.map((f, i) => ({ f, at: i * step, len, wave, vol, bell }));

/**
 * Short synthesized phrases, one per event. People coming and going ring
 * clearly, so a join is noticed during a game; toggles stay short and soft.
 */
const SOUNDS: Record<Blip, Note[]> = {
  mute: seq([880, 587], 0.07, 0.11, "sine", 0.09),
  unmute: seq([587, 880], 0.07, 0.11, "sine", 0.09),
  deafen: seq([659, 440, 330], 0.06, 0.12, "triangle", 0.1),
  undeafen: seq([330, 440, 659], 0.06, 0.12, "triangle", 0.1),
  join: seq([523, 659, 784, 1047], 0.075, 0.2, "sine", 0.11, 0.3),
  leave: seq([784, 659, 523], 0.085, 0.2, "sine", 0.1, 0.25),
  userJoin: seq([659, 988, 1319], 0.085, 0.26, "sine", 0.16, 0.35),
  userLeave: seq([988, 659], 0.1, 0.24, "sine", 0.12, 0.25),
  streamStart: seq([440, 554, 659, 880], 0.055, 0.1, "triangle", 0.08),
  streamStop: seq([880, 659, 554, 440], 0.055, 0.1, "triangle", 0.08),
  viewerJoin: seq([1319, 1760, 2093], 0.06, 0.16, "sine", 0.1, 0.2),
  message: seq([880, 1175], 0.07, 0.14, "sine", 0.12, 0.2),
  mention: seq([1175, 1568, 1175], 0.09, 0.2, "sine", 0.15, 0.35),
};

let blipCtx: AudioContext | null = null;
let blipSink = "";
let uiGain = 1;
let notifyGain = 1;

/** Volumes in percent for interface sounds and for message notifications. */
export function setBlipVolumes(ui: number, notify: number): void {
  const curve = (v: number) => Math.pow(Math.max(0, Math.min(100, v)) / 100, 1.3) * 1.5;
  uiGain = curve(ui);
  notifyGain = curve(notify);
}

/** Play a UI sound on the chosen output device ("" is the system default). */
export function blip(kind: Blip, sinkId = ""): void {
  const master = NOTIFY_SOUNDS.has(kind) ? notifyGain : uiGain;
  if (master <= 0) return;
  try {
    blipCtx ??= new AudioContext();
    const ctx = blipCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId !== blipSink && ctx.setSinkId) {
      blipSink = sinkId;
      void ctx.setSinkId(sinkId).catch(() => undefined);
    }
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime + 0.01;

    for (const n of SOUNDS[kind]) {
      const at = now + n.at;
      const peak = (n.vol ?? 0.08) * master;
      const partials: [number, number][] = [[n.f, 1]];
      if (n.bell) partials.push([n.f * 2, n.bell]);
      for (const [f, share] of partials) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = n.wave ?? "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(peak * share, at + 0.008);
        // the overtone fades faster, like a struck bell
        gain.gain.exponentialRampToValueAtTime(0.0001, at + (share < 1 ? n.len * 0.6 : n.len));
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + n.len + 0.03);
      }
    }
  } catch {
    // no audio output available
  }
}
