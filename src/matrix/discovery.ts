import type { MatrixClient } from "matrix-js-sdk";

import { BRAND } from "../brand.ts";
import { t } from "../i18n/index.ts";

/**
 * "Add a server by domain".
 *
 * Matrix has no such concept, so the host describes its community in the
 * standard /.well-known/matrix/client under a key named after the app id
 * ("<appId>.server"). The spec requires that file to be served with
 * Access-Control-Allow-Origin: *, so the page can read it, unlike an
 * arbitrary file on the domain.
 *
 *   {
 *     "m.homeserver": { "base_url": "https://example.org" },
 *     "<appId>.server": {
 *       "alias": "#main:example.org",
 *       "name": "Our server",
 *       "description": "Chat and games",
 *       "icon": "mxc://example.org/abc"
 *     }
 *   }
 *
 * Without the key, common alias names are tried, and the product name too.
 */

export const WELL_KNOWN_KEY = `${BRAND.appId}.server`;

/** Alias names tried when the domain has no description. */
export const GUESSES = [...new Set(["main", "space", "community", "home", BRAND.name.toLowerCase().replace(/[^a-z0-9._=-]/g, "")])].filter(Boolean);

export type ServerCard = {
  domain: string;
  alias: string;
  name: string;
  description: string;
  icon: string | null;
  guessed: boolean;
};

function normalizeDomain(input: string): string {
  let raw = input.trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (raw.startsWith("#")) raw = raw.split(":").slice(1).join(":");
  if (!raw || raw.includes(" ")) throw new Error(t("discovery.err.notDomain"));
  return raw;
}

async function fetchWellKnown(domain: string): Promise<Record<string, any> | null> {
  const urls = [
    `https://${domain}/.well-known/matrix/client`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "GET", mode: "cors" });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data === "object") return data;
    } catch {
      // no file, no CORS or no domain: try the next one
    }
  }
  return null;
}

/**
 * Alias to room id through the own homeserver. Returns null when the alias
 * does not exist; throws a readable error when the answer says nothing about
 * the alias itself (federation closed, the other server is down).
 */
async function resolveAlias(client: MatrixClient, alias: string, domain: string): Promise<string | null> {
  try {
    const res = await client.getRoomIdForAlias(alias);
    return res.room_id;
  } catch (e) {
    const err = e as { errcode?: string; httpStatus?: number; data?: { error?: string }; message?: string };
    const status = Number(err?.httpStatus ?? 0);
    const text = String(err?.data?.error ?? err?.message ?? "");
    if (err?.errcode === "M_NOT_FOUND" || status === 404) return null;
    const own = client.getDomain() ?? "";
    if (err?.errcode === "M_FORBIDDEN" || status === 403 || /federat/i.test(text)) {
      throw new Error(t("discovery.err.federation", { own, domain }));
    }
    if (status >= 500) throw new Error(t("discovery.err.unreachable", { own, domain }));
    throw new Error(text || t("discovery.err.noAlias", { alias }));
  }
}

/** Domain to server card. Aliases are resolved through the own homeserver, no CORS involved. */
export async function lookupServer(client: MatrixClient, input: string): Promise<ServerCard> {
  const domain = normalizeDomain(input);

  // a full #name:domain address is looked up as is
  const typed = input.trim();
  if (/^#[^:\s]+:\S+$/.test(typed)) {
    if (!(await resolveAlias(client, typed, domain))) {
      throw new Error(t("discovery.err.noAlias", { alias: typed }));
    }
    return { domain, alias: typed, name: typed, description: "", icon: null, guessed: false };
  }
  const wk = await fetchWellKnown(domain);
  const entry = (wk?.[WELL_KNOWN_KEY] ?? wk?.server ?? null) as Record<string, any> | null;

  if (entry?.alias) {
    // the owner may have announced the address before creating it
    if (!(await resolveAlias(client, String(entry.alias), domain))) {
      throw new Error(t("discovery.err.aliasMissing", { domain, alias: String(entry.alias) }));
    }
    return {
      domain,
      alias: String(entry.alias),
      name: String(entry.name ?? domain),
      description: String(entry.description ?? ""),
      icon: entry.icon ? String(entry.icon) : null,
      guessed: false,
    };
  }

  for (const guess of GUESSES) {
    const alias = `#${guess}:${domain}`;
    // a closed federation or a dead server is reported at once, not as "nothing found"
    if (await resolveAlias(client, alias, domain)) {
      return { domain, alias, name: domain, description: "", icon: null, guessed: true };
    }
  }

  throw new Error(t("discovery.err.notFound", { domain, key: WELL_KNOWN_KEY }));
}

/**
 * A free address to suggest for a new server on the own homeserver: the one
 * its well-known announces if nobody took it yet (a fresh host points to an
 * address that does not exist), otherwise "main" if free. Friends then add
 * the server by the domain alone.
 */
export async function suggestAddress(client: MatrixClient): Promise<string> {
  const domain = client.getDomain() ?? "";
  if (!domain) return "";
  const free = async (localpart: string) => {
    try {
      return !(await resolveAlias(client, `#${localpart}:${domain}`, domain));
    } catch {
      return false;
    }
  };
  const wk = await fetchWellKnown(domain);
  const announced = /^#([^:]+):(.+)$/.exec(String((wk?.[WELL_KNOWN_KEY] as Record<string, unknown> | undefined)?.alias ?? ""));
  if (announced && announced[2] === domain && (await free(announced[1]))) return announced[1];
  return (await free("main")) ? "main" : "";
}

export async function joinServer(client: MatrixClient, card: ServerCard): Promise<string> {
  const room = await client.joinRoom(card.alias, { viaServers: [card.domain] });
  return room.roomId;
}

