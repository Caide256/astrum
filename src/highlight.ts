/**
 * Colors for code blocks, as in a code editor.
 *
 * The language comes from the fence (```py), or else it is guessed from the
 * code itself; code that looks like no language stays plain text. There is
 * no grammar behind it: a scanner per family of languages tells comments,
 * strings, numbers, keywords, types, calls and the like apart, which is what
 * the eye reads code by. What a scanner does not know simply stays uncolored.
 */

export type Kind =
  | "kw"
  | "store"
  | "lit"
  | "type"
  | "str"
  | "num"
  | "com"
  | "fn"
  | "var"
  | "prop"
  | "tag"
  | "attr"
  | "meta"
  | "punc"
  | "esc"
  | "head"
  | "ins"
  | "del";

export type Token = { k: Kind | null; v: string };

/** The language id ("" for plain text), its name for the corner of the block, the colored pieces. */
export type Highlighted = { lang: string; label: string; tokens: Token[] };

/** Longer code is shown plain: thousands of colored pieces are not worth the wait. */
const MAX_CHARS = 60_000;
/** A block with a longer line is shown plain too: the line scanners take time by the square of a line. */
const MAX_LINE = 2000;

/**
 * A scanner that stops moving or thinks too long gives the block up, and it
 * is shown as plain text: colors are not worth a frozen window.
 */
class GiveUp extends Error {}
const BUDGET_MS = 150;
let deadline = 0;
let steps = 0;

/** One step of a scanner loop at `at`; `last` is where the previous step was. */
function step(at: number, last: number): number {
  if (at === last) throw new GiveUp();
  steps += 1;
  if ((steps & 1023) === 0 && Date.now() > deadline) throw new GiveUp();
  return at;
}

class Out {
  list: Token[] = [];
  add(k: Kind | null, v: string): void {
    if (!v) return;
    const last = this.list[this.list.length - 1];
    if (last && last.k === k) last.v += v;
    else this.list.push({ k, v });
  }
}

/* ------------------------------------------------------------- languages */

/** Words that steer the flow get one color, the other keywords (declarations, modifiers) another, as in VS Code. */
const CONTROL = new Set(
  (
    "if else elif elsif elseif for foreach while do switch case default break continue return yield try catch except finally " +
    "throw raise await import from export with match when unless until loop then end fi done esac goto select defer go guard " +
    "repeat fallthrough using include require require_once include_once package namespace use mod extern pass in of as"
  ).split(" "),
);

type Spec = {
  line?: string[];
  block?: [string, string][];
  quotes?: string[];
  keywords?: string;
  literals?: string;
  types?: string;
  /** Keywords in any case (SQL, PowerShell). */
  caseless?: boolean;
  /** PascalCase names are types. */
  capTypes?: boolean;
  /** @name is a decorator or an annotation. */
  decorators?: boolean;
  /** A line starting with # is a directive (C, C++, C#). */
  preproc?: boolean;
  /** $name is a variable (shell, PHP, PowerShell). */
  dollar?: boolean;
  /** name! is a macro call (Rust). */
  macros?: boolean;
  /** #[...] is an attribute (Rust). */
  attrs?: boolean;
  /** ' surrounds a single character only (Rust: 'a is a lifetime). */
  charQuote?: boolean;
  /** Letters or signs glued in front of a string: f"", r"", @"". */
  prefix?: RegExp;
  /** -f and --flag after a space are options (shell, PowerShell). */
  flags?: boolean;
  /** The first word of a command is what runs (shell). */
  commands?: boolean;
  /** Verb-Noun names are commands (PowerShell). */
  dashed?: boolean;
  /** # starts a comment only at the start of a word (shell). */
  hashWord?: boolean;
  /** $ is a part of names (JavaScript). */
  dollarIdent?: boolean;
};

type Compiled = Spec & { kw: Set<string>; lit: Set<string>; ty: Set<string> };

type Family = "c" | "markup" | "css" | "json" | "yaml" | "ini" | "diff" | "md";

type Lang = { id: string; name: string; family: Family; spec?: Spec; aliases: string[] };

const JS_KW =
  "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof " +
  "let new of return static super switch this throw try typeof var void while with yield async await get set from as";
const TS_KW = `${JS_KW} interface type enum implements declare readonly abstract private protected public namespace module keyof infer is asserts unique satisfies override accessor`;

const C_KW =
  "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short " +
  "signed sizeof static struct switch typedef union unsigned void volatile while";
const C_TYPES = "size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t bool FILE";

const C_LIKE = { line: ["//"], block: [["/*", "*/"]] as [string, string][] };

