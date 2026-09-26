import type { MatrixClient, Room } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
import { compareText, t, type Key } from "../i18n/index.ts";
import { MEMBER_TYPES } from "./rtc.ts";

/**
 * Server administration.
 *
 * Matrix keeps power levels per room (m.room.power_levels), while a server
 * here is a space plus its channels. Every server-wide action (role, kick,
 * ban) is applied to all rooms at once, and failures are collected into a
 * report instead of aborting everything.
 */

/**
 * Roles are power levels. The owner (server creator) keeps 100 and admins get
 * 75: Matrix never lets anyone change the level of a user whose level equals
 * their own, so with admins at 100 the owner could not demote them. Servers
 * made before this still may have admins at 100; they count as admins too.
 */
export const OWNER_LEVEL = 100;
export const ADMIN_LEVEL = 75;
export const MOD_LEVEL = 50;

export const ROLES: { level: number; key: Key }[] = [
  { level: 0, key: "role.member" },
  { level: MOD_LEVEL, key: "role.moderator" },
  { level: ADMIN_LEVEL, key: "role.admin" },
];

/* ----------------------------------------------------------- server roles */

/**
 * Named roles of a server. Matrix knows only a number per person (the power
 * level), so a role is a level with a name and a color. The list lives in the
 * space as a state event; the built-in roles (member, moderator, admin) can be
 * renamed and colored there too, and new ones sit at any free level below
 * admin. A person has exactly one role: the one of their level.
 */
export const ROLES_EVENT = `${BRAND.appId}.roles`;

export type RoleDef = { level: number; name: string; color: string; custom: boolean };

function cleanColor(v: unknown): string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "";
}

/** Every assignable role of the server, highest first. The owner is not in the list: nobody is made owner. */
export function serverRoles(client: MatrixClient, spaceId: string): RoleDef[] {
  const raw = client.getRoom(spaceId)?.currentState.getStateEvents(ROLES_EVENT, "")?.getContent()?.roles;
  const given = new Map<number, { name: string; color: string }>();
  for (const r of Array.isArray(raw) ? raw : []) {
    const level = Math.round(Number(r?.level));
    if (!Number.isFinite(level) || level < 0 || level >= OWNER_LEVEL || given.has(level)) continue;
    given.set(level, { name: typeof r?.name === "string" ? r.name.trim().slice(0, 32) : "", color: cleanColor(r?.color) });
  }
  const out: RoleDef[] = ROLES.map((b) => {
    const g = given.get(b.level);
    given.delete(b.level);
    return { level: b.level, name: g?.name || t(b.key), color: g?.color ?? "", custom: false };
  });
  for (const [level, g] of given) out.push({ level, name: g.name || t("role.custom", { level }), color: g.color, custom: true });
  return out.sort((a, b) => b.level - a.level);
}

/** The role a level belongs to: the highest role not above it. */
export function roleAt(roles: RoleDef[], level: number): RoleDef | null {
  return roles.find((r) => r.level <= level) ?? null;
}

/** Store the roles. Built-in ones are written only when renamed or colored. */
export async function saveRoles(client: MatrixClient, spaceId: string, roles: RoleDef[]): Promise<void> {
  const builtin = new Map(ROLES.map((b) => [b.level, t(b.key)]));
  const list = roles
    .filter((r) => r.custom || r.color || r.name !== builtin.get(r.level))
    .map((r) => ({ level: r.level, name: r.name, color: r.color }));
  await client.sendStateEvent(spaceId, ROLES_EVENT as never, { roles: list } as never, "");
}

/** A free level for a new role right above `below`: the middle of the gap to the next role. */
export function levelAbove(roles: RoleDef[], below: number): number | null {
  const higher = roles.filter((r) => r.level > below).map((r) => r.level);
  const top = Math.min(ADMIN_LEVEL, ...higher);
  const level = Math.floor((below + top) / 2);
  return level > below && level < top ? level : null;
}

/** Thresholds for permissions: every role plus "owner only". */
export function permLevels(roles: RoleDef[]): { level: number; label: string }[] {
  return [{ level: OWNER_LEVEL, label: t("role.ownerOnly") }, ...roles.map((r) => ({ level: r.level, label: r.name }))];
}

/* --------------------------------------------------------- channel access */

