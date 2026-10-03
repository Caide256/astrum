import type { MatrixClient } from "matrix-js-sdk";
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  decodeRecoveryKey,
  type GeneratedSecretStorageKey,
  type ShowSasCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth.js";
import { calculateKeyCheck, trimTrailingEquals } from "matrix-js-sdk/lib/secret-storage.js";

import { t } from "../i18n/index.ts";
import { NeedPassword } from "./people.ts";

/**
 * End-to-end encryption.
 *
 * Server channels are unencrypted, but Element creates direct chats
 * encrypted, and without crypto the client can neither read nor send there.
 * Crypto is therefore always started, and each room decides whether it needs
 * it.
 *
 * A new sign-in is a new device, and nobody shares old messages with it until
 * it is verified. The app handles the whole chain itself, no other client is
 * needed:
 *   - a fresh account gets cross-signing keys on the first sign-in, so that
 *     sign-in is verified at once;
 *   - a recovery key opens secret storage on the server, which holds the
 *     cross-signing keys (the device becomes trusted) and the key backup
 *     (history gets decrypted);
 *   - another verified sign-in, of this app or Element, confirms by emoji;
 *   - with nothing left, encryption is reset and set up again.
 */

let pendingKey: Uint8Array | null = null;

/** The key matches the stored key description (its check value), or there is nothing to check. */
async function keyFits(key: Uint8Array, info: { iv?: string; mac?: string } | undefined): Promise<boolean> {
  if (!info?.iv || !info.mac) return true;
  const { mac } = await calculateKeyCheck(key as Uint8Array<ArrayBuffer>, info.iv);
  return trimTrailingEquals(info.mac) === trimTrailingEquals(mac);
}

/**
 * createClient callback: the SDK asks for the storage key when it reads or
 * writes secrets. The key in hand is given only for the key it belongs to:
 * the SDK would otherwise encrypt with a wrong key without noticing.
 */
export const cryptoCallbacks = {
  getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }): Promise<[string, Uint8Array] | null> => {
    const key = pendingKey;
    if (!key) return null;
    for (const [keyId, info] of Object.entries(keys)) {
      if (await keyFits(key, info as { iv?: string; mac?: string })) return [keyId, key];
    }
    return null;
  },
};

/** A key store per sign-in: otherwise the SDK complains about a foreign device after re-login. */
export function cryptoPrefix(deviceId: string): string {
  return `crypto-${deviceId}`;
}

export async function startCrypto(client: MatrixClient, deviceId: string, storeKey?: string): Promise<string> {
  try {
    const key = storeKey && /^[0-9a-f]{64}$/.test(storeKey) ? new Uint8Array(storeKey.match(/../g)!.map((h) => parseInt(h, 16))) : undefined;
    await client.initRustCrypto({ cryptoDatabasePrefix: cryptoPrefix(deviceId), ...(key ? { storageKey: key } : {}) });
    return "";
  } catch (e) {
    // unencrypted rooms still work without crypto
    console.warn("crypto failed to start", e);
    return String((e as Error)?.message ?? e);
  }
}

/** Delete the key store of this sign-in. Used on sign-out. */
export async function dropCryptoStore(deviceId: string): Promise<void> {
  const prefixes = [cryptoPrefix(deviceId)];
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs
        .map((d) => d.name ?? "")
        .filter((name) => prefixes.some((p) => name.startsWith(p)))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    // leftovers stay in the profile, harmless
  }
}

export type CryptoStatus = {
  enabled: boolean;
  verified: boolean;
  secretStorage: boolean;
  backup: boolean;
  /** The account has cross-signing keys on the server at all. */
  crossSigning: boolean;
  /**
   * A new recovery key can be made without touching the account identity:
   * this device holds all cross-signing keys, or the account has none yet.
   * Otherwise only a full reset helps.
   */
  canMakeKey: boolean;
};

export const NO_CRYPTO: CryptoStatus = {
  enabled: false,
  verified: false,
  secretStorage: false,
  backup: false,
  crossSigning: false,
  canMakeKey: false,
};

export async function cryptoStatus(client: MatrixClient): Promise<CryptoStatus> {
  const crypto = client.getCrypto();
  if (!crypto) return NO_CRYPTO;

  const userId = client.getUserId() ?? "";
  const deviceId = client.getDeviceId() ?? "";
  const [status, keyId, backup, hasKeys, local] = await Promise.all([
    crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null),
    client.secretStorage.getDefaultKeyId().catch(() => null),
    crypto.getKeyBackupInfo().catch(() => null),
    crypto.userHasCrossSigningKeys(userId, true).catch(() => false),
    ownKeysHere(client),
  ]);

  return {
    enabled: true,
    verified: !!status?.crossSigningVerified,
    secretStorage: !!keyId,
    backup: !!backup,
    crossSigning: hasKeys,
    canMakeKey: !hasKeys || local,
  };
}

