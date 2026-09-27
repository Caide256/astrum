import { useMemo, useState, type ReactNode } from "react";

import { copyToClipboard } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { GROUP_MENTIONS, parse, parseInline, type Block, type Inline, type Item, type MentionResolver } from "../markdown.ts";
import { idsHidden } from "../prefs.ts";
import { IconCheck, IconCopy } from "./icons.tsx";

/**
 * Markdown message text as React elements. Task items are buttons when
 * `onToggle` is given; `checks` overrides the state written in the source
 * with the latest toggle from the room.
 */

export type CheckState = { done: boolean; by: string; ts: number };

type Ctx = {
  checks: Record<string, CheckState>;
  onToggle?: (key: string, done: boolean) => void;
  whoName?: (userId: string) => string;
  mentions?: MentionView;
};

/** How mentions look: who a name means, the own id for the highlight, a click on a person. */
export type MentionView = { resolve: MentionResolver; me: string; open: (userId: string) => void };

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`md-spoiler ${open ? "open" : ""}`}
      title={open ? undefined : t("md.spoiler")}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
    >
      {children}
    </span>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span>{lang}</span>
        <button
          className="ghost icon tiny"
          title={copied ? t("md.copied") : t("md.copy")}
          onClick={() =>
            void copyToClipboard(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function inline(nodes: Inline[], key = "", mv?: MentionView): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "mention": {
        if ((GROUP_MENTIONS as readonly string[]).includes(n.id.toLowerCase())) {
          return (
            <span key={k} className="mention group">
              {n.id}
            </span>
          );
        }
        const who = mv?.resolve(n.id);
        if (!who) return n.id;
        return (
          <span
            key={k}
            className={`mention ${who.userId === mv?.me ? "me" : ""}`}
            title={idsHidden() ? undefined : who.userId}
            onClick={(e) => {
              e.stopPropagation();
              mv?.open(who.userId);
            }}
          >
            @{who.name}
          </span>
        );
      }
      case "text":
        return n.v;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className="md-code">
            {n.v}
          </code>
        );
      case "b":
        return <strong key={k}>{inline(n.c, `${k}-`, mv)}</strong>;
      case "i":
        return <em key={k}>{inline(n.c, `${k}-`, mv)}</em>;
      case "u":
        return <u key={k}>{inline(n.c, `${k}-`, mv)}</u>;
      case "s":
        return <del key={k}>{inline(n.c, `${k}-`, mv)}</del>;
      case "spoiler":
        return <Spoiler key={k}>{inline(n.c, `${k}-`, mv)}</Spoiler>;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer" title={n.href}>
            {inline(n.c, `${k}-`, mv)}
          </a>
        );
    }
  });
}

function TaskItem({ item, ctx, k }: { item: Item; ctx: Ctx; k: string }) {
  const state = ctx.checks[item.key];
  const done = state ? state.done : !!item.task;
  const who = state?.by && ctx.whoName ? ctx.whoName(state.by) : "";
  return (
    <li className={`md-task ${done ? "done" : ""}`}>
      <button
        className={`md-box ${done ? "on" : ""}`}
        disabled={!ctx.onToggle}
        title={who ? (done ? t("md.checkedBy", { who }) : t("md.uncheckedBy", { who })) : done ? t("md.uncheck") : t("md.check")}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onToggle?.(item.key, !done);
        }}
      >
        {done && <IconCheck size={12} />}
      </button>
      <span className="md-task-text">
        {inline(item.c, `${k}t`, ctx.mentions)}
        {item.sub.map((b, i) => block(b, ctx, `${k}s${i}`))}
      </span>
    </li>
  );
}

function block(b: Block, ctx: Ctx, k: string): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={k} className="md-p">
          {inline(b.c, k, ctx.mentions)}
        </p>
      );
    case "h": {
      const Tag = `h${b.level}` as "h1" | "h2" | "h3";
      return (
        <Tag key={k} className="md-h">
          {inline(b.c, k, ctx.mentions)}
        </Tag>
      );
    }
    case "code":
      return <CodeBlock key={k} lang={b.lang} code={b.v} />;
    case "quote":
      return (
        <blockquote key={k} className="md-quote">
          {b.c.map((x, i) => block(x, ctx, `${k}q${i}`))}
        </blockquote>
      );
    case "hr":
      return <hr key={k} className="md-hr" />;
    case "list": {
      const items = b.items.map((it, i) =>
        it.task === null ? (
          <li key={`${k}i${i}`}>
            {inline(it.c, `${k}i${i}`, ctx.mentions)}
            {it.sub.map((x, j) => block(x, ctx, `${k}i${i}s${j}`))}
          </li>
        ) : (
          <TaskItem key={`${k}i${i}`} item={it} ctx={ctx} k={`${k}i${i}`} />
        ),
      );
      const tasky = b.items.some((it) => it.task !== null);
      return b.ordered ? (
        <ol key={k} className="md-list" start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={k} className={`md-list ${tasky ? "tasks" : ""}`}>
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={k} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                    {inline(c, `${k}h${i}`, ctx.mentions)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {inline(c, `${k}r${i}c${j}`, ctx.mentions)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * One line of formatting for previews such as a reply quote: block markers
 * (headings, quotes, list bullets, code fences) are dropped, line breaks
 * become spaces, inline formatting stays.
 */
export function InlineMarkdown({ text, mentions }: { text: string; mentions?: MentionView }) {
  const nodes = useMemo(() => {
    const flat = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((l) => !/^\s*(`{3,}|~{3,})/.test(l))
      .map((l) => l.replace(/^\s*(#{1,3}\s+|>+\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/, ""))
      .filter((l) => l.trim())
      .join(" ");
    return parseInline(flat);
  }, [text]);
  return <span className="md md-inline">{inline(nodes, "", mentions)}</span>;
}

export function Markdown({
  text,
  checks = {},
  onToggle,
  whoName,
  mentions,
}: {
  text: string;
  checks?: Record<string, CheckState>;
  onToggle?: (key: string, done: boolean) => void;
  whoName?: (userId: string) => string;
  mentions?: MentionView;
}) {
  const blocks = useMemo(() => parse(text), [text]);
  const ctx: Ctx = { checks, onToggle, whoName, mentions };
  return <div className="md">{blocks.map((b, i) => block(b, ctx, `b${i}`))}</div>;
}
