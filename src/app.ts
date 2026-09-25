import {
  ClientEvent,
  HttpApiEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SetPresence,
  SyncState,
  UserEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";

import { createStore } from "./store.ts";
import * as session from "./matrix/session.ts";
import {
  browseChannels,
  createChannel,
  deleteChannel,
  joinChannel,
  joinDefaultChannels,
  leaveChannel,
  listServers,
  looseChannels,
  type BrowseChannel,
  type Channel,
  type Server,
} from "./matrix/servers.ts";
import { joinServer, lookupServer, type ServerCard } from "./matrix/discovery.ts";
import * as rtc from "./matrix/rtc.ts";
import * as admin from "./matrix/admin.ts";
import * as crypto from "./matrix/crypto.ts";
import * as msg from "./matrix/messages.ts";
import * as people from "./matrix/people.ts";
import { configureMedia, encryptAttachment, mediaUrl, type EncryptedFile } from "./media.ts";
import { copyToClipboard, flashWindow, idleSeconds, onBeforeQuit, showWindow } from "./desktop.ts";
import { startHotkeys } from "./hotkeys.ts";
import { compareText, t } from "./i18n/index.ts";
import { getNotifyMode, getSoundPrefs, isMuted, startPrefsSync, stopPrefsSync } from "./prefs.ts";
import { setTrayUnread } from "./tray.ts";
import { setBeforeInstall } from "./update.ts";
import { blip } from "./voice/audio.ts";
import { voice, type ShareOptions } from "./voice/voice.ts";

export { mediaUrl };

export type Media = {
  mxc: string;
  /** Set for attachments from encrypted rooms: the key to decrypt the file. */
  file: EncryptedFile | null;
  kind: "image" | "video" | "audio" | "file";
  name: string;
  mime: string;
  size: number;
  /** Text sent together with the file. */
  caption: string;
  w: number;
  h: number;
};

/** A file being uploaded. */
export type Upload = { id: string; name: string; progress: number };

export type StatusMode = "auto" | "unavailable" | "offline";

export type ReplyPreview = { eventId: string; sender: string; senderName: string; body: string };

export type Message = {
  id: string;
  sender: string;
  senderName: string;
  avatar: string;
  body: string;
  ts: number;
  own: boolean;
  media: Media | null;
  edited: boolean;
  reply: ReplyPreview | null;
  reactions: msg.Reaction[];
  canEdit: boolean;
  canDelete: boolean;
  /** sent: reached the server, sending: on the way, failed: not sent. */
  state: "sent" | "sending" | "failed";
  failReason: string;
  /** Encrypted, and this sign-in has no key for it. */
  locked: boolean;
  /** Checklist items toggled in the room: the latest toggle per item key. */
  checks: Record<string, msg.CheckState>;
};

export type Member = {
  userId: string;
  name: string;
  avatar: string;
  power: number;
  /** Server owner. */
  owner: boolean;
  presence: people.Presence;
};

export type UserMenu = { userId: string; roomId: string | null; x: number; y: number };

export type Lightbox = { url: string; name: string };

export type SettingsTab = "profile" | "audio" | "keys" | "appearance" | "app" | "crypto" | "sessions";

export type ServerTab = "overview" | "channels" | "members" | "bans" | "perms";

export type AppState = {
  phase: "login" | "loading" | "ready";
  error: string;
  busy: string;
  /** The sync loop cannot reach the homeserver and keeps retrying. */
  offline: boolean;
  session: session.Session | null;
  view: "server" | "direct";
  servers: Server[];
  loose: Channel[];
  directs: people.Direct[];
  invites: people.Invite[];
  activeServer: string | null;
  activeChannel: string | null;
  messages: Message[];
  occupants: Record<string, string[]>;
  voiceChannel: string | null;
  addServerOpen: boolean;
  serverCard: ServerCard | null;
  profileUser: string | null;
  userMenu: UserMenu | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  screenPickerOpen: boolean;
  cameraPickerOpen: boolean;
  /** Show the call itself (tiles and shares) instead of the chat. */
  callView: boolean;
  /** Tile to expand in the call, requested from the mini player. */
  callFocus: string | null;
  sas: crypto.SasView | null;
  /** Menu of the share button while sharing: where to show it. */
  screenMenu: { x: number; y: number } | null;
  /** Context menu of a screen share. */
  streamMenu: { identity: string; x: number; y: number } | null;
  myPresence: people.Presence;
  statusMode: StatusMode;
  uploads: Upload[];
  lightbox: Lightbox | null;
  replyTo: ReplyPreview | null;
  editing: { eventId: string; body: string } | null;
  myName: string;
  myAvatar: string;
  tick: number;
  serverSettingsOpen: boolean;
  serverTab: ServerTab;
  channelEdit: string | null;
  searchOpen: boolean;
  searchHits: msg.Hit[];
  searching: boolean;
  typing: string[];
  highlight: string | null;
  /** The member list on the right is collapsed. */
  membersHidden: boolean;
  /** The chat panel next to the call. */
  callChat: boolean;
  /** The tile last expanded in the call; the mini player shows it outside the call. */
  lastFocus: string | null;
  /** Context menu of a channel or a server icon. */
  placeMenu: { kind: "room" | "server"; id: string; x: number; y: number } | null;
};

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

function loadStatusMode(): StatusMode {
  try {
    const v = localStorage.getItem("app.status");
    return v === "unavailable" || v === "offline" ? v : "auto";
  } catch {
    return "auto";
  }
}

export const app = createStore<AppState>({
  phase: "login",
  error: "",
  busy: "",
  offline: false,
  session: null,
  view: "server",
  servers: [],
  loose: [],
  directs: [],
  invites: [],
  activeServer: null,
  activeChannel: null,
  messages: [],
  occupants: {},
  voiceChannel: null,
  addServerOpen: false,
  serverCard: null,
  profileUser: null,
  userMenu: null,
  settingsOpen: false,
  settingsTab: "profile",
  screenPickerOpen: false,
  cameraPickerOpen: false,
  callView: false,
  callFocus: null,
  sas: null,
  screenMenu: null,
  streamMenu: null,
  myPresence: "online",
  statusMode: loadStatusMode(),
  uploads: [],
  lightbox: null,
  replyTo: null,
  editing: null,
  myName: "",
  myAvatar: "",
  tick: 0,
  serverSettingsOpen: false,
  serverTab: "overview",
  channelEdit: null,
  searchOpen: false,
  searchHits: [],
  searching: false,
  typing: [],
  highlight: null,
  membersHidden: loadFlag("app.members-hidden"),
  callChat: loadFlag("app.call-chat"),
  lastFocus: null,
  placeMenu: null,
});

/** Wake subscribers when data changed outside the store fields. */
function bump(): void {
  app.set({ tick: app.get().tick + 1 });
}

let client: MatrixClient | null = null;
type MembershipInfo = {
  roomId: string;
  type: string;
  stateKey: string;
  content: Record<string, any>;
  delayId: string | null;
  refreshTimer: number;
  keepTimer: number;
};

let membershipInfo: MembershipInfo | null = null;

export function matrix(): MatrixClient {
  if (!client) throw new Error("client is not started");
  return client;
}

export function me(): string {
  return client?.getUserId() ?? "";
}

export function toggleMembers(): void {
  const hidden = !app.get().membersHidden;
  saveFlag("app.members-hidden", hidden);
  app.set({ membersHidden: hidden });
}

export function toggleCallChat(open = !app.get().callChat): void {
  saveFlag("app.call-chat", open);
  app.set({ callChat: open });
  if (open) readActive();
}

/* ------------------------------------------------------------------- people */

// searching all rooms is not cheap, and names and avatars are drawn on every row
const profileCache = new Map<string, { name: string; avatar: string }>();

function lookupMember(userId: string, roomId?: string | null): { name: string; avatar: string } {
  const state = app.get();
  const candidates = [roomId, state.activeChannel, state.voiceChannel].filter(Boolean) as string[];
  let name = "";
  let avatar = "";

  for (const id of candidates) {
    const member = client?.getRoom(id)?.getMember(userId);
    if (!member) continue;
    name = name || member.name;
    avatar = avatar || member.getMxcAvatarUrl() || "";
    if (name && avatar) return { name, avatar };
  }
  for (const room of client?.getRooms() ?? []) {
    const member = room.getMember(userId);
    if (!member) continue;
    name = name || member.name;
    avatar = avatar || member.getMxcAvatarUrl() || "";
    if (name && avatar) break;
  }

  const user = client?.getUser(userId);
  return {
    name: name || user?.displayName || userId.split(":")[0].replace("@", ""),
    avatar: avatar || user?.avatarUrl || "",
  };
}

function profileBits(userId: string, roomId?: string | null): { name: string; avatar: string } {
  if (!userId) return { name: "", avatar: "" };
  const key = `${userId}|${roomId ?? ""}`;
  const hit = profileCache.get(key);
  if (hit) return hit;
  const found = lookupMember(userId, roomId);
  profileCache.set(key, found);
  return found;
}

/** Display name instead of the raw Matrix id. */
export function displayName(userId: string, roomId?: string | null): string {
  return profileBits(userId, roomId).name;
}

/** Avatar mxc of a person, "" if none. */
export function avatarMxc(userId: string, roomId?: string | null): string {
  return profileBits(userId, roomId).avatar;
}

/* ------------------------------------------------------------------ startup */

let occupantsTimer = 0;
let stopVerifyListener: (() => void) | null = null;

function afterConnect(s: session.Session, c: MatrixClient): void {
  configureMedia(c, s.accessToken);
  profileCache.clear();
  // call memberships expire by time without any event, so they are re-read every minute
  window.clearInterval(occupantsTimer);
  occupantsTimer = window.setInterval(() => refreshOccupants(), 60_000);
  startHotkeys({
    mute: (down) => down && void voice.toggleMuted(),
    deafen: (down) => down && void voice.toggleDeafened(),
    ptt: (down) => voice.setPttHeld(down),
    camera: (down) => down && void toggleCamera(),
    screen: (down) => down && void toggleScreen(),
    leave: (down) => down && void leaveVoice(),
  });
  // Element on another device may offer to verify this sign-in by itself
  stopVerifyListener?.();
  stopVerifyListener = crypto.listenVerification(c, (v) => app.set({ sas: v }));
  last = loadLast(s.userId);
}

function refreshMe(): void {
  if (!client) return;
  const id = client.getUserId() ?? "";
  const user = client.getUser(id);
  app.set({ myName: user?.displayName || displayName(id), myAvatar: user?.avatarUrl || avatarMxc(id) });
}

/** Everything after the client exists: sync, lists, the last opened channel. */
async function launch(s: session.Session, c: MatrixClient): Promise<void> {
  afterConnect(s, c);
  wire(c);
  restoreView();
  await session.start(c);
  startPrefsSync(c);
  refreshRooms();
  refreshMe();
  app.set({ phase: "ready" });
  restoreChannel();
  startPresence();
}

export async function bootstrap(): Promise<void> {
  const saved = session.loadSession();
  if (!saved) {
    app.set({ phase: "login" });
    return;
  }
  await connect(saved);
}

/**
 * Start the client for a stored session. On failure the session is kept and
 * the loading screen offers a retry: a crypto or storage error today does not
 * mean the sign-in is lost. Only a token revoked by the server ends it.
 */
async function connect(s: session.Session): Promise<boolean> {
  app.set({ phase: "loading", session: s, error: "", busy: "", offline: false });
  const c = session.createSessionClient(s);
  client = c;
  try {
    await launch(s, c);
    return true;
  } catch (e) {
    // a newer attempt or a sign-out already replaced this client
    if (client !== c) return false;
    if (session.isSessionGone(e)) {
      await sessionGone();
      return false;
    }
    await teardown().catch(() => undefined);
    c.stopClient();
    client = null;
    configureMedia(null, "");
    app.set({ offline: false, error: t("login.err.restore", { error: humanError(e) }) });
    return false;
  }
}

/** A fresh sign-in: store the session and start everything as on launch. */
async function enter(s: session.Session): Promise<boolean> {
  session.saveSession(s);
  return connect(s);
}

export async function doLogin(server: string, user: string, password: string): Promise<void> {
  app.set({ busy: t("busy.signingIn"), error: "" });
  let s: session.Session;
  try {
    s = await session.login(server, user, password);
  } catch (e) {
    app.set({ busy: "", phase: "login", error: loginErrorText(e) });
    return;
  }
  await enter(s);
}

/** Create an account and sign in. The display name can be set right away. */
export async function doRegister(server: string, username: string, password: string, shownName: string): Promise<void> {
  app.set({ busy: t("busy.registering"), error: "" });
  let s: session.Session;
  try {
    s = await session.register(server, username, password);
  } catch (e) {
    app.set({ busy: "", phase: "login", error: humanError(e) });
    return;
  }
  if ((await enter(s)) && shownName.trim() && client) {
    await people.setName(client, shownName).catch(() => undefined);
    refreshMe();
  }
}

/** Sign-in details: without them it is unclear where and as whom the client knocked. */
function loginErrorText(e: unknown): string {
  if (!(e instanceof session.LoginError)) return humanError(e);
  const lines = [e.message, t("login.err.homeserver", { url: e.homeserver }), t("login.err.user", { user: e.identifier })];
  if (e.errcode || e.serverMessage) {
    lines.push(t("login.err.answer", { answer: [e.errcode, e.serverMessage].filter(Boolean).join(" ") }));
  }
  return lines.join("\n");
}

/** Stop everything bound to the current client. The stored session is not touched. */
async function teardown(): Promise<void> {
  window.clearInterval(presenceTimer);
  window.clearInterval(occupantsTimer);
  stopPrefsSync();
  stopVerifyListener?.();
  stopVerifyListener = null;
  await leaveVoice();
}

let endingSession = false;

/** The server revoked this sign-in: signed out elsewhere, or the account was deactivated. */
async function sessionGone(): Promise<void> {
  if (endingSession || !client) return;
  endingSession = true;
  try {
    await doLogout();
  } finally {
    endingSession = false;
  }
  app.set({ error: t("login.err.expired") });
}

/**
 * Sign out from the loading screen after a failed start. There is no running
 * client, so a temporary one ends the session on the server if it answers.
 */
export async function abandonSession(): Promise<void> {
  const s = app.get().session;
  await session.logout(s ? session.createSessionClient(s) : null);
  app.set({ phase: "login", session: null, error: "", busy: "", offline: false });
}

export async function doLogout(): Promise<void> {
  await teardown();
  await session.logout(client);
  client = null;
  configureMedia(null, "");
  profileCache.clear();
  setTrayUnread(0);
  app.set({
    phase: "login",
    offline: false,
    session: null,
    servers: [],
    loose: [],
    directs: [],
    invites: [],
    activeServer: null,
    activeChannel: null,
    messages: [],
    occupants: {},
    profileUser: null,
    userMenu: null,
    settingsOpen: false,
    serverSettingsOpen: false,
    screenPickerOpen: false,
    lightbox: null,
    replyTo: null,
    editing: null,
    myName: "",
    myAvatar: "",
    error: "",
    busy: "",
  });
}

function wire(c: MatrixClient): void {
  c.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
    if (!room) return;
    if (room.roomId === app.get().activeChannel) {
      scheduleMessages();
      readActive();
    }
    if (event.getType() === "m.room.message") {
      scheduleRooms();
      notify(event, room);
    }
  });
  c.on(RoomEvent.Redaction, (_ev, room) => {
    if (room?.roomId === app.get().activeChannel) scheduleMessages();
  });
  // an own message or edit reached the server; otherwise the edit shows only with the next event
  c.on(RoomEvent.LocalEchoUpdated, (_ev, room) => {
    if (room.roomId === app.get().activeChannel) scheduleMessages();
  });
  c.on(MatrixEventEvent.Decrypted, (ev) => {
    if (ev.getRoomId() === app.get().activeChannel) scheduleMessages();
    // encrypted rooms are counted by the client only after decryption
    scheduleRooms();
    // an encrypted message is only a message once decrypted: notify now
    const room = c.getRoom(ev.getRoomId() ?? "");
    if (room && ev.getType() === "m.room.message" && !ev.isDecryptionFailure()) notify(ev, room);
  });
  c.on(RoomStateEvent.Events, (ev) => {
    const type = ev.getType();
    if (rtc.MEMBER_TYPES.includes(type as (typeof rtc.MEMBER_TYPES)[number])) {
      keepOwnMembership(ev);
      refreshOccupants();
    } else if (type === "m.space.child" || type === "m.room.name" || type === "m.room.topic") {
      scheduleRooms();
    } else if (type === "m.room.member" || type === "m.room.avatar") {
      profileCache.clear();
      scheduleMessages();
      bump();
    } else if (type === "m.room.power_levels") {
      // a role was granted or revoked: buttons, badges and cards must see it without a restart
      profileCache.clear();
      scheduleRooms();
      scheduleMessages();
      bump();
    }
  });
  c.on(ClientEvent.Room, () => scheduleRooms());
  // own read receipts from another device clear the badges here too
  c.on(RoomEvent.Receipt, () => scheduleRooms());
  c.on(RoomEvent.MyMembership, () => scheduleRooms());
  c.on(ClientEvent.AccountData, (ev) => {
    if (ev.getType() === "m.direct") refreshDirects();
  });
  // presence arrives as a separate stream of events
  c.on(UserEvent.Presence, () => bump());
  c.on(RoomMemberEvent.Typing, (_ev, member) => {
    if (member.roomId === app.get().activeChannel) refreshTyping();
  });
  c.on(UserEvent.DisplayName, () => refreshMe());
  c.on(UserEvent.AvatarUrl, () => refreshMe());
  // Error comes after several failed syncs in a row; a single failed poll is Reconnecting
  c.on(ClientEvent.Sync, (state: SyncState) => {
    if (client !== c) return;
    const offline = state === SyncState.Error;
    if (offline !== app.get().offline) app.set({ offline });
    // Unread counts arrive with the sync after the timeline events were
    // announced; without a refresh here the badges waited for the next event.
    if (state === SyncState.Syncing) scheduleRooms();
  });
  c.on(HttpApiEvent.SessionLoggedOut, () => {
    if (client === c) void sessionGone();
  });
}

