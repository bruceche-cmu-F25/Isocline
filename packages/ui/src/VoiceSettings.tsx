/** Settings → Voice (docs/design/voice.md §3): whether Alfred speaks, in which voice, how fast, and the words the
 * speech model should know. All of it lives on the home node, so every device speaks and hears alike. */
import { useEffect, useState, type FormEvent } from "react";
import type { VoiceSettings as Voice, VoiceStatus } from "@alfred/protocol";
import { api } from "./api.ts";
import { t, useLocale } from "./i18n/index.ts";
import { Select } from "./shell/Select.tsx";
import { say, stopSpeaking, useSpeaking, useVoiceSettings } from "./speech/voice.ts";

const RATES: Array<[number, "slow" | "normal" | "fast"]> = [[0.85, "slow"], [1, "normal"], [1.2, "fast"]];
const MAX_WORDS = 40;
const TRY = "voice-try";

export function VoiceSettings() {
  const locale = useLocale();
  const voice = useVoiceSettings();
  const speaking = useSpeaking() === TRY;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [word, setWord] = useState("");

  // What voices there are; while the model is being got ready, asked again now and then.
  const loading = status?.speak.model === "loading";
  useEffect(() => {
    let live = true;
    const load = () => api.voice().then((next) => { if (live) setStatus(next); }, (reason: Error) => { if (live) setError(reason.message); });
    void load();
    const timer = loading ? window.setInterval(load, 3000) : undefined;
    return () => { live = false; window.clearInterval(timer); };
  }, [loading, voice.voice]);

  const save = (patch: Partial<Voice>) => api.settings({ voice: patch }).then(() => setError(null), (reason: Error) => setError(reason.message));
  const speak = status?.speak;
  const lang = locale === "zh" ? "zh" : "en";
  // This language's voices first, the model's after the system's; the other language's after those.
  const voices = speak ? [...speak.voices.filter((item) => item.lang === lang), ...speak.voices.filter((item) => item.lang !== lang)] : [];
  const current = voice.voice && voices.some((item) => item.id === voice.voice) ? voice.voice : speak?.current ?? "";
  const label = (id: string) => {
    const item = voices.find((known) => known.id === id);
    if (!item) return id;
    return `${item.name}${item.engine === "model" ? ` · ${t("voice.settings.lifelike")}` : ""}${item.lang !== lang ? ` · ${item.lang === "zh" ? "中文" : "English"}` : ""}`;
  };
  const sample = t("voice.settings.sample");

  const addWord = (event: FormEvent) => {
    event.preventDefault();
    const next = word.trim();
    if (!next || voice.words.includes(next) || voice.words.length >= MAX_WORDS) { setWord(""); return; }
    void save({ words: [...voice.words, next] }).then(() => setWord(""));
  };

  return (
    <section className="set-section">
      <h2>{t("settings.tab.voice")}</h2>
      {error && <p className="problem small" role="alert">{error}</p>}
      {speak && !speak.available && <p className="quiet small">{speak.reason}</p>}
      <div className="set-rows">
        <div className="set-row">
          <span className="set-name">{t("voice.settings.figure")}</span>
          <span className="set-note">{t("voice.settings.figure.note")}</span>
          <span className="set-end">
            <Chips value={voice.speakFigure} onChange={(speakFigure) => void save({ speakFigure })} label={t("voice.settings.figure")} />
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("voice.settings.mute")}</span>
          <span className="set-note">{t("voice.settings.mute.note")}</span>
          <span className="set-end">
            <Chips value={voice.muted} onChange={(muted) => void save({ muted })} label={t("voice.settings.mute")} />
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("voice.settings.voice")}</span>
          <span className="set-note">{t("voice.settings.voice.note")}</span>
          <span className="set-end">
            {voices.length > 0 && (
              <Select className="model-select field-select" label={t("voice.settings.voice")} value={current}
                onChange={(id) => { void save({ voice: id }); void say(sample, { key: TRY, voice: id, rate: voice.rate }); }}
                options={voices.map((item) => ({ value: item.id, label: label(item.id) }))} />
            )}
            <button type="button" className="set-button ghost" disabled={!speak?.available}
              onClick={() => { if (speaking) stopSpeaking(TRY); else void say(sample, { key: TRY, voice: current || undefined, rate: voice.rate }); }}>
              {speaking ? t("voice.stopReading") : t("voice.settings.try")}
            </button>
          </span>
        </div>
        {speak?.model && speak.model !== "loaded" && speak.model !== "ready" && (
          <div className="set-row">
            <span className="set-name">{t("voice.settings.model")}</span>
            <span className="set-note">{t("voice.settings.model.note", { size: `${Math.round(speak.modelBytes / 1e9)}GB` })}</span>
            <span className="set-end">
              {speak.model === "loading"
                ? <span className="quiet small" role="status">{t("voice.settings.model.loading")}</span>
                : <button type="button" className="set-button" onClick={() => api.voiceModel().then(() => api.voice().then(setStatus), (reason: Error) => setError(reason.message))}>{t("voice.settings.model.get")}</button>}
            </span>
          </div>
        )}
        <div className="set-row">
          <span className="set-name">{t("voice.settings.rate")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("voice.settings.rate")}>
              {RATES.map(([rate, name]) => (
                <button type="button" key={name} className="chip" role="radio" aria-checked={voice.rate === rate} aria-pressed={voice.rate === rate}
                  onClick={() => { void save({ rate }); void say(sample, { key: TRY, voice: current || undefined, rate }); }}>{t(`voice.settings.rate.${name}`)}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row set-words">
          <span className="set-name">{t("voice.settings.words")}</span>
          <span className="set-note">{t("voice.settings.words.note", { n: voice.words.length, max: MAX_WORDS })}</span>
          <div className="set-end set-words-end">
            {voice.words.length > 0 && (
              <ul className="voice-words">
                {voice.words.map((item) => (
                  <li key={item}>
                    <span>{item}</span>
                    <button type="button" aria-label={t("voice.settings.words.remove", { word: item })} onClick={() => void save({ words: voice.words.filter((known) => known !== item) })}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <form className="voice-word-add" onSubmit={addWord}>
              <input className="model-input" value={word} maxLength={40} placeholder={t("voice.settings.words.placeholder")}
                aria-label={t("voice.settings.words.placeholder")} disabled={voice.words.length >= MAX_WORDS} onChange={(event) => setWord(event.target.value)} />
              <button type="submit" className="set-button ghost" disabled={!word.trim() || voice.words.length >= MAX_WORDS}>{t("voice.settings.words.add")}</button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}

function Chips({ value, onChange, label }: { value: boolean; onChange(next: boolean): void; label: string }) {
  return (
    <span className="chips set-chips" role="radiogroup" aria-label={label}>
      {[true, false].map((on) => (
        <button type="button" key={String(on)} className="chip" role="radio" aria-checked={value === on} aria-pressed={value === on}
          onClick={() => onChange(on)}>{t(on ? "voice.settings.on" : "voice.settings.off")}</button>
      ))}
    </span>
  );
}
