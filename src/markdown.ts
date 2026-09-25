/**
 * Markdown for chat messages, close to what Discord accepts.
 *
 * Blocks: paragraphs (every line break is kept), # to ### headings, fenced
 * code, > quotes and >>> for the rest of the message, - and 1. lists with
 * nesting, - [ ] task items, pipe tables, --- rules. Inline: **bold**,
 * *italic* and _italic_, __underline__, ~~strike~~, ||spoiler||, `code`,
 * [text](url), bare links, backslash escapes.
 *
 * The parser builds a small tree. The page renders it as React elements
 * (ui/Markdown.tsx); for other clients it is turned into the HTML that Matrix
 * carries in formatted_body. Raw HTML in the source is never interpreted.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "b" | "i" | "u" | "s" | "spoiler"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Item = {
  /** null: a plain item; true or false: a task item and whether the source marks it done. */
  task: boolean | null;
  /** Stable id of a task item within the message, derived from its text. */
  key: string;
  c: Inline[];
  sub: Block[];
};

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Item[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/* ------------------------------------------------------------------ inline */

const ESCAPABLE = /[\\`*_~|[\]()#>+\-.!<{}]/;
const URL_AT = /^(?:https?:\/\/|mailto:)[^\s<>"]+/i;
const TRAILING = /[.,:;!?)\]}'"»]+$/;
const WORD = /[\p{L}\p{N}]/u;

function safeHref(href: string): string {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : "";
}

function pushText(out: Inline[], v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last?.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Skip a code span that starts at `i`; returns the index after it, or -1 if it does not close. */
function skipCode(src: string, i: number): number {
  let n = 1;
  while (src[i + n] === "`") n += 1;
  const end = src.indexOf("`".repeat(n), i + n);
  return end === -1 ? -1 : end + n;
}

/** Where the marker opened at `from` closes, or -1. Code spans and escapes are skipped. */
function findClose(src: string, from: number, marker: string): number {
  for (let j = from; j <= src.length - marker.length; j += 1) {
    const c = src[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "`") {
      const after = skipCode(src, j);
      if (after !== -1) j = after - 1;
      continue;
    }
    if (marker === "*" && src.startsWith("**", j)) {
      // a nested **bold** inside *italic*: jump over its closing too
      const inner = findClose(src, j + 2, "**");
      if (inner !== -1) {
        j = inner + 1;
        continue;
      }
    }
    if (!src.startsWith(marker, j)) continue;
    if (j === from || /\s/.test(src[j - 1])) continue;
    if (marker === "_" && WORD.test(src[j + 1] ?? "")) continue;
    if (marker.length === 1 && src[j + 1] === marker) {
      j += 1;
      continue;
    }
    return j;
  }
  return -1;
}

const PAIRS: { marker: string; t: "b" | "i" | "u" | "s" | "spoiler" }[] = [
  { marker: "||", t: "spoiler" },
  { marker: "**", t: "b" },
  { marker: "__", t: "u" },
  { marker: "~~", t: "s" },
  { marker: "*", t: "i" },
  { marker: "_", t: "i" },
];

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out.push({ t: "br" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      const after = skipCode(src, i);
      if (after !== -1) {
        let n = 1;
        while (src[i + n] === "`") n += 1;
        let code = src.slice(i + n, after - n);
        if (n > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ t: "code", v: code });
        i = after;
        continue;
      }
    }

    // ***both*** is bold around italic
    if (src.startsWith("***", i) && i + 3 < src.length && !/\s/.test(src[i + 3])) {
      const end = findClose(src, i + 3, "***");
      if (end !== -1) {
        out.push({ t: "b", c: [{ t: "i", c: parseInline(src.slice(i + 3, end)) }] });
        i = end + 3;
        continue;
      }
    }

    let matched = false;
    for (const p of PAIRS) {
      if (!src.startsWith(p.marker, i)) continue;
      const start = i + p.marker.length;
      if (start >= src.length || /\s/.test(src[start])) continue;
      if (p.marker === "_" && i > 0 && WORD.test(src[i - 1])) continue;
      const end = findClose(src, start, p.marker);
      if (end === -1) continue;
      out.push({ t: p.t, c: parseInline(src.slice(start, end)) });
      i = end + p.marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    if (ch === "[") {
      const link = /^\[([^\]\n]+)\]\(\s*<?([^()\s<>]+)>?\s*\)/.exec(src.slice(i));
      const href = link ? safeHref(link[2]) : "";
      if (link && href) {
        out.push({ t: "link", href, c: parseInline(link[1]) });
        i += link[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        out.push({ t: "link", href: auto[1], c: [{ t: "text", v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H" || ch === "m" || ch === "M") && (i === 0 || !WORD.test(src[i - 1]))) {
      const bare = URL_AT.exec(src.slice(i));
      if (bare) {
        const url = bare[0].replace(TRAILING, "");
        if (url.length > 8) {
          out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    pushText(out, ch);
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ blocks */

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

type Ctx = { keys: Map<string, number> };

function taskKey(ctx: Ctx, text: string): string {
  const base = text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
  const n = (ctx.keys.get(base) ?? 0) + 1;
  ctx.keys.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

function parseList(lines: string[], at: number, ctx: Ctx): { block: Block; next: number } {
  const first = LIST.exec(lines[at]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number.parseInt(first[2], 10) || 1 : 1;
  const raw: { text: string; subLines: string[] }[] = [];
  let i = at;

  while (i < lines.length) {
    const line = lines[i];
    const m = LIST.exec(line);
    if (m && m[1].length <= indent + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      raw.push({ text: m[3], subLines: [] });
      i += 1;
      continue;
    }
    const last = raw[raw.length - 1];
    if (!last || !line.trim()) break;
    const lead = /^\s*/.exec(line)?.[0].length ?? 0;
    if (lead < indent + 2) break;
    // deeper lines belong to the last item: a nested list or a continuation
    if (m || last.subLines.length) last.subLines.push(line.slice(indent + 2));
    else last.text += `\n${line.trim()}`;
    i += 1;
  }

  const items: Item[] = raw.map((r) => {
    const task = TASK.exec(r.text);
    const text = task ? task[2] : r.text;
    return {
      task: task ? task[1] !== " " : null,
      key: task ? taskKey(ctx, text) : "",
      c: parseInline(text),
      sub: r.subLines.length ? parseBlocks(r.subLines, ctx) : [],
    };
  });
  return { block: { t: "list", ordered, start, items }, next: i };
}

function parseBlocks(lines: string[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const close = lines.findIndex((l, k) => k > i && l.trim().startsWith(fence[1]) && !l.trim().slice(fence[1].length).trim());
      const end = close === -1 ? lines.length : close;
      flush();
      out.push({ t: "code", lang: fence[2], v: lines.slice(i + 1, end).join("\n") });
      i = end + 1;
      continue;
    }

    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ t: "h", level: heading[1].length as 1 | 2 | 3, c: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      out.push({ t: "hr" });
      i += 1;
      continue;
    }

    if (/^\s*>>>\s?/.test(line)) {
      flush();
      const rest = [line.replace(/^\s*>>>\s?/, ""), ...lines.slice(i + 1)];
      out.push({ t: "quote", c: parseBlocks(rest, ctx) });
      break;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i += 1;
      }
      out.push({ t: "quote", c: parseBlocks(inner, ctx) });
      continue;
    }

    if (LIST.test(line)) {
      flush();
      const { block, next } = parseList(lines, i, ctx);
      out.push(block);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i += 1;
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }

    para.push(line);
    i += 1;
  }
  flush();
  return out;
}

export function parse(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"), { keys: new Map() });
}

/** True when the text has no markup at all: plain text with line breaks and bare links. */
export function isPlain(blocks: Block[]): boolean {
  if (blocks.length !== 1 || blocks[0].t !== "p") return blocks.length === 0;
  return blocks[0].c.every(
    (n) => n.t === "text" || n.t === "br" || (n.t === "link" && n.c.length === 1 && n.c[0].t === "text" && n.c[0].v === n.href),
  );
}

/** Task items of a message, in order, with the state written in the source. */
export function tasks(blocks: Block[]): { key: string; done: boolean }[] {
  const out: { key: string; done: boolean }[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "quote") walk(b.c);
      if (b.t !== "list") continue;
      for (const it of b.items) {
        if (it.task !== null) out.push({ key: it.key, done: it.task });
        walk(it.sub);
      }
    }
  };
  walk(blocks);
  return out;
}

/* -------------------------------------------------------------------- html */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return esc(n.v);
        case "br":
          return "<br>";
        case "code":
          return `<code>${esc(n.v)}</code>`;
        case "b":
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case "i":
          return `<em>${inlineHtml(n.c)}</em>`;
        case "u":
          return `<u>${inlineHtml(n.c)}</u>`;
        case "s":
          return `<del>${inlineHtml(n.c)}</del>`;
        case "spoiler":
          return `<span data-mx-spoiler>${inlineHtml(n.c)}</span>`;
        case "link":
          return `<a href="${esc(n.href)}">${inlineHtml(n.c)}</a>`;
      }
    })
    .join("");
}

function blockHtml(b: Block): string {
  switch (b.t) {
    case "p":
      return `<p>${inlineHtml(b.c)}</p>`;
    case "h":
      return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
    case "code":
      return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.v)}</code></pre>`;
    case "quote":
      return `<blockquote>${b.c.map(blockHtml).join("")}</blockquote>`;
    case "hr":
      return "<hr>";
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      const items = b.items
        .map((it) => {
          // Matrix clients drop <input>, so the box is a character
          const box = it.task === null ? "" : it.task ? "☑ " : "☐ ";
          return `<li>${box}${inlineHtml(it.c)}${it.sub.map(blockHtml).join("")}</li>`;
        })
        .join("");
      return `<${tag}${start}>${items}</${tag}>`;
    }
    case "table": {
      const cell = (tag: string, c: Inline[], k: number) => {
        const a = b.align[k];
        return `<${tag}${a ? ` align="${a}"` : ""}>${inlineHtml(c)}</${tag}>`;
      };
      const head = `<thead><tr>${b.head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>`;
      const rows = b.rows.map((r) => `<tr>${r.map((c, k) => cell("td", c, k)).join("")}</tr>`).join("");
      return `<table>${head}<tbody>${rows}</tbody></table>`;
    }
  }
}

/** formatted_body for Matrix. A lone paragraph goes without <p>, as Element does. */
export function toHtml(blocks: Block[]): string {
  if (blocks.length === 1 && blocks[0].t === "p") return inlineHtml(blocks[0].c);
  return blocks.map(blockHtml).join("");
}

/** Message content fields for a text: formatted_body only when there is markup. */
export function formatted(text: string): { format?: string; formatted_body?: string } {
  const blocks = parse(text);
  if (isPlain(blocks)) return {};
  return { format: "org.matrix.custom.html", formatted_body: toHtml(blocks) };
}
