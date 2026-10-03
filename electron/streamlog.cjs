const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The log of streams through Sunshine: what the tunnel ends saw (candidates,
 * probes in, answers, the path or the failure), Moonlight's stages and
 * errors, and the steps of the page (requests, answers, pairing). A stream
 * that does not connect leaves enough here to tell why. It stays on this
 * computer, in the profile folder (logs/streams.log, the previous one in
 * streams.log.1): addresses are in it, it is sent only by hand.
 */

const MAX_BYTES = 1_000_000;
let file = "";

function logDir() {
  return path.join(app.getPath("userData"), "logs");
}

function logFile() {
  if (!file) {
    fs.mkdirSync(logDir(), { recursive: true });
    file = path.join(logDir(), "streams.log");
  }
  return file;
}

/** One line: the time, where it comes from, what happened. Keys are left out, nothing else is secret here. */
function streamLog(source, text) {
  try {
    const f = logFile();
    const size = fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) fs.renameSync(f, `${f}.1`);
    const clean = String(text)
      .replace(/"key":"[0-9a-f]{64}"/g, '"key":"..."')
      .replace(/[\r\n]+/g, " ")
      .slice(0, 2000);
    fs.appendFileSync(f, `${new Date().toISOString()} ${String(source).slice(0, 40)} ${clean}\n`);
  } catch {
    // a log that cannot be written is no reason to stop a stream
  }
}

module.exports = { streamLog, logDir };
