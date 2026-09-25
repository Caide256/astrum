import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { t } from "../i18n/index.ts";
import { IconEye, IconEyeOff } from "./icons.tsx";

/** A labeled switch; the whole row is clickable. */
export function Toggle({
  checked,
  onChange,
  title,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span className="toggle-text">
        <b>{title}</b>
        {hint && <span className="state">{hint}</span>}
      </span>
      <span className={`switch ${checked ? "on" : ""}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  );
}

const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * Password input with an eye button: an open eye while the text is hidden, a
 * crossed-out eye while it is shown. Hidden text gets a note about Caps Lock
 * and Cyrillic letters, the usual reasons a correct password is rejected.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete = "off",
  placeholder,
  autoFocus,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const [focused, setFocused] = useState(false);
  const readCaps = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState("CapsLock"));

  let note = "";
  if (!shown && focused && caps) note = t("common.capsLock");
  else if (!shown && CYRILLIC.test(value)) note = t("common.cyrillicPassword");

  return (
    <div className="pw-field">
      <div className="pw-box">
        <input
          type={shown ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            readCaps(e);
            onKeyDown?.(e);
          }}
          onKeyUp={readCaps}
          onMouseDown={(e) => setCaps(e.getModifierState("CapsLock"))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <button
          type="button"
          className="pw-eye"
          tabIndex={-1}
          aria-pressed={shown}
          title={shown ? t("common.hidePassword") : t("common.showPassword")}
          // keep the focus and the caret in the input
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown(!shown)}
        >
          {shown ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
      {note && <span className="pw-note">{note}</span>}
    </div>
  );
}

/**
 * Keep a closing window mounted a little longer so it can animate out. While
 * closing, the last value is returned: a profile card has no user anymore but
 * still has to be drawn.
 */
export function useLinger<T>(value: T | null | undefined | false, ms = 170): { shown: T | null; closing: boolean } {
  const [kept, setKept] = useState<T | null>(value ? value : null);

  useEffect(() => {
    if (value) {
      setKept(value);
      return;
    }
    const timer = window.setTimeout(() => setKept(null), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return { shown: value ? value : kept, closing: !value && kept !== null };
}

/* Escape closes the topmost open window only. */
const escapeStack: { current: () => void }[] = [];

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || !escapeStack.length) return;
    e.preventDefault();
    escapeStack[escapeStack.length - 1].current();
  });
}

export function useEscape(active: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    escapeStack.push(entry);
    return () => {
      const at = escapeStack.indexOf(entry);
      if (at >= 0) escapeStack.splice(at, 1);
    };
  }, [active]);
}
