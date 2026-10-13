import { acceptCall, app, avatarMxc, declineCall, displayName, leaveVoice, ringAgain } from "../app.ts";
import { t } from "../i18n/index.ts";
import { useStore } from "../store.ts";
import { Avatar } from "./Avatar.tsx";
import { IconHangup, IconPhone } from "./icons.tsx";

/** A call ringing in from a direct chat: who calls, answer or decline. */
export function IncomingCall() {
  const ringing = useStore(app, (s) => s.ringing);
  if (!ringing) return null;
  const name = displayName(ringing.userId, ringing.roomId);
  return (
    <div className="incoming-call" role="alertdialog" aria-label={t("call.incoming", { name })}>
      <div className="incoming-avatar">
        <Avatar mxc={avatarMxc(ringing.userId, ringing.roomId)} name={name} size={56} />
      </div>
      <div className="incoming-text">
        <b className="ellipsis">{name}</b>
        <span>{t("call.incoming.hint")}</span>
      </div>
      <div className="incoming-buttons">
        <button className="incoming-decline" title={t("call.decline")} onClick={declineCall}>
          <IconHangup size={20} />
        </button>
        <button className="incoming-accept" title={t("call.accept")} onClick={() => void acceptCall()}>
          <IconPhone size={20} />
        </button>
      </div>
    </div>
  );
}

/** Over the call while the other person is being rung: ringing, declined or no answer. */
export function CallingBanner() {
  const calling = useStore(app, (s) => s.calling);
  const voiceChannel = useStore(app, (s) => s.voiceChannel);
  if (!calling || calling.roomId !== voiceChannel) return null;
  const name = displayName(calling.userId, calling.roomId);
  return (
    <div className={`calling-banner ${calling.status}`}>
      <Avatar mxc={avatarMxc(calling.userId, calling.roomId)} name={name} size={64} />
      <b>{calling.status === "ringing" ? t("call.ringing", { name }) : calling.status === "declined" ? t("call.declined") : t("call.missed")}</b>
      {calling.status === "ringing" ? (
        <div className="calling-dots" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      ) : (
        <div className="row">
          <button className="ghost" onClick={ringAgain}>
            <IconPhone /> {t("call.ringAgain")}
          </button>
          <button className="danger" onClick={() => void leaveVoice()}>
            <IconHangup /> {t("call.leave")}
          </button>
        </div>
      )}
    </div>
  );
}
