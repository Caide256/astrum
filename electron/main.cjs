const electron = require("electron");
const { app, BrowserWindow, Menu, desktopCapturer, globalShortcut, ipcMain, shell, session } = electron;
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const brand = require("../brand.json");
const guard = require("./guard.cjs");
const preview = require("./preview.cjs");
const { publicFetch } = require("./publicfetch.cjs");
const sunshine = require("./sunshine.cjs");
const tray = require("./tray.cjs");
const updater = require("./updater.cjs");

/**
 * Electron main process.
 *
 * In development the window loads the Vite server from APP_DEV_URL; the
 * packaged app opens dist/index.html. Media permissions are granted
 * explicitly: Electron's Chromium denies them by default.
 */

const DEV_URL = guard.DEV_URL;
const ICON = path.join(__dirname, "..", brand.logo);
// Windows and Linux get the app's own title bar; macOS keeps its traffic lights
const OWN_FRAME = process.platform !== "darwin";

// Chromium throttles hidden windows (timers once a second, paused painting).
// A voice client must keep working while minimized.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// the source for the next getDisplayMedia, picked in the app's own dialog
let chosenSource = "";
let chosenLoopback = true;
let mainWindow = null;
// a real quit, as opposed to closing the window into the tray
let quitting = false;
// autostart at sign-in: no window, the app waits in the tray
const startHidden = process.argv.includes("--hidden");

function showWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// microphone and camera, notifications and copying to the clipboard: for the app's own page only
const APP_ONLY = new Set(["media", "notifications", "clipboard-sanitized-write"]);

/**
 * Permissions. Element full screen is fine for anyone (a YouTube player
 * needs it); the rest only for the top frame of the app's own page, never
 * for an embedded player or anything else that ends up in a frame.
 */
function allowMedia() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === "fullscreen") {
      callback(true);
      return;
    }
    const url = details?.requestingUrl || wc?.getURL() || "";
    callback(APP_ONLY.has(permission) && details?.isMainFrame !== false && guard.isAppUrl(url));
  });

  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission === "fullscreen") return true;
    if (!APP_ONLY.has(permission)) return false;
    if (details?.isMainFrame === false) return false;
    if (details?.requestingUrl) return guard.isAppUrl(details.requestingUrl);
    // some checks come without any origin at all: those are the page's own
    return !origin || guard.isAppOrigin(origin);
  });

  // USB, serial and HID devices are never offered to pages
  ses.setDevicePermissionHandler(() => false);

  // without this handler getDisplayMedia fails in Electron
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
        const picked = sources.find((s) => s.id === chosenSource) || sources[0];
        const loopback = chosenLoopback;
        chosenSource = "";
        chosenLoopback = true;
        if (!picked) {
          callback({});
          return;
        }
        // engine loopback audio is used only without the native helper: it
        // captures everything, this app included, and viewers hear themselves
        callback(loopback ? { video: picked, audio: "loopback" } : { video: picked });
      })
      .catch(() => callback({}));
  });
}

function shareBridge() {
  guard.handle(ipcMain, "app:screen-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      displayId: s.display_id || "",
    }));
  });

  // physical size and refresh rate of each monitor, for the share quality options
  guard.handle(ipcMain, "app:displays", () =>
    electron.screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      hz: Math.round(d.displayFrequency || 60),
      primary: d.id === electron.screen.getPrimaryDisplay().id,
    })),
  );

  guard.handle(ipcMain, "app:screen-source", (_e, id, loopback) => {
    chosenSource = typeof id === "string" ? id : "";
    chosenLoopback = loopback !== false;
  });
}

/* ----------------------------------------------------------- native helper */

// the packed copy is named after the product (electron-builder.config.cjs), the development build after the crate
const HELPER = `${brand.name.replace(/[^\w.-]+/g, "-")}-helper.exe`;

