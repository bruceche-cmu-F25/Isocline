/** Files sent with a message (docs/design/attachments.md): picked, pasted or dropped into any composer, uploaded to
 * the home node at once, and shown as chips until the message goes. A file the home node does not take (not an
 * image, a PDF or text; past 20 MB) is said so on its chip and never sent.
 */
import { useMemo, useRef, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import type { FileInfo } from "@isocline/protocol";
import { ApiError, api } from "./api.ts";
import { t, type Key } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";
import { composerDraft, type Pending } from "./composerDraft.ts";

export const MAX_ATTACHMENTS = 10;
/** What the file picker offers. The home node decides by the bytes; this only keeps the picker useful, and on a
 * phone `image/*` is what brings up the camera and the photo library. */
const ACCEPT = "image/*,application/pdf,text/*,.md,.markdown,.txt,.json,.jsonl,.csv,.tsv,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.sh,.sql,.toml,.ini,.log,.tex";

const WHY: Record<string, Key> = { file_unsupported: "attach.unsupported", file_too_big: "attach.tooBig", file_empty: "attach.empty" };
export const fileSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export interface Attachments {
  items: Pending[];
  /** The ids to send; empty while nothing is ready. */
  ids: string[];
  /** Something is still on its way up: the message waits for it. */
  busy: boolean;
  add(files: Iterable<File>): void;
  remove(key: string): void;
  clear(): void;
  /** For a composer's element: files pasted or dropped onto it are attached. */
  onPaste(event: ClipboardEvent): void;
  onDrop(event: DragEvent): void;
  onDragOver(event: DragEvent): void;
}

export function useComposer(sessionId?: string) {
  const store = useMemo(() => composerDraft(sessionId), [sessionId]);
  const { items, text, sending } = useSyncExternalStore(store.subscribe, store.snapshot);
  const setItems = store.setItems;
  const add = (files: Iterable<File>) => {
    for (const file of files) {
      if (store.snapshot().items.length >= MAX_ATTACHMENTS) break;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // A pasted screenshot has no name of its own.
      const name = file.name || `${t("attach.pasted")}.${file.type.split("/")[1] ?? "png"}`;
      setItems((now) => [...now, { key, name, size: file.size, state: "uploading" }]);
      api.upload(file, name).then(
        (info) => setItems((now) => now.map((item) => (item.key === key ? { ...item, state: "ready", file: info } : item))),
        (reason: unknown) => {
          const why = reason instanceof ApiError && reason.code ? WHY[reason.code] : undefined;
          setItems((now) => now.map((item) => (item.key === key ? { ...item, state: "failed", error: why ? t(why) : reason instanceof Error ? reason.message : String(reason) } : item)));
        },
      );
    }
  };
  const attachments: Attachments = {
    items, add,
    remove: (key) => setItems((now) => now.filter((item) => item.key !== key)),
    clear: () => setItems(() => []),
    ids: items.flatMap((item) => (item.state === "ready" && item.file ? [item.file.id] : [])),
    busy: items.some((item) => item.state === "uploading"),
    onPaste(event) {
      const files = [...event.clipboardData.files];
      if (!files.length) return;
      event.preventDefault();
      add(files);
    },
    onDrop(event) {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      add(event.dataTransfer.files);
    },
    onDragOver(event) { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
  };
  return { store, text, sending, attachments };
}

export function useAttachments(): Attachments { return useComposer().attachments; }

/** The paperclip: opens the file picker (on a phone, the camera and the photo library too). */
export function AttachButton({ attachments, disabled }: { attachments: Attachments; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="attach-button" disabled={disabled || attachments.items.length >= MAX_ATTACHMENTS} onClick={() => input.current?.click()}
        aria-label={t("attach.add")} title={t("attach.add")}><Icon name="clip" /></button>
      <input ref={input} type="file" multiple hidden accept={ACCEPT} tabIndex={-1}
        onChange={(event) => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
    </>
  );
}

/** The files waiting to go with the message. */
export function AttachChips({ attachments }: { attachments: Attachments }) {
  if (!attachments.items.length) return null;
  return (
    <ul className="attach-chips" aria-label={t("attach.label")}>
      {attachments.items.map((item) => (
        <li key={item.key} className="attach-chip" data-state={item.state} title={item.error ?? item.name}>
          {/* The picture comes back from the home node once it is there (the page may only load images from it). */}
          {item.file?.kind === "image" ? <img src={`/api/files/${item.file.id}`} alt="" /> : <span className="attach-kind">{item.name.split(".").at(-1)?.slice(0, 4).toUpperCase()}</span>}
          <span className="attach-name">{item.name}</span>
          <span className="attach-note">{item.state === "uploading" ? t("attach.uploading") : item.state === "failed" ? item.error ?? t("attach.reselect") : fileSize(item.size)}</span>
          <button type="button" onClick={() => attachments.remove(item.key)} aria-label={t("attach.remove", { name: item.name })}><Icon name="close" /></button>
        </li>
      ))}
    </ul>
  );
}

/** The files that went with a message, under the user's words. */
export function SentFiles({ files }: { files: FileInfo[] | undefined }) {
  if (!files?.length) return null;
  return (
    <ul className="sent-files" aria-label={t("attach.label")}>
      {files.map((file) => (
        <li key={file.id}>
          <a href={`/api/files/${file.id}`} target="_blank" rel="noreferrer noopener" className="attach-chip" data-kind={file.kind} title={file.name}>
            {file.kind === "image" ? <img src={`/api/files/${file.id}`} alt="" loading="lazy" /> : <span className="attach-kind">{file.kind === "pdf" ? "PDF" : file.name.split(".").at(-1)?.slice(0, 4).toUpperCase()}</span>}
            <span className="attach-name">{file.name}</span>
            <span className="attach-note">
              {file.kind === "pdf" && file.pages ? t("attach.pages", { n: file.pages }) : fileSize(file.size)}
              {file.kind === "pdf" && file.readable === false ? ` · ${t("attach.unread")}` : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