/**
 * Who may see a channel, post in it and join its call. Posting and joining
 * the call are power levels of the channel itself. Seeing is an invite-only
 * room: a hidden channel is not listed to others and its messages are out
 * of their reach; the apps of admins invite everyone whose role qualifies
 * (and remove whoever lost it), and the invited apps join by themselves.
 * The threshold is kept in a state event of the channel.
 */
export const ACCESS_EVENT = `${BRAND.appId}.access`;

export type ChannelAccess = { view: number; send: number; voice: number };

export function channelAccess(client: MatrixClient, roomId: string): ChannelAccess {
  const room = client.getRoom(roomId);
  const pl = plContent(room);
  const events = (pl.events ?? {}) as Record<string, number>;
  const hidden = room?.getJoinRule() === "invite";
  const view = Number(room?.currentState.getStateEvents(ACCESS_EVENT, "")?.getContent()?.view ?? 0);
  const voiceLevels = MEMBER_TYPES.map((tp) => events[tp] ?? pl.state_default ?? 50);
  return {
    view: hidden && Number.isFinite(view) ? Math.max(0, view) : 0,
    send: pl.events_default ?? 0,
    voice: Math.max(0, ...voiceLevels),
  };
}

/** The join rule a visible channel of this server gets: open, or open to server members. */
function openRule(client: MatrixClient, spaceId: string): Record<string, unknown> {
  const spaceRule = client.getRoom(spaceId)?.getJoinRule();
  return !spaceRule || spaceRule === "public"
    ? { join_rule: "public" }
    : { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: spaceId }] };
}

export async function setChannelAccess(client: MatrixClient, spaceId: string, roomId: string, next: ChannelAccess): Promise<Report> {
  const room = client.getRoom(roomId);
  const before = channelAccess(client, roomId);
  const pl = structuredClone(plContent(room));
  const events = { ...(pl.events ?? {}) } as Record<string, number>;
  let plChanged = false;
  if ((pl.events_default ?? 0) !== next.send) {
    pl.events_default = next.send;
    events["m.reaction"] = 0;
    plChanged = true;
  }
  for (const tp of MEMBER_TYPES) {
    if (events[tp] !== next.voice) {
      events[tp] = next.voice;
      plChanged = true;
    }
  }
  if (plChanged) {
    pl.events = events;
    await client.sendStateEvent(roomId, "m.room.power_levels" as never, pl as never, "");
  }
  if (next.view !== before.view) {
    const rule = next.view > 0 ? { join_rule: "invite" } : openRule(client, spaceId);
    await client.sendStateEvent(roomId, "m.room.join_rules" as never, rule as never, "");
  }
  // the marker says the channel's limits are deliberate (server-wide saves keep them)
  if (next.view !== before.view || plChanged) {
    await client.sendStateEvent(roomId, ACCESS_EVENT as never, { view: next.view, voice: next.voice } as never, "");
  }
  return syncChannelMembers(client, spaceId, roomId);
}

/**
 * A hidden channel's members follow the roles: whoever qualifies is invited,
 * whoever does not any more is removed. Admins' apps run this after changing
 * a role or the channel; nothing happens for visible channels.
 */
export async function syncChannelMembers(client: MatrixClient, spaceId: string, roomId: string): Promise<Report> {
  const report: Report = { ok: 0, failed: [] };
  const acc = channelAccess(client, roomId);
  const space = client.getRoom(spaceId);
  const room = client.getRoom(roomId);
  if (!space || !room || acc.view <= 0) return report;
  const self = client.getUserId() ?? "";
  for (const m of space.getJoinedMembers()) {
    if (m.userId === self || levelOf(space, m.userId) < acc.view) continue;
    const there = room.getMember(m.userId)?.membership;
    if (there === "join" || there === "invite" || there === "ban") continue;
    try {
      await client.invite(roomId, m.userId);
      report.ok += 1;
    } catch (e) {
      report.failed.push({ name: m.name || m.userId, error: errText(e) });
    }
  }
  for (const m of room.getMembersWithMembership("join")) {
    if (m.userId === self || levelOf(space, m.userId) >= acc.view) continue;
    try {
      await client.kick(roomId, m.userId, t("access.lost"));
      report.ok += 1;
    } catch (e) {
      report.failed.push({ name: m.name || m.userId, error: errText(e) });
    }
  }
  return report;
}

