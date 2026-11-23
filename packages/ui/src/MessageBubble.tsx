import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { Linked } from "./Linked.tsx";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";

export function MessageBubble({ text, added = false }: { text: string; added?: boolean }) {
  const messageId = useId();
  const bubble = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<"copied" | "manual" | null>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!bubble.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), feedback === "copied" ? 1600 : 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("copied");
    } catch {
      setFeedback("manual");
    }
  };

  return (
    <p ref={bubble} className={added ? "said added" : "said"} data-actions-open={open || undefined}
      onClick={() => { if (window.getSelection()?.isCollapsed) setOpen((shown) => !shown); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false); }}>
      <span className="said-text" id={messageId}><Linked text={text} /></span>
      <span className="said-tools">
        <button type="button" className="icon-btn said-copy" onClick={copy} title={t("conv.copyMessage")}
          aria-label={t("conv.copyMessage")} aria-describedby={messageId}><Icon name="copy" /></button>
      </span>
      <span className="said-feedback" role="status">{feedback && t(feedback === "copied" ? "conv.copied" : "conv.copyManually")}</span>
    </p>
  );
}