/* ------------------------------------------------------------------ refresh */

let roomsTimer = 0;

/**
 * Rebuild the room lists a moment later, once per burst. A busy channel or
 * the initial sync delivers events in batches, and rebuilding every list per
 * event is wasted work.
 */
function scheduleRooms(): void {
  if (roomsTimer) return;
  roomsTimer = window.setTimeout(() => {
    roomsTimer = 0;
    refreshRooms();
  }, 60);
}

export function refreshRooms(): void {
  if (!client) return;
  profileCache.clear();
  const servers = listServers(client);
  const loose = looseChannels(client, servers);
  const state = app.get();

  let activeServer = state.activeServer;
  if (activeServer && !servers.some((g) => g.spaceId === activeServer)) activeServer = null;
  if (!activeServer && servers.length) activeServer = servers[0].spaceId;

  app.set({ servers, loose, activeServer });
  refreshDirects();
  refreshOccupants();
}

export function refreshDirects(): void {
  if (!client) return;
  const directs = people.listDirects(client);
  const invites = people.listInvites(client);
  app.set({ directs, invites });
  setTrayUnread(unreadForTray());
}

/** A channel counts as muted when it or its whole server is muted. */
export function roomMuted(roomId: string): boolean {
  if (isMuted("rooms", roomId)) return true;
  const home = serverOf(roomId);
  return !!home && isMuted("servers", home.spaceId);
}

