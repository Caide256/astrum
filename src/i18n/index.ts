import { useSyncExternalStore } from "react";

import { BRAND } from "../brand.ts";
import { en, type Key } from "./en.ts";
import { ru } from "./ru.ts";

/**
 * Interface language.
 *
 * Dictionaries are flat maps from a key to a string. English is the reference:
 * `Key` is derived from it and the Russian dictionary must cover every key.
 * Placeholders look like {name}; {app} is always the product name from
 * brand.json. Plural forms are separated by "|" and picked with
 * Intl.PluralRules: two forms in English, three in Russian.
 */

export type { Key };
export type Lang = "en" | "ru";
export type Params = Record<string, string | number>;

export const LANGS: { id: Lang; name: string }[] = [
  { id: "ru", name: "Русский" },
  { id: "en", name: "English" },
];

const DICTS: Record<Lang, Record<Key, string>> = { en, ru };
const STORE_KEY = "app.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    // storage unavailable
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  return nav.startsWith("ru") || nav.startsWith("uk") || nav.startsWith("be") ? "ru" : "en";
}

let lang: Lang = detect();
let plural = new Intl.PluralRules(lang);
const listeners = new Set<() => void>();

if (typeof document !== "undefined") document.documentElement.lang = lang;

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  plural = new Intl.PluralRules(lang);
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    // kept until restart
  }
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

export function onLangChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}

function fill(text: string, params?: Params): string {
  const all: Params = { app: BRAND.name, ...params };
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in all ? String(all[name]) : whole));
}

export function t(key: Key, params?: Params): string {
  return fill(DICTS[lang][key] ?? en[key] ?? key, params);
}

/** Plural form for `n`; `{n}` is filled in automatically. */
export function tn(key: Key, n: number, params?: Params): string {
  const forms = (DICTS[lang][key] ?? en[key] ?? key).split("|");
  const cat = plural.select(n);
  const index = lang === "ru" ? ({ one: 0, few: 1, many: 2 } as Record<string, number>)[cat] ?? 1 : cat === "one" ? 0 : 1;
  return fill(forms[Math.min(index, forms.length - 1)], { n, ...params });
}

export function locale(): string {
  return lang === "ru" ? "ru-RU" : "en-US";
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

export function compareText(a: string, b: string): number {
  return a.localeCompare(b, locale());
}
