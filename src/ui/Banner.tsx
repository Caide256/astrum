import type { CSSProperties, ReactNode } from "react";

import { useAvatarColor } from "../avatarColor.ts";
import { frameOf, type BannerPlace, type TileLook } from "../voice/voice.ts";
import { useMxc } from "./Avatar.tsx";

/**
 * A person's banner: the top of the profile card and the background of the
 * call tile. The picture, a color, or the color of the avatar, with up to
 * three emoji scattered over it.
 */

/** Fixed spots for the emoji: they look scattered but never jump around. */
const SPOTS = [
  { left: 7, top: 22, size: 1.0, rot: -14 },
  { left: 27, top: 70, size: 0.7, rot: 10 },
  { left: 45, top: 18, size: 0.85, rot: 6 },
  { left: 63, top: 64, size: 1.1, rot: -8 },
  { left: 81, top: 22, size: 0.75, rot: 16 },
  { left: 93, top: 72, size: 0.9, rot: -4 },
  { left: 15, top: 88, size: 0.6, rot: 20 },
  { left: 76, top: 92, size: 0.65, rot: -18 },
];

export function splitEmoji(text: string): string[] {
  if (!text) return [];
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
}

/**
 * Inline style of a banner. `fallback` shows while the avatar color loads, for
 * no banner at all, and under a picture: the picture itself is a separate
 * layer (BannerPicture), so it can be enlarged around a chosen point.
 */
export function useBannerStyle(look: TileLook | null, avatar: string, fallback: string): CSSProperties {
  const auto = look?.mode === "dominant" || look?.mode === "edge";
  const color = useAvatarColor(auto ? avatar : "", auto ? (look?.mode as "dominant" | "edge") : null);
  if (look?.mode === "image") return { background: fallback };
  if (look?.mode === "color") return { background: look.color || fallback };
  return { background: color || fallback };
}

/**
 * The picture of a banner, filling its box with the framing of that place:
 * the profile card and a call tile are framed apart, being of different shapes.
 */
export function BannerPicture({ look, place }: { look: TileLook | null; place: BannerPlace }) {
  const url = useMxc(look?.mode === "image" ? (look.image ?? "") : "");
  if (!url || look?.mode !== "image") return null;
  const frame = frameOf(look, place);
  const zoom = frame.zoom;
  const at = `${frame.x}% ${frame.y}%`;
  return (
    <img
      className="banner-picture"
      src={url}
      alt=""
      draggable={false}
      style={{ objectPosition: at, transformOrigin: at, transform: zoom !== 1 ? `scale(${zoom})` : undefined }}
    />
  );
}

/** The emoji of a banner, spread over its whole area. */
export function EmojiDeco({ emoji, scale = 1 }: { emoji?: string; scale?: number }) {
  const list = splitEmoji(emoji ?? "");
  if (!list.length) return null;
  return (
    <div className="banner-deco" aria-hidden>
      {SPOTS.map((s, i) => (
        <span
          key={i}
          style={{
            left: `${s.left}%`,
            top: `${s.top}%`,
            fontSize: `${(s.size * 1.7 * scale).toFixed(2)}em`,
            transform: `translate(-50%, -50%) rotate(${s.rot}deg)`,
          }}
        >
          {list[i % list.length]}
        </span>
      ))}
    </div>
  );
}

export function Banner({
  look,
  avatar,
  place = "card",
  className = "",
  children,
}: {
  look: TileLook | null;
  avatar: string;
  place?: BannerPlace;
  className?: string;
  children?: ReactNode;
}) {
  const style = useBannerStyle(look, avatar, "var(--bg-3)");
  return (
    <div className={`banner ${className}`} style={style}>
      <BannerPicture look={look} place={place} />
      <EmojiDeco emoji={look?.emoji} />
      {children}
    </div>
  );
}
