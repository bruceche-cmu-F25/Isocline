/** Model credentials (API keys and subscription tokens) for Pi, in Zirma's own secret store
 * (docs/design/settings-and-connections.md §3.2): one entry, "models", holding every provider's
 * credential, shared by the home node (logins) and the engine workers (requests, token refreshes).
 *
 * Pi's contract: `modify` is the only write path and is serialised per provider, across processes
 * too, so an OAuth refresh in a worker never races a login in the home node. A lock directory next
 * to the data does that. Reads are cached for a moment, because a keychain read starts a process
 * and Pi checks every provider's credential when it lists available models.
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SecretStore } from "@zirma/core";

/** Pi's credential storage interface and records, as ModelRuntime takes them. */
export type CredentialStore = NonNullable<NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"]>;
export type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;

const ENTRY = "models";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CredentialStoreOptions {
  secrets: Pick<SecretStore, "get" | "set" | "delete">;
  /** Where the lock directory goes (the data directory). */
  lockDir: string;
  /** How long a read may be reused, in ms. */
  cacheMs?: number;
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  const lockPath = join(options.lockDir, "models.lock");
  const cacheMs = options.cacheMs ?? 2000;
  let cache: { at: number; data: Record<string, Credential> } | null = null;
  // Calls in this process take turns, then the lock directory serialises processes.
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (fresh = false): Promise<Record<string, Credential>> => {
    if (!fresh && cache && Date.now() - cache.at < cacheMs) return cache.data;
    const raw = await options.secrets.get(ENTRY);
    let data: Record<string, Credential> = {};
    if (raw) {
      try { data = JSON.parse(raw) as Record<string, Credential>; } catch { /* unreadable: treated as empty */ }
    }
    cache = { at: Date.now(), data };
    return data;
  };
  const save = async (data: Record<string, Credential>) => {
    if (Object.keys(data).length) await options.secrets.set(ENTRY, JSON.stringify(data));
    else await options.secrets.delete(ENTRY);
    cache = { at: Date.now(), data };
  };

  async function acquire(): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A process that died holding the lock leaves it behind; it is stale after a while.
        try { if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { rmSync(lockPath, { recursive: true, force: true }); continue; } } catch { continue; }
        if (Date.now() > deadline) throw new Error("Model credentials are busy in another Zirma process");
        await sleep(40);
      }
    }
  }
  function locked<T>(action: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      await acquire();
      try { return await action(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async read(providerId) {
      return (await load())[providerId];
    },
    async list() {
      return Object.entries(await load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn) {
      return locked(async () => {
        const data = await load(true);
        const next = await fn(data[providerId]);
        if (next !== undefined) await save({ ...data, [providerId]: next });
        return next ?? data[providerId];
      });
    },
    delete(providerId) {
      return locked(async () => {
        const data = await load(true);
        if (!(providerId in data)) return;
        const { [providerId]: _gone, ...rest } = data;
        await save(rest);
      });
    },
  };
}
