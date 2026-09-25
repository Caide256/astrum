const electron = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Updates from GitHub releases of the repository named in brand.json.
 *
 * The latest release is checked shortly after start and then every few hours.
 * The page asks the user; on consent the installer is downloaded and its
 * SHA-512 is compared with latest.yml from the same release. The page then
 * leaves the voice channel and asks to install: the installer runs silently
 * with --force-run, closes the app, installs over it and starts it again.
 * The portable build cannot replace its own exe, so it only opens the release
 * page. In development nothing is installed.
 */

const API = "https://api.github.com";
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let repo = "";
let userAgent = "matrix-client";
let onState = () => undefined;
let beforeInstall = () => undefined;
let release = null;
let downloaded = "";
let busy = false;
let state = {
  enabled: false,
  current: "",
  status: "idle",
  version: "",
  notes: "",
  page: "",
  progress: 0,
  error: "",
  portable: false,
  canInstall: false,
};

function set(patch) {
  state = { ...state, ...patch };
  onState(state);
}

/** "v1.2.3" and "1.2.3" to [1, 2, 3]; anything after a dash is ignored. */
function parts(version) {
  return String(version || "")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The few fields of latest.yml that matter: installer file name, hash and size. */
function readManifest(text) {
  const pick = (key) => {
    const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+)`, "m").exec(text);
    return m ? m[1].trim() : "";
  };
  return { version: pick("version"), path: pick("path"), sha512: pick("sha512"), size: Number(pick("size")) || 0 };
}

async function get(url, accept) {
  const res = await electron.net.fetch(url, { headers: { "User-Agent": userAgent, Accept: accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function check() {
  if (!repo || busy) return state;
  busy = true;
  set({ status: "checking", error: "" });
  try {
    const res = await electron.net.fetch(`${API}/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": userAgent, Accept: "application/vnd.github+json" },
    });
    // no release published yet
    if (res.status === 404) {
      release = null;
      set({ status: "latest", version: state.current, page: `https://github.com/${repo}/releases`, notes: "" });
      return state;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const version = String(data.tag_name || "").replace(/^v/i, "");
    const page = String(data.html_url || `https://github.com/${repo}/releases/latest`);
    if (!version || !newer(version, state.current)) {
      release = null;
      set({ status: "latest", version, page, notes: "" });
      return state;
    }
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const yml = assets.find((a) => a.name === "latest.yml");
    let manifest = null;
    if (yml) manifest = readManifest(await (await get(yml.browser_download_url, "application/octet-stream")).text());
    const setup = manifest && assets.find((a) => a.name === manifest.path);
    release = setup && manifest.sha512 ? { url: setup.browser_download_url, name: setup.name, sha512: manifest.sha512, size: setup.size } : null;
    set({
      status: "available",
      version,
      page,
      notes: String(data.body || "").slice(0, 4000),
      canInstall: !!release && !state.portable && electron.app.isPackaged,
    });
  } catch (e) {
    set({ status: "error", error: String(e?.message || e) });
  } finally {
    busy = false;
  }
  return state;
}

/** Download the installer and verify it. Resolves with the file path. */
async function download() {
  if (!release) throw new Error("no installer in the release");
  const dir = path.join(electron.app.getPath("temp"), `${electron.app.getName()}-update`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, release.name);
  const res = await get(release.url, "application/octet-stream");
  const total = Number(res.headers.get("content-length")) || release.size || 0;
  const hash = crypto.createHash("sha512");
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  let shown = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      got += chunk.length;
      const progress = total ? got / total : 0;
      if (progress - shown >= 0.01) {
        shown = progress;
        set({ progress });
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (hash.digest("base64") !== release.sha512) {
    fs.rmSync(file, { force: true });
    throw new Error("checksum mismatch");
  }
  return file;
}

async function start() {
  if (!state.canInstall || state.status === "downloading") return state;
  set({ status: "downloading", progress: 0, error: "" });
  try {
    downloaded = await download();
    set({ status: "ready", progress: 1 });
  } catch (e) {
    set({ status: "error", error: String(e?.message || e) });
  }
  return state;
}

/** Run the downloaded installer silently and quit; it starts the app again when done. */
function install() {
  if (!downloaded || !fs.existsSync(downloaded)) return;
  const child = spawn(downloaded, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" });
  child.unref();
  beforeInstall();
  electron.app.quit();
}

function openPage() {
  const url = state.page || (repo ? `https://github.com/${repo}/releases/latest` : "");
  if (url) void electron.shell.openExternal(url);
}

function init(opts) {
  repo = /^[\w.-]+\/[\w.-]+$/.test(opts.repo || "") ? opts.repo : "";
  userAgent = `${opts.name || "app"}/${electron.app.getVersion()}`;
  onState = opts.onState || onState;
  beforeInstall = opts.beforeInstall || beforeInstall;
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  set({ enabled: !!repo, current: electron.app.getVersion(), portable });

  const { ipcMain } = electron;
  ipcMain.handle("app:update-state", () => state);
  ipcMain.handle("app:update-check", () => check());
  ipcMain.handle("app:update-start", () => start());
  ipcMain.handle("app:update-install", () => install());
  ipcMain.handle("app:update-open", () => openPage());

  if (!repo || process.env.APP_SELFTEST) return;
  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => {
    if (state.status !== "downloading" && state.status !== "ready") void check();
  }, CHECK_EVERY_MS);
}

module.exports = { init, check, newer, readManifest };
