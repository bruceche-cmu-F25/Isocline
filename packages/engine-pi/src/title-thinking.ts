/** How hard the model thinks while naming a conversation: as little as it can. Naming is a short classification
 * task, so thinking only adds latency and tokens (and a model left at its default may spend the whole token budget
 * thinking and write no title). The cheapest level the model supports; Gemini rejects "minimal", so it takes the
 * next one up.
 *
 * Adapted from pi-web's lib/session-title.ts `resolveTitleThinkingLevel` (https://github.com/agegr/pi-web, MIT,
 * © 2026 agegr). */
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export function titleThinkingLevel(model: Model<Api>): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  // getSupportedThinkingLevels lists levels in ascending cost order.
  const supported = getSupportedThinkingLevels(model);
  const rejectsMinimal = model.api === "google-generative-ai" || /gemini/i.test(model.id);
  const usable = rejectsMinimal ? supported.filter((level) => level !== "off" && level !== "minimal") : supported;
  return usable[0] ?? supported[0] ?? "off";
}
