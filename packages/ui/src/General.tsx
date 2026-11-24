/** Settings → General: the name and language (shared by every device), and what this device prefers:
 * light or dark, text size, send key and the phone dock shortcut (after pi-web's Settings › General,
 * github.com/agegr/pi-web, MIT).
 */
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { CHARACTER_NAMES, LOCALE_INFO, LOCALES, setAssistant, setLocale, t, useLocale, type Key, type Locale } from "./i18n/index.ts";
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
const LANGUAGES: Array<[Locale, string]> = LOCALES.map((id) => [id, LOCALE_INFO[id].name]);
const APPEARANCES: Appearance[] = ["system", "light", "dark"];
/** ⌘ on a Mac or an iPhone, Ctrl elsewhere. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

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
    <section className="set-section">
      <h2>{t("settings.general")}</h2>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="set-rows">
        <form className="set-row set-preferred-name" onSubmit={submitName} aria-busy={savingName}>
          <label className="set-name" htmlFor="preferred-name">{t("settings.preferredName")}</label>
          <span className="set-note">{t("settings.language.note")}</span>
          <div className="set-end">
            <input id="preferred-name" className="model-input" autoComplete="nickname" maxLength={80}
              value={name} disabled={savingName} onChange={(event) => {
                setDraftName(event.target.value === savedName ? null : event.target.value);
              }} />
            <button type="submit" className="set-button" disabled={!canSaveName}>{t("settings.save")}</button>
          </div>
        </form>
        <div className="set-row">
          <span className="set-name">{t("settings.character")}</span>
          <span className="set-note">{t("settings.character.note")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.character")}>
              {(["ana", "kata"] as const).map((id) => (
                <button type="button" key={id} className="chip" role="radio" data-character={id} aria-checked={assistant.character === id} aria-pressed={assistant.character === id}
                  onClick={() => chooseCharacter(id)}>{t(`settings.character.${id}`)}</button>
              ))}
            </span>
          </span>
        </div>
        <form className="set-row set-preferred-name" onSubmit={submitAssistant}>
          <label className="set-name" htmlFor="assistant-name">{t("settings.assistantName")}</label>
          <span className="set-note">{t("settings.assistantName.note", { name: assistantDefault })}</span>
          <div className="set-end">
            <input id="assistant-name" className="model-input" maxLength={40} placeholder={assistantDefault}
              value={assistantName} onChange={(event) => setDraftAssistant(event.target.value)} />
            <button type="submit" className="set-button" disabled={!canSaveAssistant}>{t("settings.save")}</button>
          </div>
        </form>
        <div className="set-row">
          <span className="set-name">{t("settings.firstRun")}</span>
          <span className="set-note">{t("settings.firstRun.note")}</span>
          <span className="set-end">
            <button type="button" className="set-button ghost" onClick={() => window.dispatchEvent(new Event(SHOW_FIRST_RUN))}>{t("settings.firstRun.again")}</button>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.language")}</span>
          <span className="set-note">{t("settings.language.note")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.language")}>
              {LANGUAGES.map(([id, name]) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={locale === id} aria-pressed={locale === id}
                  lang={LOCALE_INFO[id].tag} onClick={() => chooseLanguage(id)}>{name}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.appearance")}</span>
          <span className="set-note">{t("settings.appearance.note")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.appearance")}>
              {APPEARANCES.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={appearance === id} aria-pressed={appearance === id}
                  onClick={(event) => setAppearance(id, origin(event))}>{t(`settings.appearance.${id}`)}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.textSize")}</span>
          <span className="set-note">{t("settings.thisDevice")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.textSize")}>
              {TEXT_SIZES.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={textSize === id} aria-pressed={textSize === id}
                  onClick={() => setTextSize(id)}>{t(`settings.textSize.${id}` as Key)}</button>
              ))}
            </span>
          </span>
        </div>
        {phone && <div className="set-row set-dock-shortcut">
          <label className="set-name" htmlFor="dock-shortcut">{t("settings.dockShortcut")}</label>
          <span className="set-note">{t("settings.thisDevice")}</span>
          <span className="set-end">
            <Select className="model-select field-select" id="dock-shortcut" label={t("settings.dockShortcut")} value={dockShortcut} onChange={setDockShortcut}
              options={[
                { value: "", label: t("settings.dockShortcut.none") },
                ...(dockShortcut && !dockOptions.some((page) => page.key === dockShortcut) ? [{ value: dockShortcut, label: t("settings.dockShortcut.unavailable"), disabled: true }] : []),
                ...dockOptions.map((page) => ({ value: page.key, label: page.title })),
              ]} />
          </span>
        </div>}
        <div className="set-row">
          <span className="set-name">{t("settings.sendKey")}</span>
          <span className="set-note">{t(sendKey === "enter" ? "settings.sendKey.enter.note" : "settings.sendKey.mod.note", { mod: MOD })}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.sendKey")}>
              {SEND_KEYS.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={sendKey === id} aria-pressed={sendKey === id}
                  onClick={() => setSendKey(id)}>{id === "enter" ? "Enter" : `${MOD}Enter`}</button>
              ))}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
