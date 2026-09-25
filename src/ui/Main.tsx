import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type MouseEvent, type UIEvent } from "react";

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
  closeUserMenu,
  declineInvite,
  deleteMessage,
  discard,
  displayName,
  jumpTo,
  leaveVoice,
  loadMore,
  markRoomRead,
  markServerRead,
  me,
  mediaUrl,
  openChat,
  openDirectWith,
  openImage,
  openPlaceMenu,
  openProfile,
  openServerSettings,
  openUserMenu,
  presenceOf,
  presenceWorks,
  previewServer,
  resend,
  roomMuted,
  runSearch,
  screenButton,
  searchPeople,
  searchPeopleNow,
  selectChannel,
  selectServer,
  showCall,
  showDirects,
  startEdit,
  startReply,
  toggleCamera,
  toggleCheck,
  toggleMembers,
  toggleReaction,
  type Media,
  type Message,
} from "../app.ts";
import { fmtDateTime, fmtTime, t, tn } from "../i18n/index.ts";
import { encryptedMediaUrl } from "../media.ts";
import type { UserHit } from "../matrix/people.ts";
import { isMuted, setMuted, useMutes } from "../prefs.ts";
import type { Channel, Server } from "../matrix/servers.ts";
import { useStore } from "../store.ts";
import { voice, type VoiceMember } from "../voice/voice.ts";
import { Avatar, initials } from "./Avatar.tsx";
import { CallView } from "./CallView.tsx";
import { CameraPicker } from "./CameraPicker.tsx";
import { Composer, attachFiles, humanSize } from "./Composer.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { Markdown } from "./Markdown.tsx";
import { ScreenMenu, StreamMenu, StreamPeek, peekEnter, peekLeave } from "./Menus.tsx";
import { MiniStream } from "./MiniStream.tsx";
import { ProfileCard, UserMenu } from "./Profile.tsx";
import { ServerSettings } from "./ServerSettings.tsx";
import { Settings } from "./Settings.tsx";
import { ScreenPicker } from "./Stage.tsx";
import { VerifyModal } from "./VerifyModal.tsx";
import {
  IconBell,
  IconBellOff,
  IconChat,
  IconChevron,
  IconClip,
  IconClose,
  IconEdit,
  IconEye,
  IconGear,
  IconHangup,
  IconHash,
  IconHeadset,
  IconHeadsetOff,
  IconHome,
  IconMarkRead,
  IconMic,
  IconMicOff,
  IconPlay,
  IconPlus,
  IconReply,
  IconScreen,
  IconScreenOff,
  IconSearch,
  IconSmile,
  IconSpeaker,
  IconTrash,
  IconUsers,
  IconVideo,
  IconVideoOff,
  IconVolume,
} from "./icons.tsx";

