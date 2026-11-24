/** What was called Alfred before the rename to Isocline (docs/design/rename-isocline.md §3.3–3.4), read so that an
 * existing install keeps working: environment variables under the old prefix, and secrets in the keychain under the
 * old service name. Nothing here writes the old names. */
import type { SecretStore } from "./secrets.ts";

/** The keychain service the secrets used to be kept under. */
export const LEGACY_KEYCHAIN_SERVICE = "Alfred";

/** `ALFRED_X` is taken as `ISOCLINE_X` where that is not set. Call first, before anything reads the environment. */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("ALFRED_") || value === undefined) continue;
    const renamed = `ISOCLINE_${key.slice("ALFRED_".length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
  }
}

/** A store that reads through to the old one: a secret found only there is copied over the first time it is read.
 * The old copy is left as it is, so an older version of the app (or its home node, still running while the new one
 * takes over) keeps working; only deleting a secret also removes the old copy, so that it never comes back from it. */
export function carryingOver(store: SecretStore, legacy: SecretStore): SecretStore {
  return {
    kind: store.kind,
    async get(name) {
      const value = await store.get(name);
      if (value !== undefined) return value;
      const old = await legacy.get(name).catch(() => undefined);
      if (old === undefined) return undefined;
      await store.set(name, old).catch(() => { /* read from the old place again next time */ });
      return old;
    },
    set: (name, value) => store.set(name, value),
    async delete(name) {
      await store.delete(name);
      await legacy.delete(name).catch(() => {});
    },
  };
}
