import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { app, pickCamera } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { voice, type DeviceInfo } from "../voice/voice.ts";
import { useEscape, useLinger } from "./controls.tsx";

/** Live preview of one camera: it is obvious which one looks at you. */
function Preview({ cam, current, onPick }: { cam: DeviceInfo; current: boolean; onPick: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    void navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: cam.id }, width: 320, height: 180 } })
      .then((s) => {
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch((e) => alive && setFailed(/NotReadable|in use/i.test(String(e)) ? t("camera.busy") : t("camera.failed")));
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [cam.id]);

  return (
    <button className={`cam-preview ${current ? "current" : ""}`} onClick={onPick}>
      <div className="cam-frame">
        {failed ? <span className="state">{failed}</span> : <video ref={ref} autoPlay playsInline muted className="mirror" />}
      </div>
      <span className="ellipsis">{cam.label}</span>
    </button>
  );
}

export function CameraPicker() {
  const open = useStore(app, (s) => s.cameraPickerOpen);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const { shown, closing } = useLinger(open);
  const close = () => app.set({ cameraPickerOpen: false });
  useEscape(open, close);

  useEffect(() => {
    if (open) void voice.refreshDevices();
  }, [open]);

  if (!shown) return null;
  const cams = state.devices.cams;

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t("camera.title")}</h2>
        {cams.length === 0 && <div className="state">{t("camera.none")}</div>}
        <div className="cams">
          {cams.map((c) => (
            <Preview
              key={c.id}
              cam={c}
              current={c.id === state.settings.camId}
              onPick={() => void pickCamera(c.id)}
            />
          ))}
        </div>
        <div className="row">
          {state.camera && (
            <button className="ghost" onClick={() => (close(), void voice.setCamera(false))}>
              {t("call.cameraOff")}
            </button>
          )}
          <button className="ghost" onClick={close}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