/** This device holds all three private cross-signing keys. */
async function ownKeysHere(client: MatrixClient): Promise<boolean> {
  const status = await client.getCrypto()?.getCrossSigningStatus().catch(() => null);
  const cached = status?.privateKeysCachedLocally;
  return !!(cached?.masterKey && cached.selfSigningKey && cached.userSigningKey);
}

/* ------------------------------------------------------- own setup, reset */

/**
 * Upload of cross-signing keys goes through user-interactive auth. Servers
 * let the very first upload through without it; replacing keys needs the
 * account password.
 */
function passwordAuth(client: MatrixClient, password: string): UIAuthCallback<void> {
  return async (makeRequest) => {
    let session: string | undefined;
    try {
      await makeRequest(null);
      return;
    } catch (e) {
      const err = e as { httpStatus?: number; data?: { session?: string; flows?: unknown } };
      if (err?.httpStatus !== 401 || !err.data?.flows) throw e;
      session = err.data.session;
    }
    if (!password) throw new NeedPassword();
    try {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: client.getUserId() ?? "" },
        password,
        session,
      } as never);
    } catch (e) {
      const err = e as { httpStatus?: number; errcode?: string; data?: { errcode?: string } };
      if (err?.httpStatus === 401 || err?.errcode === "M_FORBIDDEN" || err?.data?.errcode === "M_FORBIDDEN") {
        throw new Error(t("crypto.err.password"));
      }
      throw e;
    }
  };
}

/**
 * First sign-in of an account that never had encryption set up: create the
 * cross-signing keys and a key backup right away, so this sign-in is verified
 * and later ones can be confirmed from it. Does nothing if the account
 * already has keys or the server wants a password for the upload.
 */
export async function setupFreshAccount(client: MatrixClient): Promise<boolean> {
  const crypto = client.getCrypto();
  if (!crypto) return false;
  if (await crypto.userHasCrossSigningKeys(client.getUserId() ?? "", true)) return false;
  // explicitly new: keys left here by an earlier refused upload would otherwise never be sent
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: passwordAuth(client, ""), setupNewCrossSigning: true });
  if (!(await crypto.getKeyBackupInfo())) await crypto.resetKeyBackup();
  return true;
}

/** A new random recovery key. Nothing is stored until setupRecovery runs with it. */
export async function newRecoveryKey(client: MatrixClient): Promise<GeneratedSecretStorageKey> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error(t("crypto.err.noCrypto"));
  return crypto.createRecoveryKeyFromPassphrase();
}

/**
 * Put the recovery key in place: the key locks secret storage on the server,
 * which gets the cross-signing keys and the key backup key. With `reset`
 * everything is made from scratch first: new cross-signing keys, a new empty
 * backup, the old storage dropped. Other sign-ins then have to be verified
 * again, and old encrypted messages open only where they were already read.
 *
 * The password is needed only when the server asks for it (replacing
 * cross-signing keys); without it NeedPassword is thrown.
 */
export async function setupRecovery(
  client: MatrixClient,
  key: GeneratedSecretStorageKey,
  password: string,
  reset: boolean,
): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error(t("crypto.err.noCrypto"));
  const auth = passwordAuth(client, password);

  // the SDK asks for the new key through the callback while it stores secrets
  pendingKey = key.privateKey;
  try {
    if (reset) {
      await crypto.resetEncryption(auth);
      await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => key, setupNewSecretStorage: true });
    } else {
      // the account has no keys on the server yet: make them (the UI offers a reset
      // instead when the server has keys this device does not hold)
      if (!(await crypto.userHasCrossSigningKeys(client.getUserId() ?? "", true))) {
        await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: auth, setupNewCrossSigning: true });
      }
      // an old backup whose key is not here cannot be kept: start a new one
      const keepBackup = !!(await crypto.getKeyBackupInfo()) && !!(await crypto.getSessionBackupPrivateKey());
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => key,
        setupNewSecretStorage: true,
        setupNewKeyBackup: !keepBackup,
      });
    }
    await crypto.checkKeyBackupAndEnable().catch(() => null);
  } finally {
    pendingKey = null;
  }
}

/**
 * Verify this sign-in with the recovery key and restore history.
 * Returns the number of restored message keys.
 */
