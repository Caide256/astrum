const electron = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const brand = require("../brand.json");

/**
 * Shell settings, the tray and autostart.
 *
 * Closing the window hides it into the tray instead of quitting. Autostart
 * launches the app hidden at sign-in. The tray and taskbar icons show mute,
 * deafen and unread state drawn by the page (src/tray.ts).
 *
 * Tray and menu modules are available only after "ready", so they are taken
 * from electron inside functions, not at load time.
 */

const ICON = path.join(__dirname, "..", brand.logo);

/* ----------------------------------------------------------- shell settings */

const DEFAULTS = { closeToTray: true, autostart: false, trayHintShown: false, background: "", window: null };
let settings = null;

function settingsFile() {
  return path.join(electron.app.getPath("userData"), "shell.json");
}

function loadSettings() {
  if (settings) return settings;
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    settings = { ...DEFAULTS };
  }
  return settings;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // kept in memory until restart
  }
}

/* ---------------------------------------------------------------- autostart */

// the portable build unpacks into a temp folder on every start: autostart must run the exe itself
function launcherPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/**
 * Write the autostart entry. Also called on every start, so that a moved or
 * updated exe is picked up.
 */
function applyAutostart() {
  const { app } = electron;
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    name: brand.name,
    openAtLogin: !!settings.autostart,
    path: launcherPath(),
    args: ["--hidden"],
  });
}

function publicSettings() {
  loadSettings();
  return {
    closeToTray: settings.closeToTray,
    autostart: settings.autostart,
    autostartAvailable: electron.app.isPackaged,
    background: settings.background,
  };
}

function updateSettings(patch) {
  loadSettings();
  if (typeof patch?.closeToTray === "boolean") settings.closeToTray = patch.closeToTray;
  if (typeof patch?.background === "string" && /^#[0-9a-f]{6}$/i.test(patch.background)) settings.background = patch.background;
  if (patch?.window && typeof patch.window === "object") {
    const w = patch.window;
    if ([w.x, w.y, w.width, w.height].every((v) => Number.isFinite(v))) {
      settings.window = { x: w.x, y: w.y, width: w.width, height: w.height, maximized: !!w.maximized };
    }
  }
  if (typeof patch?.autostart === "boolean") {
    settings.autostart = patch.autostart;
    applyAutostart();
  }
  saveSettings();
  return publicSettings();
}

/* -------------------------------------------------------------- tray images */

/** A tray image in two sizes: Windows picks the one for the display scale. */
function trayImage(pic16, pic32) {
  const img = electron.nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: pic16.toPNG() });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: pic32.toPNG() });
  return img;
}

/* --------------------------------------------------------------------- tray */

let tray = null;
let actions = null;
let getWindow = () => null;
let voiceState = { inCall: false, muted: false, deafened: false };
let tooltip = brand.name;
// captions in the interface language, sent by the page; English until then
let labels = {
  open: `Open ${brand.name}`,
  mute: "Mute microphone",
  unmute: "Unmute microphone",
  deafen: "Deafen",
  undeafen: "Undeafen",
  quit: `Quit ${brand.name}`,
  hintTitle: `${brand.name} is still running`,
  hintBody: "Closing the window hides it here. Right-click the icon to quit.",
};

/** The menu knows the mute state: each item says what it will do. */
function buildMenu() {
  const { Menu } = electron;
  const v = voiceState;
  return Menu.buildFromTemplate([
    { label: labels.open, click: actions.show },
    { type: "separator" },
    { label: v.muted ? labels.unmute : labels.mute, click: () => actions.hotkey("mute") },
    { label: v.deafened ? labels.undeafen : labels.deafen, click: () => actions.hotkey("deafen") },
    { type: "separator" },
    { label: labels.quit, click: actions.quit },
  ]);
}

function createTray(opts) {
  const { Tray, nativeImage } = electron;
  loadSettings();
  actions = opts;
  getWindow = opts.getWindow;
  const base = nativeImage.createFromPath(ICON);
  tray = new Tray(trayImage(base.resize({ width: 16, height: 16, quality: "best" }), base.resize({ width: 32, height: 32, quality: "best" })));
  tray.setToolTip(tooltip);
  tray.setContextMenu(buildMenu());
  // a single click restores the window
  tray.on("click", opts.show);
  tray.on("double-click", opts.show);
}

/** State from the page: ready icon images, the tooltip, menu captions and the voice state. */
function applyState(state) {
  if (!state || typeof state !== "object") return;
  const { nativeImage } = electron;
  voiceState = { inCall: !!state.inCall, muted: !!state.muted, deafened: !!state.deafened };
  tooltip = String(state.tooltip || brand.name);
  if (state.labels && typeof state.labels === "object") {
    for (const key of Object.keys(labels)) {
      if (typeof state.labels[key] === "string" && state.labels[key]) labels[key] = state.labels[key];
    }
  }
  if (tray && !tray.isDestroyed()) {
    const pic16 = nativeImage.createFromDataURL(String(state.icon16 || ""));
    const pic32 = nativeImage.createFromDataURL(String(state.icon32 || ""));
    if (!pic16.isEmpty() && !pic32.isEmpty()) tray.setImage(trayImage(pic16, pic32));
    tray.setToolTip(tooltip);
    tray.setContextMenu(buildMenu());
  }
  const win = getWindow();
  if (win && !win.isDestroyed() && process.platform === "win32") {
    const over = state.overlay ? nativeImage.createFromDataURL(String(state.overlay)) : null;
    win.setOverlayIcon(over && !over.isEmpty() ? over : null, over ? tooltip : "");
  }
}

/** The first time the window hides into the tray, say where the app went. */
function hintOnce() {
  loadSettings();
  if (settings.trayHintShown || !tray || process.env.APP_SELFTEST) return;
  settings.trayHintShown = true;
  saveSettings();
  try {
    tray.displayBalloon({ title: labels.hintTitle, content: labels.hintBody, iconType: "info" });
  } catch {
    // balloons are not available everywhere
  }
}

/** For the self-test: whether the icon exists and what it shows. */
function debugState() {
  return { hasTray: !!tray && !tray.isDestroyed(), tooltip, voice: voiceState, labels };
}

module.exports = {
  debugState,
  loadSettings,
  applyAutostart,
  publicSettings,
  updateSettings,
  createTray,
  applyState,
  hintOnce,
};
