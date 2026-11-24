import type { Conversation } from "@zirma/protocol";
import { t } from "../i18n/index.ts";

/** The same run state beside a conversation in the sidebar and the Code page. */
export function ConversationStatus({ conversation }: { conversation: Pick<Conversation, "unreadReplyId" | "attention" | "busy"> }) {
  if (conversation.unreadReplyId) {
    return <span className="st" role="img" aria-label={t("nav.unreadReply")}><span className="mark" data-k="alfred" /></span>;
  }
  return <span className="st" aria-hidden="true">{conversation.attention > 0 ? <span className="mark" data-k="warm" /> : conversation.busy > 0 ? <span className="pulse" /> : <span className="mark dim" />}</span>;
}
