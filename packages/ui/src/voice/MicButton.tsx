/** The microphone next to every place you talk to Zirma. Click to start, click again to stop (Esc throws it away);
 * the words land where the cursor is, to read over before sending. */
import type { CSSProperties } from "react";
import { Icon } from "../shell/icons.tsx";
import { t } from "../i18n/dict.ts";
import { dictationSupported, useDictation } from "./useDictation.ts";

export function MicButton({ onText, disabled, className = "" }: { onText: (text: string) => void; disabled?: boolean; className?: string }) {
  const dictation = useDictation(onText);
  if (!dictationSupported()) return null;
  const { state, level, seconds, error } = dictation;
  const label = state === "recording" ? t("voice.stop") : state === "transcribing" ? t("voice.working") : state === "starting" ? t("voice.starting") : t("voice.start");
  return (
    <span className={`mic ${className}`} data-state={state}>
      {state === "recording" && <span className="mic-time" aria-hidden="true">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>}
      <button
        type="button"
        className="mic-button"
        onClick={dictation.toggle}
        disabled={disabled || state === "transcribing"}
        aria-label={label}
        aria-pressed={state === "recording"}
        title={state === "recording" ? `${label} · ${t("voice.escCancels")}` : label}
        style={{ "--level": level.toFixed(2) } as CSSProperties}
      >
        {state === "recording" ? <span className="mic-stop" aria-hidden="true" /> : state === "transcribing" ? <span className="mic-spin" aria-hidden="true" /> : <Icon name="mic" />}
      </button>
      {error && <span className="mic-error" role="status">{error}</span>}
    </span>
  );
}
