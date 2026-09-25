// Self-test of the built front end inside real Electron: do wasm modules and
// AudioWorklets load over file://. It checks the packed app from the last
// desktop build, or dist/ after a plain `npm run build`.
// Run: npx electron scripts/electron-selftest.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const packed = path.join(__dirname, "..", "release", "win-unpacked", "resources", "app.asar", "dist");
const dist = fs.existsSync(packed) ? packed : path.join(__dirname, "..", "dist");
const assets = fs.readdirSync(path.join(dist, "assets"));
const wasm = assets.filter((f) => f.endsWith(".wasm"));
const worklets = assets.filter((f) => /worklet/i.test(f) && f.endsWith(".js"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadFile(path.join(dist, "index.html"));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    for (const f of ${JSON.stringify(wasm)}) {
      try {
        const r = await fetch("./assets/" + f);
        const buf = await r.arrayBuffer();
        out[f] = "fetch ok " + buf.byteLength + "b, compile " + (await WebAssembly.compile(buf) ? "ok" : "fail");
      } catch (e) { out[f] = "FAIL " + e; }
    }
    const ctx = new AudioContext({ sampleRate: 48000 });
    for (const f of ${JSON.stringify(worklets)}) {
      try { await ctx.audioWorklet.addModule("./assets/" + f); out[f] = "addModule ok"; }
      catch (e) { out[f] = "FAIL " + e; }
    }
    out.indexedDB = typeof indexedDB;
    out.root = document.getElementById("root")?.innerHTML.slice(0, 60);
    return out;
  })()`);
  console.log(JSON.stringify(result, null, 1));
  app.quit();
});
