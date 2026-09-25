import type { MatrixClient } from "matrix-js-sdk";
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  decodeRecoveryKey,
  type ShowSasCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { t } from "../i18n/index.ts";

/**
 * End-to-end encryption.
 *
 * Server channels are unencrypted, but Element creates direct chats
 * encrypted, and without crypto the client can neither read nor send there.
 * Crypto is therefore always started, and each room decides whether it needs
 * it.
 *
 * A new sign-in is a new device, and nobody shares old messages with it until
 * it is verified. The simplest way is the recovery key from Element: it opens
 * secret storage on the server, which holds the cross-signing keys (the
 * device becomes trusted) and the key backup (history gets decrypted).
 */

let pendingKey: Uint8Array | null = null;

/** createClient callback: the SDK asks for the storage key when it reads secrets. */
export const cryptoCallbacks = {
  getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }): Promise<[string, Uint8Array] | null> => {
    const keyId = Object.keys(keys)[0];
    if (!pendingKey || !keyId) return null;
    return [keyId, pendingKey];
  },
};

/** A key store per sign-in: otherwise the SDK complains about a foreign device after re-login. */
export function cryptoPrefix(deviceId: string): string {
  return `crypto-${deviceId}`;
}

export async function startCrypto(client: MatrixClient, deviceId: string): Promise<string> {
  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: cryptoPrefix(deviceId) });
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
};

export async function cryptoStatus(client: MatrixClient): Promise<CryptoStatus> {
  const crypto = client.getCrypto();
  if (!crypto) return { enabled: false, verified: false, secretStorage: false, backup: false };

  const userId = client.getUserId() ?? "";
  const deviceId = client.getDeviceId() ?? "";
  const [status, keyId, backup] = await Promise.all([
    crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null),
    client.secretStorage.getDefaultKeyId().catch(() => null),
    crypto.getKeyBackupInfo().catch(() => null),
  ]);

  return {
    enabled: true,
    verified: !!status?.crossSigningVerified,
    secretStorage: !!keyId,
    backup: !!backup,
  };
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
 * start the SAS exchange, so if Element has not started it a couple of
 * seconds after "ready", we do.
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

    if (!request.verifier) await until(() => !!request.verifier || ended(), 2500);
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

/** Ask another own device for verification. */
export async function startSelfVerification(client: MatrixClient, onUpdate: (v: SasView) => void): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error(t("crypto.err.noCrypto"));
  const request = await crypto.requestOwnUserVerification();
  await drive(client, request, false, onUpdate);
}

/**
 * Listen for verification requests from other own devices: Element offers to
 * verify a new sign-in by itself.
 */
export function listenVerification(client: MatrixClient, onUpdate: (v: SasView) => void): () => void {
  const handler = (request: VerificationRequest) => {
    if (!request.isSelfVerification || request.initiatedByMe) return;
    void drive(client, request, true, onUpdate);
  };
  client.on(CryptoEvent.VerificationRequestReceived as never, handler as never);
  return () => client.off(CryptoEvent.VerificationRequestReceived as never, handler as never);
}
