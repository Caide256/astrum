import { Direction, EventTimeline, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
import { formatted, mentionedUsers, parse, type MentionResolver } from "../markdown.ts";

/**
 * Messages: replies, edits, deletion, reactions, checklists, search, read
 * receipts. Text is Markdown; when it has markup, formatted_body carries the
 * same message as HTML for other clients.
 *
 * An edit in Matrix is a new event with an m.replace relation, and deletion
 * is a redaction that leaves only the event shell, so the latest replacement
 * is always looked up when rendering.
 */

export type Reply = {
  eventId: string;
  sender: string;
  senderName: string;
  body: string;
  /** Not the whole message but a piece of it: the reply quotes exactly this text. */
  quote?: boolean;
};

/** The quoted piece of a reply that quotes a fragment. Other clients see a normal reply. */
export const QUOTE_KEY = `${BRAND.appId}.quote`;

/* ------------------------------------------------------------------- pins */

export const PINNED = "m.room.pinned_events";

export function pinnedIds(room: Room): string[] {
  const list = room.currentState.getStateEvents(PINNED, "")?.getContent()?.pinned;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

export function canPin(room: Room, me: string): boolean {
  try {
    return room.currentState.maySendStateEvent(PINNED, me);
  } catch {
    return false;
  }
}

export async function setPinned(client: MatrixClient, roomId: string, ids: string[]): Promise<void> {
  await client.sendStateEvent(roomId, PINNED as never, { pinned: ids } as never, "");
}

/** Message content after edits, and whether it was edited. */
export function currentContent(ev: MatrixEvent): { content: Record<string, any>; edited: boolean } {
  const replacing = ev.replacingEvent();
  if (!replacing) return { content: ev.getContent(), edited: false };
  const c = replacing.getContent();
  return { content: (c["m.new_content"] as Record<string, any>) ?? c, edited: true };
}

/**
 * Replies carry a ">"-quoted fallback in the body for old clients. The quote
 * is drawn separately, so the fallback is stripped.
 */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith("> ")) return body;
  const at = body.indexOf("\n\n");
  return at === -1 ? body : body.slice(at + 2);
}

export function replyTargetId(content: Record<string, any>): string {
  return String(content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id ?? "");
}

const MEDIA_TYPES = new Set(["m.image", "m.video", "m.audio", "m.file"]);

/** Own text messages are edited as text, own attachments get their caption edited. */
export function isEditable(ev: MatrixEvent, me: string): boolean {
  const type = String(currentContent(ev).content.msgtype ?? "");
  return (
    ev.getSender() === me &&
    ev.getType() === "m.room.message" &&
    !ev.isRedacted() &&
    (type === "m.text" || type === "m.emote" || type === "m.notice" || MEDIA_TYPES.has(type))
  );
}

export function isMediaContent(content: Record<string, any>): boolean {
  return MEDIA_TYPES.has(String(content?.msgtype ?? ""));
}

export function mayRedact(room: Room, ev: MatrixEvent, me: string): boolean {
  if (ev.isRedacted()) return false;
  if (ev.getSender() === me) return true;
  try {
    return room.currentState.maySendRedactionForEvent(ev, me);
  } catch {
    return false;
  }
}

/**
 * Intentional mentions (m.mentions): who this message pings. The server's
 * push rules notify exactly these people; a reply also pings its author, as
 * in Discord.
 */
function mentionsOf(body: string, resolve: MentionResolver | undefined, also: string[] = [], group?: GroupPing): { user_ids: string[]; room?: boolean } {
  const ids = new Set([...mentionedUsers(parse(body), resolve), ...also.filter(Boolean), ...(group?.users ?? [])]);
  return group?.room ? { user_ids: [...ids], room: true } : { user_ids: [...ids] };
}

/** Who a group mention pings: the whole room (m.mentions.room), or a list of people for "@here". */
export type GroupPing = { room: boolean; users: string[] };

export async function sendText(
  client: MatrixClient,
  roomId: string,
  text: string,
  reply: Reply | null,
  resolve?: MentionResolver,
  extra: Record<string, unknown> = {},
  group?: GroupPing,
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const me = client.getUserId() ?? "";
  const pinged = mentionsOf(body, resolve, reply && reply.sender !== me ? [reply.sender] : [], group);
  pinged.user_ids = pinged.user_ids.filter((u) => u !== me);

  if (!reply) {
    await client.sendMessage(roomId, {
      msgtype: "m.text",
      body,
      ...formatted(body, resolve),
      "m.mentions": pinged,
      ...extra,
    } as never);
    return;
  }

  const quoted = reply.body.split("\n").map((l) => `> ${l}`).join("\n");
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: `> <${reply.sender}> ${quoted.slice(2)}\n\n${body}`,
    ...formatted(body, resolve),
    "m.mentions": pinged,
    ...extra,
    ...(reply.quote ? { [QUOTE_KEY]: reply.body } : {}),
    "m.relates_to": { "m.in_reply_to": { event_id: reply.eventId } },
  } as never);
}

