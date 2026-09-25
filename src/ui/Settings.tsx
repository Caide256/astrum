import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  NeedPassword,
  app,
  changePassword,
  muteLabel,
  doLogout,
  encryptionStatus,
  endSession,
  renameSession,
  saveMyAvatar,
  saveMyName,
  sessions,
  startVerification,
  verifyWithRecoveryKey,
  type SettingsTab,
} from "../app.ts";
import { getShellSettings, hasShell, setShellSettings, type ShellSettings } from "../desktop.ts";
import {
  ACTIONS,
  actionName,
  busyCombos,
  comboProblem,
  comboWarning,
  getBindings,
  nativeHotkeys,
  newBindingId,
  pauseHotkeys,
  prettyCombo,
  recordCombo,
  setBindings,
  type Binding,
  type HotAction,
} from "../hotkeys.ts";
import { LANGS, fmtDateTime, setLang, t, useLang, type Key, type Lang } from "../i18n/index.ts";
import type { CryptoStatus } from "../matrix/crypto.ts";
import type { SessionRow } from "../matrix/people.ts";
import {
  setMuted,
  setNotifyMode,
  setSoundPrefs,
  useMutes,
  useNotifyMode,
  useSoundPrefs,
  type Mutes,
  type NotifyMode,
} from "../prefs.ts";
import { useStore } from "../store.ts";
import {
  CUSTOM,
  THEMES,
  getCustomTheme,
  isHex,
  setCustomTheme,
  setTheme,
  tokens,
  useTheme,
  type ThemeColors,
  type ThemeDef,
} from "../theme.ts";
import { checkNow, hasUpdater, openUpdateDialog, useUpdate } from "../update.ts";
import {
  DENOISE_LIST,
  blip,
  dbToUnit,
  openMic,
  startMicTest,
  type Blip,
  type Denoise,
  type MicChain,
  type MicState,
  type MicTest,
} from "../voice/audio.ts";
import { voice, type DeviceInfo, type InputMode, type Limiter } from "../voice/voice.ts";
import { Avatar } from "./Avatar.tsx";
import { Cropper } from "./Cropper.tsx";
import { PasswordInput, Toggle, useEscape, useLinger } from "./controls.tsx";
import { IconBellOff, IconLogout, IconPalette, IconRefresh, IconTrash } from "./icons.tsx";

type MeterSource = { get: () => MicState; on: (cb: (s: MicState) => void) => () => void };

/**
 * Microphone level with the threshold, like Discord's input sensitivity. The
 * bar is green while sound passes the gate and grey while it is muted. It is
 * updated through the DOM: re-rendering React twenty times a second for one
 * bar is not worth it.
 */
function Meter({
  source,
  auto,
  threshold,
  onThreshold,
}: {
  source: MeterSource | null;
  auto: boolean;
  threshold: number;
  onThreshold: (db: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const apply = (s: MicState) => {
      if (bar.current) {
        bar.current.style.width = `${dbToUnit(s.db) * 100}%`;
        bar.current.classList.toggle("open", s.open);
      }
      if (auto && mark.current) mark.current.style.left = `${dbToUnit(s.threshold) * 100}%`;
    };
    if (!source) {
      apply({ db: -120, open: false, threshold });
      return;
    }
    apply(source.get());
    return source.on(apply);
  }, [source, auto, threshold]);

  return (
    <div className={`meter ${source ? "" : "idle"}`}>
      <div className="meter-track">
        <div className="meter-bar" ref={bar} />
        <div className={`meter-mark ${auto ? "auto" : ""}`} ref={mark} style={{ left: `${dbToUnit(threshold) * 100}%` }} />
        {!auto && (
          <input
            className="meter-range"
            type="range"
            min={-80}
            max={0}
            step={1}
            value={threshold}
            onChange={(e) => onThreshold(Number(e.target.value))}
            title={t("audio.thresholdDb", { db: threshold })}
          />
        )}
      </div>
    </div>
  );
}

