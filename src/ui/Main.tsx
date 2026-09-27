import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type UIEvent,
} from "react";

import {
  acceptInvite,
  access,
  addChannel,
  addServer,
  app,
  askNotifyPermission,
  avatarMxc,
  channelMembers,
  closeMenus,
  closePlaceMenu,
  closeSearch,
  closeUserMenu,
  closeImageMenu,
  copyImage,
  declineInvite,
  deleteMessage,
  discard,
  displayName,
  jumpTo,
  leaveInfo,
  leaveServer,
  leaveVoice,
  loadMore,
  markRoomRead,
  markServerRead,
  me,
  mediaUrl,
  mentionResolver,
  newServer,
  openChat,
  openDirectWith,
  openImage,
  openImageMenu,
  openPlaceMenu,
  openProfile,
  openServerSettings,
  openUserMenu,
  presenceOf,
  presenceWorks,
  previewServer,
  removePreview,
  resend,
  roomMuted,
  safeFileName,
  saveImage,
  runSearch,
  screenButton,
  searchPeople,
  searchPeopleNow,
  selectChannel,
  selectServer,
  setChatAtBottom,
  setStatusMode,
  startQuote,
  togglePin,
  canPinHere,
  pinnedMessages,
  showCall,
  showDirects,
  startEdit,
  suggestServerAddress,
  startReply,
  toggleCamera,
  toggleCheck,
  toggleMembers,
  toggleReaction,
  type LinkPreview,
  type PinnedItem,
  type Media,
  type Message,
} from "../app.ts";
import { fmtDateTime, fmtTime, t, tn } from "../i18n/index.ts";
import { encryptedMediaUrl } from "../media.ts";
import type { UserHit } from "../matrix/people.ts";
import { hasOwnOrder, idsHidden, isMuted, setChannelOrder, setMuted, useChannelOrders, useMutes, usePrivacy } from "../prefs.ts";
import type { Channel, Server } from "../matrix/servers.ts";
import { useStore } from "../store.ts";
import { voice, type NetSample, type NetStats, type VoiceMember } from "../voice/voice.ts";
import { Avatar, initials } from "./Avatar.tsx";
import { CallView } from "./CallView.tsx";
import { CameraPicker } from "./CameraPicker.tsx";
import { Composer, attachFiles, humanSize } from "./Composer.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { Guard } from "./Guard.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { InlineMarkdown, Markdown } from "./Markdown.tsx";
import { ScreenMenu, StreamMenu, StreamPeek, peekEnter, peekLeave } from "./Menus.tsx";
import { MiniStream } from "./MiniStream.tsx";
import { MoonlightViewer } from "./Moonlight.tsx";
import { SoundboardButton } from "./Soundboard.tsx";
import { ProfileCard, UserMenu } from "./Profile.tsx";
import { ServerSettings } from "./ServerSettings.tsx";
import { Settings } from "./Settings.tsx";
import { ScreenPicker } from "./Stage.tsx";
import { VerifyModal } from "./VerifyModal.tsx";
import {
  IconBell,
  IconBellOff,
  IconChat,
  IconCheck,
  IconChevron,
  IconClip,
  IconClose,
  IconCopy,
  IconDoorOut,
  IconDownload,
  IconEdit,
  IconExpand,
  IconEye,
  IconGear,
  IconHangup,
  IconHash,
  IconHeadset,
  IconHeadsetOff,
  IconHome,
  IconLock,
  IconMarkRead,
  IconMic,
  IconMicOff,
  IconPin,
  IconPlay,
  IconPlus,
  IconQuote,
  IconRefresh,
  IconReply,
  IconScreen,
  IconScreenOff,
  IconSearch,
  IconSignal,
  IconSmile,
  IconSpeaker,
  IconTrash,
  IconUser,
  IconUsers,
  IconVideo,
  IconVideoOff,
  IconVolume,
} from "./icons.tsx";

/** Right click on a person opens the user menu. */
function menuHandler(userId: string, roomId: string | null = null, voiceCtx = false) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openUserMenu(userId, e.clientX, e.clientY, roomId, voiceCtx);
  };
}

/** Live call data for a room: who is muted, who has a camera. Null outside the call. */
function useCallFlags(roomId: string | null): Map<string, VoiceMember> | null {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const active = useStore(app, (s) => s.voiceChannel);
  if (!roomId || active !== roomId) return null;
  return new Map(state.members.map((m) => [m.userId, m]));
}

/* ------------------------------------------------------------- person row */

