const electron = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const dgram = require("node:dgram");
const https = require("node:https");
const path = require("node:path");
const netcheck = require("./netcheck.cjs");
const { streamLog } = require("./streamlog.cjs");

/**
 * The Sunshine bundled with the app: the stream server for "stream through
 * Sunshine". It is LizardByte's official portable build, fetched once from
 * their GitHub release and checked against a pinned SHA-256, then kept in the
 * profile folder. The app writes its own config next to it: a separate port
 * range (its own Sunshine does not collide with one the user installed),
 * no web UI outside this computer, no tray icon, no UPnP, and no input from
 * viewers: keyboard, mouse and gamepads are off, a viewer only watches.
 * Sunshine's own sound capture is off too: it would carry the call; the
 * tunnel sends the computer's sound without the app's own.
 *
 * Viewers do not connect to Sunshine's ports: nothing needs to be open on
 * the router. The native helper's tunnel (native/helper/src/tunnel) punches
 * a direct, encrypted path to each viewer the user let in and forwards it to
 * Sunshine on this computer. The router may still be asked over UPnP to pass
 * the tunnel's one UDP port, which helps behind a strict NAT.
 *
 * Sunshine runs only while the user streams, under the native helper, which
 * stops it with Ctrl+C so Sunshine can put back the driver settings it
 * changes, and takes it down if the app is gone. Viewers pair through the
 * app: a viewer's request carries a one-time device name, the streamer's app
 * sees it in Sunshine's list of pending pairings and lets it in only after
 * the user agreed. Everything else waiting there is turned away.
 */

const COMPONENT = {
  version: "2026.914.233613",
  url: "https://github.com/LizardByte/Sunshine/releases/download/v2026.914.233613/Sunshine-Windows-AMD64-lite.zip",
  sha256: "233008e46f4c0e501a586cbfd6c4fd4a4c0d414a0b5fc7f13c070eb92ec3824b",
  size: 38060196,
};

const DEFAULT_PORT = 49989;
const READY_TIMEOUT_MS = 120_000;
const ENCODERS = new Set(["", "nvenc", "amdvce", "quicksync", "software"]);

let helperPath = () => "";
let send = () => undefined;

let child = null;
let state = { running: false, ready: false, starting: false, error: "", port: DEFAULT_PORT, uid: "", startedAt: 0 };
/** The streamer's end of the tunnel: the helper process, its candidates, answers awaited per viewer. */
let tunnel = null;
let installing = null;
let pollTimer = null;
let lastPairings = "";