function Picker({ label, value, list, onPick }: { label: string; value: string; list: DeviceInfo[]; onPick: (id: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="">{t("audio.systemDefault")}</option>
        {list.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Seg<T extends string>({ value, list, onPick, className = "" }: { value: T; list: { id: T; name: Key }[]; onPick: (id: T) => void; className?: string }) {
  return (
    <div className={`seg ${className}`}>
      {list.map((o) => (
        <button key={o.id} className={value === o.id ? "on" : ""} onClick={() => onPick(o.id)}>
          {t(o.name)}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ profile */

function ProfileTab() {
  const myName = useStore(app, (s) => s.myName);
  const myAvatar = useStore(app, (s) => s.myAvatar);
  const sess = useStore(app, (s) => s.session);
  const [name, setName] = useState(myName);
  const [crop, setCrop] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [again, setAgain] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => setName(myName), [myName]);

  const mismatch = !!again && newPw !== again;
  const savePassword = async () => {
    setPwBusy(true);
    setPwErr("");
    setPwMsg("");
    try {
      await changePassword(oldPw, newPw);
      setPwMsg(t("profile.passwordChanged"));
      setOldPw("");
      setNewPw("");
      setAgain("");
    } catch (e) {
      setPwErr((e as Error)?.message ?? String(e));
    }
    setPwBusy(false);
  };

  return (
    <>
      <div className="profile-top">
        <Avatar mxc={myAvatar} name={myName || "?"} size={72} />
        <div className="profile-id">
          <b className="ellipsis">{myName}</b>
          <div className="state ellipsis">{sess?.userId}</div>
          <div className="row left tight-top">
            <button className="ghost small" onClick={() => file.current?.click()}>
              {t("profile.changePicture")}
            </button>
            {myAvatar && (
              <button className="ghost small" onClick={() => void saveMyAvatar(null)}>
                {t("profile.removePicture")}
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setCrop(f);
          e.target.value = "";
        }}
      />
      {crop && (
        <Cropper
          file={crop}
          onCancel={() => setCrop(null)}
          onDone={(f) => {
            setCrop(null);
            void saveMyAvatar(f);
          }}
        />
      )}

      <div className="field">
        <label>{t("login.displayName")}</label>
        <div className="with-button">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim() || name === myName} onClick={() => void saveMyName(name)}>
            {t("common.save")}
          </button>
        </div>
        <span className="state">{t("profile.nameHint")}</span>
      </div>

      <div className="section-title">{t("profile.password")}</div>
      <div className="field">
        <PasswordInput autoComplete="current-password" placeholder={t("profile.currentPassword")} value={oldPw} onChange={setOldPw} />
      </div>
      <div className="field two">
        <PasswordInput autoComplete="new-password" placeholder={t("profile.newPassword")} value={newPw} onChange={setNewPw} />
        <PasswordInput autoComplete="new-password" placeholder={t("profile.repeatPassword")} value={again} onChange={setAgain} />
      </div>
      {mismatch && <div className="state danger-text">{t("common.passwordsDiffer")}</div>}
      {pwErr && <div className="error">{pwErr}</div>}
      {pwMsg && <div className="note good">{pwMsg}</div>}
      <div className="row left">
        <button className="primary" disabled={!oldPw || !newPw || newPw !== again || pwBusy} onClick={() => void savePassword()}>
          {pwBusy ? t("profile.changingPassword") : t("profile.changePassword")}
        </button>
      </div>

      <div className="section-title">{t("profile.account")}</div>
      {leaving ? (
        <div className="row left">
          <span className="state">{t("profile.logoutConfirm")}</span>
          <button className="danger" onClick={() => (app.set({ settingsOpen: false }), void doLogout())}>
            {t("profile.logoutYes")}
          </button>
          <button className="ghost" onClick={() => setLeaving(false)}>
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <button className="danger" onClick={() => setLeaving(true)}>
          <IconLogout /> {t("profile.logout")}
        </button>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- audio */

const SAMPLE_SOUNDS: { id: Blip; name: Key }[] = [
  { id: "mute", name: "audio.sound.mute" },
  { id: "deafen", name: "audio.sound.deafen" },
  { id: "join", name: "audio.sound.join" },
  { id: "userJoin", name: "audio.sound.userJoin" },
  { id: "userLeave", name: "audio.sound.userLeave" },
  { id: "streamStart", name: "audio.sound.stream" },
  { id: "viewerJoin", name: "audio.sound.viewer" },
];

const LIMITER_LIST: { id: Limiter; name: Key }[] = [
  { id: "off", name: "audio.limiter.off" },
  { id: "soft", name: "audio.limiter.soft" },
  { id: "medium", name: "audio.limiter.medium" },
  { id: "hard", name: "audio.limiter.hard" },
];

const INPUT_MODES: { id: InputMode; name: Key }[] = [
  { id: "voice", name: "audio.mode.voice" },
  { id: "ptt", name: "audio.mode.ptt" },
];

/** A labeled 0..100 slider. */
function Volume({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className={`field volume-field ${disabled ? "off" : ""}`}>
      <label>
        {label} <b>{value}%</b>
      </label>
      <input type="range" min={0} max={100} step={1} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function AudioTab() {
  const state = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
  const { settings, devices } = state;
  const sounds = useSoundPrefs();
  const [test, setTest] = useState<MicTest | null>(null);
  const [raw, setRaw] = useState(false);
  const [testErr, setTestErr] = useState("");
  const [idle, setIdle] = useState<MicChain | null>(null);
  const testRef = useRef<MicTest | null>(null);
  const ptt = settings.inputMode === "ptt";
  const pttKeys = getBindings().filter((b) => b.action === "ptt" && b.combo);

  const stopTest = async () => {
    const running = testRef.current;
    testRef.current = null;
    setTest(null);
    await running?.stop();
    await voice.holdForTest(false);
  };

  const runTest = async (withoutDenoise: boolean) => {
    const running = testRef.current;
    testRef.current = null;
    await running?.stop();
    setTestErr("");
    try {
      // the call must not hear the test, and the test must not be drowned by the call
      await voice.holdForTest(true);
      const started = await startMicTest(voice.micOptions(withoutDenoise ? { denoise: "off" } : {}), voice.getState().settings.spkId);
      testRef.current = started;
      setTest(started);
    } catch (e) {
      await voice.holdForTest(false);
      setTest(null);
      setTestErr((e as Error)?.message ?? String(e));
    }
  };

  // the tab or the window closed: stop listening to yourself
  useEffect(
    () => () => {
      void testRef.current?.stop();
      testRef.current = null;
      void voice.holdForTest(false);
    },
    [],
  );

  // device or suppressor changed during the test: rebuild it
  const testing = !!test;
  useEffect(() => {
    if (testing) void runTest(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.micId, settings.spkId, settings.denoise, settings.echo, settings.gain]);

  // outside a call and without the test the level still shows: a silent chain feeds the meter
  const needIdle = !state.connected && !testing;
  useEffect(() => {
    if (!needIdle) return;
    let alive = true;
    let chain: MicChain | null = null;
    void openMic({ ...voice.micOptions(), ptt: false })
      .then((c) => {
        if (!alive) {
          void c.close();
          return;
        }
        chain = c;
        setIdle(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      setIdle(null);
      void chain?.close();
    };
  }, [needIdle, settings.micId, settings.denoise, settings.echo, settings.gain]);

  const source: MeterSource | null = test
    ? { get: test.chain.state, on: test.chain.onState }
    : state.connected
      ? { get: voice.meter, on: voice.onMeter }
      : idle
        ? { get: idle.state, on: idle.onState }
        : null;

  const setSensitivity = (auto: boolean, threshold: number) => {
    void voice.applySettings({ autoSensitivity: auto, threshold });
    test?.chain.setSensitivity(auto, threshold);
    idle?.setSensitivity(auto, threshold);
  };

  const addPttKey = () => {
    app.set({ settingsTab: "keys" });
    pendingPtt = true;
  };

  return (
    <>
      <div className="section-title">{t("audio.devices")}</div>
      <div className="two">
        <Picker label={t("audio.mic")} value={settings.micId} list={devices.mics} onPick={(id) => void voice.applySettings({ micId: id })} />
        <Picker label={t("audio.output")} value={settings.spkId} list={devices.speakers} onPick={(id) => void voice.applySettings({ spkId: id })} />
      </div>

      <div className="section-title">{t("audio.test")}</div>
      <div className="mic-test">
        {test ? (
          <>
            <button className="danger" onClick={() => void stopTest()}>
              {t("audio.test.stop")}
            </button>
            <div className="seg">
              <button className={!raw ? "on" : ""} onClick={() => (setRaw(false), void runTest(false))}>
                {t("audio.test.processed")}
              </button>
              <button className={raw ? "on" : ""} onClick={() => (setRaw(true), void runTest(true))}>
                {t("audio.test.raw")}
              </button>
            </div>
          </>
        ) : (
          <button className="primary" onClick={() => (setRaw(false), void runTest(false))}>
            {t("audio.test.start")}
          </button>
        )}
        <span className="state">{test ? t("audio.test.headphones") : t("audio.test.hint")}</span>
      </div>
      {test && state.connected && <div className="note gap-top">{t("audio.test.held")}</div>}
      {testErr && <div className="error">{testErr}</div>}

      <div className="section-title">{t("audio.mode")}</div>
      <Seg value={settings.inputMode} list={INPUT_MODES} onPick={(id) => void voice.applySettings({ inputMode: id })} />
      {ptt && (
        <>
          <div className={`note ${pttKeys.length ? "" : "warn"} gap-top`}>
            {pttKeys.length ? t("audio.ptt.keys", { keys: pttKeys.map((b) => prettyCombo(b.combo)).join(", ") }) : t("audio.ptt.noKey")}{" "}
            <button className="link" onClick={addPttKey}>
              {pttKeys.length ? t("audio.ptt.addAnother") : t("audio.ptt.add")}
            </button>
          </div>
          <div className="field gap-top">
            <label>{t("audio.ptt.delay", { ms: settings.pttDelay })}</label>
            <input
              type="range"
              min={0}
              max={1000}
              step={20}
              value={settings.pttDelay}
              onChange={(e) => void voice.applySettings({ pttDelay: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      <div className="section-title">{t("audio.sensitivity")}</div>
      <label className="check">
        <input type="checkbox" checked={settings.autoSensitivity} onChange={() => setSensitivity(!settings.autoSensitivity, settings.threshold)} />
        <span>{t("audio.sensitivity.auto")}</span>
      </label>
      <Meter source={source} auto={settings.autoSensitivity} threshold={settings.threshold} onThreshold={(db) => setSensitivity(false, db)} />
      <span className="state">
        {source
          ? settings.autoSensitivity
            ? t("audio.sensitivity.autoHint")
            : t("audio.sensitivity.manualHint", { db: settings.threshold })
          : t("audio.sensitivity.idle")}
      </span>

      <div className="section-title">{t("audio.denoise")}</div>
      <div className="choices compact">
        {DENOISE_LIST.map((d) => (
          <button
            key={d.id}
            className={`choice ${settings.denoise === d.id ? "on" : ""}`}
            onClick={() => void voice.applySettings({ denoise: d.id as Denoise })}
          >
            <b>{t(d.name)}</b>
            <span className="state">{t(d.hint)}</span>
          </button>
        ))}
      </div>

      <div className="section-title">{t("audio.limiter")}</div>
      <Seg className="limiter-seg" value={settings.limiter} list={LIMITER_LIST} onPick={(id) => void voice.applySettings({ limiter: id })} />
      <span className="state">{settings.limiter === "off" ? t("audio.limiter.offHint") : t("audio.limiter.hint")}</span>

      <div className="section-title">{t("audio.processing")}</div>
      <label className="check">
        <input type="checkbox" checked={settings.echo} onChange={() => void voice.applySettings({ echo: !settings.echo })} />
        <span>{t("audio.echo")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.gain} onChange={() => void voice.applySettings({ gain: !settings.gain })} />
        <span>{t("audio.gain")}</span>
      </label>

      <div className="section-title">{t("audio.soundsTitle")}</div>
      <label className="check">
        <input type="checkbox" checked={settings.sounds} onChange={() => void voice.applySettings({ sounds: !settings.sounds })} />
        <span>{t("audio.sounds")}</span>
      </label>
      <Volume label={t("audio.soundsVolume")} value={sounds.ui} disabled={!settings.sounds} onChange={(v) => setSoundPrefs({ ui: v })} />
      <div className="chips">
        {SAMPLE_SOUNDS.map((s) => (
          <button key={s.id} className="ghost small" onClick={() => blip(s.id, settings.spkId)}>
            {t(s.name)}
          </button>
        ))}
        <button className="ghost small" onClick={() => void voice.unlockDevices()}>
          <IconRefresh /> {t("audio.refreshDevices")}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ hotkeys */
/** Set by the audio tab: open the hotkeys tab with a new push-to-talk binding. */
let pendingPtt = false;

function KeysTab() {
  const [list, setList] = useState<Binding[]>(() => getBindings());
  const [recording, setRecording] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string[]>(() => busyCombos());
  const native = nativeHotkeys();

  const save = (next: Binding[]) => {
    setList(next);
    void setBindings(next).then(setBusy);
  };

  const add = (action: HotAction = "mute") => {
    const b: Binding = { id: newBindingId(), action, combo: "" };
    save([...list, b]);
    setRecording(b.id);
    setErr("");
  };

  useEffect(() => {
    if (!pendingPtt) return;
    pendingPtt = false;
    add("ptt");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recording) return;
    void pauseHotkeys(true);
    const stop = recordCombo(
      (combo) => {
        const problem = comboProblem(combo);
        if (problem) {
          setErr(problem);
          return;
        }
        const clash = list.find((b) => b.combo === combo && b.id !== recording);
        if (clash) {
          setErr(t("keys.taken", { combo: prettyCombo(combo), action: actionName(clash.action) }));
          return;
        }
        save(list.map((b) => (b.id === recording ? { ...b, combo } : b)));
        setRecording(null);
        setErr("");
      },
      () => {
        // cancelled without a combo: an empty row is not kept
        const cur = list.find((b) => b.id === recording);
        if (cur && !cur.combo) save(list.filter((b) => b.id !== recording));
        setRecording(null);
        setErr("");
      },
    );
    return () => {
      stop();
      void pauseHotkeys(false).then(setBusy);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, list]);

  return (
    <>
      <p className="sub">{native ? t("keys.intro.native") : t("keys.intro.fallback")}</p>

      {list.length === 0 && <div className="note">{t("keys.empty")}</div>}

      <div className="keys">
        {list.map((b) => {
          const warning = b.combo && recording !== b.id ? comboWarning(b.combo) : "";
          return (
            <div className="key-block" key={b.id}>
              <div className="key-row">
                <select value={b.action} onChange={(e) => save(list.map((x) => (x.id === b.id ? { ...x, action: e.target.value as HotAction } : x)))}>
                  {ACTIONS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {t(a.name)}
                    </option>
                  ))}
                </select>
                <button
                  className={`combo ${recording === b.id ? "on" : ""} ${busy.includes(b.combo) ? "busy" : ""}`}
                  title={busy.includes(b.combo) ? t("keys.busyOne") : t("keys.change")}
                  onClick={() => setRecording(b.id)}
                >
                  {recording === b.id ? t("keys.recording") : b.combo ? prettyCombo(b.combo) : t("keys.notSet")}
                </button>
                <button className="ghost icon" title={t("common.delete")} onClick={() => save(list.filter((x) => x.id !== b.id))}>
                  <IconTrash />
                </button>
              </div>
              {warning && <div className="state key-warn">{warning}</div>}
            </div>
          );
        })}
      </div>

      {err && <div className="error">{err}</div>}
      {busy.length > 0 && !err && <div className="note">{t("keys.busy", { combos: busy.map(prettyCombo).join(", ") })}</div>}

      <div className="row left">
        <button className="primary" onClick={() => add()} disabled={!!recording}>
          {t("keys.add")}
        </button>
      </div>
    </>
  );
}


/* --------------------------------------------------------------- appearance */

function ThemePreview({ def }: { def: ThemeDef }) {
  const tk = tokens(def);
  return (
    <span className="theme-preview" style={{ background: tk["--app-bg"] }}>
      <i style={{ background: tk["--bg-0"] }} />
      <span style={{ background: tk["--bg-2"] }}>
        <b style={{ background: def.colors.accent }} />
        <em style={{ background: def.colors.text }} />
        <em style={{ background: def.colors.muted, width: "46%" }} />
      </span>
    </span>
  );
}

const COLOR_FIELDS: { id: keyof ThemeColors; name: Key }[] = [
  { id: "accent", name: "theme.color.accent" },
  { id: "text", name: "theme.color.text" },
  { id: "muted", name: "theme.color.muted" },
  { id: "bg0", name: "theme.color.bg0" },
  { id: "bg1", name: "theme.color.bg1" },
  { id: "bg2", name: "theme.color.bg2" },
  { id: "bg3", name: "theme.color.bg3" },
  { id: "line", name: "theme.color.line" },
];

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="color-row">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="grow">{label}</span>
      <input
        className="color-hex"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.value.trim();
          if (isHex(v)) onChange(v.toLowerCase());
        }}
      />
    </label>
  );
}

/** The own theme: base colors, an optional gradient and how translucent the panels are over it. */
function ThemeEditor() {
  useTheme();
  const def = getCustomTheme();
  const g = def.gradient;
  const set = (patch: Partial<ThemeDef>) => setCustomTheme(patch);

  const fromPreset = (id: string) => {
    const base = THEMES.find((th) => th.id === id);
    if (base) set({ dark: base.dark, colors: { ...base.colors }, gradient: base.gradient ? { ...base.gradient, stops: [...base.gradient.stops] } : null, glass: base.glass || 0.75 });
  };

  return (
    <div className="theme-editor">
      <div className="row left">
        <Seg
          value={def.dark ? "dark" : "light"}
          list={[
            { id: "dark", name: "theme.base.dark" },
            { id: "light", name: "theme.base.light" },
          ]}
          onPick={(id) => fromPreset(id)}
        />
        <select className="push-right theme-from" value="" onChange={(e) => e.target.value && fromPreset(e.target.value)}>
          <option value="">{t("theme.startFrom")}</option>
          {THEMES.map((th) => (
            <option key={th.id} value={th.id}>
              {th.name ? t(th.name) : th.id}
            </option>
          ))}
        </select>
      </div>

      <div className="color-grid">
        {COLOR_FIELDS.map((f) => (
          <ColorInput key={f.id} label={t(f.name)} value={def.colors[f.id]} onChange={(v) => set({ colors: { ...def.colors, [f.id]: v } })} />
        ))}
      </div>

      <Toggle
        checked={!!g}
        onChange={(on) =>
          set({ gradient: on ? { stops: [def.colors.accent, def.colors.bg0], angle: 135 } : null, glass: def.glass || 0.75 })
        }
        title={t("theme.gradient")}
        hint={t("theme.gradient.hint")}
      />
      {g && (
        <>
          <div className="gradient-stops">
            {g.stops.map((stop, i) => (
              <ColorInput
                key={i}
                label={t("theme.gradient.stop", { n: i + 1 })}
                value={stop}
                onChange={(v) => set({ gradient: { ...g, stops: g.stops.map((x, j) => (j === i ? v : x)) } })}
              />
            ))}
            <div className="row left">
              {g.stops.length < 3 ? (
                <button className="ghost small" onClick={() => set({ gradient: { ...g, stops: [...g.stops, def.colors.bg1] } })}>
                  {t("theme.gradient.addStop")}
                </button>
              ) : (
                <button className="ghost small" onClick={() => set({ gradient: { ...g, stops: g.stops.slice(0, 2) } })}>
                  {t("theme.gradient.removeStop")}
                </button>
              )}
            </div>
          </div>
          <div className="field">
            <label>{t("theme.gradient.angle", { deg: g.angle })}</label>
            <input type="range" min={0} max={359} step={1} value={g.angle} onChange={(e) => set({ gradient: { ...g, angle: Number(e.target.value) } })} />
          </div>
          <div className="field">
            <label>{t("theme.glass", { n: Math.round(def.glass * 100) })}</label>
            <input type="range" min={0} max={100} step={1} value={Math.round(def.glass * 100)} onChange={(e) => set({ glass: Number(e.target.value) / 100 })} />
          </div>
        </>
      )}
    </div>
  );
}

function AppearanceTab() {
  const theme = useTheme();
  const lang = useLang();
  const custom = getCustomTheme();

  return (
    <>
      <div className="section-title">{t("appearance.theme")}</div>
      <div className="themes">
        {THEMES.map((th) => (
          <button key={th.id} className={`theme-card ${theme === th.id ? "on" : ""}`} onClick={() => setTheme(th.id)}>
            <ThemePreview def={th} />
            <span className="theme-name">{th.name ? t(th.name) : th.id}</span>
          </button>
        ))}
        <button className={`theme-card ${theme === CUSTOM ? "on" : ""}`} onClick={() => setTheme(CUSTOM)}>
          <ThemePreview def={custom} />
          <span className="theme-name">
            <IconPalette /> {t("theme.custom")}
          </span>
        </button>
      </div>

      {theme === CUSTOM && (
        <>
          <div className="section-title">{t("theme.editor")}</div>
          <ThemeEditor />
        </>
      )}

      <div className="section-title">{t("settings.language")}</div>
      <div className="field narrow">
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <span className="state">{t("appearance.synced")}</span>
    </>
  );
}

/* -------------------------------------------------------------- application */

const NOTIFY_MODES: { id: NotifyMode; name: Key }[] = [
  { id: "all", name: "app.notify.all" },
  { id: "mentions", name: "app.notify.mentions" },
  { id: "off", name: "app.notify.off" },
];

const MUTE_KINDS: { kind: keyof Mutes; name: Key }[] = [
  { kind: "servers", name: "mutes.servers" },
  { kind: "rooms", name: "mutes.rooms" },
  { kind: "users", name: "mutes.users" },
];

function MutedList() {
  const mutes = useMutes();
  const total = mutes.rooms.length + mutes.servers.length + mutes.users.length;
  if (!total) return <span className="state">{t("mutes.none")}</span>;
  return (
    <div className="muted-list">
      {MUTE_KINDS.map(({ kind, name }) =>
        mutes[kind].length ? (
          <div key={kind}>
            <div className="state">{t(name)}</div>
            {mutes[kind].map((id) => (
              <div key={id} className="muted-row">
                <IconBellOff />
                <span className="grow ellipsis">{muteLabel(kind, id)}</span>
                <button className="ghost small" onClick={() => setMuted(kind, id, false)}>
                  {t("mutes.unmute")}
                </button>
              </div>
            ))}
          </div>
        ) : null,
      )}
    </div>
  );
}

function UpdatesSection() {
  const { update } = useUpdate();
  const [checking, setChecking] = useState(false);
  if (!hasUpdater || !update) return null;

  const status =
    update.status === "checking" || checking
      ? t("updates.checking")
      : update.status === "latest"
        ? t("updates.latest")
        : update.status === "available" || update.status === "downloading" || update.status === "ready"
          ? t("update.available", { version: update.version })
          : update.status === "error"
            ? t("update.failed", { error: update.error })
            : "";

  return (
    <>
      <div className="section-title">{t("updates.title")}</div>
      <div className="row left">
        <span className="state">{t("updates.version", { version: update.current })}</span>
        {update.enabled ? (
          <button
            className="ghost small push-right"
            disabled={checking || update.status === "downloading"}
            onClick={() => {
              setChecking(true);
              void checkNow().finally(() => setChecking(false));
            }}
          >
            <IconRefresh /> {t("updates.check")}
          </button>
        ) : null}
        {(update.status === "available" || update.status === "downloading" || update.status === "ready") && (
          <button className="primary small" onClick={openUpdateDialog}>
            {t("update.short")}
          </button>
        )}
      </div>
      {update.enabled ? status && <span className="state">{status}</span> : <span className="state">{t("updates.disabled")}</span>}
    </>
  );
}

function AppTab() {
  const [shell, setShell] = useState<ShellSettings | null>(null);
  const notify = useNotifyMode();
  const sounds = useSoundPrefs();
  const spk = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState).settings.spkId;

  useEffect(() => {
    void getShellSettings().then(setShell);
  }, []);

  const set = (patch: Partial<ShellSettings>) => {
    if (!shell) return;
    // the switch reacts at once, the shell catches up
    setShell({ ...shell, ...patch });
    void setShellSettings(patch).then((next) => next && setShell(next));
  };

  return (
    <>
      <div className="section-title">{t("app.notifications")}</div>
      <Seg value={notify} list={NOTIFY_MODES} onPick={setNotifyMode} />
      <span className="state">{t("app.notify.hint")}</span>

      <Toggle
        checked={sounds.notifyOn}
        onChange={(on) => setSoundPrefs({ notifyOn: on })}
        title={t("app.notifySound")}
        hint={t("app.notifySound.hint")}
      />
      <div className="row left volume-row">
        <Volume label={t("app.notifyVolume")} value={sounds.notify} disabled={!sounds.notifyOn} onChange={(v) => setSoundPrefs({ notify: v })} />
        <button className="ghost small" disabled={!sounds.notifyOn} onClick={() => blip("message", spk)}>
          {t("app.notifyTry")}
        </button>
        <button className="ghost small" disabled={!sounds.notifyOn} onClick={() => blip("mention", spk)}>
          {t("app.mentionTry")}
        </button>
      </div>

      <div className="section-title">{t("mutes.title")}</div>
      <span className="state">{t("mutes.hint")}</span>
      <MutedList />

      {!hasShell && <div className="note gap-top">{t("app.onlyDesktop")}</div>}
      {hasShell && !shell && <div className="state gap-top">{t("common.loading")}</div>}
      {shell && (
        <>
          <div className="section-title">{t("app.window")}</div>
          <Toggle
            checked={shell.closeToTray}
            onChange={(v) => set({ closeToTray: v })}
            title={t("app.closeToTray")}
            hint={t("app.closeToTray.hint")}
          />

          <div className="section-title">{t("app.startup")}</div>
          <Toggle
            checked={shell.autostart}
            disabled={!shell.autostartAvailable}
            onChange={(v) => set({ autostart: v })}
            title={t("app.autostart")}
            hint={shell.autostartAvailable ? t("app.autostart.hint") : t("app.autostart.unavailable")}
          />
          {shell.autostart && <div className="note gap-top">{t("app.autostart.portable")}</div>}
        </>
      )}

      <UpdatesSection />
    </>
  );
}

/* --------------------------------------------------------------- encryption */

function CryptoTab() {
  const sas = useStore(app, (s) => s.sas);
  const [st, setSt] = useState<CryptoStatus | null>(null);
  const [way, setWay] = useState<"key" | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [err, setErr] = useState("");

  const load = () => void encryptionStatus().then(setSt);
  useEffect(load, []);
  // the status changed after emoji verification
  useEffect(() => {
    if (sas?.phase === "done") load();
  }, [sas?.phase]);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const n = await verifyWithRecoveryKey(key);
      setDone(n ? t("crypto.restored", { n }) : t("crypto.verified"));
      setKey("");
      setWay(null);
      load();
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
    }
    setBusy(false);
  };

  if (!st) return <div className="state">{t("crypto.checking")}</div>;

  if (!st.enabled) return <div className="error">{t("crypto.disabled")}</div>;

  if (st.verified) {
    return (
      <>
        <div className="status-card good">
          <b>{t("crypto.ok.title")}</b>
          <span>{t("crypto.ok.text")}</span>
        </div>
        <div className="note">{st.backup ? t("crypto.backup.on") : t("crypto.backup.off")}</div>
        {done && <div className="note good">{done}</div>}
      </>
    );
  }

  return (
    <>
      <div className="status-card warn">
        <b>{t("crypto.unverified.title")}</b>
        <span>{t("crypto.unverified.text")}</span>
      </div>

      <div className="ways">
        <button className={`way ${way === "key" ? "on" : ""}`} onClick={() => setWay(way === "key" ? null : "key")} disabled={!st.secretStorage}>
          <b>{t("crypto.way.key")}</b>
          <span className="state">{st.secretStorage ? t("crypto.way.key.hint") : t("crypto.way.key.unavailable")}</span>
        </button>
        <button className="way" onClick={() => void startVerification()}>
          <b>{t("crypto.way.device")}</b>
          <span className="state">{t("crypto.way.device.hint")}</span>
        </button>
      </div>

      {way === "key" && (
        <div className="field">
          <div className="with-button">
            <PasswordInput
              autoFocus
              value={key}
              placeholder={t("crypto.key.placeholder")}
              onChange={setKey}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && void run()}
            />
            <button className="primary" disabled={!key.trim() || busy} onClick={() => void run()}>
              {busy ? t("crypto.checking") : t("crypto.key.submit")}
            </button>
          </div>
          <span className="state">{t("crypto.key.local")}</span>
        </div>
      )}

      {done && <div className="note good">{done}</div>}
      {err && <div className="error">{err}</div>}
    </>
  );
}

/* ----------------------------------------------------------------- sessions */

function SessionsTab() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState("");
  const [password, setPassword] = useState("");
  const [naming, setNaming] = useState("");

  const load = () => {
    setBusy(true);
    void sessions()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(load, []);

  /** First without a password: ask for it only if the server refuses. */
  const drop = async (deviceId: string, pw: string) => {
    setError("");
    try {
      await endSession(deviceId, pw);
      setAsking("");
      setPassword("");
      load();
    } catch (e) {
      if (e instanceof NeedPassword) {
        setAsking(deviceId);
        return;
      }
      const text = String((e as Error)?.message ?? e);
      setError(/M_FORBIDDEN|Invalid password/i.test(text) ? t("sessions.wrongPassword") : text);
    }
  };

  return (
    <>
      <p className="sub">{t("sessions.intro")}</p>

      {error && <div className="error">{error}</div>}
      {busy && <div className="state">{t("sessions.loading")}</div>}

      <div className="sessions">
        {rows.map((r) => (
          <div className="session" key={r.deviceId}>
            <div className="session-main">
              <b>
                {r.name}
                {r.current && <span className="badge">{t("sessions.current")}</span>}
              </b>
              <div className="state">
                {r.deviceId}
                {r.ip ? ` · ${r.ip}` : ""}
                {r.seen ? ` · ${fmtDateTime(r.seen)}` : ""}
              </div>
              {asking === r.deviceId && (
                <div className="with-button gap-top">
                  <PasswordInput
                    autoFocus
                    placeholder={t("sessions.password")}
                    value={password}
                    onChange={setPassword}
                    onKeyDown={(e) => e.key === "Enter" && password && void drop(r.deviceId, password)}
                  />
                  <button className="primary" disabled={!password} onClick={() => void drop(r.deviceId, password)}>
                    {t("sessions.end")}
                  </button>
                  <button className="ghost" onClick={() => (setAsking(""), setPassword(""))}>
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </div>
            {!r.current && asking !== r.deviceId && (
              <button className="ghost icon danger" title={t("sessions.endTitle")} onClick={() => void drop(r.deviceId, "")}>
                <IconTrash />
              </button>
            )}
            {r.current && naming === "" && (
              <button className="ghost small" onClick={() => setNaming(r.name)}>
                {t("sessions.rename")}
              </button>
            )}
            {r.current && naming !== "" && (
              <div className="with-button">
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} />
                <button
                  className="primary small"
                  disabled={!naming.trim()}
                  onClick={() =>
                    void renameSession(r.deviceId, naming.trim()).then(() => {
                      setNaming("");
                      load();
                    })
                  }
                >
                  {t("common.save")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="row">
        <button className="ghost" onClick={load}>
          <IconRefresh /> {t("common.refresh")}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- window */

const TABS: { id: SettingsTab; name: Key }[] = [
  { id: "profile", name: "settings.tab.profile" },
  { id: "audio", name: "settings.tab.audio" },
  { id: "keys", name: "settings.tab.keys" },
  { id: "appearance", name: "settings.tab.appearance" },
  { id: "app", name: "settings.tab.app" },
  { id: "crypto", name: "settings.tab.crypto" },
  { id: "sessions", name: "settings.tab.sessions" },
];

export function Settings() {
  const open = useStore(app, (s) => s.settingsOpen);
  const tab = useStore(app, (s) => s.settingsTab);
  const error = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState).error;

  const { shown, closing } = useLinger(open);
  const close = () => app.set({ settingsOpen: false });
  useEscape(open, close);

  useEffect(() => {
    if (open) void voice.unlockDevices();
  }, [open]);

  if (!shown) return null;

  return (
    <div className={`modal-back ${closing ? "closing" : ""}`} onClick={close}>
      <div className="modal wide settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-tabs">
          {TABS.map((tb) => (
            <button key={tb.id} className={tab === tb.id ? "on" : "ghost"} onClick={() => app.set({ settingsTab: tb.id })}>
              {t(tb.name)}
            </button>
          ))}
        </div>

        <div className="settings-body">
          <div className="tab-pane" key={tab}>
            {tab === "profile" && <ProfileTab />}
            {tab === "audio" && <AudioTab />}
            {tab === "keys" && <KeysTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "app" && <AppTab />}
            {tab === "crypto" && <CryptoTab />}
            {tab === "sessions" && <SessionsTab />}
            {error && tab === "audio" && <div className="error">{error}</div>}
          </div>
        </div>

        <div className="row">
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
