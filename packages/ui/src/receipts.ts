import type { CoreEvent } from "@isocline/protocol";
import { t, type Key } from "./i18n/index.ts";

const FIELD: Record<string, Key> = {
  title: "field.title", due: "field.due", startDate: "field.startDate", plannedOn: "field.plannedOn", url: "field.url",
  status: "field.status", done: "field.done", area: "field.area",
};

/** One line per receipt, from what was recorded, not from the model's words. */
export function describeReceipt(event: CoreEvent): string {
  const title = typeof event.payload.title === "string" ? event.payload.title : "";
  switch (event.kind) {
    case "todo.added": return t("rcpt.added", { title });
    case "todo.suggested": return t("rcpt.suggested", { title });
    case "todo.completed": return t("rcpt.completed", { title });
    case "todo.deleted": return t("rcpt.deleted", { title });
    case "todo.updated": {
      const changes = Object.keys((event.payload.changes as Record<string, unknown> | undefined) ?? {});
      const fields = [...new Set(changes.map((field) => FIELD[field]).filter(Boolean))].map((key) => t(key));
      return fields.length ? t("rcpt.updatedFields", { title, fields: fields.join(t("list.sep")) }) : t("rcpt.updated", { title });
    }
    case "link.saved": return t("rcpt.link.saved", { title });
    case "link.pinned": return t("rcpt.link.pinned", { title });
    case "link.changed": return t("rcpt.link.changed", { title });
    case "link.removed": return t("rcpt.link.removed", { title });
    case "link.topic_added": return t("rcpt.link.topic", { title: String(event.payload.name ?? "") });
    case "todo.imported": return t("rcpt.imported", { n: Number(event.payload.imported) });
    case "proposal.opened": return t("rcpt.proposed", { title });
    case "file.changed": return t(event.payload.created ? "rcpt.fileNew" : "rcpt.file", { path: String(event.payload.path), added: Number(event.payload.added) || 0, removed: Number(event.payload.removed) || 0 });
    default: return event.kind;
  }
}

/** What a failed run's error code means, in the user's words. */
export function errorText(code: string | undefined): string {
  const key = `err.${code ?? ""}` as Key;
  return code && ["engine_failed", "engine_unavailable", "timeout", "unknown_profile", "lease_lost", "engine_crashed"].includes(code) ? t(key) : "";
}
