import { useEffect, useState } from "react";

import { mediaUrl } from "./media.ts";

/**
 * A color from an avatar for the call tile behind it: the most common
 * colorful one, or the average along the picture's edge, which continues the
 * picture outwards. Computed on a small thumbnail once per avatar.
 */

export type ColorMode = "dominant" | "edge";

const cache = new Map<string, Promise<string | null>>();
const SIDE = 48;

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

function pixels(url: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SIDE;
        canvas.height = SIDE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SIDE, SIDE);
        resolve(ctx.getImageData(0, 0, SIDE, SIDE).data);
      } catch {
        // a picture from another origin cannot be read
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function edgeColor(data: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      if (x > 2 && y > 2 && x < SIDE - 3 && y < SIDE - 3) continue;
      const i = (y * SIDE + x) * 4;
      if (data[i + 3] < 200) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  return n ? hex(r / n, g / n, b / n) : null;
}

function dominantColor(data: Uint8ClampedArray): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; sat: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, sat: (Math.max(r, g, b) - Math.min(r, g, b)) / 255 };
    bucket.n += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  let score = -1;
  for (const bucket of buckets.values()) {
    // frequent and colorful beats frequent and grey: a photo's wall should not win over the face
    const s = bucket.n * (0.35 + bucket.sat);
    if (s > score) {
      score = s;
      best = bucket;
    }
  }
  return best ? hex(best.r / best.n, best.g / best.n, best.b / best.n) : null;
}

export function avatarColor(mxc: string, mode: ColorMode): Promise<string | null> {
  if (!mxc) return Promise.resolve(null);
  const key = `${mode}|${mxc}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const url = await mediaUrl(mxc, 96);
      if (!url) return null;
      const data = await pixels(url);
      if (!data) return null;
      return mode === "edge" ? edgeColor(data) : dominantColor(data);
    })();
    cache.set(key, p);
  }
  return p;
}

/** The avatar color, or null while it is computed or when there is no picture. */
export function useAvatarColor(mxc: string, mode: ColorMode | null): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    setColor(null);
    if (!mxc || !mode) return;
    let alive = true;
    void avatarColor(mxc, mode).then((c) => alive && setColor(c));
    return () => {
      alive = false;
    };
  }, [mxc, mode]);
  return color;
}