/** Hidden channels of a server brought in line with the roles, after a role change. */
export async function syncServerAccess(client: MatrixClient, spaceId: string): Promise<Report> {
  const total: Report = { ok: 0, failed: [] };
  for (const room of serverRooms(client, spaceId)) {
    if (room.roomId === spaceId || room.getJoinRule() !== "invite") continue;
    const r = await syncChannelMembers(client, spaceId, room.roomId);
    total.ok += r.ok;
    total.failed.push(...r.failed);
  }
  return total;
}

export function roleName(level: number, owner = false): string {
  if (owner) return t("role.owner");
  if (level >= ADMIN_LEVEL) return t("role.admin");
  if (level >= MOD_LEVEL) return t("role.moderator");
  return t("role.member");
}

/**
 * The highest role this user may hand out. Only the owner appoints admins;
 * others give roles below their own and below admin.
 */
export function maxGrant(myLevel: number, isOwner: boolean): number {
  return isOwner ? ADMIN_LEVEL : Math.min(ADMIN_LEVEL - 1, myLevel - 1);
}

/** Room creator. For a space this is the server owner. */
export function creatorOf(room: Room | null | undefined): string {
  return room?.currentState.getStateEvents("m.room.create", "")?.getSender() ?? "";
}

export type Report = { ok: number; failed: { name: string; error: string }[] };

function errText(e: unknown): string {
  const err = e as { data?: { error?: string }; message?: string };
  return err?.data?.error || err?.message || String(e);
}

/** The space and every channel we are joined to. */
export function serverRooms(client: MatrixClient, spaceId: string): Room[] {
  const space = client.getRoom(spaceId);
  if (!space) return [];
  const out = [space];
  for (const ev of space.currentState.getStateEvents("m.space.child")) {
    const id = ev.getStateKey();
    if (!id || !ev.getContent()?.via) continue;
    const room = client.getRoom(id);
    if (room && room.getMyMembership() === "join") out.push(room);
  }
  return out;
}

async function everywhere(rooms: Room[], run: (room: Room) => Promise<unknown>): Promise<Report> {
  const report: Report = { ok: 0, failed: [] };
  for (const room of rooms) {
    try {
      await run(room);
      report.ok += 1;
    } catch (e) {
      report.failed.push({ name: room.name || room.roomId, error: errText(e) });
    }
  }
  return report;
}

export function plContent(room: Room | null | undefined): Record<string, any> {
  return (room?.currentState.getStateEvents("m.room.power_levels", "")?.getContent() ?? {}) as Record<string, any>;
}

export function levelOf(room: Room | null | undefined, userId: string): number {
  const pl = plContent(room);
  const users = (pl.users ?? {}) as Record<string, number>;
  return users[userId] ?? pl.users_default ?? 0;
}

export function myLevel(client: MatrixClient, roomId: string): number {
  return levelOf(client.getRoom(roomId), client.getUserId() ?? "");
}

/** Power level needed to send an event of this type in the room. */
export function needed(room: Room | null | undefined, type: string, state = true): number {
  const pl = plContent(room);
  const events = (pl.events ?? {}) as Record<string, number>;
  if (type in events) return events[type];
  return state ? (pl.state_default ?? 50) : (pl.events_default ?? 0);
}

/* ------------------------------------------------------------ permissions */

export type Perms = {
  invite: number;
  kick: number;
  ban: number;
  redact: number;
  channels: number;
  server: number;
  roles: number;
};

export const PERM_NAMES: { id: keyof Perms; name: Key; hint: Key }[] = [
  { id: "channels", name: "perm.channels", hint: "perm.channels.hint" },
  { id: "server", name: "perm.server", hint: "perm.server.hint" },
  { id: "roles", name: "perm.roles", hint: "perm.roles.hint" },
  { id: "kick", name: "perm.kick", hint: "perm.kick.hint" },
  { id: "ban", name: "perm.ban", hint: "perm.ban.hint" },
  { id: "redact", name: "perm.redact", hint: "perm.redact.hint" },
  { id: "invite", name: "perm.invite", hint: "perm.invite.hint" },
];

export function readPerms(client: MatrixClient, spaceId: string): Perms {
  const space = client.getRoom(spaceId);
  const pl = plContent(space);
  return {
    invite: pl.invite ?? 0,
    kick: pl.kick ?? 50,
    ban: pl.ban ?? 50,
    redact: pl.redact ?? 50,
    channels: needed(space, "m.space.child"),
    server: needed(space, "m.room.name"),
    roles: needed(space, "m.room.power_levels"),
  };
}

