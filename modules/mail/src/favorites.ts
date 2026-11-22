import { recordDomainEvent, type World } from "@alfred/core";
import type { ModuleServices } from "@alfred/module-kit";

// Reading the remote labels and committing their snapshot must finish before a user changes the same
// account's star. Otherwise a slow sync could undo the acknowledged change in the local mirror.
const accountWork = new WeakMap<World, Map<string, Promise<void>>>();

export function withMailAccount<T>(world: World, account: string, work: () => Promise<T>): Promise<T> {
  let queue = accountWork.get(world);
  if (!queue) {
    queue = new Map();
    accountWork.set(world, queue);
  }
  const previous = queue.get(account) ?? Promise.resolve();
  const result = previous.then(work);
  const tail = result.then(() => {}, () => {});
  queue.set(account, tail);
  return result.finally(() => { if (queue.get(account) === tail) queue.delete(account); });
}

class MailFavoriteError extends Error {
  override name = "MailFavoriteError";
  readonly code: "missing" | "permission" | "reconnect" | "unavailable";
  constructor(code: MailFavoriteError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Set a desired state, so retrying after an uncertain Gmail response is safe. Only a device
 * action calls this. Local-only saves never modify Gmail or acquire new OAuth permissions. */
export function setMailFavorite(world: World, services: ModuleServices, account: string, id: string, starred: boolean) {
  return withMailAccount(world, account, async () => {
    const google = services.google;
    if (!google) throw new MailFavoriteError("unavailable", "Gmail is unavailable");
    const source = google.accounts(true).find((candidate) => candidate.email === account);
    if (!source?.capabilities.includes("mailRead")) throw new MailFavoriteError("permission", "This account has no mailbox read access");
    const row = world.db.prepare("SELECT starred, local_saved FROM mail_messages WHERE account = ? AND id = ?").get(account, id);
    if (!row) throw new MailFavoriteError("missing", "This message is no longer in Alfred Mail");

    const canModify = source.capabilities.includes("mailModify");
    if (canModify) {
      const session = await google.session(account);
      // Refreshing access can outlast a Settings change. Check the live grant immediately before sending.
      const connected = google.accounts().find((candidate) => candidate.email === account);
      if (!connected) throw new MailFavoriteError("reconnect", "Reconnect this Gmail account in Settings to change its stars");
      if (!connected.capabilities.includes("mailRead") || !connected.capabilities.includes("mailModify")) {
        throw new MailFavoriteError("permission", "Gmail star syncing is no longer enabled for this account");
      }
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`;
      const changes = starred ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] };
      const { status, body } = await session.send("POST", url, changes);
      if (status === 404 || status === 410) throw new MailFavoriteError("missing", "This message no longer exists in Gmail");
      if (status === 403) throw new MailFavoriteError("permission", "Gmail refused the star change. Check this account's permissions in Settings");
      if (status < 200 || status >= 300 || (Array.isArray(body.labelIds) && body.labelIds.includes("STARRED") !== starred)) {
        throw new MailFavoriteError("unavailable", "Gmail did not confirm the star change. Try again");
      }
    } else if (!starred && row.starred === 1) {
      throw new MailFavoriteError("permission", "Enable Gmail star syncing in Settings to remove a Gmail star");
    }

    const scope: "gmail" | "local" = canModify || row.starred === 1 ? "gmail" : "local";
    const remoteStar = canModify ? Number(starred) : row.starred;
    const localSave = scope === "local" ? Number(starred) : 0;
    world.tx((db) => {
      const result = db.prepare(`UPDATE mail_messages SET starred = ?, local_saved = ?
        WHERE account = ? AND id = ? AND (starred != ? OR local_saved != ?)`).run(remoteStar, localSave, account, id, remoteStar, localSave);
      if (result.changes) recordDomainEvent(world, { kind: "mail.favorite", subject: `mail:${account}`, actor: "user", payload: { id, starred, scope } });
    });
    return { starred, scope };
  });
}
