import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { t } from "./i18n/index.ts";

/** Only bind this directly to a focusable tile or card, so Delete can still edit text inside inputs. */
export function onDeleteKey(event: KeyboardEvent, request: () => void) {
  if ((event.key !== "Delete" && event.key !== "Backspace") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  if (!event.repeat) request();
}

export function LinkDeleteDialog({ title, folder, onCancel, onDelete }: { title: string; folder?: boolean; onCancel(): void; onDelete(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="lk-delete-dialog" aria-labelledby={label} aria-describedby={folder ? label + "-detail" : undefined}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h3 id={label}>{t("links.deleteAsk", { title })}</h3>
    {folder && <p id={label + "-detail"}>{t("links.folder.deleteHint")}</p>}
    <div>
      <button type="button" className="lk-btn" onClick={onCancel} autoFocus>{t("common.cancel")}</button>
      <button type="button" className="lk-btn danger" onClick={onDelete}>{t("links.remove")}</button>
    </div>
  </dialog>;
}
