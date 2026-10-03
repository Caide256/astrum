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
import type { GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api/index.js";

import { groupMentions, parse, type MentionResolver } from "./markdown.ts";
import { createStore } from "./store.ts";
import * as session from "./matrix/session.ts";
import {
  browseChannels,
  createChannel,
  createServer,
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
import { joinServer, lookupServer, suggestAddress, type ServerCard } from "./matrix/discovery.ts";
import * as rtc from "./matrix/rtc.ts";
import * as admin from "./matrix/admin.ts";
import * as crypto from "./matrix/crypto.ts";
import * as msg from "./matrix/messages.ts";
import * as people from "./matrix/people.ts";
import { configureMedia, encryptAttachment, mediaUrl, type EncryptedFile } from "./media.ts";
import { BRAND } from "./brand.ts";
import { isMxc } from "./mxc.ts";
import { copyImageToClipboard, copyToClipboard, fetchLinkPreview, flashWindow, idleSeconds, onBeforeQuit, showWindow, type RawPreview } from "./desktop.ts";
import { startHotkeys } from "./hotkeys.ts";
import { compareText, t } from "./i18n/index.ts";
import {
  getNotifyMode,
  getNotifyPrefs,
  getServerProfiles,
  getSoundPrefs,
  getTileLook,
  getViewPrefs,
  isMuted,
  onServerProfilesChange,
  onTileLookChange,
  setPrivacy,
  setServerProfilePref,
  startPrefsSync,
  stopPrefsSync,
} from "./prefs.ts";
import { stopSunshineStream } from "./sunshine.ts";
import { setTrayUnread } from "./tray.ts";
import { setBeforeInstall } from "./update.ts";
import { blip, playBoardSound, soundLength } from "./voice/audio.ts";
import { cleanEmoji, cleanTile, voice, type ShareOptions, type TileLook } from "./voice/voice.ts";

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
  /** A still picture of a video, if the sender made one. */
  thumb: { mxc: string; file: EncryptedFile | null; mime: string } | null;
  /** Length of a video or a sound in milliseconds, 0 if unknown. */
  duration: number;
};

/** A file being uploaded. */
export type Upload = { id: string; name: string; progress: number };

/** "streamer": do not disturb for others, and ids, domains and addresses hidden here. */
export type StatusMode = "auto" | "unavailable" | "dnd" | "streamer" | "offline";

/** `quote`: the reply quotes a piece of the message, and `body` is that piece. */
export type ReplyPreview = { eventId: string; sender: string; senderName: string; body: string; quote?: boolean };

/** A link preview inside a message (MSC4095 fields, the picture already on the homeserver). */
export type LinkPreview = {
  url: string;
  title: string;
  description: string;
  site: string;
  image: { mxc: string; file: EncryptedFile | null; w: number; h: number; mime: string } | null;
  /** YouTube video id: the card plays the video in place. */
  youtube: string;
};

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
  /** The sender deleted the account. */
  deleted: boolean;
  /** The message pings this user: by name, by a reply, or @room. */
  mentionsMe: boolean;
  previews: LinkPreview[];
  pinned: boolean;
  /** This user may pin and unpin messages here. */
  canPin: boolean;
  /** Color of the sender's role on this server, empty for none. */
  color: string;
};

export type Member = {
  userId: string;
  name: string;
  avatar: string;
  power: number;
  /** Server owner. */
  owner: boolean;
  presence: people.Presence;
  /** Role name for the badge (empty for plain members) and its color. */
  role: string;
  color: string;
};

/** `voice`: opened on a person in the call, so call volume and removal from the call apply. */
export type UserMenu = { userId: string; roomId: string | null; x: number; y: number; voice: boolean };

export type Lightbox = { url: string; name: string };

/** Right click on a picture: open, save, copy. `inViewer`: opened in the full-screen viewer itself. */
export type ImageMenu = { url: string; name: string; x: number; y: number; inViewer: boolean };

export type SettingsTab = "profile" | "audio" | "keys" | "appearance" | "app" | "moonlight" | "crypto" | "sessions";

export type ServerTab = "overview" | "me" | "channels" | "members" | "roles" | "sounds" | "bans" | "perms";

export type AppState = {
  phase: "login" | "loading" | "ready";
  error: string;
  busy: string;
  /** A short confirmation at the bottom, gone by itself: "copied" and the like. */
  notice: string;
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
  /** The profile card was opened from the call: its volume slider applies. */
  profileVoice: boolean;
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
  imageMenu: ImageMenu | null;
  replyTo: ReplyPreview | null;
  /** A message being edited; `media`: an attachment, only its caption changes. */
  editing: { eventId: string; body: string; media: boolean } | null;
  myName: string;
  myAvatar: string;
  tick: number;
  serverSettingsOpen: boolean;
  serverTab: ServerTab;
  channelEdit: string | null;
  searchOpen: boolean;
  searchHits: msg.Hit[];
  searching: boolean;
  /** What was searched: the words are marked in the results. */
  searchTerm: string;
  typing: string[];
  highlight: string | null;
  /** The member list on the right is collapsed. */
  membersHidden: boolean;
  /** In direct chats the member list is hidden unless asked for: two people need no list. */
  directMembers: boolean;
  /** The chat panel next to the call. */
  callChat: boolean;
  /** The tile last expanded in the call; the mini player shows it outside the call. */
  lastFocus: string | null;
  /** Context menu of a channel or a server icon. */
  placeMenu: { kind: "room" | "server"; id: string; x: number; y: number } | null;
  /** The server whose leave confirmation is open. */
  leaveServerAsk: string | null;
  /** The pinned messages panel is open. */
  pinsOpen: boolean;
  /** Pinned message ids of the open chat, newest pin last. */
  pins: string[];
  /** The first message the user has not read yet when the chat was opened: the "new" line goes above it. */
  unreadFrom: string | null;
  /**
   * Older history of the open chat: "more" can still be loaded, "start" is
   * the very beginning, "hidden" means the channel hides what was written
   * before the user joined.
   */
  history: "more" | "start" | "hidden";
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
    return v === "unavailable" || v === "offline" || v === "dnd" || v === "streamer" ? v : "auto";
  } catch {
    return "auto";
  }
}

