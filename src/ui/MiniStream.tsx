import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

import { app, displayName, openStreamMenu, showCall } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { voice, type VoiceVideo } from "../voice/voice.ts";
import { popOut } from "./popout.ts";
import { VideoView } from "./Stage.tsx";
import { IconClose, IconPopout, IconSwap, IconVolume, IconVolumeOff } from "./icons.tsx";

/**
 * The call in a small floating player while another channel is open. It shows
 * the tile last expanded in the call, a share or a camera, and switches
 * between every watched share and every camera. It can be dragged anywhere in
 * the window and snaps to the nearest corner on release. A double click
 * returns to the call and expands the shown tile.
 */

type Corner = "tl" | "tr" | "bl" | "br";

const W = 340;
const H = Math.round((W * 9) / 16);
const MARGIN = 16;
const KEY = "app.mini-corner";

function loadCorner(): Corner {
  try {
    const c = localStorage.getItem(KEY) as Corner | null;
    return c && ["tl", "tr", "bl", "br"].includes(c) ? c : "br";
  } catch {
    return "br";
  }
}

/** The title bar sits above the page: the top corners start below it. */
function topInset(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--titlebar-h")) || 0;
}

function cornerPos(c: Corner): { x: number; y: number } {
  const x = c.endsWith("l") ? MARGIN : window.innerWidth - W - MARGIN;
  const y = c.startsWith("t") ? MARGIN + topInset() : window.innerHeight - H - MARGIN;
  return { x, y };
}

/** The call tile key of a video, as CallView names its tiles. */
function tileKey(v: VoiceVideo): string {
  return v.screen ? `s:${v.identity}` : `m:${v.identity}`;
}

export function MiniStream() {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const callView = useStore(app, (s) => s.callView);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const lastFocus = useStore(app, (s) => s.lastFocus);
  const [corner, setCorner] = useState<Corner>(loadCorner);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [, relayout] = useState(0);
  const start = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  // on resize the corner stays, the coordinates change
  useEffect(() => {
    const onResize = () => relayout((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const inCall = callView && activeChannel === voiceChannel;
  // watched shares first, then cameras; the own camera only if nothing else is there
  const shares = state.videos.filter((v) => v.screen);
  const cams = state.videos.filter((v) => !v.screen && !v.local);
  const own = state.videos.filter((v) => !v.screen && v.local);
  const choices = [...shares, ...cams, ...(shares.length || cams.length ? [] : own)];
  const pinned = choices.find((v) => tileKey(v) === lastFocus);
  // a camera shows only when it was picked; a watched share shows on its own
  const video = pinned ?? shares[0];
  if (!voiceChannel || !video || inCall) return null;

  const stream = video.screen ? state.streams.find((s) => s.identity === video.identity) : undefined;
  const pos = drag ?? cornerPos(corner);

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, .mini-pick")) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, moved: false };
  };

  const onMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    if (!s.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    s.moved = true;
    setDrag({
      x: Math.max(0, Math.min(window.innerWidth - W, s.x + dx)),
      y: Math.max(topInset(), Math.min(window.innerHeight - H, s.y + dy)),
    });
  };

  const onUp = () => {
    const s = start.current;
    start.current = null;
    if (!s?.moved || !drag) return;
    // snap to the corner nearest to the player's center
    const cx = drag.x + W / 2;
    const cy = drag.y + H / 2;
    const next: Corner = `${cy < window.innerHeight / 2 ? "t" : "b"}${cx < window.innerWidth / 2 ? "l" : "r"}` as Corner;
    setCorner(next);
    setDrag(null);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable
    }
  };

  const nameOf = (v: VoiceVideo) =>
    v.screen ? (v.local ? t("call.yourScreen") : displayName(v.userId)) : v.local ? t("mini.yourCamera") : t("mini.camera", { who: displayName(v.userId) });
  const who = nameOf(video);

  const close = () => {
    if (video.screen) voice.unwatch(video.identity);
    app.set({ lastFocus: null });
  };

  return (
    <div
      className={`mini-stream ${drag ? "dragging" : ""}`}
      style={{ left: pos.x, top: pos.y, width: W, height: H }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={() => {
        showCall();
        app.set({ callFocus: tileKey(video) });
      }}
      onContextMenu={(e) => {
        if (!video.screen) return;
        e.preventDefault();
        openStreamMenu(video.identity, e.clientX, e.clientY);
      }}
      title={t("mini.hint")}
    >
      <VideoView video={video} fit={video.screen ? "contain" : "cover"} />
      {picking && (
        <div className="mini-pick" onPointerDown={(e) => e.stopPropagation()}>
          {choices.map((v) => (
            <button
              key={v.key}
              className={v.key === video.key ? "on" : ""}
              onClick={() => {
                app.set({ lastFocus: tileKey(v) });
                setPicking(false);
              }}
            >
              {v.screen && <i className="live-dot" />}
              <span className="ellipsis">{nameOf(v)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mini-bar">
        {video.screen && <i className="live-dot" />}
        <span className="ellipsis">{who}</span>
        {stream?.muted && <IconVolumeOff className="flag off" />}
        {choices.length > 1 && (
          <button className="icon" title={t("mini.switch")} onClick={() => setPicking(!picking)}>
            <IconSwap />
            <span className="state">{choices.length}</span>
          </button>
        )}
        {stream && !stream.local && stream.hasAudio && (
          <>
            <button
              className="icon"
              title={stream.muted ? t("share.unmuteSound") : t("share.muteSound")}
              onClick={() => voice.setStreamMuted(stream.userId, !stream.muted)}
            >
              {stream.muted ? <IconVolumeOff /> : <IconVolume />}
            </button>
            <label className="tile-volume" title={t("share.volume")}>
              <input
                type="range"
                min={0}
                max={200}
                step={1}
                value={stream.volume}
                disabled={stream.muted}
                onChange={(e) => voice.setStreamVolume(stream.userId, Number(e.target.value))}
              />
            </label>
          </>
        )}
        <button className="icon" title={t("share.popout")} onClick={() => popOut(video.key, video.track, t("share.windowTitle", { who }))}>
          <IconPopout />
        </button>
        <button className="icon" title={video.screen ? t("share.stopWatching") : t("mini.hide")} onClick={close}>
          <IconClose />
        </button>
      </div>
    </div>
  );
}
