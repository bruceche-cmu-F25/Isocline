import type { Delivered, Locale, ModuleServices } from "@isocline/module-kit";

export class MailLabelError extends Error {
  override name = "MailLabelError";
  readonly code: "missing" | "permission";
  constructor(code: MailLabelError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const SAY = {
  en: { permission: "Gmail star and archive sync is not enabled for this account", missing: "This message no longer exists in Gmail" },
  zh: { permission: "这个账户没有开启 Gmail 星标和归档同步", missing: "这封邮件在 Gmail 里已经不在了" },
};

/** A label change is safe to repeat. The queue handles transient failures and lost responses. */
export async function changeGmailLabel(
  services: ModuleServices, account: string, id: string, label: "INBOX" | "STARRED", present: boolean, locale: Locale, signal?: AbortSignal,
): Promise<Delivered> {
  const google = services.google;
  const allowed = () => {
    const capabilities = google?.accounts().find((candidate) => candidate.email === account)?.capabilities ?? [];
    return capabilities.includes("mailRead") && capabilities.includes("mailModify");
  };
  const say = SAY[locale];
  if (!google || !allowed()) return { state: "failed", error: say.permission };
  const session = await google.session(account);
  // An account's permission can change while its token is being refreshed.
  if (!allowed()) return { state: "failed", error: say.permission };
  const changes = present ? { addLabelIds: [label] } : { removeLabelIds: [label] };
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`;
  const { status, body } = await session.send("POST", url, changes, { signal });
  if (status === 404 || status === 410) return { state: "failed", error: say.missing };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { state: "failed", error: `Gmail answered ${status}` };
  // Gmail may omit labelIds when the last label was removed. An archive still needs the message ID as a receipt.
  const wrongMessage = (label === "INBOX" || body.id !== undefined) && body.id !== id;
  const wrongLabels = body.labelIds !== undefined && (!Array.isArray(body.labelIds) || body.labelIds.includes(label) !== present);
  if (status < 200 || status >= 300 || wrongMessage || wrongLabels) {
    return { state: "unclear", error: `Gmail did not confirm the ${label} change (${status})` };
  }
  return { state: "done" };
}
