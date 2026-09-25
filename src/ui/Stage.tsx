import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";

import { app, shareSource, stopShare } from "../app.ts";
import {
  getDisplays,
  getScreenSources,
  hasAppAudio,
  hasOwnScreenPicker,
  type DisplayInfo,
  type ScreenSource,
} from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { voice, type ShareCodec, type VoiceVideo } from "../voice/voice.ts";
import { IconRefresh } from "./icons.tsx";
import { useEscape, useLinger } from "./controls.tsx";

/** Any video track: attached to the element, detached on unmount. */
export function TrackView({
  track,
  fit = "contain",
  mirror = false,
}: {
  track: LocalVideoTrack | RemoteVideoTrack;
  fit?: "contain" | "cover";
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      // audio comes as separate tracks, so the video element is always muted
      muted
      className={mirror ? "mirror" : ""}
      style={{ objectFit: fit }}
    />
  );
}

/** Video of a call participant. */
export function VideoView({ video, fit = "contain" }: { video: VoiceVideo; fit?: "contain" | "cover" }) {
  return <TrackView track={video.track} fit={fit} mirror={video.local && !video.screen} />;
}

/* ------------------------------------------------- source and quality picker */

const HEIGHTS = [2160, 1440, 1080, 720, 480];
const FPS_STEPS = [240, 165, 144, 120, 60, 30];

/** Approximate upload at this quality, with the same formula as voice.ts. */
function uplink(height: number, fps: number, aspect: number): string {
  const bits = Math.max(1.5e6, Math.min(12e6, height * aspect * height * fps * 0.05));
  return t("share.mbps", { value: (bits / 1e6).toFixed(1).replace(".0", "") });
}

/**
 * Screen share dialog: what to share and at which quality. While sharing it
 * is the share settings: the window or the quality change on the fly.
 */
