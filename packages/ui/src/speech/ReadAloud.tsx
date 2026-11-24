/** 「朗读」 under one of Zirma's replies: says it out loud; pressed again, stops. Not shown when muted. */
import { Icon } from "../shell/icons.tsx";
import { t } from "../i18n/dict.ts";
import { forSpeech, say, stopSpeaking, useSpeaking, useVoiceSettings } from "./voice.ts";

export function ReadAloud({ id, text }: { id: string; text: string }) {
  const speaking = useSpeaking() === id;
  if (useVoiceSettings().muted) return null;
  return (
    <button
      type="button" className="read-aloud" data-speaking={speaking || undefined}
      aria-label={speaking ? t("voice.stopReading") : t("voice.read")} title={speaking ? t("voice.stopReading") : t("voice.read")}
      onClick={() => { if (speaking) stopSpeaking(id); else void say(forSpeech(text), { key: id }); }}
    >
      <Icon name={speaking ? "stop" : "speaker"} />
    </button>
  );
}
