import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import { app, closeImage } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { useEscape, useLinger } from "./controls.tsx";
import { IconClose, IconDownload } from "./icons.tsx";

const MIN = 1;
const MAX = 8;

/**
 * Full-screen image viewer.
 *
 * Zoom and pan are transforms, not sizes: the image never adds scrollbars,
 * and the wheel zooms exactly where the cursor points.
 */
export function Lightbox() {
  const live = useStore(app, (s) => s.lightbox);
  const { shown: shot, closing } = useLinger(live);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  useEscape(!!live, closeImage);

  useEffect(() => {
    if (!shot) return;
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [shot]);

  if (!shot) return null;

  /** Zoom around a screen point so it stays under the cursor. */
  const zoomAt = (next: number, clientX: number, clientY: number) => {
    const box = stage.current?.getBoundingClientRect();
    const target = Math.min(MAX, Math.max(MIN, next));
    if (!box || target === scale) return;
    const cx = clientX - (box.left + box.width / 2);
    const cy = clientY - (box.top + box.height / 2);
    const k = target / scale;
    setScale(target);
    setPos(target === 1 ? { x: 0, y: 0 } : { x: cx - (cx - pos.x) * k, y: cy - (cy - pos.y) * k });
  };

  const onWheel = (e: WheelEvent) => {
    zoomAt(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, moved: false };
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || scale === 1) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setPos({ x: d.px + dx, y: d.py + dy });
  };

  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    // a click without dragging toggles between zoomed and whole
    if (d && !d.moved) zoomAt(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
  };

  return (
    <div className={`lightbox ${closing ? "closing" : ""}`} onClick={closeImage}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="ellipsis">{shot.name}</span>
        <span className="state">{Math.round(scale * 100)}%</span>
        <button className="ghost small" disabled={scale === 1} onClick={() => zoomAt(1, 0, 0)}>
          {t("lightbox.fit")}
        </button>
        <a className="ghost icon" href={shot.url} download={shot.name} title={t("common.download")}>
          <IconDownload />
        </a>
        <button className="ghost icon" title={t("common.close")} onClick={closeImage}>
          <IconClose />
        </button>
      </div>

      <div
        className={`lightbox-stage ${scale > 1 ? "zoomed" : ""}`}
        ref={stage}
        onClick={(e) => {
          e.stopPropagation();
          // a click next to the image closes the viewer
          if (e.target === e.currentTarget) closeImage();
        }}
        onWheel={onWheel}
      >
        <img
          src={shot.url}
          alt={shot.name}
          draggable={false}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        />
      </div>
      <div className="lightbox-hint">{t("lightbox.hint")}</div>
    </div>
  );
}
