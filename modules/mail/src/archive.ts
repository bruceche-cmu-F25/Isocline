import { defineOp, enqueueOutbound, localeOf, recordDomainEvent, Type, userLocale, type Delivered, type ModuleServices, type Outbound, type World } from "@zirma/module-kit";
import { changeGmailLabel, MailLabelError } from "./labels.ts";

interface ArchiveInput { account: string; id: string }

const PENDING = `SELECT id AS outbound_id, json_extract(payload, '$.account') AS account, json_extract(payload, '$.id') AS message_id
  FROM core_outbound WHERE module = 'mail' AND action = 'archive' AND state IN ('queued', 'sending')`;

/** Hide pending archives from inbox reads immediately, while retaining Gmail's last known membership.
 * A failed delivery restores that membership even if the subsequent inbox refresh is offline. */
export const VISIBLE_MAIL = `(SELECT m.*, (m.in_inbox = 1 AND (m.account, m.id) NOT IN
  (SELECT account, message_id FROM (${PENDING}))) AS visible_inbox FROM mail_messages AS m)`;

export const archiveOp = defineOp({
  name: "mail.archive",
  input: Type.Object({
    account: Type.String({ minLength: 1, maxLength: 320 }),
    id: Type.String({ minLength: 1, maxLength: 64 }),
  }),
  run(world, { account, id }) {
    return world.tx((db) => {
      const row = db.prepare(`SELECT m.in_inbox, m.subject, s.can_read, s.can_modify FROM mail_messages AS m
        LEFT JOIN mail_sources AS s ON s.account = m.account WHERE m.account = ? AND m.id = ?`).get(account, id);
      if (!row) throw new MailLabelError("missing", "This message is no longer in Zirma Mail");
      if (!row.can_read || !row.can_modify) throw new MailLabelError("permission", "Enable Gmail star and archive sync for this account in Settings");
      const pending = db.prepare(`SELECT outbound_id FROM (${PENDING}) WHERE account = ? AND message_id = ?`).get(account, id);
      if (pending) return { queued: pending.outbound_id };
      if (!row.in_inbox) return { queued: null };
      const subject = (row.subject as string) || id;
      const preview = userLocale(world) === "zh" ? `在 Gmail 中归档「${subject}」` : `Archive “${subject}” in Gmail`;
      const outbound = enqueueOutbound(world, { module: "mail", action: "archive", payload: { account, id }, preview, idempotent: true, quiet: true });
      recordDomainEvent(world, { kind: "mail.archive", subject: `mail:${account}`, payload: { id } });
      return { queued: outbound.id };
    });
  },
});

export async function deliverArchive(world: World, outbound: Outbound, services: ModuleServices, signal?: AbortSignal): Promise<Delivered> {
  const { account, id } = outbound.payload as ArchiveInput;
  const outcome = await changeGmailLabel(services, account, id, "INBOX", false, localeOf(world.db), signal);
  if (outcome.state === "done") {
    world.tx((db) => db.prepare("UPDATE mail_messages SET in_inbox = 0, labels_checked_at = 0 WHERE account = ? AND id = ?").run(account, id));
  }
  return outcome;
}