/**
 * Write permissions to every room of the server.
 *
 * state_default is left alone on purpose: call membership events fall under
 * it, and raising it would lock members out of voice channels.
 */
export async function writePerms(client: MatrixClient, spaceId: string, perms: Perms): Promise<Report> {
  return everywhere(serverRooms(client, spaceId), async (room) => {
    const pl = structuredClone(plContent(room));
    const events = { ...(pl.events ?? {}) } as Record<string, number>;
    const isSpace = room.roomId === spaceId;

    pl.invite = perms.invite;
    pl.kick = perms.kick;
    pl.ban = perms.ban;
    pl.redact = perms.redact;
    events["m.room.power_levels"] = perms.roles;

    if (isSpace) {
      events["m.space.child"] = perms.channels;
      events["m.room.name"] = perms.server;
      events["m.room.avatar"] = perms.server;
      events["m.room.topic"] = perms.server;
    } else {
      events["m.room.name"] = perms.channels;
      events["m.room.topic"] = perms.channels;
      events["m.room.avatar"] = perms.channels;
    }
    // call membership stays open to everyone, unless the channel restricted its call on purpose
    const restricted = !isSpace && room.currentState.getStateEvents(ACCESS_EVENT, "") !== null;
    for (const tp of MEMBER_TYPES) {
      if (!restricted && tp in events && events[tp] > 0) events[tp] = 0;
    }

    pl.events = events;
    await client.sendStateEvent(room.roomId, "m.room.power_levels" as never, pl as never, "");
  });
}

/* ---------------------------------------------------------------- members */

export type ServerMember = { userId: string; name: string; avatar: string; level: number };

export function serverMembers(client: MatrixClient, spaceId: string): ServerMember[] {
  const space = client.getRoom(spaceId);
  if (!space) return [];
  return space
    .getJoinedMembers()
    .map((m) => ({
      userId: m.userId,
      name: m.name || m.userId,
      avatar: m.getMxcAvatarUrl() || "",
      level: levelOf(space, m.userId),
    }))
    .sort((a, b) => b.level - a.level || compareText(a.name, b.name));
}

export function bannedUsers(client: MatrixClient, spaceId: string): { userId: string; reason: string }[] {
  const space = client.getRoom(spaceId);
  if (!space) return [];
  return space.getMembersWithMembership("ban").map((m) => ({
    userId: m.userId,
    reason: String(m.events.member?.getContent()?.reason ?? ""),
  }));
}

export function setRole(client: MatrixClient, spaceId: string, userId: string, level: number): Promise<Report> {
  return everywhere(serverRooms(client, spaceId), (room) => client.setPowerLevel(room.roomId, userId, level));
}

export function kick(client: MatrixClient, spaceId: string, userId: string, reason: string): Promise<Report> {
  // channels first: once out of the space, some servers deny access to them
  const rooms = serverRooms(client, spaceId).reverse();
  return everywhere(
    rooms.filter((r) => r.getMember(userId)?.membership === "join"),
    (room) => client.kick(room.roomId, userId, reason || undefined),
  );
}

export function ban(client: MatrixClient, spaceId: string, userId: string, reason: string): Promise<Report> {
  return everywhere(serverRooms(client, spaceId).reverse(), (room) =>
    client.ban(room.roomId, userId, reason || undefined),
  );
}

export function unban(client: MatrixClient, spaceId: string, userId: string): Promise<Report> {
  return everywhere(
    serverRooms(client, spaceId).filter((r) => r.getMember(userId)?.membership === "ban"),
    (room) => client.unban(room.roomId, userId),
  );
}

/* ---------------------------------------------------- server and channels */

export async function setAvatar(client: MatrixClient, roomId: string, file: File | null): Promise<void> {
  const url = file ? (await client.uploadContent(file, { type: file.type, name: file.name })).content_uri : "";
  await client.sendStateEvent(roomId, "m.room.avatar" as never, (url ? { url } : {}) as never, "");
}

export async function setName(client: MatrixClient, roomId: string, name: string): Promise<void> {
  await client.setRoomName(roomId, name.trim());
}

