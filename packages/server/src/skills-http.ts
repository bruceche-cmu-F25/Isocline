/** `/api/skills/*`: Isocline's skills (see @isocline/protocol). The host and origin checks of http.ts have already run,
 * and only this machine reaches these routes. Errors are thrown; the listener says a SkillError as its status (wire.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Skills } from "@isocline/engine-pi";
import type { SkillSearchResponse } from "@isocline/protocol";
import { HttpError, readJson, send } from "./wire.ts";

/** What was sent does not say which skill, or what to look for. */
const invalid = (message: string) => new HttpError(400, message, "skill_invalid");

const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > 2000) throw invalid(`${key} is required`);
  return value;
};

/** Handles the request when it is one of the skills routes; false when it is not. */
export async function handleSkills(skills: Skills, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/skills") return send(res, 200, skills.list()), true;
  if (method === "GET" && path === "/api/skills/content") {
    const id = url.searchParams.get("id");
    if (!id) throw invalid("id is required");
    return send(res, 200, skills.content(id)), true;
  }
  if (method !== "POST") return false;
  const action = /^\/api\/skills\/(enable|disable|remove|add|search|updates|update)$/.exec(path)?.[1];
  if (!action) return false;
  const body = await readJson(req);
  if (action === "enable" || action === "disable") return send(res, 200, skills.setEnabled(text(body, "id"), action === "enable")), true;
  if (action === "remove") { skills.remove(text(body, "id")); return send(res, 200, {}), true; }
  if (action === "add") return send(res, 200, typeof body.package === "string" ? await skills.install(text(body, "package")) : skills.addFound(text(body, "path"))), true;
  if (action === "search") return send(res, 200, { results: await skills.search(text(body, "query")) } satisfies SkillSearchResponse), true;
  if (action === "updates") return send(res, 200, await skills.updates()), true;
  return send(res, 200, await skills.update(text(body, "id"))), true;
}
