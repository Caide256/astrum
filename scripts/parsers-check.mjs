// What reads messages from others must stay fast on any input: the markdown
// parser, the code colors and the language guess. 0.9.11 froze the window on a
// long line in a code block; this runs before every build so that cannot ship
// again. A few answers of the media server choice are checked too.
// Run: node scripts/parsers-check.mjs (Node 24 runs the TypeScript sources as they are)
import assert from "node:assert/strict";

import { detectLanguage, highlight } from "../src/highlight.ts";
import { parse, parseInline } from "../src/markdown.ts";
import { focusCandidates } from "../src/matrix/rtc.ts";

/** A call may take this long at most; the slow paths found so far took seconds. */
const LIMIT_MS = 250;

function fast(name, fn) {
  const t = performance.now();
  const out = fn();
  const ms = performance.now() - t;
  assert.ok(ms < LIMIT_MS, `${name}: ${ms.toFixed(0)} ms`);
  return out;
}

// messages built to be slow or to break the parser
const hostile = {
  backticks: "a" + "`".repeat(60_000),
  quotes: ">".repeat(20_000),
  spacedQuotes: "> ".repeat(10_000) + "x",
  stars: "*a".repeat(20_000),
  brackets: "[".repeat(30_000),
  pipes: "|a".repeat(20_000) + "\n|---|\n" + "|b".repeat(20_000),
  url: "rlvoice.duckdns.org".repeat(500),
};
for (const [name, text] of Object.entries(hostile)) {
  fast(`parse ${name}`, () => parse(text));
  fast(`parseInline ${name}`, () => parseInline(text.slice(0, 20_000)));
}

// markdown answers that the fixes above must keep
assert.deepEqual(parseInline("`x`"), [{ t: "code", v: "x" }]);
assert.deepEqual(parseInline("``a`b"), [{ t: "text", v: "``a`b" }]);
assert.equal(parse("> > hi")[0].t, "quote");
assert.equal(parse("> > hi")[0].c[0].t, "quote");

// code blocks: the line that froze 0.9.11, long lines, every scanner on junk
const fences = ["", "js", "ts", "py", "cs", "go", "rs", "cpp", "sh", "ps1", "sql", "json", "yaml", "toml", "ini", "html", "css", "scss", "diff", "md"];
const junk = ["rlvoice.duckdns.org".repeat(12), "a" + " ".repeat(20_000) + "b", "${".repeat(10_000), "--".repeat(10_000)];
for (let k = 0; k < 8; k += 1) {
  junk.push(Array.from({ length: 6000 }, () => " \t\n!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~aZ09"[Math.floor(Math.random() * 38)]).join(""));
}
for (const code of junk) {
  fast("detectLanguage", () => detectLanguage(code));
  for (const fence of fences) {
    const out = fast(`highlight ${fence || "(guess)"}`, () => highlight(code, fence));
    assert.equal(out.tokens.map((t) => t.v).join(""), code, `highlight ${fence} changed the text`);
  }
}
assert.equal(detectLanguage("def f(x):\n    return x\n\nfor i in range(3):\n    print(f(i))"), "python");
assert.equal(detectLanguage('{\n  "a": 1\n}'), "json");
assert.equal(detectLanguage("просто текст, не код"), "");

// the media server of a call: those in it decide, the oldest first; an expired one comes last
const now = Date.now();
const member = (url, created, expired) => ({
  type: "org.matrix.msc3401.call.member",
  stateKey: `k${created}`,
  sender: `@u${created}:x`,
  deviceId: "D",
  expired,
  eventId: `$${created}`,
  ts: created,
  content: { created_ts: created, foci_preferred: [{ type: "livekit", livekit_service_url: url }] },
});
const more = { own: "https://own/jwt", roomServer: "", worked: ["https://worked/jwt"], nearby: [] };
const order = (list) => focusCandidates(list, "!r:x", more).map((f) => f.serviceUrl);
assert.deepEqual(order([member("https://b/jwt", now - 1000, false), member("https://a/jwt", now - 5000, false)]), [
  "https://a/jwt",
  "https://b/jwt",
  "https://own/jwt",
  "https://worked/jwt",
]);
assert.deepEqual(order([member("https://old/jwt", now - 9e8, true)]), ["https://own/jwt", "https://worked/jwt", "https://old/jwt"]);

console.log("parsers check: ok");
