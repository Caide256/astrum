import raw from "../brand.json";

/**
 * Product name, logo and update source from brand.json. The file is read at
 * build time: Vite inlines it here, electron-builder takes the installer name,
 * app id and icon from it, and the main process reads its own copy packed
 * into the app. Changing it after the build has no effect.
 */

export type Brand = {
  name: string;
  appId: string;
  description: string;
  publisher: string;
  /** Path to a square PNG, 512x512 or larger, relative to the project root. */
  logo: string;
  /** GitHub "owner/repo" whose releases are checked for updates; empty disables updates. */
  updateRepo: string;
  /** Server prefilled on the sign-in screen. */
  defaultServer: string;
};

export const BRAND: Brand = {
  name: String(raw.name || "App"),
  appId: String(raw.appId || "app.matrix.client"),
  description: String(raw.description || ""),
  publisher: String(raw.publisher || raw.name || ""),
  logo: String(raw.logo || ""),
  updateRepo: String(raw.updateRepo || ""),
  defaultServer: String(raw.defaultServer || ""),
};

/** The logo as served next to the page (vite.config.ts copies it there). */
export const LOGO_URL = "./icon.png";
