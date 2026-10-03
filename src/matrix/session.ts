import { AutoDiscovery, ClientEvent, SyncState, createClient, type MatrixClient } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
import { canSeal, openSecret, sealSecret } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { cryptoCallbacks, dropCryptoStore, startCrypto } from "./crypto.ts";

/**
 * Session storage and the homeserver connection.
 *
 * Encryption is always started. Server channels are created unencrypted so
 * bots can join voice channels, but direct chats created by Element are
 * encrypted, and without crypto nothing can be read or sent there.
 */

export type Session = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /**
   * The key the encryption store of this sign-in is locked with (hex, 32
   * bytes), kept inside the sealed session. Sign-ins made before it existed
   * have none: their store stays as it was made, unlocked.
   */
  storeKey?: string;
};

/**
 * The sign-in. In the desktop app it is sealed by the operating system
 * (DPAPI on Windows) and only the sealed text is stored; a page in a plain
 * browser keeps it as is. A session stored in the open by an older version is
 * sealed on the next start.
 */
const KEY = "app.session";
const SEALED_KEY = "app.session.sealed";

function parse(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (s.storeKey !== undefined && !/^[0-9a-f]{64}$/.test(String(s.storeKey))) delete s.storeKey;
    return s.homeserver && s.accessToken && s.userId ? s : null;
  } catch {
    return null;
  }
}

/**
 * A fresh sign-in gets a key for its encryption store: the message keys in
 * the profile folder are then useless without the sealed session, as the
 * token is. Only where the session can be sealed: a key stored in the open
 * next to the store would protect nothing.
 */
export function withStoreKey(s: Session): Session {
  if (!canSeal || s.storeKey) return s;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { ...s, storeKey: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

export async function loadSession(): Promise<Session | null> {
  const sealed = read(SEALED_KEY);
  if (sealed) return parse(await openSecret(sealed));
  const plain = parse(read(KEY));
  // an older version left it in the open: seal it now
  if (plain && canSeal) await saveSession(plain);
  return plain;
}

export async function saveSession(s: Session): Promise<void> {
  const json = JSON.stringify(s);
  const sealed = canSeal ? await sealSecret(json) : null;
  if (sealed) {
    write(SEALED_KEY, sealed);
    write(KEY, null);
  } else {
    write(KEY, json);
    write(SEALED_KEY, null);
  }
}

export function clearSession(): void {
  write(KEY, null);
  write(SEALED_KEY, null);
}

/** Base URL from "example.org", "@user:example.org" or "https://matrix.example.org". */
export async function discoverHomeserver(input: string): Promise<string> {
  let raw = input.trim();
  if (!raw) throw new Error(t("session.err.noServer"));
  if (raw.startsWith("@")) raw = raw.split(":").slice(1).join(":");
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/+$/, "");
  }

  try {
    const config = await AutoDiscovery.findClientConfig(raw);
    const hs = config["m.homeserver"];
    if (hs?.base_url) return hs.base_url.replace(/\/+$/, "");
  } catch {
    // no well-known: try the domain itself
  }
  return `https://${raw}`;
}

export class LoginError extends Error {
  constructor(
    message: string,
    readonly homeserver: string,
    readonly identifier: string,
    readonly errcode: string,
    readonly serverMessage: string,
  ) {
    super(message);
  }
}

export async function login(server: string, user: string, password: string): Promise<Session> {
  const homeserver = await discoverHomeserver(server || user);
  const tmp = createClient({ baseUrl: homeserver });

  // Send what was typed, a full id or a bare name. The domain must not be
  // derived from the homeserver URL: the server may live at matrix.example.org
  // while users are @x:example.org.
  const identifier = user.trim();

  try {
    const res = await tmp.loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: identifier },
      password,
      initial_device_display_name: BRAND.name,
    });

    return {
      homeserver,
      userId: res.user_id,
      accessToken: res.access_token,
      deviceId: res.device_id,
    };
  } catch (e) {
    const err = e as { errcode?: string; data?: Record<string, any>; message?: string };
    const errcode = String(err?.errcode ?? err?.data?.errcode ?? "");
    const serverMessage = String(err?.data?.error ?? err?.message ?? "");
    const retryMs = Number(err?.data?.retry_after_ms ?? 0);

    let text: string;
    if (errcode === "M_LIMIT_EXCEEDED") {
      const secs = Math.ceil(retryMs / 1000) || 60;
      text = t("session.err.rateLimited", { secs });
    } else if (errcode === "M_FORBIDDEN" || errcode === "M_UNAUTHORIZED") {
      text = t("session.err.badLogin");
    } else if (errcode === "M_USER_DEACTIVATED") {
      text = t("session.err.deactivated");
    } else {
      text = serverMessage || t("session.err.loginFailed");
    }

    throw new LoginError(text, homeserver, identifier, errcode, serverMessage);
  }
}

/* ------------------------------------------------------------ registration */

/** Matrix localpart: lowercase Latin letters, digits and a few symbols. */
export function cleanUsername(input: string): string {
  return input.trim().replace(/^@/, "").split(":")[0].toLowerCase();
}

export const USERNAME_RULE = /^[a-z0-9._=\-/]+$/;

function registerError(e: unknown): Error {
  const err = e as { errcode?: string; data?: Record<string, any>; message?: string };
  const errcode = String(err?.errcode ?? err?.data?.errcode ?? "");
  const serverMessage = String(err?.data?.error ?? err?.message ?? "");
  if (errcode === "M_USER_IN_USE") return new Error(t("session.err.userInUse"));
  if (errcode === "M_INVALID_USERNAME") return new Error(t("session.err.badUsername"));
  if (errcode === "M_WEAK_PASSWORD") return new Error(t("session.err.weakPassword"));
  if (errcode === "M_FORBIDDEN") return new Error(t("session.err.registrationClosed"));
  if (errcode === "M_LIMIT_EXCEEDED") return new Error(t("session.err.tooManyAttempts"));
  return new Error(serverMessage || t("session.err.registerFailed"));
}

