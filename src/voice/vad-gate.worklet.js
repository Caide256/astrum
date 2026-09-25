/**
 * Microphone gate: input sensitivity and push-to-talk.
 *
 * Runs on the audio thread rather than page timers: a minimized window gets
 * its timers throttled to once a second, and the gate would open half a word
 * late. Decisions are made every 128 samples, about 2.7 ms.
 *
 * Voice activity mode:
 *   measures the block level in dB;
 *   in automatic mode tracks the noise floor and keeps the threshold above it;
 *   opens when the level exceeds the threshold and holds a little longer so
 *     word endings are not cut;
 *   delays the audio by 30 ms so the gate opens before the word starts.
 * Push-to-talk mode:
 *   passes audio while the key is held, plus a release delay.
 * Every 50 ms it reports the level, the threshold and whether the user speaks.
 */

const LOOKAHEAD_S = 0.03;
const HOLD_S = 0.35;
const REPORT_S = 0.05;

class VadGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.auto = o.auto !== false;
    this.threshold = typeof o.threshold === "number" ? o.threshold : -50;
    this.ptt = !!o.ptt;
    this.pttHeld = false;
    this.pttDelay = (typeof o.pttDelay === "number" ? o.pttDelay : 200) / 1000;
    this.pttUntil = 0;

    const delay = Math.max(1, Math.round(sampleRate * LOOKAHEAD_S));
    this.ring = new Float32Array(delay);
    this.pos = 0;

    this.floor = -70;
    this.open = false;
    this.holdUntil = 0;
    this.gain = 0;
    // ~5 ms attack and ~60 ms release: no clicks, no chopped word endings
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.005));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.06));

    this.lastReport = 0;
    this.peakDb = -120;
    this.wasOpen = false;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.auto === "boolean") this.auto = d.auto;
      if (typeof d.threshold === "number") this.threshold = d.threshold;
      if (typeof d.ptt === "boolean") this.ptt = d.ptt;
      if (typeof d.pttDelay === "number") this.pttDelay = d.pttDelay / 1000;
      if (typeof d.pttHeld === "boolean") {
        if (this.pttHeld && !d.pttHeld) this.pttUntil = currentTime + this.pttDelay;
        this.pttHeld = d.pttHeld;
      }
    };
  }

  currentThreshold() {
    if (!this.auto) return this.threshold;
    // noise floor plus a margin: low in a quiet room, higher in a noisy one
    return Math.min(-28, Math.max(-62, this.floor + 16));
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    let sum = 0;
    for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -140;
    if (db > this.peakDb) this.peakDb = db;

    // The floor falls fast and rises slowly, and only in pauses: learning on
    // speech would drag the threshold up to the voice during a long monologue.
    if (db < this.floor) this.floor += (db - this.floor) * 0.05;
    else if (!this.open) this.floor += (db - this.floor) * 0.0004;
    if (this.floor < -90) this.floor = -90;

    const thr = this.currentThreshold();
    let transmit;
    if (this.ptt) {
      transmit = this.pttHeld || currentTime < this.pttUntil;
      this.open = transmit && db > thr;
    } else {
      if (db > thr) {
        this.open = true;
        this.holdUntil = currentTime + HOLD_S;
      } else if (this.open && currentTime > this.holdUntil) {
        this.open = false;
      }
      transmit = this.open;
    }

    const target = transmit ? 1 : 0;
    const ring = this.ring;
    for (let i = 0; i < input.length; i += 1) {
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      const delayed = ring[this.pos];
      ring[this.pos] = input[i];
      this.pos = (this.pos + 1) % ring.length;
      output[i] = delayed * this.gain;
    }

    if (currentTime - this.lastReport >= REPORT_S || this.open !== this.wasOpen) {
      this.port.postMessage({ db: this.peakDb, open: this.open, threshold: thr, floor: this.floor });
      this.lastReport = currentTime;
      this.peakDb = -120;
      this.wasOpen = this.open;
    }
    return true;
  }
}

registerProcessor("vad-gate", VadGate);
