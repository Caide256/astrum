import { useEffect, useRef, useState } from "react";

import {
  access,
  app,
  closeServerJoin,
  copyText,
  displayName,
  hideChannel,
  inviteToServer,
  makeServerAddress,
  me,
  openProfile,
  openServerJoin,
  serverAdmin,
  serverJoinRule,
  setServerProfile,
  showChannel,
  type ServerTab,
} from "../app.ts";
import { t, tn, type Key } from "../i18n/index.ts";
import { ADMIN_LEVEL, OWNER_LEVEL, PERM_NAMES, levelAbove, maxGrant, type ChannelAccess, type Perms, type RoleDef } from "../matrix/admin.ts";
import { GUESSES } from "../matrix/discovery.ts";
import { compareChannels, type BrowseChannel, type Channel, type Server } from "../matrix/servers.ts";
import { useServerProfiles } from "../prefs.ts";
import { useStore } from "../store.ts";
import { Avatar } from "./Avatar.tsx";
import { Cropper } from "./Cropper.tsx";
import { SoundsTab } from "./Soundboard.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import { IconCheck, IconChevron, IconCopy, IconDoorOut, IconHash, IconRefresh, IconSpeaker, IconTrash } from "./icons.tsx";

/** A copy button that says it worked. */
function CopyButton({ text, label, className = "ghost small" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      title={t("common.copy")}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        })
      }
    >
      {done ? <IconCheck /> : <IconCopy />} {done ? t("common.copied") : label}
    </button>
  );
}

/** Invite a person by the full address: the invite appears under their home button. */
function InviteBox({ server }: { server: Server }) {
  const [who, setWho] = useState("");
  const [sent, setSent] = useState("");
  const can = access(server.spaceId);
  const perms = serverAdmin.perms(server.spaceId);
  if (!perms || can.level < perms.invite) return null;

  const send = async () => {
    if (await inviteToServer(server.spaceId, who)) {
      setSent(who.trim());
      setWho("");
    }
  };

  return (
    <div className="field">
      <label>{t("invite.title")}</label>
      <div className="with-button">
        <input
          value={who}
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder="@username:example.org"
        />
        <button className="primary" disabled={!who.trim()} onClick={() => void send()}>
          {t("invite.send")}
        </button>
      </div>
      <span className="state">{sent ? t("invite.sent", { who: sent }) : t("invite.hint")}</span>
    </div>
  );
}