function helperPath() {
  const candidates = [
    path.join(process.resourcesPath || "", HELPER),
    path.join(__dirname, "..", "native", "helper", "target", "release", "native-helper.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || "";
}

/* --------------------------------------------------------------- moonlight */

/**
 * Watching a Sunshine (Moonlight) host: the native helper pairs with it,
 * lists its apps and receives the video. Frames come out of the helper as
 * records ([kind u8][length u32 LE][payload]) and go to the page as they
 * are; the page decodes them with WebCodecs. The client identity (key and
 * certificate) lives in the profile folder.
 */
let mlStream = null;

function mlDir() {
  return path.join(app.getPath("userData"), "moonlight");
}

/** The pairing waiting for the streamer: dropped when the viewer gives up. */
let mlPairing = null;

/** One helper command with a JSON answer. */
function mlCommand(args, timeoutMs) {
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!exe || process.platform !== "win32") {
      resolve({ ok: false, error: "no-helper" });
      return;
    }
    const child = spawn(exe, ["moonlight", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (args[0] === "pair") mlPairing = child;
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (mlPairing === child) mlPairing = null;
      if (code !== 0) {
        resolve({ ok: false, error: err.trim() || `exit ${code}` });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(out.trim().split(/\r?\n/).pop() || "null") });
      } catch {
        resolve({ ok: false, error: out.trim() || "bad answer" });
      }
    });
  });
}

function stopMoonlight() {
  const child = mlStream;
  mlStream = null;
  if (!child) return;
  try {
    child.stdin.write("stop\n");
  } catch {
    // already gone
  }
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
  }, 3000);
}

/**
 * A host name, IPv4 or [IPv6] address, with an optional port, and optionally a
 * key the host's certificate is kept under ("key@address"): nothing else
 * reaches the helper.
 */
