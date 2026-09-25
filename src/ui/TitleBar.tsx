import { useEffect, useState } from "react";

import { BRAND, LOGO_URL } from "../brand.ts";
import { getWindowState, hasOwnFrame, onWindowState, windowAction, type WindowState } from "../desktop.ts";
import { t } from "../i18n/index.ts";
import { closeUpdateDialog, hasUpdater, installUpdate, openUpdateDialog, openUpdatePage, useUpdate } from "../update.ts";
import { useEscape, useLinger } from "./controls.tsx";
import { IconDownload, IconWinClose, IconWinMaximize, IconWinMinimize, IconWinRestore } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * The window has no system frame: this bar is its title and its buttons, in
 * the colors of the current theme. The empty part drags the window; a double
 * click maximizes it, as the system bar does. It is hidden in full screen.
 */

const INITIAL: WindowState = { frame: hasOwnFrame, maximized: false, fullscreen: false, focused: true };

export function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>(INITIAL);
  useEffect(() => {
    void getWindowState().then((s) => s && setState(s));
    return onWindowState(setState);
  }, []);
  return state;
}

function UpdateButton() {
  const { update } = useUpdate();
  if (!update || !["available", "downloading", "ready"].includes(update.status)) return null;
  const busy = update.status !== "available";
  return (
    <button
      className={`titlebar-update ${busy ? "busy" : ""}`}
      title={t("update.available", { version: update.version })}
      onClick={openUpdateDialog}
    >
      <IconDownload />
      <span>{busy ? `${Math.round(update.progress * 100)}%` : t("update.short")}</span>
    </button>
  );
}

export function TitleBar() {
  const win = useWindowState();

  useEffect(() => {
    document.documentElement.classList.toggle("own-frame", win.frame && !win.fullscreen);
  }, [win.frame, win.fullscreen]);

  if (!win.frame || win.fullscreen) return null;

  return (
    <header className={`titlebar ${win.focused ? "" : "blurred"}`}>
      <img className="titlebar-logo" src={LOGO_URL} alt="" draggable={false} />
      <span className="titlebar-name">{BRAND.name}</span>
      <div className="titlebar-fill" />
      {hasUpdater && <UpdateButton />}
      <div className="titlebar-buttons">
        <button className="tb-btn" title={t("window.minimize")} onClick={() => windowAction("minimize")}>
          <IconWinMinimize />
        </button>
        <button className="tb-btn" title={win.maximized ? t("window.restore") : t("window.maximize")} onClick={() => windowAction("maximize")}>
          {win.maximized ? <IconWinRestore /> : <IconWinMaximize />}
        </button>
        <button className="tb-btn close" title={t("window.close")} onClick={() => windowAction("close")}>
          <IconWinClose />
        </button>
      </div>
    </header>
  );
}

/* ----------------------------------------------------------- update dialog */

/**
 * A newer release exists: what is new, and one button to update. The portable
 * build and releases without an installer get a link to the release page.
 */
export function UpdateDialog({ beforeInstall }: { beforeInstall?: () => void }) {
  const { update, dialog } = useUpdate();
  const { shown, closing } = useLinger(dialog && !!update);
  useEscape(dialog, closeUpdateDialog);
  if (!shown || !update) return null;

  const downloading = update.status === "downloading" || update.status === "ready";
  const failed = update.status === "error";

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={closeUpdateDialog}>
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("update.title", { version: update.version })}</h2>
        <p className="sub">{t("update.current", { version: update.current })}</p>

        {update.notes && (
          <div className="update-notes">
            <Markdown text={update.notes} />
          </div>
        )}

        {downloading && (
          <div className="update-progress">
            <div className="upload-bar">
              <i style={{ width: `${Math.round(update.progress * 100)}%` }} />
            </div>
            <span className="state">{update.status === "ready" ? t("update.installing") : t("update.downloading", { n: Math.round(update.progress * 100) })}</span>
          </div>
        )}
        {failed && <div className="error">{t("update.failed", { error: update.error })}</div>}
        {!update.canInstall && !downloading && (
          <div className="note">{update.portable ? t("update.portable") : t("update.manual")}</div>
        )}

        <div className="row">
          <button className="ghost" onClick={closeUpdateDialog}>
            {t("update.later")}
          </button>
          {update.canInstall ? (
            <button
              className="primary"
              disabled={downloading}
              onClick={() => {
                beforeInstall?.();
                void installUpdate();
              }}
            >
              {failed ? t("update.retry") : t("update.install")}
            </button>
          ) : (
            <button className="primary" onClick={openUpdatePage}>
              {t("update.openPage")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
