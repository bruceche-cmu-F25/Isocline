/** Settings → General: the name and language (shared by every device), and what this device prefers:
 * light or dark, text size, send key and the phone dock shortcut (after pi-web's Settings › General,
 * github.com/agegr/pi-web, MIT).
 */
import { useId, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { api } from "./api.ts";
import { CHARACTER_NAMES, LOCALE_INFO, LOCALES, setAssistant, setLocale, t, useLocale, type Locale } from "./i18n/index.ts";
import { SEND_KEYS, setDockShortcut, setSendKey, setTextSize, TEXT_SIZES, useDockShortcut, useSendKey, useTextSize } from "./prefs.ts";
import { origin, setAppearance, useAppearance, type Appearance } from "./scheme.ts";
import { PHONE, useMedia } from "./shell/layout.ts";
import { Select } from "./shell/Select.tsx";
import { SHOW_FIRST_RUN } from "./firstRunEvent.ts";

export interface NamePreference { name: string | null; saveName(name: string): Promise<void> }
export interface GeneralProps extends NamePreference {
  dockOptions: ReadonlyArray<{ key: string; title: string }>;
  /** Who the assistant is and what it is called (shared by every device). */
  assistant?: { character: "ana" | "kata"; name: string | null };
}
export { SHOW_FIRST_RUN };

/** Each language named in itself. */
const LANGUAGES = LOCALES.map((id) => ({ id, label: LOCALE_INFO[id].name, lang: LOCALE_INFO[id].tag }));
const APPEARANCES: Appearance[] = ["system", "light", "dark"];
/** ⌘ on a Mac or an iPhone, Ctrl elsewhere. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const CHOICE_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function moveChoice(event: KeyboardEvent<HTMLSpanElement>) {
  const step = CHOICE_STEPS[event.key];
  if (!step) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const next = buttons[(current + step + buttons.length) % buttons.length];
  next.focus();
  next.click();
}

function ChoiceRow<T extends string>({ label, note, options, value, onChoose, className }: {
  label: string;
  note?: string;
  options: ReadonlyArray<{ id: T; label: string; lang?: string; character?: string }>;
  value: T;
  onChoose: (value: T, event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className ? `set-row ${className}` : "set-row"}>
      <span className="set-name" id={id}>{label}</span>
      {note && <span className="set-note" id={`${id}-note`}>{note}</span>}
      <span className="set-end">
        <span className="chips set-chips" role="radiogroup" aria-labelledby={id}
          aria-describedby={note ? `${id}-note` : undefined} onKeyDown={moveChoice}>
          {options.map((option) => (
            <button type="button" key={option.id} className="chip" role="radio" aria-checked={value === option.id}
              tabIndex={value === option.id ? 0 : -1} lang={option.lang} data-character={option.character}
              onClick={(event) => onChoose(option.id, event)}>{option.label}</button>
          ))}
        </span>
      </span>
    </div>
  );
}

export function General({ name: savedName, saveName, dockOptions, assistant = { character: "ana", name: null } }: GeneralProps) {
  const phone = useMedia(PHONE);
  const dockShortcut = useDockShortcut();
  const locale = useLocale();
  const appearance = useAppearance();
  const textSize = useTextSize();
  const sendKey = useSendKey();
  const [error, setError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const name = draftName ?? savedName ?? "";
  const canSaveName = !!name.trim() && name.trim() !== savedName && !savingName;
  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSaveName) return;
    setSavingName(true);
    setError(null);
    try {
      await saveName(name.trim());
      setDraftName(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSavingName(false);
    }
  };

  // The assistant: Ana or Kata, and the name it goes by (empty: the character's own).
  const [draftAssistant, setDraftAssistant] = useState<string | null>(null);
  const assistantDefault = CHARACTER_NAMES[assistant.character];
  const assistantName = draftAssistant ?? assistant.name ?? "";
  const canSaveAssistant = (assistantName.trim() || null) !== assistant.name;
  const chooseCharacter = (character: "ana" | "kata") => {
    if (character === assistant.character) return;
    // The voice goes with the character: a voice picked for the other one is let go, so the new one speaks in its own.
    if (!assistant.name) setAssistant(CHARACTER_NAMES[character]);
    api.settings({ character, voice: { voice: null } }).catch((reason: Error) => setError(reason.message));
  };
  const submitAssistant = (event: FormEvent) => {
    event.preventDefault();
    if (!canSaveAssistant) return;
    const next = assistantName.trim() || null;
    setAssistant(next ?? assistantDefault);
    api.settings({ assistantName: next }).then(() => setDraftAssistant(null), (reason: Error) => setError(reason.message));
  };

  const chooseLanguage = (next: Locale) => {
    // The UI switches at once; the home node keeps it, and every device follows.
    setLocale(next);
    api.settings({ locale: next }).catch((reason: Error) => setError(reason.message));
  };

  return (
    <section className="set-section set-general">
      <h2>{t("settings.general")}</h2>
      {error && <p className="problem small" role="alert">{error}</p>}
      <section className="set-group" aria-labelledby="settings-personal">
        <header className="set-group-head">
          <h3 id="settings-personal">{t("settings.personal")}</h3>
          <p>{t("settings.personal.note")}</p>
        </header>
        <div className="set-rows">
          <form className="set-row set-preferred-name" onSubmit={submitName} aria-busy={savingName}>
            <label className="set-name" htmlFor="preferred-name">{t("settings.preferredName")}</label>
            <div className="set-end">
              <input id="preferred-name" className="model-input" autoComplete="nickname" maxLength={80}
                value={name} disabled={savingName} onChange={(event) => {
                  setDraftName(event.target.value === savedName ? null : event.target.value);
                }} />
              <button type="submit" className="set-button" disabled={!canSaveName}>{t("settings.save")}</button>
            </div>
          </form>
          <ChoiceRow label={t("settings.character")} value={assistant.character} onChoose={chooseCharacter}
            options={(["ana", "kata"] as const).map((id) => ({ id, label: t(`settings.character.${id}`), character: id }))} />
          <form className="set-row set-preferred-name" onSubmit={submitAssistant}>
            <label className="set-name" htmlFor="assistant-name">{t("settings.assistantName")}</label>
            <span className="set-note" id="assistant-name-note">{t("settings.assistantName.note", { name: assistantDefault })}</span>
            <div className="set-end">
              <input id="assistant-name" className="model-input" maxLength={40} placeholder={assistantDefault}
                aria-describedby="assistant-name-note" value={assistantName} onChange={(event) => setDraftAssistant(event.target.value)} />
              <button type="submit" className="set-button" disabled={!canSaveAssistant}>{t("settings.save")}</button>
            </div>
          </form>
          <ChoiceRow className="set-language" label={t("settings.language")} options={LANGUAGES} value={locale} onChoose={chooseLanguage} />
        </div>
      </section>
      <section className="set-group" aria-labelledby="settings-device">
        <header className="set-group-head"><h3 id="settings-device">{t("settings.device")}</h3></header>
        <div className="set-rows">
          <ChoiceRow label={t("settings.appearance")} value={appearance} onChoose={(id, event) => setAppearance(id, origin(event))}
            options={APPEARANCES.map((id) => ({ id, label: t(`settings.appearance.${id}`) }))} />
          <ChoiceRow label={t("settings.textSize")} value={textSize} onChoose={setTextSize}
            options={TEXT_SIZES.map((id) => ({ id, label: t(`settings.textSize.${id}`) }))} />
          <ChoiceRow label={t("settings.sendKey")} value={sendKey} onChoose={setSendKey}
            note={t(sendKey === "enter" ? "settings.sendKey.enter.note" : "settings.sendKey.mod.note", { mod: MOD })}
            options={SEND_KEYS.map((id) => ({ id, label: id === "enter" ? "Enter" : `${MOD}Enter` }))} />
          {phone && <div className="set-row set-dock-shortcut">
            <label className="set-name" htmlFor="dock-shortcut">{t("settings.dockShortcut")}</label>
            <span className="set-end">
              <Select className="model-select field-select" id="dock-shortcut" label={t("settings.dockShortcut")} value={dockShortcut} onChange={setDockShortcut}
                options={[
                  { value: "", label: t("settings.dockShortcut.none") },
                  ...(dockShortcut && !dockOptions.some((page) => page.key === dockShortcut) ? [{ value: dockShortcut, label: t("settings.dockShortcut.unavailable"), disabled: true }] : []),
                  ...dockOptions.map((page) => ({ value: page.key, label: page.title })),
                ]} />
            </span>
          </div>}
        </div>
      </section>
      <div className="set-row set-walkthrough">
        <span className="set-name">{t("settings.firstRun")}</span>
        <span className="set-end">
          <button type="button" className="set-button ghost" onClick={() => window.dispatchEvent(new Event(SHOW_FIRST_RUN))}>{t("settings.firstRun.again")}</button>
        </span>
      </div>
    </section>
  );
}