const LANGS: Lang[] = [
  {
    id: "javascript",
    name: "JavaScript",
    family: "c",
    aliases: ["js", "jsx", "mjs", "cjs", "javascript", "node"],
    spec: { ...C_LIKE, quotes: ["`", '"', "'"], keywords: JS_KW, literals: "true false null undefined NaN Infinity", capTypes: true, decorators: true, dollarIdent: true },
  },
  {
    id: "typescript",
    name: "TypeScript",
    family: "c",
    aliases: ["ts", "tsx", "mts", "cts", "typescript"],
    spec: {
      ...C_LIKE,
      quotes: ["`", '"', "'"],
      keywords: TS_KW,
      literals: "true false null undefined NaN Infinity",
      types: "string number boolean any unknown never object bigint symbol",
      capTypes: true,
      decorators: true,
      dollarIdent: true,
    },
  },
  {
    id: "python",
    name: "Python",
    family: "c",
    aliases: ["py", "python", "python3", "py3", "gyp"],
    spec: {
      line: ["#"],
      quotes: ['"""', "'''", '"', "'"],
      keywords:
        "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
      literals: "True False None self cls",
      types: "int float str bool list dict set tuple bytes object type complex frozenset bytearray",
      capTypes: true,
      decorators: true,
      prefix: /[rRbBuUfF]{1,2}(?=["'])/y,
    },
  },
  {
    id: "csharp",
    name: "C#",
    family: "c",
    aliases: ["cs", "csharp", "c#"],
    spec: {
      ...C_LIKE,
      quotes: ['"""', '"', "'"],
      keywords:
        "abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var get set init record when where yield nameof partial dynamic required",
      literals: "true false null",
      types: "bool byte char decimal double float int long object sbyte short string uint ulong ushort void",
      capTypes: true,
      preproc: true,
      prefix: /[@$]{1,2}(?=")/y,
    },
  },
  {
    id: "java",
    name: "Java",
    family: "c",
    aliases: ["java"],
    spec: {
      ...C_LIKE,
      quotes: ['"""', '"', "'"],
      keywords:
        "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record yield sealed permits",
      literals: "true false null",
      types: "boolean byte char double float int long short void",
      capTypes: true,
      decorators: true,
    },
  },
  {
    id: "kotlin",
    name: "Kotlin",
    family: "c",
    aliases: ["kt", "kts", "kotlin"],
    spec: {
      ...C_LIKE,
      quotes: ['"""', '"', "'"],
      keywords:
        "as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor init finally import data sealed enum open override private protected public internal abstract companion inline suspend lateinit",
      literals: "true false null",
      capTypes: true,
      decorators: true,
    },
  },
  {
    id: "swift",
    name: "Swift",
    family: "c",
    aliases: ["swift"],
    spec: {
      ...C_LIKE,
      quotes: ['"""', '"'],
      keywords:
        "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is super self Self throw throws try async await some any",
      literals: "true false nil",
      capTypes: true,
      decorators: true,
    },
  },
  {
    id: "go",
    name: "Go",
    family: "c",
    aliases: ["go", "golang"],
    spec: {
      ...C_LIKE,
      quotes: ["`", '"', "'"],
      keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
      literals: "true false nil iota",
      types:
        "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any",
      capTypes: true,
    },
  },
  {
    id: "rust",
    name: "Rust",
    family: "c",
    aliases: ["rs", "rust"],
    spec: {
      ...C_LIKE,
      quotes: ['"', "'"],
      keywords:
        "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while",
      literals: "true false None Some Ok Err self Self",
      types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str",
      capTypes: true,
      macros: true,
      attrs: true,
      charQuote: true,
      prefix: /b?r?(?=")/y,
    },
  },
  {
    id: "c",
    name: "C",
    family: "c",
    aliases: ["c", "h"],
    spec: { ...C_LIKE, quotes: ['"', "'"], keywords: C_KW, literals: "NULL true false", types: C_TYPES, preproc: true },
  },
  {
    id: "cpp",
    name: "C++",
    family: "c",
    aliases: ["cpp", "c++", "cc", "cxx", "hpp", "hxx", "hh", "ino"],
    spec: {
      ...C_LIKE,
      quotes: ['"', "'"],
      keywords: `${C_KW} alignas alignof asm catch class constexpr const_cast decltype delete dynamic_cast explicit export friend mutable namespace new noexcept operator private protected public reinterpret_cast static_assert static_cast template this thread_local throw try typeid typename using virtual override final co_await co_return co_yield concept requires`,
      literals: "true false nullptr NULL",
      types: `${C_TYPES} wchar_t char8_t char16_t char32_t std string vector map`,
      preproc: true,
      capTypes: true,
    },
  },
  {
    id: "php",
    name: "PHP",
    family: "c",
    aliases: ["php"],
    spec: {
      line: ["//", "#"],
      block: [["/*", "*/"]],
      quotes: ['"', "'"],
      keywords:
        "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global goto if implements include include_once instanceof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
      literals: "true false null TRUE FALSE NULL",
      capTypes: true,
      dollar: true,
    },
  },
  {
    id: "ruby",
    name: "Ruby",
    family: "c",
    aliases: ["rb", "ruby"],
    spec: {
      line: ["#"],
      block: [["=begin", "=end"]],
      quotes: ['"', "'", "`"],
      keywords:
        "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer private protected public lambda proc",
      literals: "true false nil self",
      capTypes: true,
    },
  },
  {
    id: "lua",
    name: "Lua",
    family: "c",
    aliases: ["lua", "luau"],
    spec: {
      line: ["--"],
      block: [["--[[", "]]"]],
      quotes: ['"', "'"],
      keywords: "and break do else elseif end for function goto if in local not or repeat return then until while",
      literals: "true false nil self",
    },
  },
  {
    id: "bash",
    name: "Bash",
    family: "c",
    aliases: ["sh", "bash", "shell", "zsh", "console", "shellsession", "terminal", "fish"],
    spec: {
      line: ["#"],
      quotes: ['"', "'"],
      keywords:
        "if then else elif fi case esac for select while until do done in function time return exit break continue local export readonly declare unset shift source alias",
      literals: "true false",
      dollar: true,
      flags: true,
      commands: true,
      hashWord: true,
    },
  },
  {
    id: "powershell",
    name: "PowerShell",
    family: "c",
    aliases: ["ps1", "ps", "powershell", "pwsh", "psm1"],
    spec: {
      line: ["#"],
      block: [["<#", "#>"]],
      quotes: ['"', "'"],
      keywords:
        "begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow",
      caseless: true,
      dollar: true,
      flags: true,
      dashed: true,
      capTypes: false,
    },
  },
  {
    id: "batch",
    name: "Batch",
    family: "c",
    aliases: ["bat", "cmd", "batch"],
    spec: {
      line: ["::", "rem ", "REM "],
      quotes: ['"'],
      keywords: "if else for in do goto call exit set setlocal endlocal echo pause shift not exist defined errorlevel start cd",
      caseless: true,
      flags: true,
    },
  },
  {
    id: "sql",
    name: "SQL",
    family: "c",
    aliases: ["sql", "psql", "mysql", "sqlite", "postgres", "postgresql", "plsql", "tsql"],
    spec: {
      line: ["--"],
      block: [["/*", "*/"]],
      quotes: ["'", '"', "`"],
      keywords:
        "select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join inner left right outer full cross on as group by order having limit offset distinct union all exists in is like ilike between case when then else end begin commit rollback transaction default unique check constraint database schema if returns return function procedure trigger declare with recursive asc desc grant revoke truncate replace explain analyze returning conflict do nothing using cascade",
      literals: "null true false",
      types:
        "int integer bigint smallint tinyint serial bigserial decimal numeric float real double precision varchar char text boolean bool date time timestamp timestamptz interval uuid json jsonb blob bytea",
      caseless: true,
    },
  },
  {
    id: "dockerfile",
    name: "Dockerfile",
    family: "c",
    aliases: ["dockerfile", "docker", "containerfile"],
    spec: {
      line: ["#"],
      quotes: ['"', "'"],
      keywords: "from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as",
      caseless: true,
      dollar: true,
      flags: true,
      hashWord: true,
    },
  },
  { id: "json", name: "JSON", family: "json", aliases: ["json", "jsonc", "json5", "geojson", "webmanifest"] },
  { id: "yaml", name: "YAML", family: "yaml", aliases: ["yml", "yaml"] },
  { id: "toml", name: "TOML", family: "ini", aliases: ["toml"] },
  { id: "ini", name: "INI", family: "ini", aliases: ["ini", "cfg", "conf", "env", "dotenv", "properties", "editorconfig", "gitconfig"] },
  { id: "html", name: "HTML", family: "markup", aliases: ["html", "htm", "xhtml", "vue", "svelte"] },
  { id: "xml", name: "XML", family: "markup", aliases: ["xml", "svg", "xaml", "csproj", "plist", "xsd", "rss"] },
  { id: "css", name: "CSS", family: "css", aliases: ["css"] },
  { id: "scss", name: "SCSS", family: "css", aliases: ["scss", "sass", "less"] },
  { id: "diff", name: "Diff", family: "diff", aliases: ["diff", "patch"] },
  { id: "markdown", name: "Markdown", family: "md", aliases: ["md", "markdown", "mdx"] },
];

/** Fence words that mean plain text on purpose. */
const PLAIN = new Set(["txt", "text", "plain", "plaintext", "log", "output", "none", "nohighlight"]);

const byAlias = new Map<string, Lang>();
for (const lang of LANGS) for (const a of lang.aliases) byAlias.set(a, lang);
const byId = new Map(LANGS.map((l) => [l.id, l]));

const compiled = new Map<string, Compiled>();

function compile(lang: Lang): Compiled {
  const have = compiled.get(lang.id);
  if (have) return have;
  const spec = lang.spec ?? {};
  const set = (s?: string) => new Set((s ?? "").split(/\s+/).filter(Boolean).map((w) => (spec.caseless ? w.toLowerCase() : w)));
  const c: Compiled = { ...spec, kw: set(spec.keywords), lit: set(spec.literals), ty: set(spec.types) };
  compiled.set(lang.id, c);
  return c;
}

/* --------------------------------------------------------- the C family */

const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[a-zA-Z]*/y;
const IDENT = /[A-Za-z_À-￿][\wÀ-￿]*/y;
const IDENT_DOLLAR = /[A-Za-z_$À-￿][\w$À-￿]*/y;
const IDENT_DASHED = /[A-Za-z_][\w]*(?:-[A-Za-z_]\w*)*/y;
const DECORATOR = /@[A-Za-z_][\w.]*/y;
const VAR = /\$(?:\{[^}\n]*\}|[A-Za-z_][\w]*(?::[A-Za-z_]\w*)?|[0-9@#?*!$_-])/y;
const FLAG = /--?[A-Za-z][\w-]*/y;
const CHAR = /'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|.)|[^\\'\n])'/y;

function sticky(re: RegExp, code: string, at: number): string {
  re.lastIndex = at;
  const m = re.exec(code);
  return m ? m[0] : "";
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n" || c === undefined;
}

/** Where a string that starts at `from` (after the opening quote) ends. */
function stringEnd(code: string, from: number, quote: string, escapes = true): number {
  const multi = quote.length === 3 || quote === "`";
  let i = from;
  while (i < code.length) {
    const c = code[i];
    if (escapes && c === "\\") {
      i += 2;
      continue;
    }
    if (code.startsWith(quote, i)) return i + quote.length;
    if (c === "\n" && !multi) return i;
    i += 1;
  }
  return code.length;
}

function scanC(code: string, s: Compiled, out: Out): void {
  const n = code.length;
  const ident = s.dashed ? IDENT_DASHED : s.dollarIdent ? IDENT_DOLLAR : IDENT;
  let i = 0;
  // nothing but spaces so far on this line
  let lineStart = true;
  // the next word starts a command (shell)
  let cmd = true;

  let last = -1;
  while (i < n) {
    last = step(i, last);
    const c = code[i];
    if (c === "\n") {
      out.add(null, c);
      i += 1;
      lineStart = true;
      cmd = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      out.add(null, c);
      i += 1;
      continue;
    }
    const prev = code[i - 1];
    const take = (kind: Kind | null, end: number) => {
      out.add(kind, code.slice(i, end));
      i = end;
      lineStart = false;
    };

    // comments
    const block = s.block?.find(([open]) => code.startsWith(open, i));
    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      take("com", end === -1 ? n : end + block[1].length);
      continue;
    }
    const lineOpen = s.line?.find((open) =>
      s.caseless ? code.slice(i, i + open.length).toLowerCase() === open.toLowerCase() : code.startsWith(open, i),
    );
    if (lineOpen && (!s.hashWord || lineOpen !== "#" || isSpace(prev)) && (lineOpen.trim() === lineOpen || lineStart || isSpace(prev))) {
      const end = code.indexOf("\n", i);
      take("com", end === -1 ? n : end);
      continue;
    }
    if (s.preproc && lineStart && c === "#") {
      const end = code.indexOf("\n", i);
      take("meta", end === -1 ? n : end);
      continue;
    }
    if (s.attrs && c === "#" && (code[i + 1] === "[" || code.startsWith("![", i + 1))) {
      let depth = 0;
      let j = i;
      for (; j < n && code[j] !== "\n"; j += 1) {
        if (code[j] === "[") depth += 1;
        else if (code[j] === "]" && --depth === 0) break;
      }
      take("meta", Math.min(n, j + 1));
      continue;
    }

    // strings, with what may be glued in front of them
    const pre = s.prefix ? sticky(s.prefix, code, i) : "";
    const at = i + pre.length;
    const quote = s.quotes?.find((q) => code.startsWith(q, at));
    if (quote && !(s.charQuote && quote === "'")) {
      take("str", stringEnd(code, at + quote.length, quote, !(quote === "'" && s.dollar)));
      cmd = false;
      continue;
    }
    if (s.charQuote && c === "'") {
      const ch = sticky(CHAR, code, i);
      if (ch) {
        take("str", i + ch.length);
        continue;
      }
      // a lifetime: 'a
      const life = sticky(IDENT, code, i + 1);
      take("type", i + 1 + life.length);
      continue;
    }

    // numbers
    if ((c >= "0" && c <= "9") || (c === "." && code[i + 1] >= "0" && code[i + 1] <= "9")) {
      const num = sticky(NUM, code, i);
      if (num) {
        take("num", i + num.length);
        cmd = false;
        continue;
      }
    }

    if (s.decorators && c === "@") {
      const d = sticky(DECORATOR, code, i);
      if (d) {
        take("meta", i + d.length);
        continue;
      }
    }
    if (s.dollar && c === "$") {
      const v = sticky(VAR, code, i);
      if (v) {
        const name = v.slice(1).toLowerCase();
        take(s.caseless && (name === "true" || name === "false" || name === "null") ? "lit" : "var", i + v.length);
        cmd = false;
        continue;
      }
    }
    if (s.flags && c === "-" && (isSpace(prev) || prev === "(")) {
      const f = sticky(FLAG, code, i);
      if (f) {
        take("attr", i + f.length);
        continue;
      }
    }

    // words
    const word = sticky(ident, code, i);
    if (word) {
      let end = i + word.length;
      const key = s.caseless ? word.toLowerCase() : word;
      let p = end;
      while (code[p] === " " || code[p] === "\t") p += 1;
      const next = code[p];
      let before = i - 1;
      while (code[before] === " " || code[before] === "\t") before -= 1;
      const member = code[before] === ".";
      let kind: Kind | null = null;
      if (!member && s.kw.has(key)) kind = CONTROL.has(key.toLowerCase()) ? "kw" : "store";
      else if (s.lit.has(key)) kind = "lit";
      else if (s.ty.has(key)) kind = "type";
      else if (s.commands && code[end] === "=") kind = "var";
      else if (s.macros && code[end] === "!" && code[end + 1] !== "=") {
        end += 1;
        kind = "fn";
      } else if (next === "(") kind = "fn";
      else if (s.commands && cmd) kind = "fn";
      else if (s.dashed && word.includes("-")) kind = "fn";
      else if (s.capTypes && /^[A-Z][a-z0-9]\w*$/.test(word)) kind = "type";
      else if (member && !s.commands) kind = "prop";
      take(kind, end);
      // "sudo apt install": the command is the next word
      if (cmd) cmd = s.commands === true && (key === "sudo" || key === "time" || key === "exec" || key === "xargs" || key === "env" || s.kw.has(key));
      continue;
    }

    // anything else, one sign at a time
    take(null, i + 1);
    if (c === "|" || c === "&" || c === ";" || c === "(" || c === "`" || c === "{") cmd = true;
    else cmd = false;
  }
}

/* ---------------------------------------------------------- HTML and XML */

const TAG_OPEN = /<\/?([A-Za-z][\w:.-]*)/y;
const ATTR_NAME = /[^\s=>/"']+/y;
const ENTITY = /&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]\w*);/y;

function scanMarkup(code: string, out: Out): void {
  const n = code.length;
  const lower = code.toLowerCase();
  let i = 0;
  let last = -1;
  while (i < n) {
    last = step(i, last);
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const to = end === -1 ? n : end + 3;
      out.add("com", code.slice(i, to));
      i = to;
      continue;
    }
    if (code.startsWith("<![CDATA[", i)) {
      const end = code.indexOf("]]>", i);
      const to = end === -1 ? n : end + 3;
      out.add("str", code.slice(i, to));
      i = to;
      continue;
    }
    if (code.startsWith("<!", i) || code.startsWith("<?", i)) {
      const end = code.indexOf(">", i);
      const to = end === -1 ? n : end + 1;
      out.add("meta", code.slice(i, to));
      i = to;
      continue;
    }
    const open = code[i] === "<" ? sticky(TAG_OPEN, code, i) : "";
    if (open) {
      const closing = open.startsWith("</");
      out.add("punc", closing ? "</" : "<");
      const name = open.slice(closing ? 2 : 1);
      out.add("tag", name);
      i += open.length;
      let selfClosed = false;
      let afterEq = false;
      let lastAttr = -1;
      while (i < n) {
        lastAttr = step(i, lastAttr);
        const c = code[i];
        if (c === ">") {
          out.add("punc", ">");
          i += 1;
          break;
        }
        if (code.startsWith("/>", i)) {
          out.add("punc", "/>");
          i += 2;
          selfClosed = true;
          break;
        }
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          out.add(null, c);
          i += 1;
          continue;
        }
        if (c === '"' || c === "'") {
          const end = code.indexOf(c, i + 1);
          const to = end === -1 ? n : end + 1;
          out.add("str", code.slice(i, to));
          i = to;
          afterEq = false;
          continue;
        }
        if (c === "=") {
          out.add(null, c);
          i += 1;
          afterEq = true;
          continue;
        }
        const word = sticky(ATTR_NAME, code, i);
        if (!word) {
          out.add(null, c);
          i += 1;
          continue;
        }
        out.add(afterEq ? "str" : "attr", word);
        i += word.length;
        afterEq = false;
      }
      // a script or a style inside the page is colored as what it is
      const tag = name.toLowerCase();
      if (!closing && !selfClosed && (tag === "script" || tag === "style")) {
        const end = lower.indexOf(`</${tag}`, i);
        const to = end === -1 ? n : end;
        const inner = code.slice(i, to);
        if (tag === "script") scanC(inner, compile(byId.get("javascript") as Lang), out);
        else scanCss(inner, out, false);
        i = to;
      }
      continue;
    }
    if (code[i] === "&") {
      const e = sticky(ENTITY, code, i);
      if (e) {
        out.add("esc", e);
        i += e.length;
        continue;
      }
    }
    // text up to the next tag or entity
    let j = i + 1;
    while (j < n && code[j] !== "<" && code[j] !== "&") j += 1;
    out.add(null, code.slice(i, j));
    i = j;
  }
}

