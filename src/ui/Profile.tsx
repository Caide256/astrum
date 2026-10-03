import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  access,
  app,
  bannerOf,
  canDisconnectFromCall,
  closeUserMenu,
  copyText,
  deleteDirect,
  displayName,
  disconnectFromCall,
  me,
  openDirectWith,
  openProfile,
  profileOf,
  serverAdmin,
  setStatusMode,
  type StatusMode,
} from "../app.ts";
import { t, type Key } from "../i18n/index.ts";
import { maxGrant } from "../matrix/admin.ts";
import { isMuted, setMuted, useMutes } from "../prefs.ts";
import { useStore } from "../store.ts";
import { voice } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { Banner } from "./Banner.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import {
  IconBell,
  IconBellOff,
  IconChat,
  IconChevron,
  IconCopy,
  IconDoorOut,
  IconShield,
  IconSpeaker,
  IconTrash,
  IconUser,
  IconVolume,
} from "./icons.tsx";

const PRESENCE_NAME: Record<string, Key> = {
  online: "presence.online",
  unavailable: "presence.away",
  dnd: "presence.dnd",
  streamer: "presence.streamer",
  offline: "presence.offline",
};

const STATUS_MODES: { mode: StatusMode; title: Key }[] = [
  { mode: "auto", title: "presence.online" },
  { mode: "unavailable", title: "presence.away" },
  { mode: "dnd", title: "presence.dnd" },
  { mode: "streamer", title: "status.streamer" },
  { mode: "offline", title: "status.invisible" },
];

