import { useEffect, useState, type ReactNode } from "react";

import { abandonSession, app, bootstrap } from "./app.ts";
import { BRAND, LOGO_URL } from "./brand.ts";
import { t, useLang } from "./i18n/index.ts";
import { useStore } from "./store.ts";
import { Login } from "./ui/Login.tsx";
import { Main } from "./ui/Main.tsx";
import { TitleBar, UpdateDialog } from "./ui/TitleBar.tsx";

export function App() {
  const phase = useStore(app, (s) => s.phase);
  // a language change re-renders the whole tree from here
  useLang();

  useEffect(() => {
    void bootstrap();
  }, []);

  let screen: ReactNode;
  if (phase === "login") screen = <Login />;
  else if (phase === "loading") screen = <Loading />;
  else screen = <Main />;

  return (
    <>
      <TitleBar />
      <div className="app-body">{screen}</div>
      <UpdateDialog />
    </>
  );
}

/** First sync. A failed start keeps the stored session and offers a retry. */
function Loading() {
  const error = useStore(app, (s) => s.error);
  const offline = useStore(app, (s) => s.offline);
  const [leaving, setLeaving] = useState(false);

  return (
    <div className="login">
      <div className="login-card">
        <img className={error ? "login-logo" : "login-logo pulse"} src={LOGO_URL} alt="" />
        <h1>{BRAND.name}</h1>
        {error ? (
          <>
            <div className="error">{error}</div>
            <div className="row">
              <button
                className="ghost"
                disabled={leaving}
                onClick={() => {
                  setLeaving(true);
                  void abandonSession().finally(() => setLeaving(false));
                }}
              >
                {t("profile.logout")}
              </button>
              <button className="primary" disabled={leaving} onClick={() => void bootstrap()}>
                {t("app.retry")}
              </button>
            </div>
          </>
        ) : (
          <p className="sub">{offline ? t("app.offline") : t("app.syncing")}</p>
        )}
      </div>
    </div>
  );
}