function root() {
  return path.join(electron.app.getPath("userData"), "sunshine");
}
function appDir() {
  return path.join(root(), "app");
}
function stateDir() {
  return path.join(root(), "state");
}
function exePath() {
  return path.join(appDir(), "Sunshine", "sunshine.exe");
}
function metaPath() {
  return path.join(root(), "component.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function meta() {
  return readJson(metaPath(), {});
}

function installed() {
  return meta().version === COMPONENT.version && fs.existsSync(exePath());
}

function emit(event) {
  send({ ...event });
}

function setState(patch) {
  state = { ...state, ...patch };
  emit({ type: "state", state: publicState() });
}

function publicState() {
  return {
    installed: installed(),
    version: COMPONENT.version,
    size: COMPONENT.size,
    installing: installing ? installing.progress : null,
    running: state.running,
    ready: state.ready,
    starting: state.starting,
    error: state.error,
    port: state.port,
    uid: state.uid,
    tunnel: tunnel?.ready ? { nat: tunnel.nat, cands: tunnel.cands } : null,
  };
}

/* ------------------------------------------------------------------ install */

async function download(onProgress) {
  const res = await electron.net.fetch(COMPONENT.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const file = path.join(root(), "download.zip.part");
  fs.mkdirSync(root(), { recursive: true });
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash("sha256");
  const reader = res.body.getReader();
  let have = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      have += value.byteLength;
      if (have > COMPONENT.size + 1024) throw new Error("the download is bigger than expected");
      hash.update(value);
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
      onProgress(Math.min(0.95, (have / COMPONENT.size) * 0.95));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (have !== COMPONENT.size || hash.digest("hex") !== COMPONENT.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error("the downloaded Sunshine does not match the expected file");
  }
  return file;
}

function extract(zip, dest) {
  return new Promise((resolve, reject) => {
    // Windows 10 and later have bsdtar, which reads zip files
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const p = spawn(tar, ["-xf", zip, "-C", dest], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exit ${code}`))));
  });
}

function install() {
  if (installing) return installing.promise;
  const job = { progress: 0, promise: null };
  installing = job;
  const tick = (progress) => {
    job.progress = progress;
    emit({ type: "install", progress });
  };
  job.promise = (async () => {
    try {
      tick(0);
      const zip = await download(tick);
      tick(0.96);
      const fresh = path.join(root(), "app.new");
      await extract(zip, fresh);
      if (!fs.existsSync(path.join(fresh, "Sunshine", "sunshine.exe"))) throw new Error("the archive has no sunshine.exe");
      fs.rmSync(appDir(), { recursive: true, force: true });
      fs.renameSync(fresh, appDir());
      fs.rmSync(zip, { force: true });
      writeJson(metaPath(), { ...meta(), version: COMPONENT.version });
      tick(1);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      installing = null;
      emit({ type: "state", state: publicState() });
    }
  })();
  return job.promise;
}

/* ------------------------------------------------------------- credentials */

/** The web API login of the bundled Sunshine: random, made once, sealed by Windows. */
function credentials() {
  const file = path.join(stateDir(), "astrum.json");
  const saved = readJson(file, null);
  const { safeStorage } = electron;
  if (saved?.user && saved?.sealed && safeStorage.isEncryptionAvailable()) {
    try {
      return { user: saved.user, pass: safeStorage.decryptString(Buffer.from(saved.sealed, "base64")), fresh: false };
    } catch {
      // sealed by another Windows user: a new login is made below
    }
  }
  const user = "astrum";
  const pass = crypto.randomBytes(24).toString("base64url");
  const sealed = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(pass).toString("base64") : "";
  if (!sealed) throw new Error("Windows cannot protect the Sunshine login here");
  writeJson(file, { user, sealed });
  return { user, pass, fresh: true };
}

function runOnce(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(exePath(), args, { cwd: path.dirname(exePath()), windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    p.on("error", () => resolve(false));
  });
}

/* ------------------------------------------------------------------ config */

function cleanSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const text = (v, max) => (typeof v === "string" ? v.replace(/[\r\n]/g, "").slice(0, max) : "");
  const udp = Math.round(Number(s.udpPort) || 0);
  return {
    output: text(s.output, 120),
    audio: s.audio !== false,
    encoder: ENCODERS.has(s.encoder) ? s.encoder : "",
    maxKbps: Math.max(0, Math.min(500_000, Math.round(Number(s.maxKbps) || 0))),
    viewers: Math.max(1, Math.min(8, Math.round(Number(s.viewers) || 4))),
    udpPort: udp >= 1024 && udp <= 65535 ? udp : 0,
    upnp: s.upnp !== false,
    address: text(s.address, 253).trim().toLowerCase(),
  };
}

/**
 * A base port for this start, its whole range free: TCP base-5, base, base+1
 * (web UI) and base+21, UDP base+9 to base+11. Each start picks anew, so two
 * people who stream and watch each other at the same time do not need the
 * same ports: a viewer's end of the tunnel stands in for the streamer's
 * Sunshine on the streamer's port numbers, next to the own Sunshine.
 */
function portFree(port, udp) {
  return new Promise((resolve) => {
    if (udp) {
      const sock = dgram.createSocket("udp4");
      sock.once("error", () => resolve(false));
      sock.bind(port, "0.0.0.0", () => sock.close(() => resolve(true)));
    } else {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(true)));
    }
  });
}

async function pickPort() {
  for (let i = 0; i < 30; i += 1) {
    // 31000-45950: away from Sunshine's own default (47989), the tunnel's 20000-29999 and LiveKit's 50000-60000
    const base = 31000 + Math.floor(Math.random() * 300) * 50;
    const tcp = [base - 5, base, base + 1, base + 21];
    const udp = [base + 9, base + 10, base + 11];
    const free = await Promise.all([...tcp.map((p) => portFree(p, false)), ...udp.map((p) => portFree(p, true))]);
    if (free.every(Boolean)) return base;
  }
  return DEFAULT_PORT;
}

function writeConfig(settings, port) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const f = (name) => path.join(dir, name);
  // the app list is just the desktop: viewers watch, nothing gets launched
  writeJson(f("apps.json"), { env: {}, apps: [{ name: "Desktop", "image-path": "desktop.png" }] });
  const encoder = settings.encoder || meta().detectedEncoder || "";
  const lines = [
    // the computer's own name would reach every viewer in Sunshine's server info
    "sunshine_name = Astrum",
    `port = ${port}`,
    // viewers come through the tunnel: no port of Sunshine is opened on the router
    "upnp = disabled",
    "origin_web_ui_allowed = pc",
    "system_tray = disabled",
    "min_log_level = 2",
    "controller = disabled",
    "keyboard = disabled",
    "mouse = disabled",
    "install_steam_audio_drivers = disabled",
    "dd_configuration_option = disabled",
    // the tunnel carries the sound without the call: Sunshine's capture would take everything
    "stream_audio = disabled",
    // each viewer is a session of its own, with its own encoder
    `channels = ${settings.viewers}`,
    `file_apps = ${f("apps.json")}`,
    `file_state = ${f("sunshine_state.json")}`,
    `credentials_file = ${f("credentials.json")}`,
    `pkey = ${f("key.pem")}`,
    `cert = ${f("cert.pem")}`,
    `log_path = ${f("sunshine.log")}`,
  ];
  if (settings.output) lines.push(`output_name = ${settings.output}`);
  if (encoder) lines.push(`encoder = ${encoder}`);
  if (settings.maxKbps) lines.push(`max_bitrate = ${settings.maxKbps}`);
  fs.writeFileSync(f("sunshine.conf"), lines.join("\n") + "\n");
  return f("sunshine.conf");
}

/* -------------------------------------------------------------------- run */

function serverInfo(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/serverinfo", timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function readLog() {
  try {
    return fs.readFileSync(path.join(stateDir(), "sunshine.log"), "utf8");
  } catch {
    return "";
  }
}

/** Which encoder Sunshine settled on, from its log: next time it starts without trying all of them. */
function rememberEncoder() {
  const m = /Found H\.264 encoder: [^\[]*\[(\w+)\]/.exec(readLog());
  if (m && ENCODERS.has(m[1])) writeJson(metaPath(), { ...meta(), detectedEncoder: m[1] });
}

/**
 * The start in progress or done, with the settings it was made with: a start
 * with the same settings joins it. Opening the share dialog starts Sunshine
 * ahead ("warm"), so pressing start is quick; a warm Sunshine nobody started
 * a stream with goes down again after a few minutes.
 */
let run = null;
let warmTimer = null;
const WARM_MS = 3 * 60_000;

function start(raw, warm = false) {
  const settings = cleanSettings(raw);
  const key = JSON.stringify(settings);
  clearTimeout(warmTimer);
  warmTimer = warm ? setTimeout(() => void stop(), WARM_MS) : null;
  if (run && run.key === key && (state.running || state.starting)) return run.promise;
  const promise = (async () => {
    if (state.running || state.starting) await stop();
    return launch(settings);
  })();
  run = { key, promise };
  return promise;
}

async function launch(settings) {
  if (process.platform !== "win32") return { ok: false, error: "windows-only" };
  if (!installed()) return { ok: false, error: "not-installed" };
  const exe = helperPath();
  if (!exe) return { ok: false, error: "no-helper" };
  const port = await pickPort();
  streamLog("sunshine", `start: port ${port}, encoder ${settings.encoder || meta().detectedEncoder || "auto"}, viewers ${settings.viewers}, upnp ${settings.upnp}`);
  setState({ starting: true, ready: false, error: "", port, uid: "" });
  try {
    const login = credentials();
    const conf = writeConfig(settings, port);
    if (login.fresh || !fs.existsSync(path.join(stateDir(), "credentials.json"))) {
      if (!(await runOnce([conf, "--creds", login.user, login.pass], 60_000))) throw new Error("Sunshine did not accept its login");
    }
    const p = spawn(exe, ["sunshine", exePath(), conf], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child = p;
    p.stdin.on("error", () => undefined);
    p.on("exit", () => {
      if (child !== p) return;
      child = null;
      run = null;
      stopPolling();
      stopTunnel();
      setState({ running: false, ready: false, starting: false });
      emit({ type: "stopped" });
    });
    setState({ running: true, startedAt: Date.now() });
    // the tunnel does not wait for Sunshine: its STUN look runs meanwhile
    const tunnelReady = startTunnel(settings, port);
    tunnelReady.catch(() => undefined);

    // ready once it answers like a GameStream host; encoder checks take a while on first start
    const until = Date.now() + READY_TIMEOUT_MS;
    let info = null;
    while (!info && Date.now() < until && child === p) {
      info = await serverInfo(port);
      if (!info) await new Promise((r) => setTimeout(r, 400));
    }
    if (!info || child !== p) throw new Error(child === p ? "Sunshine did not start in time" : "Sunshine stopped while starting");
    // Sunshine answers even when it found no screen or encoder to stream with (a locked or
    // disconnected session, a busy graphics card): there would be nothing to watch
    if (/Unable to find display or encoder/.test(readLog())) throw new Error("no-display");
    const uid = /<uniqueid>([^<]+)<\/uniqueid>/i.exec(info)?.[1]?.replace(/[^A-Za-z0-9-]/g, "") || "";
    const t = await tunnelReady;
    if (child !== p) throw new Error("Sunshine stopped while starting");
    setState({ ready: true, starting: false, uid });
    rememberEncoder();
    startPolling();
    void warmDesktop(port, p);
    return { ok: true, port, uid, nat: t.nat, cands: t.cands, encoder: meta().detectedEncoder || settings.encoder || "" };
  } catch (e) {
    const error = String(e?.message || e);
    streamLog("sunshine", `start failed: ${error}`);
    await stop();
    setState({ starting: false, error });
    return { ok: false, error };
  }
}

function stop() {
  const p = child;
  run = null;
  clearTimeout(warmTimer);
  warmTimer = null;
  stopPolling();
  stopTunnel();
  if (!p) {
    setState({ running: false, ready: false, starting: false });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    // the helper force-stops Sunshine after its own wait; this is the backstop
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        // gone
      }
      done();
    }, 20_000);
    p.once("exit", done);
    try {
      p.stdin.write("stop\n");
    } catch {
      p.kill();
    }
  });
}

/* ------------------------------------------------------------------- warm */

/** The name the app's own Moonlight pairs with its own Sunshine under; the page leaves it alone. */
const SELF_NAME = "astrum-self";

function helperJson(args, timeoutMs) {
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!exe) {
      resolve({ ok: false });
      return;
    }
    const c = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.on("data", (d) => (out = (out + d.toString()).slice(-8192)));
    c.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    c.on("error", () => resolve({ ok: false }));
    c.on("exit", (code) => {
      clearTimeout(timer);
      try {
        resolve(code === 0 ? { ok: true, data: JSON.parse(out.trim().split(/\r?\n/).pop() || "null") } : { ok: false, error: err.trim() });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

/**
 * Sunshine checks every encoder and format again whenever an app is launched
 * (some seconds), not when a running one is resumed. So the desktop is
 * launched right after the start, by the app's own Moonlight identity paired
 * with this Sunshine (both ends here, the PIN known to both), with a moment
 * of streaming to close that session: the first viewer then only resumes it
 * and gets the picture seconds sooner.
 */
async function warmDesktop(port, p) {
  const dir = path.join(electron.app.getPath("userData"), "moonlight");
  const host = `self@127.0.0.1:${port}`;
  const info = await helperJson(["moonlight", "info", dir, host], 15_000);
  if (!info.ok || child !== p) return;
  if (!info.data?.paired) {
    const pin = String(crypto.randomInt(0, 10_000)).padStart(4, "0");
    const pairing = helperJson(["moonlight", "pair", dir, host, pin, SELF_NAME], 60_000);
    for (let i = 0; i < 30 && child === p; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await api("GET", "/api/pin");
      const req = Array.isArray(res?.pairings) ? res.pairings.find((x) => x?.name === SELF_NAME) : null;
      if (req) {
        await api("POST", "/api/pin", { pairing_id: String(req.id), pin, name: SELF_NAME });
        break;
      }
    }
    if (!(await pairing).ok || child !== p) return;
  }
  await helperJson(["moonlight", "warm", dir, host], 90_000);
}

/* ------------------------------------------------------------------ tunnel */

/** One line per event from the helper's tunnel: JSON, read as it comes. */
function lines(stream, onLine) {
  let rest = "";
  stream.on("data", (d) => {
    rest += d.toString("utf8");
    let at;
    while ((at = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line) onLine(line);
    }
    // a line that never ends is not one of ours
    if (rest.length > 65536) rest = "";
  });
}

const CAND = /^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]{2,39}\]):\d{1,5}$/i;

function cleanCands(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(",");
  return [...new Set(arr.map((c) => String(c).trim()).filter((c) => CAND.test(c)))].slice(0, 16);
}

/**
 * The streamer's end of the tunnel: one UDP port for all viewers. Its
 * candidates are the home network's addresses, IPv6, the outside address
 * STUN saw (kept alive, an offer carries it as it is then), the router's
 * once it agreed to pass the port over UPnP, and the address typed by the
 * user for a port forwarded by hand. The last two come in later: the stream
 * does not wait for the router.
 */
function startTunnel(settings, port) {
  stopTunnel();
  const exe = helperPath();
  const lan = netcheck.lanAddresses();
  const v6 = netcheck.v6Addresses();
  const p = spawn(
    exe,
    ["tunnel", "host", String(port), String(settings.udpPort), settings.audio ? "1" : "0", String(process.pid), lan.join(","), v6.join(",")],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const t = { child: p, ready: false, stopping: false, nat: "", cands: [], waiting: new Map() };
  tunnel = t;
  p.stdin.on("error", () => undefined);
  let errText = "";
  p.stderr.on("data", (d) => {
    errText = (errText + d).slice(-300);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the stream tunnel did not start")), 15_000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (tunnel === t) tunnel = null;
      for (const w of t.waiting.values()) w({ ok: false, error: "tunnel" });
      t.waiting.clear();
      if (!t.ready) streamLog("host", `the tunnel ended before it was ready (${code}): ${errText.trim()}`);
      if (!t.ready) reject(new Error("the stream tunnel did not start"));
      else if (child && !t.stopping) emit({ type: "tunnel", ev: "gone" });
    });
    lines(p.stdout, async (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      streamLog("host", line);
      if (ev.ev === "ready" && !t.ready) {
        t.nat = String(ev.nat || "");
        t.cands = cleanCands(ev.cands);
        t.ready = true;
        clearTimeout(timer);
        resolve({ nat: t.nat, cands: t.cands });
        const add = (c) => {
          streamLog("host", `extra candidate ${c}`);
          if (tunnel !== t || !CAND.test(c)) return;
          t.cands = cleanCands([...t.cands, c]);
          try {
            p.stdin.write(`cand ${c}\n`);
          } catch {
            // the tunnel is gone
          }
        };
        const udp = Number(ev.port) || 0;
        if (settings.upnp && udp) void netcheck.openPort(udp).then((outside) => outside && add(outside)).catch(() => undefined);
        if (settings.udpPort && settings.address) void publicAddress(settings.address).then((ip) => ip && add(`${ip}:${settings.udpPort}`));
      } else if (ev.ev === "cands") {
        t.cands = cleanCands(ev.cands);
      } else if ((ev.ev === "offer" || ev.ev === "refused") && typeof ev.id === "string") {
        const w = t.waiting.get(ev.id);
        t.waiting.delete(ev.id);
        w?.(
          ev.ev === "offer"
            ? { ok: true, sid: Number(ev.sid) >>> 0, key: String(ev.key || ""), cands: cleanCands(ev.cands).length ? cleanCands(ev.cands) : t.cands, nat: t.nat }
            : { ok: false, error: String(ev.text || "refused") },
        );
      } else if (ev.ev === "up" || ev.ev === "down") {
        emit({ type: "tunnel", ev: ev.ev, id: String(ev.id || ""), path: String(ev.path || ""), reason: String(ev.reason || "") });
      } else if (ev.ev === "audio-error") {
        emit({ type: "tunnel", ev: "audio-error" });
      }
    });
  });
}

function stopTunnel() {
  const t = tunnel;
  tunnel = null;
  void netcheck.closePort();
  if (!t) return;
  t.stopping = true;
  try {
    t.child.stdin.write("stop\n");
  } catch {
    // already gone
  }
  setTimeout(() => {
    if (t.child.exitCode === null) t.child.kill();
  }, 3000);
}

const VIEWER_ID = /^astrum-[0-9a-f]{8,32}$/;
const KEY = /^[0-9a-f]{64}$/;
const NATS = new Set(["open", "cone", "symmetric", "blocked", "unknown"]);

/** A viewer the user let in: the tunnel makes a session for it and answers with its key. */
function addViewer(id, key, nat, cands) {
  const t = tunnel;
  const list = cleanCands(cands);
  if (!t?.ready || !VIEWER_ID.test(String(id)) || !KEY.test(String(key)) || !list.length) return Promise.resolve({ ok: false, error: "bad" });
  const n = NATS.has(nat) ? nat : "unknown";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      t.waiting.delete(id);
      resolve({ ok: false, error: "timeout" });
    }, 8000);
    t.waiting.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    streamLog("host", `viewer ${id} let in: nat ${n}, candidates ${list.join(",")}`);
    try {
      t.child.stdin.write(`peer ${id} ${key} ${n} ${list.join(",")}\n`);
    } catch {
      t.waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: "tunnel" });
    }
  });
}

function dropViewer(id) {
  if (!tunnel || !VIEWER_ID.test(String(id))) return;
  try {
    tunnel.child.stdin.write(`drop ${id}\n`);
  } catch {
    // gone with the tunnel
  }
}

/** An address typed by the user (an IP or a DynDNS name) as a public IPv4 address, or "". */
async function publicAddress(name) {
  const host = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return "";
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    return netcheck.isPublic(address) ? address : "";
  } catch {
    return "";
  }
}

/** The helper's STUN look from a fresh socket: the NAT this computer is behind. */
function probe() {
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!exe) {
      resolve(null);
      return;
    }
    const p = spawn(exe, ["tunnel", "probe", netcheck.lanAddresses().join(",")], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

/* --------------------------------------------------------------- web API */

/** A request to the local Sunshine's API, its certificate pinned to the one in its folder. */
function api(method, route, body) {
  return new Promise((resolve) => {
    if (!state.ready) {
      resolve(null);
      return;
    }
    let login;
    let pem;
    let fingerprint = "";
    try {
      login = credentials();
      pem = fs.readFileSync(path.join(stateDir(), "cert.pem"));
      fingerprint = new crypto.X509Certificate(pem).fingerprint256;
    } catch {
      resolve(null);
      return;
    }
    const data = body ? JSON.stringify(body) : "";
    const req = https.request(
      {
        host: "127.0.0.1",
        port: state.port + 1,
        path: route,
        method,
        auth: `${login.user}:${login.pass}`,
        // the login goes out only after the handshake showed Sunshine's own certificate
        ca: pem,
        checkServerIdentity: (_host, cert) => (cert.fingerprint256 === fingerprint ? undefined : new Error("not our Sunshine")),
        timeout: 8000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

/** Pending pairing requests go to the page while they change. */
function startPolling() {
  stopPolling();
  lastPairings = "";
  pollTimer = setInterval(async () => {
    const res = await api("GET", "/api/pin");
    const list = Array.isArray(res?.pairings)
      ? res.pairings
          .filter((p) => p && typeof p.id === "string")
          .map((p) => ({ id: String(p.id).slice(0, 80), name: String(p.name ?? "").slice(0, 80), address: String(p.address ?? "").slice(0, 60) }))
      : [];
    const key = JSON.stringify(list);
    if (key === lastPairings) return;
    lastPairings = key;
    emit({ type: "pairings", list });
  }, 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  lastPairings = "";
}

/* ---------------------------------------------------------------- devices */

/**
 * Monitors as Sunshine names them, matched to the ones Electron knows by
 * their position on the desktop. Sunshine prints its list at start; before
 * the first start the system names are used.
 */
function displays() {
  const screens = electron.screen.getAllDisplays().map((d) => ({
    x: d.nativeOrigin?.x ?? Math.round(d.bounds.x * d.scaleFactor),
    y: d.nativeOrigin?.y ?? Math.round(d.bounds.y * d.scaleFactor),
    w: Math.round(d.size.width * d.scaleFactor),
    h: Math.round(d.size.height * d.scaleFactor),
    hz: Math.round(d.displayFrequency || 60),
    label: d.label || "",
    primary: d.id === electron.screen.getPrimaryDisplay().id,
  }));
  let known = [];
  try {
    const log = fs.readFileSync(path.join(stateDir(), "sunshine.log"), "utf8");
    const at = log.lastIndexOf("Currently available display devices:");
    if (at !== -1) {
      const start = log.indexOf("[", at);
      let depth = 0;
      let end = start;
      for (; end < log.length; end += 1) {
        if (log[end] === "[") depth += 1;
        else if (log[end] === "]" && (depth -= 1) === 0) break;
      }
      known = JSON.parse(log.slice(start, end + 1));
    }
  } catch {
    known = [];
  }
  return screens.map((s, i) => {
    const hit = known.find((k) => k?.info?.origin_point?.x === s.x && k?.info?.origin_point?.y === s.y);
    return {
      id: hit?.device_id || "",
      name: s.label || hit?.friendly_name || `${i + 1}`,
      w: s.w,
      h: s.h,
      hz: s.hz,
      primary: s.primary,
    };
  });
}

/* ------------------------------------------------------------------- bridge */

const PAIRING_ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[A-Za-z0-9-]{1,64}$/;

function init(opts) {
  helperPath = opts.helperPath;
  send = opts.send;
  const { handle, ipcMain } = opts;

  handle(ipcMain, "app:sun-status", () => publicState());
  handle(ipcMain, "app:sun-install", () => install());
  handle(ipcMain, "app:sun-start", (_e, settings) => start(settings));
  // the share dialog opened on Sunshine: it starts ahead, a stream started soon after is quick
  handle(ipcMain, "app:sun-prewarm", (_e, settings) => {
    if (!state.running && !state.starting && installed()) void start(settings, true);
  });
  handle(ipcMain, "app:sun-stop", () => stop());
  handle(ipcMain, "app:sun-devices", () => ({ displays: displays() }));
  handle(ipcMain, "app:sun-peer", (_e, id, key, nat, cands) => addViewer(String(id), String(key), String(nat), cands));
  handle(ipcMain, "app:sun-drop", (_e, id) => dropViewer(String(id)));
  handle(ipcMain, "app:sun-approve", async (_e, id, pin, name) => {
    if (!PAIRING_ID.test(String(id)) || !/^\d{4}$/.test(String(pin))) return { ok: false };
    const res = await api("POST", "/api/pin", { pairing_id: String(id), pin: String(pin), name: String(name ?? "").slice(0, 255) });
    streamLog("sunshine", `pairing ${id} of ${String(name ?? "")}: ${res?.status === true ? "accepted" : `refused ${JSON.stringify(res)}`}`);
    return { ok: res?.status === true };
  });
  handle(ipcMain, "app:sun-deny", async (_e, id) => {
    if (!PAIRING_ID.test(String(id))) return { ok: false };
    const res = await api("DELETE", "/api/pin", { pairing_id: String(id) });
    return { ok: res?.status === true };
  });
  handle(ipcMain, "app:sun-clients", async () => {
    const res = await api("GET", "/api/clients/list");
    return Array.isArray(res?.named_certs)
      ? res.named_certs.map((c) => ({ uuid: String(c.uuid ?? ""), name: String(c.name ?? "").slice(0, 255) })).filter((c) => UUID.test(c.uuid))
      : null;
  });
  handle(ipcMain, "app:sun-unpair", async (_e, uuid) => {
    if (uuid === "*") return { ok: (await api("POST", "/api/clients/unpair-all", {}))?.status === true };
    if (!UUID.test(String(uuid))) return { ok: false };
    return { ok: (await api("POST", "/api/clients/unpair", { uuid: String(uuid) }))?.status === true };
  });
  handle(ipcMain, "app:net-check", () => netcheck.check(probe));
}

module.exports = { init, stop, isRunning: () => !!child, probe };
