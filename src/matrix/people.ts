import type { MatrixClient } from "matrix-js-sdk";

import { t } from "../i18n/index.ts";

/**
 * Direct chats, the own profile and sessions.
 *
 * A direct chat in Matrix is a regular room marked in the m.direct account
 * data. It is not tied to any space, so the list is account-wide.
 */

const DIRECT = "m.direct";

type DirectMap = Record<string, string[]>;

function directMap(client: MatrixClient): DirectMap {
  const content = client.getAccountData(DIRECT as never)?.getContent<DirectMap>();
  return content && typeof content === "object" ? content : {};
}

export type Direct = {
  userId: string;
  roomId: string;
  name: string;
  avatar: string;
  unread: number;
  ts: number;
};

export function listDirects(client: MatrixClient): Direct[] {
  const map = directMap(client);
  const out: Direct[] = [];
  const seen = new Set<string>();

  for (const [userId, rooms] of Object.entries(map)) {
    for (const roomId of rooms ?? []) {
      if (seen.has(roomId)) continue;
      const room = client.getRoom(roomId);
      if (!room || room.getMyMembership() !== "join") continue;
      seen.add(roomId);

      const member = room.getMember(userId);
      out.push({
        userId,
        roomId,
        name: member?.name || room.name || userId,
        avatar: member?.getMxcAvatarUrl() || room.getMxcAvatarUrl() || "",
        unread: room.getUnreadNotificationCount() ?? 0,
        ts: room.getLastActiveTimestamp() ?? 0,
      });
    }
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export function directRoomFor(client: MatrixClient, userId: string): string {
  return listDirects(client).find((d) => d.userId === userId)?.roomId ?? "";
}

/** Open a direct chat: find the existing one or create a new one. */
export async function openDirect(client: MatrixClient, userId: string): Promise<string> {
  const known = directRoomFor(client, userId);
  if (known) return known;

  // Element encrypts direct chats; do the same when crypto is available
  const created = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: "trusted_private_chat" as never,
    initial_state: client.getCrypto()
      ? [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }]
      : [],
  });

  const map = directMap(client);
  const list = new Set(map[userId] ?? []);
  list.add(created.room_id);
  await client.setAccountData(DIRECT as never, { ...map, [userId]: [...list] } as never);

  return created.room_id;
}

/* ---------------------------------------------------------------- profile */

export async function setName(client: MatrixClient, name: string): Promise<void> {
  await client.setDisplayName(name.trim());
}

export async function setAvatar(client: MatrixClient, file: File): Promise<string> {
  const upload = await client.uploadContent(file, { type: file.type, name: file.name });
  await client.setAvatarUrl(upload.content_uri);
  return upload.content_uri;
}

export async function clearAvatar(client: MatrixClient): Promise<void> {
  await client.setAvatarUrl("");
}

/* --------------------------------------------------------------- sessions */

export type SessionRow = {
  deviceId: string;
  name: string;
  ip: string;
  seen: number;
  current: boolean;
};