/* ------------------------------------------------------------------ CSS */

const CSS_WORD = /-?[A-Za-z_][\w-]*/y;
const CSS_NUM = /-?(?:\d+\.?\d*|\.\d+)(?:%|[A-Za-z]+)?/y;
const HEX = /#[\da-fA-F]{3,8}\b/y;
const AT_RULES = new Set(
  "media import keyframes font-face supports include mixin extend use forward each if else for return function charset page layer container namespace while debug warn error".split(
    " ",
  ),
);

function scanCss(code: string, out: Out, scss: boolean): void {
  const n = code.length;
  let i = 0;
  let depth = 0;
  // where the scanner is: a selector, the start of a declaration (a property or a nested selector), a value
  let mode: "sel" | "decl" | "val" = "sel";
  // inside parentheses of a selector or an at-rule: (max-width: 600px), :nth-child(2n)
  let paren = 0;
  let last = -1;
  while (i < n) {
    last = step(i, last);
    const c = code[i];
    const take = (kind: Kind | null, end: number) => {
      out.add(kind, code.slice(i, end));
      i = end;
    };
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      take(null, i + 1);
      continue;
    }
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      take("com", end === -1 ? n : end + 2);
      continue;
    }
    if (scss && code.startsWith("//", i)) {
      const end = code.indexOf("\n", i);
      take("com", end === -1 ? n : end);
      continue;
    }
    if (c === '"' || c === "'") {
      take("str", stringEnd(code, i + 1, c));
      continue;
    }
    if (c === "{") {
      depth += 1;
      mode = "decl";
      take(null, i + 1);
      continue;
    }
    if (c === "}") {
      depth = Math.max(0, depth - 1);
      mode = depth > 0 ? "decl" : "sel";
      take(null, i + 1);
      continue;
    }
    if (c === ";") {
      mode = depth > 0 ? "decl" : "sel";
      take(null, i + 1);
      continue;
    }
    if (c === "@") {
      const w = sticky(CSS_WORD, code, i + 1);
      take(AT_RULES.has(w.toLowerCase()) ? "store" : "var", i + 1 + w.length);
      if (mode === "decl") mode = "sel";
      continue;
    }
    if (c === "$" && scss) {
      const w = sticky(CSS_WORD, code, i + 1);
      take("var", i + 1 + w.length);
      continue;
    }
    // a declaration starts: a property, or a selector nested in the block
    if (mode === "decl") {
      let j = i;
      while (j < n && code[j] !== ";" && code[j] !== "{" && code[j] !== "}") j += 1;
      mode = code[j] === "{" ? "sel" : "decl";
      if (mode === "decl") {
        const w = code.startsWith("--", i) ? sticky(/--[\w-]+/y, code, i) : sticky(CSS_WORD, code, i);
        if (w) {
          take(w.startsWith("--") ? "var" : "prop", i + w.length);
          mode = "val";
          continue;
        }
        mode = "val";
      }
    }
    if (mode === "val") {
      if (c === "!") {
        const w = sticky(/![A-Za-z]+/y, code, i);
        take("kw", i + Math.max(1, w.length));
        continue;
      }
      if (c === "#") {
        const h = sticky(HEX, code, i);
        if (h) {
          take("num", i + h.length);
          continue;
        }
      }
      if ((c >= "0" && c <= "9") || ((c === "-" || c === ".") && /[\d.]/.test(code[i + 1] ?? ""))) {
        const num = sticky(CSS_NUM, code, i);
        if (num) {
          take("num", i + num.length);
          continue;
        }
      }
      if (code.startsWith("--", i)) {
        // "--" alone is no custom property: taken as a sign, so the scan moves on
        const w = sticky(/--[\w-]+/y, code, i);
        if (w) {
          take("var", i + w.length);
          continue;
        }
      }
      const w = sticky(CSS_WORD, code, i);
      if (w) {
        take(code[i + w.length] === "(" ? "fn" : "str", i + w.length);
        continue;
      }
      take(null, i + 1);
      continue;
    }
    if (c === "(") paren += 1;
    else if (c === ")") paren = Math.max(0, paren - 1);
    // a media feature: a property with a value, as in a declaration
    if (paren > 0 && c !== "(" && c !== ")") {
      if ((c >= "0" && c <= "9") || (c === "." && /\d/.test(code[i + 1] ?? ""))) {
        const num = sticky(CSS_NUM, code, i);
        take("num", i + Math.max(1, num.length));
        continue;
      }
      const w = sticky(CSS_WORD, code, i);
      if (w) {
        let p = i + w.length;
        while (code[p] === " ") p += 1;
        take(code[p] === ":" ? "prop" : "str", i + w.length);
        continue;
      }
      take(null, i + 1);
      continue;
    }
    // selectors: classes, ids and pseudo-classes in one color, element names in another
    if (c === "." || c === "#" || c === ":") {
      const lead = c === ":" && code[i + 1] === ":" ? 2 : 1;
      const w = sticky(CSS_WORD, code, i + lead);
      take("meta", i + lead + w.length);
      continue;
    }
    if (c === "&") {
      take("kw", i + 1);
      continue;
    }
    const w = sticky(CSS_WORD, code, i);
    if (w) {
      take(code[i + w.length] === "(" ? "fn" : "tag", i + w.length);
      continue;
    }
    take(null, i + 1);
  }
}