export async function unlockWithRecoveryKey(client: MatrixClient, recoveryKey: string): Promise<number> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error(t("crypto.err.noCrypto"));

  let key: Uint8Array;
  try {
    key = decodeRecoveryKey(recoveryKey.trim());
  } catch {
    throw new Error(t("crypto.err.notKey"));
  }

  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) {
    throw new Error(t("crypto.err.noStorage"));
  }
  const described = await client.secretStorage.getKey(keyId);
  if (described && !(await client.secretStorage.checkKey(key as Uint8Array<ArrayBuffer>, described[1] as never))) {
    throw new Error(t("crypto.err.wrongKey"));
  }

  pendingKey = key;
  try {
    // the cross-signing keys are in secret storage: the SDK fetches them and signs this device
    await crypto.bootstrapCrossSigning({});

    let restored = 0;
    if (await crypto.getKeyBackupInfo()) {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.checkKeyBackupAndEnable();
      const res = await crypto.restoreKeyBackup();
      restored = res.imported;
    }
    return restored;
  } finally {
    pendingKey = null;
  }
}

/* ---------------------------------------------------- emoji verification */

export type SasView = {
  phase: "waiting" | "emoji" | "confirming" | "done" | "cancelled" | "error";
  emoji: [string, string][];
  incoming: boolean;
  restored: number;
  error: string;
  confirm: () => void;
  mismatch: () => void;
  cancel: () => void;
};

const noop = () => undefined;

/**
 * Run emoji verification to the end: wait for the other side to accept, show
 * the emoji, wait for the comparison and restore history. Either side may
 * start the SAS exchange: the side that asked starts it right after "ready",
 * the accepting side starts it itself if nothing came in a couple of seconds.
 */
async function drive(
  client: MatrixClient,
  request: VerificationRequest,
  incoming: boolean,
  onUpdate: (v: SasView) => void,
): Promise<void> {
  const base = {
    emoji: [] as [string, string][],
    incoming,
    restored: 0,
    error: "",
    confirm: noop,
    mismatch: noop,
    cancel: () => void request.cancel().catch(noop),
  };
  onUpdate({ ...base, phase: "waiting" });

  const phaseIs = (...p: VerificationPhase[]) => p.includes(request.phase);
  const until = (ok: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (ok()) return resolve(true);
      const timer = window.setTimeout(() => {
        request.off(VerificationRequestEvent.Change, check);
        resolve(ok());
      }, ms);
      const check = () => {
        if (!ok()) return;
        window.clearTimeout(timer);
        request.off(VerificationRequestEvent.Change, check);
        resolve(true);
      };
      request.on(VerificationRequestEvent.Change, check);
    });

  try {
    if (incoming && phaseIs(VerificationPhase.Requested)) await request.accept();

    const ended = () => phaseIs(VerificationPhase.Cancelled, VerificationPhase.Done);
    await until(() => phaseIs(VerificationPhase.Ready, VerificationPhase.Started) || ended(), 5 * 60_000);
    if (phaseIs(VerificationPhase.Cancelled)) {
      onUpdate({ ...base, phase: "cancelled" });
      return;
    }

    // the side that asked starts the emoji exchange; the accepting side gives it a moment
    if (!request.verifier && incoming) await until(() => !!request.verifier || ended(), 2500);
    const verifier = request.verifier ?? (await request.startVerification("m.sas.v1"));

    verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
      onUpdate({
        ...base,
        phase: "emoji",
        emoji: sas.sas.emoji ?? [],
        confirm: () => {
          onUpdate({ ...base, phase: "confirming", emoji: sas.sas.emoji ?? [] });
          void sas.confirm();
        },
        mismatch: () => sas.mismatch(),
      });
    });
    await verifier.verify();

    // the other device sends the backup key on its own, a bit later
    let restored = 0;
    const crypto = client.getCrypto();
    for (let i = 0; i < 10 && crypto; i += 1) {
      await new Promise((r) => window.setTimeout(r, 1000));
      await crypto.checkKeyBackupAndEnable().catch(noop);
      if (await crypto.getSessionBackupPrivateKey().catch(() => null)) {
        restored = (await crypto.restoreKeyBackup().catch(() => ({ imported: 0 }))).imported;
        break;
      }
    }
    onUpdate({ ...base, phase: "done", restored });
  } catch (e) {
    onUpdate({ ...base, phase: phaseIs(VerificationPhase.Cancelled) ? "cancelled" : "error", error: String((e as Error)?.message ?? e) });
  }
}

/** Ask another own sign-in (this app or Element) for verification. */
export async function startSelfVerification(client: MatrixClient, onUpdate: (v: SasView) => void): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error(t("crypto.err.noCrypto"));
  const request = await crypto.requestOwnUserVerification();
  await drive(client, request, false, onUpdate);
}

/**
 * Listen for verification requests from other own sign-ins: a new sign-in asks
 * an existing one to confirm it.
 */
export function listenVerification(client: MatrixClient, onUpdate: (v: SasView) => void): () => void {
  const handler = (request: VerificationRequest) => {
    if (!request.isSelfVerification || request.initiatedByMe) return;
    void drive(client, request, true, onUpdate);
  };
  client.on(CryptoEvent.VerificationRequestReceived as never, handler as never);
  return () => client.off(CryptoEvent.VerificationRequestReceived as never, handler as never);
}
