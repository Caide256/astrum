import { useMemo, useState, type ReactNode } from "react";

import { copyToClipboard } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { parse, type Block, type Inline, type Item } from "../markdown.ts";
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
};

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

function inline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
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
        return <strong key={k}>{inline(n.c, `${k}-`)}</strong>;
      case "i":
        return <em key={k}>{inline(n.c, `${k}-`)}</em>;
      case "u":
        return <u key={k}>{inline(n.c, `${k}-`)}</u>;
      case "s":
        return <del key={k}>{inline(n.c, `${k}-`)}</del>;
      case "spoiler":
        return <Spoiler key={k}>{inline(n.c, `${k}-`)}</Spoiler>;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer" title={n.href}>
            {inline(n.c, `${k}-`)}
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
        {inline(item.c, `${k}t`)}
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
          {inline(b.c, k)}
        </p>
      );
    case "h": {
      const Tag = `h${b.level}` as "h1" | "h2" | "h3";
      return (
        <Tag key={k} className="md-h">
          {inline(b.c, k)}
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
            {inline(it.c, `${k}i${i}`)}
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
                    {inline(c, `${k}h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {inline(c, `${k}r${i}c${j}`)}
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

export function Markdown({
  text,
  checks = {},
  onToggle,
  whoName,
}: {
  text: string;
  checks?: Record<string, CheckState>;
  onToggle?: (key: string, done: boolean) => void;
  whoName?: (userId: string) => string;
}) {
  const blocks = useMemo(() => parse(text), [text]);
  const ctx: Ctx = { checks, onToggle, whoName };
  return <div className="md">{blocks.map((b, i) => block(b, ctx, `b${i}`))}</div>;
}
