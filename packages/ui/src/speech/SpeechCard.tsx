import type { CSSProperties } from "react";
import { t } from "../i18n/index.ts";
import type { Said } from "./useSpeech.ts";
import "./speech.css";

export type Tail = "left" | "right" | "top" | "bottom";

interface Props {
  said: Said;
  out: number;
  complete: boolean;
  folding: boolean;
  /** How many more wait after this one. */
  more: number;
  /** Which edge the tail is on, pointing at the figure, and where along it (a CSS length from the top or left). */
  tail: Tail;
  tailAt: string;
  onOpen(): void;
  onNext(): void;
  onClose(): void;
  onHover(hovered: boolean): void;
  /** Only the title, in a pill: there is no room for more just now. */
  brief?: boolean;
  style?: CSSProperties;
}

/** What Zirma says, coming out of its figure: the tail points back at it and the card grows from there. */
export function SpeechCard({ said, out, complete, folding, more, tail, tailAt, onOpen, onNext, onClose, onHover, brief, style }: Props) {
  const chars = Array.from(said.body);
  if (brief) {
    return (
      <div className={`speech brief mood-${said.mood}${folding ? " folding" : ""}`} data-tail={tail} role="status" aria-live="polite" style={{ ...style, "--tail-at": tailAt } as CSSProperties}>
        <button type="button" className="speech-body" onClick={onOpen} title={said.body}>
          <span className="speech-title"><span>{said.title}</span></span>
          {more > 0 && <span className="speech-count">+{more}</span>}
        </button>
        <button type="button" className="speech-close" aria-label={t("presence.close")} onClick={onClose}>×</button>
      </div>
    );
  }
  return (
    <div
      className={`speech mood-${said.mood}${folding ? " folding" : ""}`} data-tail={tail} role="status" aria-live="polite"
      style={{ ...style, "--tail-at": tailAt } as CSSProperties}
      onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
    >
      <button type="button" className="speech-body" onClick={onOpen}>
        <span className="speech-title">{said.title}</span>
        {/* The whole text is laid out from the start, so the card does not grow as it is said. */}
        <span className="speech-said" aria-label={said.body}>
          <span aria-hidden="true">{chars.slice(0, out).join("")}</span>
          <span className="unsaid" aria-hidden="true">{chars.slice(out).join("")}</span>
        </span>
      </button>
      <div className={`speech-foot${complete ? " shown" : ""}`}>
        {more > 0 && <button type="button" className="speech-more" onClick={onNext}>{t("presence.next")} · {t("presence.more", { n: more })}</button>}
        <button type="button" className="speech-act" onClick={onOpen}>{said.action}</button>
      </div>
      <button type="button" className="speech-close" aria-label={t("presence.close")} onClick={onClose}>×</button>
    </div>
  );
}
