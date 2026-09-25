import { useSyncExternalStore } from "react";

import { setShellSettings } from "./desktop.ts";
import type { Key } from "./i18n/index.ts";

/**
 * Color themes.
 *
 * A theme is a handful of base colors, optionally with a gradient behind the
 * whole window. Every CSS variable is derived from them here and set on
 * <html>, so presets and the user's own theme work the same way. With a
 * gradient, panels become translucent (how much is `glass`) and floating
 * surfaces such as dialogs and menus stay solid (the --pop-* colors).
 */

export type ThemeColors = {
  /** Server bar and title bar, the darkest panel in dark themes. */
  bg0: string;
  /** Channel list and member list. */
  bg1: string;
  /** Chat. */
  bg2: string;
  /** Buttons and raised elements. */
  bg3: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
};

export type Gradient = { stops: string[]; angle: number };

export type ThemeDef = {
  id: string;
  name: Key | "";
  dark: boolean;
  colors: ThemeColors;
  gradient: Gradient | null;
  /** 0..1, gradient themes only: how much of the background shows through the panels. */
  glass: number;
};

export const CUSTOM = "custom";

const DARK: ThemeColors = {
  bg0: "#121317",
  bg1: "#191b21",
  bg2: "#21242c",
  bg3: "#2b2f39",
  line: "#31353f",
  text: "#e6e8ee",
  muted: "#8d93a1",
  accent: "#5b8cff",
};

const LIGHT: ThemeColors = {
  bg0: "#e3e5e9",
  bg1: "#f2f3f5",
  bg2: "#ffffff",
  bg3: "#dfe2e7",
  line: "#d3d7de",
  text: "#1c1f26",
  muted: "#5e6572",
  accent: "#3b6ef0",
};

function grad(id: string, name: Key, dark: boolean, stops: string[], angle: number, colors: Partial<ThemeColors>): ThemeDef {
  return { id, name, dark, colors: { ...(dark ? DARK : LIGHT), ...colors }, gradient: { stops, angle }, glass: 0.75 };
}

export const THEMES: ThemeDef[] = [
  { id: "dark", name: "theme.dark", dark: true, colors: DARK, gradient: null, glass: 0 },
  { id: "light", name: "theme.light", dark: false, colors: LIGHT, gradient: null, glass: 0 },
  {
    id: "midnight",
    name: "theme.midnight",
    dark: true,
    colors: { bg0: "#000000", bg1: "#0a0a0e", bg2: "#101016", bg3: "#1f1d29", line: "#27252f", text: "#ece9f5", muted: "#8f8ba2", accent: "#8f7bff" },
    gradient: null,
    glass: 0,
  },
  grad("aurora", "theme.aurora", true, ["#07322f", "#101a38", "#2f0c4d"], 135, {
    bg0: "#06110f", bg1: "#0a1716", bg2: "#0f1d1f", bg3: "#1d3a39", line: "#24403f", muted: "#8fb5ad", accent: "#3ddc97",
  }),
  grad("sunset", "theme.sunset", true, ["#2e0b27", "#6e1a3a", "#c4572a"], 150, {
    bg0: "#140610", bg1: "#1d0a15", bg2: "#260e1b", bg3: "#4a2230", line: "#522838", muted: "#caa0a8", accent: "#ffae5c",
  }),
  grad("ocean", "theme.ocean", true, ["#021327", "#063a61", "#0a6b80"], 160, {
    bg0: "#020b16", bg1: "#04111f", bg2: "#071a2c", bg3: "#15344b", line: "#1b3b52", muted: "#8fb1c6", accent: "#3cc7e8",
  }),
  grad("neon", "theme.neon", true, ["#12082b", "#2a0d55", "#0b3561"], 120, {
    bg0: "#08041a", bg1: "#0d0724", bg2: "#140b30", bg3: "#2a1d4f", line: "#33245c", muted: "#a898cf", accent: "#ff4fd8",
  }),
  grad("crimson", "theme.crimson", true, ["#140205", "#46080f", "#0e0103"], 170, {
    bg0: "#0a0102", bg1: "#120305", bg2: "#1a0508", bg3: "#3a1016", line: "#43141b", muted: "#c19398", accent: "#ff4d5e",
  }),
  grad("forest", "theme.forest", true, ["#07170e", "#12311f", "#2a4418"], 145, {
    bg0: "#040c07", bg1: "#07130c", bg2: "#0b1b11", bg3: "#1d3522", line: "#243e29", muted: "#9ab89f", accent: "#7ccf5c",
  }),
  grad("sakura", "theme.sakura", false, ["#fde4ea", "#f5c4d7", "#e4d2f6"], 135, {
    bg0: "#f7dce6", bg1: "#fdf1f5", bg2: "#ffffff", bg3: "#f0d4df", line: "#ebc9d6", text: "#2b1a22", muted: "#7a5a68", accent: "#d6457a",
  }),
  grad("mint", "theme.mint", false, ["#dcf9ee", "#c3ede2", "#d8e6ff"], 125, {
    bg0: "#d5f1e7", bg1: "#effbf6", bg2: "#ffffff", bg3: "#cfe9df", line: "#bfe0d4", text: "#14261f", muted: "#4f6f63", accent: "#1f9e7a",
  }),
];

