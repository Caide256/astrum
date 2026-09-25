import { BRAND } from "./brand.ts";

/**
 * Build-time settings. The server prefilled on the sign-in screen comes from
 * VITE_DEFAULT_SERVER in .env, or from "defaultServer" in brand.json.
 */
export const DEFAULT_SERVER: string =
  (import.meta.env.VITE_DEFAULT_SERVER as string | undefined)?.trim() || BRAND.defaultServer;
