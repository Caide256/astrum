const path = require("node:path");
const { fileURLToPath } = require("node:url");

/**
 * What counts as the app's own page. Everything the main process offers
 * (IPC, permissions, navigation) is limited to it: a page from anywhere else
 * that ended up in a window, or a frame inside the app (a YouTube player),
 * gets nothing.
 *
 * In development the page comes from the Vite server in APP_DEV_URL; the
 * packaged app loads the files of dist/ next to this folder.
 */

const DEV_URL = process.env.APP_DEV_URL || "";
const DEV_ORIGIN = (() => {
  try {
    return DEV_URL ? new URL(DEV_URL).origin : "";
  } catch {
    return "";
  }
})();
const DIST = path.join(__dirname, "..", "dist");
const WIN = process.platform === "win32";

function norm(p) {
  const n = path.normalize(p);
  return WIN ? n.toLowerCase() : n;
}

const DIST_NORM = norm(DIST) + path.sep;

/** A URL of the app's own page or one of its files. */
function isAppUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (DEV_ORIGIN) return u.origin === DEV_ORIGIN;
    if (u.protocol !== "file:") return false;
    return norm(fileURLToPath(u)).startsWith(DIST_NORM);
  } catch {
    return false;
  }
}

/** The origin of the app's page, for permission checks that give only an origin. */
function isAppOrigin(origin) {
  const o = String(origin || "");
  if (DEV_ORIGIN) return o === DEV_ORIGIN || o === `${DEV_ORIGIN}/`;
  return o.startsWith("file:");
}

/** An IPC message from the top frame of the app's own page. */
function trusted(event) {
  const frame = event?.senderFrame;
  if (!frame || frame.parent) return false;
  return isAppUrl(frame.url);
}

/** ipcMain.handle, but only the app's own page may call it. */
function handle(ipcMain, channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    return fn(event, ...args);
  });
}

/** Links leave the app only for the browser or the mail program, never for other URL schemes. */
function isOpenableExternally(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

module.exports = { DEV_URL, isAppUrl, isAppOrigin, trusted, handle, isOpenableExternally };
