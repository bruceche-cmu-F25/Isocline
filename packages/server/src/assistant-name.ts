/** The assistant's name in what the home node writes itself (notifications, a proposal's words): the shared
 * dictionary (@zirma/ui/i18n) fills `{assistant}` from it. Set when the node opens and whenever the settings change. */
import { assistantNameOf, getSettings, type World } from "@zirma/core";
import { setAssistant } from "@zirma/ui/i18n";

export function syncAssistantName(world: World): string {
  const name = assistantNameOf(getSettings(world));
  setAssistant(name);
  return name;
}
