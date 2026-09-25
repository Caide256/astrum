import type { MatrixClient, Room } from "matrix-js-sdk";

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

export const ROLES: { level: number; key: Key }[] = [
  { level: 0, key: "role.member" },
  { level: 50, key: "role.moderator" },
  { level: 100, key: "role.admin" },
];

export function roleName(level: number, owner = false): string {
  if (owner) return t("role.owner");
  if (level >= 100) return t("role.admin");
  if (level >= 50) return t("role.moderator");
  return t("role.member");
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
    // call membership must stay open to everyone
    for (const t of MEMBER_TYPES) {
      if (t in events && events[t] > 0) events[t] = 0;
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