/**
 * Edit a text message. Fields the app adds next to the text (link previews)
 * are kept unless `keep` says otherwise. An edit pings nobody anew: the outer
 * m.mentions is empty, the new content lists everyone mentioned.
 */
export async function editText(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  text: string,
  resolve?: MentionResolver,
  keep: Record<string, unknown> = {},
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const html = formatted(body, resolve);
  const me = client.getUserId() ?? "";
  const pinged = mentionsOf(body, resolve);
  pinged.user_ids = pinged.user_ids.filter((u) => u !== me);
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: `* ${body}`,
    ...(html.formatted_body ? { format: html.format, formatted_body: `* ${html.formatted_body}` } : {}),
    "m.mentions": {},
    "m.new_content": { msgtype: "m.text", body, ...html, "m.mentions": pinged, ...keep },
    "m.relates_to": { rel_type: "m.replace", event_id: eventId },
  } as never);
}

/**
 * Other clients (Element) put the display name into the body and the person
 * into a matrix.to link of formatted_body. For drawing, such names are turned
 * into user ids, which the renderer shows as mentions. Names that already
 * stand as an @mention of the same person are left alone.
 */
export function mentionsFromHtml(body: string, content: Record<string, any>, resolve: MentionResolver): string {
  const html = typeof content.formatted_body === "string" ? content.formatted_body.slice(0, 20_000) : "";
  if (!html.includes("matrix.to/#/@")) return body;
  let out = body;
  let seen = 0;
  const pills = html.matchAll(/<a\s+href="https:\/\/matrix\.to\/#\/(@[^"?/]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const [, rawId, rawLabel] of pills) {
    if ((seen += 1) > 50) break;
    let userId = "";
    try {
      userId = decodeURIComponent(rawId);
    } catch {
      continue;
    }
    const label = rawLabel
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
    if (!label || label.startsWith("@")) continue;
    // already written as an @mention that means the same person
    const tokens = out.match(/@[^\s@]+/g) ?? [];
    if (tokens.some((tk) => resolve(tk)?.userId === userId)) continue;
    const at = out.indexOf(label);
    if (at === -1) continue;
    out = `${out.slice(0, at)}${userId}${out.slice(at + label.length)}`;
  }
  return out;
}

/**
 * New caption of an attachment. The file stays: the replacement carries the
 * same file fields. MSC2530: with a caption, `body` is the caption and
 * `filename` the file name; without one, `body` is the file name again.
 */
export async function editCaption(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  current: Record<string, any>,
  caption: string,
): Promise<void> {
  const text = caption.trim();
  const name = String(current.filename ?? "") || String(current.body ?? "");
  const next: Record<string, any> = {};
  for (const [k, v] of Object.entries(current)) {
    if (k === "m.relates_to" || k === "m.new_content" || k === "body" || k === "filename" || k === "format" || k === "formatted_body") continue;
    next[k] = v;
  }
  if (text) {
    next.body = text;
    next.filename = name;
    Object.assign(next, formatted(text));
  } else {
    next.body = name;
  }
  await client.sendMessage(roomId, {
    ...next,
    body: `* ${next.body}`,
    "m.new_content": next,
    "m.relates_to": { rel_type: "m.replace", event_id: eventId },
  } as never);
}

export async function remove(client: MatrixClient, roomId: string, eventId: string): Promise<void> {
  await client.redactEvent(roomId, eventId);
}

/* -------------------------------------------------------------- reactions */

export type Reaction = { key: string; count: number; mine: string | null; who: string[] };

/**
 * A reaction is an m.reaction event with an m.annotation relation. The SDK
 * groups them per message; the own one is found so a second click removes it.
 */
export function reactionsFor(room: Room, eventId: string, me: string): Reaction[] {
  const rel = room.relations.getChildEventsForEvent(eventId, "m.annotation", "m.reaction");
  const sorted = rel?.getSortedAnnotationsByKey() ?? [];
  const out: Reaction[] = [];
  for (const [key, set] of sorted) {
    const events = [...set].filter((e) => !e.isRedacted());
    if (!events.length) continue;
    out.push({
      key,
      count: events.length,
      mine: events.find((e) => e.getSender() === me)?.getId() ?? null,
      who: events.map((e) => e.getSender() ?? ""),
    });
  }
  return out;
}

export async function react(client: MatrixClient, roomId: string, eventId: string, key: string): Promise<void> {
  await client.sendEvent(roomId, "m.reaction" as never, {
    "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
  } as never);
}

/* ------------------------------------------------------------- checklists */

