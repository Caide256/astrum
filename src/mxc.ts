/**
 * Checks for media links and types that come from other people's messages,
 * state events and call packets.
 */

/** mxc://server/mediaId as the spec allows it; anything else could smuggle a path into the media URL. */
const MXC = /^mxc:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?\/[A-Za-z0-9_-]{1,255}$|^mxc:\/\/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?\/[A-Za-z0-9_-]{1,255}$/;

export function isMxc(value: unknown): value is string {
  return typeof value === "string" && MXC.test(value);
}

/**
 * The type a downloaded file is shown with. A blob URL belongs to the app's
 * own origin, so a file that claims to be a web page or a script is kept as
 * plain bytes: it can be saved, never rendered as a page.
 */
export function safeMime(type: string): string {
  const t = type.split(";")[0].trim().toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(t)) return t;
  if (/^(video|audio)\/[\w.+-]+$/.test(t)) return t;
  if (t === "text/plain" || t === "text/markdown" || t === "text/csv" || t === "application/json") return t;
  return "application/octet-stream";
}