/** Invite code stage: the stable name and the one from MSC3231. */
const TOKEN_STAGES = ["m.login.registration_token", "org.matrix.msc3231.login.registration_token"];
const SUPPORTED_STAGES = new Set(["m.login.dummy", ...TOKEN_STAGES]);

type Uia = {
  session?: string;
  flows?: { stages: string[] }[];
  completed?: string[];
  errcode?: string;
  error?: string;
};

/** The user-interactive auth state from a 401 answer, or null for any other error. */
function uiaOf(e: unknown): Uia | null {
  const err = e as { httpStatus?: number; data?: Uia };
  return err?.httpStatus === 401 && err.data?.flows ? err.data : null;
}

/**
 * Check an invite code before using it, for a clear message. Codes are case
 * sensitive; a code typed in lower case is tried in upper case too. Servers
 * without the check endpoint get the code as typed.
 */
async function checkInvite(homeserver: string, code: string): Promise<string> {
  const valid = async (c: string): Promise<boolean | null> => {
    try {
      const res = await fetch(
        `${homeserver}/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent(c)}`,
      );
      if (!res.ok) return null;
      return !!(await res.json())?.valid;
    } catch {
      return null;
    }
  };
  const first = await valid(code);
  if (first !== false) return code;
  const upper = code.toUpperCase();
  if (upper !== code && (await valid(upper))) return upper;
  throw new Error(t("session.err.badInvite"));
}

/**
 * Create an account. Supported registration stages: the plain m.login.dummy
 * and an invite code (m.login.registration_token, Synapse registration
 * tokens). Captcha and email are left to Element.
 */
export async function register(server: string, username: string, password: string, invite = ""): Promise<Session> {
  const homeserver = await discoverHomeserver(server);
  const tmp = createClient({ baseUrl: homeserver });
  const body = { username: cleanUsername(username), password, initial_device_display_name: BRAND.name };
  const code = invite.trim();

  let res;
  try {
    res = await tmp.registerRequest(body);
  } catch (e) {
    let uia = uiaOf(e);
    if (!uia) throw registerError(e);
    const flow = uia.flows?.find((f) => f.stages.every((st) => SUPPORTED_STAGES.has(st)));
    if (!flow) throw new Error(t("session.err.needsCaptcha"));
    const needsCode = flow.stages.some((st) => TOKEN_STAGES.includes(st));
    if (needsCode && !code) throw new Error(t("session.err.needsInvite"));
    const token = needsCode ? await checkInvite(homeserver, code) : "";
    const session = uia.session;

    // stages go one by one; each answer lists what is completed so far
    for (let step = 0; step < flow.stages.length + 1 && !res; step += 1) {
      const done = new Set(uia?.completed ?? []);
      const stage = flow.stages.find((st) => !done.has(st));
      if (!stage) break;
      const auth = TOKEN_STAGES.includes(stage) ? { type: stage, token, session } : { type: stage, session };
      try {
        res = await tmp.registerRequest({ ...body, auth } as never);
      } catch (e2) {
        const next = uiaOf(e2);
        if (!next) throw registerError(e2);
        const advanced = (next.completed ?? []).includes(stage);
        if (!advanced) {
          throw TOKEN_STAGES.includes(stage) ? new Error(t("session.err.badInvite")) : registerError(e2);
        }
        uia = next;
      }
    }
    if (!res) throw new Error(t("session.err.registerFailed"));
  }
  if (!res.access_token || !res.device_id) {
    throw new Error(t("session.err.noAutoLogin"));
  }
  return { homeserver, userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id };
}

export function createSessionClient(s: Session): MatrixClient {
  return createClient({
    baseUrl: s.homeserver,
    accessToken: s.accessToken,
    userId: s.userId,
    deviceId: s.deviceId,
    timelineSupport: true,
    cryptoCallbacks: cryptoCallbacks as never,
  });
}

/** The server no longer accepts the access token: the session is over and cannot be restored. */
export function isSessionGone(e: unknown): boolean {
  const code = (e as { errcode?: string } | null)?.errcode;
  return code === "M_UNKNOWN_TOKEN" || code === "M_MISSING_TOKEN";
}

/**
 * Start crypto, start syncing and wait for the first full sync. Network
 * failures do not end the wait: the SDK retries on its own until the server
 * answers. Only a revoked access token rejects.
 */
export async function start(client: MatrixClient, storeKey?: string): Promise<void> {
  // crypto must be ready before sync, or the first events arrive undecrypted
  await startCrypto(client, client.getDeviceId() ?? "", storeKey);
  return new Promise((resolve, reject) => {
    const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }) => {
      if (state === SyncState.Prepared) {
        client.off(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === SyncState.Error && isSessionGone(data?.error)) {
        client.off(ClientEvent.Sync, onSync);
        client.stopClient();
        reject(data?.error);
      }
    };
    client.on(ClientEvent.Sync, onSync);
    void client.startClient({ initialSyncLimit: 30 });
  });
}

const LOGOUT_WAIT_MS = 5000;

export async function logout(client: MatrixClient | null): Promise<void> {
  clearSession();
  if (!client) return;
  const deviceId = client.getDeviceId() ?? "";
  try {
    client.stopClient();
    // an unreachable server must not hold the button forever
    await Promise.race([client.logout(true), new Promise((r) => setTimeout(r, LOGOUT_WAIT_MS))]);
  } catch {
    // signed out locally even if the server did not answer
  }
  // the keys of a signed-out device are useless and must not be left behind
  await dropCryptoStore(deviceId);
}
