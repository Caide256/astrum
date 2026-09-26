import type { MatrixClient } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
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
  /** The other person deleted the account. */
  deleted: boolean;
};

/* -------------------------------------------------------- deleted accounts */

/**
 * A deleted (deactivated) account leaves every room and loses its name and
 * picture; its homeserver then answers "not found" for the profile. Only
 * people who are no longer in the room are checked, and each at most once in
 * a while, so the check costs nothing for the usual case.
 */
const deleted = new Set<string>();
const checkedAt = new Map<string, number>();
const RECHECK_MS = 10 * 60_000;
let deletedChanged: () => void = () => undefined;

export function isDeleted(userId: string): boolean {
  return deleted.has(userId);
}

export function onDeletedChange(cb: () => void): void {
  deletedChanged = cb;
}

export function checkDeleted(client: MatrixClient, userId: string): void {
  const now = Date.now();
  if (!userId || (checkedAt.get(userId) ?? 0) > now - RECHECK_MS) return;
  checkedAt.set(userId, now);
  client.getProfileInfo(userId).then(
    () => {
      if (deleted.delete(userId)) deletedChanged();
    },
    (e) => {
      const err = e as { errcode?: string; httpStatus?: number };
      if (err?.errcode !== "M_NOT_FOUND" && err?.httpStatus !== 404) return;
      if (deleted.has(userId)) return;
      deleted.add(userId);
      deletedChanged();
    },
  );
}

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
      if (!member || member.membership === "leave") checkDeleted(client, userId);
      const gone = isDeleted(userId);
      out.push({
        userId,
        roomId,
        name: gone ? t("people.deleted") : member?.name || room.name || userId,
        avatar: gone ? "" : member?.getMxcAvatarUrl() || room.getMxcAvatarUrl() || "",
        unread: room.getUnreadNotificationCount() ?? 0,
        ts: room.getLastActiveTimestamp() ?? 0,
        deleted: gone,
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

/**
 * Delete the account for good: the server ends every session, leaves all
 * rooms and never gives the name out again. With `erase` the messages are
 * also hidden from people who join rooms later (Synapse honours it, other
 * servers may not).
 */
export async function deactivateAccount(client: MatrixClient, password: string, erase: boolean): Promise<void> {
  try {
    await withPassword(client, password, (auth) => client.deactivateAccount(auth as never, erase));
  } catch (e) {
    const err = e as UiaError & { errcode?: string };
    if (err?.httpStatus === 401 || err?.errcode === "M_FORBIDDEN") throw new Error(t("sessions.wrongPassword"));
    throw e;
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
  /** The invite event: a hidden invite is remembered by it, so a new invite shows again. */
  eventId: string;
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
  const hidden = new Set(hiddenInvites(client).map((h) => h.eventId));
  return client
    .getRooms()
    .filter((r) => r.getMyMembership() === "invite")
    .filter((r) => !hidden.has(r.getMember(me)?.events.member?.getId() ?? ""))
    .map((room) => {
      const ev = room.getMember(me)?.events.member;
      const inviter = ev?.getSender() ?? "";
      const direct = !!ev?.getContent()?.is_direct;
      const who = room.getMember(inviter);
      return {
        roomId: room.roomId,
        eventId: ev?.getId() ?? "",
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

/* ------------------------------------------------------- stuck invites */

/**
 * Invites the homeserver failed to decline: rejecting an invite from another
 * server goes through that server, and when it is down or the homeserver
 * errs, the invite would hang in the list forever. Such invites are hidden by
 * the id of the invite event and kept in account data, so every sign-in hides
 * them too. The decline is retried on later starts.
 */
const HIDDEN = `${BRAND.appId}.hidden-invites`;

type HiddenInvite = { roomId: string; eventId: string };

/** Hidden in this session, before the account data echo comes back from the server. */
const hiddenHere = new Map<string, HiddenInvite>();

function hiddenInvites(client: MatrixClient): HiddenInvite[] {
  const raw = client.getAccountData(HIDDEN as never)?.getContent<{ invites?: unknown }>()?.invites;
  const list = (Array.isArray(raw) ? raw : []).filter(
    (h): h is HiddenInvite => !!h && typeof h.roomId === "string" && typeof h.eventId === "string",
  );
  const byEvent = new Map(list.map((h) => [h.eventId, h]));
  for (const h of hiddenHere.values()) byEvent.set(h.eventId, h);
  return [...byEvent.values()];
}

async function saveHidden(client: MatrixClient, list: HiddenInvite[]): Promise<void> {
  await client.setAccountData(HIDDEN as never, { invites: list } as never);
}

export async function hideInvite(client: MatrixClient, invite: Invite): Promise<void> {
  if (!invite.eventId) return;
  const entry = { roomId: invite.roomId, eventId: invite.eventId };
  hiddenHere.set(entry.eventId, entry);
  await saveHidden(client, hiddenInvites(client));
}

/**
 * Try the hidden invites again. An invite that is gone (declined, accepted
 * elsewhere, replaced by a new one) is dropped from the list.
 */
export async function retryHiddenInvites(client: MatrixClient): Promise<void> {
  const me = client.getUserId() ?? "";
  const list = hiddenInvites(client);
  if (!list.length) return;
  const keep: HiddenInvite[] = [];
  for (const h of list) {
    const room = client.getRoom(h.roomId);
    const current = room?.getMember(me)?.events.member;
    if (room?.getMyMembership() !== "invite" || current?.getId() !== h.eventId) continue;
    try {
      await client.leave(h.roomId);
    } catch {
      keep.push(h);
    }
  }
  if (keep.length === list.length) return;
  hiddenHere.clear();
  for (const h of keep) hiddenHere.set(h.eventId, h);
  await saveHidden(client, keep);
}

export function isHiddenInvitesEvent(type: string): boolean {
  return type === HIDDEN;
}

/** Leave and forget a direct chat, and drop it from m.direct so it is not listed again. */
export async function deleteDirect(client: MatrixClient, roomId: string): Promise<void> {
  const room = client.getRoom(roomId);
  if (room && room.getMyMembership() !== "leave" && room.getMyMembership() !== "ban") await client.leave(roomId);
  await client.forget(roomId).catch(() => undefined);
  const map = directMap(client);
  let changed = false;
  const next: DirectMap = {};
  for (const [user, rooms] of Object.entries(map)) {
    const kept = (rooms ?? []).filter((r) => r !== roomId);
    if (kept.length !== (rooms ?? []).length) changed = true;
    if (kept.length) next[user] = kept;
  }
  if (changed) await client.setAccountData(DIRECT as never, next as never);
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
