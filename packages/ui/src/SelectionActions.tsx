import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n/index.ts";
import "./selection-actions.css";

interface SelectionActionsProps {
  list: RefObject<HTMLOListElement | null>;
  onFollowUp(text: string): void;
  onExplain(text: string): void;
}

interface Excerpt { text: string; range: Range; source: Element }

function selectedExcerpt(list: HTMLOListElement | null): Excerpt | null {
  const selection = window.getSelection();
  if (!list || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const source = (node instanceof Element ? node : node.parentElement)?.closest(".said-text, .reply-text");
  if (!source || !list.contains(source)) return null;
  const text = selection.toString();
  return text.trim() ? { text, range: range.cloneRange(), source } : null;
}

export function SelectionActions({ list, onFollowUp, onExplain }: SelectionActionsProps) {
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [feedback, setFeedback] = useState<"copied" | "manual" | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let dragging = false;
    const read = () => {
      if (dragging) return;
      const next = selectedExcerpt(list.current);
      // Tabbing into the actions can collapse the native selection. Keep the quote for those buttons.
      if (!next && bar.current?.contains(document.activeElement)) return;
      setExcerpt(next);
      setFeedback(null);
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !bar.current?.contains(event.target)) setExcerpt(null);
    };
    const press = (event: PointerEvent) => {
      dragging = event.pointerType === "mouse" && event.button === 0 && event.target instanceof Node && !!list.current?.contains(event.target);
      outside(event);
    };
    const release = () => {
      if (!dragging) return;
      dragging = false;
      read();
    };
    const key = (event: KeyboardEvent) => {
      if (!bar.current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setExcerpt(null);
        window.getSelection()?.removeAllRanges();
      } else if (event.key === "Tab" && !event.shiftKey && !bar.current.contains(document.activeElement)) {
        event.preventDefault();
        bar.current.querySelector("button")?.focus({ preventScroll: true });
      }
    };
    read();
    document.addEventListener("selectionchange", read);
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", key);
    };
  }, [list]);

  useLayoutEffect(() => {
    const element = bar.current;
    const turns = list.current;
    if (!excerpt || !element || !turns) return;
    const { range, source } = excerpt;
    const bubble = source.closest(".said");
    const viewport = window.visualViewport;
    const place = () => {
      if (!turns.contains(source) || !source.contains(range.commonAncestorContainer)) {
        setExcerpt(null);
        return;
      }
      const bounds = turns.getBoundingClientRect();
      const vx = viewport?.offsetLeft ?? 0, vy = viewport?.offsetTop ?? 0;
      const left = Math.max(vx, bounds.left) + 4, top = Math.max(vy, bounds.top) + 4;
      const right = Math.min(vx + (viewport?.width ?? window.innerWidth), bounds.right) - 4;
      const bottom = Math.min(vy + (viewport?.height ?? window.innerHeight), bounds.bottom) - 4;
      const line = [...range.getClientRects()].find((rect) => rect.width && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
      if (!line || right <= left || bottom <= top) { setExcerpt(null); return; }
      element.style.maxWidth = `${right - left}px`;
      const { width, height } = element.getBoundingClientRect();
      const x = (Math.max(line.left, left) + Math.min(line.right, right) - width) / 2;
      const above = line.top - height - 6, below = line.bottom + 6;
      const preferBelow = window.matchMedia("(pointer: coarse)").matches && below + height <= bottom;
      const y = above < top || preferBelow ? below : above;
      element.style.left = `${Math.max(left, Math.min(right - width, x))}px`;
      element.style.top = `${Math.max(top, Math.min(bottom - height, y))}px`;
      bubble?.setAttribute("data-text-selected", "true");
    };
    place();
    const observer = new ResizeObserver(place);
    for (const target of [turns, source, element]) observer.observe(target);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      bubble?.removeAttribute("data-text-selected");
      observer.disconnect();
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [excerpt, list]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), feedback === "copied" ? 1600 : 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  if (!excerpt) return null;
  const act = (action: (text: string) => void) => {
    setExcerpt(null);
    window.getSelection()?.removeAllRanges();
    action(excerpt.text);
  };
  const copy = async () => {
    // A late permission result belongs to the excerpt on which Copy was pressed.
    const element = bar.current;
    try {
      await navigator.clipboard.writeText(excerpt.text);
      if (element === bar.current) setFeedback("copied");
    } catch {
      if (element === bar.current) setFeedback("manual");
    }
  };
  return createPortal(
    <div ref={bar} key={excerpt.text} className="selection-actions" role="group" aria-label={t("conv.selectionActions")}
      onPointerDown={(event) => event.preventDefault()}>
      <div className="selection-buttons">
        <button type="button" onClick={() => act(onFollowUp)}>{t("conv.followUp")}</button>
        <button type="button" onClick={() => act(onExplain)}>{t("conv.explain")}</button>
        <button type="button" onClick={copy}>{t("conv.copySelection")}</button>
      </div>
      <span className="selection-feedback" role="status">{feedback && t(feedback === "copied" ? "conv.copied" : "conv.copyManually")}</span>
    </div>, document.body,
  );
}
