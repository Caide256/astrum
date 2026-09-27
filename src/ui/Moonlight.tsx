import { useEffect, useRef, useState } from "react";

import { displayName, knownPeople } from "../app.ts";
import type { MlApp } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import {
  ML_FPS,
  ML_HEIGHTS,
  addHost,
  hasMoonlight,
  hostApps,
  ml,
  pairHost,
  removeHost,
  setHostApp,
  setHostUser,
  setQuality,
  stopWatching,
  type MlHost,
} from "../moonlight.ts";
import { useIdsHidden } from "../prefs.ts";
import { useStore } from "../store.ts";
import { TrackView } from "./Stage.tsx";
import { IconClose, IconFullscreen, IconScreen, IconTrash } from "./icons.tsx";

/* ------------------------------------------------------------ settings tab */

function HostRow({ host }: { host: MlHost }) {
  const pairing = useStore(ml, (s) => s.pairing);
  const [apps, setApps] = useState<MlApp[] | null>(null);
  const people = knownPeople();
  const mine = pairing?.hostId === host.id;
  const hidden = useIdsHidden();

  useEffect(() => {
    if (host.paired && apps === null) void hostApps(host.id).then(setApps);
  }, [host.paired, host.id]);

  return (
    <div className="admin-item ml-host">
      <div className="admin-row">
        <IconScreen />
        <div className="grow ellipsis">
          <b className="ellipsis">{host.name || (hidden ? t("ml.hostHidden") : host.address)}</b>
          <div className="state ellipsis">
            <span className="sensitive">{host.address} · </span>
            {host.paired ? t("ml.paired") : t("ml.notPaired")}
          </div>
        </div>
        {!host.paired && !mine && (
          <button className="primary small" disabled={!!pairing} onClick={() => void pairHost(host.id)}>
            {t("ml.pair")}
          </button>
        )}
        <button className="ghost icon small" title={t("common.delete")} onClick={() => removeHost(host.id)}>
          <IconTrash />
        </button>
      </div>

      {mine && (
        <div className="ml-pin">
          <span className="state">{t("ml.pinHint")}</span>
          <b>{pairing?.pin}</b>
          <div className="spinner" />
        </div>
      )}

      {host.paired && (
        <div className="ml-bind">
          <div className="field">
            <label>{t("ml.whose")}</label>
            <select value={host.userId} onChange={(e) => setHostUser(host.id, e.target.value)}>
              <option value="">{t("ml.nobody")}</option>
              {host.userId && !people.some((p) => p.userId === host.userId) && <option value={host.userId}>{displayName(host.userId)}</option>}
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {hidden ? p.name : `${p.name} (${p.userId})`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t("ml.app")}</label>
            <select
              value={host.appId}
              onChange={(e) => {
                const a = apps?.find((x) => x.id === Number(e.target.value));
                if (a) setHostApp(host.id, a);
              }}
            >
              {!apps?.some((a) => a.id === host.appId) && <option value={host.appId}>{host.appTitle || "..."}</option>}
              {(apps ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export function MoonlightTab() {
  const hosts = useStore(ml, (s) => s.hosts);
  const quality = useStore(ml, (s) => s.quality);
  const busy = useStore(ml, (s) => s.busy);
  const error = useStore(ml, (s) => s.error);
  const [address, setAddress] = useState("");

  if (!hasMoonlight) return <div className="note">{t("ml.desktopOnly")}</div>;

  return (
    <>
      <p className="sub">{t("ml.intro")}</p>

      <div className="section-title">{t("ml.hosts")}</div>
      <div className="admin-list">
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
        {hosts.length === 0 && <div className="state">{t("ml.noHosts")}</div>}
      </div>
      <form
        className="with-button gap-top"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void addHost(address).then((h) => h && setAddress(""));
        }}
      >
        <input value={address} placeholder={t("ml.address")} onChange={(e) => setAddress(e.target.value)} />
        <button className="primary" disabled={!address.trim() || !!busy}>
          {busy ? t("ml.checking") : t("ml.add")}
        </button>
      </form>
      <span className="state">{t("ml.addressHint")}</span>
      {error && <div className="error gap-top">{error}</div>}

      <div className="section-title">{t("ml.quality")}</div>
      <div className="ml-quality">
        <div className="field">
          <label>{t("ml.size")}</label>
          <select value={quality.height} onChange={(e) => setQuality({ height: Number(e.target.value) })}>
            {ML_HEIGHTS.map((h) => (
              <option key={h} value={h}>
                {h}p
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t("ml.fps")}</label>
          <select value={quality.fps} onChange={(e) => setQuality({ fps: Number(e.target.value) })}>
            {ML_FPS.map((f) => (
              <option key={f} value={f}>
                {t("net.fps", { n: f })}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t("ml.codec")}</label>
          <select value={quality.codec} onChange={(e) => setQuality({ codec: e.target.value === "hevc" ? "hevc" : "h264" })}>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC (H.265)</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>{t("ml.bitrate", { n: quality.mbps })}</label>
        <input type="range" min={2} max={150} step={1} value={quality.mbps} onChange={(e) => setQuality({ mbps: Number(e.target.value) })} />
      </div>
      <span className="state">{t("ml.qualityHint")}</span>
    </>
  );
}

/* ------------------------------------------------------------------ viewer */

/** The picture of a Moonlight stream, or where the connection stands. */
export function MoonlightPicture() {
  const w = useStore(ml, (s) => s.watching);
  if (!w) return null;
  if (w.track && w.status === "live") return <TrackView track={w.track} fit="contain" />;
  return (
    <div className="ml-status">
      {w.status === "connecting" && (
        <>
          <div className="spinner" />
          <span>{w.stage ? t("ml.stage", { stage: w.stage }) : t("ml.connecting")}</span>
        </>
      )}
      {w.status === "ended" && <span>{t("ml.ended")}</span>}
      {w.status === "error" && <span className="danger-text">{t("ml.failed", { error: w.error })}</span>}
    </div>
  );
}

/**
 * Outside the call view the stream opens in its own window over the app:
 * the same picture as a share tile, with full screen and close.
 */
export function MoonlightViewer({ hidden }: { hidden: boolean }) {
  const w = useStore(ml, (s) => s.watching);
  const box = useRef<HTMLDivElement>(null);
  if (!w || hidden) return null;
  return (
    <div className="ml-viewer" ref={box}>
      <div className="ml-viewer-bar">
        <i className="live-dot" />
        <b className="ellipsis">{t("ml.title", { who: displayName(w.userId) })}</b>
        {w.status === "live" && (
          <span className="state">
            {w.width}×{w.height} · {t("net.fps", { n: w.fps })}
          </span>
        )}
        <button
          className="ghost icon small"
          title={t("call.fullscreen")}
          onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void box.current?.requestFullscreen())}
        >
          <IconFullscreen />
        </button>
        <button className="ghost icon small" title={t("ml.stop")} onClick={stopWatching}>
          <IconClose />
        </button>
      </div>
      <div className="ml-viewer-body">
        <MoonlightPicture />
      </div>
    </div>
  );
}

/** Whether a person is tied to a paired host: their menu offers the Moonlight stream. */
export function useMoonlightFor(userId: string): boolean {
  const hosts = useStore(ml, (s) => s.hosts);
  return hosts.some((h) => h.userId === userId && h.paired);
}
