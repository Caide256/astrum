import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  access,
  app,
  canDisconnectFromCall,
  closeUserMenu,
  copyText,
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
import { ROLES } from "../matrix/admin.ts";
import { isMuted, setMuted, useMutes } from "../prefs.ts";
import { useStore } from "../store.ts";
import { voice } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import { IconBell, IconBellOff, IconChat, IconCopy, IconDoorOut, IconShield, IconSpeaker, IconUser, IconVolume } from "./icons.tsx";

const PRESENCE_NAME: Record<string, Key> = {
  online: "presence.online",
  unavailable: "presence.away",
  offline: "presence.offline",
};

const STATUS_MODES: { mode: StatusMode; title: Key; hint: Key }[] = [
  { mode: "auto", title: "presence.online", hint: "status.auto.hint" },
  { mode: "unavailable", title: "presence.away", hint: "status.away.hint" },
  { mode: "offline", title: "status.invisible", hint: "status.invisible.hint" },
];

/** Own status: automatic, away, or invisible. */
function StatusPicker() {
  const mode = useStore(app, (s) => s.statusMode);
  const current = STATUS_MODES.find((m) => m.mode === mode) ?? STATUS_MODES[0];
  return (
    <div className="status-pick">
      <div className="seg">
        {STATUS_MODES.map((m) => (
          <button key={m.mode} className={m.mode === mode ? "on" : ""} onClick={() => setStatusMode(m.mode)}>
            <i className={`status-chip ${m.mode === "auto" ? "online" : m.mode}`} />
            {t(m.title)}
          </button>
        ))}
      </div>
      <div className="state">{t(current.hint)}</div>
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

  const run = async () => {
    const ok = acting === "kick" ? await serverAdmin.kick(spaceId, userId, reason) : await serverAdmin.ban(spaceId, userId, reason);
    if (ok) closeUserMenu();
  };

  return (
    <div className="menu-admin">
      {can.roles && (
        <div className="menu-roles">
          <IconShield />
          {ROLES.filter((r) => r.level < can.level).map((r) => (
            <button
              key={r.level}
              className={`ghost small ${level === r.level ? "on-soft" : ""}`}
              onClick={() => void serverAdmin.setRole(spaceId, userId, r.level)}
            >
              {t(r.key)}
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

export function UserMenu() {
  const menu = useStore(app, (s) => s.userMenu);
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

        {!own && <VolumeRow userId={menu.userId} />}
        {!own && <VoiceKickRow userId={menu.userId} />}

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
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const close = () => app.set({ profileUser: null });
  useEscape(!!live, close);

  if (!userId) return null;

  const info = profileOf(userId, activeChannel);
  const member = state.members.find((m) => m.userId === userId);

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal profile" onClick={(e) => e.stopPropagation()}>
        <div className="profile-top">
          <Avatar mxc={info.avatar} name={info.name} size={72} status={info.presence} className="profile-avatar" />
          <div className="profile-id">
            <h2 className="ellipsis">{info.name}</h2>
            <div className="state ellipsis">{info.userId}</div>
            <div className={`presence ${info.presence}`}>{t(PRESENCE_NAME[info.presence])}</div>
          </div>
        </div>

        {info.own && <StatusPicker />}

        <dl className="profile-facts">
          <div>
            <dt>{t("profile.homeserver")}</dt>
            <dd>{info.server}</dd>
          </div>
          <div>
            <dt>{info.inServer ? t("profile.serverRole") : t("profile.chatRights")}</dt>
            <dd>
              {info.role}
              {info.power && ![50, 100].includes(info.power) ? ` ${t("profile.level", { level: info.power })}` : ""}
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

        {member && !member.local && <VolumeRow userId={userId} />}

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
