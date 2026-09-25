import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import { app, cancelCompose, editLastOwn, maxUpload, sendMessage, typingNow } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { FormatBar, applyFormat, formatForKey, type FormatId } from "./FormatBar.tsx";
import { IconClose, IconFile, IconFormat, IconPlus, IconSend, IconSmile } from "./icons.tsx";

/**
 * Message field.
 *
 * Enter sends, Shift+Enter inserts a line break. Attaching is not sending: a
 * file, a screenshot pasted with Ctrl+V or a dropped file becomes a card above
 * the field, gets an optional caption and is sent together with the text.
 * Each channel keeps its own draft; text drafts survive restarts.
 *
 * Text is Markdown. The format bar appears with the "Aa" button or on its own
 * while text is selected; Ctrl+B, I, U, E, K and Ctrl+Shift+X work in the field.
 */

type Draft = { text: string; files: File[] };

const drafts = new Map<string, Draft>();
const TEXT_DRAFTS_KEY = "app.drafts";
const MAX_TEXT_DRAFTS = 50;

function loadTextDrafts(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TEXT_DRAFTS_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveTextDraft(roomId: string, text: string): void {
  const all = loadTextDrafts();
  delete all[roomId];
  if (text.trim()) all[roomId] = text;
  // the newest drafts are kept, the oldest dropped
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TEXT_DRAFTS))) delete all[k];
  try {
    localStorage.setItem(TEXT_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
}

// drag and drop is caught by the whole chat; the cards live here
let addToTray: ((files: File[]) => void) | null = null;

export function attachFiles(files: File[]): void {
  addToTray?.(files);
}

export function humanSize(bytes: number): string {
  if (!bytes) return "";
  const units = t("size.units").split("|");
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Pasted screenshots are always named image.png; name them by time to tell them apart. */
function renamePasted(file: File): File {
  if (!/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = file.name.split(".").pop() ?? "png";
  return new File([file], `image-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

function Attachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState("");
  const image = file.type.startsWith("image/");

  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, image]);

  return (
    <div className="attach-card" title={file.name}>
      <div className="attach-thumb">{preview ? <img src={preview} alt="" /> : <IconFile size={34} />}</div>
      <div className="attach-name ellipsis">{file.name}</div>
      <div className="attach-size">{humanSize(file.size)}</div>
      <button type="button" className="attach-remove" title={t("composer.remove")} onClick={onRemove}>
        <IconClose />
      </button>
    </div>
  );
}

export function Composer({ roomId, title }: { roomId: string; title: string }) {
  const replyTo = useStore(app, (s) => s.replyTo);
  const editing = useStore(app, (s) => s.editing);
  const uploads = useStore(app, (s) => s.uploads);

  const [text, setText] = useState(() => drafts.get(roomId)?.text ?? loadTextDrafts()[roomId] ?? "");
  const [files, setFiles] = useState<File[]>(() => drafts.get(roomId)?.files ?? []);
  const [emoji, setEmoji] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // the selection to restore once React has written the new text into the field
  const pendingSel = useRef<[number, number] | null>(null);
  const current = useRef<Draft>({ text, files });
  current.current = { text, files };

  // the Composer is recreated per channel (key); on leave the draft stays with the channel
  const shownRoom = useRef(roomId);
  useEffect(
    () => () => {
      drafts.set(shownRoom.current, current.current);
      saveTextDraft(shownRoom.current, current.current.text);
    },
    [],
  );

  // also on window close, which does not unmount anything
  useEffect(() => {
    const flush = () => saveTextDraft(shownRoom.current, current.current.text);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  // the field grows with the text up to a third of the window
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
    const sel = pendingSel.current;
    if (sel) {
      pendingSel.current = null;
      el.focus();
      el.setSelectionRange(sel[0], sel[1]);
    }
  }, [text]);

  useEffect(() => {
    if (editing) {
      setText(editing.body);
      field.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo) field.current?.focus();
  }, [replyTo, roomId]);

  const add = async (list: File[]) => {
    if (!list.length) return;
    const limit = await maxUpload();
    const ok: File[] = [];
    for (const f of list) {
      if (limit && f.size > limit) {
        app.set({ error: t("composer.err.tooBig", { name: f.name, size: humanSize(f.size), limit: humanSize(limit) }) });
        continue;
      }
      ok.push(renamePasted(f));
    }
    if (ok.length) setFiles((prev) => [...prev, ...ok].slice(0, 10));
    field.current?.focus();
  };

  useEffect(() => {
    addToTray = (list) => void add(list);
    return () => {
      addToTray = null;
    };
  });

  // typing while focus is elsewhere goes into the message; Ctrl+V pastes a screenshot as an attachment
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || isEditable(document.activeElement)) return;
      if (document.querySelector(".modal-back, .emoji-picker")) return;
      const paste = (e.ctrlKey || e.metaKey) && e.code === "KeyV";
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (paste || printable) field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const canSend = editing ? !!text.trim() : !!text.trim() || files.length > 0;

  const submit = () => {
    if (!canSend) return;
    const body = text;
    const sending = editing ? [] : files;
    setText("");
    if (!editing) setFiles([]);
    setEmoji(false);
    drafts.delete(roomId);
    saveTextDraft(roomId, "");
    void sendMessage(body, sending);
  };

  const format = (id: FormatId) => {
    const el = field.current;
    const s = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = applyFormat(id, text, s, end);
    pendingSel.current = [next.start, next.end];
    setText(next.text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // while an IME composes a word, Enter confirms the word
    if (e.nativeEvent.isComposing) return;
    const shortcut = formatForKey(e);
    if (shortcut) {
      e.preventDefault();
      format(shortcut);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp" && !text && !editing) {
      if (editLastOwn()) e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (replyTo || editing) {
        e.preventDefault();
        cancelCompose();
        if (editing) setText("");
      } else if (emoji) {
        e.preventDefault();
        setEmoji(false);
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const list = Array.from(e.clipboardData.files);
    if (!list.length) return;
    e.preventDefault();
    void add(list);
  };

  const insert = (value: string) => {
    const el = field.current;
    if (!el) {
      setText((prev) => prev + value);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    pendingSel.current = [start + value.length, start + value.length];
    setText(next);
  };

  return (
    <div className="composer-wrap">
      {uploads.length > 0 && (
        <div className="uploads">
          {uploads.map((u) => (
            <div key={u.id} className="upload-row">
              <span className="ellipsis">{t("composer.uploading", { name: u.name })}</span>
              <div className="upload-bar">
                <i style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
              <b>{Math.round(u.progress * 100)}%</b>
            </div>
          ))}
        </div>
      )}

      <div className={`composer-box ${replyTo || editing ? "with-bar" : ""}`}>
        {(replyTo || editing) && (
          <div className="compose-bar">
            {editing ? (
              <span className="ellipsis">{t("composer.editing")}</span>
            ) : (
              <span className="ellipsis">
                {t("composer.replyTo")} <b>{replyTo?.senderName}</b>: {replyTo?.body}
              </span>
            )}
            <button
              type="button"
              className="ghost icon small"
              title={t("common.cancel")}
              onClick={() => {
                cancelCompose();
                if (editing) setText("");
              }}
            >
              <IconClose />
            </button>
          </div>
        )}

        {files.length > 0 && !editing && (
          <div
            className="attach-tray"
            onWheel={(e) => {
              // the wheel scrolls the cards sideways
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {files.map((f, i) => (
              <Attachment key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}

        {(formatOpen || selected) && <FormatBar onFormat={format} />}

        <div className="composer">
          <button
            type="button"
            className="composer-tool attach"
            title={t("composer.attach")}
            disabled={!!editing}
            onClick={() => fileInput.current?.click()}
          >
            <IconPlus size={18} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <textarea
            ref={field}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              typingNow(!!e.target.value);
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onSelect={(e) => setSelected(e.currentTarget.selectionEnd > e.currentTarget.selectionStart)}
            onBlur={() => setSelected(false)}
            placeholder={
              editing ? t("composer.placeholder.edit") : files.length ? t("composer.placeholder.caption") : t("composer.placeholder", { name: title })
            }
          />
          <button
            type="button"
            className={`composer-tool ${formatOpen ? "on" : ""}`}
            title={t("format.toggle")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFormatOpen(!formatOpen)}
          >
            <IconFormat size={18} />
          </button>
          <button type="button" className={`composer-tool ${emoji ? "on" : ""}`} title={t("composer.emoji")} onClick={() => setEmoji(!emoji)}>
            <IconSmile size={20} />
          </button>
          {canSend && (
            <button type="button" className="composer-send" title={t("composer.send")} onClick={submit}>
              <IconSend size={17} />
            </button>
          )}
          {emoji && <EmojiPicker className="above" onPick={insert} onClose={() => setEmoji(false)} />}
        </div>
      </div>
    </div>
  );
}
