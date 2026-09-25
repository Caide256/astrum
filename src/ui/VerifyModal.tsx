import { app } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";

/**
 * Emoji verification of this sign-in. Opens by itself when Element on another
 * device offers verification, or from the settings button.
 */
export function VerifyModal() {
  const sas = useStore(app, (s) => s.sas);
  if (!sas) return null;
  const close = () => app.set({ sas: null });

  return (
    <div className="modal-back" onClick={(e) => e.stopPropagation()}>
      <div className="modal verify">
        <h2>{t("verify.title")}</h2>

        {sas.phase === "waiting" && (
          <>
            <p className="sub">
              {sas.incoming ? t("verify.incoming") : t("verify.outgoing")}
            </p>
            <div className="spinner" />
            <div className="row">
              <button className="ghost" onClick={() => (sas.cancel(), close())}>
                {t("common.cancel")}
              </button>
            </div>
          </>
        )}

        {(sas.phase === "emoji" || sas.phase === "confirming") && (
          <>
            <p className="sub">{t("verify.compare")}</p>
            <div className="emoji-grid">
              {sas.emoji.map(([e, name], i) => (
                <div key={i} className="emoji-cell">
                  <span className="emoji">{e}</span>
                  <span className="state">{name}</span>
                </div>
              ))}
            </div>
            {sas.phase === "confirming" ? (
              <p className="sub">{t("verify.waiting")}</p>
            ) : (
              <div className="row">
                <button className="danger" onClick={() => sas.mismatch()}>
                  {t("verify.mismatch")}
                </button>
                <button className="primary" onClick={() => sas.confirm()}>
                  {t("verify.match")}
                </button>
              </div>
            )}
          </>
        )}

        {sas.phase === "done" && (
          <>
            <p className="sub">{sas.restored ? t("verify.doneRestored", { n: sas.restored }) : t("verify.done")}</p>
            <div className="row">
              <button className="primary" onClick={close}>
                {t("common.done")}
              </button>
            </div>
          </>
        )}

        {(sas.phase === "cancelled" || sas.phase === "error") && (
          <>
            <p className="sub">
              {sas.phase === "cancelled" ? t("verify.cancelled") : t("verify.failed", { error: sas.error })}
            </p>
            <div className="row">
              <button className="primary" onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
