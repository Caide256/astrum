import type { Track, TrackProcessor, VideoProcessorOptions } from "livekit-client";

type FrameProcessor = { readable: ReadableStream<VideoFrame> };
type FrameGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type Breakout = {
  MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => FrameProcessor;
  MediaStreamTrackGenerator?: new (o: { kind: string }) => FrameGenerator;
};

/** Whether this browser can take a camera apart into frames and put it back together. */
export function canMirror(): boolean {
  const g = globalThis as unknown as Breakout;
  return !!g.MediaStreamTrackProcessor && !!g.MediaStreamTrackGenerator;
}

/**
 * The camera flipped left to right, frame by frame, for everyone: what is
 * sent is what the own tile shows. LiveKit sends the processed track and
 * attaches it to the own preview too.
 */
export class MirrorProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  name = "mirror";
  processedTrack?: MediaStreamTrack;
  private stop: AbortController | null = null;

  async init(opts: VideoProcessorOptions): Promise<void> {
    this.start(opts.track);
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    await this.destroy();
    this.start(opts.track);
  }

  async destroy(): Promise<void> {
    this.stop?.abort();
    this.stop = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
  }

  private start(track: MediaStreamTrack): void {
    const g = globalThis as unknown as Breakout;
    if (!g.MediaStreamTrackProcessor || !g.MediaStreamTrackGenerator) throw new Error("no frame access");
    const input = new g.MediaStreamTrackProcessor({ track });
    const output = new g.MediaStreamTrackGenerator({ kind: "video" });
    let canvas: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    const flip = new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, out) {
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        if (!canvas || canvas.width !== w || canvas.height !== h) {
          canvas = new OffscreenCanvas(w, h);
          ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
          ctx?.setTransform(-1, 0, 0, 1, w, 0);
        }
        if (!ctx) {
          out.enqueue(frame);
          return;
        }
        ctx.drawImage(frame, 0, 0, w, h);
        const flipped = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
        frame.close();
        out.enqueue(flipped);
      },
    });
    this.stop = new AbortController();
    const signal = this.stop.signal;
    void input.readable
      .pipeThrough(flip, { signal })
      .pipeTo(output.writable, { signal })
      .catch(() => undefined);
    this.processedTrack = output;
  }
}
