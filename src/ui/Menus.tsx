import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { app, closeMenus, displayName, openShareSettings, stopShare, stopWatching, watchStream } from "../app.ts";
import { t } from "../i18n/index.ts";
import { createStore, useStore } from "../store.ts";
import { voice, type CodecInfo } from "../voice/voice.ts";
import { useEscape } from "./controls.tsx";
import { popOut } from "./popout.ts";
import { TrackView } from "./Stage.tsx";
import { IconClose, IconExpand, IconEye, IconGear, IconPopout, IconScreenOff, IconVolume, IconVolumeOff } from "./icons.tsx";

/* ------------------------------------------------------------- menu base */

type Place = "above" | "point" | "right";

/**
 * A popup that stays inside the window. above: centered over a button,
 * point: at the cursor like a context menu, right: to the right of a row.
 */
function Floating({
  x,
  y,
  place,
  onClose,
  children,
  className = "",
  backdrop = true,
  onMouseEnter,
  onMouseLeave,
}: {
  x: number;
  y: number;
  place: Place;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backdrop?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEscape(true, onClose);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let left = x;
    let top = y;
    if (place === "above") {
      left = x - w / 2;
      top = y - h - 8;
      if (top < 8) top = y + 8;
    } else if (place === "point") {
      if (left + w > W - 8) left = x - w;
      if (top + h > H - 8) top = y - h;
    }
    setPos({
      left: Math.max(8, Math.min(W - w - 8, left)),
      top: Math.max(8, Math.min(H - h - 8, top)),
    });
  }, [x, y, place]);

  useEffect(() => {
    window.addEventListener("resize", onClose);
    return () => window.removeEventListener("resize", onClose);
  }, [onClose]);

  const menu = (
    <div
      ref={box}
      className={`menu ${className}`}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? "visible" : "hidden" }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );

  if (!backdrop) return menu;
  return (
    <div
      className="menu-back"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div onMouseDown={(e) => e.stopPropagation()}>{menu}</div>
    </div>
  );
}

/** Ask every two seconds who encodes the video: the GPU or the CPU. */
function useCodec(read: () => Promise<CodecInfo | null>): CodecInfo | null {
  const [info, setInfo] = useState<CodecInfo | null>(null);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    let alive = true;
    const tick = () =>
      void reader.current().then((i) => {
        if (alive) setInfo(i);
      });
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return info;
}

/** Menu line: who encodes the video and, for the CPU, why. */
export function CodecLine({ info, sending }: { info: CodecInfo | null; sending: boolean }) {
  if (!info) return <div className="menu-note">{t("codec.checking")}</div>;
  const size = info.width ? ` · ${info.width}×${info.height}` : "";
  const noH264 = sending && !info.gpu && info.serverCodecs.length > 0 && !info.serverCodecs.includes("H264");
  const who = sending ? (info.gpu ? t("codec.encodeGpu") : t("codec.encodeCpu")) : info.gpu ? t("codec.decodeGpu") : t("codec.decodeCpu");
  return (
    <div className={`menu-note codec ${info.gpu ? "gpu" : "cpu"}`}>
      <b>{who}</b> · {info.codec || "?"}
      {size} · {t("codec.fps", { fps: info.fps })}
      {noH264 && <div className="codec-why">{t("codec.noH264", { codec: info.serverCodecs[0] })}</div>}
      {sending && !info.gpu && !noH264 && <div className="codec-why">{t("codec.gpuRefused")}</div>}
    </div>
  );
}

function shareLine(): string {
  const share = voice.getState().share;
  if (!share) return "";
  const size = share.height ? `${share.height}p` : "";
  return [size, t("codec.fps", { fps: share.fps }), share.audio ? t("share.withAudio") : t("share.noAudio")].filter(Boolean).join(" · ");
}

/* --------------------------------------------------------- share button menu */

/** While sharing, the share button opens this: settings or stop. */
export function ScreenMenu() {
  const menu = useStore(app, (s) => s.screenMenu);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  if (!menu || !state.screen) return null;

  return (
    <Floating x={menu.x} y={menu.y} place="above" onClose={closeMenus} className="share-menu">
      <div className="menu-head ellipsis">{state.share?.name ? t("share.showing", { name: state.share.name }) : t("share.running")}</div>
      {state.share && <div className="menu-note">{shareLine()}</div>}
      <ShareCodec />
      <button className="menu-item" onClick={openShareSettings}>
        <IconGear />
        <span>{t("share.settings")}</span>
      </button>
      <button className="menu-item danger" onClick={() => void stopShare()}>
        <IconScreenOff />
        <span>{t("share.stop")}</span>
      </button>
    </Floating>
  );
}

function ShareCodec() {
  const info = useCodec(() => voice.shareCodec());
  return <CodecLine info={info} sending />;
}

function WatchCodec({ identity }: { identity: string }) {
  const info = useCodec(() => voice.watchCodec(identity));
  return info ? <CodecLine info={info} sending={false} /> : null;
}

/* ------------------------------------------------------ share context menu */

