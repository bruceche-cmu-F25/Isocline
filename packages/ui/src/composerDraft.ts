import type { FileInfo } from "@isocline/protocol";

export interface Pending {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  file?: FileInfo;
  error?: string;
}

interface Draft { text: string; items: Pending[]; sending: boolean }
const empty = (): Draft => ({ text: "", items: [], sending: false });

/** Each window keeps its own unsent work. Upload completions still reach it while another session is open. */
function createDraft(key?: string) {
  let draft = empty();
  if (key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw) as Draft;
        if (typeof saved.text === "string" && Array.isArray(saved.items)) {
          draft.text = saved.text;
          draft.items = saved.items.filter((item) => item && typeof item.key === "string" && typeof item.name === "string")
            .map((item) => item.state === "uploading" ? { ...item, state: "failed" } : item);
        }
      }
    } catch { /* Storage can be unavailable in a private window. */ }
  }
  const listeners = new Set<() => void>();
  function write(next: Draft) {
    draft = next;
    if (key) {
      try {
        if (draft.text || draft.items.length) sessionStorage.setItem(key, JSON.stringify({ text: draft.text, items: draft.items }));
        else sessionStorage.removeItem(key);
      } catch { /* Keep the draft in this window's memory. */ }
    }
    for (const listener of listeners) listener();
  }
  return {
    snapshot: () => draft,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText(value: string | ((text: string) => string)) {
      write({ ...draft, text: typeof value === "function" ? value(draft.text) : value });
    },
    setItems(change: (items: Pending[]) => Pending[]) { write({ ...draft, items: change(draft.items) }); },
    beginSend() {
      if (draft.sending) return false;
      write({ ...draft, sending: true });
      return true;
    },
    endSend() { write({ ...draft, sending: false }); },
    sent(text: string, files: readonly string[]) {
      write({ ...draft, text: draft.text === text ? "" : draft.text,
        items: draft.items.filter((item) => !item.file || !files.includes(item.file.id)) });
    },
  };
}

const drafts = new Map<string, ReturnType<typeof createDraft>>();
export function composerDraft(sessionId?: string) {
  if (!sessionId) return createDraft();
  let draft = drafts.get(sessionId);
  if (!draft) {
    draft = createDraft(`isocline.codingDraft.${sessionId}`);
    drafts.set(sessionId, draft);
  }
  return draft;
}
