import { useState, type FormEvent, type ReactNode } from "react";

import { app, doLogin, doRegister } from "../app.ts";
import { BRAND, LOGO_URL } from "../brand.ts";
import { DEFAULT_SERVER } from "../config.ts";
import { LANGS, setLang, t, useLang, type Lang } from "../i18n/index.ts";
import { USERNAME_RULE, cleanUsername } from "../matrix/session.ts";
import { useStore } from "../store.ts";
import { PasswordInput } from "./controls.tsx";

type Mode = "login" | "register";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Login() {
  const busy = useStore(app, (s) => s.busy);
  const error = useStore(app, (s) => s.error);
  const lang = useLang();

  const [mode, setMode] = useState<Mode>("login");
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [user, setUser] = useState("");
  const [shownName, setShownName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

  const username = cleanUsername(user);
  const badName = mode === "register" && !!user && !USERNAME_RULE.test(username);
  const mismatch = mode === "register" && !!repeat && repeat !== password;
  const canSubmit =
    mode === "login"
      ? !!user && !!password
      : !!server && !!username && !badName && password.length >= 8 && password === repeat;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (mode === "login") void doLogin(server || user, user, password);
    else void doRegister(server, username, password, shownName);
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    app.set({ error: "" });
  };

  return (
    <div className="login">
      <select className="login-lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("settings.language")}>
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>

      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src={LOGO_URL} alt="" />
        <h1>{BRAND.name}</h1>
        <p className="sub">{t("login.tagline")}</p>

        <div className="seg login-tabs">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => switchTo("login")}>
            {t("login.tab.signIn")}
          </button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => switchTo("register")}>
            {t("login.tab.register")}
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <Field label={t("login.server")}>
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="example.org" autoComplete="url" />
        </Field>

        <Field label={mode === "login" ? t("login.user") : t("login.username")}>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={mode === "login" ? t("login.user.placeholder") : t("login.username.placeholder")}
            autoComplete="username"
          />
          {mode === "register" && user && (
            <span className={`state ${badName ? "bad" : ""}`}>
              {badName ? t("login.username.rule") : t("login.username.preview", { id: `@${username}:${server || t("login.server.some")}` })}
            </span>
          )}
        </Field>

        {mode === "register" && (
          <Field label={t("login.displayName")}>
            <input value={shownName} onChange={(e) => setShownName(e.target.value)} placeholder={t("login.displayName.placeholder")} />
          </Field>
        )}

        <Field label={t("login.password")}>
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </Field>
        {mode === "register" && (
          <>
            <Field label={t("login.passwordRepeat")}>
              <PasswordInput value={repeat} onChange={setRepeat} autoComplete="new-password" />
            </Field>
            {password && password.length < 8 && <p className="state bad">{t("login.password.short")}</p>}
            {mismatch && <p className="state bad">{t("common.passwordsDiffer")}</p>}
          </>
        )}

        <button className="primary wide-button" disabled={!!busy || !canSubmit}>
          {busy || (mode === "login" ? t("login.submit.signIn") : t("login.submit.register"))}
        </button>

        <p className="hint">{mode === "login" ? t("login.hint.signIn") : t("login.hint.register")}</p>
      </form>
    </div>
  );
}