const HOST_RE = /^(?:[A-Za-z0-9_-]{1,64}@)?(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;
/** The device name a pairing request carries: the streamer's app matches requests by it. */
const DEVICE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function mlHost(h) {
  const v = String(h || "").trim();
  return v.length <= 260 && HOST_RE.test(v) ? v : "";
}

function moonlightBridge() {
  const bad = { ok: false, error: "bad-host" };
  const run = (h, args, ms) => {
    const host = mlHost(h);
    return host ? mlCommand([args[0], mlDir(), host, ...args.slice(1)], ms) : bad;
  };
  guard.handle(ipcMain, "app:ml-info", (_e, h) => run(h, ["info"], 20_000));
  // the streamer lets the request in on the other side; that may take a while
  guard.handle(ipcMain, "app:ml-pair", (_e, h, pin, name) => {
    if (!/^\d{4}$/.test(String(pin))) return bad;
    const device = DEVICE_RE.test(String(name ?? "")) ? [String(name)] : [];
    return run(h, ["pair", String(pin), ...device], 200_000);
  });
  guard.handle(ipcMain, "app:ml-forget", (_e, h) => run(h, ["forget"], 10_000));
  guard.handle(ipcMain, "app:ml-cancel", () => mlPairing?.kill());
  guard.handle(ipcMain, "app:ml-apps", (_e, h) => run(h, ["apps"], 20_000));
  guard.handle(ipcMain, "app:ml-quit", (_e, h) => run(h, ["quit"], 20_000));

  guard.handle(ipcMain, "app:ml-start", (event, opts) => {
    stopMoonlight();
    const exe = helperPath();
    if (!exe || process.platform !== "win32") return { ok: false, error: "no-helper" };
    const o = opts || {};
    if (!mlHost(o.host)) return bad;
    const num = (v, d) => String(Math.round(Number(v) || d));
    const args = [
      "moonlight",
      "stream",
      mlDir(),
      mlHost(o.host),
      num(o.app, 0),
      num(o.width, 1920),
      num(o.height, 1080),
      num(o.fps, 60),
      num(o.kbps, 20000),
      num(o.formats, 1),
      // the streamer keeps hearing the own sound
      o.hostAudio === false ? "0" : "1",
    ];
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    mlStream = child;
    const sender = event.sender;
    let pending = Buffer.alloc(0);
    let errText = "";

    child.stdout.on("data", (data) => {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      // whole records only; a frame may arrive in several pieces
      while (pending.length >= 5) {
        const len = pending.readUInt32LE(1);
        if (pending.length < 5 + len) break;
        const kind = pending[0];
        const payload = pending.subarray(5, 5 + len);
        pending = pending.subarray(5 + len);
        if (sender.isDestroyed()) continue;
        if (kind === 1) sender.send("app:ml-frame", Buffer.from(payload));
        else if (kind === 2) sender.send("app:ml-event", payload.toString("utf8"));
        else if (kind === 3) sender.send("app:ml-audio", Buffer.from(payload));
      }
    });
    child.stderr.on("data", (d) => {
      errText += d.toString();
    });
    child.on("exit", (code) => {
      if (mlStream === child) mlStream = null;
      if (!sender.isDestroyed()) {
        sender.send("app:ml-event", JSON.stringify({ event: "ended", code: code || 0, text: errText.trim().slice(-500) }));
      }
    });
    return { ok: true };
  });

  guard.handle(ipcMain, "app:ml-idr", () => {
    try {
      mlStream?.stdin.write("idr\n");
    } catch {
      // stream already ended
    }
  });
  guard.handle(ipcMain, "app:ml-stop", () => stopMoonlight());
}

/* ------------------------------------------------------- screen share audio */

/**
 * The native helper captures audio with WASAPI process loopback: a window
 * shares only its own program, a screen everything except this app. It writes
 * raw PCM to stdout, forwarded to the page in 10 ms chunks.
 */
let audioHelper = null;

function stopAudioHelper() {
  if (audioHelper) {
    audioHelper.removeAllListeners();
    audioHelper.kill();
    audioHelper = null;
  }
}

function audioBridge() {
  guard.handle(ipcMain, "app:screen-audio-start", (event, sourceId) => {
    stopAudioHelper();
    const exe = helperPath();
    if (!exe || process.platform !== "win32") return { ok: false, error: "no-helper" };

    // "window:HWND:0" is a window, anything else a screen
    const win = /^window:(\d+):/.exec(String(sourceId || ""));
    const args = win ? ["window", win[1]] : ["exclude", String(process.pid)];

    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    audioHelper = child;
    const sender = event.sender;
    let tail = Buffer.alloc(0);
    let errText = "";

    child.stdout.on("data", (data) => {
      // keep frame boundaries: 4 bytes per stereo sample
      const all = tail.length ? Buffer.concat([tail, data]) : data;
      const whole = all.length - (all.length % 4);
      tail = all.subarray(whole);
      if (whole > 0 && !sender.isDestroyed()) sender.send("app:screen-audio", all.subarray(0, whole));
    });
    child.stderr.on("data", (d) => {
      errText += d.toString();
    });
    child.on("exit", (code) => {
      if (audioHelper === child) audioHelper = null;
      if (!sender.isDestroyed()) sender.send("app:screen-audio-end", code ? errText.trim() || `exit ${code}` : "");
    });
    return { ok: true };
  });

  guard.handle(ipcMain, "app:screen-audio-stop", () => stopAudioHelper());
}

/* ------------------------------------------------------------------ hotkeys */

/**
 * Global hotkeys. On Windows the native helper runs in "keys" mode and
 * watches input through low-level hooks: left and right modifiers differ,
 * releases are reported (push-to-talk), keys are not taken from other
 * programs. Elsewhere, or if the helper is missing, Electron global shortcuts
 * are used; they take keys away from other programs and have no release.
 */
let keysHelper = null;
let keysRetry = 0;
/** Bindings from the page: [{ id, action, keys: number[][] | null, accelerator }] */
let bindings = [];

function sendHotkey(detail) {
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send("app:hotkey", detail);
}

function pushBindings() {
  const child = keysHelper;
  if (!child || !child.stdin.writable) return;
  const lines = ["clear"];
  for (const b of bindings) {
    if (!Array.isArray(b.keys) || !b.keys.length) continue;
    const spec = b.keys.map((part) => part.map((k) => Number(k).toString(16)).join("|")).join(",");
    lines.push(`bind ${String(b.id).replace(/\s/g, "")} ${spec}`);
  }
  child.stdin.write(lines.join("\n") + "\n");
}

function startKeysHelper() {
  const exe = helperPath();
  if (!exe || process.platform !== "win32" || quitting) return;
  const child = spawn(exe, ["keys"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  keysHelper = child;
  let buf = "";
  child.stdout.on("data", (data) => {
    buf += data.toString();
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (line === "ready") continue;
      const [kind, id] = line.split(" ");
      const binding = bindings.find((b) => String(b.id) === id);
      if (binding && (kind === "down" || kind === "up")) sendHotkey({ id: binding.id, action: binding.action, down: kind === "down" });
    }
  });
  child.stderr.on("data", () => undefined);
  child.on("exit", () => {
    if (keysHelper !== child) return;
    keysHelper = null;
    // a crash should not silently disable hotkeys: restart a few times
    if (!quitting && keysRetry < 5) {
      keysRetry += 1;
      setTimeout(() => {
        startKeysHelper();
        pushBindings();
      }, 1000);
    }
  });
  child.stdin.on("error", () => undefined);
}

function registerShortcuts(list) {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const item of list) {
    if (!item?.accelerator) continue;
    try {
      const ok = globalShortcut.register(item.accelerator, () => sendHotkey({ id: item.id, action: item.action, down: true }));
      if (!ok) failed.push(item.accelerator);
    } catch {
      failed.push(item.accelerator);
    }
  }
  return failed;
}

function hotkeyBridge() {
  // answers whether the native hook is used and which shortcuts the system refused
  guard.handle(ipcMain, "app:hotkeys", (_e, list) => {
    bindings = Array.isArray(list) ? list : [];
    if (keysHelper) {
      globalShortcut.unregisterAll();
      pushBindings();
      return { native: true, failed: [] };
    }
    return { native: false, failed: registerShortcuts(bindings) };
  });
}

/* ------------------------------------------------------------ shell bridge */

// seconds since the last mouse or keyboard input system-wide, not just in our
// window: someone playing with the app in the background is not away.
// (the screen and power modules are only touched inside handlers: they are unavailable before ready)
guard.handle(ipcMain, "app:idle-seconds", () => electron.powerMonitor.getSystemIdleTime());

// tray, autostart, unread badge and taskbar flashing
function shellBridge() {
  guard.handle(ipcMain, "app:shell-settings", () => tray.publicSettings());
  guard.handle(ipcMain, "app:set-shell-settings", (_e, patch) => tray.updateSettings(patch));
  guard.handle(ipcMain, "app:tray-state", (_e, state) => tray.applyState(state));
  guard.handle(ipcMain, "app:show", () => showWindow());
  guard.handle(ipcMain, "app:flash", () => {
    const win = mainWindow;
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
  guard.handle(ipcMain, "app:copy", (_e, text) => electron.clipboard.writeText(String(text ?? "")));
  guard.handle(ipcMain, "app:copy-image", (_e, png) => {
    if (!(png instanceof Uint8Array) || png.byteLength > 64 * 1024 * 1024) throw new Error("not an image");
    const image = electron.nativeImage.createFromBuffer(Buffer.from(png));
    if (image.isEmpty()) throw new Error("not an image");
    electron.clipboard.writeImage(image);
  });
  linkPreviews();
}

/* ------------------------------------------------------------------ secrets */

/**
 * The sign-in token is kept sealed by the operating system (DPAPI on
 * Windows), not as plain text in the profile folder: a copy of the folder,
 * or another Windows user, gets nothing usable. The page stores the sealed
 * text and asks for it to be opened on start.
 */
function secretsBridge() {
  const { safeStorage } = electron;
  guard.handle(ipcMain, "app:secret-seal", (_e, text) => {
    if (typeof text !== "string" || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(text).toString("base64");
  });
  guard.handle(ipcMain, "app:secret-open", (_e, sealed) => {
    if (typeof sealed !== "string" || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      return null;
    }
  });
}

/* ------------------------------------------------------------ link previews */

/**
 * Link previews are fetched here, not in the page: no CORS in the way, and
 * the proxy and certificate settings of the system apply. Only the sender's
 * app fetches; the result travels inside the message.
 */
function linkPreviews() {
  const fetchPreview = preview.createPreviewer(
    publicFetch,
    `Mozilla/5.0 (compatible; ${brand.name.replace(/[^\w.-]+/g, "")}Bot/1.0; link preview)`,
  );
  guard.handle(ipcMain, "app:link-preview", (_e, url) => fetchPreview(String(url ?? "")).catch(() => null));

  // YouTube refuses to play embedded videos without a Referer (error 153), and
  // a page loaded from a file sends none. Apps are asked to send their id.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube-nocookie.com/embed/*", "https://www.youtube.com/embed/*"] },
    (details, done) => {
      details.requestHeaders.Referer = `https://${brand.appId}/`;
      done({ requestHeaders: details.requestHeaders });
    },
  );
}

/* ----------------------------------------------------------- window frame */

function windowState(win) {
  return {
    frame: OWN_FRAME,
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
  };
}

// the page draws the title bar and its buttons; the window itself has no frame
function frameBridge() {
  guard.handle(ipcMain, "app:window", (e, action) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return null;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close();
    return windowState(win);
  });
}

function watchFrame(win) {
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send("app:window-state", windowState(win));
  };
  // Leaving the full screen of a video (Esc) is reported before the window
  // itself is out of it: the state sent right away still said "full screen"
  // and the title bar stayed hidden. It is sent again once things settled.
  const push = () => {
    send();
    setTimeout(send, 150);
    setTimeout(send, 600);
  };
  for (const ev of [
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
    "enter-html-full-screen",
    "leave-html-full-screen",
    "focus",
    "blur",
    "restore",
    "show",
  ]) {
    win.on(ev, push);
  }
  win.webContents.on("did-finish-load", push);
}

/* ------------------------------------------------------------- quitting */

/**
 * A real quit leaves the voice channel first: without it the call membership
 * stays in the room and others see a ghost until it expires. The page gets a
 * moment to retract it, then the app quits regardless.
 */
const LEAVE_WAIT_MS = 2500;
let leftCall = false;

/** Ask the page to leave the call, then continue. Returns false when there is nothing to wait for. */
function leaveCall(then) {
  const win = mainWindow;
  if (leftCall || !win || win.isDestroyed()) return false;
  leftCall = true;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    then();
  };
  ipcMain.once("app:quit-ready", finish);
  setTimeout(finish, LEAVE_WAIT_MS);
  win.webContents.send("app:before-quit");
  return true;
}

