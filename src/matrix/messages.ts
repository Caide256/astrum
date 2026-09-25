import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
import { formatted } from "../markdown.ts";

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
};

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

export function isEditable(ev: MatrixEvent, me: string): boolean {
  return (
    ev.getSender() === me &&
    ev.getType() === "m.room.message" &&
    !ev.isRedacted() &&
    String(currentContent(ev).content.msgtype ?? "") === "m.text"
  );
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

export async function sendText(
  client: MatrixClient,
  roomId: string,
  text: string,
  reply: Reply | null,
): Promise<void> {
  const body = text.trim();
  if (!body) return;

  if (!reply) {
    await client.sendMessage(roomId, { msgtype: "m.text", body, ...formatted(body) } as never);
    return;
  }

  const quoted = reply.body.split("\n").map((l) => `> ${l}`).join("\n");
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: `> <${reply.sender}> ${quoted.slice(2)}\n\n${body}`,
    ...formatted(body),
    "m.relates_to": { "m.in_reply_to": { event_id: reply.eventId } },
  } as never);
}

export async function editText(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  text: string,
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const html = formatted(body);
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: `* ${body}`,
    ...(html.formatted_body ? { format: html.format, formatted_body: `* ${html.formatted_body}` } : {}),
    "m.new_content": { msgtype: "m.text", body, ...html },
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
