import type { MatrixClient } from "matrix-js-sdk";

import { t } from "./i18n/index.ts";
import { isMxc, safeMime } from "./mxc.ts";

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
/**
 * Downloaded files live in memory as blob URLs. Past this much the least
 * recently used are let go: the app stays open for days, and every picture
 * and clip seen would stay in memory otherwise.
 */
const KEEP_BYTES = 256 * 1024 * 1024;
/** The newest few stay whatever their size: one of them is likely on screen or playing. */
const KEEP_NEWEST = 8;
const sizes = new Map<string, number>();
let kept = 0;

function forget(key: string): void {
  const url = cache.get(key);
  if (url === undefined) return;
  cache.delete(key);
  kept -= sizes.get(key) ?? 0;
  sizes.delete(key);
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function remember(key: string, url: string, size: number): void {
  forget(key);
  cache.set(key, url);
  sizes.set(key, size);
  kept += size;
  // a Map keeps the order of insertion: the first keys are the ones used longest ago
  for (const k of cache.keys()) {
    if (kept <= KEEP_BYTES || cache.size <= KEEP_NEWEST) break;
    forget(k);
  }
}

/** A kept URL, moved to the end as just used. */
function recall(key: string): string {
  const url = cache.get(key);
  if (url === undefined) return "";
  cache.delete(key);
  cache.set(key, url);
  return url;
}
const inflight = new Map<string, Promise<string>>();
/** When a download last failed: tried again only after a pause, never remembered for good. */
const failedAt = new Map<string, number>();
const RETRY_MS = 15_000;

export function configureMedia(c: MatrixClient | null, accessToken: string): void {
  client = c;
  token = accessToken;
  for (const key of [...cache.keys()]) forget(key);
  inflight.clear();
  failedAt.clear();
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
  return recall(keyOf(mxc, size));
}

async function fetchBlob(http: string, authed: boolean): Promise<Blob | null> {
  try {
    const res = await fetch(http, authed ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (!res.ok) return null;
    const blob = new Blob([await res.arrayBuffer()], { type: safeMime(res.headers.get("content-type") ?? "") });
    return blob.size ? blob : null;
  } catch {
    return null;
  }
}

/**
 * Download with the token, then without it (older servers); a thumbnail the
 * server cannot make yet falls back to the file itself. A failure is not
 * remembered as a broken link: a picture whose first request failed (a
 * moment after upload, a network hiccup) loads on the next try.
 */
async function download(mxc: string, size: number): Promise<{ url: string; bytes: number } | null> {
  const tries: [number, boolean][] = size
    ? [
        [size, true],
        [size, false],
        [0, true],
        [0, false],
      ]
    : [
        [0, true],
        [0, false],
      ];
  for (const [sz, authed] of tries) {
    const http = httpOf(mxc, sz, authed);
    if (!http) continue;
    const blob = await fetchBlob(http, authed);
    if (blob) return { url: URL.createObjectURL(blob), bytes: blob.size };
  }
  return null;
}

export function mediaUrl(mxc: string, size = 0): Promise<string> {
  if (!isMxc(mxc) || !client) return Promise.resolve("");

  const key = keyOf(mxc, size);
  const ready = recall(key);
  if (ready) return Promise.resolve(ready);

  const running = inflight.get(key);
  if (running) return running;
  if ((failedAt.get(key) ?? 0) > Date.now() - RETRY_MS) return Promise.resolve("");

  const task = (async () => {
    try {
      const got = await download(mxc, size);
      if (got) {
        remember(key, got.url, got.bytes);
        failedAt.delete(key);
      } else {
        failedAt.set(key, Date.now());
      }
      return got?.url ?? "";
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
  if (!client || !isMxc(file?.url)) return Promise.resolve("");
  const key = `enc:${file.url}`;
  const ready = recall(key);
  if (ready) return Promise.resolve(ready);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      let res = await fetch(httpOf(file.url, 0, true), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) res = await fetch(httpOf(file.url, 0, false));
      if (!res.ok) throw new Error(String(res.status));
      const plain = await decryptAttachment(await res.arrayBuffer(), file);
      const url = URL.createObjectURL(new Blob([plain], { type: safeMime(mime || file.mimetype || "") }));
      remember(key, url, plain.byteLength);
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

/* --------------------------------------------------------- attachments */

/**
 * A whole attachment for the player: downloaded with progress, decrypted in
 * encrypted rooms, cached like other media. `onProgress` gets 0..1 while the
 * size is known.
 */
export function attachmentUrl(
  mxc: string,
  file: EncryptedFile | null,
  mime: string,
  onProgress?: (part: number) => void,
): Promise<string> {
  const url = file?.url ?? mxc;
  if (!client || !isMxc(url)) return Promise.resolve("");
  const key = file ? `enc:${file.url}` : mxc;
  const ready = recall(key);
  if (ready) return Promise.resolve(ready);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const get = async (authed: boolean): Promise<ArrayBuffer | null> => {
        const http = httpOf(url, 0, authed);
        if (!http) return null;
        const res = await fetch(http, authed ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (!res.ok || !res.body) return null;
        const total = Number(res.headers.get("content-length") ?? 0);
        const reader = res.body.getReader();
        const parts: Uint8Array[] = [];
        let have = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(value);
          have += value.byteLength;
          if (total) onProgress?.(Math.min(1, have / total));
        }
        const out = new Uint8Array(have);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.byteLength;
        }
        return out.buffer;
      };
      const data = (await get(true).catch(() => null)) ?? (await get(false).catch(() => null));
      if (!data) return "";
      const plain = file ? await decryptAttachment(data, file) : data;
      const blobUrl = URL.createObjectURL(new Blob([plain], { type: safeMime(mime || file?.mimetype || "") }));
      remember(key, blobUrl, plain.byteLength);
      return blobUrl;
    } catch {
      return "";
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** An attachment that is already downloaded, so the player starts without a spinner. */
export function peekAttachment(mxc: string, file: EncryptedFile | null): string {
  return recall(file ? `enc:${file.url}` : mxc);
}
