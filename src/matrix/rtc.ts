import type { MatrixClient, Room } from "matrix-js-sdk";

import { t } from "../i18n/index.ts";

/**
 * MatrixRTC: who is in a voice channel and how to get in.
 *
 * Call membership is a state event in the room; media goes through LiveKit,
 * access to which lk-jwt-service grants in exchange for a homeserver OpenID
 * token.
 *
 * The event format differs between Element versions, so instead of guessing
 * the schema the client copies it from a live participant and substitutes
 * its own ids.
 */

export const MEMBER_TYPES = ["m.rtc.member", "m.call.member", "org.matrix.msc3401.call.member"] as const;

export type Membership = {
  type: string;
  stateKey: string;
  sender: string;
  deviceId: string;
  content: Record<string, any>;
  expired: boolean;
  eventId: string;
  /** When the membership was last written. */
  ts: number;
};

export type Focus = { serviceUrl: string; alias: string };

export type SfuTicket = { url: string; jwt: string };

function deepFind(obj: unknown, key: string): string {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const found = deepFind(v, key);
      if (found) return found;
    }
    return "";
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const direct = rec[key];
    if (typeof direct === "string" && direct) return direct;
    for (const v of Object.values(rec)) {
      const found = deepFind(v, key);
      if (found) return found;
    }
  }
  return "";
}

const DEFAULT_EXPIRE_MS = 4 * 60 * 60 * 1000;

/**
 * Whether a membership has expired.
 *
 * If a client crashes or the window closes without leaving, the membership
 * event stays in the room. Element drops such events by age: created_ts (or
 * the event time) plus expires, four hours by default. The same rule applies
 * here, otherwise ghosts stay in the channel. New m.rtc.member events have no
 * expiry; the server removes them with a delayed event.
 */
function isExpired(type: string, content: Record<string, any>, eventTs: number, now: number): boolean {
  if (type === "m.rtc.member") return false;

  const one = (m: Record<string, any>): boolean => {
    if (typeof m.expires_ts === "number") return m.expires_ts <= now;
    const created = typeof m.created_ts === "number" ? m.created_ts : eventTs;
    const expires = typeof m.expires === "number" ? m.expires : DEFAULT_EXPIRE_MS;
    return created + expires <= now;
  };

  // the legacy format keeps an array of memberships: alive if any is alive
  if (Array.isArray(content.memberships)) {
    return content.memberships.length === 0 || content.memberships.every((m: Record<string, any>) => one(m));
  }
  return one(content);
}

/** All call memberships. Empty content means the participant left. */
export function memberships(room: Room, now = Date.now()): Membership[] {
  const out: Membership[] = [];
  for (const type of MEMBER_TYPES) {
    for (const ev of room.currentState.getStateEvents(type)) {
      const content = ev.getContent() as Record<string, any>;
      if (!content || Object.keys(content).length === 0) continue;
      out.push({
        type,
        stateKey: ev.getStateKey() ?? "",
        sender: ev.getSender() ?? "",
        deviceId: deepFind(content, "device_id"),
        content,
        expired: isExpired(type, content, ev.getTs(), now),
        eventId: ev.getId() ?? "",
        ts: ev.getTs(),
      });
    }
  }
  return out;
}

/** Who is actually in the call: no expired entries and no known ghosts, one entry per user. */
export function participantsInCall(room: Room, ghost: (m: Membership) => boolean = () => false): string[] {
  return [
    ...new Set(
      memberships(room)
        .filter((m) => !m.expired && !ghost(m))
        .map((m) => m.sender)
        .filter(Boolean),
    ),
  ];
}

/** The media server a membership points to, "" if none is named. */
export function focusOf(m: Membership): string {
  return deepFind(m.content, "livekit_service_url");
}

/**
 * Clear someone else's stale membership. State keys starting with "@" belong
 * to that user alone; the "_@user_DEVICE" keys of newer clients may be written
 * by anyone the room allows to send call memberships.
 */
export async function clearMembership(client: MatrixClient, roomId: string, m: Membership): Promise<void> {
  if (m.stateKey.startsWith("@") && m.sender !== client.getUserId()) return;
  try {
    await client.sendStateEvent(roomId, m.type as never, {} as never, m.stateKey);
  } catch {
    // not allowed here: it stays hidden locally and expires on its own
  }
}

