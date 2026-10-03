const { contextBridge, ipcRenderer, webFrame } = require("electron");

/**
 * Thin bridge to the main process: only what a page cannot do itself, such
 * as the list of windows to share, native share audio, global hotkeys, the
 * tray, the window frame and updates.
 */

function listen(channel, cb) {
  const handler = (_e, value) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("desktop", {
  getScreenSources: () => ipcRenderer.invoke("app:screen-sources"),
  setScreenSource: (id, loopback) => ipcRenderer.invoke("app:screen-source", id, loopback),
  setHotkeys: (list) => ipcRenderer.invoke("app:hotkeys", list),
  getDisplays: () => ipcRenderer.invoke("app:displays"),
  idleSeconds: () => ipcRenderer.invoke("app:idle-seconds"),

  getShellSettings: () => ipcRenderer.invoke("app:shell-settings"),
  setShellSettings: (patch) => ipcRenderer.invoke("app:set-shell-settings", patch),
  setTrayState: (state) => ipcRenderer.invoke("app:tray-state", state),
  showWindow: () => ipcRenderer.invoke("app:show"),
  flashWindow: () => ipcRenderer.invoke("app:flash"),
  copyText: (text) => ipcRenderer.invoke("app:copy", text),
  copyImage: (png) => ipcRenderer.invoke("app:copy-image", png),
  sealSecret: (text) => ipcRenderer.invoke("app:secret-seal", text),
  openSecret: (sealed) => ipcRenderer.invoke("app:secret-open", sealed),
  linkPreview: (url) => ipcRenderer.invoke("app:link-preview", url),
  // the size of the whole interface; a page zoom keeps every layout in proportion
  setZoom: (factor) => {
    const f = Number(factor);
    if (f >= 0.5 && f <= 2) webFrame.setZoomFactor(f);
  },
  setMenuLabels: (labels) => ipcRenderer.invoke("app:menu-labels", labels),

  mlInfo: (host) => ipcRenderer.invoke("app:ml-info", host),
  mlPair: (host, pin, name, wid) => ipcRenderer.invoke("app:ml-pair", host, pin, name, wid),
  mlForget: (host) => ipcRenderer.invoke("app:ml-forget", host),
  mlReset: () => ipcRenderer.invoke("app:ml-reset"),
  mlCancel: (wid) => ipcRenderer.invoke("app:ml-cancel", wid),
  mlStart: (wid, opts) => ipcRenderer.invoke("app:ml-start", wid, opts),
  mlStop: (wid) => ipcRenderer.invoke("app:ml-stop", wid),
  mlIdr: (wid) => ipcRenderer.invoke("app:ml-idr", wid),
  // events of every watch: the callback gets the watch id first
  onMlEvent: (cb) => {
    const handler = (_e, wid, json) => cb(wid, json);
    ipcRenderer.on("app:ml-event", handler);
    return () => ipcRenderer.removeListener("app:ml-event", handler);
  },
  onMlFrame: (cb) => {
    const handler = (_e, wid, chunk) => cb(wid, chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    ipcRenderer.on("app:ml-frame", handler);
    return () => ipcRenderer.removeListener("app:ml-frame", handler);
  },

  sunStatus: () => ipcRenderer.invoke("app:sun-status"),
  sunInstall: () => ipcRenderer.invoke("app:sun-install"),
  sunStart: (settings) => ipcRenderer.invoke("app:sun-start", settings),
  sunStop: () => ipcRenderer.invoke("app:sun-stop"),
  sunDevices: () => ipcRenderer.invoke("app:sun-devices"),
  sunApprove: (id, pin, name) => ipcRenderer.invoke("app:sun-approve", id, pin, name),
  sunDeny: (id) => ipcRenderer.invoke("app:sun-deny", id),
  sunClients: () => ipcRenderer.invoke("app:sun-clients"),
  sunUnpair: (uuid) => ipcRenderer.invoke("app:sun-unpair", uuid),
  onSunEvent: (cb) => listen("app:sun-event", cb),
  sunPeer: (id, key, nat, cands) => ipcRenderer.invoke("app:sun-peer", id, key, nat, cands),
  sunDrop: (id) => ipcRenderer.invoke("app:sun-drop", id),
  netCheck: () => ipcRenderer.invoke("app:net-check"),
  sunPrewarm: (settings) => ipcRenderer.invoke("app:sun-prewarm", settings),
  streamLog: (text) => ipcRenderer.invoke("app:stream-log", text),
  openLogs: () => ipcRenderer.invoke("app:open-logs"),
  tunStart: (wid, base) => ipcRenderer.invoke("app:tun-start", wid, base),
  tunPeer: (wid, sid, key, nat, cands) => ipcRenderer.invoke("app:tun-peer", wid, sid, key, nat, cands),
  onTunEvent: (cb) => {
    const handler = (_e, wid, json) => cb(wid, json);
    ipcRenderer.on("app:tun-event", handler);
    return () => ipcRenderer.removeListener("app:tun-event", handler);
  },
  onTunPcm: (cb) => {
    const handler = (_e, wid, chunk) => cb(wid, chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    ipcRenderer.on("app:tun-pcm", handler);
    return () => ipcRenderer.removeListener("app:tun-pcm", handler);
  },

  windowAction: (action) => ipcRenderer.invoke("app:window", action),
  onWindowState: (cb) => listen("app:window-state", cb),

  getUpdate: () => ipcRenderer.invoke("app:update-state"),
  checkUpdate: () => ipcRenderer.invoke("app:update-check"),
  startUpdate: () => ipcRenderer.invoke("app:update-start"),
  installUpdate: () => ipcRenderer.invoke("app:update-install"),
  openUpdatePage: () => ipcRenderer.invoke("app:update-open"),
  onUpdate: (cb) => listen("app:update", cb),

  // a real quit: the page leaves the voice channel and reports back
  onBeforeQuit: (cb) =>
    listen("app:before-quit", async () => {
      try {
        await cb();
      } finally {
        ipcRenderer.send("app:quit-ready");
      }
    }),

  startScreenAudio: (sourceId) => ipcRenderer.invoke("app:screen-audio-start", sourceId),
  stopScreenAudio: () => ipcRenderer.invoke("app:screen-audio-stop"),
  onScreenAudio: (cb) => {
    const handler = (_e, chunk) => {
      // the main process sends a Uint8Array; hand out a standalone ArrayBuffer
      const copy = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      cb(copy);
    };
    ipcRenderer.on("app:screen-audio", handler);
    return () => ipcRenderer.removeListener("app:screen-audio", handler);
  },
  onScreenAudioEnd: (cb) => listen("app:screen-audio-end", cb),
});

// a global hotkey or a tray menu item fired in the main process
ipcRenderer.on("app:hotkey", (_e, detail) => {
  window.dispatchEvent(new CustomEvent("app:hotkey", { detail }));
});