export async function listSessions(client: MatrixClient): Promise<SessionRow[]> {
  const res = await client.getDevices();
  const mine = client.getDeviceId();
  return (res.devices ?? [])
    .map((d) => ({
      deviceId: d.device_id,
      name: d.display_name || t("sessions.unnamed"),
      ip: d.last_seen_ip || "",
      seen: d.last_seen_ts || 0,
      current: d.device_id === mine,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.seen - a.seen);
}

export async function renameSession(client: MatrixClient, deviceId: string, name: string): Promise<void> {
  await client.setDeviceDetails(deviceId, { display_name: name });
}

/** The server wants the password to confirm: the UI asks for it and retries. */
export class NeedPassword extends Error {
  constructor() {
    super(t("sessions.needPassword"));
  }
}

type UiaError = { httpStatus?: number; data?: { session?: string; flows?: unknown } };

/**
 * An action behind user-interactive auth. First try without a password
 * (Synapse lets it through if the password was entered recently); on refusal
 * either ask for the password or retry with the one given.
 */
async function withPassword(
  client: MatrixClient,
  password: string,
  run: (auth: Record<string, unknown> | undefined) => Promise<unknown>,
): Promise<void> {
  try {
    await run(undefined);
    return;
  } catch (e) {
    const err = e as UiaError;
    const session = err?.data?.session;
    if (err?.httpStatus !== 401 || !session) throw e;
    if (!password) throw new NeedPassword();
    await run({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: client.getUserId() ?? "" },
      password,
      session,
    });
  }
}

/** End another session. The password is needed only if the server asks for it. */
export function removeSession(client: MatrixClient, deviceId: string, password: string): Promise<void> {
  return withPassword(client, password, (auth) => client.deleteDevice(deviceId, auth as never));
}

/**
 * Change the password. The old one is always required. Other sessions stay
 * signed in.
 */
export async function changePassword(client: MatrixClient, oldPassword: string, newPassword: string): Promise<void> {
  try {
    await withPassword(client, oldPassword, (auth) =>
      client.setPassword((auth ?? {}) as never, newPassword, false),
    );
  } catch (e) {
    const err = e as UiaError & { errcode?: string };
    if (err?.httpStatus === 401 || err?.errcode === "M_FORBIDDEN") throw new Error(t("profile.err.oldPassword"));
    throw e;
  }
}

/* --------------------------------------------------------------- presence */

export type Presence = "online" | "unavailable" | "offline";

export function presenceOf(client: MatrixClient, userId: string): Presence {
  const p = client.getUser(userId)?.presence;
  if (p === "online") return "online";
  if (p === "unavailable") return "unavailable";
  return "offline";
}

/* ---------------------------------------------------------------- invites */

export type Invite = {
  roomId: string;
  name: string;
  avatar: string;
  inviter: string;
  direct: boolean;
  space: boolean;
};

/**
 * A direct chat starts with an invite, and until it is accepted the room is
 * not joined, so invites are listed separately.
 */
export function listInvites(client: MatrixClient): Invite[] {
  const me = client.getUserId() ?? "";
  return client
    .getRooms()
    .filter((r) => r.getMyMembership() === "invite")
    .map((room) => {
      const ev = room.getMember(me)?.events.member;
      const inviter = ev?.getSender() ?? "";
      const direct = !!ev?.getContent()?.is_direct;
      const who = room.getMember(inviter);
      return {
        roomId: room.roomId,
        name: direct ? who?.name || inviter : room.name || room.roomId,
        avatar: (direct ? who?.getMxcAvatarUrl() : room.getMxcAvatarUrl()) || "",
        inviter,
        direct,
        space: room.isSpaceRoom(),
      };
    });
}

/** Accept an invite. A direct chat is also added to m.direct, or it would not be listed. */
export async function acceptInvite(client: MatrixClient, invite: Invite): Promise<void> {
  await client.joinRoom(invite.roomId);
  if (!invite.direct || !invite.inviter) return;
  const map = directMap(client);
  const list = new Set(map[invite.inviter] ?? []);
  list.add(invite.roomId);
  await client.setAccountData(DIRECT as never, { ...map, [invite.inviter]: [...list] } as never);
}

export async function declineInvite(client: MatrixClient, roomId: string): Promise<void> {
  await client.leave(roomId);
}

/* ---------------------------------------------------------- people search */

export type UserHit = { userId: string; name: string; avatar: string; shared: boolean };

const FULL_ID = /^@[^:\s]+:\S+$/;

/**
 * Find a person to message. People sharing a room come first: found instantly
 * without the server. Then the homeserver's user directory. A full
 * @name:server address always works, even if the directory does not know it.
 */
export function searchLocalUsers(client: MatrixClient, term: string): UserHit[] {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const me = client.getUserId();
  const out = new Map<string, UserHit>();
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    for (const m of room.getJoinedMembers()) {
      if (m.userId === me || out.has(m.userId)) continue;
      if (`${m.name} ${m.userId}`.toLowerCase().includes(q)) {
        out.set(m.userId, { userId: m.userId, name: m.name || m.userId, avatar: m.getMxcAvatarUrl() || "", shared: true });
      }
    }
  }
  return [...out.values()].slice(0, 30);
}

export async function searchUsers(client: MatrixClient, term: string): Promise<UserHit[]> {
  const t = term.trim();
  const me = client.getUserId();
  const out = new Map<string, UserHit>(searchLocalUsers(client, t).map((u) => [u.userId, u]));
  try {
    const res = await client.searchUserDirectory({ term: t, limit: 30 });
    for (const r of res.results) {
      if (r.user_id === me || out.has(r.user_id)) continue;
      out.set(r.user_id, { userId: r.user_id, name: r.display_name || r.user_id, avatar: r.avatar_url || "", shared: false });
    }
  } catch {
    // the directory is disabled: shared rooms and full addresses remain
  }
  if (FULL_ID.test(t) && t !== me && !out.has(t)) {
    let hit: UserHit = { userId: t, name: t, avatar: "", shared: false };
    try {
      const p = await client.getProfileInfo(t);
      hit = { ...hit, name: p.displayname || t, avatar: p.avatar_url || "" };
    } catch {
      // no profile: use the address as is
    }
    out.set(t, hit);
  }
  return [...out.values()].slice(0, 40);
}
