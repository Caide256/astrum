import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import { t } from "../i18n/index.ts";
import type { BannerFrame, BannerPlace } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { useEscape } from "./controls.tsx";

/**
 * Framing of a banner picture, like cropping an avatar: the picture moves
 * under a window of the place's shape, the wheel or the slider enlarges it,
 * and what stays outside the window is dimmed. The profile card and a call
 * tile have windows of their own shapes and are framed apart; the picture is
 * the same.
 *
 * The result is a BannerFrame (zoom, and the point kept in view in percent),
 * which BannerPicture turns back into exactly this framing in a box of the
 * same shape at any size: the picture covers the box (object-fit), is placed
 * by object-position and enlarged around that same point.
 */

/** Shapes of the places: the profile card's banner (420 by 108) and a call tile (16:9). */
const SHAPE: Record<BannerPlace, number> = { card: 420 / 108, tile: 16 / 9 };
const WIDTH = 440;
const PAD = 36;
const MAX_ZOOM = 4;

/** The picture's place under the window: its zoom and its top left corner in window pixels. */
type Pose = { zoom: number; left: number; top: number };

type Size = { w: number; h: number };

function windowOf(place: BannerPlace): Size {
  return { w: WIDTH, h: Math.round(WIDTH / SHAPE[place]) };
}

function sizes(img: Size, win: Size, zoom: number): Size {
  const base = Math.max(win.w / img.w, win.h / img.h);
  return { w: img.w * base * zoom, h: img.h * base * zoom };
}

/** Keep the window covered: no empty edge may show. */
function clamp(p: Pose, img: Size, win: Size): Pose {
  const d = sizes(img, win, p.zoom);
  return {
    zoom: p.zoom,
    left: Math.min(0, Math.max(win.w - d.w, p.left)),
    top: Math.min(0, Math.max(win.h - d.h, p.top)),
  };
}

function poseOf(f: BannerFrame, img: Size, win: Size): Pose {
  const d = sizes(img, win, f.zoom);
  const uw = win.w / d.w;
  const vh = win.h / d.h;
  return clamp({ zoom: f.zoom, left: -(f.x / 100) * (1 - uw) * d.w, top: -(f.y / 100) * (1 - vh) * d.h }, img, win);
}

function frameOfPose(p: Pose, img: Size, win: Size): BannerFrame {
  const d = sizes(img, win, p.zoom);
  const uw = win.w / d.w;
  const vh = win.h / d.h;
  const pct = (u0: number, span: number) => (span < 0.9999 ? Math.max(0, Math.min(100, (100 * u0) / (1 - span))) : 50);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { zoom: round(p.zoom), x: round(pct(-p.left / d.w, uw)), y: round(pct(-p.top / d.h, vh)) };
}

export function BannerFramer({
  src,
  frames,
  start,
  avatar,
  name,
  busy,
  onDone,
  onCancel,
}: {
  src: string;
  frames: Record<BannerPlace, BannerFrame>;
  start: BannerPlace;
  avatar: string;
  name: string;
  busy?: boolean;
  onDone: (frames: Record<BannerPlace, BannerFrame>) => void;
  onCancel: () => void;
}) {
  const [img, setImg] = useState<Size | null>(null);
  const [place, setPlace] = useState<BannerPlace>(start);
  const [poses, setPoses] = useState<Record<BannerPlace, Pose> | null>(null);
  const drag = useRef<{ x: number; y: number; from: Pose } | null>(null);
  useEscape(true, onCancel);

  useEffect(() => {
    const el = new Image();
    el.onload = () => {
      const size = { w: el.naturalWidth || 1, h: el.naturalHeight || 1 };
      setImg(size);
      setPoses({ card: poseOf(frames.card, size, windowOf("card")), tile: poseOf(frames.tile, size, windowOf("tile")) });
    };
    el.src = src;
    // the frames are read once: later changes come from here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const win = windowOf(place);
  const pose = poses?.[place] ?? null;
  const shown = img && pose ? sizes(img, win, pose.zoom) : null;

  const setPose = (p: Pose) => {
    if (!img || !poses) return;
    setPoses({ ...poses, [place]: clamp(p, img, win) });
  };

  /** Enlarge around the middle of the window: the point there stays put. */
  const zoomTo = (next: number) => {
    if (!img || !pose) return;
    const zoom = Math.max(1, Math.min(MAX_ZOOM, next));
    const d0 = sizes(img, win, pose.zoom);
    const d1 = sizes(img, win, zoom);
    const cu = (win.w / 2 - pose.left) / d0.w;
    const cv = (win.h / 2 - pose.top) / d0.h;
    setPose({ zoom, left: win.w / 2 - cu * d1.w, top: win.h / 2 - cv * d1.h });
  };

  const onDown = (e: PointerEvent) => {
    if (!pose || e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, from: pose };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPose({ zoom: d.from.zoom, left: d.from.left + e.clientX - d.x, top: d.from.top + e.clientY - d.y });
  };
  const onWheel = (e: WheelEvent) => {
    if (pose) zoomTo(pose.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  };

  const done = () => {
    if (!img || !poses) return;
    onDone({ card: frameOfPose(poses.card, img, windowOf("card")), tile: frameOfPose(poses.tile, img, windowOf("tile")) });
  };

  return (
    <div className="cropper-back" onClick={(e) => e.stopPropagation()}>
      <div className="modal framer">
        <h2>{t("tile.frame.title")}</h2>
        <div className="seg framer-places">
          <button className={place === "card" ? "on" : ""} onClick={() => setPlace("card")}>
            {t("tile.where.card")}
          </button>
          <button className={place === "tile" ? "on" : ""} onClick={() => setPlace("tile")}>
            {t("tile.where.tile")}
          </button>
        </div>
        <p className="sub">{t("tile.frame.hint")}</p>

        <div
          className="framer-stage"
          style={{ width: win.w + PAD * 2, height: win.h + PAD * 2 }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={onWheel}
        >
          {shown && pose && (
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ width: shown.w, height: shown.h, left: PAD + pose.left, top: PAD + pose.top }}
            />
          )}
          <div className={`framer-window ${place}`} style={{ left: PAD, top: PAD, width: win.w, height: win.h }}>
            {place === "card" ? (
              <div className="framer-who card">
                <Avatar mxc={avatar} name={name || "?"} size={56} />
              </div>
            ) : (
              <div className="framer-who tile">
                <Avatar mxc={avatar} name={name || "?"} size={64} />
              </div>
            )}
          </div>
        </div>

        <div className="framer-zoom">
          <span className="state">{t("tile.zoom", { n: Math.round((pose?.zoom ?? 1) * 100) })}</span>
          <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={pose?.zoom ?? 1} onChange={(e) => zoomTo(Number(e.target.value))} />
          <button className="ghost small" disabled={!img} onClick={() => img && setPose(poseOf({ zoom: 1, x: 50, y: 50 }, img, win))}>
            {t("tile.reset")}
          </button>
        </div>

        <div className="row">
          <button className="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="primary" disabled={!poses || busy} onClick={done}>
            {busy ? t("common.saving") : t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
