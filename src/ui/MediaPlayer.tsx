import { useEffect, useRef, useState, type CSSProperties } from "react";

import { safeFileName, type Media } from "../app.ts";
import { t } from "../i18n/index.ts";
import { attachmentUrl, encryptedMediaUrl, mediaUrl, peekAttachment } from "../media.ts";
import { humanSize } from "./Composer.tsx";
import { IconDownload, IconFullscreen, IconPause, IconPlay, IconVolume, IconVolumeOff } from "./icons.tsx";

/**
 * A small player for videos and sounds sent in chats. Nothing is downloaded
 * until play is pressed; then the file comes down with a progress bar (and is
 * decrypted in encrypted rooms) and plays with the app's own controls. Only
 * one player sounds at a time, and the volume is shared by all of them.
 */

const VOLUME_KEY = "app.player-volume";

function loadVolume(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { volume?: number; muted?: boolean } | null;
    const v = Number(raw?.volume);
    return { volume: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8, muted: raw?.muted === true };
  } catch {
    return { volume: 0.8, muted: false };
  }
}

function saveVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // kept until restart
  }
}

/** The element that plays right now: starting another one pauses it. */
let current: HTMLMediaElement | null = null;

function claim(el: HTMLMediaElement): void {
  if (current && current !== el && !current.paused) current.pause();
  current = el;
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Downloading on demand: the URL once it is there, and how far it got. */
function useAttachment(media: Media) {
  const [url, setUrl] = useState(() => peekAttachment(media.mxc, media.file));
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const start = async (): Promise<string> => {
    if (url) return url;
    setFailed(false);
    setProgress(0);
    const got = await attachmentUrl(media.mxc, media.file, media.mime, setProgress);
    setProgress(null);
    if (!got) setFailed(true);
    setUrl(got);
    return got;
  };
  return { url, progress, failed, start };
}

function useThumb(media: Media): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    const th = media.thumb;
    if (!th) return;
    let alive = true;
    void (th.file ? encryptedMediaUrl(th.file, th.mime) : mediaUrl(th.mxc)).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [media.thumb?.mxc]);
  return src;
}

function saveFile(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(name, "file");
  a.click();
}

/** Seek bar with the downloaded part, the played part and a thumb. */
function Seek({ at, length, onSeek }: { at: number; length: number; onSeek: (s: number) => void }) {
  const part = length > 0 ? Math.min(1, at / length) : 0;
  return (
    <input
      className="player-seek"
      type="range"
      min={0}
      max={Math.max(0.1, length)}
      step={0.05}
      value={Math.min(at, length || 0)}
      style={{ "--part": `${(part * 100).toFixed(2)}%` } as CSSProperties}
      onChange={(e) => onSeek(Number(e.target.value))}
    />
  );
}

function VolumeControl({ el }: { el: HTMLMediaElement | null }) {
  const [state, setState] = useState(loadVolume);
  useEffect(() => {
    if (!el) return;
    el.volume = state.volume;
    el.muted = state.muted;
  }, [el, state]);
  const set = (volume: number, muted: boolean) => {
    setState({ volume, muted });
    saveVolume(volume, muted);
  };
  return (
    <div className="player-volume">
      <button
        className="player-btn"
        title={state.muted || state.volume === 0 ? t("player.unmute") : t("player.mute")}
        onClick={() => set(state.volume || 0.8, !state.muted && state.volume > 0)}
      >
        {state.muted || state.volume === 0 ? <IconVolumeOff /> : <IconVolume />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={state.muted ? 0 : state.volume}
        onChange={(e) => set(Number(e.target.value), false)}
      />
    </div>
  );
}

/** Play position and state of a media element, kept in React state. */
function useMediaState(el: HTMLMediaElement | null) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!el) return;
    const bump = () => redraw((n) => n + 1);
    const events = ["timeupdate", "play", "pause", "ended", "durationchange", "loadedmetadata", "waiting", "playing"];
    for (const ev of events) el.addEventListener(ev, bump);
    return () => {
      for (const ev of events) el.removeEventListener(ev, bump);
    };
  }, [el]);
  return {
    playing: !!el && !el.paused && !el.ended,
    at: el?.currentTime ?? 0,
    length: el && Number.isFinite(el.duration) ? el.duration : 0,
  };
}

