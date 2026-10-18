const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Logs in the profile folder (logs/), each with its previous part in
 * "<name>.1". They stay on this computer: addresses are in them, they are
 * sent only by hand.
 *
 * streams.log: streams through Sunshine. What the tunnel ends saw
 * (candidates, probes in, answers, the path or the failure), Moonlight's
 * stages and errors, and the steps of the page (requests, answers, pairing).
 *
 * app.log: connections of the app itself. Sign-in and sync failures, and
 * every step into a call: which media servers were tried, what each one
 * answered, where the call went in the end.
 */

const MAX_BYTES = 1_000_000;
const files = new Map();

function logDir() {
  return path.join(app.getPath("userData"), "logs");
}

function logFile(name) {
  let f = files.get(name);
  if (!f) {
    fs.mkdirSync(logDir(), { recursive: true });
    f = path.join(logDir(), `${name}.log`);
    files.set(name, f);
  }
  return f;
}

/** One line: the time, where it comes from, what happened. Keys and tokens are left out, nothing else is secret here. */
function write(name, source, text) {
  try {
    const f = logFile(name);
    const size = fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) fs.renameSync(f, `${f}.1`);
    const clean = String(text)
      .replace(/"key":"[0-9a-f]{64}"/g, '"key":"..."')
      .replace(/("(?:jwt|access_token|token)":")[^"]+"/g, '$1..."')
      .replace(/[\r\n]+/g, " ")
      .slice(0, 2000);
    fs.appendFileSync(f, `${new Date().toISOString()} ${String(source).slice(0, 40)} ${clean}\n`);
  } catch {
    // a log that cannot be written is no reason to stop anything
  }
}

const streamLog = (source, text) => write("streams", source, text);
const appLog = (source, text) => write("app", source, text);

module.exports = { streamLog, appLog, logDir, logFile };