/* ------------------------------------------------------------ color math */

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** `a` moved towards `b` by `k` (0..1). */
function mix(a: string, b: string, k: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

function alpha(color: string, a: number): string {
  const [r, g, b] = rgb(color);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function luminance(color: string): number {
  const lin = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function isHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v);
}

/* ---------------------------------------------------------------- tokens */

/** Every CSS variable of a theme. */
export function tokens(def: ThemeDef): Record<string, string> {
  const c = def.colors;
  const d = def.dark;
  const g = def.gradient && def.gradient.stops.length >= 2 ? def.gradient : null;
  const glass = g ? Math.max(0, Math.min(1, def.glass)) : 0;
  // the middle of the gradient tints the solid surfaces that float above it
  const middle = g ? g.stops[Math.floor(g.stops.length / 2)] : c.bg1;
  const panel = (color: string, share: number) => (g ? alpha(color, 1 - glass * share) : color);
  const solid = (color: string) => (g ? mix(color, middle, 0.18 * glass) : color);
  const black = "#000000";
  const white = "#ffffff";

  return {
    "--bg-0": panel(c.bg0, 0.55),
    "--bg-1": panel(c.bg1, 0.65),
    "--bg-2": panel(c.bg2, 0.75),
    "--bg-3": panel(c.bg3, 0.45),
    "--pop-1": solid(c.bg1),
    "--pop-2": solid(c.bg2),
    "--pop-3": solid(c.bg3),
    "--line": g ? alpha(c.line, 1 - glass * 0.35) : c.line,
    "--text": c.text,
    "--muted": c.muted,
    "--accent": c.accent,
    "--accent-hover": mix(c.accent, black, 0.12),
    "--on-accent": luminance(c.accent) > 0.36 ? mix(c.bg0, black, 0.5) : white,
    "--link": d ? mix(c.accent, white, 0.25) : mix(c.accent, black, 0.12),
    "--danger": d ? "#e2566a" : "#d63c50",
    "--danger-hover": d ? "#c9404f" : "#bd3245",
    "--danger-text": d ? "#ffb3bd" : "#b42336",
    "--ok": d ? "#46b97b" : "#24a05a",
    "--ok-hover": d ? "#3da56c" : "#1e8a4d",
    "--on-ok": d ? "#07130c" : white,
    "--warn": d ? "#f0b232" : "#b98000",
    "--away": "#f0b232",
    "--gold": d ? "#d8a657" : "#a8741a",
    "--live": "#ed4245",
    "--badge-admin": d ? "#ff8a8c" : "#c9303d",
    "--hover": d ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)",
    "--row-hover": d ? "rgba(255, 255, 255, 0.025)" : "rgba(0, 0, 0, 0.025)",
    "--shade": d ? "rgba(0, 0, 0, 0.16)" : "rgba(0, 0, 0, 0.035)",
    "--backdrop": d ? "rgba(8, 9, 12, 0.65)" : "rgba(24, 27, 34, 0.42)",
    "--backdrop-strong": d ? "rgba(8, 9, 12, 0.75)" : "rgba(24, 27, 34, 0.55)",
    "--shadow": d ? "rgba(0, 0, 0, 0.55)" : "rgba(20, 24, 32, 0.18)",
    "--call-bg": g ? (d ? "rgba(0, 0, 0, 0.42)" : "rgba(255, 255, 255, 0.3)") : d ? mix(c.bg0, black, 0.35) : mix(c.bg0, c.bg3, 0.4),
    "--call-line": g ? alpha(c.line, 0.6) : d ? mix(c.bg1, c.line, 0.3) : c.line,
    "--tile-bg": d ? mix(c.bg1, black, 0.15) : mix(c.bg3, black, 0.06),
    "--tile-offer": `linear-gradient(160deg, ${solid(c.bg2)}, ${solid(mix(c.bg0, d ? black : c.bg3, 0.2))})`,
    "--ctl-bg": solid(d ? mix(c.bg1, c.bg2, 0.3) : white),
    "--ctl-hover": solid(c.bg3),
    "--switch-off": d ? mix(c.muted, c.bg0, 0.45) : mix(c.muted, white, 0.45),
    "--app-bg": g ? `linear-gradient(${g.angle}deg, ${g.stops.join(", ")})` : c.bg0,
  };
}

