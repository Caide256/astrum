import { BRAND } from "./brand.ts";
import { hasShell, pushTrayState } from "./desktop.ts";
import { getLang, onLangChange, t, tn } from "./i18n/index.ts";
import { voice } from "./voice/voice.ts";

/**
 * Tray and taskbar icons. A red badge with a crossed-out microphone means
 * muted, crossed-out headphones means deafened, a red dot means unread
 * messages or invites. The images are drawn here on a canvas with the same
 * glyphs as the interface and handed to the main process as PNG.
 */

type Look = { inCall: boolean; muted: boolean; deafened: boolean; unread: number };

const RED = "#ed4245";
const RING = "#121317";

let base: HTMLImageElement | null = null;
let unread = 0;
let lastKey = "";

function loadBase(): Promise<HTMLImageElement> {
  if (base?.complete) return Promise.resolve(base);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      base = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = "./icon.png";
  });
}

/** Glyph inside the badge: the same strokes as IconMicOff and IconHeadsetOff. */
function glyph(ctx: CanvasRenderingContext2D, kind: "mic" | "headset", cx: number, cy: number, r: number): void {
  ctx.save();
  // the icons are drawn on a 16x16 grid, fitted into the circle with margins
  const s = (r * 1.25) / 16;
  ctx.translate(cx - 8 * s, cy - 8 * s);
  ctx.scale(s, s);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "mic") {
    ctx.beginPath();
    ctx.roundRect(6, 1.8, 4, 7.4, 2);
    ctx.stroke();
    ctx.stroke(new Path2D("M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4"));
  } else {
    ctx.stroke(new Path2D("M3 10.4V8a5 5 0 0 1 10 0v2.4"));
    ctx.beginPath();
    ctx.roundRect(1.8, 9.4, 3, 4.2, 1.2);
    ctx.roundRect(11.2, 9.4, 3, 4.2, 1.2);
    ctx.stroke();
  }
  ctx.stroke(new Path2D("M2.4 2.2l11.2 11.6"));
  ctx.restore();
}

function badge(ctx: CanvasRenderingContext2D, size: number, look: Look, alone: boolean): void {
  const r = alone ? size / 2 : size * 0.3;
  const cx = size - r;
  const cy = size - r;
  if (!alone) {
    // a dark ring separates the badge from the icon
    ctx.fillStyle = RING;
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(1, size * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = RED;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  glyph(ctx, look.deafened ? "headset" : "mic", cx, cy, r);
}

function dot(ctx: CanvasRenderingContext2D, size: number, alone: boolean): void {
  const r = alone ? size / 2 : size * 0.2;
  const cx = size - r;
  const cy = alone ? size - r : r;
  if (!alone) {
    ctx.fillStyle = RING;
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(1, size * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = RED;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function isOff(look: Look): boolean {
  return look.muted || look.deafened;
}

function draw(img: HTMLImageElement, size: number, look: Look): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size, size);
  if (look.unread && !isOff(look)) dot(ctx, size, false);
  if (isOff(look)) badge(ctx, size, look, false);
  return canvas.toDataURL("image/png");
}

/** Small overlay on the taskbar button: mute wins over unread. */
function overlay(look: Look): string {
  if (!isOff(look) && !look.unread) return "";
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  if (isOff(look)) badge(ctx, 32, look, true);
  else dot(ctx, 32, true);
  return canvas.toDataURL("image/png");
}

function tooltip(look: Look): string {
  const parts = [BRAND.name];
  if (look.deafened) parts.push(t("tray.tip.deafened"));
  else if (look.muted) parts.push(t("tray.tip.muted"));
  else if (look.inCall) parts.push(t("tray.tip.inCall"));
  if (look.unread) parts.push(tn("tray.tip.unread", look.unread));
  return parts.join(" · ");
}

async function update(): Promise<void> {
  if (!hasShell) return;
  const v = voice.getState();
  const look: Look = { inCall: v.connected, muted: v.muted, deafened: v.deafened, unread };
  const key = JSON.stringify(look) + getLang();
  if (key === lastKey) return;
  lastKey = key;
  try {
    const img = await loadBase();
    pushTrayState({
      icon16: draw(img, 16, look),
      icon32: draw(img, 32, look),
      overlay: overlay(look),
      tooltip: tooltip(look),
      inCall: look.inCall,
      muted: look.muted,
      deafened: look.deafened,
      labels: {
        open: t("tray.open"),
        mute: t("tray.mute"),
        unmute: t("tray.unmute"),
        deafen: t("tray.deafen"),
        undeafen: t("tray.undeafen"),
        quit: t("tray.quit"),
        hintTitle: t("tray.hintTitle"),
        hintBody: t("tray.hintBody"),
      },
    });
  } catch {
    lastKey = "";
  }
}

/** Unread direct messages and invites. */
export function setTrayUnread(count: number): void {
  unread = count;
  void update();
}

voice.subscribe(() => void update());
onLangChange(() => void update());
void update();
