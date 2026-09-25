import { useEffect, useRef, useState } from "react";

import {
  access,
  app,
  copyText,
  hideChannel,
  inviteToServer,
  makeServerAddress,
  me,
  openProfile,
  openServerJoin,
  serverAdmin,
  serverJoinRule,
  showChannel,
  type ServerTab,
} from "../app.ts";
import { t, tn, type Key } from "../i18n/index.ts";
import { PERM_NAMES, ROLES, type Perms } from "../matrix/admin.ts";
import { GUESSES } from "../matrix/discovery.ts";
import { compareChannels, type BrowseChannel, type Channel, type Server } from "../matrix/servers.ts";
import { useStore } from "../store.ts";
import { Avatar } from "./Avatar.tsx";
import { Cropper } from "./Cropper.tsx";
import { useEscape, useLinger } from "./controls.tsx";
import { IconCheck, IconChevron, IconCopy, IconHash, IconRefresh, IconSpeaker, IconTrash } from "./icons.tsx";

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
          <div className="note">
            {guessable ? t("address.byDomain", { domain, alias }) : t("address.byAlias", { alias })}{" "}
            {open ? t("address.open") : t("address.closed")}
          </div>
          <div className="row left">
            <CopyButton text={guessable ? domain : alias} label={guessable ? t("address.copyDomain") : t("address.copyAlias")} />
            {!open && can.server && (
              <button className="ghost small" onClick={() => void openServerJoin(server.spaceId)}>
                {t("address.openJoin")}
              </button>
            )}
          </div>
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

function RoleSelect({ value, max, onPick, disabled }: { value: number; max: number; onPick: (level: number) => void; disabled?: boolean }) {
  // Matrix does not allow granting a role above your own, so such options are disabled
  return (
    <select value={value} disabled={disabled} onChange={(e) => onPick(Number(e.target.value))}>
      {!ROLES.some((r) => r.level === value) && <option value={value}>{t("role.custom", { level: value })}</option>}
      {ROLES.map((r) => (
        <option key={r.level} value={r.level} disabled={r.level > max}>
          {t(r.key)}
        </option>
      ))}
    </select>
  );
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
                <span className="state ellipsis" title={alias}>
                  {alias}
                </span>
                <CopyButton text={alias} className="ghost icon tiny" />
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
    </>
  );
}

/* ----------------------------------------------------------------- channels */

function ChannelEditor({ server, channel }: { server: Server; channel: Channel }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [confirm, setConfirm] = useState(false);
  const sendLevel = serverAdmin.sendLevel(channel.roomId);

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

      {channel.kind === "text" && (
        <div className="field">
          <label>{t("channel.whoPosts")}</label>
          <select value={sendLevel} onChange={(e) => void serverAdmin.setSendLevel(channel.roomId, Number(e.target.value))}>
            {ROLES.map((r) => (
              <option key={r.level} value={r.level}>
                {r.level === 0 ? t("channel.everyone") : t("channel.andAbove", { role: t(r.key) })}
              </option>
            ))}
          </select>
          <span className="state">{t("channel.whoPosts.hint")}</span>
        </div>
      )}

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

  return (
    <>
      <DriftNote server={server} />
      <InviteBox server={server} />
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("members.filter")} />
      <div className="admin-list gap-top">
        {members.map((m) => {
          // Matrix allows acting only on those below you
          const below = m.level < can.level && m.userId !== self;
          return (
            <div key={m.userId} className="admin-item">
              <div className="admin-row">
                <Avatar mxc={m.avatar} name={m.name} size={28} className="clickable" onClick={() => openProfile(m.userId)} />
                <div className="grow ellipsis">
                  <b className="ellipsis">
                    {m.name}
                    {m.userId === owner && <span className="badge">{t("role.owner")}</span>}
                  </b>
                  <div className="state ellipsis">{m.userId}</div>
                </div>
                <RoleSelect
                  value={m.level}
                  max={can.level}
                  disabled={!can.roles || (!below && m.userId !== self)}
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
              <b className="ellipsis">{b.userId}</b>
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

function PermsTab({ server }: { server: Server }) {
  const can = access(server.spaceId);
  const [perms, setPerms] = useState<Perms | null>(() => serverAdmin.perms(server.spaceId));
  const saved = serverAdmin.perms(server.spaceId);

  if (!perms) return null;
  const changed = JSON.stringify(perms) !== JSON.stringify(saved);

  return (
    <>
      <p className="sub">{t("perms.intro")}</p>
      <div className="admin-list">
        {PERM_NAMES.map((p) => (
          <div key={p.id} className="admin-item">
            <div className="admin-row">
              <div className="grow">
                <b>{t(p.name)}</b>
                <div className="state">{t(p.hint)}</div>
              </div>
              <RoleSelect value={perms[p.id]} max={can.level} disabled={!can.roles} onPick={(level) => setPerms({ ...perms, [p.id]: level })} />
            </div>
          </div>
        ))}
      </div>
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

/* ------------------------------------------------------------------- window */

const TABS: { id: ServerTab; name: Key }[] = [
  { id: "overview", name: "server.tab.overview" },
  { id: "channels", name: "server.tab.channels" },
  { id: "members", name: "server.tab.members" },
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
            {tab === "channels" && <Channels server={server} />}
            {tab === "members" && <Members server={server} />}
            {tab === "bans" && <Bans server={server} />}
            {tab === "perms" && <PermsTab server={server} />}
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
