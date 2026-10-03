import { useEffect, useState } from "react";

import { avatarMxc, displayName, flashNotice } from "../app.ts";
import { fmtDateTime, t, type Key } from "../i18n/index.ts";
import { ML_CODECS, ML_FPS, ML_HEIGHTS, autoKbps, forgetHost, hasMoonlight, ml, pictureFor, setQuality, type MlCodec, type MlWatch } from "../moonlight.ts";
import { setPlayerPrefs, usePlayerPrefs } from "../prefs.ts";
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
  type SunSettings,
} from "../sunshine.ts";
import { voice } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { Toggle } from "./controls.tsx";
import { IconClose, IconRefresh, IconTrash } from "./icons.tsx";

function mbps(kbps: number): string {
  return (kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1).replace(/\.0$/, "");
}

/* ------------------------------------------------------- regular streams */

function PlayerSection() {
  const player = usePlayerPrefs();
  return (
    <>
      <div className="section-title">{t("player.title")}</div>
      <Toggle checked={player.mini} onChange={(mini) => setPlayerPrefs({ mini })} title={t("player.mini")} hint={t("player.mini.hint")} />
      <Toggle
        checked={player.magnet}
        disabled={!player.mini}
        onChange={(magnet) => setPlayerPrefs({ magnet })}
        title={t("player.magnet")}
        hint={t("player.magnet.hint")}
      />
    </>
  );
}

/* ---------------------------------------------------------------- viewing */

const HEIGHT_NAMES: Record<number, string> = { 720: "720p", 1080: "1080p", 1440: "1440p", 2160: "4K" };
const CODEC_NAMES: Record<MlCodec, string> = { h264: "H.264", hevc: "HEVC (H.265)", av1: "AV1" };

