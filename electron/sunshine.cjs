const electron = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const netcheck = require("./netcheck.cjs");

/**
 * The Sunshine bundled with the app: the stream server for "stream through
 * Sunshine". It is LizardByte's official portable build, fetched once from
 * their GitHub release and checked against a pinned SHA-256, then kept in the
 * profile folder. The app writes its own config next to it: a separate port
 * range (its own Sunshine does not collide with one the user installed),
 * no web UI outside this computer, no tray icon, and no input from viewers:
 * keyboard, mouse and gamepads are off, a viewer only watches.
 *
 * It runs only while the user streams, under the native helper, which stops
 * it with Ctrl+C so Sunshine can put back the driver settings it changes, and
 * takes it down if the app is gone. Viewers pair through the app: a viewer's
 * request carries a one-time device name, the streamer's app sees it in
 * Sunshine's list of pending pairings and lets it in only after the user
 * agrees. Everything else waiting there is turned away.
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
  return {
    output: text(s.output, 120),
    audioSink: text(s.audioSink, 200),
    audio: s.audio !== false,
    encoder: ENCODERS.has(s.encoder) ? s.encoder : "",
    maxKbps: Math.max(0, Math.min(500_000, Math.round(Number(s.maxKbps) || 0))),
    port: Number(s.port) >= 1100 && Number(s.port) <= 64000 ? Math.round(Number(s.port)) : DEFAULT_PORT,
    upnp: s.upnp !== false,
  };
}

function writeConfig(settings) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const f = (name) => path.join(dir, name);
  // the app list is just the desktop: viewers watch, nothing gets launched
  writeJson(f("apps.json"), { env: {}, apps: [{ name: "Desktop", "image-path": "desktop.png" }] });
  const encoder = settings.encoder || meta().detectedEncoder || "";
  const lines = [
    `sunshine_name = ${(os.hostname() || "Astrum").replace(/[^\w.-]/g, "").slice(0, 40) || "Astrum"}`,
    `port = ${settings.port}`,
    `upnp = ${settings.upnp ? "enabled" : "disabled"}`,
    "origin_web_ui_allowed = pc",
    "system_tray = disabled",
    "min_log_level = 2",
    "controller = disabled",
    "keyboard = disabled",
    "mouse = disabled",
    "install_steam_audio_drivers = disabled",
    "dd_configuration_option = disabled",
    `stream_audio = ${settings.audio ? "enabled" : "disabled"}`,
    `file_apps = ${f("apps.json")}`,
    `file_state = ${f("sunshine_state.json")}`,
    `credentials_file = ${f("credentials.json")}`,
    `pkey = ${f("key.pem")}`,
    `cert = ${f("cert.pem")}`,
    `log_path = ${f("sunshine.log")}`,
  ];
  if (settings.audioSink) lines.push(`audio_sink = ${settings.audioSink}`);
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

async function start(raw) {
  if (process.platform !== "win32") return { ok: false, error: "windows-only" };
  if (!installed()) return { ok: false, error: "not-installed" };
  if (state.running || state.starting) await stop();
  const exe = helperPath();
  if (!exe) return { ok: false, error: "no-helper" };
  const settings = cleanSettings(raw);
  setState({ starting: true, ready: false, error: "", port: settings.port, uid: "" });
  try {
    const login = credentials();
    const conf = writeConfig(settings);
    if (login.fresh || !fs.existsSync(path.join(stateDir(), "credentials.json"))) {
      if (!(await runOnce([conf, "--creds", login.user, login.pass], 60_000))) throw new Error("Sunshine did not accept its login");
    }
    const p = spawn(exe, ["sunshine", exePath(), conf], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child = p;
    p.stdin.on("error", () => undefined);
    p.on("exit", () => {
      if (child !== p) return;
      child = null;
      stopPolling();
      setState({ running: false, ready: false, starting: false });
      emit({ type: "stopped" });
    });
    setState({ running: true, startedAt: Date.now() });

    // ready once it answers like a GameStream host; encoder checks take a while on first start
    const until = Date.now() + READY_TIMEOUT_MS;
    let info = null;
    while (!info && Date.now() < until && child === p) {
      info = await serverInfo(settings.port);
      if (!info) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!info || child !== p) throw new Error(child === p ? "Sunshine did not start in time" : "Sunshine stopped while starting");
    // Sunshine answers even when it found no screen or encoder to stream with (a locked or
    // disconnected session, a busy graphics card): there would be nothing to watch
    if (/Unable to find display or encoder/.test(readLog())) throw new Error("no-display");
    const uid = /<uniqueid>([^<]+)<\/uniqueid>/i.exec(info)?.[1]?.replace(/[^A-Za-z0-9-]/g, "") || "";
    setState({ ready: true, starting: false, uid });
    rememberEncoder();
    startPolling();
    return { ok: true, port: settings.port, uid };
  } catch (e) {
    const error = String(e?.message || e);
    await stop();
    setState({ starting: false, error });
    return { ok: false, error };
  }
}

function stop() {
  const p = child;
  stopPolling();
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

/** Sound outputs Sunshine can capture, from its own tool. */
function audioDevices() {
  return new Promise((resolve) => {
    const tool = path.join(appDir(), "Sunshine", "tools", "audio-info.exe");
    if (!fs.existsSync(tool)) {
      resolve([]);
      return;
    }
    const p = spawn(tool, [], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => p.kill(), 15_000);
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.on("error", () => resolve([]));
    p.on("exit", () => {
      clearTimeout(timer);
      const list = [];
      for (const block of out.split(/===== Device =====/).slice(1)) {
        const id = /Device ID\s*:\s*(.+)/.exec(block)?.[1]?.trim();
        const name = /Device name\s*:\s*(.+)/.exec(block)?.[1]?.trim();
        const active = /Device state\s*:\s*Active/i.test(block);
        if (id && active) list.push({ id, name: name || id });
      }
      resolve(list);
    });
  });
}

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
  handle(ipcMain, "app:sun-stop", () => stop());
  handle(ipcMain, "app:sun-devices", async () => ({ audio: await audioDevices(), displays: displays() }));
  handle(ipcMain, "app:sun-approve", async (_e, id, pin, name) => {
    if (!PAIRING_ID.test(String(id)) || !/^\d{4}$/.test(String(pin))) return { ok: false };
    const res = await api("POST", "/api/pin", { pairing_id: String(id), pin: String(pin), name: String(name ?? "").slice(0, 60) });
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
      ? res.named_certs.map((c) => ({ uuid: String(c.uuid ?? ""), name: String(c.name ?? "").slice(0, 80) })).filter((c) => UUID.test(c.uuid))
      : null;
  });
  handle(ipcMain, "app:sun-unpair", async (_e, uuid) => {
    if (uuid === "*") return { ok: (await api("POST", "/api/clients/unpair-all", {}))?.status === true };
    if (!UUID.test(String(uuid))) return { ok: false };
    return { ok: (await api("POST", "/api/clients/unpair", { uuid: String(uuid) }))?.status === true };
  });
  handle(ipcMain, "app:net-check", () => netcheck.check());
  // a host name typed by the user (a DynDNS name) becomes the public address viewers get
  handle(ipcMain, "app:resolve-public", async (_e, name) => {
    const host = String(name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host)) return "";
    try {
      const { address } = await dns.lookup(host, { family: 4 });
      return netcheck.isPublic(address) ? address : "";
    } catch {
      return "";
    }
  });
}

module.exports = { init, stop, isRunning: () => !!child };