/* ---------------------------------------------------------------- JSON */

function scanJson(code: string, out: Out): void {
  const n = code.length;
  let i = 0;
  let last = -1;
  while (i < n) {
    last = step(i, last);
    const c = code[i];
    if (c === '"') {
      const end = stringEnd(code, i + 1, '"');
      let p = end;
      while (isSpace(code[p]) && p < n) p += 1;
      out.add(code[p] === ":" ? "prop" : "str", code.slice(i, end));
      i = end;
      continue;
    }
    if (code.startsWith("//", i)) {
      const end = code.indexOf("\n", i);
      const to = end === -1 ? n : end;
      out.add("com", code.slice(i, to));
      i = to;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const to = end === -1 ? n : end + 2;
      out.add("com", code.slice(i, to));
      i = to;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const num = sticky(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, code, i);
      if (num) {
        out.add("num", num);
        i += num.length;
        continue;
      }
    }
    const word = sticky(/[A-Za-z_]\w*/y, code, i);
    if (word) {
      out.add(word === "true" || word === "false" || word === "null" ? "lit" : null, word);
      i += word.length;
      continue;
    }
    out.add(null, c);
    i += 1;
  }
}

/* ------------------------------------------- YAML, TOML and INI, by lines */

const YAML_KEY = /^(\s*)((?:-\s+)*)((?:"[^"\n]*"|'[^'\n]*'|[^\s#:\-"'][^\n:#]*?|-[^\s][^\n:#]*?))(\s*:)(?=\s|$)/;
const YAML_ITEM = /^(\s*)((?:-\s+)+)/;
const YAML_LIT = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);

