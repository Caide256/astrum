import { NotificationCountType, type MatrixClient, type Room } from "matrix-js-sdk";

import { compareText, t } from "../i18n/index.ts";
import { MEMBER_TYPES } from "./rtc.ts";

/**
 * Discord-like model on top of Matrix:
 *   space              -> server
 *   room in the space  -> channel, text or voice
 */

export type ChannelKind = "text" | "voice";

export type Channel = {
  roomId: string;
  name: string;
  kind: ChannelKind;
  topic: string;
  order: string;
  joined: boolean;
  unread: number;
  /** Unread messages that mention the user. */
  mentions: number;
};

export type Server = {
  spaceId: string;
  name: string;
  avatar: string | null;
  channels: Channel[];
};

/** Room types treated as voice channels. */
const VOICE_ROOM_TYPES = new Set(["m.video_room", "org.matrix.msc3417.call"]);

export function roomType(room: Room): string {
  const create = room.currentState.getStateEvents("m.room.create", "");
  return (create?.getContent()?.type as string) ?? "";
}

export function isVoiceRoom(room: Room): boolean {
  return VOICE_ROOM_TYPES.has(roomType(room));
}

export function isSpace(room: Room): boolean {
  return room.isSpaceRoom();
}

/**
 * An mxc URI, not an http URL: recent servers require a token for media and a
 * plain <img src> gets 401. media.ts downloads it with authorization.
 */
function avatarOf(room: Room): string | null {
  return room.getMxcAvatarUrl() ?? null;
}

function toChannel(client: MatrixClient, roomId: string, order: string): Channel | null {
  const room = client.getRoom(roomId);
  if (!room) {
    return null; // known to the space, but not joined and no data about it
  }
  if (room.isSpaceRoom()) return null; // nested spaces are not channels
  // left or kicked: gone from the list, it can be added back in server settings
  const membership = room.getMyMembership();
  if (membership !== "join" && membership !== "invite") return null;
  return {
    roomId,
    name: room.name || roomId,
    kind: isVoiceRoom(room) ? "voice" : "text",
    topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic ?? "",
    order,
    joined: room.getMyMembership() === "join",
    unread: room.getUnreadNotificationCount() ?? 0,
    mentions: room.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
  };
}

/** Text above voice, then by the order the server set, then by name. */
export function compareChannels(a: { kind: ChannelKind; order: string; name: string }, b: { kind: ChannelKind; order: string; name: string }): number {
  return sortChannels(a, b);
}

function sortChannels(a: { kind: ChannelKind; order: string; name: string }, b: { kind: ChannelKind; order: string; name: string }): number {
  // voice below text, then by order and name
  if (a.kind !== b.kind) return a.kind === "text" ? -1 : 1;
  if (a.order && b.order && a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.order && !b.order) return -1;
  if (!a.order && b.order) return 1;
  return compareText(a.name, b.name);
}

export function listServers(client: MatrixClient): Server[] {
  const servers: Server[] = [];
  for (const room of client.getRooms()) {
    if (!room.isSpaceRoom() || room.getMyMembership() !== "join") continue;

    const children = room.currentState.getStateEvents("m.space.child");
    const channels: Channel[] = [];
    for (const ev of children) {
      const childId = ev.getStateKey();
      const content = ev.getContent();
      if (!childId || !content?.via) continue; // empty content is a removed child
      const channel = toChannel(client, childId, String(content.order ?? ""));
      if (channel) channels.push(channel);
    }
    channels.sort(sortChannels);

    servers.push({
      spaceId: room.roomId,
      name: room.name || room.roomId,
      avatar: avatarOf(room),
      channels,
    });
  }
  servers.sort((a, b) => compareText(a.name, b.name));
  return servers;
}

/** Rooms outside every space. */
export function looseChannels(client: MatrixClient, servers: Server[]): Channel[] {
  const inServers = new Set<string>();
  for (const g of servers) {
    inServers.add(g.spaceId);
    for (const c of g.channels) inServers.add(c.roomId);
  }
  const out: Channel[] = [];
  for (const room of client.getRooms()) {
    if (room.isSpaceRoom() || inServers.has(room.roomId)) continue;
    if (room.getMyMembership() !== "join") continue;
    const channel = toChannel(client, room.roomId, "");
    if (channel) out.push(channel);
  }
  out.sort(sortChannels);
  return out;
}

export type CreateChannelOpts = {
  spaceId: string;
  name: string;
  kind: ChannelKind;
  topic?: string;
};

/**
 * A new channel copies the server's power levels. By default Matrix gives
 * power only to the room creator, and server admins and moderators would be
 * plain members in the new channel.
 */
function channelPowerLevels(client: MatrixClient, spaceId: string): Record<string, unknown> {
  const pl = (client.getRoom(spaceId)?.currentState.getStateEvents("m.room.power_levels", "")?.getContent() ??
    {}) as Record<string, any>;
  const me = client.getUserId() ?? "";
  const users = { ...((pl.users ?? {}) as Record<string, number>) };
  if (!(me in users)) users[me] = 100;
  const events = (pl.events ?? {}) as Record<string, number>;
  const manage = events["m.space.child"] ?? pl.state_default ?? 50;
  const out: Record<string, unknown> = {
    users,
    events: {
      "m.room.name": manage,
      "m.room.topic": manage,
      "m.room.avatar": manage,
      "m.room.power_levels": events["m.room.power_levels"] ?? 100,
      "m.reaction": 0,
      // call membership must stay open to everyone, or members cannot join voice
      ...Object.fromEntries(MEMBER_TYPES.map((t) => [t, 0])),
    },
  };
  for (const key of ["kick", "ban", "redact", "invite"]) {
    if (typeof pl[key] === "number") out[key] = pl[key];
  }
  return out;
}