/**
 * The red dot on the tray and taskbar icons: direct messages, invites and
 * mentions always; other channel messages only in "all" notification mode
 * and when the channel is not muted.
 */
function unreadForTray(): number {
  const s = app.get();
  const mode = getNotifyMode();
  let n = s.directs.filter((d) => !isMuted("users", d.userId)).reduce((sum, d) => sum + d.unread, 0) + s.invites.length;
  for (const g of s.servers) {
    for (const ch of g.channels) {
      if (ch.kind !== "text") continue;
      if (ch.mentions > 0) n += ch.mentions;
      else if (mode === "all" && !roomMuted(ch.roomId)) n += ch.unread;
    }
  }
  return n;
}

export async function acceptInvite(invite: people.Invite): Promise<void> {
  if (!client) return;
  app.set({ busy: t("busy.acceptingInvite"), error: "" });
  try {
    await people.acceptInvite(client, invite);
    if (invite.space) {
      app.set({ busy: t("busy.joiningChannels") });
      await joinDefaultChannels(client, invite.roomId).catch(() => undefined);
    }
    refreshRooms();
    app.set({ busy: "" });
    if (invite.space) {
      selectServer(invite.roomId);
    } else {
      app.set({ view: invite.direct ? "direct" : app.get().view });
      await openChat(invite.roomId);
    }
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
  }
}

export async function declineInvite(roomId: string): Promise<void> {
  if (!client) return;
  try {
    await people.declineInvite(client, roomId);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  refreshRooms();
}

/**
 * Memberships whose device was not in the call while we were: a client that
 * crashed or was killed leaves its membership behind until it expires. They
 * are remembered by state key and event, so a fresh join shows again.
 */
const ghosts = new Set<string>();
/** The media server of the current call: only memberships on it can be checked against it. */
let mediaFocus = "";
const missingSince = new Map<string, number>();
/** How long a membership may lack its device in the call before it counts as a ghost. */
const GHOST_AFTER_MS = 25_000;

function ghostKey(m: rtc.Membership): string {
  return `${m.stateKey}|${m.eventId}`;
}

/**
 * While in a call the connected devices are known: memberships without one
 * become ghosts after a grace period. Stale ones in the "_@user" format are
 * also cleared in the room, which anyone may do (see rtc.clearMembership), so
 * everybody else stops seeing them too.
 */
function checkGhosts(room: Room): void {
  const present = voice.presentIdentities();
  if (!client || !present.length) return;
  const devices = new Set(present.map((id) => id.split(":").slice(2).join(":")).filter(Boolean));
  const users = new Set(present.map((id) => id.split(":").slice(0, 2).join(":")));
  const now = Date.now();
  for (const m of rtc.memberships(room)) {
    if (m.expired || m.sender === client.getUserId()) continue;
    const theirs = rtc.focusOf(m).replace(/\/+$/, "");
    if (theirs && mediaFocus && theirs !== mediaFocus.replace(/\/+$/, "")) continue;
    const key = ghostKey(m);
    const here = m.deviceId ? devices.has(m.deviceId) : users.has(m.sender);
    // a device that has only just announced itself may still be connecting
    if (here || now - m.ts < GHOST_AFTER_MS) {
      missingSince.delete(key);
      continue;
    }
    const since = missingSince.get(key) ?? now;
    missingSince.set(key, since);
    if (now - since < GHOST_AFTER_MS || ghosts.has(key)) continue;
    ghosts.add(key);
    void rtc.clearMembership(client, room.roomId, m);
  }
}

export function refreshOccupants(): void {
  if (!client) return;
  const occupants: Record<string, string[]> = {};
  const live = app.get().voiceChannel;
  for (const server of app.get().servers) {
    for (const channel of server.channels) {
      if (channel.kind !== "voice") continue;
      const room = client.getRoom(channel.roomId);
      if (!room) continue;
      if (channel.roomId === live) checkGhosts(room);
      occupants[channel.roomId] = rtc.participantsInCall(room, (m) => ghosts.has(ghostKey(m)));
    }
  }
  app.set({ occupants });
}

function replyPreview(room: Room, eventId: string): ReplyPreview | null {
  if (!eventId) return null;
  const target = room.findEventById(eventId);
  if (!target) {
    return { eventId, sender: "", senderName: "", body: t("chat.replyNotLoaded") };
  }
  const { content } = msg.currentContent(target);
  const sender = target.getSender() ?? "";
  return {
    eventId,
    sender,
    senderName: room.getMember(sender)?.name || sender,
    body: msg.stripReplyFallback(String(content.body ?? "")).slice(0, 180),
  };
}

let messagesTimer = 0;

/**
 * Re-render the timeline a moment later, in one batch. The SDK attaches
 * edits and reactions after announcing the event; rendering immediately
 * would show the edit only with the next event.
 */
function scheduleMessages(): void {
  if (messagesTimer) return;
  messagesTimer = window.setTimeout(() => {
    messagesTimer = 0;
    refreshMessages();
  }, 30);
}

function refreshMessages(): void {
  const roomId = app.get().activeChannel;
  if (!client || !roomId) {
    app.set({ messages: [] });
    return;
  }
  const room = client.getRoom(roomId);
  if (!room) {
    app.set({ messages: [] });
    return;
  }
  const self = client.getUserId() ?? "";
  const messages: Message[] = [];
  const checks = msg.collectChecks(room);

  for (const ev of room.getLiveTimeline().getEvents()) {
    const type = ev.getType();
    const locked = type === "m.room.encrypted";
    if (type !== "m.room.message" && !locked) continue;
    // still decrypting: it shows up when ready
    if (locked && !ev.isDecryptionFailure()) continue;
    // edits and reactions are separate events and are not messages themselves
    if (ev.isRelation("m.replace") || ev.isRelation("m.annotation")) continue;
    if (ev.isRedacted() || ev.status === "cancelled") continue;

    const { content, edited } = msg.currentContent(ev);
    const sender = ev.getSender() ?? "";
    const member = room.getMember(sender);
    const media = locked ? null : mediaOf(content);

    messages.push({
      id: ev.getId() ?? String(ev.getTs()),
      sender,
      senderName: member?.name || sender,
      avatar: member?.getMxcAvatarUrl() || "",
      body: locked
        ? t("chat.locked")
        : media
          ? media.caption || media.name
          : msg.stripReplyFallback(String(content.body ?? "")),
      ts: ev.getTs(),
      own: sender === self,
      media,
      edited,
      reply: replyPreview(room, msg.replyTargetId(ev.getContent())),
      reactions: msg.reactionsFor(room, ev.getId() ?? "", self),
      canEdit: !locked && !ev.status && msg.isEditable(ev, self),
      canDelete: !ev.status && msg.mayRedact(room, ev, self),
      state: ev.status === "not_sent" ? "failed" : ev.status && ev.status !== "sent" ? "sending" : "sent",
      failReason: ev.status === "not_sent" ? String(ev.error?.message ?? "") : "",
      locked,
      checks: checks.get(ev.getId() ?? "") ?? {},
    });
  }

  app.set({ messages: messages.slice(-400) });
}

/**
 * An attachment from message content. In encrypted rooms the link is in
 * `file` together with the key. Captions follow MSC2530: if `filename` is set
 * and differs from `body`, the body is the caption.
 */
function mediaOf(content: Record<string, any>): Media | null {
  const file = content.file && typeof content.file.url === "string" ? (content.file as EncryptedFile) : null;
  const mxc = String(file?.url ?? content.url ?? "");
  if (!mxc.startsWith("mxc://")) return null;
  const msgtype = String(content.msgtype ?? "");
  const info = (content.info ?? {}) as Record<string, any>;
  const body = String(content.body ?? "");
  const filename = typeof content.filename === "string" ? content.filename : "";
  return {
    mxc,
    file,
    kind: msgtype === "m.image" ? "image" : msgtype === "m.video" ? "video" : msgtype === "m.audio" ? "audio" : "file",
    name: filename || body || t("chat.file"),
    mime: String(info.mimetype ?? file?.mimetype ?? ""),
    size: Number(info.size ?? 0),
    caption: filename && body && body !== filename ? body : "",
    w: Number(info.w ?? 0),
    h: Number(info.h ?? 0),
  };
}

/* --------------------------------------------------------------- navigation */

/**
 * The channel last opened on each server and in direct messages, stored per
 * account: coming back to a server opens the same channel.
 */
type Remembered = { roomId: string; call: boolean };
type LastSeen = { view: "server" | "direct"; server: string | null; channels: Record<string, Remembered> };

let last: LastSeen = { view: "server", server: null, channels: {} };

function lastKey(userId: string): string {
  return `app.last:${userId}`;
}

function loadLast(userId: string): LastSeen {
  try {
    const raw = localStorage.getItem(lastKey(userId));
    if (raw) {
      const got = JSON.parse(raw) as Partial<LastSeen>;
      return {
        view: got.view === "direct" ? "direct" : "server",
        server: typeof got.server === "string" ? got.server : null,
        channels: got.channels && typeof got.channels === "object" ? got.channels : {},
      };
    }
  } catch {
    // nothing stored
  }
  return { view: "server", server: null, channels: {} };
}

function saveLast(): void {
  const id = me();
  if (!id) return;
  try {
    localStorage.setItem(lastKey(id), JSON.stringify(last));
  } catch {
    // storage unavailable
  }
}

function placeKey(): string {
  const s = app.get();
  return s.view === "direct" ? "direct" : (s.activeServer ?? "loose");
}

function remember(roomId: string, call: boolean): void {
  const s = app.get();
  last.channels[placeKey()] = { roomId, call };
  last.view = s.view;
  last.server = s.activeServer;
  saveLast();
}

/** Before the first sync: return to the server or DMs where the user was last time. */
function restoreView(): void {
  app.set({ view: last.view, activeServer: last.server });
}

/** Open the channel last opened here, or the first text channel. */
function restoreChannel(): void {
  let s = app.get();
  if (s.activeChannel) return;
  // no servers yet but an invite is waiting: show it instead of emptiness
  if (s.view === "server" && !s.servers.length && s.invites.length) {
    app.set({ view: "direct" });
    s = app.get();
  }
  const saved = last.channels[placeKey()];

  if (s.view === "direct") {
    const d = s.directs.find((x) => x.roomId === saved?.roomId) ?? s.directs[0];
    if (d) void openChat(d.roomId);
    return;
  }

  const server = s.servers.find((g) => g.spaceId === s.activeServer);
  const channels = server ? server.channels : s.loose;
  const found = channels.find((c) => c.roomId === saved?.roomId && c.joined);
  if (found?.kind === "voice") {
    if (saved?.call && s.voiceChannel === found.roomId) showCall();
    else void openChat(found.roomId);
    return;
  }
  const target = found ?? channels.find((c) => c.kind === "text" && c.joined);
  if (target) void openChat(target.roomId);
}

export function selectServer(spaceId: string): void {
  // clicking the open server again resets nothing
  const now = app.get();
  if (now.view === "server" && now.activeServer === spaceId && now.activeChannel) return;
  app.set({
    view: "server",
    activeServer: spaceId,
    activeChannel: null,
    callView: false,
    messages: [],
    userMenu: null,
    replyTo: null,
    editing: null,
  });
  last.view = "server";
  last.server = spaceId;
  saveLast();
  restoreChannel();
}

export function showDirects(): void {
  const now = app.get();
  if (now.view === "direct" && now.activeChannel) return;
  app.set({ view: "direct", activeChannel: null, callView: false, messages: [], userMenu: null });
  refreshDirects();
  last.view = "direct";
  saveLast();
  restoreChannel();
}

/** Open the chat of a channel without touching voice. Voice channels have chats too. */
export async function openChat(roomId: string, joined = true): Promise<void> {
  app.set({
    callView: false,
    activeChannel: roomId,
    messages: [],
    userMenu: null,
    replyTo: null,
    editing: null,
    searchOpen: false,
    searchHits: [],
    typing: [],
    highlight: null,
  });
  remember(roomId, false);
  if (!joined && client) {
    app.set({ busy: t("busy.joiningChannel") });
    try {
      await client.joinRoom(roomId);
    } catch (e) {
      app.set({ error: humanError(e) });
    }
    app.set({ busy: "" });
    refreshRooms();
  }
  refreshMessages();
  refreshTyping();
  readActive();
}

export async function selectChannel(channel: Channel): Promise<void> {
  if (channel.kind === "voice") {
    // a click joins the conversation and shows the call
    const already = app.get().voiceChannel === channel.roomId;
    await openChat(channel.roomId, channel.joined);
    app.set({ callView: true });
    remember(channel.roomId, true);
    if (!already) {
      await joinVoice(channel);
      refreshMessages();
    }
    return;
  }
  await openChat(channel.roomId, channel.joined);
}

/** Back to the call: tiles instead of the chat. */
export function showCall(): void {
  const roomId = app.get().voiceChannel;
  if (!roomId) return;
  // the call lives on its own server: switch there if another one is open
  const home = app.get().servers.find((g) => g.channels.some((c) => c.roomId === roomId));
  if (home && (app.get().view !== "server" || app.get().activeServer !== home.spaceId)) {
    app.set({ view: "server", activeServer: home.spaceId });
  }
  if (app.get().activeChannel !== roomId) void openChat(roomId);
  app.set({ callView: true });
  remember(roomId, true);
}

export async function openDirectWith(userId: string): Promise<void> {
  if (!client || !userId || userId === me()) return;
  app.set({ busy: t("busy.openingChat"), error: "", profileUser: null, userMenu: null });
  try {
    const roomId = await people.openDirect(client, userId);
    refreshDirects();
    app.set({ busy: "", view: "direct" });
    await openChat(roomId);
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
  }
}

/* ----------------------------------------------------------------- messages */

export async function send(text: string): Promise<void> {
  const state = app.get();
  const roomId = state.activeChannel;
  if (!client || !roomId || !text.trim()) return;
  typingNow(false);

  if (state.editing) {
    const target = state.editing.eventId;
    app.set({ editing: null });
    await msg.editText(client, roomId, target, text);
    return;
  }

  const reply = state.replyTo;
  app.set({ replyTo: null });
  await msg.sendText(
    client,
    roomId,
    text,
    reply ? { eventId: reply.eventId, sender: reply.sender, senderName: reply.senderName, body: reply.body } : null,
  );
}

let uploadLimit: Promise<number> | null = null;

/** Maximum upload size in bytes, asked once. */
export function maxUpload(): Promise<number> {
  if (!client) return Promise.resolve(0);
  uploadLimit ??= client
    .getMediaConfig()
    .then((c) => Number(c["m.upload.size"] ?? 0))
    .catch(() => 0);
  return uploadLimit;
}

function setUpload(id: string, patch: Partial<Upload> | null): void {
  const list = app.get().uploads;
  if (patch === null) app.set({ uploads: list.filter((u) => u.id !== id) });
  else app.set({ uploads: list.map((u) => (u.id === id ? { ...u, ...patch } : u)) });
}

async function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  } catch {
    return null;
  }
}