export function VideoPlayer({ media }: { media: Media }) {
  const file = useAttachment(media);
  const thumb = useThumb(media);
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const st = useMediaState(el);
  const [active, setActive] = useState(false);
  const idle = useRef(0);

  const ratio = media.w > 0 && media.h > 0 ? media.w / media.h : 16 / 9;
  const style = { aspectRatio: String(ratio), width: Math.min(480, Math.round(Math.max(200, 300 * ratio))) };

  const toggle = async () => {
    if (!file.url) {
      const got = await file.start();
      if (!got) return;
      return;
    }
    if (!el) return;
    if (el.paused || el.ended) {
      claim(el);
      void el.play().catch(() => undefined);
    } else el.pause();
  };

  // the controls hide while the video plays and the mouse rests
  const wake = () => {
    setActive(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setActive(false), 2200);
  };
  useEffect(() => () => window.clearTimeout(idle.current), []);

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void box.current?.requestFullscreen().catch(() => undefined);
  };

  return (
    <div
      ref={box}
      className={`player video ${st.playing ? "playing" : ""} ${active || !st.playing ? "awake" : ""}`}
      style={style}
      onMouseMove={wake}
      onMouseLeave={() => setActive(false)}
    >
      {file.url ? (
        <video
          ref={setEl}
          src={file.url}
          playsInline
          autoPlay
          onPlay={(e) => claim(e.currentTarget)}
          onClick={() => void toggle()}
          onDoubleClick={fullscreen}
        />
      ) : (
        <button className="player-poster" onClick={() => void toggle()} title={t("player.play")}>
          {thumb && <img src={thumb} alt="" draggable={false} />}
          <span className="player-big">
            {file.progress !== null ? (
              <svg viewBox="0 0 36 36" className="player-ring">
                <circle cx="18" cy="18" r="15" />
                <circle cx="18" cy="18" r="15" className="done" style={{ strokeDasharray: `${(file.progress * 94.2).toFixed(1)} 94.2` }} />
              </svg>
            ) : (
              <IconPlay size={26} />
            )}
          </span>
          <span className="player-caption ellipsis">
            {media.name}
            <small>
              {[media.duration ? clock(media.duration / 1000) : "", humanSize(media.size)].filter(Boolean).join(" · ")}
              {file.failed ? ` · ${t("player.failed")}` : ""}
            </small>
          </span>
        </button>
      )}
      {file.url && (
        <div className="player-bar" onDoubleClick={(e) => e.stopPropagation()}>
          <button className="player-btn" title={st.playing ? t("player.pause") : t("player.play")} onClick={() => void toggle()}>
            {st.playing ? <IconPause /> : <IconPlay />}
          </button>
          <span className="player-time">
            {clock(st.at)} / {clock(st.length || media.duration / 1000)}
          </span>
          <Seek at={st.at} length={st.length} onSeek={(s) => el && (el.currentTime = s)} />
          <VolumeControl el={el} />
          <button className="player-btn" title={t("common.download")} onClick={() => saveFile(file.url, media.name)}>
            <IconDownload />
          </button>
          <button className="player-btn" title={t("call.fullscreen")} onClick={fullscreen}>
            <IconFullscreen />
          </button>
        </div>
      )}
    </div>
  );
}

export function AudioPlayer({ media }: { media: Media }) {
  const file = useAttachment(media);
  const [el, setEl] = useState<HTMLAudioElement | null>(null);
  const st = useMediaState(el);
  const wantPlay = useRef(false);

  const toggle = async () => {
    if (!file.url) {
      wantPlay.current = true;
      await file.start();
      return;
    }
    if (!el) return;
    if (el.paused || el.ended) {
      claim(el);
      void el.play().catch(() => undefined);
    } else el.pause();
  };

  const length = st.length || media.duration / 1000;
  return (
    <div className={`player audio ${st.playing ? "playing" : ""}`}>
      <button className="player-round" title={st.playing ? t("player.pause") : t("player.play")} onClick={() => void toggle()}>
        {file.progress !== null ? (
          <svg viewBox="0 0 36 36" className="player-ring">
            <circle cx="18" cy="18" r="15" />
            <circle cx="18" cy="18" r="15" className="done" style={{ strokeDasharray: `${(file.progress * 94.2).toFixed(1)} 94.2` }} />
          </svg>
        ) : st.playing ? (
          <IconPause />
        ) : (
          <IconPlay />
        )}
      </button>
      <div className="player-mid">
        <span className="player-name ellipsis" title={media.name}>
          {media.name}
          {file.failed && <small className="danger-text"> · {t("player.failed")}</small>}
        </span>
        <div className="player-line">
          <Seek at={st.at} length={st.length} onSeek={(s) => el && (el.currentTime = s)} />
          <span className="player-time">{file.url ? `${clock(st.at)} / ${clock(length)}` : length ? clock(length) : humanSize(media.size)}</span>
        </div>
      </div>
      {file.url && <VolumeControl el={el} />}
      {file.url && (
        <button className="player-btn" title={t("common.download")} onClick={() => saveFile(file.url, media.name)}>
          <IconDownload />
        </button>
      )}
      {file.url && (
        <audio
          ref={setEl}
          src={file.url}
          preload="auto"
          onCanPlay={(e) => {
            if (!wantPlay.current) return;
            wantPlay.current = false;
            claim(e.currentTarget);
            void e.currentTarget.play().catch(() => undefined);
          }}
          onPlay={(e) => claim(e.currentTarget)}
        />
      )}
    </div>
  );
}