/** Right click on a person opens the user menu. */
function menuHandler(userId: string, roomId: string | null = null) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openUserMenu(userId, e.clientX, e.clientY, roomId);
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
      title={live ? undefined : userId}
      onClick={() => openProfile(userId)}
      onContextMenu={menuHandler(userId, roomId)}
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
        const mentions = g.channels.reduce((n, c) => n + (c.kind === "text" ? c.mentions : 0), 0);
        const fresh = !muted && g.channels.some((c) => c.kind === "text" && c.unread > 0 && !roomMuted(c.roomId));
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
          title={u.userId}
          onClick={() => {
            onDone();
            void openDirectWith(u.userId);
          }}
        >
          <Avatar mxc={u.avatar} name={u.name} size={24} />
          <span className="grow ellipsis">
            <span className="ellipsis">{u.name}</span>
            <span className="hit-id ellipsis">{u.userId}</span>
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
                  <button className="icon live" title={t("common.accept")} onClick={() => void acceptInvite(inv)}>
                    <IconPlus />
                  </button>
                  <button className="ghost icon" title={t("common.decline")} onClick={() => void declineInvite(inv.roomId)}>
                    <IconClose />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="group-title">{t("dm.title")}</div>
          {directs.length === 0 && <div className="state pad">{t("dm.empty")}</div>}
          {directs.map((d) => (
            <button
              key={d.roomId}
              className={`channel direct ${d.roomId === activeChannel ? "active" : ""} ${isMuted("users", d.userId) ? "muted" : ""}`}
              onClick={() => void openChat(d.roomId)}
              onContextMenu={menuHandler(d.userId, d.roomId)}
            >
              <Avatar mxc={d.avatar} name={d.name} size={24} status={presenceOf(d.userId)} />
              <span className="ellipsis">{d.name}</span>
              {isMuted("users", d.userId) && <IconBellOff className="mute-mark" />}
              {d.unread > 0 && <span className="count">{d.unread}</span>}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ channel list */

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
  const server = servers.find((g) => g.spaceId === activeServer);
  const textChannels = server ? server.channels.filter((c) => c.kind === "text") : loose;
  const voiceChannels = server ? server.channels.filter((c) => c.kind === "voice") : [];
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
    const fresh = c.kind === "text" && c.unread > 0 && c.roomId !== activeChannel;
    return (
    <div key={c.roomId}>
      <div className="channel-row">
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
          {muted && <IconBellOff className="mute-mark" />}
          {c.mentions > 0 ? (
            <span className="count">{c.mentions}</span>
          ) : (
            c.unread > 0 && c.kind === "text" && !muted && <span className="count soft">{c.unread}</span>
          )}
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

  const addButton = (kind: "text" | "voice") => (
    <button className="channel" onClick={() => setCreating(kind)}>
      <span className="sigil">
        <IconPlus />
      </span>
      <span>{t("channels.create")}</span>
    </button>
  );

  return (
    <section className="channels">
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

          {creating && (
            <form onSubmit={create} className="create-channel">
              <input
                autoFocus
                value={name}
                placeholder={creating === "voice" ? t("channels.voiceName") : t("channels.textName")}
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
          )}
        </div>
      )}

      <VoiceDock />
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

  const channelName = servers.flatMap((g) => g.channels).find((c) => c.roomId === voiceChannel)?.name;
  const ptt = state.settings.inputMode === "ptt";

  return (
    <div className="dock">
      {voiceChannel && (
        <>
          <span className="state">
            {state.connected ? <b>{t("dock.connected")}</b> : t("dock.connecting")}
            {channelName ? ` · ${channelName}` : ""}
          </span>

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
            <button className="icon hangup" title={t("call.leave")} onClick={() => void leaveVoice()}>
              <IconHangup />
            </button>
          </div>
        </>
      )}

      <div className="me-bar">
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

        <button
          className={`icon ${state.muted ? "on" : ""}`}
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

/* -------------------------------------------------------------------- media */

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
  a.download = media.name;
  a.click();
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
      <button className="media" style={box} onClick={() => openImage(url, media.name)} title={t("chat.openImage")}>
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

const PICKER_W = 352;
const PICKER_H = 392;

function MessageRow({ m, roomId, lit }: { m: Message; roomId: string | null; lit: boolean }) {
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

  return (
    <div className={`msg ${lit ? "lit" : ""} ${m.state}`} ref={box} id={`msg-${m.id}`}>
      <Avatar
        mxc={m.avatar}
        name={m.senderName}
        size={34}
        className="clickable"
        onClick={() => openProfile(m.sender)}
        onContextMenu={menuHandler(m.sender, roomId)}
      />
      <div className="msg-body">
        {m.reply && (
          <div className="quote">
            <IconReply />
            <b>{m.reply.senderName}</b>
            <span className="ellipsis">{m.reply.body}</span>
          </div>
        )}
        <div>
          <span className="who clickable" onClick={() => openProfile(m.sender)} onContextMenu={menuHandler(m.sender, roomId)}>
            {m.senderName}
          </span>
          <span className="when">{fmtTime(m.ts)}</span>
          {m.edited && <span className="when">{t("chat.edited")}</span>}
        </div>
        {text && (
          <div className={`body ${m.locked ? "locked" : ""} ${isJumbo(text) ? "jumbo" : ""}`}>
            {m.locked || isJumbo(text) ? (
              <RichText text={text} />
            ) : (
              <Markdown
                text={text}
                checks={m.checks}
                onToggle={m.state === "sent" ? (key, done) => void toggleCheck(m.id, key, done) : undefined}
                whoName={(u) => displayName(u, roomId)}
              />
            )}
          </div>
        )}
        {m.media && <MessageMedia media={m.media} />}

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
}

/* --------------------------------------------------------------------- chat */

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

  const [dragging, setDragging] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const direct = directs.find((d) => d.roomId === activeChannel);
  const channel =
    servers.flatMap((g) => g.channels).find((c) => c.roomId === activeChannel) ?? loose.find((c) => c.roomId === activeChannel);
  const title = direct?.name ?? channel?.name ?? activeChannel ?? "";
  const voiceHere = channel?.kind === "voice";

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeChannel]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
          <MuteBell roomId={activeChannel} userId={direct?.userId ?? ""} tight={voiceHere && activeChannel === voiceChannel} />
        )}
        {!embedded && (
        <button
          className={`ghost icon head-tool tight ${searchOpen ? "on-soft" : ""}`}
          title={t("chat.search")}
          onClick={() => app.set({ searchOpen: !searchOpen, searchHits: [] })}
        >
          <IconSearch />
        </button>
        )}
        {!searchOpen && !embedded && (
          <button
            className={`ghost icon head-tool tight ${membersHidden ? "" : "on-soft"}`}
            title={membersHidden ? t("chat.showMembers") : t("chat.hideMembers")}
            onClick={toggleMembers}
          >
            <IconUsers />
          </button>
        )}
      </div>

      <div className="timeline" key={`timeline-${activeChannel}`} ref={scroller} onScroll={onScroll}>
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} roomId={activeChannel} lit={highlight === m.id} />
        ))}
        <div ref={bottom} />
      </div>

      {dragging && <div className="drop-hint">{t("chat.dropHint")}</div>}

      <div className="typing">{typingLine(typing)}</div>

      <Composer key={`composer-${activeChannel}`} roomId={activeChannel} title={title} />
    </main>
  );
}