/** Server address, so friends can add the server by domain. */
function AddressBox({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const [local, setLocal] = useState("main");
  const alias = serverAdmin.alias(server.spaceId);
  const domain = alias.split(":").slice(1).join(":");
  const local0 = alias.slice(1).split(":")[0];
  const open = serverJoinRule(server.spaceId) === "public";
  // a bare domain finds the server only if the alias is one the client guesses
  const guessable = GUESSES.includes(local0);

  return (
    <div className="field">
      <label>{t("address.title")}</label>
      {alias ? (
        <>
          <div className="note sensitive-blur">
            {guessable ? t("address.byDomain", { domain, alias }) : t("address.byAlias", { alias })}{" "}
            {open ? t("address.open") : t("address.closed")}
          </div>
          {can.server && (
            <div className="row left">
              {open ? (
                <button className="ghost small" onClick={() => void closeServerJoin(server.spaceId)}>
                  {t("address.closeJoin")}
                </button>
              ) : (
                <button className="ghost small" onClick={() => void openServerJoin(server.spaceId)}>
                  {t("address.openJoin")}
                </button>
              )}
            </div>
          )}
        </>
      ) : can.server ? (
        <>
          <div className="note">{t("address.none")}</div>
          <div className="with-button">
            <input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="main" />
            <button className="primary" disabled={!local.trim()} onClick={() => void makeServerAddress(server.spaceId, local)}>
              {t("address.create")}
            </button>
          </div>
        </>
      ) : (
        <div className="note">{t("address.noneNoRights")}</div>
      )}
    </div>
  );
}

/**
 * Channel permissions lag behind server roles. Whoever can fix it gets an
 * "align" button, the others get an explanation whom to ask.
 */
function DriftNote({ server }: { server: Server }) {
  const drift = serverAdmin.drift(server.spaceId);
  const self = me();
  if (!drift.length) return null;

  const mine = drift.filter((d) => d.users.some((u) => u.userId === self && u.want > u.have));
  const fixable = drift.filter((d) => d.canFix);
  const people = new Set(drift.flatMap((d) => d.users.map((u) => u.userId)));

  if (fixable.length) {
    return (
      <div className="drift">
        <div>
          <b>{t("drift.title")}</b>
          <div className="state">{t("drift.text", { channels: drift.length, people: people.size })}</div>
        </div>
        <button className="primary" onClick={() => void serverAdmin.syncRoles(server.spaceId)}>
          {t("drift.fix")}
        </button>
      </div>
    );
  }
  if (mine.length) {
    return (
      <div className="drift">
        <div>
          <b>{t("drift.mine.title")}</b>
          <div className="state">{t("drift.mine.text", { channels: mine.map((d) => d.name).join(", ") })}</div>
        </div>
      </div>
    );
  }
  return null;
}

function RoleSelect({
  value,
  max,
  onPick,
  disabled,
  list,
  title,
}: {
  value: number;
  max: number;
  onPick: (level: number) => void;
  disabled?: boolean;
  list: { level: number; label: string }[];
  title?: string;
}) {
  // roles above what this user may hand out are shown but disabled
  const known = list.find((r) => r.level === value);
  return (
    <select value={value} disabled={disabled} title={title} onChange={(e) => onPick(Number(e.target.value))}>
      {!known && <option value={value}>{legacyName(value)}</option>}
      {list.map((r) => (
        <option key={r.level} value={r.level} disabled={r.level > max && r.level !== value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

/** Roles of a server as select options. */
function roleOptions(roles: RoleDef[]): { level: number; label: string }[] {
  return roles.map((r) => ({ level: r.level, label: r.name }));
}

/** A level outside the list: an admin at 100 from older servers, or a custom one. */
function legacyName(level: number): string {
  if (level >= 100) return t("role.adminLegacy");
  return t("role.custom", { level });
}

/* ----------------------------------------------------------------- overview */

function Overview({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const [name, setName] = useState(server.name);
  const [topic, setTopic] = useState(serverAdmin.topicOf(server.spaceId));
  const alias = serverAdmin.alias(server.spaceId);
  const [crop, setCrop] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => setName(server.name), [server.name]);

  return (
    <>
      <div className="profile-top">
        <Avatar mxc={server.avatar} name={server.name} size={72} className="square-avatar" />
        <div className="profile-id">
          <b className="ellipsis">{server.name}</b>
          <div className="server-address">
            {alias ? (
              <>
                <span className="state ellipsis sensitive" title={alias}>
                  {alias}
                </span>
                <CopyButton text={alias} className="ghost icon tiny sensitive" />
              </>
            ) : (
              <span className="state">{t("address.noneShort")}</span>
            )}
          </div>
          {can.server && (
            <div className="row left tight-top">
              <button className="ghost small" onClick={() => file.current?.click()}>
                {t("profile.changePicture")}
              </button>
              {server.avatar && (
                <button className="ghost small" onClick={() => void serverAdmin.avatar(server.spaceId, null)}>
                  {t("profile.removePicture")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <DriftNote server={server} />

      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setCrop(f);
          e.target.value = "";
        }}
      />

      {crop && (
        <Cropper
          file={crop}
          round={false}
          onCancel={() => setCrop(null)}
          onDone={(f) => {
            setCrop(null);
            void serverAdmin.avatar(server.spaceId, f);
          }}
        />
      )}

      <div className="field">
        <label>{t("server.name")}</label>
        <div className="with-button">
          <input value={name} disabled={!can.server} onChange={(e) => setName(e.target.value)} />
          {can.server && (
            <button className="primary" disabled={!name.trim() || name === server.name} onClick={() => void serverAdmin.rename(server.spaceId, name)}>
              {t("common.save")}
            </button>
          )}
        </div>
      </div>

      <div className="field">
        <label>{t("server.description")}</label>
        <div className="with-button">
          <input value={topic} disabled={!can.server} placeholder={t("server.description.placeholder")} onChange={(e) => setTopic(e.target.value)} />
          {can.server && (
            <button className="primary" onClick={() => void serverAdmin.topic(server.spaceId, topic)}>
              {t("common.save")}
            </button>
          )}
        </div>
      </div>

      <AddressBox server={server} />
      <InviteBox server={server} />

      <div className="section-title">{t("server.leave.section")}</div>
      <div className="row left">
        <button className="danger" onClick={() => app.set({ leaveServerAsk: server.spaceId })}>
          <IconDoorOut /> {t("server.leave")}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------- own server profile */

/**
 * The own name and picture on this server only. Other Matrix clients show
 * them too: it is the per-room name of the standard membership event.
 */
function MyServerProfile({ server }: { server: Server }) {
  const profiles = useServerProfiles();
  const own = profiles[server.spaceId];
  const myName = useStore(app, (s) => s.myName);
  const myAvatar = useStore(app, (s) => s.myAvatar);
  const [name, setName] = useState(own?.name ?? "");
  const [crop, setCrop] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setName(own?.name ?? ""), [server.spaceId, own?.name]);
  const avatar = own?.avatar || myAvatar;

  return (
    <>
      <p className="sub">{t("serverProfile.intro")}</p>
      <div className="profile-top">
        <Avatar mxc={avatar} name={name.trim() || myName || "?"} size={72} />
        <div className="profile-id">
          <b className="ellipsis">{name.trim() || myName}</b>
          <div className="state">{own ? t("serverProfile.own") : t("serverProfile.global")}</div>
          <div className="row left tight-top">
            <button className="ghost small" onClick={() => file.current?.click()}>
              {t("serverProfile.picture")}
            </button>
            {own?.avatar && (
              <button className="ghost small" onClick={() => void setServerProfile(server.spaceId, own.name, null)}>
                {t("serverProfile.pictureReset")}
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setCrop(f);
          e.target.value = "";
        }}
      />
      {crop && (
        <Cropper
          file={crop}
          onCancel={() => setCrop(null)}
          onDone={(f) => {
            setCrop(null);
            void setServerProfile(server.spaceId, own?.name ?? "", f);
          }}
        />
      )}

      <div className="field">
        <label>{t("serverProfile.name")}</label>
        <div className="with-button">
          <input value={name} maxLength={64} placeholder={myName} onChange={(e) => setName(e.target.value)} />
          <button
            className="primary"
            disabled={name.trim() === (own?.name ?? "")}
            onClick={() => void setServerProfile(server.spaceId, name, own?.avatar || null)}
          >
            {t("common.save")}
          </button>
        </div>
        <span className="state">{t("serverProfile.nameHint")}</span>
      </div>

      {own && (
        <div className="row left">
          <button className="ghost" onClick={() => void setServerProfile(server.spaceId, "", null)}>
            {t("serverProfile.reset")}
          </button>
        </div>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- channels */

/** Who sees the channel, who posts in it, who joins its call. */
function AccessBox({ server, channel }: { server: Server; channel: Channel }) {
  const can = access(server.spaceId);
  const saved = serverAdmin.channelAccess(channel.roomId);
  const [acc, setAcc] = useState<ChannelAccess>(saved);
  useEffect(() => setAcc(serverAdmin.channelAccess(channel.roomId)), [channel.roomId]);
  const roles = serverAdmin.roles(server.spaceId);
  const changed = JSON.stringify(acc) !== JSON.stringify(saved);
  const pick = (value: number, set: (v: number) => void, everyone: string) => (
    <select value={value} disabled={!can.roles} onChange={(e) => set(Number(e.target.value))}>
      {roles
        .slice()
        .reverse()
        .map((r) => (
          <option key={r.level} value={r.level}>
            {r.level === 0 ? everyone : t("channel.andAbove", { role: r.name })}
          </option>
        ))}
      {!roles.some((r) => r.level === value) && <option value={value}>{legacyName(value)}</option>}
    </select>
  );

  return (
    <div className="access-box">
      <div className="field">
        <label>{t("access.view")}</label>
        {pick(acc.view, (view) => setAcc({ ...acc, view }), t("access.everyone"))}
        <span className="state">{acc.view > 0 ? t("access.view.hidden") : t("access.view.hint")}</span>
      </div>
      {channel.kind === "text" ? (
        <div className="field">
          <label>{t("channel.whoPosts")}</label>
          {pick(acc.send, (send) => setAcc({ ...acc, send }), t("channel.everyone"))}
          <span className="state">{t("channel.whoPosts.hint")}</span>
        </div>
      ) : (
        <div className="field">
          <label>{t("access.voice")}</label>
          {pick(acc.voice, (voice) => setAcc({ ...acc, voice }), t("channel.everyone"))}
          <span className="state">{t("access.voice.hint")}</span>
        </div>
      )}
      {can.roles && (
        <div className="row left">
          <button className="primary" disabled={!changed} onClick={() => void serverAdmin.setChannelAccess(server.spaceId, channel.roomId, acc)}>
            {t("access.save")}
          </button>
          {changed && (
            <button className="ghost" onClick={() => setAcc(saved)}>
              {t("common.cancel")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelEditor({ server, channel }: { server: Server; channel: Channel }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="channel-editor">
      <div className="field">
        <label>{t("channel.name")}</label>
        <div className="with-button">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim() || name === channel.name} onClick={() => void serverAdmin.rename(channel.roomId, name)}>
            {t("common.save")}
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t("channel.topic")}</label>
        <div className="with-button">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("channel.topic.placeholder")} />
          <button className="primary" disabled={topic === channel.topic} onClick={() => void serverAdmin.topic(channel.roomId, topic)}>
            {t("common.save")}
          </button>
        </div>
      </div>

      <AccessBox server={server} channel={channel} />

      <div className="row left">
        {confirm ? (
          <>
            <span className="state">{t("channel.deleteConfirm")}</span>
            <button className="danger" onClick={() => void serverAdmin.removeChannel(server.spaceId, channel.roomId)}>
              {t("channel.deleteYes")}
            </button>
            <button className="ghost" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <button className="danger" onClick={() => setConfirm(true)}>
            <IconTrash /> {t("channel.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Server channels. Everyone sees all channels and picks which to show on the
 * left; whoever manages channels also reorders and configures them here.
 */
function Channels({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const open = useStore(app, (s) => s.channelEdit);
  const [list, setList] = useState<BrowseChannel[] | null>(null);
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("");

  const load = () => {
    setList(null);
    void serverAdmin.browse(server.spaceId).then(setList);
  };
  useEffect(load, [server.spaceId]);

  // membership comes from the live state: no server round trip after joining or leaving
  const joined = new Set(server.channels.filter((c) => c.joined).map((c) => c.roomId));
  const mine = server.channels;

  const move = (id: string, dir: -1 | 1) => {
    const kind = mine.find((c) => c.roomId === id)?.kind;
    const same = mine.filter((c) => c.kind === kind).map((c) => c.roomId);
    const at = same.indexOf(id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= same.length) return;
    [same[at], same[to]] = [same[to], same[at]];
    // text channels always go above voice channels
    const texts = kind === "text" ? same : mine.filter((c) => c.kind === "text").map((c) => c.roomId);
    const voices = kind === "voice" ? same : mine.filter((c) => c.kind === "voice").map((c) => c.roomId);
    void serverAdmin.reorder(server.spaceId, [...texts, ...voices]);
  };

  const toggle = async (c: BrowseChannel, on: boolean) => {
    setBusy(c.roomId);
    if (on) await showChannel(c);
    else await hideChannel(c.roomId);
    setBusy("");
  };

  // the order comes from the live space state: a move shows at once, without reloading the list
  const shown = (list ?? [])
    // a hidden channel of another role is not even offered
    .filter((c) => c.joinable || can.channels)
    .map((c) => ({ ...c, order: serverAdmin.childOrder(server.spaceId, c.roomId) || c.order }))
    .sort(compareChannels)
    .filter((c) => !filter || `${c.name} ${c.topic}`.toLowerCase().includes(filter.toLowerCase()));
  const count = list?.filter((c) => joined.has(c.roomId)).length ?? 0;

  return (
    <>
      <p className="sub">{t("channels.pick.intro")}</p>
      <div className="with-button">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("channels.pick.filter")} />
        <button className="ghost" title={t("common.refresh")} onClick={load}>
          <IconRefresh />
        </button>
      </div>
      {list && <div className="state list-count">{t("channels.pick.count", { n: count, total: list.length })}</div>}

      {!list && <div className="state list-count">{t("channels.pick.loading")}</div>}

      <div className="admin-list">
        {shown.map((c) => {
          const on = joined.has(c.roomId);
          const channel = mine.find((x) => x.roomId === c.roomId);
          const manage = can.channels && on && channel;
          return (
            <div key={c.roomId} className={`admin-item browse ${on ? "on" : ""} ${open === c.roomId ? "open" : ""}`}>
              <div className="admin-row">
                <span className="sigil">{c.kind === "voice" ? <IconSpeaker /> : <IconHash />}</span>
                <div className="grow ellipsis">
                  <b className="ellipsis">{c.name}</b>
                  <div className="state ellipsis">
                    {c.topic || (c.kind === "voice" ? t("channels.kind.voice") : t("channels.kind.text"))}
                    {c.members ? ` · ${tn("channels.members", c.members)}` : ""}
                    {!c.joinable && !on ? ` · ${t("channels.inviteOnly")}` : ""}
                  </div>
                </div>
                {manage && (
                  <>
                    <button className="ghost icon small" title={t("channels.up")} onClick={() => move(c.roomId, -1)}>
                      <IconChevron style={{ transform: "rotate(180deg)" }} />
                    </button>
                    <button className="ghost icon small" title={t("channels.down")} onClick={() => move(c.roomId, 1)}>
                      <IconChevron />
                    </button>
                    <button className="ghost small" onClick={() => app.set({ channelEdit: open === c.roomId ? null : c.roomId })}>
                      {open === c.roomId ? t("channels.collapse") : t("channels.configure")}
                    </button>
                  </>
                )}
                <label
                  className={`switch ${on ? "on" : ""} ${busy === c.roomId ? "busy" : ""}`}
                  title={on ? t("channels.hide") : t("channels.show")}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!!busy || (!on && !c.joinable)}
                    onChange={(e) => void toggle(c, e.target.checked)}
                  />
                  <i />
                </label>
              </div>
              {open === c.roomId && channel && <ChannelEditor server={server} channel={channel} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ members */

function Members({ server }: { server: Server }) {
  const tick = useStore(app, (s) => s.tick);
  const can = access(server.spaceId);
  const [filter, setFilter] = useState("");
  const [acting, setActing] = useState<{ userId: string; kind: "kick" | "ban" } | null>(null);
  const [reason, setReason] = useState("");
  const [demoting, setDemoting] = useState<number | null>(null);
  const self = me();
  void tick;

  const members = serverAdmin
    .members(server.spaceId)
    .filter((m) => !filter || `${m.name} ${m.userId}`.toLowerCase().includes(filter.toLowerCase()));

  const run = async () => {
    if (!acting) return;
    const ok =
      acting.kind === "kick"
        ? await serverAdmin.kick(server.spaceId, acting.userId, reason)
        : await serverAdmin.ban(server.spaceId, acting.userId, reason);
    if (ok) {
      setActing(null);
      setReason("");
    }
  };

  const owner = serverAdmin.owner(server.spaceId);
  const grant = maxGrant(can.level, owner === self);
  const roles = serverAdmin.roles(server.spaceId);

  return (
    <>
      <DriftNote server={server} />
      <InviteBox server={server} />
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("members.filter")} />
      <div className="admin-list gap-top">
        {members.map((m) => {
          // Matrix allows acting only on those below you
          const below = m.level < can.level && m.userId !== self;
          // an equal level can be changed only by its holder, not even by the owner
          const equal = m.userId !== self && m.level >= can.level && can.roles;
          return (
            <div key={m.userId} className="admin-item">
              <div className="admin-row">
                <Avatar mxc={m.avatar} name={m.name} size={28} className="clickable" onClick={() => openProfile(m.userId)} />
                <div className="grow ellipsis">
                  <b className="ellipsis">
                    {m.name}
                    {m.userId === owner && <span className="badge">{t("role.owner")}</span>}
                  </b>
                  <div className="state ellipsis sensitive">{m.userId}</div>
                </div>
                <RoleSelect
                  list={roleOptions(roles)}
                  value={m.level}
                  max={m.userId === self ? m.level : grant}
                  title={equal ? t("members.equalLevel") : undefined}
                  disabled={!can.roles || (m.userId !== self && (!below || m.level > grant))}
                  onPick={(level) => {
                    // lowering yourself cannot be undone by yourself: confirm first
                    if (m.userId === self && level < m.level) setDemoting(level);
                    else void serverAdmin.setRole(server.spaceId, m.userId, level);
                  }}
                />
                {can.kick && below && (
                  <button className="ghost small" onClick={() => setActing({ userId: m.userId, kind: "kick" })}>
                    {t("members.kick")}
                  </button>
                )}
                {can.ban && below && (
                  <button className="ghost small danger" onClick={() => setActing({ userId: m.userId, kind: "ban" })}>
                    {t("members.ban")}
                  </button>
                )}
              </div>

              {m.userId === self && demoting !== null && (
                <div className="row left gap-top">
                  <span className="state">{t("members.demoteSelf")}</span>
                  <button
                    className="danger"
                    onClick={() => {
                      void serverAdmin.setRole(server.spaceId, self, demoting);
                      setDemoting(null);
                    }}
                  >
                    {t("members.demoteYes")}
                  </button>
                  <button className="ghost" onClick={() => setDemoting(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              )}

              {acting?.userId === m.userId && (
                <div className="with-button gap-top">
                  <input
                    autoFocus
                    value={reason}
                    placeholder={t("members.reason")}
                    onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void run()}
                  />
                  <button className="danger" onClick={() => void run()}>
                    {acting.kind === "kick" ? t("members.kick") : t("members.banAction")}
                  </button>
                  <button className="ghost" onClick={() => setActing(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* --------------------------------------------------------------------- bans */

function Bans({ server }: { server: Server }) {
  const tick = useStore(app, (s) => s.tick);
  const can = access(server.spaceId);
  void tick;
  const list = serverAdmin.bans(server.spaceId);

  if (!list.length) return <div className="note">{t("bans.none")}</div>;

  return (
    <div className="admin-list">
      {list.map((b) => (
        <div key={b.userId} className="admin-item">
          <div className="admin-row">
            <div className="grow ellipsis">
              <b className="ellipsis">{displayName(b.userId)}</b>
              <div className="state ellipsis sensitive">{b.userId}</div>
              <div className="state ellipsis">{b.reason || t("bans.noReason")}</div>
            </div>
            {can.ban && (
              <button className="ghost small" onClick={() => void serverAdmin.unban(server.spaceId, b.userId)}>
                {t("bans.unban")}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- permissions */

/**
 * Rights per role, as a table. Matrix grants a right from a level up, so a
 * right given to a role also belongs to every role above it: those cells are
 * ticked and greyed. Taking a right away from the lowest role that holds it
 * moves it to the next role up.
 */
function PermsTab({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const [perms, setPerms] = useState<Perms | null>(() => serverAdmin.perms(server.spaceId));
  const saved = serverAdmin.perms(server.spaceId);
  const roles = serverAdmin.roles(server.spaceId);

  if (!perms) return null;
  const changed = JSON.stringify(perms) !== JSON.stringify(saved);
  const levels = roles.map((r) => r.level);
  /** The lowest role that holds a right: its cell is the one that switches it. */
  const holder = (threshold: number) => Math.min(OWNER_LEVEL, ...levels.filter((l) => l >= threshold));
  const nextUp = (level: number) => Math.min(OWNER_LEVEL, ...levels.filter((l) => l > level));
  // Matrix refuses to move a threshold that is, or would be, above the own level
  const editable = (from: number, to: number) => can.roles && from <= can.level && to <= can.level;

  return (
    <>
      <p className="sub">{t("perms.intro")}</p>
      <div className="perm-table-wrap">
        <table className="perm-table">
          <thead>
            <tr>
              <th />
              <th title={t("role.ownerOnly")}>{t("role.owner")}</th>
              {roles.map((r) => (
                <th key={r.level} style={r.color ? { color: r.color } : undefined} title={r.name}>
                  <span className="ellipsis">{r.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERM_NAMES.map((p) => {
              const threshold = perms[p.id];
              const base = holder(threshold);
              return (
                <tr key={p.id}>
                  <td className="perm-name">
                    <b>{t(p.name)}</b>
                    <div className="state">{t(p.hint)}</div>
                  </td>
                  <td>
                    <input type="checkbox" checked disabled title={t("perms.ownerAlways")} />
                  </td>
                  {roles.map((r) => {
                    const has = r.level >= threshold;
                    const inherited = has && r.level > base;
                    const next = has ? nextUp(r.level) : r.level;
                    return (
                      <td key={r.level} className={inherited ? "inherited" : ""}>
                        <input
                          type="checkbox"
                          checked={has}
                          disabled={inherited || !editable(threshold, next)}
                          title={inherited ? t("perms.inherited") : undefined}
                          onChange={() => setPerms({ ...perms, [p.id]: next })}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="state">{t("perms.ladder")}</span>
      {can.roles && (
        <div className="row">
          <button className="ghost" disabled={!changed} onClick={() => setPerms(saved)}>
            {t("perms.reset")}
          </button>
          <button className="primary" disabled={!changed} onClick={() => void serverAdmin.writePerms(server.spaceId, perms)}>
            {t("perms.save")}
          </button>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- roles */

/**
 * Roles of the server: names and colors of the built-in ones, and own roles
 * between them. A new role goes right above the one picked; the owner alone
 * can add roles at the admin level and above.
 */
function RolesTab({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const saved = serverAdmin.roles(server.spaceId);
  const [roles, setRoles] = useState<RoleDef[]>(saved);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#5b8cff");
  const [above, setAbove] = useState(0);
  useEffect(() => setRoles(serverAdmin.roles(server.spaceId)), [server.spaceId]);
  const members = serverAdmin.members(server.spaceId);
  const changed = JSON.stringify(roles) !== JSON.stringify(saved);
  const edit = can.roles;

  const set = (level: number, patch: Partial<RoleDef>) => setRoles(roles.map((r) => (r.level === level ? { ...r, ...patch } : r)));
  const add = () => {
    const level = levelAbove(roles, above);
    if (level === null || !newName.trim()) return;
    setRoles([...roles, { level, name: newName.trim(), color: newColor, custom: true }].sort((a, b) => b.level - a.level));
    setNewName("");
  };
  const freeAbove = levelAbove(roles, above);
  const count = (r: RoleDef) => members.filter((m) => serverAdmin.roleAt(roles, m.level)?.level === r.level).length;

  return (
    <>
      <p className="sub">{t("roles.intro")}</p>
      <div className="admin-list">
        {roles.map((r) => (
          <div key={r.level} className="admin-item">
            <div className="admin-row role-row">
              <input type="color" value={r.color || "#8d93a1"} disabled={!edit} onChange={(e) => set(r.level, { color: e.target.value })} />
              <input className="grow" value={r.name} maxLength={32} disabled={!edit} onChange={(e) => set(r.level, { name: e.target.value })} />
              <span className="state role-meta">{tn("roles.people", count(r))}</span>
              {r.custom && edit && (
                <button className="ghost icon small" title={t("common.delete")} onClick={() => setRoles(roles.filter((x) => x.level !== r.level))}>
                  <IconTrash />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <>
          <div className="section-title">{t("roles.add")}</div>
          <div className="role-add">
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
            <input value={newName} maxLength={32} placeholder={t("roles.name")} onChange={(e) => setNewName(e.target.value)} />
            <select value={above} onChange={(e) => setAbove(Number(e.target.value))}>
              {roles
                .filter((r) => r.level < ADMIN_LEVEL)
                .map((r) => (
                  <option key={r.level} value={r.level}>
                    {t("roles.above", { role: r.name })}
                  </option>
                ))}
            </select>
            <button className="primary" disabled={!newName.trim() || freeAbove === null} onClick={add}>
              {t("roles.addButton")}
            </button>
          </div>
          {freeAbove === null && <div className="state">{t("roles.noRoom")}</div>}
          <div className="row">
            <button className="ghost" disabled={!changed} onClick={() => setRoles(saved)}>
              {t("perms.reset")}
            </button>
            <button className="primary" disabled={!changed} onClick={() => void serverAdmin.saveRoles(server.spaceId, roles)}>
              {t("roles.save")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- window */

const TABS: { id: ServerTab; name: Key }[] = [
  { id: "overview", name: "server.tab.overview" },
  { id: "me", name: "server.tab.me" },
  { id: "channels", name: "server.tab.channels" },
  { id: "members", name: "server.tab.members" },
  { id: "roles", name: "server.tab.roles" },
  { id: "sounds", name: "server.tab.sounds" },
  { id: "bans", name: "server.tab.bans" },
  { id: "perms", name: "server.tab.perms" },
];

export function ServerSettings() {
  const open = useStore(app, (s) => s.serverSettingsOpen);
  const tab = useStore(app, (s) => s.serverTab);
  const servers = useStore(app, (s) => s.servers);
  const activeServer = useStore(app, (s) => s.activeServer);
  const error = useStore(app, (s) => s.error);
  // roles and permissions change through Matrix events: every tab re-renders with them
  const tick = useStore(app, (s) => s.tick);
  const { shown, closing } = useLinger(open);
  const close = () => app.set({ serverSettingsOpen: false, channelEdit: null });
  useEscape(open, close);
  void tick;

  if (!shown) return null;
  const server = servers.find((g) => g.spaceId === activeServer);
  if (!server) return null;

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal wide settings" onClick={(e) => e.stopPropagation()}>
        <h2 className="ellipsis">{server.name}</h2>
        <div className="settings-tabs">
          {TABS.map((tb) => (
            <button key={tb.id} className={tab === tb.id ? "on" : "ghost"} onClick={() => app.set({ serverTab: tb.id })}>
              {t(tb.name)}
            </button>
          ))}
        </div>

        <div className="settings-body">
          <div className="tab-pane" key={tab}>
            {tab === "overview" && <Overview server={server} />}
            {tab === "me" && <MyServerProfile server={server} />}
            {tab === "channels" && <Channels server={server} />}
            {tab === "members" && <Members server={server} />}
            {tab === "bans" && <Bans server={server} />}
            {tab === "perms" && <PermsTab server={server} />}
            {tab === "roles" && <RolesTab server={server} />}
            {tab === "sounds" && <SoundsTab spaceId={server.spaceId} />}
            {error && <div className="error gap-top">{error}</div>}
          </div>
        </div>

        <div className="row">
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
