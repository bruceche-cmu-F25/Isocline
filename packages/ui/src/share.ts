/** `next`, with every part of it that says the same as in `before` being the very object `before` had.
 *
 * The state is read again whenever something happened, and most of it says what it said before. Keeping the old
 * objects where nothing changed lets React (and anything that compares by identity: an effect's dependencies, a
 * memo) see that, instead of a tree of new objects that all look changed. Lists of things with an `id` are matched
 * by it, so one new item at the top does not make every item after it new.
 *
 * Only JSON's shapes (objects, arrays, plain values), which is all the home node sends.
 */
export function shared<T>(before: unknown, next: T): T {
  if (before === next || before === null || next === null || typeof before !== "object" || typeof next !== "object") return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(before)) return next;
    const byId = new Map<string, unknown>();
    for (const item of before) { const id = idOf(item); if (id !== undefined) byId.set(id, item); }
    let same = before.length === next.length;
    const out = next.map((item, index) => {
      const id = idOf(item);
      const kept = shared(id !== undefined && byId.has(id) ? byId.get(id) : before[index], item);
      if (kept !== before[index]) same = false;
      return kept;
    });
    return (same ? before : out) as T;
  }
  if (Array.isArray(before)) return next;
  const was = before as Record<string, unknown>, now = next as Record<string, unknown>;
  const keys = Object.keys(now);
  let same = Object.keys(was).length === keys.length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = shared(was[key], now[key]);
    if (out[key] !== was[key] || !Object.hasOwn(was, key)) same = false;
  }
  return (same ? before : out) as T;
}

const idOf = (item: unknown): string | undefined => {
  const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : undefined;
};