/** Open a link in the browser or the mail program; any other URL scheme is ignored. */
function openOutside(url) {
  if (guard.isOpenableExternally(url)) void shell.openExternal(url);
}

/**
 * Every window, the share popouts included, stays on the app's own page. A
 * dropped file or link, or a page script, cannot navigate a window elsewhere:
 * a foreign page there would run next to the app's bridge. Webviews are not
 * used, and new windows are refused unless the main window allows them.
 */
function lockContents(contents) {
  contents.on("will-navigate", (e, url) => {
    if (!guard.isAppUrl(url)) e.preventDefault();
  });
  contents.on("will-redirect", (e, url) => {
    if (e.isMainFrame && !guard.isAppUrl(url)) e.preventDefault();
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
}

const WEB_PREFS = {
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // the checker is there; whether it underlines anything is a setting (see spellBridge)
  spellcheck: true,
  backgroundThrottling: false,
};

/* ----------------------------------------------------------- spell checking */

/**
 * Red underlines under misspelled words, Russian and English at once, on when
 * the user turns it on. Right click on such a word offers the fixes; any text
 * field gets cut, copy and paste. Menu captions come from the page, in its
 * language.
 */
let menuLabels = {
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
  addWord: "Add to dictionary",
  noFixes: "No suggestions",
};

function applySpellcheck(on) {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(!!on);
  if (!on) return;
  const have = ses.availableSpellCheckerLanguages || [];
  const want = ["ru", "en-US"].filter((l) => !have.length || have.includes(l));
  try {
    if (want.length) ses.setSpellCheckerLanguages(want);
  } catch {
    // a language the system does not offer: the rest still works
  }
}

function spellBridge() {
  tray.setSpellcheckHandler(applySpellcheck);
  applySpellcheck(tray.loadSettings().spellcheck);
  guard.handle(ipcMain, "app:menu-labels", (_e, labels) => {
    if (!labels || typeof labels !== "object") return;
    for (const key of Object.keys(menuLabels)) {
      if (typeof labels[key] === "string" && labels[key].length < 80) menuLabels[key] = labels[key];
    }
  });
}

function editMenu(contents, params) {
  if (!params.isEditable && !params.selectionText) return;
  const items = [];
  if (params.misspelledWord) {
    const fixes = (params.dictionarySuggestions || []).slice(0, 6);
    for (const fix of fixes) items.push({ label: fix, click: () => contents.replaceMisspelling(fix) });
    if (!fixes.length) items.push({ label: menuLabels.noFixes, enabled: false });
    items.push({
      label: menuLabels.addWord,
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: "separator" });
  }
  const can = params.editFlags || {};
  if (params.isEditable) items.push({ label: menuLabels.cut, role: "cut", enabled: !!can.canCut });
  items.push({ label: menuLabels.copy, role: "copy", enabled: !!can.canCopy });
  if (params.isEditable) {
    items.push({ label: menuLabels.paste, role: "paste", enabled: !!can.canPaste });
    items.push({ type: "separator" }, { label: menuLabels.selectAll, role: "selectAll" });
  }
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
}

/* ------------------------------------------------------------- window state */

const MIN_W = 900;
const MIN_H = 600;

/** The saved bounds, if they still fit on one of the connected monitors. */
function savedBounds() {
  const b = tray.loadSettings().window;
  if (!b || typeof b.width !== "number" || typeof b.height !== "number") return null;
  const visible = electron.screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 80 > a.x && b.y + 40 > a.y && b.x + 80 < a.x + a.width && b.y + 40 < a.y + a.height;
  });
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

function watchBounds(win) {
  let timer = null;
  const store = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      const b = win.getNormalBounds();
      tray.updateSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } });
    }, 400);
  };
  win.on("resize", store);
  win.on("move", store);
  win.on("maximize", store);
  win.on("unmaximize", store);
}

