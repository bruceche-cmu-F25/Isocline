import type { Conversation } from "@isocline/protocol";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";

interface ArchiveNoticeProps {
  conversation: Conversation;
  onUndo(): Promise<void>;
  onDismiss(): void;
}

export function ArchiveNotice({ conversation, onUndo, onDismiss }: ArchiveNoticeProps) {
  const remaining = useRef(10_000);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const paused = hovered || focused || restoring || !!error;
  useEffect(() => {
    if (paused) return;
    const start = performance.now();
    const timer = window.setTimeout(onDismiss, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current -= performance.now() - start;
    };
  }, [paused, onDismiss]);

  async function undo() {
    if (restoring) return;
    setRestoring(true);
    setError("");
    try {
      await onUndo();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRestoring(false);
    }
  }

  return (
    <div className="archive-notice" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => setFocused(event.currentTarget.contains(event.relatedTarget))}>
      <span className="archive-message" role="status" title={conversation.title}>{t("archive.done", { title: conversation.title })}</span>
      <button type="button" className="archive-undo" aria-disabled={restoring} onClick={undo}>
        {t(restoring ? "archive.restoring" : conversation.projectId ? "archive.restoreSession" : "archive.undo")}
      </button>
      <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onDismiss}><Icon name="close" /></button>
      {error && <p className="problem" role="alert">{error}</p>}
    </div>
  );
}
