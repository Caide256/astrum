const { contextBridge, ipcRenderer } = require("electron");

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
