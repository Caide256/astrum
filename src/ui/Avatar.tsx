import { useEffect, useState } from "react";

import { t, type Key } from "../i18n/index.ts";
import { mediaUrl, peekMedia } from "../media.ts";

export function initials(name: string): string {
  const clean = name.replace(/^[#@!]/, "").trim();
  const parts = clean.split(/[\s\-_]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
}

/** Image URL for an mxc URI, "" while it downloads. */
export function useMxc(mxc: string, size = 0): string {
  const [url, setUrl] = useState(() => peekMedia(mxc, size));

  useEffect(() => {
    const ready = peekMedia(mxc, size);
    setUrl(ready);
    if (!mxc || ready) return;

    let alive = true;
    void mediaUrl(mxc, size).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [mxc, size]);

  return url;
}

export type Status = "online" | "unavailable" | "offline";

type Props = {
  mxc?: string | null;
  name: string;
  size?: number;
  className?: string;
  title?: string;
  /** Status dot at the bottom right: green online, yellow away. */
  status?: Status | null;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

const STATUS_TITLE: Record<Status, Key> = { online: "presence.online", unavailable: "presence.away", offline: "presence.offline" };

/** Avatar: the picture if there is one, otherwise the initials. */
export function Avatar({ mxc, name, size = 34, className = "", title, status, onClick, onContextMenu }: Props) {
  // a thumbnail at twice the size stays sharp on high-DPI screens
  const url = useMxc(mxc ?? "", Math.round(size * 2));

  const face = (
    <div
      className={`avatar ${status ? "" : className}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
      title={status ? undefined : title}
      onClick={status ? undefined : onClick}
      onContextMenu={status ? undefined : onContextMenu}
    >
      {url ? <img src={url} alt="" /> : initials(name)}
    </div>
  );
  // offline has no dot: such rows are just dimmed
  if (!status) return face;

  // the avatar is round and clips everything outside, so the dot lives in a
  // wrapper; a ring in the background color separates it from the picture
  const inner = Math.max(7, Math.round(size * 0.28));
  const ring = Math.max(2, Math.round(size * 0.09));
  const shift = -Math.round(ring * 0.6);
  return (
    <div
      className={`avatar-wrap ${className}`}
      style={{ width: size, height: size }}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {face}
      {status !== "offline" && (
        <span
          className={`status-dot ${status}`}
          title={t(STATUS_TITLE[status])}
          style={{ width: inner + ring * 2, height: inner + ring * 2, borderWidth: ring, right: shift, bottom: shift }}
        />
      )}
    </div>
  );
}
