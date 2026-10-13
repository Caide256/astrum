/**
 * Player for raw PCM (16-bit stereo) from the native helper.
 *
 * Frames come unevenly (the network, the processes in between) and from a
 * sound card whose clock runs a little faster or slower than this one. A
 * ring buffer keeps a reserve. Instead of skipping when the reserve grows
 * or running dry when it shrinks, playback runs a fraction of a percent
 * faster or slower to hold it where it should be. After a dropout the
 * reserve grows; once things have been calm for a while it shrinks again.
 * Every break fades instead of clicking.
 *
 * Frames come one of two ways: chunks of plain PCM posted to the node (this
 * computer's own sound), or numbered frames, [sequence u32 BE][PCM], on a
 * port handed to the node (a stream's sound, straight from the main process,
 * past the page's busy thread). A lost numbered frame is covered by the one
 * before it, fading; a frame of the number alone is 5 ms of silence (the
 * streamer sends those while nothing plays, so pauses are not dropouts).
 *
 * Every ten seconds the port of the node gets what happened meanwhile, for
 * the stream log: dropouts, lost frames, cuts after a stall, the reserve.
 */

const MIN_TARGET_S = 0.06;
const START_TARGET_S = 0.1;
/** A network that holds sound back behind bursts of the picture needs this much at worst. */
const MAX_TARGET_S = 0.3;
const GROW_S = 0.04;
const CALM_S = 15;
/** At most this much faster or slower: well under what an ear notices. */
const MAX_SKEW = 0.004;
const FADE_SAMPLES = 96;
/** 5 ms at 48 kHz, stereo: a silent numbered frame stands for this. */
const SILENT = new Int16Array(480);

class PcmFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    // a position between samples: playback steps a little more or less than one
    this.read = 0;
    this.write = 0;
    this.primed = false;
    this.target = START_TARGET_S * sampleRate;
    this.fill = this.target;
    this.calmSince = currentTime;
    this.fadeIn = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.lastSeq = -1;
    this.lastFrame = null;
    this.stats = { dropouts: 0, lost: 0, cuts: 0, frames: 0 };
    this.statsAt = currentTime;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.port) {
        d.port.onmessage = (m) => this.frame(m.data);
        return;
      }
      if (d instanceof ArrayBuffer) this.chunk(new Int16Array(d, 0, d.byteLength >> 1), 1);
    };
  }

  /** A numbered frame: one seen before is dropped, a gap of a few is covered. */
  frame(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const seq = new DataView(data).getUint32(0, false);
    if (this.lastSeq >= 0 && seq <= this.lastSeq && this.lastSeq - seq < 1000000) return;
    const pcm = data.byteLength < 8 ? SILENT : new Int16Array(data, 4, (data.byteLength - 4) >> 1);
    const gap = this.lastSeq >= 0 ? seq - this.lastSeq - 1 : 0;
    this.stats.frames += 1;
    if (gap > 0) this.stats.lost += Math.min(gap, 1000);
    if (gap > 0 && gap <= 8 && this.lastFrame) {
      for (let i = 0; i < gap; i += 1) this.chunk(this.lastFrame, 0.5 ** (i + 1));
    }
    this.lastSeq = seq;
    this.lastFrame = pcm;
    this.chunk(pcm, 1);
  }

  chunk(pcm, gain) {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      this.left[this.write] = (pcm[i] / 32768) * gain;
      this.right[this.write] = (pcm[i + 1] / 32768) * gain;
      this.write = (this.write + 1) % this.size;
    }
    // a stall delivered all at once: speeding up would take a minute, so back to the reserve now
    if (this.primed && this.available() > Math.max(0.2 * sampleRate, 2.5 * this.target)) {
      this.read = (this.write - Math.round(this.target) + this.size) % this.size;
      this.fill = this.target;
      this.fadeIn = FADE_SAMPLES;
      this.stats.cuts += 1;
    }
  }

  available() {
    return (this.write - Math.floor(this.read) + this.size) % this.size;
  }

  /** Silence from `from` on, fading out of the last sound instead of cutting it. */
  silence(l, r, from) {
    for (let i = from; i < l.length; i += 1) {
      this.lastL *= 0.95;
      this.lastR *= 0.95;
      l[i] = this.lastL;
      if (r !== l) r[i] = this.lastR;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    const have = this.available();

    // build the reserve first, otherwise the first uneven frames crackle
    if (!this.primed) {
      if (have < this.target) {
        this.silence(l, r, 0);
        return true;
      }
      if (have > 2.5 * this.target) this.read = (this.write - Math.round(this.target) + this.size) % this.size;
      this.primed = true;
      this.fill = this.target;
      this.fadeIn = FADE_SAMPLES;
    }

    // hold the reserve at its target: a little faster when there is more, a little slower when less
    this.fill += (this.available() - this.fill) * 0.01;
    const skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, ((this.fill - this.target) / this.target) * 0.01));
    const step = 1 + skew;

    for (let i = 0; i < l.length; i += 1) {
      const at = Math.floor(this.read);
      const next = (at + 1) % this.size;
      if (at === this.write || next === this.write) {
        // ran dry: fade out, then wait for a bigger reserve than before
        this.silence(l, r, i);
        this.primed = false;
        this.target = Math.min(MAX_TARGET_S * sampleRate, this.target + GROW_S * sampleRate);
        this.calmSince = currentTime;
        this.stats.dropouts += 1;
        return true;
      }
      const frac = this.read - at;
      let vl = this.left[at] + (this.left[next] - this.left[at]) * frac;
      let vr = this.right[at] + (this.right[next] - this.right[at]) * frac;
      if (this.fadeIn > 0) {
        const g = 1 - this.fadeIn / FADE_SAMPLES;
        vl *= g;
        vr *= g;
        this.fadeIn -= 1;
      }
      l[i] = vl;
      if (r !== l) r[i] = vr;
      this.lastL = vl;
      this.lastR = vr;
      this.read += step;
      if (this.read >= this.size) this.read -= this.size;
    }

    // calm for a while: a smaller reserve, the sound closer to the picture
    if (currentTime - this.calmSince > CALM_S && this.target > MIN_TARGET_S * sampleRate) {
      this.target = Math.max(MIN_TARGET_S * sampleRate, this.target - 0.01 * sampleRate);
      this.calmSince = currentTime;
    }
    if (currentTime - this.statsAt >= 10 && this.stats.frames > 0) {
      this.port.postMessage({ stats: { ...this.stats, reserveMs: Math.round((this.fill / sampleRate) * 1000), targetMs: Math.round((this.target / sampleRate) * 1000) } });
      this.stats = { dropouts: 0, lost: 0, cuts: 0, frames: 0 };
      this.statsAt = currentTime;
    }
    return true;
  }
}

registerProcessor("pcm-feed", PcmFeed);