/** A value after "key:" or "key =": strings, numbers, literals, a comment at the end. */
function scanValue(text: string, out: Out, plainIsString: boolean, lits: Set<string>, semicolon = false): void {
  let i = 0;
  const n = text.length;
  let last = -1;
  while (i < n) {
    last = step(i, last);
    const c = text[i];
    if ((c === "#" || (semicolon && c === ";")) && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      out.add("com", text.slice(i));
      return;
    }
    if (c === " " || c === "\t" || c === "," || c === "[" || c === "]" || c === "{" || c === "}") {
      out.add(null, c);
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = stringEnd(text, i + q.length, q, c === '"');
      out.add("str", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === "&" || c === "*") {
      const w = sticky(/[&*][\w-]+/y, text, i);
      if (w.length > 1) {
        out.add("var", w);
        i += w.length;
        continue;
      }
    }
    if (c === "!") {
      const w = sticky(/!!?[\w-]*/y, text, i);
      out.add("meta", w);
      i += w.length;
      continue;
    }
    if ((c === "|" || c === ">") && /^[|>][-+]?\s*$/.test(text.slice(i).replace(/\s+#.*$/, ""))) {
      out.add("kw", text.slice(i).replace(/\s+#.*$/, ""));
      i += text.slice(i).replace(/\s+#.*$/, "").length;
      continue;
    }
    // one plain word up to a space or a comma
    let j = i;
    while (j < n && !(text[j] === " " && (text[j + 1] === "#" || (semicolon && text[j + 1] === ";"))) && text[j] !== "," && text[j] !== "]" && text[j] !== "}") j += 1;
    const word = text.slice(i, j);
    const bare = word.trim();
    const kind: Kind | null = lits.has(bare.toLowerCase())
      ? "lit"
      : /^[-+]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/.test(bare) || /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(bare)
        ? "num"
        : plainIsString
          ? "str"
          : null;
    out.add(kind, word);
    i = j;
  }
}

function scanYaml(code: string, out: Out): void {
  for (const line of code.split(/(?<=\n)/)) {
    const body = line.replace(/\n$/, "");
    const nl = line.endsWith("\n") ? "\n" : "";
    if (/^\s*#/.test(body)) out.add("com", body);
    else if (/^(---|\.\.\.)(\s|$)/.test(body)) out.add("meta", body);
    else {
      const m = YAML_KEY.exec(body);
      if (m) {
        out.add(null, m[1]);
        out.add("punc", m[2]);
        out.add("prop", m[3]);
        out.add(null, m[4]);
        scanValue(body.slice(m[0].length), out, true, YAML_LIT);
      } else {
        const item = YAML_ITEM.exec(body);
        if (item) {
          out.add(null, item[1]);
          out.add("punc", item[2]);
          scanValue(body.slice(item[0].length), out, true, YAML_LIT);
        } else scanValue(body, out, true, YAML_LIT);
      }
    }
    out.add(null, nl);
  }
}

const INI_LIT = new Set(["true", "false", "yes", "no", "on", "off", "null", "none"]);

function scanIni(code: string, out: Out): void {
  for (const line of code.split(/(?<=\n)/)) {
    const body = line.replace(/\n$/, "");
    const nl = line.endsWith("\n") ? "\n" : "";
    const key = /^(\s*)([\w.\-"' $]+?)(\s*[=:])/.exec(body);
    if (/^\s*[#;]/.test(body)) out.add("com", body);
    else if (/^\s*\[\[?[^\]]*\]\]?\s*(#.*)?$/.test(body)) out.add("head", body);
    else if (key) {
      out.add(null, key[1]);
      out.add("prop", key[2]);
      out.add(null, key[3]);
      scanValue(body.slice(key[0].length), out, false, INI_LIT, true);
    } else scanValue(body, out, false, INI_LIT, true);
    out.add(null, nl);
  }
}

/* --------------------------------------------------- diff and Markdown */

function scanDiff(code: string, out: Out): void {
  for (const line of code.split(/(?<=\n)/)) {
    const kind: Kind | null = /^(\+\+\+|---|diff |index |similarity |rename |new file|deleted file)/.test(line)
      ? "meta"
      : line.startsWith("@@")
        ? "head"
        : line.startsWith("+")
          ? "ins"
          : line.startsWith("-")
            ? "del"
            : null;
    out.add(kind, line);
  }
}

const MD_INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\[[^\]\n]*\])(\([^)\n]*\))/g;

function scanMarkdown(code: string, out: Out): void {
  for (const line of code.split(/(?<=\n)/)) {
    if (/^#{1,6}\s/.test(line)) {
      out.add("head", line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      out.add("com", line);
      continue;
    }
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      out.add("meta", line);
      continue;
    }
    let rest = line;
    const marker = /^(\s*)([-*+]|\d+[.)])(\s+(\[[ xX]\]\s+)?)/.exec(rest);
    if (marker) {
      out.add(null, marker[1]);
      out.add("kw", marker[2] + marker[3]);
      rest = rest.slice(marker[0].length);
    }
    let last = 0;
    for (const m of rest.matchAll(MD_INLINE)) {
      out.add(null, rest.slice(last, m.index));
      if (m[1]) out.add("str", m[1]);
      else if (m[2]) out.add("store", m[2]);
      else {
        out.add("attr", m[3]);
        out.add("str", m[4]);
      }
      last = (m.index ?? 0) + m[0].length;
    }
    out.add(null, rest.slice(last));
  }
}

/* ------------------------------------------------------ guessing the language */

/** Signs of a language: [language, pattern, weight, how many matches count at most]. */
const SIGNS: [string, RegExp, number, number?][] = [
  ["xml", /^\s*<\?xml\b/, 8],
  ["html", /<!DOCTYPE html|<\/?(html|head|body|div|span|p|a|ul|ol|li|script|style|table|tr|td|img|br|input|button|form|section|template|main|nav|header|footer|h[1-6])\b[^>]*>/i, 4],
  ["xml", /<\/[\w:.-]+>/, 1],
  ["diff", /^@@ [-+]\d+(,\d+)? [-+]\d+(,\d+)? @@/m, 8],
  ["diff", /^(\+\+\+|---) [ab]?\/?\S/m, 3],
  ["diff", /^diff --git /m, 8],

  ["python", /^\s*def \w+\(.*\)\s*(->\s*[^:\n]+)?:\s*$/m, 5],
  ["python", /^\s*(from [\w.]+ )?import [\w., ]+\s*$/m, 2],
  ["python", /^\s*(elif|except|finally|with)\b.*:\s*$/m, 3],
  ["python", /\bself\.\w+/, 2],
  ["python", /\b(None|True|False)\b/, 1],
  ["python", /^\s*class \w+(\(.*\))?:\s*$/m, 4],
  ["python", /\bf"[^"\n]*\{/, 2],
  ["python", /^\s*(if|while) .+:\s*$/m, 2],
  ["python", /^\s*for \w+(,\s*\w+)* in .+:\s*$/m, 4],
  ["python", /__name__|__init__|__main__/, 4],
  ["python", /^\s*print\(/m, 1],

  ["javascript", /\b(const|let|var)\s+[\w${}[\], ]+\s*=/, 2, 3],
  ["javascript", /=>/, 1, 2],
  ["javascript", /\bfunction\s*\*?\s*[\w$]*\s*\(/, 2],
  ["javascript", /\bconsole\.\w+\(/, 4],
  ["javascript", /\b(import|export)\b[^\n]*\bfrom\s+['"]/, 3],
  ["javascript", /\brequire\(['"]/, 3],
  ["javascript", /\b(document|window)\.\w+/, 2],
  ["javascript", /===|!==/, 2],
  ["javascript", /\bmodule\.exports\b/, 4],
  ["typescript", /:\s*(string|number|boolean|any|void|unknown|never)(\[\])?\b/, 3, 2],
  ["typescript", /\binterface\s+\w+\s*(<[^>]*>)?\s*(extends\s[^{]+)?\{/, 4],
  ["typescript", /^\s*(export\s+)?type\s+\w+(<[^>]*>)?\s*=/m, 3],
  ["typescript", /\bas\s+const\b/, 3],
  ["typescript", /\b(private|public|protected|readonly)\s+\w+\s*[:?]/, 2],

  ["csharp", /^\s*using\s+System(\.[\w.]+)?;/m, 6],
  ["csharp", /^\s*namespace\s+[\w.]+\s*[;{]?\s*$/m, 3],
  ["csharp", /\bConsole\.Write(Line)?\(/, 6],
  ["csharp", /\{\s*get;\s*(set;|init;)?\s*\}/, 5],
  ["csharp", /\b(public|private|protected|internal)\s+(static\s+)?(async\s+)?(void|Task(<[^>]+>)?|string|int|bool)\s+\w+\s*\(/, 2],
  ["csharp", /\bvar\s+\w+\s*=\s*new\b/, 2],
  ["csharp", /\bawait\s+\w+Async\(/, 3],

  ["java", /\bpublic\s+static\s+void\s+main\s*\(/, 6],
  ["java", /\bSystem\.out\.print/, 6],
  ["java", /^\s*import\s+(java|javax|android|org|com)\.[\w.*]+;/m, 5],
  ["java", /^\s*package\s+[\w.]+;/m, 5],
  ["java", /@Override\b/, 3],
  ["java", /\bString\[\]\s+\w+/, 2],

  ["kotlin", /\bfun\s+(<[^>]+>\s*)?[\w.]+\s*\(/, 4],
  ["kotlin", /\bval\s+\w+(\s*:\s*[\w<>?]+)?\s*=/, 2],
  ["kotlin", /\bdata class\b/, 5],
  ["kotlin", /\bwhen\s*(\(.*\))?\s*\{/, 2],

  ["go", /^\s*package\s+\w+\s*$/m, 4],
  ["go", /\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\(/, 4],
  ["go", /:=/, 2],
  ["go", /\bfmt\.\w+\(/, 5],
  ["go", /^\s*import\s*\(/m, 3],
  ["go", /\berr\s*!=\s*nil\b/, 5],

  ["rust", /\bfn\s+\w+\s*(<[^>]*>)?\(/, 3],
  ["rust", /\blet\s+mut\b/, 5],
  ["rust", /\b(println|vec|format|panic|eprintln|assert_eq|write|writeln)!\(/, 5],
  ["rust", /\bimpl\b(<[^>]*>)?\s+[\w:]+/, 3],
  ["rust", /^\s*use\s+(std|crate|super|self)::/m, 5],
  ["rust", /&mut\b|&self\b/, 3],
  ["rust", /#\[derive\(/, 6],
  ["rust", /\bpub\s+(fn|struct|enum|mod|trait)\b/, 3],

  ["c", /^\s*#include\s*[<"]/m, 5],
  ["c", /\bprintf\(/, 2],
  ["c", /\bint\s+main\s*\(/, 4],
  ["c", /\b(unsigned|size_t|uint\d+_t|malloc|sizeof)\b/, 2],
  ["c", /->\w+/, 1],
  ["cpp", /\bstd::\w+/, 6],
  ["cpp", /\bcout\s*<<|\bcin\s*>>/, 6],
  ["cpp", /\btemplate\s*</, 4],
  ["cpp", /\bnullptr\b/, 4],
  ["cpp", /\bclass\s+\w+\s*(:\s*(public|private)\s+\w+)?\s*\{/, 2],

  ["php", /<\?php/, 10],
  ["php", /\$\w+\s*=/, 1],
  ["php", /\becho\s/, 1],
  ["php", /\bfunction\s+\w+\s*\(\s*\$/, 5],

  ["ruby", /^\s*def\s+[\w.]+[?!]?(\(.*\))?\s*$/m, 4],
  ["ruby", /^\s*end\s*$/m, 2],
  ["ruby", /\bputs\s/, 3],
  ["ruby", /\brequire(_relative)?\s+['"]/, 3],
  ["ruby", /\bdo\s*\|\w+(,\s*\w+)*\|/, 5],
  ["ruby", /\battr_(reader|accessor|writer)\b/, 5],

  ["lua", /\blocal\s+\w+\s*=/, 3],
  ["lua", /\bthen\b/, 1],
  ["lua", /\belseif\b/, 3],
  ["lua", /~=/, 3],
  ["lua", /^\s*end\s*$/m, 1],
  ["lua", /\bfunction\s+[\w.:]+\s*\(.*\)\s*$/m, 2],
  ["lua", /\.\.\s*["\w]/, 1],

  ["bash", /^#!\/(usr\/)?bin\/(env\s+)?(ba|z|da)?sh\b/, 10],
  [
    "bash",
    /^\s*(\$\s+)?(sudo|apt(-get)?|cd|ls|echo|export|chmod|chown|mkdir|rm|cp|mv|curl|wget|git|docker|npm|npx|pnpm|yarn|pip3?|ssh|scp|systemctl|journalctl|cat|grep|tar|source|make|cargo|kubectl|brew|nano|vim|python3?|node)\b/m,
    3,
    2,
  ],
  ["bash", /\$\{?\w+\}?/, 1],
  ["bash", /\|\s*(grep|awk|sed|head|tail|xargs|sort|uniq|wc|tee|jq)\b/, 3],
  ["bash", /^\s*(fi|done|esac)\s*$/m, 5],
  ["bash", /\bthen\s*$/m, 2],
  ["bash", /&&\s*\w/, 1],
  ["bash", /(^|\s)--?[a-z][\w-]*/m, 1],

  ["powershell", /\b(Get|Set|New|Remove|Start|Stop|Write|Read|Invoke|Test|Out|Select|Where|ForEach|Import|Export|Add|Copy|Move)-[A-Z]\w+/, 6],
  ["powershell", /\$_\b|\$PSItem|\$env:\w+/i, 4],
  ["powershell", /\s-(eq|ne|lt|gt|le|ge|like|notlike|match|and|or|not|contains)\s/i, 3],
  ["powershell", /\bparam\s*\(/i, 2],

  ["batch", /^\s*@echo\s+off\b/im, 8],
  ["batch", /%\w+%/, 2],
  ["batch", /^\s*(rem|::)\s/im, 3],

  ["sql", /\bselect\b[\s\S]+?\bfrom\b/i, 5],
  ["sql", /\binsert\s+into\b/i, 6],
  ["sql", /\bcreate\s+(table|index|view|database|schema|function)\b/i, 6],
  ["sql", /\b(update\s+\w+\s+set|delete\s+from|alter\s+table|drop\s+table)\b/i, 5],
  ["sql", /\b(inner|left|right|full)?\s*join\b[\s\S]+?\bon\b/i, 2],
  ["sql", /\b(group|order)\s+by\b/i, 2],

  ["css", /^[ \t]*[.#]?[\w-][\w.#:>+~, \t-]*\{[ \t]*$/m, 1],
  [
    "css",
    /^\s*-{0,2}[a-z][\w-]*\s*:\s*[^;{}\n]*(\d(px|em|rem|%|vh|vw|s|ms|fr|deg)\b|#[\da-fA-F]{3,8}\b|\b(none|auto|block|flex|grid|inherit|solid|bold|center|absolute|relative|hidden|pointer|transparent)\b)[^;{}\n]*;\s*$/m,
    3,
    2,
  ],
  ["css", /@(media|import|keyframes|font-face|supports)\b/, 3],
  ["css", /:\s*(#[0-9a-fA-F]{3,8}|\d+(px|em|rem|%|vh|vw|ms|s)\b)/, 3],
  ["scss", /^\s*\$[\w-]+\s*:/m, 4],
  ["scss", /@(mixin|include|extend|use)\b/, 5],
  ["scss", /&(:|\.|-|::)\w/, 3],

  ["dockerfile", /^\s*FROM\s+[\w./:-]+(\s+AS\s+\w+)?\s*$/im, 6],
  ["dockerfile", /^\s*(RUN|COPY|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|ADD)\s/m, 3, 2],


  ["markdown", /^#{1,6}\s+\S/m, 2, 2],
  ["markdown", /^\s*([-*+]|\d+\.)\s+\S/m, 1, 2],
  ["markdown", /\*\*[^*\n]+\*\*/, 1],
  ["markdown", /\[[^\]\n]+\]\([^)\n]+\)/, 2],
];

/** Only the start of a long line is looked at when guessing. */
const MAX_SIGN_LINE = 300;

/** YAML is a list of "key: value" lines with no braces or semicolons; counted apart. */
function yamlScore(code: string): number {
  const lines = code.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length || /[;{}]\s*$/m.test(code) || /\b(function|def|class|return)\b/.test(code)) return 0;
  const keys = lines.filter((l) => /^\s*(-\s+)?[\w.\-"']+:(\s|$)/.test(l)).length;
  const items = lines.filter((l) => /^\s*-\s+\S/.test(l)).length;
  if (keys < 1 || (keys + items) / lines.length < 0.6) return 0;
  return Math.min(8, keys * 2 + items + (/^---\s*$/m.test(code) ? 2 : 0));
}

/**
 * INI and TOML: [sections] and "key = value" lines and nothing else. Code
 * assigns with "=" too, so a line ending in a call or a semicolon rules it out.
 */
function iniScore(code: string): [string, number] {
  const lines = code.split("\n").filter((l) => l.trim() && !/^\s*[#;]/.test(l));
  if (!lines.length || /[();]\s*$/m.test(code)) return ["", 0];
  const sections = lines.filter((l) => /^\s*\[\[?[\w .:"-]+\]\]?\s*$/.test(l)).length;
  const pairs = lines.filter((l) => /^\s*[\w.-]+\s*=\s*\S/.test(l)).length;
  if ((sections + pairs) / lines.length < 0.8 || (!sections && pairs < 3)) return ["", 0];
  const toml = /^\s*\[\[/m.test(code) || /=\s*("[^"]*"|'[^']*'|\[|\{|true\b|false\b)/.test(code);
  return [toml ? "toml" : "ini", Math.min(8, 2 + sections * 2 + pairs)];
}

function looksLikeJson(code: string): boolean {
  const s = code.trim();
  if (!/^[{[]/.test(s) || !/[}\]]$/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    // JSON with comments or trailing commas still counts if it looks like it
    return /^\{\s*"[^"\n]+"\s*:/.test(s) || /^\[\s*(\{|"|\d|true|false|null)/.test(s);
  }
}

/** The language of a piece of code, "" if it looks like none. */
export function detectLanguage(code: string): string {
  const head = code.length > 6000 ? code.slice(0, 6000) : code;
  const sample = head
    .split("\n")
    .map((line) => (line.length > MAX_SIGN_LINE ? line.slice(0, MAX_SIGN_LINE) : line))
    .join("\n");
  if (!sample.trim()) return "";
  if (looksLikeJson(sample)) return "json";
  const score = new Map<string, number>();
  const add = (lang: string, w: number) => score.set(lang, (score.get(lang) ?? 0) + w);
  for (const [lang, re, weight, cap = 1] of SIGNS) {
    if (cap > 1) {
      const all = sample.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
      if (all) add(lang, weight * Math.min(cap, all.length));
    } else if (re.test(sample)) add(lang, weight);
  }
  add("yaml", yamlScore(sample));
  const [ini, iniPoints] = iniScore(sample);
  if (ini) add(ini, iniPoints);
  // the dialects build on their base language
  const js = score.get("javascript") ?? 0;
  if (score.has("typescript")) add("typescript", js);
  if (score.has("cpp")) add("cpp", score.get("c") ?? 0);
  if (score.has("scss")) add("scss", score.get("css") ?? 0);
  if (score.has("html")) add("html", score.get("xml") ?? 0);
  let best = "";
  let top = 0;
  for (const [lang, s] of score) {
    if (s > top) {
      best = lang;
      top = s;
    }
  }
  return top >= 3 ? best : "";
}

/** The language a fence word means, null if unknown, "" for plain text on purpose. */
function fenceLang(word: string): Lang | "" | null {
  const w = word.trim().toLowerCase().replace(/^\{?\.?/, "").replace(/\}$/, "");
  if (!w) return null;
  if (PLAIN.has(w)) return "";
  return byAlias.get(w) ?? null;
}

/** Color a code block. `fence` is the word after ``` (may be empty). */
export function highlight(code: string, fence: string): Highlighted {
  const named = fenceLang(fence);
  const label = fence.trim();
  if (named === "" || code.length > MAX_CHARS || code.split("\n").some((l) => l.length > MAX_LINE)) {
    return { lang: "", label, tokens: [{ k: null, v: code }] };
  }
  // a known name, or a guess when there is none (an unknown name keeps its label, the code stays plain)
  const lang = named ?? (label ? undefined : byId.get(detectLanguage(code)));
  if (!lang) return { lang: "", label, tokens: [{ k: null, v: code }] };
  const out = new Out();
  deadline = Date.now() + BUDGET_MS;
  steps = 0;
  try {
    scan(code, lang, out);
  } catch (e) {
    if (!(e instanceof GiveUp)) throw e;
    return { lang: "", label: label || lang.name, tokens: [{ k: null, v: code }] };
  }
  return { lang: lang.id, label: lang.name, tokens: out.list };
}

function scan(code: string, lang: Lang, out: Out): void {
  switch (lang.family) {
    case "c":
      scanC(code, compile(lang), out);
      break;
    case "markup":
      scanMarkup(code, out);
      break;
    case "css":
      scanCss(code, out, lang.id === "scss");
      break;
    case "json":
      scanJson(code, out);
      break;
    case "yaml":
      scanYaml(code, out);
      break;
    case "ini":
      scanIni(code, out);
      break;
    case "diff":
      scanDiff(code, out);
      break;
    case "md":
      scanMarkdown(code, out);
      break;
  }
}