/** Another participant's event to copy the format from; a live one if possible. */
export function pickTemplate(list: Membership[], me: string): Membership | null {
  const others = list.filter((m) => m.sender !== me);
  return others.find((m) => !m.expired) ?? others[0] ?? null;
}

export function discoverFocus(list: Membership[], roomId: string, fallbackUrl: string): Focus {
  let serviceUrl = "";
  let alias = "";
  // prefer live participants: an expired entry may point to an old server
  const ordered = [...list].sort((a, b) => Number(a.expired) - Number(b.expired));
  for (const m of ordered) {
    serviceUrl = serviceUrl || deepFind(m.content, "livekit_service_url");
    alias = alias || deepFind(m.content, "livekit_alias");
    if (serviceUrl && alias) break;
  }
  return { serviceUrl: serviceUrl || fallbackUrl, alias: alias || roomId };
}

/**
 * State key in exactly the template's format, with our ids. Versions use
 * "@u:s_DEV", "_@u:s_DEV" or "_@u:s_DEV_m.call".
 */
export function mirrorStateKey(template: Membership | null, userId: string, deviceId: string): string {
  const raw = template?.stateKey ?? "";
  const sender = template?.sender ?? "";
  if (!raw || !sender || !raw.includes(sender)) return "";

  const at = raw.indexOf(sender);
  const prefix = raw.slice(0, at);
  let rest = raw.slice(at + sender.length);

  const theirDevice = template?.deviceId ?? "";
  if (theirDevice && rest.includes(theirDevice)) {
    rest = rest.replace(theirDevice, deviceId);
  } else {
    const parts = rest.split("_");
    if (parts.length >= 2 && parts[1]) {
      parts[1] = deviceId;
      rest = parts.join("_");
    } else {
      rest = `_${deviceId}`;
    }
  }
  return `${prefix}${userId}${rest}`;
}

export function stateKeyCandidates(userId: string, deviceId: string): string[] {
  return [
    `_${userId}_${deviceId}_m.call`,
    `${userId}_${deviceId}`,
    `_${userId}_${deviceId}`,
    userId,
  ];
}

const EXPIRES_MS = 14_400_000;

export function buildContent(
  template: Membership | null,
  deviceId: string,
  focus: Focus,
  createdTs: number,
): Record<string, any> {
  let content: Record<string, any>;

  if (template) {
    content = structuredClone(template.content);
    if (Array.isArray(content.memberships) && content.memberships.length) {
      const one = structuredClone(content.memberships[0]);
      setDevice(one, deviceId);
      one.membershipID = randomId();
      one.expires = EXPIRES_MS;
      one.created_ts = createdTs || Date.now();
      if ("expires_ts" in one) one.expires_ts = (createdTs || Date.now()) + EXPIRES_MS;
      content = { memberships: [one] };
    } else {
      setDevice(content, deviceId);
      content.device_id = content.device_id ?? deviceId;
      content.expires = EXPIRES_MS;
      if ("expires_ts" in content) content.expires_ts = (createdTs || Date.now()) + EXPIRES_MS;
      if ("membershipID" in content) content.membershipID = randomId();
    }
  } else {
    content = {
      application: "m.call",
      call_id: "",
      scope: "m.room",
      device_id: deviceId,
      expires: EXPIRES_MS,
      focus_active: { type: "livekit", focus_selection: "oldest_membership" },
      foci_preferred: [
        { type: "livekit", livekit_service_url: focus.serviceUrl, livekit_alias: focus.alias },
      ],
    };
  }

  content.created_ts = createdTs || Date.now();
  return content;
}

/**
 * Extend the own membership without changing the join time: Element picks the
 * oldest participant by it, and that decides whose media server is used.
 */
export function extendContent(content: Record<string, any>, now = Date.now()): Record<string, any> {
  const next = structuredClone(content);
  const bump = (m: Record<string, any>) => {
    const created = typeof m.created_ts === "number" ? m.created_ts : now;
    m.expires = now - created + EXPIRES_MS;
    if ("expires_ts" in m) m.expires_ts = now + EXPIRES_MS;
  };
  if (Array.isArray(next.memberships)) next.memberships.forEach(bump);
  else bump(next);
  return next;
}

