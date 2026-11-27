/** Settings → General → Reminders (docs/design/reminders.md §5): which events, todos and mail Zirma mentions on its
 * own, and how early. All of it lives on the home node, so every device reminds alike. */
import { useState, type FormEvent } from "react";
import type { ReminderSettings, StateResponse } from "@zirma/protocol";
import { api } from "./api.ts";
import { t, useLocale } from "./i18n/index.ts";
import { Select } from "./shell/Select.tsx";
import { Chips } from "./VoiceSettings.tsx";

const EVENT_MINUTES = [5, 10, 15, 30, 60];
const TODO_MINUTES = [15, 30, 60, 120, 180];
const DEFAULTS: ReminderSettings = { events: { on: true, beforeMin: 10 }, todos: { on: true, beforeMin: 60 }, mail: { senders: [], important: false, since: null } };
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;

/** "10 min", "1 hr", "2 hr". */
const howEarly = (minutes: number) => minutes >= 60 ? t("rem.hours", { n: minutes / 60 }) : t("rem.min", { n: minutes });

export function Reminders({ state }: { state: StateResponse }) {
  useLocale();
  const settings = state.settings.reminders ?? DEFAULTS;
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const save = (patch: NonNullable<Parameters<typeof api.settings>[0]["reminders"]>) =>
    api.settings({ reminders: patch }).then(() => setError(null), (reason: Error) => setError(reason.message));

  const timed = (key: "events" | "todos", minutes: number[]) => (
    <div className="set-row">
      <span className="set-name">{t(`rem.settings.${key}`)}</span>
      <span className="set-note">{t(`rem.settings.${key}.note`)}</span>
      <span className="set-end rem-end">
        <Chips value={settings[key].on} onChange={(on) => void save({ [key]: { on } })} label={t(`rem.settings.${key}`)} />
        <Select className="model-select field-select rem-before" label={t("rem.settings.before")} value={String(settings[key].beforeMin)} disabled={!settings[key].on}
          onChange={(value) => void save({ [key]: { beforeMin: Number(value) } })}
          options={minutes.map((value) => ({ value: String(value), label: howEarly(value) }))} />
      </span>
    </div>
  );

  const senders = settings.mail.senders;
  const add = (event: FormEvent) => {
    event.preventDefault();
    const next = address.trim().toLowerCase();
    if (!EMAIL.test(next) || senders.includes(next)) { setAddress(""); return; }
    void save({ mail: { senders: [...senders, next] } }).then(() => setAddress(""));
  };

  return (
    <section className="set-section">
      <h2>{t("rem.settings")}</h2>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="set-rows">
        {timed("events", EVENT_MINUTES)}
        {timed("todos", TODO_MINUTES)}
        <div className="set-row set-words">
          <span className="set-name">{t("rem.settings.mail")}</span>
          <span className="set-note">{t("rem.settings.mail.note")}</span>
          <div className="set-end set-words-end">
            {senders.length > 0 && (
              <ul className="voice-words">
                {senders.map((sender) => (
                  <li key={sender}>
                    <span>{sender}</span>
                    <button type="button" aria-label={t("rem.settings.mail.remove", { who: sender })} onClick={() => void save({ mail: { senders: senders.filter((known) => known !== sender) } })}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <form className="voice-word-add" onSubmit={add}>
              <input className="model-input" type="email" value={address} maxLength={320} placeholder={t("rem.settings.mail.placeholder")}
                aria-label={t("rem.settings.mail.placeholder")} onChange={(event) => setAddress(event.target.value)} />
              <button type="submit" className="set-button ghost" disabled={!EMAIL.test(address.trim())}>{t("voice.settings.words.add")}</button>
            </form>
          </div>
        </div>
        <div className="set-row">
          <span className="set-name">{t("rem.settings.important")}</span>
          <span className="set-note">{t("rem.settings.important.note")}</span>
          <span className="set-end">
            <Chips value={settings.mail.important} onChange={(important) => void save({ mail: { important } })} label={t("rem.settings.important")} />
          </span>
        </div>
      </div>
    </section>
  );
}
