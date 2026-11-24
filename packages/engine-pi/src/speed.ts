/** Faster writing for a higher price, where the model's provider offers it (protocol fastSpeed): the worker passes
 * every request body through this just before it is sent, on a turn whose conversation asked for speed. */
import { fastSpeed } from "@isocline/protocol";

/** A request body asking its provider to write faster, where the model has a way (protocol fastSpeed); any other
 * model's request is sent as it was. */
export function fasterPayload(payload: unknown, model: { provider?: string; id?: string }): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const way = fastSpeed(model.provider, model.id);
  if (way === "anthropic") return { ...(payload as object), speed: "fast" };
  if (way === "openai") return { ...(payload as object), service_tier: "priority" };
  return payload;
}
