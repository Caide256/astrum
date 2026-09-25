import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";

import { t } from "../i18n/index.ts";
import { voice } from "../voice/voice.ts";

/**
 * A screen share in a separate system window that can be moved to another
 * monitor and made full screen there.
 *
 * The window opens blank from the app's origin and is filled from here: the
 * picture reuses the same track as the main window, no second connection to
 * the call is needed. Audio stays in the main window.
 *
 * If the shell refuses to open a window, picture-in-picture is used instead.
 */

type Track = LocalVideoTrack | RemoteVideoTrack;

const open = new Map<string, Window>();

/**
 * Stopping watching or leaving the call stops the track without an "ended"
 * event, so the call state is checked instead: once the video is gone, the
 * window closes rather than freezing on the last frame.
 */
voice.subscribe(() => {
  if (!open.size) return;
  const alive = new Set(voice.getState().videos.map((v) => v.key));
  for (const key of [...open.keys()]) if (!alive.has(key)) closePopout(key);
});

export function closePopout(key: string): void {
  const w = open.get(key);
  open.delete(key);
  if (w && !w.closed) w.close();
}

export function popOut(key: string, track: Track, title: string, onClose?: () => void): void {
  const existing = open.get(key);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }

  const safe = key.replace(/[^a-z0-9]/gi, "");
  const w = window.open("about:blank", `popout-${safe}`, "width=960,height=560");
  if (!w) {
    void pictureInPicture(track);
    return;
  }
  open.set(key, w);

  const doc = w.document;
  doc.title = title;
  doc.body.innerHTML = "";
  const style = doc.createElement("style");
  style.textContent = `
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
    .hint {
      position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
      font: 12px "Segoe UI", system-ui, sans-serif; color: #cfd3dc;
      background: rgba(0, 0, 0, 0.55); padding: 5px 10px; border-radius: 6px;
      transition: opacity .4s; pointer-events: none;
    }`;
  doc.head.appendChild(style);

  const video = doc.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track.mediaStreamTrack]);
  doc.body.appendChild(video);

  const hint = doc.createElement("div");
  hint.className = "hint";
  hint.textContent = t("popout.hint");
  doc.body.appendChild(hint);
  w.setTimeout(() => (hint.style.opacity = "0"), 2500);

  video.addEventListener("dblclick", () => {
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void doc.documentElement.requestFullscreen().catch(() => undefined);
  });
  void video.play().catch(() => undefined);

  // the share ended: the window is no longer needed
  const ended = () => closePopout(key);
  track.mediaStreamTrack.addEventListener("ended", ended);
  w.addEventListener("beforeunload", () => {
    track.mediaStreamTrack.removeEventListener("ended", ended);
    open.delete(key);
    onClose?.();
  });
}

async function pictureInPicture(track: Track): Promise<void> {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track.mediaStreamTrack]);
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  try {
    await video.play();
    await video.requestPictureInPicture();
    video.addEventListener("leavepictureinpicture", () => video.remove(), { once: true });
  } catch {
    video.remove();
  }
}
