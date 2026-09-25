import { useState, type ReactNode } from "react";

import { t, type Key } from "../i18n/index.ts";
import {
  IconBold,
  IconChecklist,
  IconCode,
  IconCodeBlock,
  IconHeading,
  IconHelp,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconQuote,
  IconSpoiler,
  IconStrike,
  IconUnderline,
} from "./icons.tsx";

/**
 * Markdown helpers for the message field: wrap the selection in markers or
 * prefix the selected lines, and toggle them off when they are already there.
 * Each edit returns the new text and the selection to restore.
 */

export type Edit = { text: string; start: number; end: number };

export type FormatId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "spoiler"
  | "code"
  | "codeblock"
  | "link"
  | "quote"
  | "list"
  | "numbers"
  | "tasks"
  | "heading";

function wrap(text: string, s: number, e: number, marker: string, placeholder: string): Edit {
  const m = marker.length;
  // already wrapped around the selection: unwrap
  if (e > s && text.slice(s - m, s) === marker && text.slice(e, e + m) === marker) {
    return { text: text.slice(0, s - m) + text.slice(s, e) + text.slice(e + m), start: s - m, end: e - m };
  }
  const sel = text.slice(s, e);
  if (sel.length > 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, -m);
    return { text: text.slice(0, s) + inner + text.slice(e), start: s, end: s + inner.length };
  }
  const body = sel || placeholder;
  return { text: text.slice(0, s) + marker + body + marker + text.slice(e), start: s + m, end: s + m + body.length };
}

function lines(text: string, s: number, e: number, prefix: (i: number) => string, pattern: RegExp): Edit {
  const from = text.lastIndexOf("\n", s - 1) + 1;
  const nl = text.indexOf("\n", Math.max(e - (e > s && text[e - 1] === "\n" ? 1 : 0), s));
  const to = nl === -1 ? text.length : nl;
  const block = text.slice(from, to).split("\n");
  const on = block.every((l) => pattern.test(l));
  const next = block.map((l, i) => (on ? l.replace(pattern, "") : prefix(i) + l)).join("\n");
  return { text: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length };
}

export function applyFormat(id: FormatId, text: string, s: number, e: number): Edit {
  const ph = t("format.placeholder");
  switch (id) {
    case "bold":
      return wrap(text, s, e, "**", ph);
    case "italic":
      return wrap(text, s, e, "*", ph);
    case "underline":
      return wrap(text, s, e, "__", ph);
    case "strike":
      return wrap(text, s, e, "~~", ph);
    case "spoiler":
      return wrap(text, s, e, "||", ph);
    case "code":
      return wrap(text, s, e, "`", "code");
    case "codeblock": {
      const sel = text.slice(s, e) || "code";
      const before = s > 0 && text[s - 1] !== "\n" ? "\n" : "";
      const out = `${before}\`\`\`\n${sel}\n\`\`\`\n`;
      const at = s + before.length + 4;
      return { text: text.slice(0, s) + out + text.slice(e), start: at, end: at + sel.length };
    }
    case "link": {
      const sel = text.slice(s, e) || t("format.linkText");
      const out = `[${sel}](https://)`;
      const url = s + sel.length + 3;
      return { text: text.slice(0, s) + out + text.slice(e), start: url, end: url + 8 };
    }
    case "quote":
      return lines(text, s, e, () => "> ", /^> ?/);
    case "list":
      return lines(text, s, e, () => "- ", /^[-*] (?!\[[ xX]\] )/);
    case "numbers":
      return lines(text, s, e, (i) => `${i + 1}. `, /^\d+\. /);
    case "tasks":
      return lines(text, s, e, () => "- [ ] ", /^[-*] \[[ xX]\] /);
    case "heading":
      return lines(text, s, e, () => "## ", /^#{1,3} /);
  }
}

/** Ctrl shortcuts inside the field. */
export function formatForKey(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }): FormatId | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.shiftKey) return e.code === "KeyX" ? "strike" : null;
  const map: Record<string, FormatId> = { KeyB: "bold", KeyI: "italic", KeyU: "underline", KeyE: "code", KeyK: "link" };
  return map[e.code] ?? null;
}

const BUTTONS: { id: FormatId; icon: ReactNode; name: Key; keys?: string }[] = [
  { id: "bold", icon: <IconBold />, name: "format.bold", keys: "Ctrl+B" },
  { id: "italic", icon: <IconItalic />, name: "format.italic", keys: "Ctrl+I" },
  { id: "underline", icon: <IconUnderline />, name: "format.underline", keys: "Ctrl+U" },
  { id: "strike", icon: <IconStrike />, name: "format.strike", keys: "Ctrl+Shift+X" },
  { id: "spoiler", icon: <IconSpoiler />, name: "format.spoiler" },
  { id: "code", icon: <IconCode />, name: "format.code", keys: "Ctrl+E" },
  { id: "codeblock", icon: <IconCodeBlock />, name: "format.codeblock" },
  { id: "link", icon: <IconLink />, name: "format.link", keys: "Ctrl+K" },
  { id: "quote", icon: <IconQuote />, name: "format.quote" },
  { id: "list", icon: <IconList />, name: "format.list" },
  { id: "numbers", icon: <IconListNumbers />, name: "format.numbers" },
  { id: "tasks", icon: <IconChecklist />, name: "format.tasks" },
  { id: "heading", icon: <IconHeading />, name: "format.heading" },
];

/** Syntax and what it gives; "%" stands for sample text. */
const CHEATSHEET: [string, Key][] = [
  ["**%**", "format.bold"],
  ["*%*", "format.italic"],
  ["__%__", "format.underline"],
  ["~~%~~", "format.strike"],
  ["||%||", "format.spoiler"],
  ["`code`", "format.code"],
  ["```\ncode\n```", "format.codeblock"],
  ["[%](https://...)", "format.link"],
  ["> %", "format.quote"],
  ["- %", "format.list"],
  ["1. %", "format.numbers"],
  ["- [ ] %", "format.tasks"],
  ["# ## ###", "format.heading"],
  ["| a | b |\n|---|---|", "format.table"],
];

export function FormatBar({ onFormat }: { onFormat: (id: FormatId) => void }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="format-bar" onMouseDown={(e) => e.preventDefault()}>
      {BUTTONS.map((b) => (
        <button
          key={b.id}
          type="button"
          className="ghost icon small"
          title={b.keys ? `${t(b.name)} (${b.keys})` : t(b.name)}
          onClick={() => onFormat(b.id)}
        >
          {b.icon}
        </button>
      ))}
      <button type="button" className={`ghost icon small push-right ${help ? "on-soft" : ""}`} title={t("format.help")} onClick={() => setHelp(!help)}>
        <IconHelp />
      </button>
      {help && (
        <div className="md-help">
          <b>{t("format.help")}</b>
          <table>
            <tbody>
              {CHEATSHEET.map(([code, name]) => (
                <tr key={name}>
                  <td>
                    <code>{code.replaceAll("%", t("format.sampleText"))}</code>
                  </td>
                  <td>{t(name)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="state">{t("format.helpNote")}</span>
        </div>
      )}
    </div>
  );
}