/** The bell in a chat header: silence this chat, or the person in a direct chat. */
function MuteBell({ roomId, userId, tight }: { roomId: string; userId: string; tight: boolean }) {
  useMutes();
  const kind = userId ? "users" : "rooms";
  const id = userId || roomId;
  const muted = isMuted(kind, id);
  return (
    <button
      className={`ghost icon head-tool ${tight ? "tight" : ""} ${muted ? "on-soft" : ""}`}
      title={muted ? t("mutes.unmuteChat") : t("mutes.muteChat")}
      onClick={() => setMuted(kind, id, !muted)}
    >
      {muted ? <IconBellOff /> : <IconBell />}
    </button>
  );
}

/* --------------------------------------------------------------- place menu */

/** Right click on a channel or a server icon: notifications, read state, settings. */
function PlaceMenu() {
  const menu = useStore(app, (s) => s.placeMenu);
  const servers = useStore(app, (s) => s.servers);
  useMutes();
  useEscape(!!menu, closePlaceMenu);
  if (!menu) return null;

  const server = menu.kind === "server" ? servers.find((g) => g.spaceId === menu.id) : servers.find((g) => g.channels.some((c) => c.roomId === menu.id));
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
        style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 200) }}
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
        {menu.kind === "server" && (
          <button className="menu-item" onClick={run(() => (selectServer(menu.id), openServerSettings()))}>
            <IconGear />
            <span>{t("server.settings")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- search */

function SearchPanel() {
  const hits = useStore(app, (s) => s.searchHits);
  const searching = useStore(app, (s) => s.searching);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const [term, setTerm] = useState("");

  return (
    <aside className="members search-panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(term);
        }}
      >
        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t("search.placeholder")} />
      </form>
      <div className="state search-state">
        {searching ? t("search.searching") : hits.length ? tn("search.found", hits.length) : t("search.hint")}
      </div>
      {hits.map((h) => (
        <button key={h.eventId} className="hit" onClick={() => void jumpTo(h.eventId)}>
          <div>
            <b>{displayName(h.sender, activeChannel)}</b>
            <span className="when">{fmtDateTime(h.ts)}</span>
          </div>
          <div className="hit-body">{h.body}</div>
        </button>
      ))}
    </aside>
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
      title={m.userId}
      onClick={() => openProfile(m.userId)}
      onContextMenu={menuHandler(m.userId, activeChannel)}
    >
      <Avatar mxc={m.avatar} name={m.name} size={30} status={split ? m.presence : null} />
      <span className="ellipsis">{m.name}</span>
      {(m.owner || m.power >= 50) && (
        <span className={`badge ${m.owner ? "owner" : m.power >= 100 ? "admin" : ""}`}>
          {m.owner ? t("role.owner") : m.power >= 100 ? t("role.admin") : t("role.mod")}
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
  const [domain, setDomain] = useState("");
  const { shown, closing } = useLinger(open);
  const close = () => app.set({ addServerOpen: false, serverCard: null, error: "" });
  useEscape(open, close);

  if (!shown) return null;

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("server.add.title")}</h2>
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

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => {
      if (app.get().error === error) app.set({ error: "" });
    }, ERROR_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  if (!busy && !error) return null;
  return (
    <div className={`toast ${error ? "bad" : ""}`}>
      {error ? (
        <>
          <span className="toast-text">{error}</span>
          <button className="ghost icon tiny" title={t("common.close")} onClick={() => app.set({ error: "" })}>
            <IconClose />
          </button>
        </>
      ) : (
        busy
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
  const searchOpen = useStore(app, (s) => s.searchOpen);
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
            {searchOpen && activeChannel ? <SearchPanel /> : !membersHidden && <Members />}
          </>
        )}
      </div>
      <MiniStream />
      <StreamPeek />
      <Toast />
      <OfflineBar />
      <AddServerModal />
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
    </>
  );
}

export { Chat };