function createWindow() {
  const bounds = savedBounds();
  const win = new BrowserWindow({
    width: Math.max(MIN_W, bounds?.width || 1280),
    height: Math.max(MIN_H, bounds?.height || 820),
    x: bounds?.x,
    y: bounds?.y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    backgroundColor: tray.loadSettings().background || "#121317",
    autoHideMenuBar: true,
    frame: !OWN_FRAME,
    title: brand.name,
    icon: ICON,
    show: false,
    webPreferences: WEB_PREFS,
  });
  mainWindow = win;
  if (bounds?.maximized) win.maximize();
  if (!startHidden) win.show();
  watchBounds(win);
  watchFrame(win);

  // the close button hides into the tray: calls and notifications go on
  win.on("close", (e) => {
    if (!quitting && tray.loadSettings().closeToTray) {
      e.preventDefault();
      win.hide();
      tray.hintOnce();
      return;
    }
    // closing for real: leave the voice channel first
    if (leaveCall(() => !win.isDestroyed() && win.close())) e.preventDefault();
  });
  win.on("focus", () => win.flashFrame(false));
  // right click in a text field: fixes for a misspelled word, cut, copy, paste
  win.webContents.on("context-menu", (_e, params) => editMenu(win.webContents, params));

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // a separate screen share window: a blank page filled by the app itself.
    // A regular window, not always-on-top, so it can go to another monitor
    if (url === "about:blank" && frameName.startsWith("popout-")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 960,
          height: 560,
          minWidth: 320,
          minHeight: 200,
          backgroundColor: "#000000",
          autoHideMenuBar: true,
          title: brand.name,
          icon: ICON,
          webPreferences: { ...WEB_PREFS, preload: undefined },
        },
      };
    }
    // external links open in the browser, not inside the app
    openOutside(url);
    return { action: "deny" };
  });

  // the main window is gone: share windows go with it
  win.on("closed", () => {
    mainWindow = null;
    stopAudioHelper();
    app.quit();
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  if (process.env.APP_SELFTEST) win.webContents.once("did-finish-load", () => void selftest(win));
  return win;
}

/**
 * Self-test of the packaged app in real Electron: the popout window, helper
 * audio without the app's own sound, capture quality, the tray, and global
 * key bindings through the native hook. Run: APP_SELFTEST=1 electron .
 */
async function selftest(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    const w = window.open("about:blank", "popout-selftest", "width=400,height=300");
    out.popout = !!w && !!w.document && !!w.document.body;
    w && w.close();

    // the app plays a loud tone: it must not end up in the screen capture
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain).connect(ctx.destination);
    osc.start();

    const chunks = [];
    const off = window.desktop.onScreenAudio((c) => chunks.push(new Int16Array(c)));
    out.start = await window.desktop.startScreenAudio("screen:0:0");
    await new Promise((r) => setTimeout(r, 2500));
    await window.desktop.stopScreenAudio();
    off();
    osc.stop();
    await ctx.close();

    let sum = 0, n = 0;
    for (const c of chunks) for (const v of c) { sum += (v / 32768) ** 2; n += 1; }
    out.capturedSeconds = +(n / 2 / 48000).toFixed(2);
    out.capturedRms = n ? +Math.sqrt(sum / n).toFixed(4) : 0;
    out.ownToneRms = +(0.2 / Math.SQRT2).toFixed(4);

    // share quality: constrained capture, constraint changes, real frame rate
    out.displays = await window.desktop.getDisplays();
    out.idleSeconds = await window.desktop.idleSeconds();
    out.h264 = RTCRtpSender.getCapabilities("video").codecs.some((c) => /h264/i.test(c.mimeType));
    const screen = (await window.desktop.getScreenSources()).find((s) => s.kind === "screen");
    out.screenDisplayId = screen && screen.displayId;
    await window.desktop.setScreenSource(screen.id, false);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { max: 720 }, width: { max: 1728 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
    });
    let track = stream.getVideoTracks()[0];
    // frames are counted on the track itself, before painting, so the window rate does not limit it
    const countFrames = async () => {
      const t = track.clone();
      const reader = new MediaStreamTrackProcessor({ track: t }).readable.getReader();
      let frames = 0;
      let size = "";
      const started = performance.now();
      while (performance.now() - started < 2000) {
        const { value, done } = await reader.read();
        if (done) break;
        size = value.displayWidth + "x" + value.displayHeight;
        value.close();
        frames += 1;
      }
      reader.cancel().catch(() => undefined);
      t.stop();
      return { fps: Math.round(frames / ((performance.now() - started) / 1000)), frame: size };
    };
    // the picture must change every frame, or the capture sends fewer frames
    const spin = document.createElement("div");
    spin.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;background:red;z-index:99999";
    document.body.appendChild(spin);
    let hue = 0;
    let animating = true;
    let painted = 0;
    const paintStart = performance.now();
    const paint = () => {
      painted += 1;
      hue = (hue + 7) % 360;
      spin.style.background = "hsl(" + hue + " 90% 50%)";
      if (animating) requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    const s720 = track.getSettings();
    out.capture720 = { w: s720.width, h: s720.height, fps: s720.frameRate, measured: await countFrames() };
    await track.applyConstraints({ height: { max: 480 }, width: { max: 1152 }, frameRate: { ideal: 30, max: 30 } });
    await new Promise((r) => setTimeout(r, 400));
    const s480 = track.getSettings();
    out.capture480 = { w: s480.width, h: s480.height, fps: s480.frameRate, measured: await countFrames() };
    await track.applyConstraints({ frameRate: { ideal: 60, max: 60 } });
    await new Promise((r) => setTimeout(r, 400));
    out.captureNative = { measured: await countFrames() };
    track.stop();

    // windows use another capture path (WGC): measure our own animated window too
    const own = (await window.desktop.getScreenSources()).find((s) => s.kind === "window" && s.name.includes(${JSON.stringify(brand.name)}));
    if (own) {
      await window.desktop.setScreenSource(own.id, false);
      const ws = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false });
      const wt = ws.getVideoTracks()[0];
      const keep = track;
      track = wt;
      out.captureWindow = { name: own.name, measured: await countFrames() };
      track = keep;
      wt.stop();
    }
    animating = false;
    out.pageFps = Math.round(painted / ((performance.now() - paintStart) / 1000));
    spin.remove();
    track.stop();
    return out;
  })()`);

  // tray: the state reaches the icon, the close button hides instead of quitting
  result.shell = await win.webContents.executeJavaScript(`(async () => {
    const before = await window.desktop.getShellSettings();
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    g.fillStyle = "#ed4245";
    g.fillRect(0, 0, 32, 32);
    const png = c.toDataURL("image/png");
    await window.desktop.setTrayState({
      icon16: png, icon32: png, overlay: png, tooltip: ${JSON.stringify(brand.name + " · microphone off")}, inCall: true, muted: true, deafened: false,
      labels: { open: "Open", mute: "Mute", unmute: "Unmute", deafen: "Deafen", undeafen: "Undeafen", quit: "Quit", hintTitle: "", hintBody: "" },
    });
    return { before };
  })()`);
  result.tray = tray.debugState();

  // global bindings through the native hook: right Shift + F24 must fire, left Shift + F24 must
  // not. Only F23 and F24 are pressed: they type nothing into whatever window has the focus
  const events = [];
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, detail) => {
    if (channel === "app:hotkey") events.push(detail);
    return origSend(channel, detail);
  };
  result.hotkeys = await win.webContents.executeJavaScript(`window.desktop.setHotkeys([
    { id: "rshift", action: "mute", keys: [[0xa1], [0x87]], accelerator: null },
    { id: "f23", action: "deafen", keys: [[0x86]], accelerator: "F23" },
  ])`);
  await new Promise((r) => setTimeout(r, 300));
  const exe = helperPath();
  const press = (spec) =>
    new Promise((resolve) => spawn(exe, ["press", spec], { windowsHide: true }).on("exit", resolve));
  if (exe) {
    await press("a1,87");
    await press("a0,87");
    await press("86");
    await new Promise((r) => setTimeout(r, 400));
  }
  result.hotkeyEvents = events.map((e) => `${e.id}:${e.down ? "down" : "up"}`);
  await win.webContents.executeJavaScript(`window.desktop.setHotkeys([])`);

  // the own title bar: drawn, draggable, and the window keeps its size limits without a frame
  result.frame = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector(".titlebar");
    return {
      bar: !!bar,
      height: bar ? bar.getBoundingClientRect().height : 0,
      drag: bar ? getComputedStyle(bar).getPropertyValue("-webkit-app-region") : "",
      buttons: document.querySelectorAll(".tb-btn").length,
    };
  })()`);
  result.frame.resizable = win.isResizable();
  if (process.env.APP_SELFTEST_SHOT) {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(process.env.APP_SELFTEST_SHOT, shot.toPNG());
  }

  win.close();
  await new Promise((r) => setTimeout(r, 300));
  result.closeToTray = { destroyed: win.isDestroyed(), visible: !win.isDestroyed() && win.isVisible() };
  console.log("SELFTEST " + JSON.stringify(result));
  app.quit();
}