/**
 * A checklist item is ticked with a separate event that points at the
 * message, so anyone in the room can tick items of anyone's message. The
 * latest event per item wins. Other clients hide the unknown event type.
 */
export const CHECK_TYPE = `${BRAND.appId}.check`;

export type CheckState = { done: boolean; by: string; ts: number };

/** Latest toggle per message and item among the loaded timeline. */
export function collectChecks(room: Room): Map<string, Record<string, CheckState>> {
  const out = new Map<string, Record<string, CheckState>>();
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.getType() !== CHECK_TYPE || ev.isRedacted()) continue;
    const c = ev.getContent() as { target?: string; item?: string; done?: boolean };
    if (typeof c.target !== "string" || typeof c.item !== "string") continue;
    const per = out.get(c.target) ?? {};
    const prev = per[c.item];
    if (!prev || prev.ts <= ev.getTs()) per[c.item] = { done: !!c.done, by: ev.getSender() ?? "", ts: ev.getTs() };
    out.set(c.target, per);
  }
  return out;
}

export async function sendCheck(client: MatrixClient, roomId: string, eventId: string, item: string, done: boolean): Promise<void> {
  await client.sendEvent(roomId, CHECK_TYPE as never, { target: eventId, item, done } as never);
}

/* ----------------------------------------------------------------- search */

export type Hit = { eventId: string; sender: string; body: string; ts: number };

/** Lower case, and "ё" as "е": people type both. */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/** Every word of the query is somewhere in the text, as a piece of a word too: "добав" finds "добавить". */
export function matchesQuery(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** A hit from a message event, its latest edit taken into account; null if it does not match. */
function hitOf(ev: MatrixEvent, query: string): Hit | null {
  if (ev.getType() !== "m.room.message" || ev.isRedacted() || ev.isRelation("m.annotation")) return null;
  const raw = ev.getContent();
  // an edit found on its own stands for the message it edits
  const rel = raw["m.relates_to"] as { rel_type?: string; event_id?: string } | undefined;
  const target = rel?.rel_type === "m.replace" && typeof rel.event_id === "string" ? rel.event_id : "";
  const edit = !!target;
  const content = edit ? ((raw["m.new_content"] as Record<string, any>) ?? raw) : currentContent(ev).content;
  const body = stripReplyFallback(String(content.body ?? ""));
  if (!body || !matchesQuery(body, query)) return null;
  return { eventId: target || (ev.getId() ?? ""), sender: ev.getSender() ?? "", body, ts: ev.getTs() };
}

/** Search in what the app already holds: works in encrypted rooms, where the server sees nothing. */
export function searchLoaded(room: Room, query: string): Hit[] {
  const out: Hit[] = [];
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const hit = hitOf(events[i], query);
    if (hit && hit.eventId) out.push(hit);
  }
  return out;
}

/**
 * Search further back than the loaded timeline without touching it: pages of
 * older history are fetched and read here, encrypted ones decrypted, and
 * dropped afterwards.
 */
export async function searchOlder(client: MatrixClient, room: Room, query: string, pages: number): Promise<Hit[]> {
  const out: Hit[] = [];
  const map = client.getEventMapper();
  let from = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
  for (let i = 0; i < pages && from; i += 1) {
    const res = await client.createMessagesRequest(room.roomId, from, 100, Direction.Backward);
    for (const raw of res.chunk ?? []) {
      const ev = map(raw);
      if (ev.isEncrypted()) await client.decryptEventIfNeeded(ev).catch(() => undefined);
      const hit = hitOf(ev, query);
      if (hit && hit.eventId) out.push(hit);
    }
    if (!res.chunk?.length || !res.end || res.end === from) break;
    from = res.end;
  }
  return out;
}

/** Server-side search: finds messages not loaded into the timeline yet. */
export async function search(client: MatrixClient, roomId: string, term: string): Promise<Hit[]> {
  const res = await client.searchRoomEvents({ term, filter: { rooms: [roomId] } });
  return res.results
    .map((r) => r.context.getEvent())
    .filter((ev) => ev.getType() === "m.room.message" && !ev.isRedacted())
    .map((ev) => ({
      eventId: ev.getId() ?? "",
      sender: ev.getSender() ?? "",
      body: stripReplyFallback(String(ev.getContent().body ?? "")),
      ts: ev.getTs(),
    }));
}

/* ---------------------------------------------------------- read receipts */

/**
 * Mark the room read up to the last event, or the server keeps counting the
 * messages as unread.
 */
export async function markRead(client: MatrixClient, room: Room): Promise<void> {
  const me = client.getUserId() ?? "";
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    const id = ev.getId();
    // local echoes ("~" ids) are not on the server yet and cannot be receipted
    if (!id || id.startsWith("~")) continue;
    if (room.hasUserReadEvent(me, id)) return;
    await client.sendReadReceipt(ev);
    return;
  }
}