/** Create a channel and add it to the space. */
export async function createChannel(client: MatrixClient, opts: CreateChannelOpts): Promise<string> {
  const server = client.getDomain() ?? "";
  const created = await client.createRoom({
    name: opts.name,
    topic: opts.topic,
    visibility: "public" as never,
    preset: "public_chat" as never,
    creation_content: opts.kind === "voice" ? { type: "m.video_room" } : undefined,
    power_level_content_override: channelPowerLevels(client, opts.spaceId) as never,
    initial_state: [
      {
        type: "m.room.guest_access",
        state_key: "",
        content: { guest_access: "can_join" },
      },
    ],
  });

  await client.sendStateEvent(
    opts.spaceId,
    "m.space.child" as never,
    { via: [server], suggested: true } as never,
    created.room_id,
  );
  return created.room_id;
}

export async function deleteChannel(client: MatrixClient, spaceId: string, roomId: string): Promise<void> {
  await client.sendStateEvent(spaceId, "m.space.child" as never, {} as never, roomId);
  try {
    await client.leave(roomId);
  } catch {
    // already left
  }
}

/* --------------------------------------------------------- channel browser */

/** A server channel, joined or not, for the channel picker. */
export type BrowseChannel = {
  roomId: string;
  name: string;
  topic: string;
  kind: ChannelKind;
  members: number;
  joined: boolean;
  /** Joinable without an invite: public, or restricted to server members. */
  joinable: boolean;
  suggested: boolean;
  via: string[];
  order: string;
};

type HierarchyRoom = {
  room_id: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members?: number;
  room_type?: string;
  join_rule?: string;
  children_state?: { state_key: string; content: Record<string, any> }[];
};

/** All rooms of the space from the server, page by page, including unjoined ones. */
async function hierarchy(client: MatrixClient, spaceId: string): Promise<HierarchyRoom[]> {
  const out: HierarchyRoom[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const res = await client.getRoomHierarchy(spaceId, 100, 1, false, token);
    out.push(...(res.rooms as unknown as HierarchyRoom[]));
    token = res.next_batch;
    if (!token) break;
  }
  return out;
}

const OPEN_RULES = new Set(["public", "restricted", "knock_restricted"]);

/**
 * Channels of a server: which exist, which are joined and which can be
 * joined. The child list comes from the space itself; details about unjoined
 * channels come from the server's hierarchy API.
 */
export async function browseChannels(client: MatrixClient, spaceId: string): Promise<BrowseChannel[]> {
  const space = client.getRoom(spaceId);
  let rooms: HierarchyRoom[] = [];
  try {
    rooms = await hierarchy(client, spaceId);
  } catch {
    // no hierarchy from the server: show what is known locally
  }
  const byId = new Map(rooms.map((r) => [r.room_id, r]));

  const children = new Map<string, Record<string, any>>();
  for (const ev of space?.currentState.getStateEvents("m.space.child") ?? []) {
    const id = ev.getStateKey();
    if (id && ev.getContent()?.via) children.set(id, ev.getContent());
  }
  // the space is not synced yet (just joined): take children from the server's answer
  if (!children.size) {
    for (const ch of byId.get(spaceId)?.children_state ?? []) {
      if (ch.content?.via) children.set(ch.state_key, ch.content);
    }
  }

  const out: BrowseChannel[] = [];
  for (const [roomId, content] of children) {
    const h = byId.get(roomId);
    const local = client.getRoom(roomId);
    if (h?.room_type === "m.space" || local?.isSpaceRoom()) continue;
    const membership = local?.getMyMembership();
    const type = h?.room_type ?? (local ? roomType(local) : "");
    const rule = h?.join_rule ?? local?.getJoinRule() ?? "";
    out.push({
      roomId,
      name: h?.name || local?.name || h?.canonical_alias || t("server.unnamedChannel"),
      topic: h?.topic ?? String(local?.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic ?? ""),
      kind: VOICE_ROOM_TYPES.has(type) ? "voice" : "text",
      members: h?.num_joined_members ?? local?.getJoinedMemberCount() ?? 0,
      joined: membership === "join",
      // unknown to the hierarchy: probably private, but joining may still work
      joinable: membership === "join" || membership === "invite" || !h || OPEN_RULES.has(rule),
      suggested: !!content.suggested,
      via: Array.isArray(content.via) ? content.via : [],
      order: String(content.order ?? ""),
    });
  }
  out.sort(sortChannels);
  return out;
}

export async function joinChannel(client: MatrixClient, roomId: string, via: string[]): Promise<void> {
  await client.joinRoom(roomId, { viaServers: via });
}

export async function leaveChannel(client: MatrixClient, roomId: string): Promise<void> {
  await client.leave(roomId);
}

/**
 * Right after joining a server: join the suggested channels so it does not
 * open empty, or all open channels if none are suggested. The rest can be
 * picked in server settings.
 */
export async function joinDefaultChannels(client: MatrixClient, spaceId: string): Promise<void> {
  const list = (await browseChannels(client, spaceId)).filter((c) => !c.joined && c.joinable);
  const suggested = list.filter((c) => c.suggested);
  const pick = (suggested.length ? suggested : list).slice(0, 30);
  for (const c of pick) {
    try {
      await joinChannel(client, c.roomId, c.via);
    } catch {
      // private channel or unreachable server: the others still get joined
    }
  }
}
