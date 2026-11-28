/** A new chat's title. A conversation starts named after the start of its first message (core titleFrom); once its
 * first reply is in, the engine is asked for a short title, written in the user's language, and it replaces that,
 * unless the user renamed the conversation meanwhile or said more. Tried once per conversation while the node runs;
 * a model that cannot answer leaves the first title. */
import { cleanTitle, untitledExchange, updateConversation, type EnginePort, type Run, type World } from "@zirma/core";

export function createTitler(world: World, engine: EnginePort, log?: (message: string) => void): (run: Run) => void {
  const tried = new Set<string>();
  return (run) => {
    if (!engine.title || run.state !== "completed" || run.automationId || tried.has(run.conversationId)) return;
    const exchange = untitledExchange(world, run.conversationId);
    if (!exchange) return;
    tried.add(run.conversationId);
    engine.title(exchange).then((text) => {
      const title = cleanTitle(text);
      // Still the same: one exchange and the first title. A rename or a second message wins.
      if (!title || !world.db.isOpen || !untitledExchange(world, run.conversationId)) return;
      updateConversation(world, run.conversationId, { title });
    }).catch((error: unknown) => log?.(`title for ${run.conversationId}: ${error instanceof Error ? error.message : String(error)}`));
  };
}