/** Which codecs this computer's graphics card decodes: the others are greyed out. */
function useDecodable(): Record<MlCodec, boolean> {
  const [ok, setOk] = useState<Record<MlCodec, boolean>>({ h264: true, hevc: true, av1: true });
  useEffect(() => {
    let alive = true;
    const probe: Record<MlCodec, string> = { h264: "avc1.640033", hevc: "hvc1.1.6.L153.B0", av1: "av01.0.13M.08" };
    void Promise.all(
      ML_CODECS.map(async (c) => {
        if (c === "h264" || typeof VideoDecoder === "undefined") return [c, c === "h264"] as const;
        const r = await VideoDecoder.isConfigSupported({ codec: probe[c], hardwareAcceleration: "prefer-hardware" }).catch(() => null);
        return [c, !!r?.supported] as const;
      }),
    ).then((list) => alive && setOk(Object.fromEntries(list) as Record<MlCodec, boolean>));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

function QualitySection() {
  const q = useStore(ml, (s) => s.quality);
  const decodable = useDecodable();
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
          {ML_CODECS.map((c) => (
            <button
              key={c}
              className={q.codec === c ? "on" : ""}
              disabled={!decodable[c]}
              title={decodable[c] ? "" : t("ml.codec.noDecoder")}
              onClick={() => setQuality({ codec: c })}
            >
              {CODEC_NAMES[c]}
            </button>
          ))}
        </div>
        <span className="state">{t("ml.codec.hint")}</span>
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
                <div className="state ellipsis">{h.at ? t("ml.lastWatched", { when: fmtDateTime(h.at) }) : ""}</div>
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

/** How likely viewers get through to this computer, from the NAT in front of it. */
function NetLine() {
  const net = useStore(sun, (s) => s.net);
  const checking = useStore(sun, (s) => s.checking);
  const level = !net ? "" : net.nat === "blocked" ? "bad" : net.nat === "symmetric" && !net.upnp ? "fair" : net.nat === "unknown" ? "fair" : "good";
  const text = checking
    ? t("sun.net.checking")
    : !net
      ? t("sun.net.none")
      : net.nat === "blocked"
        ? t("sun.net.blocked")
        : net.nat === "open"
          ? t("sun.net.open")
          : net.upnp
            ? t("sun.net.upnp")
            : net.nat === "cone"
              ? t("sun.net.cone")
              : net.nat === "symmetric"
                ? t("sun.net.symmetric")
                : t("sun.net.unknown");
  return (
    <div className="sun-net">
      <div className="sun-net-line">
        <i className={`sun-net-dot ${checking ? "checking" : level}`} />
        <span className="grow">
          {text}
          {net?.v6 && !checking && <span className="state"> {t("sun.net.v6")}</span>}
        </span>
        <button className="ghost small" disabled={checking} onClick={() => void checkNet(true)}>
          <IconRefresh /> {t("sun.net.recheck")}
        </button>
      </div>
    </div>
  );
}

const ENCODER_NAMES: Record<string, Key> = {
  nvenc: "sun.encoder.nvenc",
  amdvce: "sun.encoder.amd",
  quicksync: "sun.encoder.intel",
  software: "sun.encoder.cpu",
};

function ComponentLine() {
  const status = useStore(sun, (s) => s.status);
  const busy = useStore(sun, (s) => s.busy);
  const encoder = useStore(sun, (s) => s.encoder);
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
  if (!status.installed) {
    return (
      <div className="row left">
        <span className="state grow">{t("sun.notInstalled", { size: Math.round(status.size / 1048576) })}</span>
        <button className="ghost small" disabled={!!busy} onClick={() => void installSunshine()}>
          {t("sun.download")}
        </button>
      </div>
    );
  }
  return (
    <>
      <span className="state">{t("sun.installed", { version: status.version })}</span>
      {encoder && (
        <span className={encoder === "software" ? "note warn" : "state"}>
          {encoder === "software" ? t("sun.encoder.cpuWarn") : t("sun.encoder.using", { name: t(ENCODER_NAMES[encoder] ?? "sun.encoder.auto") })}
        </span>
      )}
    </>
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
const VIEWER_COUNTS = [1, 2, 3, 4, 6, 8];

/** Monitor and sound: asked in the share dialog too. */
export function SunSourceFields() {
  const settings = useStore(sun, (s) => s.settings);
  const devices = useStore(sun, (s) => s.devices);
  const noSound = useStore(sun, (s) => s.noSound);
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
      {noSound && <div className="note warn">{t("sun.audio.failed")}</div>}
    </>
  );
}

/** For networks where a direct path is hard: UPnP, or a port forwarded by hand. */
function NetworkFields() {
  const settings = useStore(sun, (s) => s.settings);
  const [port, setPort] = useState(settings.udpPort ? String(settings.udpPort) : "");
  return (
    <details className="sun-more">
      <summary>{t("sun.more")}</summary>
      <Toggle checked={settings.upnp} onChange={(upnp) => setSunSettings({ upnp })} title={t("sun.upnp")} hint={t("sun.upnp.hint")} />
      <div className="field two">
        <div className="field">
          <label>{t("sun.udpPort")}</label>
          <input
            inputMode="numeric"
            value={port}
            placeholder={t("sun.udpPort.auto")}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 5);
              setPort(v);
              const n = Number(v);
              setSunSettings({ udpPort: n >= 1024 && n <= 65535 ? n : 0 });
            }}
          />
        </div>
        <div className="field">
          <label>{t("sun.address")}</label>
          <input
            value={settings.address}
            disabled={!settings.udpPort}
            placeholder={t("sun.address.placeholder")}
            onChange={(e) => setSunSettings({ address: e.target.value.trim() })}
          />
        </div>
      </div>
      <span className="state">{t("sun.udpPort.hint")}</span>
    </details>
  );
}

function ViewersSection() {
  const allowed = useStore(sun, (s) => s.allowed);
  return (
    <>
      <div className="section-title">{t("sun.viewers")}</div>
      <div className="admin-list">
        {allowed.map((userId) => (
          <div key={userId} className="admin-item">
            <div className="admin-row">
              <Avatar mxc={avatarMxc(userId)} name={displayName(userId)} size={28} />
              <b className="grow ellipsis">{displayName(userId)}</b>
              <button className="ghost icon small" title={t("sun.viewers.remove")} onClick={() => void removeViewer(userId)}>
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
        {allowed.length === 0 && <div className="state">{t("sun.viewers.none")}</div>}
        {allowed.length > 1 && (
          <div className="row left">
            <button className="ghost small danger-text" onClick={() => void removeViewer("*")}>
              {t("sun.viewers.removeAll")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function SunshineSettings() {
  const settings = useStore(sun, (s) => s.settings);
  const live = useStore(sun, (s) => s.live);
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
      <div className="field two">
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
          <label>{t("sun.viewersMax")}</label>
          <select value={settings.viewers} onChange={(e) => setSunSettings({ viewers: Number(e.target.value) })}>
            {VIEWER_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <span className="state">{t("sun.viewersMax.hint")}</span>
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
      <NetworkFields />
      {live && <span className="state">{t("sun.nextTime")}</span>}
      <ViewersSection />
    </>
  );
}

function SunshineSection() {
  const error = useStore(sun, (s) => s.error);
  useEffect(() => {
    void checkNet();
    void refreshStatus();
    void loadDevices();
    if (sun.get().live) void refreshClients();
  }, []);
  if (!hasSunshine) return null;
  return (
    <>
      <div className="section-title">{t("sun.title")}</div>
      <p className="sub">{t("sun.intro")}</p>
      <NetLine />
      <ComponentLine />
      <SunshineSettings />
      {error && <div className="error gap-top">{sunError(error)}</div>}
    </>
  );
}

export function sunError(code: string): string {
  if (code === "not-installed" || code === "install") return t("sun.err.install");
  if (code === "no-helper") return t("desktop.err.noHelper");
  if (code === "stopped") return t("sun.err.stopped");
  if (code === "no-display") return t("sun.err.noDisplay");
  if (code === "tunnel" || /tunnel/.test(code)) return t("sun.err.tunnel");
  if (code === "start") return t("sun.err.start", { error: "" });
  return t("sun.err.start", { error: code });
}

export function MoonlightTab() {
  return (
    <>
      <PlayerSection />
      {hasMoonlight ? (
        <>
          <p className="sub gap-top">{t("ml.intro")}</p>
          <QualitySection />
          <ConnectionsSection />
          <SunshineSection />
        </>
      ) : (
        <div className="note gap-top">{t("ml.desktopOnly")}</div>
      )}
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
          <div key={r.name} className="sun-request">
            <Avatar mxc={avatarMxc(r.userId)} name={who} size={34} />
            <div className="grow">
              <b className="ellipsis">{who}</b>
              <div className="state">{t("sun.ask")}</div>
            </div>
            <div className="sun-request-buttons">
              <button
                className="primary small"
                onClick={() => {
                  void allowViewer(r);
                  flashNotice(t("sun.allowed", { who }));
                }}
              >
                {t("sun.allow")}
              </button>
              <button className="ghost small" onClick={() => denyViewer(r)}>
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
  if (reason === "tunnel") return t("sun.watch.tunnel");
  if (reason === "off") return t("sun.watch.off", { who });
  if (reason === "timeout") return t("sun.watch.timeout", { who });
  if (reason === "denied") return t("sun.watch.denied", { who });
  if (reason === "busy") return t("sun.watch.busy", { who });
  if (reason === "punch") return t("sun.watch.punch");
  if (reason === "unreachable") return t("sun.watch.unreachable", { who });
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
          <span>{w.stage ? t("ml.stage", { stage: w.stage }) : w.path ? t("ml.connecting") : t("sun.watch.punching")}</span>
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

const PATH_NAMES: Record<string, Key> = { lan: "sun.path.lan", v6: "sun.path.v6", wan: "sun.path.wan" };

/** Picture size, rate and the path of the Sunshine stream being watched, for the tile label. */
export function useSunWatchInfo(identity: string): string {
  const w = useStore(ml, (s) => s.watching);
  if (!w || w.identity !== identity || w.status !== "live" || !w.fps) return "";
  const path = PATH_NAMES[w.path] ? ` · ${t(PATH_NAMES[w.path])}${w.rtt ? ` ${w.rtt} ${t("sun.ms")}` : ""}` : "";
  return `${w.height}p · ${t("net.fps", { n: w.fps })}${path}`;
}

/* ------------------------------------------------- share dialog, Sunshine */

/** The Sunshine side of the share dialog: the network, the monitor, the sound, and start. */
export function SunsharePane({ onStarted, onClose }: { onStarted: () => void; onClose: () => void }) {
  const state = useStore(sun, (s) => s);
  useEffect(() => {
    void checkNet();
    void refreshStatus();
  }, []);
  const starting = state.busy === "start" || state.busy === "install" || !!state.status?.starting;
  return (
    <div className="sun-pane">
      <p className="sub">{t("sun.pane.intro")}</p>
      <NetLine />
      <ComponentLine />
      <SunSourceFields />
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
          <button className="primary" disabled={starting} onClick={() => void startSunshineStream().then((ok) => ok && onStarted())}>
            {state.busy === "install" ? t("sun.pane.downloading") : starting ? t("sun.pane.starting") : t("sun.pane.start")}
          </button>
        )}
      </div>
      {starting && <span className="state">{t("sun.pane.firstStart")}</span>}
    </div>
  );
}
