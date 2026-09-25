import type { MatrixClient } from "matrix-js-sdk";

import { t } from "./i18n/index.ts";

/**
 * Media from the homeserver.
 *
 * Recent servers serve media only with a token, so an mxc link cannot go into
 * src directly: that yields 401 and an empty square. Media is downloaded with
 * authorization and handed out as a blob URL.
 */

let client: MatrixClient | null = null;
let token = "";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function configureMedia(c: MatrixClient | null, accessToken: string): void {
  client = c;
  token = accessToken;
  for (const url of cache.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  cache.clear();
  inflight.clear();
}

function keyOf(mxc: string, size: number): string {
  return size ? `${mxc}|${size}` : mxc;
}

function httpOf(mxc: string, size: number, authed: boolean): string {
  if (!client) return "";
  return size
    ? (client.mxcUrlToHttp(mxc, size, size, "crop", false, true, authed) ?? "")
    : (client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, authed) ?? "");
}

/** A ready URL if already downloaded, so placeholders do not flash. */
export function peekMedia(mxc: string, size = 0): string {
  if (!mxc) return "";
  return cache.get(keyOf(mxc, size)) ?? "";
}

export function mediaUrl(mxc: string, size = 0): Promise<string> {
  if (!mxc || !mxc.startsWith("mxc://") || !client) return Promise.resolve("");

  const key = keyOf(mxc, size);
  const ready = cache.get(key);
  if (ready) return Promise.resolve(ready);

  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const http = httpOf(mxc, size, true);
    if (!http) return "";
    try {
      const res = await fetch(http, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      cache.set(key, url);
      return url;
    } catch {
      // older servers serve media without authorization
      const legacy = httpOf(mxc, size, false);
      if (legacy) cache.set(key, legacy);
      return legacy;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/* ---------------------------------------------------- encrypted attachments */

/**
 * In an encrypted room the file is stored AES-CTR encrypted and the key
 * travels inside the (also encrypted) message, in the same format as Element.
 */
export type EncryptedFile = {
  url: string;
  key: { kty: string; k: string; alg?: string; ext?: boolean; key_ops?: string[] };
  iv: string;
  hashes: { sha256: string };
  v: string;
  mimetype?: string;
};

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptAttachment(
  plain: ArrayBuffer,
): Promise<{ data: ArrayBuffer; file: Omit<EncryptedFile, "url"> }> {
  const iv = new Uint8Array(16);
  // the high 8 bytes are random, the low 8 bytes are the counter starting at zero
  crypto.getRandomValues(iv.subarray(0, 8));
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return {
    data,
    file: {
      key: { kty: "oct", k: jwk.k ?? "", alg: "A256CTR", ext: true, key_ops: ["encrypt", "decrypt"] },
      iv: toB64(iv),
      hashes: { sha256: toB64(hash) },
      v: "v2",
    },
  };
}

export async function decryptAttachment(data: ArrayBuffer, file: EncryptedFile): Promise<ArrayBuffer> {
  const expected = (file.hashes?.sha256 ?? "").replace(/=+$/, "");
  const actual = toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  if (!expected || expected !== actual) throw new Error(t("media.err.corrupt"));
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "oct", k: file.key.k, alg: "A256CTR", ext: true, key_ops: ["encrypt", "decrypt"] },
    "AES-CTR",
    false,
    ["decrypt"],
  );
  // the oldest clients used the whole 128 bits as the counter
  const length = String(file.v).toLowerCase() === "v1" ? 128 : 64;
  return crypto.subtle.decrypt({ name: "AES-CTR", counter: fromB64(file.iv), length }, key, data);
}

/** Download and decrypt an attachment into a blob URL, cached like other media. */
export function encryptedMediaUrl(file: EncryptedFile, mime: string): Promise<string> {
  if (!client || !file?.url?.startsWith("mxc://")) return Promise.resolve("");
  const key = `enc:${file.url}`;
  const ready = cache.get(key);
  if (ready) return Promise.resolve(ready);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      let res = await fetch(httpOf(file.url, 0, true), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) res = await fetch(httpOf(file.url, 0, false));
      if (!res.ok) throw new Error(String(res.status));
      const plain = await decryptAttachment(await res.arrayBuffer(), file);
      const url = URL.createObjectURL(new Blob([plain], { type: mime || file.mimetype || "application/octet-stream" }));
      cache.set(key, url);
      return url;
    } catch {
      return "";
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