// The data folder is named after the product. A separate profile has its own
// folder, sign-in and single-instance lock: a second account can run side by
// side, and the self-test does not collide with a running copy.
app.setName(brand.name);
const profile = process.env.APP_PROFILE || (process.env.APP_SELFTEST ? "selftest" : "");
const dataDir = profile ? `${brand.name}-${profile.replace(/[^\w-]/g, "")}` : brand.name;
app.setPath("userData", path.join(app.getPath("appData"), dataDir));
// notifications and the taskbar group windows by this id; the installer's shortcut carries the same one
if (process.platform === "win32") app.setAppUserModelId(brand.appId);

// one instance; a second launch just shows the window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // a second launch, including while hidden in the tray, shows the window
  app.on("second-instance", () => showWindow());

  app.on("before-quit", (e) => {
    quitting = true;
    if (leaveCall(() => app.quit())) e.preventDefault();
  });

  app.on("web-contents-created", (_e, contents) => lockContents(contents));

  void app.whenReady().then(() => {
    // no menu bar: Alt would toggle it and Ctrl+R would reload the page mid-call
    if (!DEV_URL) Menu.setApplicationMenu(null);
    allowMedia();
    spellBridge();
    secretsBridge();
    shareBridge();
    audioBridge();
    hotkeyBridge();
    shellBridge();
    moonlightBridge();
    sunshine.init({
      handle: guard.handle,
      ipcMain,
      helperPath,
      send: (event) => {
        const win = mainWindow;
        if (win && !win.isDestroyed()) win.webContents.send("app:sun-event", event);
      },
    });
    frameBridge();
    startKeysHelper();
    createWindow();
    updater.init({
      repo: brand.updateRepo,
      name: brand.name,
      onState: (st) => {
        const win = mainWindow;
        if (win && !win.isDestroyed()) win.webContents.send("app:update", st);
      },
      // the installer closes the app: skip the voice goodbye, it has no time for it
      beforeInstall: () => {
        quitting = true;
        leftCall = true;
      },
    });

    tray.createTray({
      getWindow: () => mainWindow,
      show: showWindow,
      quit: () => app.quit(),
      hotkey: (action) => sendHotkey({ action, down: true }),
    });
    // the exe may have moved or been updated: point autostart at the current one
    if (tray.loadSettings().autostart && !process.env.APP_SELFTEST) tray.applyAutostart();

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      else showWindow();
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopAudioHelper();
    // the helper stops Sunshine cleanly on its own once the app is gone
    void sunshine.stop();
    stopMoonlight();
    if (keysHelper) {
      const child = keysHelper;
      keysHelper = null;
      child.stdin.end();
      child.kill();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

