import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";

import {
  app,
  avatarMxc,
  displayName,
  leaveVoice,
  openShareSettings,
  openStreamMenu,
  openUserMenu,
  screenButton,
  toggleCallChat,
  toggleCamera,
} from "../app.ts";
import { t, tn } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { voice, type VoiceMember, type VoiceStream, type VoiceVideo } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { Chat } from "./Main.tsx";
import { popOut } from "./popout.ts";
import { VideoView } from "./Stage.tsx";
import {
  IconChat,
  IconChevron,
  IconClose,
  IconEye,
  IconFullscreen,
  IconHangup,
  IconHeadset,
  IconHeadsetOff,
  IconMic,
  IconMicOff,
  IconGear,
  IconPopout,
  IconScreen,
  IconScreenOff,
  IconSpeaker,
  IconVideo,
  IconVideoOff,
  IconVolume,
  IconVolumeOff,
} from "./icons.tsx";

type Tile =
  | { kind: "member"; key: string; member: VoiceMember; video?: VoiceVideo }
  | { kind: "stream"; key: string; stream: VoiceStream; video?: VoiceVideo };

const RATIO = 16 / 9;
const GAP = 8;

/**
 * Column count that fits all tiles into the rectangle at the largest size.
 * A call has few tiles, so every column count is tried.
 */
function fitGrid(n: number, w: number, h: number): { cols: number; tw: number; th: number } {
  let best = { cols: 1, tw: 0, th: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols += 1) {
    const rows = Math.ceil(n / cols);
    const byWidth = (w - GAP * (cols - 1)) / cols;
    const byHeight = ((h - GAP * (rows - 1)) / rows) * RATIO;
    const tw = Math.floor(Math.min(byWidth, byHeight));
    if (tw > best.tw) best = { cols, tw, th: Math.floor(tw / RATIO) };
  }
  return best;
}