/* ----------------------------------------------------------------- state */

const STORE_KEY = "app.theme";
const CUSTOM_KEY = "app.theme-custom";

function loadCustom(): ThemeDef {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "null") as Partial<ThemeDef> | null;
    if (raw && raw.colors) return sanitize(raw);
  } catch {
    // nothing stored
  }
  return { ...THEMES[0], id: CUSTOM, name: "" };
}

/** A custom theme from storage or from the account: only known fields, only colors. */
export function sanitize(raw: Partial<ThemeDef>): ThemeDef {
  const base = raw.dark === false ? LIGHT : DARK;
  const colors = { ...base };
  for (const k of Object.keys(base) as (keyof ThemeColors)[]) {
    const v = raw.colors?.[k];
    if (typeof v === "string" && isHex(v)) colors[k] = v;
  }
  const stops = (raw.gradient?.stops ?? []).filter((s) => typeof s === "string" && isHex(s)).slice(0, 3);
  const angle = Number(raw.gradient?.angle);
  return {
    id: CUSTOM,
    name: "",
    dark: raw.dark !== false,
    colors,
    gradient: stops.length >= 2 ? { stops, angle: Number.isFinite(angle) ? Math.round(angle) % 360 : 135 } : null,
    glass: Math.max(0, Math.min(1, Number(raw.glass ?? 0.75) || 0)),
  };
}

function load(): string {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === CUSTOM || THEMES.some((th) => th.id === saved)) return saved as string;
  } catch {
    // storage unavailable
  }
  return "dark";
}

let theme = load();
let custom = loadCustom();
const listeners = new Set<() => void>();

export function themeDef(id: string = theme): ThemeDef {
  if (id === CUSTOM) return custom;
  return THEMES.find((th) => th.id === id) ?? THEMES[0];
}

/** The color behind everything: the window shows it before the page loads. */
function baseColor(def: ThemeDef): string {
  return def.gradient ? def.gradient.stops[0] : def.colors.bg0;
}

function apply(): void {
  if (typeof document === "undefined") return;
  const def = themeDef();
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens(def))) root.style.setProperty(k, v);
  root.dataset.theme = def.id;
  root.style.colorScheme = def.dark ? "dark" : "light";
  root.classList.toggle("gradient", !!def.gradient);
}

apply();

function changed(): void {
  apply();
  void setShellSettings({ background: baseColor(themeDef()) });
  listeners.forEach((l) => l());
}

export function getTheme(): string {
  return theme;
}

export function setTheme(next: string): void {
  if (next === theme || (next !== CUSTOM && !THEMES.some((th) => th.id === next))) return;
  theme = next;
  try {
    localStorage.setItem(STORE_KEY, theme);
  } catch {
    // kept until restart
  }
  changed();
}

export function getCustomTheme(): ThemeDef {
  return custom;
}

/** Save the own theme and switch to it. */
export function setCustomTheme(next: Partial<ThemeDef>): void {
  custom = sanitize({ ...custom, ...next, colors: { ...custom.colors, ...next.colors } });
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  } catch {
    // kept until restart
  }
  if (theme !== CUSTOM) {
    theme = CUSTOM;
    try {
      localStorage.setItem(STORE_KEY, theme);
    } catch {
      // kept until restart
    }
  }
  changed();
}

/** The own theme from the account: stored, and shown if it is the current one. */
export function importCustomTheme(raw: Partial<ThemeDef>): void {
  const next = sanitize(raw);
  if (JSON.stringify(next) === JSON.stringify(custom)) return;
  custom = next;
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  } catch {
    // kept until restart
  }
  if (theme === CUSTOM) changed();
  else listeners.forEach((l) => l());
}

export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let version = 0;
onThemeChange(() => {
  version += 1;
});

/** The current theme id; re-renders on any change, the custom theme's colors included. */
export function useTheme(): string {
  useSyncExternalStore(onThemeChange, () => version, () => version);
  return theme;
}