/** Own status: a drop-down with every mode. */
function StatusPicker() {
  const mode = useStore(app, (s) => s.statusMode);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = STATUS_MODES.find((m) => m.mode === mode) ?? STATUS_MODES[0];
  useEscape(open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="status-pick" ref={box}>
      <button className={`status-current ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
        <i className={`status-chip ${current.mode === "auto" ? "online" : current.mode}`} />
        <span className="grow">{t(current.title)}</span>
        <IconChevron />
      </button>
      {open && (
        <div className="status-list" role="listbox">
          {STATUS_MODES.map((m) => (
            <button
              key={m.mode}
              role="option"
              aria-selected={m.mode === mode}
              className={`status-option ${m.mode === mode ? "on" : ""}`}
              onClick={() => {
                setStatusMode(m.mode);
                setOpen(false);
              }}
            >
              <i className={`status-chip ${m.mode === "auto" ? "online" : m.mode}`} />
              <span className="status-text">{t(m.title)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Volume slider for one person: local only, the person does not know. */
function VolumeRow({ userId }: { userId: string }) {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const member = state.members.find((m) => m.userId === userId && !m.local);
  if (!member) return null;

  return (
    <div className="menu-volume">
      <label>
        <IconVolume />
        <span>{t("profile.volume")}</span>
        <b>{member.localMuted ? t("profile.volumeOff") : `${member.volume}%`}</b>
      </label>
      <input
        type="range"
        min={0}
        max={200}
        step={1}
        value={member.localMuted ? 0 : member.volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          voice.setUserVolume(userId, v);
          if (member.localMuted && v > 0) voice.setUserMuted(userId, false);
        }}
      />
      <button className={`ghost small ${member.localMuted ? "on" : ""}`} onClick={() => voice.setUserMuted(userId, !member.localMuted)}>
        {member.localMuted ? t("profile.unmuteLocal") : t("profile.muteLocal")}
      </button>
    </div>
  );
}

/**
 * Moderation right from the menu: role, kick, ban. Only for those with the
 * rights, and only over people below them: the server refuses otherwise.
 */
function ModerationRows({ userId }: { userId: string }) {
  const spaceId = useStore(app, (s) => s.activeServer);
  const view = useStore(app, (s) => s.view);
  const tick = useStore(app, (s) => s.tick);
  const [acting, setActing] = useState<"kick" | "ban" | null>(null);
  const [reason, setReason] = useState("");
  void tick;

  if (view !== "server" || !spaceId || userId === me()) return null;
  const can = access(spaceId);
  const level = serverAdmin.levelOf(spaceId, userId);
  if (level >= can.level || !(can.roles || can.kick || can.ban)) return null;
  // only the owner appoints or demotes admins
  const grant = maxGrant(can.level, serverAdmin.owner(spaceId) === me());
  const rolesHere = can.roles && level <= grant;

  const run = async () => {
    const ok = acting === "kick" ? await serverAdmin.kick(spaceId, userId, reason) : await serverAdmin.ban(spaceId, userId, reason);
    if (ok) closeUserMenu();
  };

  return (
    <div className="menu-admin">
      {rolesHere && (
        <div className="menu-roles">
          <IconShield />
          {serverAdmin
            .roles(spaceId)
            .filter((r) => r.level <= grant)
            .reverse()
            .map((r) => (
              <button
                key={r.level}
                className={`ghost small ${level === r.level ? "on-soft" : ""}`}
                style={r.color ? { color: r.color } : undefined}
                onClick={() => void serverAdmin.setRole(spaceId, userId, r.level)}
              >
                {r.name}
              </button>
            ))}
        </div>
      )}

      {acting ? (
        <div className="menu-reason">
          <input
            autoFocus
            value={reason}
            placeholder={t("profile.reason")}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
          <div className="row gap-top">
            <button className="ghost small" onClick={() => setActing(null)}>
              {t("common.cancel")}
            </button>
            <button className="danger small" onClick={() => void run()}>
              {acting === "kick" ? t("members.kick") : t("members.banAction")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {can.kick && (
            <button className="menu-item" onClick={() => setActing("kick")}>
              <span className="danger-text">{t("profile.kickFromServer")}</span>
            </button>
          )}
          {can.ban && (
            <button className="menu-item" onClick={() => setActing("ban")}>
              <span className="danger-text">{t("members.banAction")}</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- right-click menu */

/** In the same call: a moderator can make the person leave it. */
function VoiceKickRow({ userId }: { userId: string }) {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const [asking, setAsking] = useState(false);
  const here = state.members.some((m) => m.userId === userId && !m.local);
  if (!here || !canDisconnectFromCall(userId)) return null;
  return asking ? (
    <div className="menu-reason">
      <span className="state">{t("voice.kickConfirm", { who: displayName(userId) })}</span>
      <div className="row gap-top">
        <button className="ghost small" onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </button>
        <button className="danger small" onClick={() => void disconnectFromCall(userId)}>
          {t("voice.kick")}
        </button>
      </div>
    </div>
  ) : (
    <button className="menu-item" onClick={() => setAsking(true)}>
      <IconDoorOut />
      <span className="danger-text">{t("voice.kick")}</span>
    </button>
  );
}

/** Opened on a direct chat: delete it, after a confirmation right in the menu. */
function DeleteDirectRow({ roomId, name }: { roomId: string; name: string }) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <div className="menu-reason">
      <span className="state">{t("dm.deleteConfirm", { name })}</span>
      <div className="row gap-top">
        <button className="ghost small" onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </button>
        <button
          className="danger small"
          onClick={() => {
            closeUserMenu();
            void deleteDirect(roomId);
          }}
        >
          {t("common.delete")}
        </button>
      </div>
    </div>
  ) : (
    <button className="menu-item" onClick={() => setAsking(true)}>
      <IconTrash />
      <span className="danger-text">{t("dm.delete")}</span>
    </button>
  );
}

export function UserMenu() {
  const menu = useStore(app, (s) => s.userMenu);
  const directs = useStore(app, (s) => s.directs);
  useMutes();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEscape(!!menu, closeUserMenu);

  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    // keep the menu inside the window
    const rect = box.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8),
    });
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    window.addEventListener("resize", closeUserMenu);
    return () => window.removeEventListener("resize", closeUserMenu);
  }, [menu]);

  if (!menu) return null;

  const name = displayName(menu.userId, menu.roomId);
  const own = menu.userId === me();
  const direct = directs.find((d) => d.roomId === menu.roomId && d.userId === menu.userId);

  return (
    <div className="menu-back" onClick={closeUserMenu} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu" ref={box} style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
        <div className="menu-head ellipsis">{name}</div>

        <button className="menu-item" onClick={() => openProfile(menu.userId)}>
          <IconUser />
          <span>{t("profile.open")}</span>
        </button>

        {!own && (
          <button className="menu-item" onClick={() => void openDirectWith(menu.userId)}>
            <IconChat />
            <span>{t("profile.message")}</span>
          </button>
        )}


        {!own && menu.voice && <VolumeRow userId={menu.userId} />}
        {!own && menu.voice && <VoiceKickRow userId={menu.userId} />}

        {!own && (
          <button className="menu-item" onClick={() => setMuted("users", menu.userId, !isMuted("users", menu.userId))}>
            {isMuted("users", menu.userId) ? <IconBell /> : <IconBellOff />}
            <span>{isMuted("users", menu.userId) ? t("mutes.unmuteUser") : t("mutes.muteUser")}</span>
          </button>
        )}

        <button
          className="menu-item"
          onClick={() => {
            copyText(menu.userId);
            closeUserMenu();
          }}
        >
          <IconCopy />
          <span>{t("profile.copyId")}</span>
        </button>

        <ModerationRows userId={menu.userId} />

        {direct && !own && <DeleteDirectRow roomId={direct.roomId} name={direct.name} />}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- card */

export function ProfileCard() {
  const live = useStore(app, (s) => s.profileUser);
  // the card fades out, so the last shown person is kept
  const { shown: userId, closing } = useLinger(live);
  const activeChannel = useStore(app, (s) => s.activeChannel);
  const fromVoice = useStore(app, (s) => s.profileVoice);
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const close = () => app.set({ profileUser: null });
  useEscape(!!live, close);

  if (!userId) return null;

  const info = profileOf(userId, activeChannel);
  const member = state.members.find((m) => m.userId === userId);
  // without a banner of their own the avatar gives the color, as in Discord
  const look = info.deleted ? null : (bannerOf(userId, activeChannel) ?? { mode: "dominant" as const, color: "" });

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal profile" onClick={(e) => e.stopPropagation()}>
        <Banner look={look} avatar={info.avatar} className="profile-banner" />
        <div className="profile-top">
          <Avatar mxc={info.avatar} name={info.name} size={72} status={info.presence} className="profile-avatar" />
          <div className="profile-id">
            <h2 className="ellipsis">{info.name}</h2>
            <div className="state ellipsis sensitive">{info.userId}</div>
            {info.deleted ? (
              <div className="presence offline">{t("people.deletedHint")}</div>
            ) : (
              <div className={`presence ${info.presence}`}>{t(PRESENCE_NAME[info.presence])}</div>
            )}
          </div>
        </div>

        {info.own && <StatusPicker />}

        <dl className="profile-facts">
          <div className="sensitive">
            <dt>{t("profile.homeserver")}</dt>
            <dd>{info.server}</dd>
          </div>
          <div>
            <dt>{info.inServer ? t("profile.serverRole") : t("profile.chatRights")}</dt>
            <dd>
              {info.role}
              {info.power && ![50, 75, 100].includes(info.power) ? ` ${t("profile.level", { level: info.power })}` : ""}
            </dd>
          </div>
          {info.voiceChannel && (
            <div>
              <dt>{t("profile.inVoice")}</dt>
              <dd>
                <IconSpeaker /> {info.voiceChannel}
              </dd>
            </div>
          )}
          {member && (
            <div>
              <dt>{t("profile.microphone")}</dt>
              <dd>{member.deafened ? t("profile.deafened") : member.muted ? t("profile.micOff") : t("profile.micOn")}</dd>
            </div>
          )}
        </dl>

        {member && !member.local && fromVoice && <VolumeRow userId={userId} />}

        <div className="row">
          <button className="ghost" onClick={() => copyText(info.userId)}>
            {t("profile.copyId")}
          </button>
          {!info.own && (
            <button className="primary" onClick={() => void openDirectWith(userId)}>
              {t("profile.message")}
            </button>
          )}
          {info.own && (
            <button className="primary" onClick={() => app.set({ profileUser: null, settingsOpen: true, settingsTab: "profile" })}>
              {t("profile.edit")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
