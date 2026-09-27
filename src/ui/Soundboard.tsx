import { useRef, useState } from "react";

import {
  addSound,
  app,
  callServerId,
  canEditSounds,
  openServerSettings,
  playSound,
  previewSound,
  removeSound,
  selectServer,
  serverSounds,
  type Sound,
} from "../app.ts";
import { t } from "../i18n/index.ts";
import { setSoundPrefs, useSoundPrefs } from "../prefs.ts";
import { useStore } from "../store.ts";
import { useEscape } from "./controls.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { IconClose, IconGear, IconMusic, IconPlay, IconSmile, IconTrash, IconVolume } from "./icons.tsx";

/**
 * The soundboard of the server the call is on. A sound plays for everyone in
 * the call who uses this app; each hears it at their own soundboard volume.
 */
function BoardPop({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const tick = useStore(app, (s) => s.tick);
  const prefs = useSoundPrefs();
  const spaceId = callServerId();
  const sounds = serverSounds(spaceId);
  const edit = canEditSounds(spaceId);
  useEscape(true, onClose);
  void tick;

  const width = 300;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left + anchor.width / 2 - width / 2));
  const bottom = Math.max(8, window.innerHeight - anchor.top + 8);

  return (
    <>
      <div className="head-pop-back" onMouseDown={onClose} />
      <div className="board-pop" style={{ left, bottom, width }}>
        <div className="head-pop-top">
          <b>
            <IconMusic /> {t("sounds.title")}
          </b>
          {edit && spaceId && (
            <button
              className="ghost icon tiny"
              title={t("sounds.manage")}
              onClick={() => {
                onClose();
                selectServer(spaceId);
                openServerSettings("sounds");
              }}
            >
              <IconGear />
            </button>
          )}
          <button className="ghost icon tiny" title={t("common.close")} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        {sounds.length ? (
          <div className="board-grid">
            {sounds.map((s) => (
              <button key={s.id} className="board-sound" title={s.name} onClick={() => playSound(s)}>
                <span className="board-emoji">{s.emoji || "🔊"}</span>
                <span className="ellipsis">{s.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="state pad">{edit ? t("sounds.emptyEdit") : t("sounds.empty")}</div>
        )}
        <label className="board-volume" title={t("sounds.volume")}>
          <IconVolume />
          <input type="range" min={0} max={100} step={1} value={prefs.board} onChange={(e) => setSoundPrefs({ board: Number(e.target.value) })} />
          <span>{prefs.board}%</span>
        </label>
      </div>
    </>
  );
}

/** The soundboard button of the call controls and of the voice dock. */
export function SoundboardButton({ className }: { className: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className={`${className} ${anchor ? "live" : ""}`}
        title={t("sounds.title")}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <IconMusic />
      </button>
      {anchor && <BoardPop anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

/* --------------------------------------------------------- server settings */

function SoundRow({ spaceId, sound, edit }: { spaceId: string; sound: Sound; edit: boolean }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="admin-item">
      <div className="admin-row">
        <span className="board-emoji">{sound.emoji || "🔊"}</span>
        <b className="grow ellipsis">{sound.name}</b>
        <button className="ghost icon small" title={t("sounds.preview")} onClick={() => previewSound(sound)}>
          <IconPlay />
        </button>
        {edit &&
          (asking ? (
            <>
              <button className="danger small" onClick={() => void removeSound(spaceId, sound.id)}>
                {t("common.delete")}
              </button>
              <button className="ghost small" onClick={() => setAsking(false)}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <button className="ghost icon small" title={t("common.delete")} onClick={() => setAsking(true)}>
              <IconTrash />
            </button>
          ))}
      </div>
    </div>
  );
}

export function SoundsTab({ spaceId }: { spaceId: string }) {
  const tick = useStore(app, (s) => s.tick);
  const busy = useStore(app, (s) => s.busy);
  const sounds = serverSounds(spaceId);
  const edit = canEditSounds(spaceId);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [pickAt, setPickAt] = useState<{ left: number; top: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  void tick;

  const add = async () => {
    if (!file) return;
    if (await addSound(spaceId, file, name, emoji)) {
      setFile(null);
      setName("");
      setEmoji("");
    }
  };

  return (
    <>
      <p className="sub">{t("sounds.intro")}</p>
      <div className="admin-list">
        {sounds.map((s) => (
          <SoundRow key={s.id} spaceId={spaceId} sound={s} edit={edit} />
        ))}
        {!sounds.length && <div className="state">{t("sounds.none")}</div>}
      </div>

      {edit ? (
        <>
          <div className="section-title">{t("sounds.add")}</div>
          <div className="sound-add">
            <button
              className="ghost emoji-pick-btn"
              title={t("sounds.emoji")}
              onClick={(ev) => {
                const r = ev.currentTarget.getBoundingClientRect();
                setPickAt({ left: Math.max(8, Math.min(window.innerWidth - 360, r.left)), top: Math.max(8, Math.min(window.innerHeight - 400, r.bottom + 6)) });
              }}
            >
              {emoji || <IconSmile />}
            </button>
            <input value={name} maxLength={32} placeholder={t("sounds.name")} onChange={(e) => setName(e.target.value)} />
            <button className="ghost" onClick={() => input.current?.click()}>
              {file ? <span className="ellipsis">{file.name}</span> : t("sounds.file")}
            </button>
            <button className="primary" disabled={!file || !!busy} onClick={() => void add()}>
              {t("sounds.addButton")}
            </button>
          </div>
          <span className="state">{t("sounds.limits")}</span>
          <input
            ref={input}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setFile(f);
            }}
          />
          {pickAt && (
            <EmojiPicker className="floating" style={{ left: pickAt.left, top: pickAt.top }} onPick={(e) => setEmoji(e)} onClose={() => setPickAt(null)} />
          )}
        </>
      ) : (
        <div className="note gap-top">{t("sounds.noRights")}</div>
      )}
    </>
  );
}