const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yml: "text/yaml",
  yaml: "text/yaml",
  xml: "text/xml",
  ini: "text/plain",
  cfg: "text/plain",
  toml: "text/plain",
};

/** Browsers give no type to .md, .log and similar files. */
function mimeByName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * One attachment. In an encrypted room the file is encrypted here and the
 * server stores only ciphertext, as in Element. Captions follow MSC2530.
 */
async function sendAttachment(roomId: string, file: File, caption: string, reply: ReplyPreview | null): Promise<void> {
  const c = client;
  if (!c) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  app.set({ uploads: [...app.get().uploads, { id, name: file.name, progress: 0 }] });
  try {
    const mime = file.type || mimeByName(file.name);
    const kind = mime.startsWith("image/")
      ? "m.image"
      : mime.startsWith("video/")
        ? "m.video"
        : mime.startsWith("audio/")
          ? "m.audio"
          : "m.file";
    const info: Record<string, unknown> = { mimetype: mime, size: file.size };
    if (kind === "m.image") {
      const dims = await imageSize(file);
      if (dims) Object.assign(info, dims);
    }
    const progressHandler = (p: { loaded: number; total: number }) =>
      setUpload(id, { progress: p.total ? p.loaded / p.total : 0 });

    const content: Record<string, unknown> = { msgtype: kind, body: caption || file.name, info };
    if (caption) content.filename = file.name;

    if (c.getRoom(roomId)?.hasEncryptionStateEvent()) {
      const { data, file: enc } = await encryptAttachment(await file.arrayBuffer());
      const up = await c.uploadContent(new Blob([data]), {
        type: "application/octet-stream",
        includeFilename: false,
        progressHandler,
      });
      content.file = { ...enc, url: up.content_uri, mimetype: mime };
    } else {
      const up = await c.uploadContent(file, { type: mime, name: file.name, progressHandler });
      content.url = up.content_uri;
    }
    if (reply) content["m.relates_to"] = { "m.in_reply_to": { event_id: reply.eventId } };
    await c.sendMessage(roomId, content as never);
  } catch (e) {
    app.set({ error: t("chat.err.upload", { name: file.name, error: humanError(e) }) });
  } finally {
    setUpload(id, null);
  }
}

/**
 * Send what was composed: text and attachments together. One file with text
 * goes as one message with a caption; several files go after the text.
 */
export async function sendMessage(text: string, files: File[]): Promise<void> {
  const state = app.get();
  const roomId = state.activeChannel;
  if (!client || !roomId) return;
  if (state.editing || !files.length) {
    await send(text);
    return;
  }
  typingNow(false);
  let reply = state.replyTo;
  app.set({ replyTo: null });

  const caption = files.length === 1 ? text.trim() : "";
  if (text.trim() && !caption) {
    try {
      await msg.sendText(client, roomId, text, reply);
    } catch (e) {
      app.set({ error: humanError(e) });
    }
    reply = null;
  }
  for (const [i, file] of files.entries()) {
    await sendAttachment(roomId, file, i === 0 ? caption : "", i === 0 ? reply : null);
  }
}

/** The last own text message: Up Arrow in an empty field edits it. */
export function editLastOwn(): boolean {
  const mine = [...app.get().messages].reverse().find((m) => m.own && m.canEdit);
  if (!mine) return false;
  startEdit(mine);
  return true;
}

