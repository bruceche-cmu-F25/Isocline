/** What the product was called before: Isocline (until 2026-11-24) and, before that, Alfred (until 2026-11-23). See
 * docs/design/rename-zirma.md §3.2 and rename-isocline.md §3.3–3.4. They are read so that an existing install keeps
 * working, newest name first: environment variables under the old prefixes, and secrets in the keychain under the old
 * service names. Nothing here writes an old name. */
import type { SecretStore } from "./secrets.ts";
import type { Stage } from "./stage.ts";

/** The product's earlier names, newest first. */
export const LEGACY_NAMES = ["Isocline", "Alfred"] as const;

/** The keychain services a stage's secrets used to be kept under, newest first. Only Isocline had a development
 * stage of its own; Alfred kept everything under one service, which was production's. */
export function legacyKeychainServices(stage: Stage): string[] {
  return stage === "production" ? [...LEGACY_NAMES] : ["Isocline Dev"];
}

/** `ISOCLINE_X`, else `ALFRED_X`, is taken as `ZIRMA_X` where that is not set. Call first, before anything reads the
 * environment. */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of LEGACY_NAMES) {
    const prefix = `${name.toUpperCase()}_`;
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefix) || value === undefined) continue;
      const renamed = `ZIRMA_${key.slice(prefix.length)}`;
      if (env[renamed] === undefined) env[renamed] = value;
    }
  }
}

/** A store that reads through to the old ones, newest first: a secret found only there is copied over the first time
 * it is read. The old copies are left as they are, so an older version of the app (or its home node, still running
 * while the new one takes over) keeps working; only deleting a secret also removes the old copies, so that it never
 * comes back from them. */
export function carryingOver(store: SecretStore, ...legacies: SecretStore[]): SecretStore {
  return {
    kind: store.kind,
    async get(name) {
      const value = await store.get(name);
      if (value !== undefined) return value;
      for (const legacy of legacies) {
        const old = await legacy.get(name).catch(() => undefined);
        if (old === undefined) continue;
        await store.set(name, old).catch(() => { /* read from the old place again next time */ });
        return old;
      }
      return undefined;
    },
    set: (name, value) => store.set(name, value),
    async delete(name) {
      await store.delete(name);
      for (const legacy of legacies) await legacy.delete(name).catch(() => {});
    },
  };
}
