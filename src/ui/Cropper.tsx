import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import { t } from "../i18n/index.ts";

const VIEW = 280;
const OUT = 512;

type Props = {
  file: File;
  round?: boolean;
  onDone: (file: File) => void;
  onCancel: () => void;
};

/**
 * Avatar cropper.
 *
 * The image always covers the square: at minimum zoom it fits by the short
 * side, and panning is clamped so no empty edges appear. The result is drawn
 * into a 512x512 square.
 */
export function Cropper({ file, round = true, onDone, onCancel }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const base = img ? Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;

  /** Clamp the offset so no empty edge shows in the square. */
  const clamp = (x: number, y: number, ww = w, hh = h) => ({
    x: Math.max(-(ww - VIEW) / 2, Math.min((ww - VIEW) / 2, x)),
    y: Math.max(-(hh - VIEW) / 2, Math.min((hh - VIEW) / 2, y)),
  });

  const setZoomKeep = (next: number) => {
    if (!img) return;
    const z = Math.max(1, Math.min(6, next));
    const k = z / zoom;
    const ww = img.naturalWidth * base * z;
    const hh = img.naturalHeight * base * z;
    setZoom(z);
    setOff(clamp(off.x * k, off.y * k, ww, hh));
  };

  const onWheel = (e: WheelEvent) => setZoomKeep(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));

  const onDown = (e: PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOff(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y));
  };
  const onUp = () => {
    drag.current = null;
  };

  const save = async () => {
    if (!img) return;
    setBusy(true);
    const left = VIEW / 2 - w / 2 + off.x;
    const top = VIEW / 2 - h / 2 + off.y;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT);

    // only png and webp keep transparency; photos are much smaller as jpeg
    const alpha = /png|webp|gif/i.test(file.type);
    const type = alpha ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
    setBusy(false);
    if (blob) onDone(new File([blob], alpha ? "avatar.png" : "avatar.jpg", { type }));
  };

  return (
    <div className="cropper-back" onClick={(e) => e.stopPropagation()}>
      <div className="modal cropper">
        <h2>{t("cropper.title")}</h2>
        <p className="sub">{t("cropper.hint")}</p>

        <div
          className={`crop-view ${round ? "round" : ""}`}
          style={{ width: VIEW, height: VIEW }}
          onWheel={onWheel}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{
                width: w,
                height: h,
                left: VIEW / 2 - w / 2 + off.x,
                top: VIEW / 2 - h / 2 + off.y,
              }}
            />
          )}
          <div className="crop-mask" />
        </div>

        <input
          type="range"
          min={1}
          max={6}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoomKeep(Number(e.target.value))}
        />

        <div className="row">
          <button className="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="primary" disabled={!img || busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