export const app = createStore<AppState>({
  phase: "login",
  error: "",
  busy: "",
  notice: "",
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
  profileVoice: false,
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
  imageMenu: null,
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
  searchTerm: "",
  typing: [],
  highlight: null,
  membersHidden: loadFlag("app.members-hidden"),
  directMembers: loadFlag("app.direct-members"),
  callChat: loadFlag("app.call-chat"),
  lastFocus: null,
  placeMenu: null,
  leaveServerAsk: null,
  pinsOpen: false,
  pins: [],
  unreadFrom: null,
  history: "more",
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

/** The member list button: in a direct chat it has its own switch, off by default. */
export function toggleMembers(direct = false): void {
  if (direct) {
    const shown = !app.get().directMembers;
    saveFlag("app.direct-members", shown);
    app.set({ directMembers: shown });
    return;
  }
  const hidden = !app.get().membersHidden;
  saveFlag("app.members-hidden", hidden);
  app.set({ membersHidden: hidden });
}

/** Whether the member list shows next to this chat. */
export function membersShown(roomId: string | null): boolean {
  const s = app.get();
  const direct = !!roomId && s.directs.some((d) => d.roomId === roomId);
  return direct ? s.directMembers : !s.membersHidden;
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
    name = name || people.plainName(member);
    avatar = avatar || member.getMxcAvatarUrl() || "";
    if (name && avatar) return { name, avatar };
  }
  for (const room of client?.getRooms() ?? []) {
    const member = room.getMember(userId);
    if (!member) continue;
    name = name || people.plainName(member);
    avatar = avatar || member.getMxcAvatarUrl() || "";
    if (name && avatar) break;
  }

  const user = client?.getUser(userId);
  return {
    name: name || user?.displayName || people.localName(userId),
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
  people.onDeletedChange(() => {
    profileCache.clear();
    scheduleMessages();
    refreshDirects();
    bump();
  });
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

/**
 * The own name and picture as the server has them. The client learns about
 * profile changes from room events, so an account that is in no room yet (a
 * fresh sign-up) kept showing the old picture after setting a new one.
 */
async function fetchMe(): Promise<void> {
  const c = client;
  if (!c) return;
  const id = c.getUserId() ?? "";
  try {
    const p = await c.getProfileInfo(id);
    if (client !== c) return;
    const user = c.getUser(id);
    if (user) {
      if (p.displayname) user.setDisplayName(p.displayname);
      user.setAvatarUrl(p.avatar_url || undefined);
    }
    profileCache.clear();
    app.set({ myName: p.displayname || app.get().myName, myAvatar: p.avatar_url ?? "" });
    bump();
  } catch {
    // the server did not answer: what the client knows stays
  }
}

/** Everything after the client exists: sync, lists, the last opened channel. */
async function launch(s: session.Session, c: MatrixClient): Promise<void> {
  afterConnect(s, c);
  wire(c);
  restoreView();
  await session.start(c);
  // a fresh account gets its encryption keys here, no other client needed
  void crypto.setupFreshAccount(c).catch((e) => console.warn("encryption setup skipped", e));
  // invites the server failed to decline last time
  void people
    .retryHiddenInvites(c)
    .then(() => refreshDirects())
    .catch(() => undefined);
  startPrefsSync(c);
  refreshRooms();
  refreshMe();
  void fetchMe();
  app.set({ phase: "ready" });
  restoreChannel();
  startPresence();
  scheduleOwnMembers(8000);
}

export async function bootstrap(): Promise<void> {
  const saved = await session.loadSession();
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
  await session.saveSession(s);
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
export async function doRegister(
  server: string,
  username: string,
  password: string,
  shownName: string,
  invite: string,
): Promise<void> {
  app.set({ busy: t("busy.registering"), error: "" });
  let s: session.Session;
  try {
    s = await session.register(server, username, password, invite);
  } catch (e) {
    app.set({ busy: "", phase: "login", error: humanError(e) });
    return;
  }
  if ((await enter(s)) && shownName.trim() && client) {
    await people.setName(client, shownName).catch(() => undefined);
    refreshMe();
    await fetchMe();
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
      if (!chatAtBottom && !app.get().unreadFrom && event.getType() === "m.room.message" && event.getSender() !== c.getUserId()) {
        app.set({ unreadFrom: event.getId() ?? null });
      }
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
    } else if (type === msg.PINNED) {
      scheduleMessages();
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
  c.on(RoomEvent.MyMembership, (room, membership, prev) => onMyMembership(room, membership, prev));
  c.on(ClientEvent.AccountData, (ev) => {
    if (ev.getType() === "m.direct" || people.isHiddenInvitesEvent(ev.getType())) refreshDirects();
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
  const lost = !!activeServer && !servers.some((g) => g.spaceId === activeServer);
  if (lost) activeServer = null;
  if (!activeServer && servers.length) activeServer = servers[0].spaceId;

  app.set({ servers, loose, activeServer });
  // the server is gone (left, kicked, banned): nothing of it may stay on screen
  if (lost && state.view === "server") {
    app.set({ activeChannel: null, messages: [], callView: false, serverSettingsOpen: false });
    if (!activeServer) app.set({ view: "direct" });
    restoreChannel();
  }
  // a call in a room we are no longer in ends here, whoever took us out
  const vc = state.voiceChannel;
  if (vc && client.getRoom(vc) && client.getRoom(vc)?.getMyMembership() !== "join") void leaveVoice();
  refreshDirects();
  refreshOccupants();
}

export function refreshDirects(): void {
  if (!client) return;
  const directs = people.listDirects(client);
  // channel invites of own servers are joined by themselves, not listed
  const invites = people.listInvites(client).filter((inv) => inv.space || !parentSpace(inv.roomId) || !joinChannelInvite(inv.roomId));
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
  const voiceChats = getNotifyPrefs().voiceChats;
  let n =
    s.directs.filter((d) => !isMuted("users", d.userId) && !readingNow(d.roomId)).reduce((sum, d) => sum + d.unread, 0) +
    s.invites.length;
  for (const g of s.servers) {
    for (const ch of g.channels) {
      if (readingNow(ch.roomId)) continue;
      if (ch.mentions > 0) n += ch.mentions;
      // voice channels have chats too; their plain messages count only when asked for
      else if (mode === "all" && !roomMuted(ch.roomId) && (ch.kind !== "voice" || voiceChats)) n += ch.unread;
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
    if (!people.isDeadInvite(e)) {
      app.set({ busy: "", error: humanError(e) });
      return;
    }
    // everybody left that chat: it can never be joined, so the invite goes away by itself
    app.set({ busy: "", error: t("invite.err.dead") });
    await declineInvite(invite, true);
  }
}

/**
 * Remove a direct chat from the list: leave it, forget it, drop it from
 * m.direct. The other person keeps the history; writing again starts a new chat.
 */
export async function deleteDirect(roomId: string): Promise<void> {
  if (!client) return;
  if (app.get().voiceChannel === roomId) await leaveVoice();
  try {
    await people.deleteDirect(client, roomId);
  } catch (e) {
    app.set({ error: humanError(e) });
    return;
  }
  if (app.get().activeChannel === roomId) app.set({ activeChannel: null, messages: [] });
  refreshDirects();
}

/** `quiet`: the reason was already shown, a failed decline only hides the invite. */
export async function declineInvite(invite: people.Invite, quiet = false): Promise<void> {
  if (!client) return;
  try {
    await people.declineInvite(client, invite.roomId);
  } catch (e) {
    // the server could not decline it: hide it and try again on a later start
    const error = humanError(e);
    await people.hideInvite(client, invite).catch(() => undefined);
    if (!quiet) app.set({ error: t("invite.err.stuck", { error }) });
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

function replyPreview(room: Room, eventId: string, quoted?: unknown): ReplyPreview | null {
  if (!eventId) return null;
  const target = room.findEventById(eventId);
  // a quoted piece is known from the reply itself, even if the message is not loaded
  if (typeof quoted === "string" && quoted.trim()) {
    const sender = target?.getSender() ?? "";
    return {
      eventId,
      sender,
      senderName: sender ? (people.isDeleted(sender) ? t("people.deleted") : displayName(sender, room.roomId)) : "",
      body: quoted.slice(0, 500),
      quote: true,
    };
  }
  if (!target) {
    return { eventId, sender: "", senderName: "", body: t("chat.replyNotLoaded") };
  }
  const { content } = msg.currentContent(target);
  const sender = target.getSender() ?? "";
  return {
    eventId,
    sender,
    senderName: people.isDeleted(sender) ? t("people.deleted") : displayName(sender, room.roomId),
    body: msg.stripReplyFallback(String(content.body ?? "")).slice(0, 180),
  };
}

let messagesTimer = 0;

/**
 * The messages of the last refresh by id, with a fingerprint of their content.
 * A message that did not change keeps its object, so its row is not drawn
 * again: a new message or a reaction redraws one row, not the whole chat.
 */
let messageMemo = new Map<string, { print: string; msg: Message }>();

function reuse(next: Map<string, { print: string; msg: Message }>, m: Message): Message {
  const print = JSON.stringify(m);
  const old = messageMemo.get(m.id);
  const kept = old && old.print === print ? old.msg : m;
  next.set(m.id, { print, msg: kept });
  return kept;
}

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
    app.set({ messages: [], history: "more" });
    return;
  }
  const room = client.getRoom(roomId);
  if (!room) {
    app.set({ messages: [], history: "more" });
    return;
  }
  const self = client.getUserId() ?? "";
  const messages: Message[] = [];
  const checks = msg.collectChecks(room);
  const events = room.getLiveTimeline().getEvents();
  const resolve = mentionResolver(roomId);
  const pins = msg.pinnedIds(room);
  const pinSet = new Set(pins);
  // names take the color of their role on the server, as in Discord
  const home = serverOf(roomId);
  const space = home ? client.getRoom(home.spaceId) : null;
  const roles = home ? admin.serverRoles(client, home.spaceId) : [];
  const colorOf = (userId: string) => (space ? (admin.roleAt(roles, admin.levelOf(space, userId))?.color ?? "") : "");
  const canPin = msg.canPin(room, self);
  const memo = new Map<string, { print: string; msg: Message }>();

  for (const ev of events) {
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
    // people who left may have deleted the account: checked in the background
    if (!member || member.membership === "leave") people.checkDeleted(client, sender);
    const gone = people.isDeleted(sender);

    const next: Message = {
      id: ev.getId() ?? String(ev.getTs()),
      sender,
      senderName: gone ? t("people.deleted") : displayName(sender, roomId),
      avatar: gone ? "" : member?.getMxcAvatarUrl() || "",
      body: locked
        ? t("chat.locked")
        : media
          ? media.caption || media.name
          : msg.mentionsFromHtml(msg.stripReplyFallback(String(content.body ?? "")), content, resolve),
      ts: ev.getTs(),
      own: sender === self,
      media,
      edited,
      reply: replyPreview(room, msg.replyTargetId(ev.getContent()), ev.getContent()[msg.QUOTE_KEY]),
      reactions: msg.reactionsFor(room, ev.getId() ?? "", self),
      canEdit: !locked && !ev.status && msg.isEditable(ev, self),
      canDelete: !ev.status && msg.mayRedact(room, ev, self),
      state: ev.status === "not_sent" ? "failed" : ev.status && ev.status !== "sent" ? "sending" : "sent",
      failReason: ev.status === "not_sent" ? String(ev.error?.message ?? "") : "",
      locked,
      checks: checks.get(ev.getId() ?? "") ?? {},
      deleted: gone,
      mentionsMe: sender !== self && !locked && pingsMe(ev, content, self),
      previews: locked ? [] : previewsOf(content),
      pinned: pinSet.has(ev.getId() ?? ""),
      canPin,
      color: colorOf(sender),
    };
    messages.push(next);
  }

  const shown = messages.slice(-400).map((m) => reuse(memo, m));
  messageMemo = memo;
  app.set({ messages: shown, history: historyOf(room, events), pins });
}

/* ------------------------------------------------------------ link previews */

/**
 * Link previews travel inside the message (MSC4095, as Beeper does): the
 * sender's app fetches the page once and uploads the picture, so readers
 * never contact the linked site and all see the same card. The sender can
 * remove a card later, which is an edit of the message.
 */
const PREVIEWS = "com.beeper.linkpreviews";
const EMBED = `${BRAND.appId}.embed`;
const MAX_PREVIEWS = 3;
const PREVIEW_WAIT_MS = 4000;

/** Links of a text that get a card: bare links outside code; <link> in angle brackets opts out, as in Discord. */
export function previewUrls(text: string): string[] {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<https?:\/\/[^\s>]+>/gi, " ");
  const out: string[] = [];
  for (const m of plain.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = m[0].replace(/[.,:;!?)\]}'"»]+$/, "");
    if (url.length > 10 && !out.includes(url)) out.push(url);
    if (out.length >= MAX_PREVIEWS) break;
  }
  return out;
}

const rawPreviews = new Map<string, Promise<RawPreview | null>>();
const uploadedPreviews = new Map<string, Promise<Record<string, unknown> | null>>();

function rawPreview(url: string): Promise<RawPreview | null> {
  let p = rawPreviews.get(url);
  if (!p) {
    p = fetchLinkPreview(url);
    rawPreviews.set(url, p);
    if (rawPreviews.size > 200) rawPreviews.delete(rawPreviews.keys().next().value as string);
  }
  return p;
}

/** Start fetching the previews of a text being typed, so sending does not wait for them. */
export function prefetchPreviews(text: string): void {
  for (const url of previewUrls(text)) void rawPreview(url);
}

/** One preview as message content, the picture uploaded (encrypted in encrypted rooms). */
function previewEntry(url: string, encrypted: boolean): Promise<Record<string, unknown> | null> {
  const key = `${encrypted ? "e" : "p"}|${url}`;
  let p = uploadedPreviews.get(key);
  if (p) return p;
  p = (async () => {
    const c = client;
    const raw = await rawPreview(url);
    if (!c || !raw) return null;
    const entry: Record<string, unknown> = { matched_url: url, "og:url": raw.url };
    if (raw.title) entry["og:title"] = raw.title;
    if (raw.description) entry["og:description"] = raw.description;
    if (raw.site) entry["og:site_name"] = raw.site;
    if (raw.youtube) entry[EMBED] = `youtube:${raw.youtube}`;
    if (raw.image) {
      try {
        const blob = new Blob([raw.image.data as Uint8Array<ArrayBuffer>], { type: raw.image.mime });
        const dims = await imageSize(new File([blob], "preview", { type: raw.image.mime }));
        if (encrypted) {
          const { data, file } = await encryptAttachment(await blob.arrayBuffer());
          const up = await c.uploadContent(new Blob([data]), { type: "application/octet-stream", includeFilename: false });
          entry["beeper:image:encryption"] = { ...file, url: up.content_uri };
        } else {
          const up = await c.uploadContent(blob, { type: raw.image.mime, includeFilename: false });
          entry["og:image"] = up.content_uri;
        }
        entry["matrix:image:size"] = raw.image.data.byteLength;
        entry["og:image:type"] = raw.image.mime;
        if (dims) {
          entry["og:image:width"] = dims.w;
          entry["og:image:height"] = dims.h;
        }
      } catch {
        // the card goes without the picture
      }
    }
    return entry;
  })();
  uploadedPreviews.set(key, p);
  return p;
}

/** Previews for these links, or none if they take too long: the message is not held up for them. */
async function buildPreviews(roomId: string, urls: string[]): Promise<Record<string, unknown>[]> {
  if (!urls.length || !client) return [];
  const encrypted = !!client.getRoom(roomId)?.hasEncryptionStateEvent();
  const all = Promise.all(urls.map((u) => previewEntry(u, encrypted).catch(() => null)));
  const done = await Promise.race([all, new Promise<null>((r) => window.setTimeout(() => r(null), PREVIEW_WAIT_MS))]);
  return (done ?? []).filter((e): e is Record<string, unknown> => !!e);
}

function previewsOf(content: Record<string, any>): LinkPreview[] {
  const list = content[PREVIEWS];
  if (!Array.isArray(list)) return [];
  const out: LinkPreview[] = [];
  for (const p of list.slice(0, MAX_PREVIEWS)) {
    if (!p || typeof p !== "object") continue;
    const url = String(p.matched_url ?? p["og:url"] ?? "");
    if (!/^https?:\/\//i.test(url)) continue;
    const enc = p["beeper:image:encryption"];
    const file = enc && typeof enc.url === "string" ? (enc as EncryptedFile) : null;
    const mxc = String(file?.url ?? p["og:image"] ?? "");
    const embed = String(p[EMBED] ?? "");
    out.push({
      url,
      title: String(p["og:title"] ?? ""),
      description: String(p["og:description"] ?? ""),
      site: String(p["og:site_name"] ?? ""),
      image: isMxc(mxc)
        ? {
            mxc,
            file,
            w: Number(p["og:image:width"] ?? 0),
            h: Number(p["og:image:height"] ?? 0),
            mime: String(p["og:image:type"] ?? "image/jpeg"),
          }
        : null,
      youtube: /^youtube:[\w-]{6,20}$/.test(embed) ? embed.slice(8) : "",
    });
  }
  return out;
}

/** Remove one card from an own message: an edit with the same text and the card gone. */
export async function removePreview(eventId: string, url: string): Promise<void> {
  const roomId = app.get().activeChannel;
  const ev = roomId ? client?.getRoom(roomId)?.findEventById(eventId) : null;
  if (!client || !roomId || !ev) return;
  const { content } = msg.currentContent(ev);
  const list = Array.isArray(content[PREVIEWS]) ? (content[PREVIEWS] as Record<string, any>[]) : [];
  const keep = list.filter((p) => String(p?.matched_url ?? p?.["og:url"] ?? "") !== url);
  const body = msg.stripReplyFallback(String(content.body ?? ""));
  try {
    await msg.editText(client, roomId, eventId, body, mentionResolver(roomId), { [PREVIEWS]: keep });
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

/** The server's push rules decide what pings; m.mentions is checked too for clients that lag behind. */
function pingsMe(ev: MatrixEvent, content: Record<string, any>, self: string): boolean {
  const ids = content["m.mentions"]?.user_ids;
  if (Array.isArray(ids) && ids.includes(self)) return true;
  return !!client?.getPushActionsForEvent(ev)?.tweaks?.highlight;
}

function historyOf(room: Room, events: MatrixEvent[]): AppState["history"] {
  const sawCreate = events[0]?.getType() === "m.room.create";
  if (!sawCreate && room.oldState.paginationToken !== null) return "more";
  const visibility = room.currentState.getStateEvents("m.room.history_visibility", "")?.getContent()?.history_visibility;
  return !sawCreate && (visibility === "joined" || visibility === "invited") ? "hidden" : "start";
}

/**
 * An attachment from message content. In encrypted rooms the link is in
 * `file` together with the key. Captions follow MSC2530: if `filename` is set
 * and differs from `body`, the body is the caption.
 */
function mediaOf(content: Record<string, any>): Media | null {
  const file = content.file && typeof content.file.url === "string" ? (content.file as EncryptedFile) : null;
  const mxc = String(file?.url ?? content.url ?? "");
  if (!isMxc(mxc)) return null;
  const msgtype = String(content.msgtype ?? "");
  const info = (content.info ?? {}) as Record<string, any>;
  const body = String(content.body ?? "");
  const filename = typeof content.filename === "string" ? content.filename : "";
  const thumbFile = info.thumbnail_file && typeof info.thumbnail_file.url === "string" ? (info.thumbnail_file as EncryptedFile) : null;
  const thumbMxc = String(thumbFile?.url ?? info.thumbnail_url ?? "");
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
    thumb: isMxc(thumbMxc) ? { mxc: thumbMxc, file: thumbFile, mime: String(info.thumbnail_info?.mimetype ?? "image/jpeg") } : null,
    duration: Math.max(0, Number(info.duration ?? 0) || 0),
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

/** The first message from someone else after the own read receipt, or null when all is read. */
function firstUnread(roomId: string): string | null {
  const room = client?.getRoom(roomId);
  const self = client?.getUserId() ?? "";
  if (!room) return null;
  const upTo = room.getEventReadUpTo(self);
  if (!upTo) return null;
  const events = room.getLiveTimeline().getEvents();
  const at = events.findIndex((e) => e.getId() === upTo);
  if (at === -1) return null;
  for (const e of events.slice(at + 1)) {
    if (e.getType() === "m.room.message" && e.getSender() !== self) return e.getId() ?? null;
  }
  return null;
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
  chatAtBottom = true;
  app.set({ unreadFrom: client ? firstUnread(roomId) : null, pinsOpen: false });
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
  // an edit may clear the text: a caption goes, an empty message is deleted
  if (!client || !roomId || (!text.trim() && !state.editing)) return;
  typingNow(false);

  if (state.editing) {
    await saveEdit(text, state.editing.media, []);
    return;
  }

  const reply = state.replyTo;
  app.set({ replyTo: null });
  const previews = await buildPreviews(roomId, previewUrls(text));
  await msg.sendText(
    client,
    roomId,
    text,
    reply ? { eventId: reply.eventId, sender: reply.sender, senderName: reply.senderName, body: reply.body, quote: reply.quote } : null,
    mentionResolver(roomId),
    previews.length ? { [PREVIEWS]: previews } : {},
    groupPing(roomId, text),
  );
}

/** May this user ping the whole room? The room's power levels decide (notifications.room). */
export function canPingEveryone(roomId: string | null): boolean {
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !room) return false;
  try {
    return room.currentState.mayTriggerNotifOfType("room", client.getUserId() ?? "");
  } catch {
    return false;
  }
}

/**
 * "@everyone" and "@room" ping the whole room through m.mentions.room, which
 * every Matrix client understands. Matrix has no "@here": the people online
 * right now are listed as mentioned one by one. Both need the right to ping
 * the room; without it the words stay plain text.
 */
function groupPing(roomId: string, text: string): msg.GroupPing | undefined {
  const found = groupMentions(parse(text));
  if (!found.size || !canPingEveryone(roomId)) return undefined;
  if (found.has("@everyone") || found.has("@room")) return { room: true, users: [] };
  const c = client;
  const room = c?.getRoom(roomId);
  if (!c || !room) return undefined;
  const self = c.getUserId();
  const users = room
    .getJoinedMembers()
    .filter((m) => m.userId !== self && people.presenceOf(c, m.userId) !== "offline")
    .map((m) => m.userId)
    .slice(0, 100);
  return { room: false, users };
}

/** A text edit: the link cards follow the links that are still in the text. */
async function editTextMessage(roomId: string, target: string, current: Record<string, any> | null, text: string): Promise<void> {
  const c = client;
  if (!c || !text.trim()) return;
  const before = current && !msg.isMediaContent(current) ? previewUrls(msg.stripReplyFallback(String(current.body ?? ""))) : [];
  const now = previewUrls(text);
  const old = Array.isArray(current?.[PREVIEWS]) ? (current?.[PREVIEWS] as Record<string, any>[]) : [];
  const kept = old.filter((p) => now.includes(String(p?.matched_url ?? "")));
  const added = await buildPreviews(roomId, now.filter((u) => !before.includes(u)));
  await msg.editText(c, roomId, target, text, mentionResolver(roomId), { [PREVIEWS]: [...kept, ...added] });
}

/**
 * Save an edit. The attachment of the message may be removed and new files
 * added. A Matrix message holds one file: the first new file takes the place
 * of a removed one (or turns a text message into a file with that text as its
 * caption), the rest follow as messages of their own. A message left with no
 * text and no file is deleted.
 */
export async function saveEdit(text: string, keepMedia: boolean, files: File[]): Promise<void> {
  const state = app.get();
  const roomId = state.activeChannel;
  const editing = state.editing;
  const c = client;
  if (!c || !roomId || !editing) return;
  app.set({ editing: null });
  typingNow(false);
  const target = editing.eventId;
  const ev = c.getRoom(roomId)?.findEventById(target);
  const current = ev ? msg.currentContent(ev).content : null;
  const hadMedia = !!current && msg.isMediaContent(current);
  try {
    if (hadMedia && keepMedia && current) {
      await msg.editCaption(c, roomId, target, current, text);
    } else if (files.length) {
      const content = await buildAttachment(roomId, files[0], text.trim());
      if (content) await msg.editToContent(c, roomId, target, content);
      files = files.slice(1);
    } else if (text.trim()) {
      await editTextMessage(roomId, target, current, text);
    } else {
      // nothing left of the message
      await msg.remove(c, roomId, target);
    }
    for (const f of files) await sendAttachment(roomId, f, "", null);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
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

/**
 * Length, size and a still picture of a video (length only for a sound), as
 * Element sends them: the player can show the picture and the length before
 * anything is downloaded.
 */
async function mediaMeta(
  file: File,
  video: boolean,
): Promise<{ duration: number; w: number; h: number; thumb: { blob: Blob; w: number; h: number } | null }> {
  const none = { duration: 0, w: 0, h: 0, thumb: null };
  const url = URL.createObjectURL(file);
  const el = document.createElement(video ? "video" : "audio") as HTMLVideoElement;
  el.muted = true;
  el.preload = "metadata";
  el.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error("no metadata"));
      window.setTimeout(() => reject(new Error("timeout")), 8000);
    });
    const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
    if (!video || !el.videoWidth) return { ...none, duration };
    const w = el.videoWidth;
    const h = el.videoHeight;
    // a frame a little in: the very first one is often black
    el.currentTime = Math.min(1, (el.duration || 0) / 10);
    await new Promise<void>((resolve) => {
      el.onseeked = () => resolve();
      window.setTimeout(resolve, 3000);
    });
    const k = Math.min(1, 800 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return { duration, w, h, thumb: blob ? { blob, w: canvas.width, h: canvas.height } : null };
  } catch {
    return none;
  } finally {
    el.removeAttribute("src");
    URL.revokeObjectURL(url);
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
  try {
    const content = await buildAttachment(roomId, file, caption);
    if (!content) return;
    if (reply) content["m.relates_to"] = { "m.in_reply_to": { event_id: reply.eventId } };
    await c.sendMessage(roomId, content as never);
  } catch (e) {
    app.set({ error: t("chat.err.upload", { name: file.name, error: humanError(e) }) });
  }
}

/**
 * Upload one file and make the message content for it, with the progress bar
 * above the field. In an encrypted room the file (and the still picture of a
 * video) is encrypted here first. Errors are thrown to the caller.
 */
async function buildAttachment(roomId: string, file: File, caption: string): Promise<Record<string, unknown> | null> {
  const c = client;
  if (!c) return null;
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
    const encrypted = !!c.getRoom(roomId)?.hasEncryptionStateEvent();
    if (kind === "m.image") {
      const dims = await imageSize(file);
      if (dims) Object.assign(info, dims);
    } else if (kind === "m.video" || kind === "m.audio") {
      const meta = await mediaMeta(file, kind === "m.video");
      if (meta.duration) info.duration = meta.duration;
      if (meta.w && meta.h) Object.assign(info, { w: meta.w, h: meta.h });
      if (meta.thumb) {
        // the still picture goes the same way as the file: encrypted in encrypted rooms
        try {
          const t = meta.thumb;
          const thumbInfo = { w: t.w, h: t.h, mimetype: "image/jpeg", size: t.blob.size };
          if (encrypted) {
            const { data, file: enc } = await encryptAttachment(await t.blob.arrayBuffer());
            const up = await c.uploadContent(new Blob([data]), { type: "application/octet-stream", includeFilename: false });
            info.thumbnail_file = { ...enc, url: up.content_uri, mimetype: "image/jpeg" };
          } else {
            const up = await c.uploadContent(t.blob, { type: "image/jpeg", includeFilename: false });
            info.thumbnail_url = up.content_uri;
          }
          info.thumbnail_info = thumbInfo;
        } catch {
          // the video goes without a still picture
        }
      }
    }
    const progressHandler = (p: { loaded: number; total: number }) =>
      setUpload(id, { progress: p.total ? p.loaded / p.total : 0 });

    const content: Record<string, unknown> = { msgtype: kind, body: caption || file.name, info };
    if (caption) content.filename = file.name;

    if (encrypted) {
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
    return content;
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
  if (state.editing) {
    await saveEdit(text, state.editing.media, files);
    return;
  }
  if (!files.length) {
    await send(text);
    return;
  }
  typingNow(false);
  let reply = state.replyTo;
  app.set({ replyTo: null });

  const caption = files.length === 1 ? text.trim() : "";
  if (text.trim() && !caption) {
    try {
      await msg.sendText(client, roomId, text, reply, mentionResolver(roomId));
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
  const mine = [...app.get().messages].reverse().find((m) => m.own && m.canEdit && !m.media);
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

/** Reply to a piece of a message: the piece shows above the answer and leads to the message. */
export function startQuote(m: Message, piece: string): void {
  const body = piece.trim() || m.body;
  app.set({
    replyTo: { eventId: m.id, sender: m.sender, senderName: m.senderName, body: body.slice(0, 500), quote: true },
    editing: null,
    userMenu: null,
  });
}

export function canPinHere(): boolean {
  const room = client?.getRoom(app.get().activeChannel ?? "");
  return !!client && !!room && msg.canPin(room, client.getUserId() ?? "");
}

export async function togglePin(id: string): Promise<void> {
  const roomId = app.get().activeChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !roomId || !room) return;
  const list = msg.pinnedIds(room);
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  try {
    await msg.setPinned(client, roomId, next);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

export type PinnedItem = { id: string; sender: string; name: string; body: string; ts: number };

/** Pinned messages of the open chat, newest pin first; fetched from the server if not loaded. */
export async function pinnedMessages(): Promise<PinnedItem[]> {
  const roomId = app.get().activeChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !roomId || !room) return [];
  const c = client;
  const out: PinnedItem[] = [];
  for (const id of [...msg.pinnedIds(room)].reverse()) {
    let sender = "";
    let body = "";
    let ts = 0;
    const local = room.findEventById(id);
    if (local) {
      sender = local.getSender() ?? "";
      body = String(msg.currentContent(local).content.body ?? "");
      ts = local.getTs();
    } else {
      try {
        const raw = (await c.fetchRoomEvent(roomId, id)) as { sender?: string; content?: { body?: string }; origin_server_ts?: number; type?: string };
        sender = raw.sender ?? "";
        body = raw.type === "m.room.encrypted" ? t("chat.locked") : String(raw.content?.body ?? "");
        ts = raw.origin_server_ts ?? 0;
      } catch {
        body = t("pins.gone");
      }
    }
    out.push({ id, sender, name: sender ? displayName(sender, roomId) : "", body: msg.stripReplyFallback(body), ts });
  }
  return out;
}

export function startEdit(m: Message): void {
  const media = !!m.media;
  app.set({ editing: { eventId: m.id, body: media ? (m.media?.caption ?? "") : m.body, media }, replyTo: null, userMenu: null });
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
  app.set({ lightbox: null, imageMenu: null });
}

export function openImageMenu(url: string, name: string, x: number, y: number, inViewer = false): void {
  app.set({ imageMenu: { url, name, x, y, inViewer }, userMenu: null, placeMenu: null, streamMenu: null, screenMenu: null });
}

export function closeImageMenu(): void {
  if (app.get().imageMenu) app.set({ imageMenu: null });
}

/** A file name that is safe on any system: no folders, no reserved characters. */
export function safeFileName(name: string, fallback: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return clean || fallback;
}

/** Save a picture: the shell asks where, as a browser does. */
export function saveImage(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(name, "image.png");
  a.click();
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

let searchRun = 0;

/**
 * Search the open chat. The homeserver matches whole words only and sees
 * nothing in encrypted rooms, so the app also looks through what it has
 * loaded and a few hundred older messages itself, matching pieces of words.
 * Local results show at once, the rest joins them; newest first.
 */
export async function runSearch(term: string): Promise<void> {
  const roomId = app.get().activeChannel;
  const q = term.trim();
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !roomId || !room || !q) {
    closeSearch();
    return;
  }
  const c = client;
  const run = ++searchRun;
  const merge = (lists: msg.Hit[][]) => {
    const seen = new Map<string, msg.Hit>();
    for (const list of lists) for (const h of list) if (h.eventId && !seen.has(h.eventId)) seen.set(h.eventId, h);
    return [...seen.values()].sort((a, b) => b.ts - a.ts);
  };
  const local = msg.searchLoaded(room, q);
  app.set({ searchOpen: true, searching: true, searchTerm: q, searchHits: local, pinsOpen: false, error: "" });
  const [older, remote] = await Promise.all([
    msg.searchOlder(c, room, q, 8).catch(() => [] as msg.Hit[]),
    msg.search(c, roomId, q).catch(() => [] as msg.Hit[]),
  ]);
  if (run !== searchRun || app.get().activeChannel !== roomId || !app.get().searchOpen) return;
  app.set({ searchHits: merge([local, older, remote]), searching: false });
}

export function closeSearch(): void {
  searchRun += 1;
  if (app.get().searchOpen || app.get().searchHits.length) app.set({ searchOpen: false, searchHits: [], searching: false, searchTerm: "" });
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
        .map((m) => displayName(m.userId, roomId))
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
/** Something arrived while a receipt was on the way: one more goes after it. */
let readAgain = false;

/**
 * Whether the open chat shows its newest messages. Scrolled up, new messages
 * are not read yet: the receipt waits until the user comes back down.
 */
let chatAtBottom = true;

export function setChatAtBottom(at: boolean): void {
  if (at === chatAtBottom) return;
  chatAtBottom = at;
  if (at) readActive();
}

function readActive(): void {
  const roomId = app.get().activeChannel;
  const room = roomId ? client?.getRoom(roomId) : null;
  if (!client || !room || document.hidden || !chatAtBottom) return;
  if (reading) {
    // a burst of messages: the receipt for the last one must still go out
    readAgain = true;
    return;
  }
  reading = true;
  readAgain = false;
  void msg
    .markRead(client, room)
    .catch(() => undefined)
    .finally(() => {
      reading = false;
      scheduleRooms();
      if (readAgain) {
        readAgain = false;
        readActive();
      }
    });
}

/** The open chat is being read right now: its badge counts nowhere. */
export function readingNow(roomId: string): boolean {
  return roomId === app.get().activeChannel && chatAtBottom && !document.hidden && !app.get().callView;
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
    adminRun(t("busy.role"), t("admin.what.role"), async () => {
      const r = await admin.setRole(need(), spaceId, userId, level);
      // hidden channels follow the new role: invited to new ones, removed from lost ones
      const s = await admin.syncServerAccess(need(), spaceId);
      return { ok: r.ok + s.ok, failed: [...r.failed, ...s.failed] };
    }),
  roles: (spaceId: string): admin.RoleDef[] => (client ? admin.serverRoles(client, spaceId) : []),
  roleAt: (roles: admin.RoleDef[], level: number) => admin.roleAt(roles, level),
  saveRoles: (spaceId: string, roles: admin.RoleDef[]) =>
    adminRun(t("busy.roles"), "", () => admin.saveRoles(need(), spaceId, roles)),
  channelAccess: (roomId: string): admin.ChannelAccess => (client ? admin.channelAccess(client, roomId) : { view: 0, send: 0, voice: 0 }),
  setChannelAccess: (spaceId: string, roomId: string, next: admin.ChannelAccess) =>
    adminRun(t("busy.channelPerms"), t("admin.what.access"), () => admin.setChannelAccess(need(), spaceId, roomId, next)),
  kick: (spaceId: string, userId: string, reason: string) =>
    adminRun(t("busy.kick"), t("admin.what.kick"), async () => {
      await dropFromCalls(spaceId, userId);
      return admin.kick(need(), spaceId, userId, reason);
    }),
  ban: (spaceId: string, userId: string, reason: string) =>
    adminRun(t("busy.ban"), t("admin.what.ban"), async () => {
      await dropFromCalls(spaceId, userId);
      return admin.ban(need(), spaceId, userId, reason);
    }),
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

/**
 * Before a kick or ban: out of every voice channel of the server. The own call
 * tells the person's app to leave at once; memberships in other channels are
 * cleared so nobody sees a ghost. The app of the banned person also leaves on
 * its own when it sees the ban.
 */
async function dropFromCalls(spaceId: string, userId: string): Promise<void> {
  const c = client;
  if (!c) return;
  const server = app.get().servers.find((g) => g.spaceId === spaceId);
  if (server?.channels.some((ch) => ch.roomId === app.get().voiceChannel)) {
    for (const identity of voice.presentIdentities()) {
      if (identity.startsWith(`${userId}:`)) voice.kick(identity);
    }
  }
  for (const ch of server?.channels ?? []) {
    if (ch.kind !== "voice") continue;
    const room = c.getRoom(ch.roomId);
    if (!room) continue;
    for (const m of rtc.memberships(room)) {
      if (m.sender === userId) await rtc.clearMembership(c, room.roomId, m).catch(() => undefined);
    }
  }
}

/**
 * Own membership changed. A kick or ban from a server takes the whole server
 * away: its channels are left here too, the call ends, and the reason is
 * shown. Without this the channels the admin could not reach stayed behind
 * as orphans.
 */
/** The joined server a room is a channel of, if any. */
function parentSpace(roomId: string): string | null {
  for (const room of client?.getRooms() ?? []) {
    if (!room.isSpaceRoom() || room.getMyMembership() !== "join") continue;
    const child = room.currentState.getStateEvents("m.space.child", roomId);
    if (child?.getContent()?.via) return room.roomId;
  }
  return null;
}

/**
 * An invite into a channel of a server we are on: a hidden channel opened to
 * our role. It is joined at once instead of waiting under the home button.
 */
const joiningInvites = new Set<string>();

function joinChannelInvite(roomId: string): boolean {
  if (!client || !parentSpace(roomId)) return false;
  if (joiningInvites.has(roomId)) return true;
  joiningInvites.add(roomId);
  void client
    .joinRoom(roomId)
    .then(() => refreshRooms())
    .catch(() => undefined)
    .finally(() => joiningInvites.delete(roomId));
  return true;
}

function onMyMembership(room: Room, membership: string, prev: string | undefined): void {
  scheduleRooms();
  if (membership === "invite" && joinChannelInvite(room.roomId)) return;
  // a new room of a server: it gets the server name and the banner
  if (membership === "join" && prev !== "join") scheduleOwnMembers(3000);
  const c = client;
  if (!c || prev !== "join" || (membership !== "leave" && membership !== "ban")) return;
  const self = c.getUserId() ?? "";
  const ev = room.getMember(self)?.events.member;
  const by = ev?.getSender() ?? self;
  const reason = String(ev?.getContent()?.reason ?? "");

  if (app.get().voiceChannel === room.roomId) void leaveVoice();
  if (by === self) return;

  if (room.isSpaceRoom()) {
    const children = room.currentState
      .getStateEvents("m.space.child")
      .map((e) => e.getStateKey() ?? "")
      .filter((id) => id && c.getRoom(id)?.getMyMembership() === "join");
    if (children.includes(app.get().voiceChannel ?? "")) void leaveVoice();
    void (async () => {
      for (const id of children) await c.leave(id).catch(() => undefined);
      refreshRooms();
    })();
    const text = membership === "ban" ? "server.bannedYou" : "server.kickedYou";
    app.set({
      error: t(text, { name: room.name || room.roomId, who: displayName(by, room.roomId) }) + (reason ? t("server.reason", { reason }) : ""),
    });
    if (app.get().activeServer === room.roomId) {
      const next = app.get().servers.find((g) => g.spaceId !== room.roomId);
      app.set({ activeServer: null, activeChannel: null, messages: [], callView: false, serverSettingsOpen: false });
      if (next) selectServer(next.spaceId);
      else showDirects();
    }
    return;
  }

  if (app.get().activeChannel === room.roomId) {
    app.set({ activeChannel: null, messages: [], callView: false });
    restoreChannel();
  }
}

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

/* ---------------------------------------------------------- leave a server */

export type LeaveInfo = {
  /** Nobody else on the server can manage it after this user leaves. */
  lastAdmin: boolean;
  /** Nobody else is on the server at all. */
  alone: boolean;
};

export function leaveInfo(spaceId: string): LeaveInfo {
  const space = client?.getRoom(spaceId);
  const self = me();
  if (!space) return { lastAdmin: false, alone: false };
  const others = space.getJoinedMembers().filter((m) => m.userId !== self);
  return {
    lastAdmin:
      admin.levelOf(space, self) >= admin.ADMIN_LEVEL && !others.some((m) => admin.levelOf(space, m.userId) >= admin.ADMIN_LEVEL),
    alone: others.length === 0,
  };
}

/**
 * Leave a server: every joined channel, then the server itself. It can be
 * joined again by its address or a new invite.
 */
export async function leaveServer(spaceId: string): Promise<boolean> {
  if (!client) return false;
  const c = client;
  app.set({ busy: t("busy.leavingServer"), error: "", leaveServerAsk: null });
  const rooms = admin.serverRooms(c, spaceId);
  if (rooms.some((r) => r.roomId === app.get().voiceChannel)) await leaveVoice();

  const failed: string[] = [];
  for (const room of rooms) {
    if (room.roomId === spaceId) continue;
    try {
      await c.leave(room.roomId);
    } catch {
      failed.push(room.name || room.roomId);
    }
  }
  try {
    await c.leave(spaceId);
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    refreshRooms();
    return false;
  }

  refreshRooms();
  app.set({ busy: "", serverSettingsOpen: false, error: failed.length ? t("server.leave.partial", { names: failed.join(", ") }) : "" });
  if (app.get().activeServer === spaceId) {
    const next = app.get().servers.find((g) => g.spaceId !== spaceId);
    app.set({ activeServer: null, activeChannel: null, messages: [], callView: false });
    if (next) selectServer(next.spaceId);
    else showDirects();
  }
  return true;
}

/* ---------------------------------------------------------- delete account */

/**
 * Delete the account on the server, then clean up here like a sign-out. The
 * server has already ended every session, so the sign-out request just fails.
 */
export async function deleteAccount(password: string, erase: boolean): Promise<void> {
  if (!client) return;
  await leaveVoice();
  // the sync loop is about to see the token die: expected here, not "session expired"
  endingSession = true;
  try {
    await people.deactivateAccount(client, password, erase);
  } catch (e) {
    endingSession = false;
    throw e;
  }
  try {
    await doLogout();
  } finally {
    endingSession = false;
  }
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

/**
 * Back to invites only. Channels that were open to anyone become open to the
 * server's members only, or an outsider who knows a channel's id could still
 * walk in. Hidden channels keep their own rule.
 */
export async function closeServerJoin(spaceId: string): Promise<void> {
  const c = client;
  if (!c) return;
  app.set({ busy: t("busy.closeJoin"), error: "" });
  const failed: string[] = [];
  try {
    await c.sendStateEvent(spaceId, "m.room.join_rules" as never, { join_rule: "invite" } as never, "");
    for (const room of admin.serverRooms(c, spaceId)) {
      if (room.roomId === spaceId || room.getJoinRule() !== "public") continue;
      try {
        await c.sendStateEvent(
          room.roomId,
          "m.room.join_rules" as never,
          { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: spaceId }] } as never,
          "",
        );
      } catch {
        failed.push(room.name || room.roomId);
      }
    }
    bump();
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    return;
  }
  app.set({ busy: "", error: failed.length ? t("address.closePartial", { names: failed.join(", ") }) : "" });
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

/** Address suggestion for a new server, e.g. the one the host already announces. */
export function suggestServerAddress(): Promise<string> {
  return client ? suggestAddress(client).catch(() => "") : Promise.resolve("");
}

/** Resolves once the sync brought the room in, or after the timeout. */
function roomArrived(roomId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (client?.getRoom(roomId) || Date.now() - started > ms) resolve();
      else window.setTimeout(check, 200);
    };
    check();
  });
}

/** Create an own server with a text and a voice channel and open it. */
export async function newServer(name: string, address: string, open: boolean): Promise<boolean> {
  if (!client || !name.trim()) return false;
  const alias = address.trim().replace(/^#/, "").split(":")[0].toLowerCase();
  if (alias && !/^[a-z0-9._=-]+$/.test(alias)) {
    app.set({ error: t("address.err.latin") });
    return false;
  }
  const full = `#${alias}:${client.getDomain() ?? ""}`;
  app.set({ busy: t("busy.creatingServer"), error: "" });
  try {
    const spaceId = await createServer(client, {
      name: name.trim(),
      alias,
      open,
      textName: t("server.create.textChannel"),
      voiceName: t("server.create.voiceChannel"),
    });
    await roomArrived(spaceId, 10_000);
    refreshRooms();
    app.set({ busy: "", addServerOpen: false, serverCard: null });
    selectServer(spaceId);
    return true;
  } catch (e) {
    const text = humanError(e);
    app.set({ busy: "", error: /M_ROOM_IN_USE|in use/i.test(text) ? t("address.err.taken", { alias: full }) : text });
    return false;
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
  if (channel.voiceLocked) {
    app.set({ error: t("voice.err.noAccess", { channel: channel.name }) });
    return;
  }
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
  if (state.sunshine) {
    await stopSunshineStream();
    return;
  }
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
  if (!state.screen && !state.sunshine) {
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
  if (voice.getState().sunshine) await stopSunshineStream();
  else await voice.stopScreen();
}

/**
 * Start sharing or apply settings to the running share. The same source with
 * new quality changes in place, another source replaces the picture without
 * interrupting viewers. A null source lets the browser ask (development only).
 */
export async function shareSource(sourceId: string | null, opts: ShareOptions, pickNew = false): Promise<void> {
  // one stream at a time: an own Sunshine stream ends before the call server takes over
  if (voice.getState().sunshine) await stopSunshineStream();
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
  if (s.streamMenu || s.screenMenu || s.imageMenu) app.set({ streamMenu: null, screenMenu: null, imageMenu: null });
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
  else if (mode === "dnd") want = "dnd";
  else if (mode === "streamer") want = "streamer";
  else want = (await idleSeconds()) >= IDLE_AFTER_S ? "unavailable" : "online";
  if (!force && want === app.get().myPresence) return;
  app.set({ myPresence: want });
  // Matrix has neither "do not disturb" nor a streamer mode: both are "online" with a status message
  const presence = want === "dnd" || want === "streamer" ? "online" : want;
  const statusMsg = want === "dnd" ? people.DND_STATUS : want === "streamer" ? people.STREAMER_STATUS : "";
  try {
    // the sync presence too, or the next sync request resets it to online
    await c.setSyncPresence(presence as SetPresence);
    await c.setPresence({ presence, status_msg: statusMsg });
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

/** Do not disturb or the streamer mode: no notifications and no message sounds. */
export function quietMode(): boolean {
  const mode = app.get().statusMode;
  return mode === "dnd" || mode === "streamer";
}

// the streamer mode lives in the status; the hiding itself is done by the privacy settings
setPrivacy({ streamer: app.get().statusMode === "streamer" });

export function setStatusMode(mode: StatusMode): void {
  setPrivacy({ streamer: mode === "streamer" });
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
  /** The account was deleted. */
  deleted: boolean;
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
  const named = server && client && !owner ? admin.roleAt(admin.serverRoles(client, server.spaceId), level) : null;
  return { level, name: named?.name ?? admin.roleName(level, owner), owner };
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

  const gone = people.isDeleted(userId);
  return {
    userId,
    deleted: gone,
    name: gone ? t("people.deleted") : bits.name,
    avatar: gone ? "" : bits.avatar,
    server: userId.split(":").slice(1).join(":"),
    power: role.level,
    role: role.name,
    inServer: !!serverOf(scope),
    voiceChannel: inVoice,
    presence: userId === client?.getUserId() ? state.myPresence : client ? people.presenceOf(client, userId) : "offline",
    own: userId === client?.getUserId(),
  };
}

export function openProfile(userId: string, fromVoice = false): void {
  app.set({ profileUser: userId, profileVoice: fromVoice, userMenu: null });
}

export function openUserMenu(userId: string, x: number, y: number, roomId: string | null = null, voice = false): void {
  app.set({ userMenu: { userId, roomId, x, y, voice } });
}

export function closeUserMenu(): void {
  if (app.get().userMenu) app.set({ userMenu: null });
}

export function copyText(text: string): Promise<boolean> {
  return copyToClipboard(text);
}

let noticeTimer = 0;

/** A short confirmation at the bottom of the window. */
export function flashNotice(text: string): void {
  window.clearTimeout(noticeTimer);
  app.set({ notice: text });
  noticeTimer = window.setTimeout(() => app.set({ notice: "" }), 2200);
}

/** Right click on a picture copies it, as in Discord. */
export async function copyImage(url: string): Promise<void> {
  if (await copyImageToClipboard(url)) flashNotice(t("chat.imageCopied"));
  else app.set({ error: t("chat.err.imageCopy") });
}

/* --------------------------------------------------- own profile and sessions */

export async function saveMyName(name: string): Promise<void> {
  if (!client || !name.trim()) return;
  app.set({ busy: t("busy.name"), error: "" });
  try {
    await people.setName(client, name);
    profileCache.clear();
    refreshMe();
    await fetchMe();
    // the homeserver has just reset the name in every room: server names and the banner go back
    scheduleOwnMembers(300);
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
    await fetchMe();
    scheduleOwnMembers(300);
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

/* ------------------------------------ own membership: server names and banner */

/**
 * The banner travels in the own membership of each server's space, under a
 * key of this app: everyone on the server can read it, other clients ignore
 * it. Server names and pictures are the standard per-room display name and
 * avatar of the membership, which every Matrix client shows.
 */
const BANNER_KEY = `${BRAND.appId}.banner`;

let ownMembersTimer = 0;
let ownMembersRunning = false;
let ownMembersAgain = false;
/** Servers whose own name was just taken away: their rooms get the global profile back. */
const resetServers = new Set<string>();

export function scheduleOwnMembers(delay = 1500): void {
  window.clearTimeout(ownMembersTimer);
  ownMembersTimer = window.setTimeout(() => void syncOwnMembers(), delay);
}

function isDefaultBanner(look: TileLook): boolean {
  return look.mode === "dominant" && !look.image && !look.emoji;
}

/**
 * Bring the own memberships in line: the server name and picture in every
 * room of a server that has them, the banner in every space. Rooms that
 * already match are not touched, so this is cheap to run often; rooms of
 * servers without an own name keep whatever name they have.
 */
async function syncOwnMembers(): Promise<void> {
  const c = client;
  if (!c) return;
  if (ownMembersRunning) {
    ownMembersAgain = true;
    return;
  }
  ownMembersRunning = true;
  try {
    const self = c.getUserId() ?? "";
    let global: { displayname?: string; avatar_url?: string } = {};
    try {
      global = await c.getProfileInfo(self);
    } catch {
      return;
    }
    const overrides = getServerProfiles();
    const banner = getTileLook();
    const reset = new Set(resetServers);
    resetServers.clear();
    for (const server of app.get().servers) {
      const own = overrides[server.spaceId];
      const naming = !!own || reset.has(server.spaceId);
      for (const room of admin.serverRooms(c, server.spaceId)) {
        const isSpace = room.roomId === server.spaceId;
        if (!naming && !isSpace) continue;
        const ev = room.getMember(self)?.events.member;
        if (!ev || room.getMyMembership() !== "join") continue;
        const cur = ev.getContent() as Record<string, unknown>;
        const want: Record<string, unknown> = { ...cur, membership: "join" };
        // these belong to the join itself, not to a profile change
        delete want.join_authorised_via_users_server;
        delete want.reason;
        if (naming) {
          const name = own?.name || global.displayname;
          const avatar = own?.avatar || global.avatar_url;
          if (name) want.displayname = name;
          else delete want.displayname;
          if (avatar) want.avatar_url = avatar;
          else delete want.avatar_url;
        }
        if (isSpace) {
          if (isDefaultBanner(banner)) delete want[BANNER_KEY];
          else want[BANNER_KEY] = banner;
        }
        const pick = (o: Record<string, unknown>) => JSON.stringify([o.displayname ?? null, o.avatar_url ?? null, o[BANNER_KEY] ?? null]);
        if (pick(cur) === pick(want)) continue;
        try {
          await c.sendStateEvent(room.roomId, "m.room.member" as never, want as never, self);
        } catch {
          // no right to change it here, or the server is unreachable: the next run tries again
        }
      }
    }
  } finally {
    ownMembersRunning = false;
    if (ownMembersAgain) {
      ownMembersAgain = false;
      scheduleOwnMembers(500);
    }
  }
}

onTileLookChange(() => scheduleOwnMembers(2500));
onServerProfilesChange(() => scheduleOwnMembers(800));

/* --------------------------------------------------------------- soundboard */

/** A sound of a server's soundboard. The file sits on the homeserver like any attachment. */
export type Sound = { id: string; name: string; emoji: string; url: string; mime: string };

const MAX_SOUNDS = 48;
const MAX_SOUND_BYTES = 1024 * 1024;
const MAX_SOUND_SECONDS = 7;

export function serverSounds(spaceId: string | null): Sound[] {
  const raw = spaceId ? client?.getRoom(spaceId)?.currentState.getStateEvents(admin.SOUNDS_EVENT, "")?.getContent()?.sounds : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s.id === "string" && isMxc(s.url))
    .map((s) => ({
      id: String(s.id),
      name: String(s.name ?? "").slice(0, 32),
      emoji: cleanEmoji(s.emoji).slice(0, 16),
      url: String(s.url),
      mime: String(s.mime ?? ""),
    }))
    .slice(0, MAX_SOUNDS);
}

/** The server of the running call: its soundboard is the one offered. */
export function callServerId(): string | null {
  return serverOf(app.get().voiceChannel)?.spaceId ?? null;
}

export function canEditSounds(spaceId: string | null): boolean {
  const room = spaceId ? client?.getRoom(spaceId) : null;
  if (!client || !room) return false;
  try {
    return room.currentState.maySendStateEvent(admin.SOUNDS_EVENT, client.getUserId() ?? "");
  } catch {
    return false;
  }
}

async function writeSounds(spaceId: string, list: Sound[]): Promise<void> {
  await need().sendStateEvent(spaceId, admin.SOUNDS_EVENT as never, { sounds: list } as never, "");
}

/** Add a sound: up to 1 MB and 7 seconds, so a button press stays a short sound. */
export async function addSound(spaceId: string, file: File, name: string, emoji: string): Promise<boolean> {
  const c = client;
  if (!c) return false;
  const list = serverSounds(spaceId);
  if (list.length >= MAX_SOUNDS) {
    app.set({ error: t("sounds.err.full", { n: MAX_SOUNDS }) });
    return false;
  }
  if (file.size > MAX_SOUND_BYTES) {
    app.set({ error: t("sounds.err.big") });
    return false;
  }
  const length = await soundLength(await file.arrayBuffer());
  if (!length) {
    app.set({ error: t("sounds.err.notAudio") });
    return false;
  }
  if (length > MAX_SOUND_SECONDS + 0.3) {
    app.set({ error: t("sounds.err.long", { n: MAX_SOUND_SECONDS }) });
    return false;
  }
  app.set({ busy: t("busy.sound"), error: "" });
  try {
    const up = await c.uploadContent(file, { type: file.type || "audio/mpeg", name: file.name });
    const sound: Sound = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: (name.trim() || file.name.replace(/\.[^.]+$/, "")).slice(0, 32),
      emoji: cleanEmoji(emoji),
      url: up.content_uri,
      mime: file.type,
    };
    await writeSounds(spaceId, [...list, sound]);
    app.set({ busy: "" });
    return true;
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    return false;
  }
}

export async function removeSound(spaceId: string, id: string): Promise<void> {
  try {
    await writeSounds(spaceId, serverSounds(spaceId).filter((s) => s.id !== id));
  } catch (e) {
    app.set({ error: humanError(e) });
  }
}

/** Play a sound for the whole call. */
export function playSound(sound: Sound): void {
  voice.sendBoardSound(sound.url);
}

/** Listen to a sound alone, without the call hearing it. */
export function previewSound(sound: Sound): void {
  playLocal(sound.url);
}

function playLocal(url: string): void {
  void playBoardSound(url, async () => (await fetch(await mediaUrl(url))).arrayBuffer(), getSoundPrefs().board, voice.getState().settings.spkId);
}

// someone in the call pressed a sound: heard here unless the sound is off
voice.onBoardSound = (url) => {
  if (voice.getState().deafened) return;
  if (!serverSounds(callServerId()).some((s) => s.url === url)) return;
  playLocal(url);
};

/** A banner picture: large ones are scaled down to 1920 px wide first; small animations stay as they are. */
export async function uploadBanner(file: File): Promise<string> {
  const c = client;
  if (!c) return "";
  app.set({ busy: t("busy.picture"), error: "" });
  try {
    let blob: Blob = file;
    if (!(file.type === "image/gif" && file.size < 4_000_000)) {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1920 / bmp.width);
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
      canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    }
    const up = await c.uploadContent(blob, { type: blob.type || file.type, includeFilename: false });
    app.set({ busy: "" });
    return up.content_uri;
  } catch (e) {
    app.set({ busy: "", error: humanError(e) });
    return "";
  }
}

/** The own name and picture on one server. An empty name and no picture mean the global profile. */
export async function setServerProfile(spaceId: string, name: string, avatar: File | string | null): Promise<void> {
  const c = client;
  if (!c) return;
  app.set({ busy: t("busy.serverProfile"), error: "" });
  try {
    const mxc = avatar instanceof File ? (await c.uploadContent(avatar, { type: avatar.type, name: avatar.name })).content_uri : (avatar ?? "");
    if (!name.trim() && !mxc) resetServers.add(spaceId);
    setServerProfilePref(spaceId, { name, avatar: mxc });
    window.clearTimeout(ownMembersTimer);
    await syncOwnMembers();
    profileCache.clear();
    bump();
  } catch (e) {
    app.set({ error: humanError(e) });
  }
  app.set({ busy: "" });
}

/**
 * A person's banner: their own from settings, the one their app sent in the
 * call, or the one in their membership of a shared server (this server
 * first). Null for people whose app says nothing: the avatar color is used.
 */
export function bannerOf(userId: string, roomId?: string | null): TileLook | null {
  if (!userId) return null;
  if (userId === me()) return getTileLook();
  return withoutPicture(theirBanner(userId, roomId));
}

function theirBanner(userId: string, roomId?: string | null): TileLook | null {
  const live = voice.getState().members.find((m) => m.userId === userId && m.tile)?.tile;
  if (live) return live;
  const c = client;
  if (!c) return null;
  const first = serverOf(roomId)?.spaceId;
  const spaces = [first, ...app.get().servers.map((g) => g.spaceId).filter((id) => id !== first)].filter(Boolean) as string[];
  for (const id of spaces) {
    const look = cleanTile(c.getRoom(id)?.getMember(userId)?.events.member?.getContent()?.[BANNER_KEY]);
    if (look) return look;
  }
  return null;
}

/** Pictures of other people's banners can be turned off: the avatar color stands in, the emoji stay. */
export function withoutPicture(look: TileLook | null): TileLook | null {
  if (!look || look.mode !== "image" || getViewPrefs().bannerImages) return look;
  return { mode: "dominant", color: look.color, ...(look.emoji ? { emoji: look.emoji } : {}) };
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
  return client ? crypto.cryptoStatus(client) : Promise.resolve(crypto.NO_CRYPTO);
}

/** A new recovery key to show the user. Nothing changes on the account yet. */
export function newRecoveryKey(): Promise<GeneratedSecretStorageKey> {
  if (!client) return Promise.reject(new Error(t("crypto.err.noCrypto")));
  return crypto.newRecoveryKey(client);
}

/**
 * Put the shown recovery key in place, or with `reset` start encryption over.
 * Throws NeedPassword when the server wants the account password.
 */
export async function applyRecoveryKey(key: GeneratedSecretStorageKey, password: string, reset: boolean): Promise<void> {
  if (!client) return;
  await crypto.setupRecovery(client, key, password, reset);
  scheduleMessages();
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
  const firstBefore = app.get().messages[0]?.id ?? "";
  try {
    // voice channels are full of call state: a page may hold no message at all
    for (let i = 0; i < 6 && room.oldState.paginationToken !== null; i += 1) {
      const count = room.getLiveTimeline().getEvents().length;
      await client.scrollback(room, 50);
      if (app.get().activeChannel !== roomId) return false;
      refreshMessages();
      if ((app.get().messages[0]?.id ?? "") !== firstBefore) break;
      if (room.getLiveTimeline().getEvents().length === count) break;
    }
    refreshMessages();
    return (app.get().messages[0]?.id ?? "") !== firstBefore;
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
  // do not disturb and the streamer mode keep quiet: the badges still count
  if (quietMode()) return;

  const body = msg.stripReplyFallback(String(event.getContent().body ?? ""));
  const direct = app.get().directs.some((d) => d.roomId === room.roomId);
  const mention = mentionsMe(event, body);
  if (isMuted("users", sender)) return;
  if (!mention && roomMuted(room.roomId)) return;
  if (mode === "mentions" && !direct && !mention) return;
  // the chat of a voice channel is talk next to the call: silent unless asked for, mentions aside
  if (!mention && !getNotifyPrefs().voiceChats && isVoiceChat(room.roomId)) return;

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
      void jumpToRoom(room.roomId).then(() => (id ? jumpTo(id) : undefined));
      n.close();
    };
  } catch {
    // notifications blocked by the system
  }
}

function isVoiceChat(roomId: string): boolean {
  return !!serverOf(roomId)?.channels.some((c) => c.roomId === roomId && c.kind === "voice");
}

/** Open a chat wherever it is: in direct messages or on one of the servers. */
export function jumpToRoom(roomId: string): Promise<void> {
  const s = app.get();
  if (s.directs.some((d) => d.roomId === roomId)) {
    app.set({ view: "direct" });
  } else {
    const home = s.servers.find((g) => g.channels.some((c) => c.roomId === roomId));
    if (home) app.set({ view: "server", activeServer: home.spaceId });
  }
  return openChat(roomId);
}

/* ---------------------------------------------------------------- mentions */

function localOf(userId: string): string {
  return userId.slice(1).split(":")[0].toLowerCase();
}

/**
 * Who an @mention in a room means. A full id is a person as is; a bare name
 * matches the name part of the room's members (people who left included),
 * preferring those present and on the own server when names repeat.
 */
export function mentionResolver(roomId: string | null): MentionResolver {
  return (id) => {
    const c = client;
    const room = roomId ? c?.getRoom(roomId) : null;
    if (!c || !room) return null;
    const raw = (id.startsWith("@") ? id.slice(1) : id).toLowerCase();
    if (!raw) return null;
    if (raw.includes(":")) {
      const userId = `@${raw}`;
      return { userId, name: people.isDeleted(userId) ? t("people.deleted") : displayName(userId, roomId) };
    }
    const found = room.getMembers().filter((m) => localOf(m.userId) === raw);
    if (!found.length) return null;
    const domain = c.getDomain() ?? "";
    const pick =
      found.find((m) => m.membership === "join" && m.userId.endsWith(`:${domain}`)) ??
      found.find((m) => m.membership === "join") ??
      found[0];
    return { userId: pick.userId, name: displayName(pick.userId, roomId) };
  };
}

/** `group`: "@everyone" or "@here" instead of a person, with a line about whom it pings. */
export type MentionHit = { userId: string; name: string; avatar: string; insert: string; group?: string };

/**
 * People to offer after "@" in the message field: the name part of the id
 * first, then the display name or any word of it. The inserted text is
 * "@name", or the full id when another member has the same name part.
 */
export function mentionCandidates(roomId: string | null, query: string): MentionHit[] {
  const c = client;
  const room = roomId ? c?.getRoom(roomId) : null;
  if (!c || !room) return [];
  const q = query.toLowerCase();
  const self = c.getUserId();
  const groups: MentionHit[] = canPingEveryone(roomId)
    ? [
        { userId: "@everyone", name: "@everyone", avatar: "", insert: "@everyone", group: t("mention.everyone") },
        { userId: "@here", name: "@here", avatar: "", insert: "@here", group: t("mention.here") },
      ].filter((g) => g.name.slice(1).startsWith(q))
    : [];
  const count = new Map<string, number>();
  for (const m of room.getMembers()) count.set(localOf(m.userId), (count.get(localOf(m.userId)) ?? 0) + 1);
  return room
    .getJoinedMembers()
    .filter((m) => m.userId !== self)
    .map((m) => {
      const local = localOf(m.userId);
      const name = (people.plainName(m) || local).toLowerCase();
      const score = !q
        ? 1
        : local.startsWith(q)
          ? 0
          : name.startsWith(q)
            ? 1
            : name.split(/\s+/).some((w) => w.startsWith(q))
              ? 2
              : m.userId.toLowerCase().includes(q)
                ? 3
                : -1;
      return { m, local, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || compareText(people.plainName(a.m) || a.local, people.plainName(b.m) || b.local))
    .slice(0, 8)
    .map<MentionHit>(({ m, local }) => ({
      userId: m.userId,
      name: people.plainName(m) || local,
      avatar: m.getMxcAvatarUrl() || "",
      insert: (count.get(local) ?? 0) > 1 ? m.userId : `@${local}`,
    }))
    .concat(groups);
}

/** Everyone this account shares a room with, by name: for picking whose stream a Moonlight host is. */
export function knownPeople(): { userId: string; name: string }[] {
  const c = client;
  if (!c) return [];
  const self = c.getUserId();
  const seen = new Map<string, string>();
  for (const room of c.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    for (const m of room.getJoinedMembers()) {
      if (m.userId !== self && !seen.has(m.userId)) seen.set(m.userId, people.plainName(m) || people.localName(m.userId));
      if (seen.size > 800) break;
    }
  }
  return [...seen.entries()].map(([userId, name]) => ({ userId, name })).sort((a, b) => compareText(a.name, b.name));
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
  const roles = space ? admin.serverRoles(c, space.roomId) : [];
  return room
    .getJoinedMembers()
    .map((m) => {
      const power = space ? admin.levelOf(space, m.userId) : (m.powerLevel ?? 0);
      const owner = !!space && admin.creatorOf(space) === m.userId;
      const role = admin.roleAt(roles, power);
      return {
        userId: m.userId,
        name: people.plainName(m) || people.localName(m.userId),
        avatar: m.getMxcAvatarUrl() || "",
        power,
        owner,
        presence: m.userId === self ? app.get().myPresence : people.presenceOf(c, m.userId),
        role: owner ? t("role.owner") : role && role.level > 0 ? role.name : "",
        color: owner ? "" : (role?.color ?? ""),
      };
    })
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