/** Background of a tile without video: stable per person, muted. */
function tint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 22% 26%)`;
}

function useSize<T extends HTMLElement>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Full screen for a tile, or leave it. */
function toggleFullscreen(el: Element | null | undefined): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void (el as HTMLElement | null)?.requestFullscreen().catch(() => undefined);
}

/* ------------------------------------------------------------------- tile */

function VideoTools({ video, title, children }: { video: VoiceVideo; title: string; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="tile-tools" ref={box} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {children}
      <button className="icon" title={t("share.popout")} onClick={() => popOut(video.key, video.track, title)}>
        <IconPopout />
      </button>
      <button className="icon" title={t("call.fullscreen")} onClick={() => toggleFullscreen(box.current?.closest(".ctile"))}>
        <IconFullscreen />
      </button>
    </div>
  );
}

function StreamTools({ stream, video }: { stream: VoiceStream; video: VoiceVideo }) {
  const who = displayName(stream.userId);
  return (
    <VideoTools video={video} title={t("share.windowTitle", { who })}>
      {!stream.local && stream.hasAudio && (
        <>
          <button
            className={`icon ${stream.muted ? "off" : ""}`}
            title={stream.muted ? t("share.unmuteSound") : t("share.muteSound")}
            onClick={() => voice.setStreamMuted(stream.userId, !stream.muted)}
          >
            {stream.muted ? <IconVolumeOff /> : <IconVolume />}
          </button>
          <label className="tile-volume" title={t("share.volume")}>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={stream.volume}
              disabled={stream.muted}
              onChange={(e) => voice.setStreamVolume(stream.userId, Number(e.target.value))}
            />
            <span>{stream.volume}%</span>
          </label>
        </>
      )}
      <button className="icon" title={t("share.stopWatching")} onClick={() => voice.unwatch(stream.identity)}>
        <IconClose />
      </button>
    </VideoTools>
  );
}

/** Who watches the own share: a count on the tile, names on hover. */
function Viewers({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  const names = ids.map((id) => displayName(id.split(":").slice(0, 2).join(":")));
  return (
    <span className="viewers" title={t("share.viewers", { names: names.join(", ") })}>
      <IconEye /> {ids.length}
    </span>
  );
}

function TileView({
  tile,
  style,
  focused,
  onFocus,
}: {
  tile: Tile;
  style?: CSSProperties;
  focused: boolean;
  onFocus: () => void;
}) {
  const roomId = useStore(app, (s) => s.voiceChannel);
  const box = useRef<HTMLDivElement>(null);

  if (tile.kind === "stream") {
    const { stream, video } = tile;
    const who = displayName(stream.userId, roomId);
    let body: ReactNode;
    if (video) {
      body = (
        <>
          <VideoView video={video} />
          <StreamTools stream={stream} video={video} />
        </>
      );
    } else {
      body = (
        <div className="ctile-offer">
          <Avatar mxc={avatarMxc(stream.userId, roomId)} name={who} size={56} />
          {stream.local ? (
            <div className="ctile-actions">
              <button onClick={(e) => (e.stopPropagation(), voice.watch(stream.identity))}>
                <IconEye /> {t("share.watch")}
              </button>
              <button className="ghost" onClick={(e) => (e.stopPropagation(), openShareSettings())}>
                <IconGear /> {t("share.settings")}
              </button>
            </div>
          ) : (
            <button className="primary" onClick={(e) => (e.stopPropagation(), voice.watch(stream.identity))}>
              <IconEye /> {t("share.watch")}
            </button>
          )}
        </div>
      );
    }
    return (
      <div
        ref={box}
        className={`ctile stream ${focused ? "focused" : ""}`}
        style={style}
        onClick={onFocus}
        onDoubleClick={() => video && toggleFullscreen(box.current)}
        onContextMenu={(e) => {
          e.preventDefault();
          openStreamMenu(stream.identity, e.clientX, e.clientY);
        }}
      >
        {body}
        <div className="ctile-label">
          <i className="live-dot" />
          <IconScreen />
          <span className="ellipsis">{stream.local ? t("call.yourScreen") : who}</span>
          {stream.muted && <IconVolumeOff className="flag off" />}
          {stream.local && <Viewers ids={stream.viewers} />}
        </div>
      </div>
    );
  }

  const { member, video } = tile;
  const who = member.userId ? displayName(member.userId, roomId) : member.name;
  return (
    <div
      ref={box}
      className={`ctile member ${member.speaking ? "speaking" : ""} ${focused ? "focused" : ""}`}
      style={{ ...style, background: video ? "#000" : tint(member.userId || member.id) }}
      onClick={onFocus}
      onDoubleClick={() => video && toggleFullscreen(box.current)}
      onContextMenu={(e) => {
        if (!member.userId) return;
        e.preventDefault();
        openUserMenu(member.userId, e.clientX, e.clientY, roomId);
      }}
    >
      {video ? (
        <>
          <VideoView video={video} fit="cover" />
          <VideoTools video={video} title={who} />
        </>
      ) : (
        <Avatar mxc={avatarMxc(member.userId, roomId)} name={who} size={Math.max(40, Math.min(96, ((style?.height as number) || 120) * 0.42))} />
      )}
      <div className="ctile-label">
        {member.deafened ? <IconHeadsetOff className="flag off" /> : member.muted && <IconMicOff className="flag off" />}
        {member.localMuted && <IconVolume className="flag off" />}
        <span className="ellipsis">
          {who}
          {member.local ? ` ${t("call.you")}` : ""}
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- controls */

function Controls() {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  return (
    <div className="call-controls">
      <div className="ctl-group">
        <button
          className={`ctl ${state.muted ? "off" : ""}`}
          title={state.muted ? t("call.unmute") : t("call.mute")}
          onClick={() => void voice.setMuted(!state.muted)}
        >
          {state.muted ? <IconMicOff /> : <IconMic />}
        </button>
        <button
          className={`ctl ${state.deafened ? "off" : ""}`}
          title={state.deafened ? t("call.undeafen") : t("call.deafen")}
          onClick={() => void voice.setDeafened(!state.deafened)}
        >
          {state.deafened ? <IconHeadsetOff /> : <IconHeadset />}
        </button>
      </div>

      <div className="ctl-group">
        <button
          className={`ctl ${state.camera ? "live" : ""}`}
          title={state.camera ? t("call.cameraOff") : t("call.cameraOnAction")}
          onClick={() => void toggleCamera()}
        >
          {state.camera ? <IconVideo /> : <IconVideoOff />}
        </button>
        <button className="ctl narrow" title={t("call.pickCamera")} onClick={() => app.set({ cameraPickerOpen: true })}>
          <IconChevron style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>

      <div className="ctl-group">
        <button
          className={`ctl ${state.screen ? "live" : ""}`}
          title={state.screen ? t("call.shareMenu") : t("call.shareScreen")}
          onClick={(e) => screenButton(e.currentTarget)}
        >
          {state.screen ? <IconScreen /> : <IconScreenOff />}
        </button>
      </div>

      <button className="ctl hangup" title={t("call.leave")} onClick={() => void leaveVoice()}>
        <IconHangup />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- call */

export function CallView() {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const servers = useStore(app, (s) => s.servers);
  const requested = useStore(app, (s) => s.callFocus);
  const chatOpen = useStore(app, (s) => s.callChat);
  const [focus, setFocus] = useState<string | null>(null);
  const [stageRef, size] = useSize<HTMLDivElement>();

  // a request to expand a share came from outside, from the mini player
  useEffect(() => {
    if (!requested) return;
    setFocus(requested);
    app.set({ callFocus: null });
  }, [requested]);

  // the mini player shows the tile last expanded here
  useEffect(() => {
    if (focus) app.set({ lastFocus: focus });
  }, [focus]);

  const channel = servers.flatMap((g) => g.channels).find((c) => c.roomId === voiceChannel);

  const videoOf = (identity: string, screen: boolean) =>
    state.videos.find((v) => v.identity === identity && v.screen === screen);

  const tiles: Tile[] = [
    ...state.streams.map<Tile>((s) => ({ kind: "stream", key: `s:${s.identity}`, stream: s, video: videoOf(s.identity, true) })),
    ...state.members.map<Tile>((m) => ({ kind: "member", key: `m:${m.id}`, member: m, video: videoOf(m.id, false) })),
  ];

  const focused = focus ? tiles.find((tile) => tile.key === focus) : undefined;

  // the focused tile is gone (left the call or stopped sharing)
  useEffect(() => {
    if (focus && !focused) setFocus(null);
  }, [focus, focused]);

  const toggle = (key: string) => setFocus(focus === key ? null : key);

  let stage: ReactNode;
  if (focused) {
    const rest = tiles.filter((tile) => tile.key !== focused.key);
    const stripH = rest.length ? 118 : 0;
    const big = fitGrid(1, size.w, size.h - stripH - (rest.length ? GAP : 0));
    stage = (
      <div className="call-focus">
        <div className="call-focus-main">
          <TileView tile={focused} focused style={{ width: big.tw, height: big.th }} onFocus={() => toggle(focused.key)} />
        </div>
        {rest.length > 0 && (
          <div className="call-strip">
            {rest.map((tile) => (
              <TileView key={tile.key} tile={tile} focused={false} style={{ width: 196, height: 110 }} onFocus={() => toggle(tile.key)} />
            ))}
          </div>
        )}
      </div>
    );
  } else {
    const grid = fitGrid(tiles.length, size.w, size.h);
    stage = (
      <div className="call-grid" style={{ maxWidth: grid.cols * grid.tw + (grid.cols - 1) * GAP }}>
        {tiles.map((tile) => (
          <TileView key={tile.key} tile={tile} focused={false} style={{ width: grid.tw, height: grid.th }} onFocus={() => toggle(tile.key)} />
        ))}
      </div>
    );
  }

  const unread = channel?.unread ?? 0;

  return (
    <div className={`call-wrap ${chatOpen ? "with-chat" : ""}`}>
      <section className="call">
        <header className="call-head">
          <IconSpeaker />
          <b className="ellipsis">{channel?.name ?? t("channels.kind.voice")}</b>
          <span className="state">{state.connected ? tn("call.inChannel", state.members.length) : t("dock.connecting")}</span>
          <button
            className={`ghost icon head-tool call-chat-btn ${chatOpen ? "on-soft" : ""}`}
            title={chatOpen ? t("call.chatHide") : t("call.chat")}
            onClick={() => toggleCallChat()}
          >
            <IconChat />
            {!chatOpen && unread > 0 && <span className="pip">{unread}</span>}
          </button>
        </header>
        <div className="call-stage" ref={stageRef}>
          {size.w > 0 && stage}
        </div>
        <Controls />
      </section>
      {chatOpen && (
        <div className="call-chat">
          <Chat embedded onClose={() => toggleCallChat(false)} />
        </div>
      )}
    </div>
  );
}
