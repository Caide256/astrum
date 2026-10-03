import { useEffect } from "react";

import { avatarMxc, displayName, flashNotice } from "../app.ts";
import { fmtDateTime, t, type Key } from "../i18n/index.ts";
import { ML_FPS, ML_HEIGHTS, autoKbps, forgetHost, hasMoonlight, ml, pictureFor, setQuality, type MlWatch } from "../moonlight.ts";
import { useIdsHidden } from "../prefs.ts";
import { useStore } from "../store.ts";
import {
  allowViewer,
  checkNet,
  denyViewer,
  hasSunshine,
  installSunshine,
  loadDevices,
  refreshClients,
  refreshStatus,
  removeViewer,
  setSunSettings,
  startSunshineStream,
  stopSunshineStream,
  sun,
  sunshineAllowed,
  type SunSettings,
} from "../sunshine.ts";
import { voice } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { Toggle } from "./controls.tsx";
import { IconClose, IconRefresh, IconTrash } from "./icons.tsx";

function mbps(kbps: number): string {
  return (kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1).replace(/\.0$/, "");
}

/* ---------------------------------------------------------------- viewing */

const HEIGHT_NAMES: Record<number, string> = { 720: "720p", 1080: "1080p", 1440: "1440p", 2160: "4K" };

function QualitySection() {
  const q = useStore(ml, (s) => s.quality);
  // what the bitrate comes to with a 1440p source, the usual monitor of a streamer
  const sample = pictureFor({ w: 2560, h: 1440 }, q);
  return (
    <>
      <div className="section-title">{t("ml.quality")}</div>
      <div className="field">
        <label>{t("ml.size")}</label>
        <div className="seg">
          {ML_HEIGHTS.map((h) => (
            <button key={h} className={q.height === h ? "on" : ""} onClick={() => setQuality({ height: h })}>
              {h === 0 ? t("ml.sizeSource") : HEIGHT_NAMES[h]}
            </button>
          ))}
        </div>
        <span className="state">{q.height === 0 ? t("ml.sizeSource.hint") : t("ml.size.hint")}</span>
      </div>
      <div className="field">
        <label>{t("ml.fps")}</label>
        <div className="seg">
          {ML_FPS.map((f) => (
            <button key={f} className={q.fps === f ? "on" : ""} onClick={() => setQuality({ fps: f })}>
              {t("net.fps", { n: f })}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t("ml.codec")}</label>
        <div className="seg">
          <button className={q.codec === "h264" ? "on" : ""} onClick={() => setQuality({ codec: "h264" })}>
            H.264
          </button>
          <button className={q.codec === "hevc" ? "on" : ""} onClick={() => setQuality({ codec: "hevc" })}>
            HEVC (H.265)
          </button>
        </div>
      </div>
      <div className="field">
        <label>{t("ml.bitrateAuto")}</label>
        <div className="ml-rate">
          <b>{t("ml.mbps", { n: mbps(autoKbps(sample.width, sample.height, q.fps, q.codec)) })}</b>
          <span className="state">{q.height === 0 ? t("ml.bitrateAuto.source") : t("ml.bitrateAuto.fixed", { size: HEIGHT_NAMES[q.height] ?? "" })}</span>
        </div>
        <span className="state">{t("ml.bitrateAuto.hint")}</span>
      </div>
    </>
  );
}

function ConnectionsSection() {
  const hosts = useStore(ml, (s) => s.hosts);
  const hidden = useIdsHidden();
  return (
    <>
      <div className="section-title">{t("ml.connections")}</div>
      <div className="admin-list">
        {hosts.map((h) => (
          <div key={h.key} className="admin-item">
            <div className="admin-row">
              <Avatar mxc={avatarMxc(h.userId)} name={displayName(h.userId)} size={28} />
              <div className="grow ellipsis">
                <b className="ellipsis">{displayName(h.userId)}</b>
                <div className="state ellipsis">
                  {!hidden && <span className="sensitive">{h.address} · </span>}
                  {h.at ? t("ml.lastWatched", { when: fmtDateTime(h.at) }) : ""}
                </div>
              </div>
              <button className="ghost icon small" title={t("ml.forget")} onClick={() => void forgetHost(h.key)}>
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
        {hosts.length === 0 && <div className="state">{t("ml.noConnections")}</div>}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- own Sunshine */

function NetLine() {
  const net = useStore(sun, (s) => s.net);
  const checking = useStore(sun, (s) => s.checking);
  const manual = useStore(sun, (s) => s.settings.manualWhite);
  const hidden = useIdsHidden();
  const ip = (v: string) => (hidden ? "•••" : v);
  return (
    <div className="sun-net">
      <div className={`sun-net-line ${net?.verdict ?? ""}`}>
        <i className={`sun-net-dot ${checking ? "checking" : (net?.verdict ?? "")}`} />
        <span className="grow">
          {checking
            ? t("sun.net.checking")
            : !net
              ? t("sun.net.none")
              : net.verdict === "white"
                ? t(net.upnp ? "sun.net.whiteUpnp" : "sun.net.white", { ip: ip(net.ip) })
                : net.verdict === "gray"
                  ? t("sun.net.gray")
                  : net.stunIp
                    ? t("sun.net.unknownSeen", { ip: ip(net.stunIp) })
                    : t("sun.net.unknown")}
        </span>
        <button className="ghost small" disabled={checking} onClick={() => void checkNet(true)}>
          <IconRefresh /> {t("sun.net.recheck")}
        </button>
      </div>
      {net?.verdict === "unknown" && (
        <Toggle checked={manual} onChange={(manualWhite) => setSunSettings({ manualWhite })} title={t("sun.manualWhite")} hint={t("sun.manualWhite.hint")} />
      )}
    </div>
  );
}

function ComponentLine() {
  const status = useStore(sun, (s) => s.status);
  const busy = useStore(sun, (s) => s.busy);
  if (!status) return <div className="state">{t("common.loading")}</div>;
  if (status.installing !== null) {
    return (
      <div className="sun-progress">
        <span className="state">{t("sun.downloading", { n: Math.round(status.installing * 100) })}</span>
        <div className="upload-bar">
          <i style={{ width: `${Math.round(status.installing * 100)}%` }} />
        </div>
      </div>
    );
  }
  return status.installed ? (
    <span className="state">{t("sun.installed", { version: status.version })}</span>
  ) : (
    <div className="row left">
      <span className="state grow">{t("sun.notInstalled", { size: Math.round(status.size / 1048576) })}</span>
      <button className="ghost small" disabled={!!busy} onClick={() => void installSunshine()}>
        {t("sun.download")}
      </button>
    </div>
  );
}

const ENCODERS: { id: SunSettings["encoder"]; name: Key }[] = [
  { id: "", name: "sun.encoder.auto" },
  { id: "nvenc", name: "sun.encoder.nvenc" },
  { id: "amdvce", name: "sun.encoder.amd" },
  { id: "quicksync", name: "sun.encoder.intel" },
  { id: "software", name: "sun.encoder.cpu" },
];

const CAPS = [0, 10_000, 20_000, 40_000, 80_000, 150_000];

/** Monitor and sound: asked in the share dialog too. */
export function SunSourceFields() {
  const settings = useStore(sun, (s) => s.settings);
  const devices = useStore(sun, (s) => s.devices);
  useEffect(() => {
    if (!devices) void loadDevices();
  }, [devices]);
  return (
    <>
      <div className="field">
        <label>{t("sun.display")}</label>
        <select value={settings.output} onChange={(e) => setSunSettings({ output: e.target.value })}>
          <option value="">{t("sun.display.primary")}</option>
          {(devices?.displays ?? [])
            .filter((d) => d.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.w}×{d.h} · {t("net.fps", { n: d.hz })}
              </option>
            ))}
        </select>
      </div>
      <Toggle checked={settings.audio} onChange={(audio) => setSunSettings({ audio })} title={t("sun.audio")} hint={t("sun.audio.hint")} />
      {settings.audio && (
        <div className="field">
          <label>{t("sun.audioSink")}</label>
          <select value={settings.audioSink} onChange={(e) => setSunSettings({ audioSink: e.target.value })}>
            <option value="">{t("sun.audioSink.default")}</option>
            {(devices?.audio ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

function SunshineSettings() {
  const settings = useStore(sun, (s) => s.settings);
  const live = useStore(sun, (s) => s.live);
  const clients = useStore(sun, (s) => s.clients);
  return (
    <>
      {live && (
        <div className="note row left">
          <span className="grow">{t("sun.liveNow")}</span>
          <button className="danger small" onClick={() => void stopSunshineStream()}>
            {t("share.stop")}
          </button>
        </div>
      )}
      <SunSourceFields />
      <div className="field">
        <label>{t("sun.encoder")}</label>
        <select value={settings.encoder} onChange={(e) => setSunSettings({ encoder: e.target.value as SunSettings["encoder"] })}>
          {ENCODERS.map((x) => (
            <option key={x.id} value={x.id}>
              {t(x.name)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{t("sun.cap")}</label>
        <select value={settings.maxKbps} onChange={(e) => setSunSettings({ maxKbps: Number(e.target.value) })}>
          {CAPS.map((c) => (
            <option key={c} value={c}>
              {c ? t("ml.mbps", { n: mbps(c) }) : t("sun.cap.none")}
            </option>
          ))}
        </select>
        <span className="state">{t("sun.cap.hint")}</span>
      </div>
      <div className="field">
        <label>{t("sun.address")}</label>
        <input value={settings.address} placeholder={t("sun.address.placeholder")} onChange={(e) => setSunSettings({ address: e.target.value.trim() })} />
        <span className="state">{t("sun.address.hint")}</span>
      </div>
      <Toggle checked={settings.upnp} onChange={(upnp) => setSunSettings({ upnp })} title={t("sun.upnp")} hint={t("sun.upnp.hint")} />
      <div className="field narrow">
        <label>{t("sun.port")}</label>
        <input
          type="number"
          min={1100}
          max={64000}
          value={settings.port}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (v >= 1100 && v <= 64000) setSunSettings({ port: v });
          }}
        />
      </div>
      <PortsLine />
      {live && <span className="state">{t("sun.nextTime")}</span>}

      <div className="section-title">{t("sun.viewers")}</div>
      {!live ? (
        <span className="state">{t("sun.viewers.offline")}</span>
      ) : (
        <div className="admin-list">
          {(clients ?? []).map((c) => (
            <div key={c.uuid} className="admin-item">
              <div className="admin-row">
                <b className="grow ellipsis">{c.name || c.uuid}</b>
                <button className="ghost icon small" title={t("sun.viewers.remove")} onClick={() => void removeViewer(c.uuid)}>
                  <IconTrash />
                </button>
              </div>
            </div>
          ))}
          {clients && clients.length === 0 && <div className="state">{t("sun.viewers.none")}</div>}
          {clients && clients.length > 1 && (
            <div className="row left">
              <button className="ghost small danger-text" onClick={() => void removeViewer("*")}>
                {t("sun.viewers.removeAll")}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SunshineSection() {
  const state = useStore(sun, (s) => s);
  useEffect(() => {
    void checkNet();
    void refreshStatus();
    void loadDevices();
    if (sun.get().live) void refreshClients();
  }, []);
  if (!hasSunshine) return null;
  const allowed = sunshineAllowed(state);
  return (
    <>
      <div className="section-title">{t("sun.title")}</div>
      <p className="sub">{t("sun.intro")}</p>
      <NetLine />
      {allowed ? (
        <>
          <ComponentLine />
          <SunshineSettings />
        </>
      ) : (
        state.net?.verdict === "gray" && <div className="note">{t("sun.grayNote")}</div>
      )}
      {state.error && <div className="error gap-top">{sunError(state.error)}</div>}
    </>
  );
}

export function sunError(code: string): string {
  if (code === "not-white") return t("sun.err.notWhite");
  if (code === "not-installed" || code === "install") return t("sun.err.install");
  if (code === "no-helper") return t("desktop.err.noHelper");
  if (code === "stopped") return t("sun.err.stopped");
  if (code === "no-display") return t("sun.err.noDisplay");
  if (code === "start") return t("sun.err.start", { error: "" });
  return t("sun.err.start", { error: code });
}

export function MoonlightTab() {
  if (!hasMoonlight) return <div className="note">{t("ml.desktopOnly")}</div>;
  return (
    <>
      <p className="sub">{t("ml.intro")}</p>
      <QualitySection />
      <ConnectionsSection />
      <SunshineSection />
    </>
  );
}

/* ------------------------------------------------------- streamer prompts */

/**
 * Someone wants to watch through Sunshine for the first time: the streamer
 * decides here. Once allowed, that viewer comes in without asking next time.
 */
export function SunRequests() {
  const requests = useStore(sun, (s) => s.requests);
  const unreachable = useStore(sun, (s) => s.unreachable);
  if (!requests.length && !unreachable) return null;
  return (
    <div className="sun-requests">
      {requests.map((r) => {
        const who = displayName(r.userId);
        return (
          <div key={r.id} className="sun-request">
            <Avatar mxc={avatarMxc(r.userId)} name={who} size={34} />
            <div className="grow">
              <b className="ellipsis">{who}</b>
              <div className="state">{t("sun.ask")}</div>
            </div>
            <div className="sun-request-buttons">
              <button
                className="primary small"
                onClick={() => {
                  void allowViewer(r, `${who} (${r.userId})`);
                  flashNotice(t("sun.allowed", { who }));
                }}
              >
                {t("sun.allow")}
              </button>
              <button className="ghost small" onClick={() => void denyViewer(r)}>
                {t("sun.deny")}
              </button>
            </div>
          </div>
        );
      })}
      {unreachable && (
        <div className="sun-request warn">
          <div className="grow state">{t("sun.unreachable", { who: displayName(unreachable) })}</div>
          <button className="ghost icon small" title={t("common.close")} onClick={() => sun.set({ unreachable: "" })}>
            <IconClose />
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------- viewer status */

function failText(w: MlWatch, who: string): string {
  const [reason, ...rest] = w.error.split(":");
  const detail = rest.join(":");
  if (reason === "unreachable") return t("sun.watch.unreachable", { who });
  if (reason === "denied") return t("sun.watch.denied", { who });
  if (reason === "pairing") return t("sun.watch.pairing", { error: detail || "?" });
  if (reason === "no-app") return t("sun.watch.noApp");
  if (reason === "start") return t("sun.watch.start", { error: detail || "?" });
  return t("ml.failed", { error: w.error });
}

/** Where watching a Sunshine stream stands, on its tile until the picture comes. */
export function SunWatchStatus({ identity, userId }: { identity: string; userId: string }) {
  const w = useStore(ml, (s) => s.watching);
  const who = displayName(userId);
  if (!w || w.identity !== identity) {
    return (
      <div className="ml-status">
        <span>{t("sun.watch.idle")}</span>
      </div>
    );
  }
  const retry = () => {
    voice.unwatch(identity);
    voice.watch(identity);
  };
  return (
    <div className="ml-status">
      {(w.status === "connecting" || (w.status === "live" && !w.fps)) && (
        <>
          <div className="spinner" />
          <span>{w.stage ? t("ml.stage", { stage: w.stage }) : t("ml.connecting")}</span>
        </>
      )}
      {w.status === "approval" && (
        <>
          <div className="spinner" />
          <span>{t("sun.watch.approval", { who })}</span>
        </>
      )}
      {w.status === "ended" && (
        <>
          <span>{t("ml.ended")}</span>
          <button className="ghost small" onClick={retry}>
            {t("sun.watch.again")}
          </button>
        </>
      )}
      {w.status === "error" && (
        <>
          <span className="danger-text">{failText(w, who)}</span>
          <button className="ghost small" onClick={retry}>
            {t("sun.watch.again")}
          </button>
        </>
      )}
    </div>
  );
}

/** Picture size and rate of the Sunshine stream being watched, for the tile label. */
export function useSunWatchInfo(identity: string): string {
  const w = useStore(ml, (s) => s.watching);
  if (!w || w.identity !== identity || w.status !== "live" || !w.fps) return "";
  return `${w.height}p · ${t("net.fps", { n: w.fps })}`;
}

/* ------------------------------------------------- share dialog, Sunshine */

/** Ports to forward on the router when UPnP is off or missing. */
function PortsLine() {
  const p = useStore(sun, (s) => s.settings.port);
  return <span className="state">{t("sun.ports", { tcp: `${p - 5}, ${p}, ${p + 21}`, udp: `${p + 9}-${p + 11}` })}</span>;
}

/** The Sunshine side of the share dialog: checks, the monitor, the sound, and start. */
export function SunsharePane({ onStarted, onClose }: { onStarted: () => void; onClose: () => void }) {
  const state = useStore(sun, (s) => s);
  useEffect(() => {
    void checkNet();
    void refreshStatus();
  }, []);
  const allowed = sunshineAllowed(state);
  const starting = state.busy === "start" || state.busy === "install" || !!state.status?.starting;
  return (
    <div className="sun-pane">
      <p className="sub">{t("sun.pane.intro")}</p>
      <NetLine />
      {allowed && (
        <>
          {!state.net?.upnp && <PortsLine />}
          <ComponentLine />
          <SunSourceFields />
        </>
      )}
      {state.error && <div className="error">{sunError(state.error)}</div>}
      <div className="row">
        <button className="ghost" onClick={onClose}>
          {t("common.close")}
        </button>
        {state.live ? (
          <button className="danger" onClick={() => void stopSunshineStream()}>
            {t("share.stop")}
          </button>
        ) : (
          <button className="primary" disabled={!allowed || starting} onClick={() => void startSunshineStream().then((ok) => ok && onStarted())}>
            {state.busy === "install" ? t("sun.pane.downloading") : starting ? t("sun.pane.starting") : t("sun.pane.start")}
          </button>
        )}
      </div>
      {starting && <span className="state">{t("sun.pane.firstStart")}</span>}
    </div>
  );
}
