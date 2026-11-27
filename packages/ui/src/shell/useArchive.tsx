import type { Conversation } from "@zirma/protocol";
import { useState, type ReactNode } from "react";
import { ApiError, api } from "../api.ts";
import { t } from "../i18n/index.ts";
import { Pop } from "./Pop.tsx";

export type ArchiveConversation = (conversation: Conversation, worktree?: "keep" | "discard", archiveRuns?: "finish" | "stop") => Promise<void>;

/** Archiving a conversation, and the two questions it can raise: a session's worktree holds work not committed (keep
 * the folder or drop it), or a turn is still running (let it finish, or stop it). Shared by the sidebar's list and the
 * Chats page (docs/design/chat.md), so both ask the same way. Render `dialogs` once wherever it is used. */
export function useArchive(onArchive: ArchiveConversation): {
  archive: ArchiveConversation; archiving: boolean; archiveError: string; asking: boolean; dialogs: ReactNode;
} {
  // A session whose worktree holds work not committed: archiving it asks whether to keep that folder or drop it.
  const [dirty, setDirty] = useState<{ conversation: Conversation; count: number } | null>(null);
  const [unfinished, setUnfinished] = useState<{ conversation: Conversation; count: number } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  async function archive(conversation: Conversation, worktree?: "keep" | "discard", archiveRuns?: "finish" | "stop") {
    if (archiving) return;
    setArchiving(true);
    setArchiveError("");
    try {
      await onArchive(conversation, worktree, archiveRuns);
      setUnfinished(null);
      setDirty(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "git_dirty") {
        setUnfinished(null);
        setDirty({ conversation, count: reason.count ?? 1 });
      } else if (reason instanceof ApiError && reason.code === "archive_busy") {
        setDirty(null);
        setUnfinished({ conversation, count: reason.count ?? Math.max(1, conversation.busy + conversation.attention) });
      } else {
        setArchiveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setArchiving(false);
    }
  }
  const dialogs = (
    <>
        {unfinished && (
          <Pop onClose={() => setUnfinished(null)}>
            <div className="ev-edit" role="alertdialog" aria-modal="true" aria-label={t("archive.unfinished", { n: unfinished.count })}>
              <div className="ev-card-head"><b>{t("archive.unfinished", { n: unfinished.count })}</b><button type="button" className="icon-btn" onClick={() => setUnfinished(null)} aria-label={t("common.close")}>×</button></div>
              <p>{t("archive.waitHint")}</p>
              {archiveError && <p className="problem" role="alert">{archiveError}</p>}
              <div className="ev-foot">
                {unfinished.conversation.archivePlan === "finish" && <button type="button" disabled={archiving} onClick={async () => {
                  setArchiving(true);
                  try { await api.updateConversation(unfinished.conversation.id, { archived: false }); setUnfinished(null); }
                  catch (reason) { setArchiveError(reason instanceof Error ? reason.message : String(reason)); }
                  finally { setArchiving(false); }
                }}>{t("archive.withdraw")}</button>}
                <span />
                <button type="button" className="danger" disabled={archiving} onClick={() => archive(unfinished.conversation, undefined, "stop")}>{t("archive.stop")}</button>
                <button type="button" disabled={archiving} autoFocus onClick={() => archive(unfinished.conversation, undefined, "finish")}>{t("archive.finish")}</button>
              </div>
            </div>
          </Pop>
        )}
        {dirty && (
          <Pop onClose={() => setDirty(null)}>
            <div className="ev-edit" role="alertdialog" aria-modal="true" aria-label={t("archive.dirty", { n: dirty.count })}>
              <div className="ev-card-head"><b>{t("archive.dirty", { n: dirty.count })}</b><button type="button" className="icon-btn" onClick={() => setDirty(null)} aria-label={t("common.close")}>×</button></div>
              <p>{t("archive.dirtyWhy", { branch: dirty.conversation.branch ?? "" })}</p>
              {archiveError && <p className="problem" role="alert">{archiveError}</p>}
              <div className="ev-foot">
                <span />
                <button type="button" className="danger" disabled={archiving} onClick={() => archive(dirty.conversation, "discard")}>{t("archive.discard")}</button>
                <button type="button" disabled={archiving} onClick={() => archive(dirty.conversation, "keep")} autoFocus>{t("archive.keep")}</button>
              </div>
            </div>
          </Pop>
        )}
    </>
  );
  return { archive, archiving, archiveError, asking: !!dirty || !!unfinished, dialogs };
}