export async function setTopic(client: MatrixClient, roomId: string, topic: string): Promise<void> {
  await client.setRoomTopic(roomId, topic.trim());
}

/** Who may post in a channel: this makes read-only channels such as announcements. */
export async function setSendLevel(client: MatrixClient, roomId: string, level: number): Promise<void> {
  const pl = structuredClone(plContent(client.getRoom(roomId)));
  pl.events_default = level;
  // reactions are events too, keep them open to everyone
  pl.events = { ...(pl.events ?? {}), "m.reaction": 0 };
  await client.sendStateEvent(roomId, "m.room.power_levels" as never, pl as never, "");
}

export function sendLevel(client: MatrixClient, roomId: string): number {
  return plContent(client.getRoom(roomId)).events_default ?? 0;
}

/**
 * New channel order. The order in m.space.child is a string sorted
 * lexicographically, so channels are numbered with leading zeros.
 */
export async function reorder(client: MatrixClient, spaceId: string, ids: string[]): Promise<void> {
  const space = client.getRoom(spaceId);
  if (!space) return;
  for (let i = 0; i < ids.length; i += 1) {
    const ev = space.currentState.getStateEvents("m.space.child", ids[i]);
    const content = (ev?.getContent() ?? {}) as Record<string, any>;
    const order = String((i + 1) * 10).padStart(4, "0");
    if (content.order === order || !content.via) continue;
    await client.sendStateEvent(spaceId, "m.space.child" as never, { ...content, order } as never, ids[i]);
  }
}

export function inviteAlias(client: MatrixClient, spaceId: string): string {
  return client.getRoom(spaceId)?.getCanonicalAlias() ?? "";
}

/* ------------------------------------------------------ roles in channels */

/**
 * Roles are granted on the server, but Matrix keeps power levels per room. If
 * a role was granted from Element (which changes only the space), or a
 * channel was created before the role was granted, the person stays a plain
 * member in some channels: the buttons are there, the server rejects actions.
 */
export type Drift = {
  roomId: string;
  name: string;
  users: { userId: string; want: number; have: number }[];
  canFix: boolean;
};

export function roleDrift(client: MatrixClient, spaceId: string): Drift[] {
  const space = client.getRoom(spaceId);
  if (!space) return [];
  const me = client.getUserId() ?? "";
  const spaceUsers = (plContent(space).users ?? {}) as Record<string, number>;
  const out: Drift[] = [];

  for (const room of serverRooms(client, spaceId).slice(1)) {
    const roomUsers = (plContent(room).users ?? {}) as Record<string, number>;
    const mine = levelOf(room, me);
    const users: Drift["users"] = [];
    for (const userId of new Set([...Object.keys(spaceUsers), ...Object.keys(roomUsers)])) {
      const want = levelOf(space, userId);
      const have = levelOf(room, userId);
      if (want !== have) users.push({ userId, want, have });
    }
    if (!users.length) continue;
    // Matrix allows changing only users below you, and not above your own level
    const canFix =
      mine >= needed(room, "m.room.power_levels") &&
      users.some((u) => u.want <= mine && (u.userId === me ? u.want > u.have : u.have < mine));
    out.push({ roomId: room.roomId, name: room.name || room.roomId, users, canFix });
  }
  return out;
}

/** Align channel power levels with server roles wherever own power allows. */
export function syncRoles(client: MatrixClient, spaceId: string): Promise<Report> {
  const me = client.getUserId() ?? "";
  const drift = roleDrift(client, spaceId).filter((d) => d.canFix);
  const rooms = drift.map((d) => client.getRoom(d.roomId)).filter((r): r is Room => !!r);
  return everywhere(rooms, async (room) => {
    const d = drift.find((x) => x.roomId === room.roomId);
    if (!d) return;
    const pl = structuredClone(plContent(room));
    const users = { ...((pl.users ?? {}) as Record<string, number>) };
    const mine = levelOf(room, me);
    const base = Number(pl.users_default ?? 0);
    for (const u of d.users) {
      if (u.want > mine) continue;
      // only raise yourself: an automatic self-demotion could not be undone
      if (u.userId === me ? u.want < u.have : u.have >= mine) continue;
      if (u.want === base) delete users[u.userId];
      else users[u.userId] = u.want;
    }
    pl.users = users;
    await client.sendStateEvent(room.roomId, "m.room.power_levels" as never, pl as never, "");
  });
}
