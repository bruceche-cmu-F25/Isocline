/** Favorites: a star in Gmail, or a message saved in Zirma only.
 *
 * The user's click is an operation like any other (`mail.favorite`): it changes the mirror at once, in one
 * transaction. If Zirma may change stars in the account, the Gmail half is an outbound change (core/outbound.ts)
 * that `deliverStar` makes later, so it is retried, ordered and reported like every other outside change. A star is a
 * desired state, so delivering it again is safe (`idempotent`); the user hears about it only when it did not go
 * through (`quiet`), and the next read of the inbox then shows Gmail as it is.
 *
 * Without that permission a favorite is saved in Zirma only. A Gmail star cannot be removed from here then.
 */
import { enqueueOutbound, listOutbound, localeOf, recordDomainEvent, userLocale, type Locale, type Outbound, type World, defineOp, Type, type Delivered, type ModuleServices } from "@zirma/module-kit";
import { changeGmailLabel, MailLabelError } from "./labels.ts";

export interface StarInput { account: string; id: string; starred: boolean }

const SAY: Record<Locale, { star(subject: string): string; unstar(subject: string): string }> = {
  zh: {
    star: (subject) => `在 Gmail 中给「${subject}」加星`,
    unstar: (subject) => `取消「${subject}」的 Gmail 星标`,
  },
  en: {
    star: (subject) => `Star “${subject}” in Gmail`,
    unstar: (subject) => `Remove the Gmail star from “${subject}”`,
  },
};

/** Star changes for these messages are still on their way to Gmail (`account\nid`): the mirror already shows them,
 * and an inbox read taken before they arrive must not undo that. */
export function starsOnTheirWay(world: World, account: string): Map<string, Outbound> {
  const waiting = new Map<string, Outbound>();
  for (const outbound of listOutbound(world, { module: "mail", states: ["queued", "sending"] })) {
    const input = outbound.payload as StarInput;
    if (outbound.action === "star" && input.account === account) waiting.set(input.id, outbound);
  }
  return waiting;
}

export const favoriteOp = defineOp({
  name: "mail.favorite",
  input: Type.Object({
    account: Type.String({ minLength: 1, maxLength: 320 }),
    id: Type.String({ minLength: 1, maxLength: 64 }),
    starred: Type.Boolean(),
  }),
  run(world, { account, id, starred }) {
    return world.tx((db) => {
      const row = db.prepare(`SELECT m.starred, m.local_saved, m.subject, s.can_modify FROM mail_messages AS m
        LEFT JOIN mail_sources AS s ON s.account = m.account WHERE m.account = ? AND m.id = ?`).get(account, id);
      if (!row) throw new MailLabelError("missing", "This message is no longer in Zirma Mail");
      const canModify = row.can_modify === 1;
      if (!canModify && !starred && row.starred === 1) {
        throw new MailLabelError("permission", "Enable Gmail star syncing in Settings to remove a Gmail star");
      }
      const scope: "gmail" | "local" = canModify || row.starred === 1 ? "gmail" : "local";
      // Starring in Gmail keeps a local save until Gmail has it (deliverStar clears it), so a star Gmail refuses
      // does not lose the favorite. Taking a favorite away takes both.
      const next = canModify
        ? { starred: Number(starred), saved: starred ? row.local_saved as number : 0 }
        : { starred: row.starred as number, saved: scope === "local" ? Number(starred) : 0 };
      const changed = db.prepare("UPDATE mail_messages SET starred = ?, local_saved = ? WHERE account = ? AND id = ? AND (starred != ? OR local_saved != ?)")
        .run(next.starred, next.saved, account, id, next.starred, next.saved).changes;
      if (canModify && row.starred !== next.starred) {
        const say = SAY[userLocale(world)];
        const subject = (row.subject as string) || id;
        // After any star change for this message still on its way, so Gmail ends where the user last left it.
        const afterId = [...starsOnTheirWay(world, account).values()].filter((outbound) => (outbound.payload as StarInput).id === id).at(-1)?.id;
        enqueueOutbound(world, {
          module: "mail", action: "star", payload: { account, id, starred } satisfies StarInput,
          preview: starred ? say.star(subject) : say.unstar(subject), idempotent: true, quiet: true, afterId,
        });
      }
      if (changed) recordDomainEvent(world, { kind: "mail.favorite", subject: `mail:${account}`, payload: { id, starred, scope } });
      return { starred, scope };
    });
  },
});

/** Makes one star change in Gmail (mail's `deliver`, for `star`). The permission is checked again here: the user may
 * have turned star syncing off since the click. */
export async function deliverStar(world: World, outbound: Outbound, services: ModuleServices, signal?: AbortSignal): Promise<Delivered> {
  const { account, id, starred } = outbound.payload as StarInput;
  const outcome = await changeGmailLabel(services, account, id, "STARRED", starred, localeOf(world.db), signal);
  if (outcome.state !== "done") return outcome;
  // Gmail holds it now: a local save under the star is no longer needed.
  if (starred) world.tx((db) => db.prepare("UPDATE mail_messages SET local_saved = 0 WHERE account = ? AND id = ? AND starred = 1").run(account, id));
  return { state: "done" };
}