export const REFRESH_MS = 30 * 60 * 1000;

/* ---------------------------------------------------------- delayed leave */

/**
 * Delayed leave event (MSC4140), as in Element Call: the server sends an empty
 * membership itself if we stop refreshing it, so a crash or a closed window
 * leaves no ghost. Servers without MSC4140 fall back to expiry only.
 */
export async function scheduleLeave(
  client: MatrixClient,
  roomId: string,
  type: string,
  stateKey: string,
): Promise<string | null> {
  try {
    const res = await client._unstable_sendDelayedStateEvent(
      roomId,
      { delay: LEAVE_DELAY_MS },
      type as never,
      {} as never,
      stateKey,
    );
    return res.delay_id ?? null;
  } catch {
    return null;
  }
}

export const LEAVE_DELAY_MS = 20_000;

export async function keepLeaveAway(client: MatrixClient, delayId: string): Promise<boolean> {
  try {
    await client._unstable_restartScheduledDelayedEvent(delayId);
    return true;
  } catch {
    return false;
  }
}

export async function cancelLeave(client: MatrixClient, delayId: string): Promise<void> {
  try {
    await client._unstable_updateDelayedEvent(delayId, "cancel" as never);
  } catch {
    // already fired or forgotten by the server
  }
}

function setDevice(obj: unknown, deviceId: string): void {
  if (Array.isArray(obj)) {
    obj.forEach((v) => setDevice(v, deviceId));
    return;
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if ((k === "device_id" || k === "deviceId") && typeof v === "string") rec[k] = deviceId;
      else setDevice(v, deviceId);
    }
  }
}

function randomId(): string {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2, 10);
}

/** Publish the own call membership. Returns the state key that worked. */
export async function publishMembership(
  client: MatrixClient,
  roomId: string,
  type: string,
  content: Record<string, any>,
  preferredKey: string,
): Promise<{ type: string; stateKey: string }> {
  const userId = client.getUserId() ?? "";
  const deviceId = client.getDeviceId() ?? "";
  const keys = [preferredKey, ...stateKeyCandidates(userId, deviceId)].filter(Boolean);
  let lastError: unknown = null;

  for (const key of [...new Set(keys)]) {
    try {
      await client.sendStateEvent(roomId, type as never, content as never, key);
      return { type, stateKey: key };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(t("rtc.err.membership", { error: String(lastError) }));
}

export async function retractMembership(
  client: MatrixClient,
  roomId: string,
  type: string,
  stateKey: string,
): Promise<void> {
  try {
    await client.sendStateEvent(roomId, type as never, {} as never, stateKey);
  } catch {
    // could not remove it; it expires on its own
  }
}

/** lk-jwt-service URL from the own homeserver's well-known. */
export async function focusFromWellKnown(homeserver: string): Promise<string> {
  try {
    const res = await fetch(`${homeserver.replace(/\/+$/, "")}/.well-known/matrix/client`);
    if (!res.ok) return "";
    const data = await res.json();
    const foci = data?.["org.matrix.msc4143.rtc_foci"];
    if (Array.isArray(foci)) {
      for (const f of foci) {
        if (f?.type === "livekit" && f?.livekit_service_url) return String(f.livekit_service_url);
      }
    }
  } catch {
    // no well-known: the URL comes from another participant's membership
  }
  return "";
}

/** OpenID token to a LiveKit JWT. The service embeds the room name itself. */
export async function getSfuTicket(
  client: MatrixClient,
  serviceUrl: string,
  alias: string,
): Promise<SfuTicket> {
  const openid = await client.getOpenIdToken();
  const res = await fetch(`${serviceUrl.replace(/\/+$/, "")}/sfu/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room: alias,
      openid_token: {
        access_token: openid.access_token,
        matrix_server_name: openid.matrix_server_name,
      },
      device_id: client.getDeviceId(),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 401 || res.status === 403 ? ` ${t("rtc.err.notAllowed")}` : "";
    throw new Error(t("rtc.err.jwt", { status: res.status, body: body.slice(0, 200) }) + hint);
  }
  const data = await res.json();
  if (!data?.url || !data?.jwt) throw new Error(t("rtc.err.jwtEmpty"));
  return { url: String(data.url), jwt: String(data.jwt) };
}
