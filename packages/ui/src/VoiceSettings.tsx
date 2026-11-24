/** Settings → Voice (docs/design/voice.md §3): whether Isocline speaks, in which voice, how fast, and the words the
 * speech model should know; and the speech services (ElevenLabs, Inworld, Boson AI) whose voices it can use with the
 * user's own key. All of it lives on the home node, so every device speaks and hears alike; keys are given only on
 * that machine. */
import { useEffect, useState, type FormEvent } from "react";
import type { SpeechServiceStatus, VoiceSettings as Voice, VoiceStatus } from "@isocline/protocol";
import { api } from "./api.ts";
import { t, useLocale } from "./i18n/index.ts";
import { Logo } from "./brand/Logo.tsx";
import { Select } from "./shell/Select.tsx";
import { say, stopSpeaking, useSpeaking, useVoiceSettings } from "./speech/voice.ts";

const RATES: Array<[number, "slow" | "normal" | "fast"]> = [[0.85, "slow"], [1, "normal"], [1.2, "fast"]];
const MAX_WORDS = 40;
const TRY = "voice-try";

export function VoiceSettings({ local }: { local: boolean }) {
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
  // The services' voices first (the user brought a key for them), then this language's own, then the rest.
  const rank = (item: VoiceStatus["speak"]["voices"][number]) => (item.engine !== "system" && item.engine !== "model" ? 0 : item.lang === lang ? 1 : 2);
  const voices = speak ? [...speak.voices].sort((a, b) => rank(a) - rank(b)) : [];
  const serviceName = (engine: string) => speak?.providers.find((item) => item.id === engine)?.name;
  const current = voice.voice && voices.some((item) => item.id === voice.voice) ? voice.voice : speak?.current ?? "";
  const label = (id: string) => {
    const item = voices.find((known) => known.id === id);
    if (!item) return id;
    const service = serviceName(item.engine);
    return `${item.name}${service ? ` · ${service}` : item.engine === "model" ? ` · ${t("voice.settings.lifelike")}` : ""}${item.lang !== lang && item.lang !== "any" ? ` · ${item.lang === "zh" ? "中文" : "English"}` : ""}`;
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
        {speak && speak.providers.length > 0 && (
          <div className="set-row voice-services-head">
            <span className="set-name">{t("voice.services")}</span>
            <span className="set-note">{t("voice.services.note")}</span>
          </div>
        )}
        {speak?.providers.map((service) => (
          <ServiceRow key={service.id} service={service} local={local}
            onChange={(next) => setStatus((last) => (last ? { ...last, speak: { ...next, current: last.speak.current } } : last))} onError={setError} />
        ))}
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

/** One speech service: connected or not, and on the home node a field for its key. */
function ServiceRow({ service, local, onChange, onError }: {
  service: SpeechServiceStatus; local: boolean; onChange(next: Omit<VoiceStatus["speak"], "current">): void; onError(message: string | null): void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const act = (work: Promise<Omit<VoiceStatus["speak"], "current">>) => {
    setBusy(true);
    work.then((next) => { onChange(next); onError(null); setKey(""); }, (reason: Error) => onError(t("voice.services.refused", { name: service.name, reason: reason.message })))
      .finally(() => setBusy(false));
  };
  const note = service.error ? t("voice.services.error", { reason: service.error })
    : service.key === "saved" ? t("voice.services.connected")
    : service.key === "env" ? t("voice.services.env")
    : local ? t("voice.services.none") : t("voice.services.onMac");
  return (
    <form className="set-row has-logo voice-service" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (key.trim()) act(api.voiceServiceKey(service.id, key.trim())); }}>
      <span className="set-logo" data-k="gray"><Logo name={service.id} /></span>
      <span className="set-name">{service.name}</span>
      <span className="set-note" data-problem={service.error ? "" : undefined}>
        {note}{local && !service.key && <> · <a href={service.keyUrl} target="_blank" rel="noreferrer">{t("voice.services.getKey")}</a></>}
      </span>
      {local && (
        <span className="set-end">
          {service.key === "saved"
            ? <button type="button" className="set-button ghost" disabled={busy} onClick={() => act(api.voiceServiceForget(service.id))}>{t("voice.services.forget")}</button>
            : <>
                <input className="model-input" type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy}
                  placeholder={t("voice.services.key")} aria-label={t("voice.services.keyFor", { name: service.name })} onChange={(event) => setKey(event.target.value)} />
                <button type="submit" className="set-button" disabled={busy || !key.trim()}>{busy ? t("voice.services.checking") : t("voice.services.connect")}</button>
              </>}
        </span>
      )}
    </form>
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
