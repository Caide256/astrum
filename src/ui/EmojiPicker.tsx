import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { t, type Key } from "../i18n/index.ts";
import { EMOJI_GROUPS, QUICK_REACTIONS, noteEmoji, recentEmoji } from "./emoji.ts";

/**
 * Emoji picker for both messages and reactions. A click inserts and closes,
 * Shift+click inserts and keeps the picker open to pick several.
 */
export function EmojiPicker({
  onPick,
  onClose,
  className = "",
  style,
  forReaction = false,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  forReaction?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState("recent");
  const [hover, setHover] = useState("");

  const groups = useMemo(() => {
    const recent = recentEmoji();
    const first = recent.length ? recent : forReaction ? QUICK_REACTIONS : [];
    const head: Key = recent.length ? "emoji.recent" : "emoji.frequent";
    return [...(first.length ? [{ id: "recent", title: head, icon: "🕘", list: first }] : []), ...EMOJI_GROUPS];
  }, [forReaction]);

  // a click outside and Escape close it like any popup
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // deferred so the click that opened the picker does not close it
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const jump = (id: string) => {
    const el = grid.current?.querySelector<HTMLElement>(`[data-group="${id}"]`);
    // the scroll container is the offsetParent, so offsetTop is relative to it
    if (el && grid.current) grid.current.scrollTop = el.offsetTop;
    setActive(id);
  };

  // the tab on top follows the scroll position
  const onScroll = () => {
    const g = grid.current;
    if (!g) return;
    let current = groups[0]?.id ?? "";
    for (const el of g.querySelectorAll<HTMLElement>("[data-group]")) {
      if (el.offsetTop <= g.scrollTop + 8) current = el.dataset.group ?? current;
    }
    setActive(current);
  };

  const pick = (emoji: string, keep: boolean) => {
    noteEmoji(emoji);
    onPick(emoji);
    if (!keep) onClose();
  };

  return (
    <div className={`emoji-picker ${className}`} style={style} ref={box} onMouseDown={(e) => e.stopPropagation()}>
      <div className="emoji-tabs">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            className={active === g.id ? "on" : ""}
            title={t(g.title)}
            onClick={() => jump(g.id)}
          >
            {g.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid-scroll" ref={grid} onScroll={onScroll}>
        {groups.map((g) => (
          <section key={g.id} data-group={g.id}>
            <div className="emoji-group-title">{t(g.title)}</div>
            <div className="emoji-cells">
              {g.list.map((e) => (
                <button
                  key={e}
                  type="button"
                  onMouseEnter={() => setHover(e)}
                  onClick={(ev) => pick(e, ev.shiftKey)}
                >
                  {e}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="emoji-foot">
        <span className="emoji-big">{hover || groups[0]?.list[0]}</span>
        <span className="state">{t("emoji.multi")}</span>
      </div>
    </div>
  );
}
