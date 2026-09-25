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

/** Domain to server card. Aliases are resolved through the own homeserver, no CORS involved. */
export async function lookupServer(client: MatrixClient, input: string): Promise<ServerCard> {
  const domain = normalizeDomain(input);

  // a full #name:domain address is looked up as is
  const typed = input.trim();
  if (/^#[^:\s]+:\S+$/.test(typed)) {
    try {
      await client.getRoomIdForAlias(typed);
    } catch {
      throw new Error(t("discovery.err.noAlias", { alias: typed }));
    }
    return { domain, alias: typed, name: typed, description: "", icon: null, guessed: false };
  }
  const wk = await fetchWellKnown(domain);
  const entry = (wk?.[WELL_KNOWN_KEY] ?? wk?.server ?? null) as Record<string, any> | null;

  if (entry?.alias) {
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
    try {
      await client.getRoomIdForAlias(alias);
      return { domain, alias, name: domain, description: "", icon: null, guessed: true };
    } catch {
      // no such alias, try the next
    }
  }

  throw new Error(t("discovery.err.notFound", { domain, key: WELL_KNOWN_KEY }));
}

export async function joinServer(client: MatrixClient, card: ServerCard): Promise<string> {
  const room = await client.joinRoom(card.alias, { viaServers: [card.domain] });
  return room.roomId;
}