function PersonRow({
  userId,
  roomId,
  flags,
  size = 20,
}: {
  userId: string;
  roomId: string | null;
  flags: VoiceMember | undefined;
  size?: number;
}) {
  const live = !!flags?.screen;
  return (
    <div
      className={`occupant clickable ${flags?.speaking ? "speaking" : ""}`}
      title={live || idsHidden() ? undefined : userId}
      onClick={() => openProfile(userId, true)}
      onContextMenu={menuHandler(userId, roomId, true)}
      // hovering someone who shares the screen shows a preview with a watch button
      onMouseEnter={(e) => {
        if (live && flags) peekEnter(flags.id, userId, e.currentTarget);
      }}
      onMouseLeave={() => {
        if (live) peekLeave();
      }}
    >
      <Avatar
        mxc={avatarMxc(userId, roomId)}
        name={displayName(userId, roomId)}
        size={size}
        className={flags?.speaking ? "talking" : ""}
      />
      <span className="ellipsis">{displayName(userId, roomId)}</span>
      {flags?.localMuted && <IconVolume className="flag off" />}
      {flags?.deafened ? (
        <IconHeadsetOff className="flag off" />
      ) : (
        flags?.muted && <IconMicOff className="flag off" />
      )}
      {(flags?.camera || flags?.screen) && (
        <span className="live-dots">
          {flags.camera && <i className="cam-dot" title={t("call.cameraOn")} />}
          {flags.screen && <i className="live-dot" title={t("call.sharing")} />}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- server bar */

function ServerBar() {
  const servers = useStore(app, (s) => s.servers);
  const active = useStore(app, (s) => s.activeServer);
  const view = useStore(app, (s) => s.view);
  const directs = useStore(app, (s) => s.directs);
  const invites = useStore(app, (s) => s.invites);
  useMutes();

  const unread = directs.filter((d) => !isMuted("users", d.userId)).reduce((sum, d) => sum + d.unread, 0) + invites.length;

  return (
    <nav className="servers">
      <button className={`server-btn home ${view === "direct" ? "active" : ""}`} title={t("dm.title")} onClick={showDirects}>
        <IconHome size={20} />
        {unread > 0 && <span className="pip">{unread}</span>}
      </button>
      <div className="server-sep" />

      {servers.map((g: Server) => {
        const on = view === "server" && g.spaceId === active;
        const muted = isMuted("servers", g.spaceId);
        const mentions = g.channels.reduce((n, c) => n + c.mentions, 0);
        const fresh = !muted && g.channels.some((c) => c.unread > 0 && !roomMuted(c.roomId));
        return (
          // the pill on the left: short for unread, taller on hover, long for the open server
          <div key={g.spaceId} className={`server-item ${on ? "active" : ""} ${fresh ? "unread" : ""} ${muted ? "muted" : ""}`}>
            <span className="server-pill" />
            <button
              className={`server-btn ${on ? "active" : ""}`}
              title={g.name}
              onClick={() => selectServer(g.spaceId)}
              onContextMenu={(e) => {
                e.preventDefault();
                openPlaceMenu("server", g.spaceId, e.clientX, e.clientY);
              }}
            >
              <Avatar mxc={g.avatar} name={g.name} size={46} />
            </button>
            {mentions > 0 && <span className="pip">{mentions}</span>}
          </div>
        );
      })}

      <div className="server-sep" />
      <button
        className="server-btn"
        title={t("server.add")}
        onClick={() => app.set({ addServerOpen: true, serverCard: null, error: "" })}
      >
        <IconPlus size={20} />
      </button>
    </nav>
  );
}

/* --------------------------------------------------------- direct messages */

/**
 * People search in direct messages: own chats and people sharing a room
 * first (instant, local), then the homeserver directory. A full @name:server
 * address is always offered.
 */
function PeopleSearch({ term, onDone }: { term: string; onDone: () => void }) {
  const directs = useStore(app, (s) => s.directs);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const [remote, setRemote] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setRemote([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchPeople(q).then((hits) => {
        if (!alive) return;
        setRemote(hits);
        setSearching(false);
      });
    }, 280);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [term]);

  const q = term.trim().toLowerCase();
  const chats = directs.filter((d) => `${d.name} ${d.userId}`.toLowerCase().includes(q));
  const withChat = new Set(chats.map((d) => d.userId));
  const seen = new Set<string>();
  // a full address is offered right away: it can always be messaged
  const typed = term.trim();
  const direct: UserHit[] = /^@[^:\s]+:\S+$/.test(typed) ? [{ userId: typed, name: typed, avatar: "", shared: false }] : [];
  const found = [...searchPeopleNow(term), ...remote, ...direct].filter((u) => {
    if (withChat.has(u.userId) || seen.has(u.userId)) return false;
    seen.add(u.userId);
    return true;
  });

  return (
    <div className="search-results">
      {chats.length > 0 && <div className="group-title">{t("dm.conversations")}</div>}
      {chats.map((d) => (
        <button
          key={d.roomId}
          className={`channel direct ${d.roomId === activeChannel ? "active" : ""}`}
          onClick={() => {
            onDone();
            void openChat(d.roomId);
          }}
        >
          <Avatar mxc={d.avatar} name={d.name} size={24} status={presenceOf(d.userId)} />
          <span className="ellipsis">{d.name}</span>
        </button>
      ))}

      <div className="group-title">{t("dm.people")}</div>
      {found.map((u) => (
        <button
          key={u.userId}
          className="channel direct person-hit"
          title={idsHidden() ? undefined : u.userId}
          onClick={() => {
            onDone();
            void openDirectWith(u.userId);
          }}
        >
          <Avatar mxc={u.avatar} name={u.name} size={24} />
          <span className="grow ellipsis">
            <span className="ellipsis">{u.name}</span>
            <span className="hit-id ellipsis sensitive">{u.userId}</span>
          </span>
          <IconChat className="hit-go" />
        </button>
      ))}
      {!found.length && (
        <div className="state pad">{searching ? t("dm.searching") : q.length < 2 ? t("dm.typeMore") : t("dm.nobody")}</div>
      )}
      {found.length > 0 && searching && <div className="state pad">{t("dm.searchingMore")}</div>}
    </div>
  );
}

function DirectList() {
  useMutes();
  const directs = useStore(app, (s) => s.directs);
  const invites = useStore(app, (s) => s.invites);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const [term, setTerm] = useState("");

  return (
    <div className="channel-scroll">
      <div className="people-search">
        <IconSearch />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && term) {
              e.preventDefault();
              setTerm("");
            }
          }}
          placeholder={t("dm.search")}
        />
        {term && (
          <button className="ghost icon tiny" title={t("common.clear")} onClick={() => setTerm("")}>
            <IconClose />
          </button>
        )}
      </div>

      {term ? (
        <PeopleSearch term={term} onDone={() => setTerm("")} />
      ) : (
        <>
          {invites.length > 0 && (
            <>
              <div className="group-title">{t("dm.invites")}</div>
              {invites.map((inv) => (
                <div key={inv.roomId} className="invite">
                  <Avatar mxc={inv.avatar} name={inv.name} size={26} />
                  <div className="grow">
                    <div className="ellipsis">{inv.name}</div>
                    <div className="state ellipsis">
                      {inv.direct ? t("dm.invite.direct") : inv.space ? t("dm.invite.server") : t("dm.invite.channel")}
                    </div>
                  </div>
                  <button className="invite-accept" title={t("common.accept")} onClick={() => void acceptInvite(inv)}>
                    <IconCheck size={14} /> {t("common.accept")}
                  </button>
                  <button className="ghost icon" title={t("common.decline")} onClick={() => void declineInvite(inv)}>
                    <IconClose />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="group-title">{t("dm.title")}</div>
          {directs.length === 0 && <div className="state pad">{t("dm.empty")}</div>}
          {directs.map((d) => (
            <div key={d.roomId} className="channel-row direct-row">
              <button
                className={`channel direct ${d.roomId === activeChannel ? "active" : ""} ${isMuted("users", d.userId) ? "muted" : ""}`}
                onClick={() => void openChat(d.roomId)}
                // the right click menu holds deleting the chat: a cross on the row was too easy to hit
                onContextMenu={menuHandler(d.userId, d.roomId)}
              >
                <Avatar mxc={d.avatar} name={d.name} size={24} status={presenceOf(d.userId)} />
                <span className="ellipsis">{d.name}</span>
                {isMuted("users", d.userId) && <IconBellOff className="mute-mark" />}
                {d.unread > 0 && <span className="count">{d.unread}</span>}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ channel list */

/** A server's channels in the own order, if the user arranged them; new channels go last. */
function arrangeChannels(list: Channel[], own: string[] | undefined): Channel[] {
  if (!own) return list;
  const rank = new Map(own.map((id, i) => [id, i]));
  return list
    .map((c, i) => ({ c, r: rank.get(c.roomId) ?? own.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

/** Move a channel in the own order: before or after another channel of the same kind. */
function moveChannel(server: Server, own: string[] | undefined, id: string, target: string, after: boolean): void {
  const texts = arrangeChannels(server.channels.filter((c) => c.kind === "text"), own).map((c) => c.roomId);
  const voices = arrangeChannels(server.channels.filter((c) => c.kind === "voice"), own).map((c) => c.roomId);
  const list = texts.includes(id) ? texts : voices;
  if (!list.includes(target) || id === target) return;
  list.splice(list.indexOf(id), 1);
  list.splice(list.indexOf(target) + (after ? 1 : 0), 0, id);
  setChannelOrder(server.spaceId, [...texts, ...voices]);
}

const CHANNELS_W_KEY = "app.channels-w";
const CHANNELS_W = { min: 180, max: 420, base: 240 };

function loadChannelsWidth(): number {
  try {
    const v = Number(localStorage.getItem(CHANNELS_W_KEY));
    return Number.isFinite(v) && v >= CHANNELS_W.min && v <= CHANNELS_W.max ? v : CHANNELS_W.base;
  } catch {
    return CHANNELS_W.base;
  }
}

function applyChannelsWidth(w: number): void {
  document.documentElement.style.setProperty("--channels-w", `${Math.round(w)}px`);
}
applyChannelsWidth(loadChannelsWidth());

/** The edge between the channel column and the chat: dragged to make the column wider or narrower. */
function ColumnGrip() {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  const save = (w: number) => {
    try {
      localStorage.setItem(CHANNELS_W_KEY, String(Math.round(w)));
    } catch {
      // kept until restart
    }
  };
  return (
    <div
      className={`column-grip ${active ? "on" : ""}`}
      title={t("channels.resize")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: loadChannelsWidth() };
        setActive(true);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const w = Math.max(CHANNELS_W.min, Math.min(CHANNELS_W.max, s.w + e.clientX - s.x));
        applyChannelsWidth(w);
        save(w);
      }}
      onPointerUp={() => {
        start.current = null;
        setActive(false);
      }}
      onDoubleClick={() => {
        applyChannelsWidth(CHANNELS_W.base);
        save(CHANNELS_W.base);
      }}
    />
  );
}

function ChannelList() {
  const view = useStore(app, (s) => s.view);
  const servers = useStore(app, (s) => s.servers);
  const loose = useStore(app, (s) => s.loose);
  const activeServer = useStore(app, (s) => s.activeServer);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const occupants = useStore(app, (s) => s.occupants);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const flags = useCallFlags(voiceChannel);
  useMutes();

  const tick = useStore(app, (s) => s.tick);
  const orders = useChannelOrders();
  const server = servers.find((g) => g.spaceId === activeServer);
  const own = server ? orders[server.spaceId] : undefined;
  const textChannels = server ? arrangeChannels(server.channels.filter((c) => c.kind === "text"), own) : loose;
  const voiceChannels = server ? arrangeChannels(server.channels.filter((c) => c.kind === "voice"), own) : [];

  // Dragging a channel with the mouse, for everyone: the order is personal.
  // Pointer events instead of HTML drag and drop, which a button inside the
  // row and the window frame both could swallow.
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOverState] = useState<{ id: string; after: boolean } | null>(null);
  const overRef = useRef<{ id: string; after: boolean } | null>(null);
  const press = useRef<{ id: string; kind: string; x: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const setOver = (next: { id: string; after: boolean } | null) => {
    const cur = overRef.current;
    if (cur?.id === next?.id && cur?.after === next?.after) return;
    overRef.current = next;
    setOverState(next);
  };
  const latest = useRef({ server, own });
  latest.current = { server, own };

  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.moved) {
        if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 6) return;
        p.moved = true;
        setDrag(p.id);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".channel-item[data-id]");
      if (!el || el.dataset.kind !== p.kind || el.dataset.id === p.id) {
        setOver(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setOver({ id: el.dataset.id ?? "", after: e.clientY > r.top + Math.min(r.height, 34) / 2 });
    };
    const up = () => {
      const p = press.current;
      press.current = null;
      if (!p?.moved) return;
      // the click that ends a drag must not open the channel
      swallowClick.current = true;
      window.setTimeout(() => (swallowClick.current = false), 0);
      const target = overRef.current;
      const { server: srv, own: order } = latest.current;
      if (srv && target) moveChannel(srv, order, p.id, target.id, target.after);
      setDrag(null);
      setOver(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const can = access(server?.spaceId ?? null);
  void tick;

  // in the own call the connected people are known exactly; the room state may lag or hold ghosts
  const occupantsOf = (roomId: string): string[] => {
    const listed = occupants[roomId] ?? [];
    if (roomId !== voiceChannel || !flags) return listed;
    const live = [...flags.keys()].filter(Boolean);
    return [...new Set([...live, ...listed.filter((u) => flags.has(u))])];
  };
  const editChannel = (roomId: string) => {
    openServerSettings("channels");
    app.set({ channelEdit: roomId });
  };

  const [creating, setCreating] = useState<"text" | "voice" | null>(null);
  const [name, setName] = useState("");

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (creating && name.trim()) void addChannel(name, creating);
    setName("");
    setCreating(null);
  };

  const row = (c: Channel) => {
    const muted = roomMuted(c.roomId);
    // unread: bold and a pill on the edge, as in Discord; only mentions get a number
    const fresh = c.unread > 0 && c.roomId !== activeChannel && !muted;
    const dropMark = over?.id === c.roomId && drag && drag !== c.roomId ? (over.after ? "drop-after" : "drop-before") : "";
    return (
      <div
        key={c.roomId}
        data-id={c.roomId}
        data-kind={c.kind}
        className={`channel-item ${drag === c.roomId ? "dragging" : ""} ${dropMark}`}
        onPointerDown={(e) => {
          if (!server || e.button !== 0 || (e.target as Element).closest(".occupants, button.tiny")) return;
          press.current = { id: c.roomId, kind: c.kind, x: e.clientX, y: e.clientY, moved: false };
        }}
        onClickCapture={(e) => {
          if (!swallowClick.current) return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {fresh && <span className="unread-pill" />}
        <div className={`channel-row ${c.roomId === activeChannel ? "active" : ""}`}>
          <button
            className={`channel ${c.roomId === activeChannel ? "active" : ""} ${c.roomId === voiceChannel ? "live" : ""} ${muted ? "muted" : ""} ${fresh ? "fresh" : ""}`}
            onClick={() => void selectChannel(c)}
            onContextMenu={(e) => {
              e.preventDefault();
              openPlaceMenu("room", c.roomId, e.clientX, e.clientY);
            }}
          >
            <span className="sigil">{c.kind === "voice" ? <IconSpeaker /> : <IconHash />}</span>
            <span className="ellipsis">{c.name}</span>
            {(c.hidden || c.voiceLocked) && (
              <span className="lock-mark" title={c.voiceLocked ? t("access.voiceLocked") : t("access.hiddenMark")}>
                <IconLock size={11} />
              </span>
            )}
            {muted && <IconBellOff className="mute-mark" />}
            {c.mentions > 0 && <span className="count">{c.mentions}</span>}
          </button>
          {c.kind === "voice" && (
            <button className="ghost icon tiny" title={t("channels.openChat")} onClick={() => void openChat(c.roomId, c.joined)}>
              <IconChat />
            </button>
          )}
          {can.channels && (
            <button className="ghost icon tiny" title={t("channels.edit")} onClick={() => editChannel(c.roomId)}>
              <IconGear />
            </button>
          )}
        </div>
        {c.kind === "voice" && (occupantsOf(c.roomId).length ?? 0) > 0 && (
          <div className="occupants">
            {occupantsOf(c.roomId).map((u) => (
              <PersonRow key={u} userId={u} roomId={c.roomId} flags={c.roomId === voiceChannel ? flags?.get(u) : undefined} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const addButton = (kind: "text" | "voice") =>
    creating === kind ? (
      <form onSubmit={create} className="create-channel">
        <span className="sigil">{kind === "voice" ? <IconSpeaker /> : <IconHash />}</span>
        <input
          autoFocus
          value={name}
          placeholder={kind === "voice" ? t("channels.voiceName") : t("channels.textName")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setCreating(null);
            }
          }}
          onBlur={() => setCreating(null)}
        />
      </form>
    ) : (
      <button className="channel" onClick={() => (setName(""), setCreating(kind))}>
        <span className="sigil">
          <IconPlus />
        </span>
        <span>{t("channels.create")}</span>
      </button>
    );

  return (
    <section className={`channels ${drag ? "reordering" : ""}`}>
      <div className="server-head">
        {view === "server" && server ? (
          <button className="server-name" title={t("server.settings")} onClick={() => openServerSettings()}>
            <span className="ellipsis">{server.name}</span>
            <IconChevron />
          </button>
        ) : (
          <span className="ellipsis">{view === "direct" ? t("dm.title") : t("channels.noServer")}</span>
        )}
      </div>

      {view === "direct" ? (
        <DirectList />
      ) : (
        <div className="channel-scroll" key={activeServer ?? "loose"}>
          <div className="group-title">{t("channels.text")}</div>
          {textChannels.map(row)}
          {server && can.channels && addButton("text")}

          {server && (
            <>
              <div className="group-title">{t("channels.voice")}</div>
              {voiceChannels.map(row)}
              {can.channels && addButton("voice")}
            </>
          )}
        </div>
      )}

      <VoiceDock />
      <ColumnGrip />
    </section>
  );
}

/* --------------------------------------------------------------- voice dock */

function VoiceDock() {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const servers = useStore(app, (s) => s.servers);
  const myName = useStore(app, (s) => s.myName);
  const myAvatar = useStore(app, (s) => s.myAvatar);
  const myPresence = useStore(app, (s) => s.myPresence);
  const priv = usePrivacy();

  const channelName = servers.flatMap((g) => g.channels).find((c) => c.roomId === voiceChannel)?.name;
  const ptt = state.settings.inputMode === "ptt";
  const [netOpen, setNetOpen] = useState(false);
  const hint = voiceChannel ? state.hint : "";

  return (
    <div className="dock">
      {voiceChannel && (
        <>
          <button className="dock-status" title={t("net.open")} onClick={() => setNetOpen(!netOpen)}>
            <IconSignal />
            <span className="state ellipsis">
              {state.connected ? <b>{t("dock.connected")}</b> : t("dock.connecting")}
              {channelName ? ` · ${channelName}` : ""}
            </span>
          </button>
          {netOpen && state.connected && <NetPanel onClose={() => setNetOpen(false)} />}

          <div className="dock-members">
            {state.members.map((m) => (
              <PersonRow key={m.id} userId={m.userId || m.id} roomId={voiceChannel} flags={m} size={18} />
            ))}
          </div>

          <div className="dock-buttons">
            <button
              className={`icon ${state.camera ? "live" : ""}`}
              title={state.camera ? t("call.cameraOff") : t("call.cameraOnAction")}
              onClick={() => void toggleCamera()}
            >
              {state.camera ? <IconVideo /> : <IconVideoOff />}
            </button>
            <button
              className={`icon ${state.screen ? "live" : ""}`}
              title={state.screen ? t("call.shareMenu") : t("call.shareScreen")}
              onClick={(e) => screenButton(e.currentTarget)}
            >
              {state.screen ? <IconScreen /> : <IconScreenOff />}
            </button>
            <SoundboardButton className="icon" />
            <button className="icon hangup" title={t("call.leave")} onClick={() => void leaveVoice()}>
              <IconHangup />
            </button>
          </div>
        </>
      )}

      <div className="me-bar">
        {hint && (
          <div className={`dock-notice ${hint}`} key={hint} role="alert">
            <span className="dock-notice-icon">{hint === "muted-talk" ? <IconMicOff /> : <IconMic />}</span>
            <span className="dock-notice-text">{hint === "muted-talk" ? t("hint.mutedTalk") : t("hint.micSilent")}</span>
            <button className="dock-notice-close" title={t("hint.dismiss")} onClick={() => voice.dismissHint()}>
              <IconClose />
            </button>
            {hint === "muted-talk" ? (
              <button className="dock-notice-act" onClick={() => void voice.setMuted(false)}>
                {t("hint.unmute")}
              </button>
            ) : (
              <button className="dock-notice-act" onClick={() => app.set({ settingsOpen: true, settingsTab: "audio" })}>
                {t("hint.check")}
              </button>
            )}
          </div>
        )}
        <Avatar
          mxc={myAvatar}
          name={myName || "?"}
          size={30}
          status={myPresence}
          className={`clickable ${state.members[0]?.speaking ? "talking" : ""}`}
          onClick={() => openProfile(me())}
        />
        <span className="me-name ellipsis clickable" onClick={() => openProfile(me())}>
          {myName}
          {ptt && !state.muted && <small>{t("dock.ptt")}</small>}
        </span>
        {priv.streamer && (
          <button className="streamer-chip" title={t("streamer.off")} onClick={() => setStatusMode("auto")}>
            {t("streamer.chip")}
          </button>
        )}

        <button
          className={`icon ${state.muted ? "on" : ""} ${hint === "muted-talk" ? "attention" : ""}`}
          title={state.muted ? t("call.unmute") : t("call.mute")}
          onClick={() => void voice.setMuted(!state.muted)}
        >
          {state.muted ? <IconMicOff /> : <IconMic />}
        </button>
        <button
          className={`icon ${state.deafened ? "on" : ""}`}
          title={state.deafened ? t("call.undeafen") : t("call.deafen")}
          onClick={() => void voice.setDeafened(!state.deafened)}
        >
          {state.deafened ? <IconHeadsetOff /> : <IconHeadset />}
        </button>
        <button className="icon" title={t("settings.title")} onClick={() => app.set({ settingsOpen: true })}>
          <IconGear />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- connection panel */

/** A line chart of the last minutes: time goes right, zero is at the bottom. */
function Chart({ samples, pick, floor, unit, danger }: { samples: NetSample[]; pick: (s: NetSample) => number; floor: number; unit: string; danger: number }) {
  const W = 260;
  const H = 76;
  const values = samples.map(pick);
  const top = Math.max(floor, ...values) * 1.15;
  const x = (i: number) => (samples.length < 2 ? W : (i / (samples.length - 1)) * W);
  const y = (v: number) => H - (v / top) * H;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const warn = values.some((v) => v >= danger);
  return (
    <div className="net-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((k) => (
          <line key={k} x1={0} x2={W} y1={H * k} y2={H * k} className="net-grid" />
        ))}
        {values.length > 0 && <polyline points={`0,${H} ${points} ${W},${H}`} className={`net-area ${warn ? "warn" : ""}`} />}
        {values.length > 0 && <polyline points={points} className={`net-line ${warn ? "warn" : ""}`} />}
      </svg>
      <div className="net-scale">
        <span>{Math.round(top)}</span>
        <span>{Math.round(top / 2)}</span>
        <span>0 {unit}</span>
      </div>
    </div>
  );
}

function codecLine(c: { codec: string; engine: string; gpu: boolean; width: number; height: number; fps: number } | null): string {
  if (!c) return "";
  const where = c.gpu ? t("net.gpu") : t("net.cpu");
  const size = c.width && c.height ? ` · ${c.width}×${c.height}` : "";
  const fps = c.fps ? ` · ${t("net.fps", { n: c.fps })}` : "";
  return `${c.codec || "?"} · ${where}${c.engine ? ` (${c.engine})` : ""}${size}${fps}`;
}

/**
 * Connection details for the call, opened from "Voice connected": the round
 * trip to the media server and packet loss over the last minutes, and how the
 * own share and camera are being encoded.
 */
function NetPanel({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<NetStats | null>(null);
  useEscape(true, onClose);
  useEffect(() => {
    let alive = true;
    const load = () => void voice.netStats().then((s) => alive && setStats(s));
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const samples = stats?.samples ?? [];
  const last = samples[samples.length - 1];
  const avg = samples.length ? Math.round(samples.reduce((a, s) => a + s.rtt, 0) / samples.length) : 0;
  const recent = samples.slice(-15);
  const outLoss = recent.length ? recent.reduce((a, s) => a + s.outLoss, 0) / recent.length : 0;
  const inLoss = recent.length ? recent.reduce((a, s) => a + s.inLoss, 0) / recent.length : 0;

  return (
    <>
      <div className="net-back" onMouseDown={onClose} />
      <div className="net-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="net-head">
          <b>{t("net.title")}</b>
          <span className="state ellipsis sensitive">{stats?.server ?? ""}</span>
          <button className="ghost icon tiny" title={t("common.close")} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        {samples.length === 0 ? (
          <div className="state">{t("net.collecting")}</div>
        ) : (
          <>
            <div className="net-caption">{t("net.ping")}</div>
            <Chart samples={samples} pick={(s) => s.rtt} floor={60} unit={t("net.ms")} danger={250} />
            <div className="net-caption">{t("net.loss")}</div>
            <Chart samples={samples} pick={(s) => Math.max(s.outLoss, s.inLoss)} floor={5} unit="%" danger={10} />
          </>
        )}
        <dl className="net-facts">
          <div>
            <dt>{t("net.avg")}</dt>
            <dd>{samples.length ? `${avg} ${t("net.ms")}` : "..."}</dd>
          </div>
          <div>
            <dt>{t("net.last")}</dt>
            <dd className={last && last.rtt >= 250 ? "bad" : ""}>{last ? `${last.rtt} ${t("net.ms")}` : "..."}</dd>
          </div>
          <div>
            <dt>{t("net.outLoss")}</dt>
            <dd className={outLoss >= 10 ? "bad" : ""}>{outLoss.toFixed(1)}%</dd>
          </div>
          <div>
            <dt>{t("net.inLoss")}</dt>
            <dd className={inLoss >= 10 ? "bad" : ""}>{inLoss.toFixed(1)}%</dd>
          </div>
          {stats?.share && (
            <div>
              <dt>{t("net.share")}</dt>
              <dd>{codecLine(stats.share)}</dd>
            </div>
          )}
          {stats?.camera && (
            <div>
              <dt>{t("net.camera")}</dt>
              <dd>{codecLine(stats.camera)}</dd>
            </div>
          )}
          {stats?.link && (
            <div>
              <dt>{t("net.link")}</dt>
              <dd className={stats.link.protocol === "TCP" ? "bad" : ""}>
                {[stats.link.protocol, stats.link.relay ? t("net.relay") : "", stats.link.upKbps ? t("net.up", { n: (stats.link.upKbps / 1000).toFixed(1) }) : ""].filter(Boolean).join(" · ")}
              </dd>
            </div>
          )}
          {(stats?.incoming.length ?? 0) > 0 && (
            <div>
              <dt>{t("net.incoming")}</dt>
              <dd>
                {stats?.incoming.map((v, i) => (
                  <div key={i}>
                    {v.codec} · {v.width}×{v.height} · {t("net.fps", { n: v.fps })}
                    {v.kbps ? ` · ${t("net.mbps", { n: (v.kbps / 1000).toFixed(1) })}` : ""}
                  </div>
                ))}
              </dd>
            </div>
          )}
        </dl>
        {stats?.link?.protocol === "TCP" && <div className="note warn net-note">{t("net.tcpWarn")}</div>}
        <div className="state net-note">{t("net.note")}</div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- media */

/** Right click on a picture opens its menu: open, save, copy. */
function imageMenuHandler(url: string, name: string) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openImageMenu(url, name, e.clientX, e.clientY);
  };
}

/** URL of an attachment: plain media is downloaded, encrypted media is also decrypted. */
function mediaSrc(media: Media): Promise<string> {
  return media.file ? encryptedMediaUrl(media.file, media.mime) : mediaUrl(media.mxc);
}

function useMediaSrc(media: Media, enabled: boolean): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void mediaSrc(media).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
    // an attachment is identified by its mxc; the other fields follow from it
  }, [media.mxc, enabled]);
  return url;
}

async function downloadMedia(media: Media): Promise<void> {
  const url = await mediaSrc(media);
  if (!url) {
    app.set({ error: t("chat.err.download", { name: media.name }) });
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(media.name, "file");
  a.click();
}

/* ------------------------------------------------------------- link cards */

function previewMedia(p: LinkPreview): Media | null {
  const img = p.image;
  if (!img) return null;
  return { mxc: img.mxc, file: img.file, kind: "image", name: p.title || p.site, mime: img.mime, size: 0, caption: "", w: img.w, h: img.h };
}

/**
 * A link card like Discord's: site, title, description and the picture, a
 * large one below or a small one on the side. YouTube plays in place. The
 * sender sees a cross to take the card away.
 */
function LinkCard({ preview, onRemove }: { preview: LinkPreview; onRemove?: () => void }) {
  const media = previewMedia(preview);
  const src = useMediaSrc(media ?? ({ mxc: "" } as Media), !!media);
  const [playing, setPlaying] = useState(false);
  const wide = !!preview.youtube || (media ? media.w >= 360 && media.w >= media.h * 1.15 : false) || (!preview.title && !preview.description);

  return (
    <div className={`embed ${preview.youtube ? "video" : ""} ${wide ? "wide" : ""}`}>
      <div className="embed-text">
        {preview.site && <div className="embed-site ellipsis">{preview.site}</div>}
        {preview.title && (
          <a className="embed-title" href={preview.url} target="_blank" rel="noreferrer" title={preview.url}>
            {preview.title}
          </a>
        )}
        {preview.description && <div className="embed-desc">{preview.description}</div>}
      </div>
      {preview.youtube ? (
        playing ? (
          <div className="embed-player">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(preview.youtube)}?autoplay=1&rel=0`}
              title={preview.title || "YouTube"}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        ) : (
          <button className="embed-shot" onClick={() => setPlaying(true)} title={t("embed.play")}>
            {src && <img src={src} alt="" loading="lazy" />}
            <span className="embed-play">
              <IconPlay size={22} />
            </span>
          </button>
        )
      ) : (
        media &&
        src && (
          <button className={wide ? "embed-shot" : "embed-thumb"} onClick={() => openImage(src, media.name)} onContextMenu={imageMenuHandler(src, media.name)} title={t("chat.openImage")}>
            <img src={src} alt="" loading="lazy" />
          </button>
        )
      )}
      {onRemove && (
        <button className="embed-remove ghost icon tiny" title={t("embed.remove")} onClick={onRemove}>
          <IconClose />
        </button>
      )}
    </div>
  );
}

/** Images load at once, video and audio only on click: they can be heavy. */
function MessageMedia({ media }: { media: Media }) {
  const [load, setLoad] = useState(media.kind === "image");
  const url = useMediaSrc(media, load);

  // reserve the image size up front so the timeline does not jump while it loads
  const box =
    media.w > 0 && media.h > 0
      ? { aspectRatio: `${media.w} / ${media.h}`, width: Math.min(media.w, 420, Math.round((media.w / media.h) * 320)) }
      : undefined;

  if (media.kind === "image") {
    return url ? (
      <button className="media" style={box} onClick={() => openImage(url, media.name)} onContextMenu={imageMenuHandler(url, media.name)} title={t("chat.openImage")}>
        <img src={url} alt={media.name} loading="lazy" />
      </button>
    ) : (
      <div className="media placeholder" style={box}>
        {t("chat.loadingImage")}
      </div>
    );
  }

  if (media.kind === "video" || media.kind === "audio") {
    if (!load || !url) {
      return (
        <button className="media-play" onClick={() => setLoad(true)} disabled={load}>
          <IconPlay size={18} />
          <span className="ellipsis">{media.name}</span>
          <span className="state">{load ? t("common.loading") : humanSize(media.size)}</span>
        </button>
      );
    }
    return media.kind === "video" ? (
      <video className="media-video" src={url} controls autoPlay />
    ) : (
      <audio className="media-audio" src={url} controls autoPlay />
    );
  }

  return (
    <>
      <div className="file-row">
        <button className="file-chip" title={t("common.download")} onClick={() => void downloadMedia(media)}>
          <IconClip />
          <span className="ellipsis">{media.name}</span>
          <span className="state">{humanSize(media.size)}</span>
        </button>
        {isTextFile(media) && <TextPreviewButton media={media} />}
      </div>
    </>
  );
}

const TEXT_EXT = /\.(md|markdown|txt|log|csv|json|ya?ml|xml|ini|cfg|toml|conf|sh|bat|ps1|py|js|ts|tsx|jsx|c|cpp|h|hpp|cs|java|kt|go|rs|rb|php|lua|sql|css|html?)$/i;
const TEXT_MAX = 512 * 1024;

function isTextFile(media: Media): boolean {
  return media.size <= TEXT_MAX && (/^text\//.test(media.mime) || /json|xml|yaml|markdown/.test(media.mime) || TEXT_EXT.test(media.name));
}

/** Text attachments open right in the chat; Markdown files are rendered. */
function TextPreviewButton({ media }: { media: Media }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!open || text !== null) return;
    let alive = true;
    void mediaSrc(media)
      .then((url) => fetch(url))
      .then((r) => r.text())
      .then((v) => alive && setText(v))
      .catch(() => alive && setText(t("chat.previewFailed")));
    return () => {
      alive = false;
    };
  }, [open, text, media]);

  const markdown = /\.(md|markdown)$/i.test(media.name) || /markdown/.test(media.mime);
  return (
    <>
      <button className="ghost small" onClick={() => setOpen(!open)}>
        <IconEye /> {open ? t("chat.hidePreview") : t("chat.preview")}
      </button>
      {open && (
        <div className={`text-preview ${markdown ? "md-file" : ""}`}>
          {text === null ? (
            <span className="state">{t("common.loading")}</span>
          ) : markdown ? (
            <Markdown text={text} />
          ) : (
            <pre>{text}</pre>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ message text */

const URL_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,:;!?)\]}'»])/g;
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u;

/** Links in text are clickable and open in the browser. */
function RichText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A message of a few emoji only is drawn large. */
function isJumbo(text: string): boolean {
  const s = text.trim();
  return s.length > 0 && s.length <= 24 && ONLY_EMOJI.test(s) && !/\d/.test(s);
}

/* ------------------------------------------------------------------ message */

/** Longer texts are drawn without Markdown: a crafted giant message must not freeze the chat. */
const MARKDOWN_MAX = 16_000;

const PICKER_W = 352;
const PICKER_H = 392;

/** One message. Drawn again only when the message itself changed (see reuse() in app.ts). */
const MessageRow = memo(function MessageRow({ m, roomId, lit }: { m: Message; roomId: string | null; lit: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [pickAt, setPickAt] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // a message found through search is scrolled to and highlighted
  useEffect(() => {
    if (lit) box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [lit]);

  const openPicker = (e: MouseEvent<HTMLButtonElement>) => {
    if (pickAt) {
      setPickAt(null);
      return;
    }
    // the reaction picker floats above everything and is not clipped by the timeline
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.bottom + 6 + PICKER_H < window.innerHeight;
    setPickAt({
      left: Math.max(8, Math.min(window.innerWidth - PICKER_W - 8, r.right - PICKER_W)),
      top: below ? r.bottom + 6 : Math.max(8, r.top - PICKER_H - 6),
    });
  };

  const text = m.media ? m.media.caption : m.body;
  const mentions = { resolve: mentionResolver(roomId), me: me(), open: openProfile };

  return (
    <div
      className={`msg ${lit ? "lit" : ""} ${m.state} ${m.deleted ? "deleted" : ""} ${m.mentionsMe ? "pinged" : ""} ${m.own ? "own" : ""}`}
      ref={box}
      id={`msg-${m.id}`}
    >
      <Avatar
        mxc={m.avatar}
        name={m.senderName}
        size={34}
        className="clickable"
        onClick={() => openProfile(m.sender)}
        onContextMenu={menuHandler(m.sender, roomId)}
      />
      <div className="msg-body">
        {m.reply &&
          (m.reply.quote ? (
            <button type="button" className="quote fragment" title={t("chat.jumpToReply")} onClick={() => m.reply && void jumpTo(m.reply.eventId)}>
              <span className="quote-bar" />
              <span className="quote-text">
                <InlineMarkdown text={m.reply.body} mentions={mentions} />
                {m.reply.senderName && <b> · {m.reply.senderName}</b>}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="quote"
              title={t("chat.jumpToReply")}
              onClick={() => m.reply && void jumpTo(m.reply.eventId)}
            >
              <IconReply />
              {m.reply.senderName && <b>{m.reply.senderName}</b>}
              <span className="ellipsis">
                <InlineMarkdown text={m.reply.body} mentions={mentions} />
              </span>
            </button>
          ))}
        <div>
          <span
            className="who clickable"
            style={m.color ? { color: m.color } : undefined}
            onClick={() => openProfile(m.sender)}
            onContextMenu={menuHandler(m.sender, roomId)}
          >
            {m.senderName}
          </span>
          <span className="when">{fmtTime(m.ts)}</span>
          {m.edited && <span className="when">{t("chat.edited")}</span>}
          {m.pinned && (
            <span className="when pin-mark" title={t("pins.pinned")}>
              <IconPin size={11} />
            </span>
          )}
        </div>
        {text && (
          <div className={`body ${m.locked ? "locked" : ""} ${isJumbo(text) ? "jumbo" : ""}`}>
            {m.locked || isJumbo(text) || text.length > MARKDOWN_MAX ? (
              <RichText text={text} />
            ) : (
              <Markdown
                text={text}
                checks={m.checks}
                onToggle={m.state === "sent" ? (key, done) => void toggleCheck(m.id, key, done) : undefined}
                whoName={(u) => displayName(u, roomId)}
                mentions={mentions}
              />
            )}
          </div>
        )}
        {m.media && <MessageMedia media={m.media} />}
        {m.previews.map((p) => (
          <LinkCard key={p.url} preview={p} onRemove={m.own && m.state === "sent" ? () => void removePreview(m.id, p.url) : undefined} />
        ))}

        {m.state === "failed" && (
          <div className="send-failed" title={m.failReason}>
            <span>{m.failReason ? t("chat.notSentWhy", { why: m.failReason }) : t("chat.notSent")}</span>
            <button className="ghost small" onClick={() => void resend(m.id)}>
              {t("chat.retry")}
            </button>
            <button className="ghost small" onClick={() => discard(m.id)}>
              {t("chat.discard")}
            </button>
          </div>
        )}

        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button
                key={r.key}
                className={`reaction ${r.mine ? "mine" : ""}`}
                title={r.who.map((u) => displayName(u, roomId)).join(", ")}
                onClick={() => void toggleReaction(m.id, r.key)}
              >
                <span>{r.key}</span>
                <b>{r.count}</b>
              </button>
            ))}
          </div>
        )}
      </div>

      {pickAt && (
        <EmojiPicker
          forReaction
          className="floating"
          style={{ left: pickAt.left, top: pickAt.top }}
          onPick={(e) => void toggleReaction(m.id, e)}
          onClose={() => setPickAt(null)}
        />
      )}

      <div className={`msg-tools ${pickAt ? "shown" : ""}`}>
        {confirming ? (
          <>
            <span className="state">{t("chat.deleteConfirm")}</span>
            <button
              className="ghost icon small danger"
              title={t("common.yes")}
              onClick={() => {
                setConfirming(false);
                void deleteMessage(m.id);
              }}
            >
              <IconTrash />
            </button>
            <button className="ghost icon small" title={t("common.no")} onClick={() => setConfirming(false)}>
              <IconClose />
            </button>
          </>
        ) : (
          <>
            <button className="ghost icon small" title={t("chat.react")} onClick={openPicker}>
              <IconSmile />
            </button>
            <button className="ghost icon small" title={t("chat.reply")} onClick={() => startReply(m)}>
              <IconReply />
            </button>
            {text && !m.locked && (
              <button
                className="ghost icon small"
                title={t("chat.quote")}
                // the selection inside the message must survive the click
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const sel = window.getSelection();
                  const inside = !!sel && !sel.isCollapsed && !!box.current?.contains(sel.anchorNode) && !!box.current?.contains(sel.focusNode);
                  startQuote(m, inside ? (sel?.toString() ?? "") : text);
                  sel?.removeAllRanges();
                }}
              >
                <IconQuote />
              </button>
            )}
            {m.state === "sent" && m.canPin && (
              <button className={`ghost icon small ${m.pinned ? "on-soft" : ""}`} title={m.pinned ? t("pins.unpin") : t("pins.pin")} onClick={() => void togglePin(m.id)}>
                <IconPin />
              </button>
            )}
            {m.canEdit && (
              <button className="ghost icon small" title={t("chat.edit")} onClick={() => startEdit(m)}>
                <IconEdit />
              </button>
            )}
            {m.canDelete && (
              <button className="ghost icon small" title={t("common.delete")} onClick={() => setConfirming(true)}>
                <IconTrash />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

/* --------------------------------------------------------------------- chat */

/**
 * Where each chat was left: at its newest messages, or scrolled up with some
 * message at the top of the view. Coming back shows the same place. Kept for
 * the session only.
 */
type ScrollMark = { bottom: true } | { bottom: false; anchor: string; offset: number };
const scrollMarks = new Map<string, ScrollMark>();

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

/** The first message whose lower edge is inside the view; messages are in order, so a binary search does. */
function markScroll(roomId: string, el: HTMLElement): void {
  if (nearBottom(el)) {
    scrollMarks.set(roomId, { bottom: true });
    return;
  }
  const top = el.getBoundingClientRect().top;
  const nodes = el.querySelectorAll<HTMLElement>(".msg");
  let lo = 0;
  let hi = nodes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom > top + 4) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (found === -1) return;
  const node = nodes[found];
  scrollMarks.set(roomId, { bottom: false, anchor: node.id.slice(4), offset: node.getBoundingClientRect().top - top });
}

function typingLine(names: string[]): string {
  if (names.length === 1) return t("chat.typing.one", { a: names[0] });
  if (names.length === 2) return t("chat.typing.two", { a: names[0], b: names[1] });
  if (names.length > 2) return t("chat.typing.many");
  return "";
}

function Chat({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  useMutes();
  const messages = useStore(app, (s) => s.messages);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const view = useStore(app, (s) => s.view);
  const servers = useStore(app, (s) => s.servers);
  const loose = useStore(app, (s) => s.loose);
  const directs = useStore(app, (s) => s.directs);
  const typing = useStore(app, (s) => s.typing);
  const highlight = useStore(app, (s) => s.highlight);
  const searchOpen = useStore(app, (s) => s.searchOpen);
  const membersHidden = useStore(app, (s) => s.membersHidden);
  const history = useStore(app, (s) => s.history);
  const unreadFrom = useStore(app, (s) => s.unreadFrom);
  const pinsOpen = useStore(app, (s) => s.pinsOpen);
  const pins = useStore(app, (s) => s.pins);
  const [atBottom, setAtBottom] = useState(true);
  // the "new" line has been in view: the bar about new messages is not needed
  const [lineSeen, setLineSeen] = useState(false);

  const [dragging, setDragging] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // the place to return to, applied once the chat's messages are drawn
  const restore = useRef<ScrollMark | null>(null);
  const markFrame = useRef(0);

  const direct = directs.find((d) => d.roomId === activeChannel);
  const channel =
    servers.flatMap((g) => g.channels).find((c) => c.roomId === activeChannel) ?? loose.find((c) => c.roomId === activeChannel);
  const title = direct?.name ?? channel?.name ?? activeChannel ?? "";
  const voiceHere = channel?.kind === "voice";

  const follow = (on: boolean) => {
    stick.current = on;
    setAtBottom(on);
    setChatAtBottom(on);
  };

  // another chat: back to where it was left, or to its newest messages
  useLayoutEffect(() => {
    const mark = activeChannel ? scrollMarks.get(activeChannel) : undefined;
    restore.current = mark && !mark.bottom ? mark : null;
    setLineSeen(false);
    follow(!restore.current);
    if (!restore.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [activeChannel]);

  useLayoutEffect(() => {
    const mark = restore.current;
    const el = scroller.current;
    if (!mark || mark.bottom || !el || !messages.length) return;
    restore.current = null;
    const node = document.getElementById(`msg-${mark.anchor}`);
    if (!node || !el.contains(node)) {
      // that message is not loaded any more: the newest ones then
      follow(true);
      bottom.current?.scrollIntoView({ block: "end" });
      return;
    }
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - mark.offset;
  }, [messages, activeChannel]);

  const toBottom = () => {
    stick.current = true;
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  // new messages from others since the chat was opened (or since scrolling away)
  const unreadAt = unreadFrom ? messages.findIndex((x) => x.id === unreadFrom) : -1;
  const fresh = unreadAt === -1 ? [] : messages.slice(unreadAt).filter((x) => !x.own);

  useEffect(() => setLineSeen(false), [unreadFrom]);

  useEffect(() => {
    const el = line.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLineSeen(true);
    }, { root });
    io.observe(el);
    return () => io.disconnect();
  }, [unreadFrom, activeChannel, messages.length]);

  const toLine = () => line.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  const readAll = () => {
    app.set({ unreadFrom: null });
    if (activeChannel) void markRoomRead(activeChannel);
  };

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeChannel]);

  // Older history loads on scrolling up, but a short chat has nothing to
  // scroll: a fresh join (over federation too) shows only the last few
  // events. Keep loading until the view is full or the start is reached.
  const firstId = messages[0]?.id ?? "";
  useEffect(() => {
    const el = scroller.current;
    if (!el || history !== "more") return;
    if (el.scrollHeight - el.clientHeight < 80) void loadMore();
  }, [firstId, messages.length, activeChannel, history]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const at = nearBottom(el);
    stick.current = at;
    if (at !== atBottom) {
      setAtBottom(at);
      setChatAtBottom(at);
    }
    // where the chat stands is noted once a frame, not on every scroll event
    if (activeChannel && !markFrame.current) {
      const roomId = activeChannel;
      markFrame.current = requestAnimationFrame(() => {
        markFrame.current = 0;
        if (scroller.current && app.get().activeChannel === roomId) markScroll(roomId, scroller.current);
      });
    }
    if (el.scrollTop < 80) {
      const before = el.scrollHeight;
      void loadMore().then((got) => {
        if (got && scroller.current) {
          // keep the same message in view after older history is prepended
          scroller.current.scrollTop += scroller.current.scrollHeight - before;
        }
      });
    }
  };

  useEffect(() => () => cancelAnimationFrame(markFrame.current), []);

  // an own message goes out: scroll down even if history was being read
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.own && lastMsg.state === "sending") {
      stick.current = true;
      bottom.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  const dropFiles = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    attachFiles(Array.from(e.dataTransfer.files));
  };

  if (!activeChannel) {
    const none = view !== "direct" && servers.length === 0;
    return (
      <main className="chat">
        <div className="empty">
          <h3>{none ? t("chat.empty.noServers") : view === "direct" ? t("chat.empty.pickPerson") : t("chat.empty.pickChannel")}</h3>
          <p>{none ? t("chat.empty.noServers.hint") : t("chat.empty.hint")}</p>
        </div>
      </main>
    );
  }

  const showNew = fresh.length > 0 && !lineSeen;

  return (
    <main
      className={`chat ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // moving onto a child also fires dragleave; hide the hint only at the chat edge
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={dropFiles}
    >
      <div className="chat-head">
        <span className="sigil">{direct ? <IconChat /> : voiceHere ? <IconSpeaker /> : <IconHash />}</span>
        <b className="ellipsis">{title}</b>
        {channel?.topic && !embedded && <span className="topic">{channel.topic}</span>}
        <span className="head-gap" />
        {voiceHere && activeChannel === voiceChannel && !embedded && (
          <button className="ghost small head-tool back-to-call" onClick={showCall}>
            <IconSpeaker /> {t("chat.backToCall")}
          </button>
        )}
        {embedded ? (
          <button className="ghost icon head-tool" title={t("common.close")} onClick={onClose}>
            <IconClose />
          </button>
        ) : (
          <>
            <MuteBell roomId={activeChannel} userId={direct?.userId ?? ""} />
            <button
              className={`ghost icon head-tool pin-tool ${pinsOpen ? "on-soft" : ""}`}
              title={t("pins.title")}
              onClick={() => app.set({ pinsOpen: !pinsOpen })}
            >
              <IconPin />
              {pins.length > 0 && <small>{pins.length}</small>}
            </button>
            <HeadSearch roomId={activeChannel} />
            <button
              className={`ghost icon head-tool ${membersHidden ? "" : "on-soft"}`}
              title={membersHidden ? t("chat.showMembers") : t("chat.hideMembers")}
              onClick={toggleMembers}
            >
              <IconUsers />
            </button>
          </>
        )}
      </div>

      <div className="timeline-wrap">
        {showNew ? (
          <div className="unread-bar">
            <button className="unread-jump" onClick={toLine}>
              {tn("chat.unreadSince", fresh.length, { time: fmtTime(fresh[0].ts) })}
            </button>
            <button className="unread-act" onClick={readAll}>
              {t("mutes.markRead")} <IconMarkRead />
            </button>
          </div>
        ) : (
          !atBottom && (
            <div className="unread-bar older">
              <button className="unread-jump" onClick={toBottom}>
                {t("chat.olderShown")}
              </button>
              <button className="unread-act" onClick={toBottom}>
                {t("chat.toBottom")} ↓
              </button>
            </div>
          )
        )}

        {!embedded && searchOpen && <SearchPop roomId={activeChannel} />}
        {!embedded && pinsOpen && <PinsPop />}

        <div className="timeline" key={`timeline-${activeChannel}`} ref={scroller} onScroll={onScroll}>
          {history !== "more" && (
            <div className="chat-start">
              <b>{direct ? t("chat.start.direct", { name: title }) : t("chat.start.channel", { name: title })}</b>
              <span>{history === "hidden" ? t("chat.start.hidden") : t("chat.start.text")}</span>
            </div>
          )}
          {messages.map((m) => (
            <Fragment key={m.id}>
              {m.id === unreadFrom && (
                <div className="new-line" ref={line}>
                  <span>{t("chat.newLine")}</span>
                </div>
              )}
              <Guard key={m.id} fallback={<div className="guard-note msg-broken">{t("guard.message")}</div>}>
                <MessageRow m={m} roomId={activeChannel} lit={highlight === m.id} />
              </Guard>
            </Fragment>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      {dragging && <div className="drop-hint">{t("chat.dropHint")}</div>}

      <div className="typing">{typingLine(typing)}</div>

      {direct?.deleted ? (
        <div className="composer-closed">{t("chat.deletedPeer")}</div>
      ) : channel?.readonly ? (
        <div className="composer-closed">{t("chat.readonly")}</div>
      ) : (
        <Composer key={`composer-${activeChannel}`} roomId={activeChannel} title={title} />
      )}
    </main>
  );
}

/** The bell in a chat header: silence this chat, or the person in a direct chat. */
function MuteBell({ roomId, userId }: { roomId: string; userId: string }) {
  useMutes();
  const kind = userId ? "users" : "rooms";
  const id = userId || roomId;
  const muted = isMuted(kind, id);
  return (
    <button
      className={`ghost icon head-tool ${muted ? "on-soft" : ""}`}
      title={muted ? t("mutes.unmuteChat") : t("mutes.muteChat")}
      onClick={() => setMuted(kind, id, !muted)}
    >
      {muted ? <IconBellOff /> : <IconBell />}
    </button>
  );
}

/* --------------------------------------------------------------- image menu */

/** The context menu of a picture, in the chat and in the full-screen viewer. */
function ImageMenuView() {
  const menu = useStore(app, (s) => s.imageMenu);
  useEscape(!!menu, closeImageMenu);
  if (!menu) return null;
  const run = (fn: () => void) => () => {
    closeImageMenu();
    fn();
  };
  return (
    <div className="menu-back over-viewer" onMouseDown={closeImageMenu} onContextMenu={(e) => (e.preventDefault(), closeImageMenu())}>
      <div
        className="menu"
        style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.max(8, Math.min(menu.y, window.innerHeight - 150)) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!menu.inViewer && (
          <button className="menu-item" onClick={run(() => openImage(menu.url, menu.name))}>
            <IconExpand />
            <span>{t("image.open")}</span>
          </button>
        )}
        <button className="menu-item" onClick={run(() => saveImage(menu.url, menu.name))}>
          <IconDownload />
          <span>{t("image.save")}</span>
        </button>
        <button className="menu-item" onClick={run(() => void copyImage(menu.url))}>
          <IconCopy />
          <span>{t("image.copy")}</span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- search */

/**
 * The search field in the chat header. Enter searches; the results open
 * under the header and stay until closed, the chat changes or the app
 * navigates elsewhere. The member list stays where it is.
 */
function HeadSearch({ roomId }: { roomId: string }) {
  const open = useStore(app, (s) => s.searchOpen);
  const [term, setTerm] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => setTerm(""), [roomId]);

  const clear = () => {
    setTerm("");
    closeSearch();
  };

  return (
    <div className={`head-search ${open || term ? "wide" : ""}`} onClick={() => field.current?.focus()}>
      <IconSearch />
      <input
        ref={field}
        value={term}
        placeholder={t("search.short")}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void runSearch(term);
          } else if (e.key === "Escape") {
            e.preventDefault();
            clear();
            field.current?.blur();
          }
        }}
      />
      {(term || open) && (
        <button className="ghost icon tiny" title={t("common.clear")} onClick={(e) => (e.stopPropagation(), clear())}>
          <IconClose />
        </button>
      )}
    </div>
  );
}

/** The searched words, marked in a found message. */
function Marked({ text, term }: { text: string; term: string }) {
  const words = term
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

function SearchPop({ roomId }: { roomId: string }) {
  const hits = useStore(app, (s) => s.searchHits);
  const searching = useStore(app, (s) => s.searching);
  const term = useStore(app, (s) => s.searchTerm);

  return (
    <div className="head-pop search-pop">
      <div className="head-pop-top">
        <span className="state">{searching ? t("search.searching") : hits.length ? tn("search.found", hits.length) : t("search.nothing")}</span>
        <button className="ghost icon tiny" title={t("common.close")} onClick={closeSearch}>
          <IconClose />
        </button>
      </div>
      <div className="head-pop-list">
        {hits.map((h) => (
          <button key={h.eventId} className="hit" onClick={() => void jumpTo(h.eventId)}>
            <div>
              <b>{displayName(h.sender, roomId)}</b>
              <span className="when">{fmtDateTime(h.ts)}</span>
            </div>
            <div className="hit-body">
              <Marked text={h.body} term={term} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- pins */

/** Pinned messages, under the header like the search. A click outside closes them. */
function PinsPop() {
  const pins = useStore(app, (s) => s.pins);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const [items, setItems] = useState<PinnedItem[] | null>(null);
  const can = canPinHere();
  const close = () => app.set({ pinsOpen: false });
  useEscape(true, close);

  useEffect(() => {
    let alive = true;
    void pinnedMessages().then((list) => alive && setItems(list));
    return () => {
      alive = false;
    };
  }, [pins.join(","), activeChannel]);

  return (
    <>
      <div className="head-pop-back" onMouseDown={close} />
      <div className="head-pop pins-pop">
        <div className="head-pop-top">
          <b>
            <IconPin /> {t("pins.title")}
          </b>
          <button className="ghost icon tiny" title={t("common.close")} onClick={close}>
            <IconClose />
          </button>
        </div>
        <div className="head-pop-list">
          {!items && <div className="state pad">{t("pins.loading")}</div>}
          {items?.length === 0 && <div className="state pad">{t("pins.none")}</div>}
          {items?.map((p) => (
            <div key={p.id} className="hit pin-item">
              <button className="pin-open" onClick={() => void jumpTo(p.id)}>
                <div>
                  <b>{p.name}</b>
                  {p.ts > 0 && <span className="when">{fmtDateTime(p.ts)}</span>}
                </div>
                <div className="hit-body">
                  <InlineMarkdown text={p.body} />
                </div>
              </button>
              {can && (
                <button className="ghost icon tiny" title={t("pins.unpin")} onClick={() => void togglePin(p.id)}>
                  <IconClose />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- place menu */

/** Right click on a channel or a server icon: notifications, read state, settings. */
function PlaceMenu() {
  const menu = useStore(app, (s) => s.placeMenu);
  const servers = useStore(app, (s) => s.servers);
  const orders = useChannelOrders();
  useMutes();
  useEscape(!!menu, closePlaceMenu);
  if (!menu) return null;

  const server = menu.kind === "server" ? servers.find((g) => g.spaceId === menu.id) : servers.find((g) => g.channels.some((c) => c.roomId === menu.id));
  const own = server ? orders[server.spaceId] : undefined;
  const siblings = server && menu.kind === "room" ? arrangeChannels(server.channels.filter((c) => c.kind === server.channels.find((x) => x.roomId === menu.id)?.kind), own) : [];
  const at = siblings.findIndex((c) => c.roomId === menu.id);
  const channel = menu.kind === "room" ? server?.channels.find((c) => c.roomId === menu.id) : undefined;
  const kind = menu.kind === "server" ? "servers" : "rooms";
  const muted = isMuted(kind, menu.id);
  const can = access(server?.spaceId ?? null);
  const serverMuted = menu.kind === "room" && !!server && isMuted("servers", server.spaceId);

  const run = (fn: () => void) => () => {
    closePlaceMenu();
    fn();
  };

  return (
    <div className="menu-back" onMouseDown={closePlaceMenu} onContextMenu={(e) => (e.preventDefault(), closePlaceMenu())}>
      <div
        className="menu"
        style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.max(8, Math.min(menu.y, window.innerHeight - 330)) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="menu-head ellipsis">{menu.kind === "server" ? server?.name : channel?.name}</div>
        <button className="menu-item" onClick={run(() => setMuted(kind, menu.id, !muted))}>
          {muted ? <IconBell /> : <IconBellOff />}
          <span>{muted ? t(menu.kind === "server" ? "mutes.unmuteServer" : "mutes.unmuteChat") : t(menu.kind === "server" ? "mutes.muteServer" : "mutes.muteChat")}</span>
        </button>
        {serverMuted && <div className="menu-note">{t("mutes.serverMuted")}</div>}
        <button
          className="menu-item"
          onClick={run(() => void (menu.kind === "server" ? markServerRead(menu.id) : markRoomRead(menu.id)))}
        >
          <IconMarkRead />
          <span>{t("mutes.markRead")}</span>
        </button>
        {can.channels && menu.kind === "room" && (
          <button
            className="menu-item"
            onClick={run(() => {
              openServerSettings("channels");
              app.set({ channelEdit: menu.id });
            })}
          >
            <IconGear />
            <span>{t("channels.edit")}</span>
          </button>
        )}
        {server && at > 0 && (
          <button className="menu-item" onClick={run(() => moveChannel(server, own, menu.id, siblings[at - 1].roomId, false))}>
            <IconChevron style={{ transform: "rotate(180deg)" }} />
            <span>{t("order.up")}</span>
          </button>
        )}
        {server && at !== -1 && at < siblings.length - 1 && (
          <button className="menu-item" onClick={run(() => moveChannel(server, own, menu.id, siblings[at + 1].roomId, true))}>
            <IconChevron />
            <span>{t("order.down")}</span>
          </button>
        )}
        {menu.kind === "server" && (
          <button className="menu-item" onClick={run(() => (selectServer(menu.id), openServerSettings("me")))}>
            <IconUser />
            <span>{t("server.tab.me")}</span>
          </button>
        )}
        {menu.kind === "server" && (
          <button className="menu-item" onClick={run(() => (selectServer(menu.id), openServerSettings()))}>
            <IconGear />
            <span>{t("server.settings")}</span>
          </button>
        )}
        {menu.kind === "server" && hasOwnOrder(menu.id) && (
          <button className="menu-item" onClick={run(() => setChannelOrder(menu.id, null))}>
            <IconRefresh />
            <span>{t("order.reset")}</span>
          </button>
        )}
        {menu.kind === "server" && (
          <button className="menu-item danger" onClick={run(() => app.set({ leaveServerAsk: menu.id }))}>
            <IconDoorOut />
            <span>{t("server.leave")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ members */

function Members() {
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const messages = useStore(app, (s) => s.messages);
  const tick = useStore(app, (s) => s.tick);
  const myPresence = useStore(app, (s) => s.myPresence);

  // not used directly: the list is rebuilt whenever these change
  const members = channelMembers(activeChannel);
  void messages.length;
  void tick;
  void myPresence;

  const split = presenceWorks(members);
  const online = split ? members.filter((m) => m.presence !== "offline") : members;
  const offline = split ? members.filter((m) => m.presence === "offline") : [];

  const row = (m: (typeof members)[number]) => (
    <div
      className={`member clickable ${m.presence}`}
      key={m.userId}
      title={idsHidden() ? undefined : m.userId}
      onClick={() => openProfile(m.userId)}
      onContextMenu={menuHandler(m.userId, activeChannel)}
    >
      <Avatar mxc={m.avatar} name={m.name} size={30} status={split ? m.presence : null} />
      <span className="ellipsis" style={m.color ? { color: m.color } : undefined}>
        {m.name}
      </span>
      {m.role && (
        <span
          className={`badge ${m.owner ? "owner" : m.power >= 75 ? "admin" : ""}`}
          style={m.color ? { color: m.color, borderColor: m.color } : undefined}
        >
          {m.role}
        </span>
      )}
    </div>
  );

  return (
    <aside className="members">
      {members.length === 0 && (
        <>
          <div className="group-title">
            <IconUsers /> {t("members.title")}
          </div>
          <div className="state">{t("members.pickChannel")}</div>
        </>
      )}

      {online.length > 0 && (
        <>
          <div className="group-title">{t(split ? "members.online" : "members.all", { n: online.length })}</div>
          {online.map(row)}
        </>
      )}

      {offline.length > 0 && (
        <>
          <div className="group-title">{t("members.offline", { n: offline.length })}</div>
          {offline.map(row)}
        </>
      )}
    </aside>
  );
}

/* --------------------------------------------------------------- add server */

function AddServerModal() {
  const open = useStore(app, (s) => s.addServerOpen);
  const card = useStore(app, (s) => s.serverCard);
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const [mode, setMode] = useState<"join" | "create">("join");
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [openJoin, setOpenJoin] = useState(true);
  const { shown, closing } = useLinger(open);
  const close = () => app.set({ addServerOpen: false, serverCard: null, error: "" });
  useEscape(open, close);

  // a fresh host announces an address nobody took yet: offer it for the first server
  useEffect(() => {
    if (!open || mode !== "create") return;
    let alive = true;
    void suggestServerAddress().then((a) => alive && a && setAddress((cur) => cur || a));
    return () => {
      alive = false;
    };
  }, [open, mode]);

  if (!shown) return null;

  const switchTo = (m: "join" | "create") => {
    setMode(m);
    app.set({ serverCard: null, error: "" });
  };
  const domainPart = me().split(":").slice(1).join(":");
  const create = () => void newServer(name, address, openJoin);

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal add-server" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === "join" ? t("server.add.title") : t("server.create.title")}</h2>

        <div className="seg login-tabs">
          <button type="button" className={mode === "join" ? "on" : ""} onClick={() => switchTo("join")}>
            {t("server.add.tab.join")}
          </button>
          <button type="button" className={mode === "create" ? "on" : ""} onClick={() => switchTo("create")}>
            {t("server.add.tab.create")}
          </button>
        </div>

        {mode === "join" ? (
          <>
            <p className="sub">{t("server.add.hint")}</p>

            {error && <div className="error">{error}</div>}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void previewServer(domain);
              }}
            >
              <input autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t("server.add.placeholder")} />
            </form>

            {card && (
              <div className="card-preview">
                <div className="avatar">{initials(card.name)}</div>
                <div>
                  <b>{card.name}</b>
                  <div className="state">{card.description || card.alias}</div>
                  {card.guessed && <div className="state">{t("server.add.guessed")}</div>}
                </div>
              </div>
            )}

            <div className="row">
              <button className="ghost" onClick={close}>
                {t("common.cancel")}
              </button>
              {card ? (
                <button className="primary" disabled={!!busy} onClick={() => void addServer()}>
                  {busy || t("server.add.join")}
                </button>
              ) : (
                <button className="primary" disabled={!domain || !!busy} onClick={() => void previewServer(domain)}>
                  {busy || t("server.add.find")}
                </button>
              )}
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !busy) create();
            }}
          >
            <p className="sub">{t("server.create.hint")}</p>

            {error && <div className="error">{error}</div>}

            <div className="field">
              <label>{t("server.create.name")}</label>
              <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("server.create.name.placeholder")} />
            </div>

            <div className="field">
              <label>{t("server.create.address")}</label>
              <div className="address-input">
                <span>#</span>
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value.toLowerCase().replace(/\s+/g, ""))}
                  placeholder="main"
                />
                <span>:{domainPart}</span>
              </div>
              <span className="state">{t("server.create.address.hint")}</span>
            </div>

            <div className="seg join-pick">
              <button type="button" className={openJoin ? "on" : ""} onClick={() => setOpenJoin(true)}>
                {t("server.create.open")}
              </button>
              <button type="button" className={openJoin ? "" : "on"} onClick={() => setOpenJoin(false)}>
                {t("server.create.closed")}
              </button>
            </div>
            <span className="state">{openJoin ? t("server.create.open.hint") : t("server.create.closed.hint")}</span>

            <div className="row">
              <button type="button" className="ghost" onClick={close}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="primary" disabled={!name.trim() || !!busy}>
                {busy || t("server.create.submit")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- leave server */

function LeaveServerModal() {
  const spaceId = useStore(app, (s) => s.leaveServerAsk);
  const servers = useStore(app, (s) => s.servers);
  const busy = useStore(app, (s) => s.busy);
  const { shown, closing } = useLinger(!!spaceId);
  const close = () => app.set({ leaveServerAsk: null });
  useEscape(!!spaceId, close);
  if (!shown || !spaceId) return null;

  const server = servers.find((g) => g.spaceId === spaceId);
  const info = leaveInfo(spaceId);

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("server.leave.title", { name: server?.name ?? "" })}</h2>
        <p className="sub">{t("server.leave.text")}</p>
        {info.alone ? (
          <div className="note warn">{t("server.leave.alone")}</div>
        ) : (
          info.lastAdmin && <div className="note warn">{t("server.leave.lastAdmin")}</div>
        )}
        <div className="row">
          <button className="ghost" onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="danger" disabled={!!busy} onClick={() => void leaveServer(spaceId)}>
            {busy || t("server.leave.yes")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- toast */

const ERROR_TTL_MS = 9000;

/** Progress and errors at the bottom. Errors fade after a while or on click. */
function Toast() {
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const notice = useStore(app, (s) => s.notice);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => {
      if (app.get().error === error) app.set({ error: "" });
    }, ERROR_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  if (!busy && !error && !notice) return null;
  return (
    <div className={`toast ${error ? "bad" : !busy ? "good" : ""}`}>
      {error ? (
        <>
          <span className="toast-text">{error}</span>
          <button className="ghost icon tiny" title={t("common.close")} onClick={() => app.set({ error: "" })}>
            <IconClose />
          </button>
        </>
      ) : (
        busy || notice
      )}
    </div>
  );
}

/** Shown while the sync loop cannot reach the homeserver. Voice keeps its own connection. */
function OfflineBar() {
  const offline = useStore(app, (s) => s.offline);
  if (!offline) return null;
  return <div className="offline-bar">{t("app.offline")}</div>;
}

/* ------------------------------------------------------------------- screen */

export function Main() {
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const callView = useStore(app, (s) => s.callView);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  const membersHidden = useStore(app, (s) => s.membersHidden);
  // the call takes the place of the chat and the member list; the left columns stay
  const inCall = callView && !!voiceChannel && activeChannel === voiceChannel;

  useEffect(() => {
    askNotifyPermission();
    const onScroll = (e: Event) => {
      // scrolling inside the menu or the emoji picker itself does not close it
      if ((e.target as Element | null)?.closest?.(".menu, .emoji-picker")) return;
      closeUserMenu();
      closeMenus();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);

  return (
    <>
      <div className="shell">
        <ServerBar />
        <ChannelList />
        {inCall ? (
          <CallView />
        ) : (
          <>
            <Chat />
            {!membersHidden && <Members />}
          </>
        )}
      </div>
      <MiniStream />
      <MoonlightViewer hidden={inCall} />
      <StreamPeek />
      <Toast />
      <OfflineBar />
      <AddServerModal />
      <LeaveServerModal />
      <Settings />
      <ServerSettings />
      <ScreenPicker />
      <CameraPicker />
      <VerifyModal />
      <ProfileCard />
      <Lightbox />
      <UserMenu />
      <ScreenMenu />
      <StreamMenu />
      <PlaceMenu />
      <ImageMenuView />
    </>
  );
}

export { Chat };
