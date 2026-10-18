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

/** Where a media server to try came from, for the log. */
export type FocusSource = "call" | "own" | "room server" | "worked before" | "server channels" | "old call" | "member servers";
export type FocusCandidate = Focus & { source: FocusSource };

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

/** When a participant joined: the oldest one picks the media server. */
function joinedAt(m: Membership): number {
  const own = m.content.created_ts;
  if (typeof own === "number") return own;
  const first = Array.isArray(m.content.memberships) ? m.content.memberships[0]?.created_ts : undefined;
  return typeof first === "number" ? first : m.ts;
}

/**
 * Media servers to try, best first. Those already in the call decide, the
 * oldest first, as Element does ("oldest_membership"): one call has to be on
 * one server. An empty call goes to the own homeserver's media server, as in
 * Element; a membership left behind long ago no longer decides it.
 *
 * The rest are backups for a server that does not answer: the one of the
 * room's homeserver, ones that worked here before, ones the other channels of
 * the server use, and ones named by memberships long gone.
 */
export function focusCandidates(
  list: Membership[],
  roomId: string,
  more: { own: string; roomServer: string; worked: string[]; nearby: string[] },
): FocusCandidate[] {
  const out: FocusCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, alias: string, source: FocusSource) => {
    const key = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ serviceUrl: key, alias: alias || roomId, source });
  };
  const live = list.filter((m) => !m.expired).sort((a, b) => joinedAt(a) - joinedAt(b));
  for (const m of live) add(focusOf(m), deepFind(m.content, "livekit_alias"), "call");
  add(more.own, "", "own");
  add(more.roomServer, "", "room server");
  for (const url of more.worked) add(url, "", "worked before");
  for (const url of more.nearby) add(url, "", "server channels");
  for (const m of list.filter((m) => m.expired)) add(focusOf(m), deepFind(m.content, "livekit_alias"), "old call");
  // a server that does not answer can cost seconds: a few backups are enough
  return out.slice(0, Math.max(MAX_CANDIDATES, live.length));
}

const MAX_CANDIDATES = 6;

/** The host of a URL for messages: "host:port", or the text itself. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
    // the server this client really went to: a backup one when the template's did not answer
    setKey(content, "livekit_service_url", focus.serviceUrl);
    setKey(content, "livekit_alias", focus.alias);
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

function setKey(obj: unknown, key: string, value: string): void {
  if (Array.isArray(obj)) {
    obj.forEach((v) => setKey(v, key, value));
    return;
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === key && typeof v === "string") rec[k] = value;
      else setKey(v, key, value);
    }
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

const wellKnown = new Map<string, { at: number; url: string }>();
const WELL_KNOWN_MS = 10 * 60 * 1000;

/**
 * lk-jwt-service URL from a homeserver's well-known (its base URL, or
 * "https://" and the server name). Kept for a while: every join asks.
 */
export async function focusFromWellKnown(homeserver: string): Promise<string> {
  const base = homeserver.trim().replace(/\/+$/, "");
  if (!base) return "";
  const kept = wellKnown.get(base);
  if (kept && Date.now() - kept.at < WELL_KNOWN_MS) return kept.url;
  let url = "";
  try {
    const res = await fetch(`${base}/.well-known/matrix/client`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const foci = data?.["org.matrix.msc4143.rtc_foci"];
      if (Array.isArray(foci)) {
        for (const f of foci) {
          if (f?.type === "livekit" && f?.livekit_service_url) {
            url = String(f.livekit_service_url);
            break;
          }
        }
      }
    }
  } catch {
    // no well-known: the URL comes from another participant's membership
  }
  wellKnown.set(base, { at: Date.now(), url });
  return url;
}

/** How long lk-jwt-service may think: it checks the sign-in with the homeserver and creates the room. */
const TICKET_MS = 15_000;

/** OpenID token to a LiveKit JWT. The service embeds the room name itself. */
export async function getSfuTicket(
  client: MatrixClient,
  serviceUrl: string,
  alias: string,
): Promise<SfuTicket> {
  const openid = await client.getOpenIdToken();
  const host = hostOf(serviceUrl);
  let res: Response;
  try {
    res = await fetch(`${serviceUrl.replace(/\/+$/, "")}/sfu/get`, {
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
      signal: AbortSignal.timeout(TICKET_MS),
    });
  } catch (e) {
    // no answer at all, a broken certificate, or an answer without CORS headers (a proxy's own error page)
    const name = e instanceof Error ? e.name : "";
    const why =
      name === "TimeoutError"
        ? t("rtc.err.timeout", { s: TICKET_MS / 1000 })
        : name === "TypeError"
          ? t("rtc.err.noAnswer")
          : String(e instanceof Error ? e.message : e);
    throw new Error(t("rtc.err.unreachable", { host, error: why }), { cause: e });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = res.status === 401 || res.status === 403 ? ` ${t("rtc.err.notAllowed")}` : "";
    throw new Error(t("rtc.err.jwt", { host, status: res.status, body: body.slice(0, 200) }) + hint);
  }
  const data = await res.json().catch(() => null);
  if (!data?.url || !data?.jwt) throw new Error(t("rtc.err.jwtEmpty", { host }));
  return { url: String(data.url), jwt: String(data.jwt) };
}
