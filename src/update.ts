import { useSyncExternalStore } from "react";

import {
  checkUpdate,
  getUpdate,
  hasUpdater,
  installUpdateNow,
  onUpdate,
  openUpdatePage,
  startUpdate,
  type UpdateState,
} from "./desktop.ts";
import type { Lang } from "./i18n/index.ts";

/**
 * Update state for the page. The main process checks GitHub releases
 * (electron/updater.cjs); a newer version opens a dialog once per launch and
 * the title bar keeps a button for it. After consent the installer is
 * downloaded; once it is verified the call is left and the installer runs.
 */

type Store = { update: UpdateState | null; dialog: boolean };

let store: Store = { update: null, dialog: false };
const listeners = new Set<() => void>();
// the dialog opens by itself once per version and launch
let offered = "";
let consented = false;
let beforeInstall: () => Promise<void> = async () => undefined;

function set(patch: Partial<Store>): void {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
}

function take(u: UpdateState | null): void {
  if (!u) return;
  const fresh = u.status === "available" && !!u.version && offered !== u.version;
  if (fresh) offered = u.version;
  set({ update: u, dialog: store.dialog || fresh });
  if (u.status === "ready" && consented) {
    consented = false;
    void beforeInstall()
      .catch(() => undefined)
      .finally(installUpdateNow);
  }
}

if (hasUpdater) {
  onUpdate(take);
  void getUpdate().then(take);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const read = () => store;

export function useUpdate(): Store {
  return useSyncExternalStore(subscribe, read, read);
}

/** What to do right before the installer closes the app: leave the voice channel. */
export function setBeforeInstall(cb: () => Promise<void>): void {
  beforeInstall = cb;
}

export function openUpdateDialog(): void {
  set({ dialog: true });
}

export function closeUpdateDialog(): void {
  set({ dialog: false });
}

export async function checkNow(): Promise<void> {
  take(await checkUpdate());
}

/**
 * Release notes in the app's language. A release description holds one
 * collapsible section per language, as GitHub shows them:
 *
 *   <details><summary>English</summary> ... </details>
 *   <details><summary>Русский</summary> ... </details>
 *
 * The section of the current language is shown, English if there is none,
 * the first section otherwise; text outside the sections (a common line on
 * top) goes first. Notes without sections are shown as they are.
 */
export function localNotes(notes: string, lang: Lang): string {
  const text = notes.replace(/<!--[\s\S]*?-->/g, "");
  const sections = [...text.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)].map((m) => ({
    title: m[1].replace(/<[^>]+>/g, "").trim().toLowerCase(),
    body: m[2].trim(),
  }));
  if (!sections.length) return text.trim();
  const english = (s: string) => /english|англ|^en\b/.test(s);
  const russian = (s: string) => /рус|russian|^ru\b/.test(s);
  const pick = sections.find((s) => (lang === "ru" ? russian(s.title) : english(s.title))) ?? sections.find((s) => english(s.title)) ?? sections[0];
  const intro = text.replace(/<details\b[\s\S]*?<\/details>/gi, "").trim();
  return [intro, pick.body].filter(Boolean).join("\n\n");
}

/** Download, verify, then install on its own. */
export async function installUpdate(): Promise<void> {
  consented = true;
  take(await startUpdate());
}

export { hasUpdater, openUpdatePage };
