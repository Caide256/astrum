const electron = require("electron");
const dns = require("node:dns").promises;
const net = require("node:net");

/**
 * GET for link previews that reaches the public internet only.
 *
 * A link typed in a chat must not become a way into the user's own network:
 * a page that redirects to http://127.0.0.1:port or to the router at
 * 192.168.0.1 would otherwise get fetched by the app, and its title and
 * picture would land in the chat for everyone. Every hop is checked: the name
 * must resolve to public addresses only, redirects are followed by hand and
 * each target is checked the same way. The Chromium resolver is asked first,
 * so the check sees the addresses the request itself will use.
 *
 * 198.18.0.0/15 is allowed on purpose: proxy tools with "fake IP" DNS map
 * every name into it, and it is never a real local service.
 */

const MAX_REDIRECTS = 5;

function blockedV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    a >= 224
  );
}

function blockedIp(ip) {
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(v)) return blockedV4(v);
  if (!net.isIPv6(v)) return true;
  if (v === "::" || v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return blockedV4(mapped[1]);
  // unique local, link local, site local (deprecated), multicast
  return /^(f[cd]|fe[89ab]|fe[c-f]|ff)/.test(v);
}

async function addressesOf(host) {
  if (net.isIP(host)) return [host];
  const ses = electron.session.defaultSession;
  if (typeof ses.resolveHost === "function") {
    try {
      const r = await ses.resolveHost(host);
      const list = (r?.endpoints ?? []).map((e) => e.address).filter(Boolean);
      if (list.length) return list;
    } catch {
      // fall back to the system resolver
    }
  }
  return (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/** Throws unless the URL is http(s) on a name that resolves to public addresses only. */
async function assertPublic(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https");
  if (u.username || u.password) throw new Error("no credentials in links");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const singleLabel = !host.includes(".") && !net.isIP(host);
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || singleLabel) {
    throw new Error("local host");
  }
  const addrs = await addressesOf(host);
  if (!addrs.length || addrs.some(blockedIp)) throw new Error("private address");
}

/** One request, redirects not followed: resolves with a Response or with the redirect target. */
function hop(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = electron.net.request({ url, method: "GET", redirect: "manual", useSessionCookies: false });
    for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, String(v));
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onAbort = () => {
      req.abort();
      done(reject, new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    req.on("redirect", (_status, _method, target) => {
      // not followed here: the caller checks the target and starts a new request
      req.abort();
      done(resolve, { redirect: target });
    });
    req.on("response", (res) => {
      const head = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) head.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
      const body = new ReadableStream({
        start(ctl) {
          res.on("data", (chunk) => ctl.enqueue(new Uint8Array(chunk)));
          res.on("end", () => ctl.close());
          res.on("error", (e) => ctl.error(e));
        },
        cancel() {
          req.abort();
        },
      });
      const empty = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
      const status = res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502;
      const out = new Response(empty ? null : body, { status, headers: head });
      Object.defineProperty(out, "url", { value: url });
      done(resolve, { response: out });
    });
    req.on("error", (e) => done(reject, e));
    req.end();
  });
}

/** fetch() for previews: GET only, public addresses only, redirects checked hop by hop. */
async function publicFetch(raw, init = {}) {
  let url = String(raw);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    await assertPublic(url);
    const r = await hop(url, init.headers, init.signal);
    if (r.response) return r.response;
    url = new URL(r.redirect, url).href;
  }
  throw new Error("too many redirects");
}

module.exports = { publicFetch, blockedIp };