/** Retry a message that failed to send. */
export async function resend(id: string): Promise<void> {
  const room = client?.getRoom(app.get().activeChannel ?? "");
  const ev = room?.findEventById(id);
  if (!client || !room || !ev) return;
  try {
    await client.resendEvent(ev, room);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  scheduleMessages();
}

/** Drop a message that failed to send. */
export function discard(id: string): void {
  const room = client?.getRoom(app.get().activeChannel ?? "");
  const ev = room?.findEventById(id);
  if (!client || !ev) return;
  client.cancelPendingEvent(ev);
  scheduleMessages();
}

export function startReply(m: Message): void {
  app.set({
    replyTo: { eventId: m.id, sender: m.sender, senderName: m.senderName, body: m.body.slice(0, 180) },
    editing: null,
    userMenu: null,
  });
}

export function startEdit(m: Message): void {
  app.set({ editing: { eventId: m.id, body: m.body }, replyTo: null, userMenu: null });
}

export function cancelCompose(): void {
  app.set({ replyTo: null, editing: null });
}

export async function deleteMessage(id: string): Promise<void> {
  const roomId = app.get().activeChannel;
  if (!client || !roomId) return;
  try {
    await msg.remove(client, roomId, id);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

export function openImage(url: string, name: string): void {
  app.set({ lightbox: { url, name } });
}

export function closeImage(): void {
  app.set({ lightbox: null });
}

/* -------------------------------------------------- reactions, search, typing */

/** Tick or untick a checklist item of any message. Everyone in the room sees the latest state. */
export async function toggleCheck(eventId: string, key: string, done: boolean): Promise<void> {
  const roomId = app.get().activeChannel;
  if (!client || !roomId) return;
  try {
    await msg.sendCheck(client, roomId, eventId, key, done);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

export async function toggleReaction(eventId: string, key: string): Promise<void> {
  const state = app.get();
  const roomId = state.activeChannel;
  if (!client || !roomId) return;
  const mine = state.messages.find((m) => m.id === eventId)?.reactions.find((r) => r.key === key)?.mine;
  try {
    if (mine) await msg.remove(client, roomId, mine);
    else await msg.react(client, roomId, eventId, key);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

export async function runSearch(term: string): Promise<void> {
  const roomId = app.get().activeChannel;
  if (!client || !roomId || !term.trim()) {
    app.set({ searchHits: [] });
    return;
  }
  app.set({ searching: true, error: "" });
  try {
    app.set({ searchHits: await msg.search(client, roomId, term.trim()) });
  } catch (e) {
    app.set({ error: t("chat.err.search", { error: humanError(e) }), searchHits: [] });
  }
  app.set({ searching: false });
}

/** Jump to a found message: page back through history until it is loaded, then highlight it. */
export async function jumpTo(eventId: string): Promise<void> {
  const roomId = app.get().activeChannel;
  if (!client || !roomId) return;
  const room = client.getRoom(roomId);
  if (!room) return;

  app.set({ busy: t("busy.searchingHistory") });
  for (let i = 0; i < 25 && !room.findEventById(eventId); i += 1) {
    const before = room.getLiveTimeline().getEvents().length;
    try {
      await client.scrollback(room, 60);
    } catch {
      break;
    }
    if (room.getLiveTimeline().getEvents().length === before) break;
  }
  refreshMessages();
  const found = !!room.findEventById(eventId);
  app.set({
    busy: "",
    highlight: found ? eventId : null,
    error: found ? "" : t("chat.err.tooFar"),
  });
}

function refreshTyping(): void {
  const roomId = app.get().activeChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  const self = client?.getUserId();
  const typing = room
    ? room
        .getMembers()
        .filter((m) => m.typing && m.userId !== self)
        .map((m) => m.name || m.userId)
    : [];
  app.set({ typing });
}

let typingSent = 0;

/** Report typing, at most once every three seconds. */
export function typingNow(active: boolean): void {
  const roomId = app.get().activeChannel;
  if (!client || !roomId) return;
  const now = Date.now();
  if (active && now - typingSent < 3000) return;
  if (!active && !typingSent) return;
  typingSent = active ? now : 0;
  void client.sendTyping(roomId, active, 5000).catch(() => undefined);
}

let reading = false;

function readActive(): void {
  const roomId = app.get().activeChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !room || reading || document.hidden) return;
  reading = true;
  void msg
    .markRead(client, room)
    .catch(() => undefined)
    .finally(() => {
      reading = false;
      scheduleRooms();
    });
}

// back to the window: whatever arrived meanwhile in the open chat is read
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) readActive();
  });
}

/** Mark a channel read without opening it. */
export async function markRoomRead(roomId: string): Promise<void> {
  const room = client?.getRoom(roomId);
  if (!client || !room) return;
  await msg.markRead(client, room).catch(() => undefined);
  scheduleRooms();
}

/** Mark every channel of a server read. */
export async function markServerRead(spaceId: string): Promise<void> {
  const server = app.get().servers.find((g) => g.spaceId === spaceId);
  for (const ch of server?.channels ?? []) {
    if (ch.unread > 0) await markRoomRead(ch.roomId);
  }
}

/** A readable name for a muted chat, server or person. */
export function muteLabel(kind: "rooms" | "servers" | "users", id: string): string {
  if (kind === "users") return `${displayName(id)} (${id})`;
  if (kind === "servers") return app.get().servers.find((g) => g.spaceId === id)?.name ?? id;
  const direct = app.get().directs.find((d) => d.roomId === id);
  if (direct) return direct.name;
  const home = serverOf(id);
  const channel = home?.channels.find((c) => c.roomId === id) ?? app.get().loose.find((c) => c.roomId === id);
  const name = channel?.name ?? client?.getRoom(id)?.name ?? id;
  return home ? `${home.name} · ${name}` : name;
}

export function openPlaceMenu(kind: "room" | "server", id: string, x: number, y: number): void {
  app.set({ placeMenu: { kind, id, x, y }, userMenu: null, streamMenu: null, screenMenu: null });
}

export function closePlaceMenu(): void {
  if (app.get().placeMenu) app.set({ placeMenu: null });
}

/* ----------------------------------------------------------- administration */

export type ServerAccess = {
  level: number;
  channels: boolean;
  server: boolean;
  roles: boolean;
  kick: boolean;
  ban: boolean;
};

const NO_ACCESS: ServerAccess = { level: 0, channels: false, server: false, roles: false, kick: false, ban: false };

/** What the current user may do on the server. Buttons depend on it. */
export function access(spaceId: string | null = app.get().activeServer): ServerAccess {
  if (!client || !spaceId) return NO_ACCESS;
  const level = admin.myLevel(client, spaceId);
  const perms = admin.readPerms(client, spaceId);
  return {
    level,
    channels: level >= perms.channels,
    server: level >= perms.server,
    roles: level >= perms.roles,
    kick: level >= perms.kick,
    ban: level >= perms.ban,
  };
}

function reportText(what: string, r: admin.Report): string {
  if (!r.failed.length) return "";
  const where = r.failed.map((f) => `${f.name}: ${f.error}`).join("; ");
  return t("admin.partial", { what, ok: r.ok, total: r.ok + r.failed.length, where });
}

async function adminRun(busy: string, what: string, run: () => Promise<admin.Report | void>): Promise<boolean> {
  if (!client) return false;
  app.set({ busy, error: "" });
  try {
    const r = await run();
    app.set({ busy: "", error: r ? reportText(what, r) : "" });
    refreshRooms();
    bump();
    return !r || !r.failed.length;
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    return false;
  }
}

export function openServerSettings(tab: ServerTab = "overview"): void {
  app.set({ serverSettingsOpen: true, serverTab: tab, userMenu: null });
}

function need(): MatrixClient {
  if (!client) throw new Error("client is not started");
  return client;
}

export const serverAdmin = {
  members: (spaceId: string) => (client ? admin.serverMembers(client, spaceId) : []),
  bans: (spaceId: string) => (client ? admin.bannedUsers(client, spaceId) : []),
  perms: (spaceId: string) => (client ? admin.readPerms(client, spaceId) : null),
  alias: (spaceId: string) => (client ? admin.inviteAlias(client, spaceId) : ""),
  sendLevel: (roomId: string) => (client ? admin.sendLevel(client, roomId) : 0),
  levelOf: (spaceId: string, userId: string) => (client ? admin.levelOf(client.getRoom(spaceId), userId) : 0),
  /** The live order of a channel in the server, from the space state. */
  childOrder: (spaceId: string, roomId: string) =>
    String(client?.getRoom(spaceId)?.currentState.getStateEvents("m.space.child", roomId)?.getContent()?.order ?? ""),
  topicOf: (roomId: string) =>
    String(client?.getRoom(roomId)?.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic ?? ""),

  setRole: (spaceId: string, userId: string, level: number) =>
    adminRun(t("busy.role"), t("admin.what.role"), () => admin.setRole(need(), spaceId, userId, level)),
  kick: (spaceId: string, userId: string, reason: string) =>
    adminRun(t("busy.kick"), t("admin.what.kick"), () => admin.kick(need(), spaceId, userId, reason)),
  ban: (spaceId: string, userId: string, reason: string) =>
    adminRun(t("busy.ban"), t("admin.what.ban"), () => admin.ban(need(), spaceId, userId, reason)),
  unban: (spaceId: string, userId: string) =>
    adminRun(t("busy.unban"), t("admin.what.unban"), () => admin.unban(need(), spaceId, userId)),
  writePerms: (spaceId: string, perms: admin.Perms) =>
    adminRun(t("busy.perms"), t("admin.what.perms"), () => admin.writePerms(need(), spaceId, perms)),

  rename: (roomId: string, name: string) => adminRun(t("busy.rename"), "", () => admin.setName(need(), roomId, name)),
  topic: (roomId: string, topic: string) => adminRun(t("busy.topic"), "", () => admin.setTopic(need(), roomId, topic)),
  avatar: (roomId: string, file: File | null) => adminRun(t("busy.picture"), "", () => admin.setAvatar(need(), roomId, file)),
  setSendLevel: (roomId: string, level: number) =>
    adminRun(t("busy.channelPerms"), "", () => admin.setSendLevel(need(), roomId, level)),
  reorder: (spaceId: string, ids: string[]) => adminRun(t("busy.reorder"), "", () => admin.reorder(need(), spaceId, ids)),
  drift: (spaceId: string) => (client ? admin.roleDrift(client, spaceId) : []),
  syncRoles: (spaceId: string) =>
    adminRun(t("busy.syncRoles"), t("admin.what.syncRoles"), () => admin.syncRoles(need(), spaceId)),
  owner: (spaceId: string) => (client ? admin.creatorOf(client.getRoom(spaceId)) : ""),
  browse: (spaceId: string): Promise<BrowseChannel[]> => (client ? browseChannels(client, spaceId) : Promise.resolve([])),
  removeChannel: (spaceId: string, roomId: string) =>
    adminRun(t("busy.deleteChannel"), "", async () => {
      await deleteChannel(need(), spaceId, roomId);
      if (app.get().activeChannel === roomId) app.set({ activeChannel: null, messages: [] });
      app.set({ channelEdit: null });
    }),
};

/* ------------------------------------------------------ own channel list */

/** Join a channel from the channel list in server settings: it appears on the left. */
export async function showChannel(channel: BrowseChannel): Promise<boolean> {
  if (!client) return false;
  try {
    await joinChannel(client, channel.roomId, channel.via);
    refreshRooms();
    return true;
  } catch (e) {
    app.set({ error: t("channels.err.join", { name: channel.name, error: humanError(e) }) });
    return false;
  }
}

/** Remove a channel from the own list by leaving the room; it can be added back later. */
export async function hideChannel(roomId: string): Promise<boolean> {
  if (!client) return false;
  if (app.get().voiceChannel === roomId) await leaveVoice();
  try {
    await leaveChannel(client, roomId);
  } catch (e) {
    app.set({ error: humanError(e) });
    return false;
  }
  if (app.get().activeChannel === roomId) {
    app.set({ activeChannel: null, messages: [], callView: false });
    refreshRooms();
    restoreChannel();
  } else {
    refreshRooms();
  }
  return true;
}

/* ------------------------------------------------------- invite to a server */

const FULL_USER_ID = /^@[^:\s]+:\S+$/;

/** Invite a person to the server: the invite appears under their home button. */
export async function inviteToServer(spaceId: string, userId: string): Promise<boolean> {
  if (!client) return false;
  const id = userId.trim();
  if (!FULL_USER_ID.test(id)) {
    app.set({ error: t("invite.err.fullId") });
    return false;
  }
  app.set({ busy: t("busy.inviting"), error: "" });
  try {
    await client.invite(spaceId, id);
    app.set({ busy: "" });
    return true;
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    return false;
  }
}

/** Who may join by themselves: "public" means by address, otherwise by invite only. */
export function serverJoinRule(spaceId: string): string {
  return client?.getRoom(spaceId)?.getJoinRule() ?? "";
}

/** Give the server an address like #main:domain so friends can add it by domain alone. */
export async function makeServerAddress(spaceId: string, localpart: string): Promise<boolean> {
  if (!client) return false;
  const name = localpart.trim().replace(/^#/, "").split(":")[0].toLowerCase();
  if (!/^[a-z0-9._=-]+$/.test(name)) {
    app.set({ error: t("address.err.latin") });
    return false;
  }
  const alias = `#${name}:${client.getDomain() ?? ""}`;
  app.set({ busy: t("busy.address"), error: "" });
  try {
    await client.createAlias(alias, spaceId);
    await client.sendStateEvent(spaceId, "m.room.canonical_alias" as never, { alias } as never, "");
    app.set({ busy: "" });
    bump();
    return true;
  } catch (e) {
    const text = humanError(e);
    app.set({ busy: "", error: /M_ROOM_IN_USE|in use/i.test(text) ? t("address.err.taken", { alias }) : text });
    return false;
  }
}

/** Let anyone with the address join; otherwise only invited people can. */
export async function openServerJoin(spaceId: string): Promise<void> {
  if (!client) return;
  app.set({ busy: t("busy.openJoin"), error: "" });
  try {
    await client.sendStateEvent(spaceId, "m.room.join_rules" as never, { join_rule: "public" } as never, "");
    bump();
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

/* ------------------------------------------------------------ people search */

export function searchPeopleNow(term: string): people.UserHit[] {
  return client ? people.searchLocalUsers(client, term) : [];
}

export function searchPeople(term: string): Promise<people.UserHit[]> {
  return client ? people.searchUsers(client, term) : Promise.resolve([]);
}

/* ------------------------------------------------------------------ servers */

export async function previewServer(domain: string): Promise<void> {
  if (!client) return;
  app.set({ busy: t("busy.findingServer"), error: "", serverCard: null });
  try {
    const card = await lookupServer(client, domain);
    app.set({ serverCard: card, busy: "" });
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
  }
}

export async function addServer(): Promise<void> {
  const card = app.get().serverCard;
  if (!client || !card) return;
  app.set({ busy: t("busy.joiningServer", { name: card.name }), error: "" });
  try {
    const spaceId = await joinServer(client, card);
    app.set({ busy: t("busy.joiningChannels") });
    await joinDefaultChannels(client, spaceId).catch(() => undefined);
    refreshRooms();
    app.set({ busy: "", addServerOpen: false, serverCard: null, activeServer: spaceId, view: "server", activeChannel: null });
    restoreChannel();
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
  }
}

export async function addChannel(name: string, kind: "text" | "voice"): Promise<void> {
  const spaceId = app.get().activeServer;
  if (!client || !spaceId || !name.trim()) return;
  app.set({ busy: t("busy.creatingChannel"), error: "" });
  try {
    await createChannel(client, { spaceId, name: name.trim(), kind });
    refreshRooms();
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

/* -------------------------------------------------------------------- voice */

export async function joinVoice(channel: Channel): Promise<void> {
  if (!client) return;
  if (app.get().voiceChannel === channel.roomId) return;
  await leaveVoice();

  app.set({ busy: t("busy.connecting", { name: channel.name }), error: "" });
  try {
    if (channel.joined === false) await client.joinRoom(channel.roomId);
    const room = client.getRoom(channel.roomId);
    if (!room) throw new Error(t("voice.err.noRoom"));

    const list = rtc.memberships(room);
    const template = rtc.pickTemplate(list, client.getUserId() ?? "");
    const fallback = await rtc.focusFromWellKnown(app.get().session?.homeserver ?? "");
    const focus = rtc.discoverFocus(list, channel.roomId, fallback);
    mediaFocus = focus.serviceUrl;
    if (!focus.serviceUrl) throw new Error(t("voice.err.noFocus"));

    const ticket = await rtc.getSfuTicket(client, focus.serviceUrl, focus.alias);
    await voice.connect(channel.roomId, ticket.url, ticket.jwt);

    const deviceId = client.getDeviceId() ?? "";
    const content = rtc.buildContent(template, deviceId, focus, Date.now());
    const type = template?.type ?? "org.matrix.msc3401.call.member";
    const published = await rtc.publishMembership(
      client,
      channel.roomId,
      type,
      content,
      rtc.mirrorStateKey(template, client.getUserId() ?? "", deviceId),
    );
    membershipInfo = {
      roomId: channel.roomId,
      ...published,
      content,
      delayId: null,
      refreshTimer: 0,
      keepTimer: 0,
    };
    keepMembership(membershipInfo);

    // microphone problems do not prevent joining, but they are reported
    app.set({ voiceChannel: channel.roomId, busy: "", error: voice.getState().error });
    refreshOccupants();
  } catch (e) {
    await voice.disconnect();
    app.set({ busy: "", error: humanError(e), voiceChannel: null });
  }
}

/**
 * Keep the own membership alive: extend its expiry and keep a delayed leave
 * event that the server sends by itself if the client disappears.
 */
function keepMembership(info: MembershipInfo): void {
  const c = client;
  if (!c) return;

  info.refreshTimer = window.setInterval(() => {
    info.content = rtc.extendContent(info.content);
    void c.sendStateEvent(info.roomId, info.type as never, info.content as never, info.stateKey).catch(() => undefined);
  }, rtc.REFRESH_MS);

  void rtc.scheduleLeave(c, info.roomId, info.type, info.stateKey).then((delayId) => {
    if (!delayId || membershipInfo !== info) {
      if (delayId) void rtc.cancelLeave(c, delayId);
      return;
    }
    info.delayId = delayId;
    info.keepTimer = window.setInterval(() => {
      const id = info.delayId;
      if (!id) return;
      void rtc.keepLeaveAway(c, id).then(async (alive) => {
        if (alive || membershipInfo !== info) return;
        // the delayed leave fired while we were silent: rejoin and schedule a new one
        info.content = rtc.extendContent(info.content);
        await c.sendStateEvent(info.roomId, info.type as never, info.content as never, info.stateKey).catch(() => undefined);
        info.delayId = await rtc.scheduleLeave(c, info.roomId, info.type, info.stateKey);
      });
    }, 8000);
  });
}

/**
 * Someone else cleared our membership while we are still connected: a client
 * that took us for a ghost during a network hiccup. It is written back.
 */
function keepOwnMembership(ev: MatrixEvent): void {
  const info = membershipInfo;
  const c = client;
  if (!info || !c || ev.getRoomId() !== info.roomId || ev.getType() !== info.type || ev.getStateKey() !== info.stateKey) return;
  if (Object.keys(ev.getContent() ?? {}).length || ev.getSender() === c.getUserId() || !voice.getState().connected) return;
  info.content = rtc.extendContent(info.content);
  void c.sendStateEvent(info.roomId, info.type as never, info.content as never, info.stateKey).catch(() => undefined);
}

function stopMembership(info: MembershipInfo): void {
  window.clearInterval(info.refreshTimer);
  window.clearInterval(info.keepTimer);
  if (client && info.delayId) void rtc.cancelLeave(client, info.delayId);
}

/**
 * The window closes while in a call. A regular request would not make it;
 * with keepalive the browser finishes it after the page is gone.
 */
function retractOnUnload(): void {
  const info = membershipInfo;
  const s = app.get().session;
  if (!info || !s) return;
  membershipInfo = null;
  const url =
    `${s.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(info.roomId)}` +
    `/state/${encodeURIComponent(info.type)}/${encodeURIComponent(info.stateKey)}`;
  void fetch(url, {
    method: "PUT",
    keepalive: true,
    headers: { Authorization: `Bearer ${s.accessToken}`, "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", retractOnUnload);
  window.addEventListener("beforeunload", retractOnUnload);
}

// a real quit, or the installer of an update: leave the call properly first
onBeforeQuit(() => leaveVoice().catch(() => undefined));
setBeforeInstall(() => leaveVoice().catch(() => undefined));

export async function leaveVoice(): Promise<void> {
  const info = membershipInfo;
  membershipInfo = null;
  if (info) stopMembership(info);
  await voice.disconnect();
  if (client && info) {
    await rtc.retractMembership(client, info.roomId, info.type, info.stateKey);
  }
  app.set({ voiceChannel: null, callView: false, cameraPickerOpen: false, lastFocus: null });
  refreshOccupants();
}

/**
 * A moderator may make someone leave a voice channel: whoever can kick on the
 * server and ranks above the person. The person's client of this app leaves
 * on its own; their call membership is also cleared in the room, so other
 * clients stop showing them.
 */
export function canDisconnectFromCall(userId: string): boolean {
  const roomId = app.get().voiceChannel;
  if (!client || !roomId || userId === me()) return false;
  const home = serverOf(roomId);
  const can = access(home?.spaceId ?? null);
  return can.kick && admin.levelOf(client.getRoom(home?.spaceId ?? roomId), userId) < can.level;
}

export async function disconnectFromCall(userId: string): Promise<void> {
  const roomId = app.get().voiceChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !room || !canDisconnectFromCall(userId)) return;
  for (const identity of voice.presentIdentities()) {
    if (identity.startsWith(`${userId}:`)) voice.kick(identity);
  }
  for (const m of rtc.memberships(room)) {
    if (m.sender === userId) await rtc.clearMembership(client, room.roomId, m);
  }
  app.set({ userMenu: null });
}

voice.kickAllowed = (fromUserId: string) => {
  const roomId = app.get().voiceChannel;
  if (!client || !roomId) return false;
  const home = serverOf(roomId);
  const space = client.getRoom(home?.spaceId ?? roomId);
  const perms = admin.readPerms(client, home?.spaceId ?? roomId);
  const theirs = admin.levelOf(space, fromUserId);
  return theirs >= perms.kick && theirs > admin.levelOf(space, me());
};

voice.onKicked = (fromUserId: string) => {
  const roomId = app.get().voiceChannel;
  const name = app.get().servers.flatMap((g) => g.channels).find((c) => c.roomId === roomId)?.name ?? "";
  void leaveVoice().then(() => app.set({ error: t("voice.kicked", { who: displayName(fromUserId), channel: name }) }));
};

/** Camera and share errors live in the voice state; surface them. */
async function withVoiceError(run: () => Promise<void>): Promise<void> {
  app.set({ error: "" });
  await run();
  const err = voice.getState().error;
  if (err) app.set({ error: err });
}

/** Camera. With several cameras a picker with live previews comes first. */
export async function toggleCamera(): Promise<void> {
  const state = voice.getState();
  if (!state.connected) return;
  if (state.camera) {
    await withVoiceError(() => voice.setCamera(false));
    return;
  }
  await voice.refreshDevices();
  if (voice.getState().devices.cams.length > 1) {
    app.set({ cameraPickerOpen: true });
    return;
  }
  await withVoiceError(() => voice.setCamera(true));
}

export async function pickCamera(deviceId: string): Promise<void> {
  app.set({ cameraPickerOpen: false });
  await withVoiceError(() => voice.setCamera(true, deviceId));
}

/** Share hotkey: stop a running share, otherwise open the picker. */
export async function toggleScreen(): Promise<void> {
  const state = voice.getState();
  if (!state.connected) return;
  if (state.screen) {
    await voice.stopScreen();
    return;
  }
  app.set({ screenPickerOpen: true, screenMenu: null });
}

/** Share button: opens the picker, or while sharing a menu above the button (settings or stop). */
export function screenButton(el: HTMLElement): void {
  const state = voice.getState();
  if (!state.connected) return;
  if (!state.screen) {
    app.set({ screenPickerOpen: true, screenMenu: null });
    return;
  }
  const r = el.getBoundingClientRect();
  const open = app.get().screenMenu;
  app.set({ screenMenu: open ? null : { x: r.left + r.width / 2, y: r.top } });
}

export function openShareSettings(): void {
  app.set({ screenMenu: null, screenPickerOpen: true });
}

export async function stopShare(): Promise<void> {
  app.set({ screenMenu: null, screenPickerOpen: false });
  await voice.stopScreen();
}

/**
 * Start sharing or apply settings to the running share. The same source with
 * new quality changes in place, another source replaces the picture without
 * interrupting viewers. A null source lets the browser ask (development only).
 */
export async function shareSource(sourceId: string | null, opts: ShareOptions, pickNew = false): Promise<void> {
  const state = voice.getState();
  app.set({ screenPickerOpen: false });
  void voice.applySettings({ shareAudio: opts.audio, shareHeight: opts.height, shareFps: opts.fps });
  const share = state.share;
  await withVoiceError(async () => {
    if (!state.screen || !share) await voice.startScreen(sourceId, opts);
    else if (!pickNew && (sourceId ?? "") === share.sourceId) await voice.setShareQuality(opts);
    else await voice.switchScreen(sourceId, opts);
  });
}

/* ------------------------------------------------------------ watching shares */

/** Watch a share: subscribe, open the call and expand its tile. */
export function watchStream(identity: string): void {
  voice.watch(identity);
  showCall();
  app.set({ callFocus: `s:${identity}`, streamMenu: null });
}

export function stopWatching(identity: string): void {
  voice.unwatch(identity);
  app.set({ streamMenu: null });
}

export function openStreamMenu(identity: string, x: number, y: number): void {
  app.set({ streamMenu: { identity, x, y }, screenMenu: null, userMenu: null });
}

export function closeMenus(): void {
  const s = app.get();
  if (s.streamMenu || s.screenMenu) app.set({ streamMenu: null, screenMenu: null });
}

/* ----------------------------------------------------------------- presence */

/** Seconds without input after which the user is away. */
const IDLE_AFTER_S = 5 * 60;
let presenceTimer = 0;

function startPresence(): void {
  window.clearInterval(presenceTimer);
  void applyPresence(true);
  presenceTimer = window.setInterval(() => void applyPresence(false), 20_000);
}

/**
 * Own presence. In automatic mode "away" is set after a while without mouse
 * and keyboard input; in Electron idle time is system-wide, so playing a game
 * with the app in the background does not count as away.
 */
async function applyPresence(force: boolean): Promise<void> {
  const c = client;
  if (!c) return;
  const mode = app.get().statusMode;
  let want: people.Presence;
  if (mode === "offline") want = "offline";
  else if (mode === "unavailable") want = "unavailable";
  else want = (await idleSeconds()) >= IDLE_AFTER_S ? "unavailable" : "online";
  if (!force && want === app.get().myPresence) return;
  app.set({ myPresence: want });
  try {
    // the sync presence too, or the next sync request resets it to online
    await c.setSyncPresence(want as SetPresence);
    await c.setPresence({ presence: want });
  } catch {
    // presence disabled on the server: the status stays local
  }
}

// back at the computer: clear "away" right away instead of waiting for the next check
let lastWake = 0;
if (typeof window !== "undefined") {
  const wake = () => {
    const s = app.get();
    if (s.statusMode !== "auto" || s.myPresence !== "unavailable") return;
    const now = Date.now();
    if (now - lastWake < 3000) return;
    lastWake = now;
    void applyPresence(false);
  };
  for (const ev of ["pointermove", "keydown", "focus"]) window.addEventListener(ev, wake, { passive: true });
}

export function setStatusMode(mode: StatusMode): void {
  try {
    localStorage.setItem("app.status", mode);
  } catch {
    // kept until restart
  }
  app.set({ statusMode: mode });
  void applyPresence(true);
}

/* ----------------------------------------------------------------- profiles */

export type ProfileInfo = {
  userId: string;
  name: string;
  avatar: string;
  server: string;
  power: number;
  role: string;
  /** The role is a server role: viewed from a server channel, not a direct chat. */
  inServer: boolean;
  voiceChannel: string;
  presence: people.Presence;
  own: boolean;
};

/** The server a room belongs to, or the server itself for its space. */
function serverOf(roomId: string | null | undefined): Server | undefined {
  if (!roomId) return undefined;
  return app.get().servers.find((g) => g.spaceId === roomId || g.channels.some((c) => c.roomId === roomId));
}

/**
 * A person's role. On a server it is shared by all channels and read from the
 * space; outside servers (direct chats) the room itself is used.
 */
export function roleOf(userId: string, roomId?: string | null): { level: number; name: string; owner: boolean } {
  const server = serverOf(roomId);
  const room = client?.getRoom(server?.spaceId ?? roomId ?? "") ?? null;
  const level = admin.levelOf(room, userId);
  const owner = !!server && admin.creatorOf(room) === userId && level >= 100;
  return { level, name: admin.roleName(level, owner), owner };
}

export function profileOf(userId: string, roomId?: string | null): ProfileInfo {
  const bits = profileBits(userId, roomId);
  const state = app.get();
  const scope = roomId ?? state.activeChannel;
  const role = roleOf(userId, scope);

  let inVoice = "";
  for (const server of state.servers) {
    for (const channel of server.channels) {
      if (channel.kind !== "voice") continue;
      if (state.occupants[channel.roomId]?.includes(userId)) inVoice = channel.name;
    }
  }

  return {
    userId,
    name: bits.name,
    avatar: bits.avatar,
    server: userId.split(":").slice(1).join(":"),
    power: role.level,
    role: role.name,
    inServer: !!serverOf(scope),
    voiceChannel: inVoice,
    presence: userId === client?.getUserId() ? state.myPresence : client ? people.presenceOf(client, userId) : "offline",
    own: userId === client?.getUserId(),
  };
}

export function openProfile(userId: string): void {
  app.set({ profileUser: userId, userMenu: null });
}

export function openUserMenu(userId: string, x: number, y: number, roomId: string | null = null): void {
  app.set({ userMenu: { userId, roomId, x, y } });
}

export function closeUserMenu(): void {
  if (app.get().userMenu) app.set({ userMenu: null });
}

export function copyText(text: string): Promise<boolean> {
  return copyToClipboard(text);
}

/* --------------------------------------------------- own profile and sessions */

export async function saveMyName(name: string): Promise<void> {
  if (!client || !name.trim()) return;
  app.set({ busy: t("busy.name"), error: "" });
  try {
    await people.setName(client, name);
    profileCache.clear();
    refreshMe();
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

export async function saveMyAvatar(file: File | null): Promise<void> {
  if (!client) return;
  app.set({ busy: t("busy.avatar"), error: "" });
  try {
    if (file) await people.setAvatar(client, file);
    else await people.clearAvatar(client);
    profileCache.clear();
    refreshMe();
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

export function sessions(): Promise<people.SessionRow[]> {
  return client ? people.listSessions(client) : Promise.resolve([]);
}

/** End a session. Throws people.NeedPassword if the server asks for the password. */
export function endSession(deviceId: string, password: string): Promise<void> {
  return client ? people.removeSession(client, deviceId, password) : Promise.resolve();
}

export const NeedPassword = people.NeedPassword;

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (!client) return;
  await people.changePassword(client, oldPassword, newPassword);
}

export function renameSession(deviceId: string, name: string): Promise<void> {
  return client ? people.renameSession(client, deviceId, name) : Promise.resolve();
}

/* --------------------------------------------------------------- encryption */

export function encryptionStatus(): Promise<crypto.CryptoStatus> {
  return client
    ? crypto.cryptoStatus(client)
    : Promise.resolve({ enabled: false, verified: false, secretStorage: false, backup: false });
}

/** Verify this sign-in with the recovery key. Returns the number of restored message keys. */
export async function verifyWithRecoveryKey(key: string): Promise<number> {
  if (!client) return 0;
  const restored = await crypto.unlockWithRecoveryKey(client, key);
  scheduleMessages();
  return restored;
}

/** Ask another own device (Element) to verify this sign-in. */
export async function startVerification(): Promise<void> {
  if (!client) return;
  try {
    await crypto.startSelfVerification(client, (v) => app.set({ sas: v }));
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

export function humanError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (text.includes("M_FORBIDDEN")) return t("err.forbidden");
  if (text.includes("M_UNKNOWN_TOKEN")) return t("err.token");
  if (text.includes("Failed to fetch")) return t("err.network");
  return text;
}

/* ------------------------------------------------------------ older history */

let loading = false;

export async function loadMore(): Promise<boolean> {
  const roomId = app.get().activeChannel;
  if (!client || !roomId || loading) return false;
  const room = client.getRoom(roomId);
  if (!room) return false;

  loading = true;
  try {
    const before = room.getLiveTimeline().getEvents().length;
    await client.scrollback(room, 40);
    refreshMessages();
    return room.getLiveTimeline().getEvents().length > before;
  } catch {
    return false;
  } finally {
    loading = false;
  }
}

/* ------------------------------------------------------------ notifications */

export function askNotifyPermission(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

/** Whether a message names this user: by the server's push rules, the id or the display name. */
function mentionsMe(event: MatrixEvent, body: string): boolean {
  const c = client;
  if (!c) return false;
  if (c.getPushActionsForEvent(event)?.tweaks?.highlight) return true;
  const self = c.getUserId() ?? "";
  const myName = app.get().myName.trim().toLowerCase();
  return body.includes(self) || (myName.length > 1 && body.toLowerCase().includes(myName));
}

/**
 * A new message elsewhere: a sound, and a system notification while the
 * window is not in front. Muted chats, servers and people stay silent unless
 * the message mentions the user.
 */
// a message may be seen twice: announced, then decrypted
const notified = new Set<string>();

function notify(event: MatrixEvent, room: Room): void {
  if (event.getType() !== "m.room.message") return;
  const id = event.getId() ?? "";
  if (notified.has(id)) return;
  notified.add(id);
  if (notified.size > 500) notified.clear();
  const sender = event.getSender() ?? "";
  if (sender === client?.getUserId()) return;
  if (event.getTs() < Date.now() - 30_000) return;
  const focused = !document.hidden && document.hasFocus();
  if (focused && room.roomId === app.get().activeChannel) return;
  const mode = getNotifyMode();
  if (mode === "off") return;

  const body = msg.stripReplyFallback(String(event.getContent().body ?? ""));
  const direct = app.get().directs.some((d) => d.roomId === room.roomId);
  const mention = mentionsMe(event, body);
  if (isMuted("users", sender)) return;
  if (!mention && roomMuted(room.roomId)) return;
  if (mode === "mentions" && !direct && !mention) return;

  const sounds = getSoundPrefs();
  if (sounds.notifyOn) blip(direct || mention ? "mention" : "message", voice.getState().settings.spkId);

  // a direct message or a mention also flashes the taskbar button
  if (direct || mention) flashWindow();
  if (focused) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const who = displayName(sender, room.roomId);
  const home = serverOf(room.roomId);
  try {
    const n = new Notification(direct ? who : t("notify.inRoom", { who, room: home ? `${room.name} · ${home.name}` : room.name }), {
      body: body.slice(0, 160),
      tag: room.roomId,
      icon: "./icon.png",
      // the sound above is the only one; the system one would double it
      silent: true,
    });
    n.onclick = () => {
      showWindow();
      jumpToRoom(room.roomId);
      n.close();
    };
  } catch {
    // notifications blocked by the system
  }
}

/** Open a chat wherever it is: in direct messages or on one of the servers. */
export function jumpToRoom(roomId: string): void {
  const s = app.get();
  if (s.directs.some((d) => d.roomId === roomId)) {
    app.set({ view: "direct" });
  } else {
    const home = s.servers.find((g) => g.channels.some((c) => c.roomId === roomId));
    if (home) app.set({ view: "server", activeServer: home.spaceId });
  }
  void openChat(roomId);
}

/** Channel members for the right column, highest role first. */
export function channelMembers(roomId: string | null): Member[] {
  if (!client || !roomId) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const c = client;
  const self = c.getUserId();
  // role badges come from the server, so an admin stays an admin in every channel
  const space = client.getRoom(serverOf(roomId)?.spaceId ?? "");
  return room
    .getJoinedMembers()
    .map((m) => ({
      userId: m.userId,
      name: m.name || m.userId,
      avatar: m.getMxcAvatarUrl() || "",
      power: space ? admin.levelOf(space, m.userId) : (m.powerLevel ?? 0),
      owner: !!space && admin.creatorOf(space) === m.userId,
      presence: m.userId === self ? app.get().myPresence : people.presenceOf(c, m.userId),
    }))
    .sort((a, b) => b.power - a.power || compareText(a.name, b.name))
    .slice(0, 200);
}

/** A person's status for the dot on the avatar. */
export function presenceOf(userId: string): people.Presence {
  if (!client) return "offline";
  if (userId === client.getUserId()) return app.get().myPresence;
  return people.presenceOf(client, userId);
}

/**
 * Some homeservers disable presence: everyone shows as offline, and splitting
 * the member list into online and offline makes no sense.
 */
export function presenceWorks(members: Member[]): boolean {
  const self = client?.getUserId();
  return members.some((m) => m.userId !== self && m.presence !== "offline");
}