export function StreamMenu() {
  const menu = useStore(app, (s) => s.streamMenu);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  if (!menu) return null;

  const stream = state.streams.find((s) => s.identity === menu.identity);
  if (!stream) return null;
  const video = state.videos.find((v) => v.identity === stream.identity && v.screen);
  const who = stream.local ? t("share.yours") : displayName(stream.userId);

  return (
    <Floating x={menu.x} y={menu.y} place="point" onClose={closeMenus}>
      <div className="menu-head ellipsis">{who}</div>
      {stream.local ? <ShareCodec /> : stream.watching && <WatchCodec identity={stream.identity} />}

      {stream.watching ? (
        <button className="menu-item" onClick={() => stopWatching(stream.identity)}>
          <IconClose />
          <span>{t("share.stopWatching")}</span>
        </button>
      ) : (
        <button className="menu-item" onClick={() => watchStream(stream.identity)}>
          <IconEye />
          <span>{t("share.watch")}</span>
        </button>
      )}

      {stream.watching && (
        <button className="menu-item" onClick={() => watchStream(stream.identity)}>
          <IconExpand />
          <span>{t("share.expand")}</span>
        </button>
      )}

      {video && (
        <button
          className="menu-item"
          onClick={() => {
            closeMenus();
            popOut(video.key, video.track, t("share.windowTitle", { who }));
          }}
        >
          <IconPopout />
          <span>{t("share.popout")}</span>
        </button>
      )}

      {!stream.local && stream.hasAudio && stream.watching && (
        <button className="menu-item" onClick={() => voice.setStreamMuted(stream.userId, !stream.muted)}>
          {stream.muted ? <IconVolume /> : <IconVolumeOff />}
          <span>{stream.muted ? t("share.unmuteSound") : t("share.muteSound")}</span>
        </button>
      )}

      {stream.local && stream.viewers.length > 0 && (
        <div className="menu-note">{t("share.viewers", { names: stream.viewers.map((id) => displayName(id.split(":").slice(0, 2).join(":"))).join(", ") })}</div>
      )}

      {!stream.local && stream.hasAudio && stream.watching && !stream.muted && (
        <div className="menu-volume">
          <label>
            <IconVolume />
            <span>{t("share.volume")}</span>
            <b>{stream.volume}%</b>
          </label>
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={stream.volume}
            onChange={(e) => voice.setStreamVolume(stream.userId, Number(e.target.value))}
          />
        </div>
      )}

      {stream.local && (
        <>
          <button className="menu-item" onClick={openShareSettings}>
            <IconGear />
            <span>{t("share.settings")}</span>
          </button>
          <button className="menu-item danger" onClick={() => void stopShare()}>
            <IconScreenOff />
            <span>{t("share.stop")}</span>
          </button>
        </>
      )}
    </Floating>
  );
}

/* ------------------------------------------------------- hover preview card */

type Peek = { identity: string; userId: string; x: number; y: number };

const peekStore = createStore<{ peek: Peek | null }>({ peek: null });
let openTimer = 0;
let closeTimer = 0;

function closePeekNow(): void {
  const p = peekStore.get().peek;
  if (p) voice.peek(p.identity, false);
  peekStore.set({ peek: null });
}

/** The mouse entered a person who shares the screen: show the card after a moment. */
export function peekEnter(identity: string, userId: string, el: HTMLElement): void {
  window.clearTimeout(closeTimer);
  window.clearTimeout(openTimer);
  const current = peekStore.get().peek;
  if (current?.identity === identity) return;
  openTimer = window.setTimeout(() => {
    closePeekNow();
    const r = el.getBoundingClientRect();
    peekStore.set({ peek: { identity, userId, x: r.right + 10, y: r.top - 6 } });
    voice.peek(identity, true);
  }, 220);
}

/** The mouse left the row: leave time to reach the card, then hide it. */
export function peekLeave(): void {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closePeekNow, 200);
}

export function StreamPeek() {
  const peek = useStore(peekStore, (s) => s.peek);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const stream = peek ? state.streams.find((s) => s.identity === peek.identity) : undefined;

  // the share stopped while the card was open
  useEffect(() => {
    if (peek && !stream) closePeekNow();
  }, [peek, stream]);

  if (!peek || !stream) return null;
  const track = voice.screenTrackOf(peek.identity);
  const who = stream.local ? t("share.yoursTitle") : t("share.isSharing", { who: displayName(peek.userId) });

  return (
    <Floating
      x={peek.x}
      y={peek.y}
      place="right"
      backdrop={false}
      className="stream-peek"
      onClose={closePeekNow}
      onMouseEnter={() => window.clearTimeout(closeTimer)}
      onMouseLeave={peekLeave}
    >
      <div className="peek-title ellipsis">
        <i className="live-dot" />
        {who}
      </div>
      <div className="peek-video">{track ? <TrackView track={track} /> : <div className="state">{t("share.loadingPreview")}</div>}</div>
      {stream.local ? (
        <button
          className="primary peek-action"
          onClick={() => {
            closePeekNow();
            openShareSettings();
          }}
        >
          <IconGear /> {t("share.settings")}
        </button>
      ) : stream.watching ? (
        <div className="peek-row">
          <button
            className="primary peek-action"
            onClick={() => {
              closePeekNow();
              watchStream(stream.identity);
            }}
          >
            <IconExpand /> {t("share.expandShort")}
          </button>
          <button
            className="ghost peek-action"
            onClick={() => {
              closePeekNow();
              stopWatching(stream.identity);
            }}
          >
            {t("share.stopWatching")}
          </button>
        </div>
      ) : (
        <button
          className="primary peek-action"
          onClick={() => {
            closePeekNow();
            watchStream(stream.identity);
          }}
        >
          <IconEye /> {t("share.watch")}
        </button>
      )}
    </Floating>
  );
}
