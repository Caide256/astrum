import { AutoDiscovery, ClientEvent, SyncState, createClient, type MatrixClient } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
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
};

const KEY = "app.session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.homeserver && s.accessToken && s.userId ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
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

/**
 * Create an account. Only the plain m.login.dummy stage is supported: captcha,
 * email and registration tokens are left to Element.
 */
export async function register(server: string, username: string, password: string): Promise<Session> {
  const homeserver = await discoverHomeserver(server);
  const tmp = createClient({ baseUrl: homeserver });
  const body = { username: cleanUsername(username), password, initial_device_display_name: BRAND.name };

  let res;
  try {
    res = await tmp.registerRequest(body);
  } catch (e) {
    const err = e as { httpStatus?: number; data?: { session?: string; flows?: { stages: string[] }[] } };
    if (err?.httpStatus !== 401 || !err.data?.flows) throw registerError(e);
    const simple = err.data.flows.some((f) => f.stages.every((st) => st === "m.login.dummy"));
    if (!simple) {
      throw new Error(t("session.err.needsCaptcha"));
    }
    try {
      res = await tmp.registerRequest({ ...body, auth: { type: "m.login.dummy", session: err.data.session } });
    } catch (e2) {
      throw registerError(e2);
    }
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
export async function start(client: MatrixClient): Promise<void> {
  // crypto must be ready before sync, or the first events arrive undecrypted
  await startCrypto(client, client.getDeviceId() ?? "");
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