export function ScreenPicker() {
  const open = useStore(app, (s) => s.screenPickerOpen);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const live = state.screen && !!state.share;

  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [picked, setPicked] = useState("");
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState(true);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(60);
  const { shown, closing } = useLinger(open);
  const close = () => app.set({ screenPickerOpen: false });
  useEscape(open, close);

  const load = () => {
    if (!hasOwnScreenPicker) return;
    setLoading(true);
    void getScreenSources()
      .then(setSources)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    const s = voice.getState();
    const current = s.share?.sourceId ?? "";
    setAudio(s.share?.audio ?? s.settings.shareAudio);
    setHeight(s.settings.shareHeight);
    setFps(s.share?.fps ?? s.settings.shareFps);
    setPicked(current);
    setTab(current.startsWith("window:") ? "window" : "screen");
    load();
    void getDisplays().then(setDisplays);
  }, [open]);

  if (!shown) return null;

  const list = sources.filter((s) => s.kind === tab);
  const source = sources.find((s) => s.id === picked);

  // the monitor of the picked screen; for a window the largest one
  const biggest = [...displays].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const display = displays.find((d) => source?.displayId && d.id === source.displayId) ?? biggest;
  const nativeH = display?.height ?? 1080;
  const aspect = display ? display.width / display.height : 16 / 9;
  // a screen has its monitor's rate; a window may be on any monitor, so the fastest one
  const hz = Math.max(
    30,
    source?.kind === "screen" && display ? display.hz : Math.max(display?.hz ?? 60, ...displays.map((d) => d.hz)),
  );

  const heights = HEIGHTS.filter((h) => h < nativeH);
  const effHeight = height > 0 && height < nativeH ? height : 0;
  const fpsList = [...new Set([hz, ...FPS_STEPS.filter((f) => f < hz)])].filter((f) => f >= 30);
  const effFps = fpsList.includes(fps) ? fps : (fpsList.find((f) => f <= fps) ?? fpsList[fpsList.length - 1] ?? 30);

  const hint = !hasAppAudio ? t("share.audio.all") : tab === "screen" ? t("share.audio.screen") : t("share.audio.window");

  const apply = (id: string | null, pickNew = false) =>
    void shareSource(
      hasOwnScreenPicker ? id : null,
      {
        audio,
        height: effHeight,
        fps: effFps,
        name: sources.find((s) => s.id === id)?.name ?? state.share?.name ?? "",
      },
      pickNew,
    );

  const canStart = hasOwnScreenPicker ? !!picked : true;

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal wide share-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{live ? t("share.settings") : t("share.title")}</h2>

        {hasOwnScreenPicker ? (
          <>
            <div className="tabs">
              <button className={tab === "screen" ? "on" : "ghost"} onClick={() => setTab("screen")}>
                {t("share.tab.screens")}
              </button>
              <button className={tab === "window" ? "on" : "ghost"} onClick={() => setTab("window")}>
                {t("share.tab.windows")}
              </button>
              <button className="ghost small push-right" onClick={load}>
                <IconRefresh /> {t("common.refresh")}
              </button>
            </div>

            {loading && sources.length === 0 && <div className="state">{t("share.loading")}</div>}
            {!loading && list.length === 0 && <div className="state">{t("share.empty")}</div>}

            <div className="sources">
              {list.map((s) => (
                <button
                  key={s.id}
                  className={`source ${picked === s.id ? "picked" : ""}`}
                  title={t("share.doubleClick")}
                  onClick={() => setPicked(s.id)}
                  onDoubleClick={() => apply(s.id)}
                >
                  {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="source-blank" />}
                  <span className="ellipsis">
                    {live && s.id === state.share?.sourceId && <i className="live-dot" />}
                    {s.name}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="sub">{live ? t("share.browser.live") : t("share.browser.start")}</p>
        )}

        <div className="share-quality">
          <div className="quality-row">
            <span className="quality-label">{t("share.resolution")}</span>
            <div className="seg">
              <button className={effHeight === 0 ? "on" : ""} onClick={() => setHeight(0)}>
                {t("share.native", { h: nativeH })}
              </button>
              {heights.map((h) => (
                <button key={h} className={effHeight === h ? "on" : ""} onClick={() => setHeight(h)}>
                  {h}p
                </button>
              ))}
            </div>
          </div>
          <div className="quality-row">
            <span className="quality-label">{t("share.fps")}</span>
            <div className="seg">
              {fpsList.map((f) => (
                <button key={f} className={effFps === f ? "on" : ""} onClick={() => setFps(f)}>
                  {f}
                  {f === hz && hz > 60 ? ` · ${t("share.monitorRate")}` : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="state">
            {t("share.uplink", { rate: uplink(effHeight || nativeH, effFps, aspect) })}
            {tab === "screen" && effFps > 30 && hasOwnScreenPicker ? ` ${t("share.screenSlow")}` : ""}
          </div>
        </div>

        <div className="quality-row codec-row">
          <span className="quality-label">{t("share.codec")}</span>
          <select
            value={state.settings.shareCodec}
            onChange={(e) => void voice.applySettings({ shareCodec: e.target.value as ShareCodec })}
          >
            <option value="auto">{t("share.codec.auto")}</option>
            <option value="h264">{t("share.codec.gpu")}</option>
            <option value="vp8">{t("share.codec.cpu")}</option>
          </select>
        </div>
        <span className="state">{t("share.codec.hint")}</span>

        <label className="check share-audio">
          <input type="checkbox" checked={audio} onChange={() => setAudio(!audio)} />
          <span>
            <b>{t("share.audio")}</b>
            <span className="state">{hint}</span>
          </span>
        </label>

        <div className="row">
          {live && (
            <button className="danger push-left" onClick={() => void stopShare()}>
              {t("share.stop")}
            </button>
          )}
          {live && !hasOwnScreenPicker && (
            <button className="ghost" onClick={() => apply(null, true)}>
              {t("share.switchWindow")}
            </button>
          )}
          <button className="ghost" onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="primary" disabled={!canStart} onClick={() => apply(picked || null)}>
            {live ? t("share.apply") : t("share.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
