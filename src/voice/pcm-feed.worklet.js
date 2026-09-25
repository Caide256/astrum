/**
 * Player for raw PCM from the native helper.
 *
 * Chunks arrive every 10 ms but unevenly: IPC between processes delays some
 * and delivers others in bursts. A ring buffer keeps about 60 ms of reserve;
 * when a burst grows the reserve past the limit, the excess is dropped so the
 * audio does not drift behind the picture.
 */

const TARGET_S = 0.06;
const MAX_S = 0.25;

class PcmFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.primed = false;

    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        this.left[this.write] = pcm[i] / 32768;
        this.right[this.write] = pcm[i + 1] / 32768;
        this.write = (this.write + 1) % this.size;
      }
      const have = this.available();
      if (have > MAX_S * sampleRate) {
        this.read = (this.write - Math.round(TARGET_S * sampleRate) + this.size) % this.size;
      }
    };
  }

  available() {
    return (this.write - this.read + this.size) % this.size;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    const have = this.available();

    // build the reserve first, otherwise the first uneven chunks crackle
    if (!this.primed) {
      if (have < TARGET_S * sampleRate) {
        l.fill(0);
        if (r !== l) r.fill(0);
        return true;
      }
      this.primed = true;
    }

    for (let i = 0; i < l.length; i += 1) {
      if (this.read === this.write) {
        // reserve ran out: silence until the next chunk, then build it again
        l[i] = 0;
        if (r !== l) r[i] = 0;
        this.primed = false;
        continue;
      }
      l[i] = this.left[this.read];
      if (r !== l) r[i] = this.right[this.read];
      this.read = (this.read + 1) % this.size;
    }
    return true;
  }
}

registerProcessor("pcm-feed", PcmFeed);
