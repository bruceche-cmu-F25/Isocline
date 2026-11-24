import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { World } from "@isocline/core";
import type { WebLockStatus } from "@isocline/protocol";
import { Fault, HttpError } from "./wire.ts";

export const WEB_LOCK_IDLE_MS = 15 * 60_000;
export const WEB_SESSION_COOKIE = "__Host-isocline_unlock";
/** Its name before the rename: an unlocked browser stays unlocked until that session ends. */
export const LEGACY_WEB_SESSION_COOKIE = "__Host-alfred_unlock";
const ATTEMPT_WINDOW_MS = 5 * 60_000;
const ERROR_LOCKED = () => new HttpError(423, "Unlock this browser to use Isocline.", "web_locked");
const ERROR_THROTTLED = () => new HttpError(429, "Too many unlock attempts. Try again later.", "rate_limited");

interface Verifier { salt: Buffer; hash: Buffer }
interface Session { token: string; expiresAt: number; timer: NodeJS.Timeout }

// scrypt v1: 128 MiB per check. Limit the number of simultaneous checks below.
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
    (error, result) => error ? reject(new Fault(error)) : resolve(result)));
}

function readVerifier(world: World): Verifier | null | "damaged" {
  const row = world.db.prepare("SELECT salt, verifier FROM core_web_lock WHERE id = 1").get();
  if (row?.salt === null && row.verifier === null) return null;
  if (!(row?.salt instanceof Uint8Array) || row.salt.length !== 16 || !(row.verifier instanceof Uint8Array) || row.verifier.length !== 32) return "damaged";
  return { salt: Buffer.from(row.salt), hash: Buffer.from(row.verifier) };
}

/** Pairing survives restarts; unlocked sessions live only on this running home node. */
export class WebLock {
  readonly #world: World;
  readonly #changed: (deviceId: string | null) => void;
  readonly #sessions = new Map<string, Session>();
  readonly #checking = new Map<string, { revoked: boolean }>();
  // Small rolling window shared by all paired devices; each admitted attempt counts before hashing starts.
  #attempts: { id: string; time: number }[] = [];
  #verifier: Verifier | null | "damaged";
  #configuring = false;

  constructor(world: World, changed: (deviceId: string | null) => void) {
    this.#world = world;
    this.#changed = changed;
    this.#verifier = readVerifier(world);
  }

  get enabled(): boolean { return this.#verifier !== null; }

  async configure(enabled: boolean, password?: unknown): Promise<void> {
    if (this.#configuring) throw new HttpError(409, "Web lock settings are being updated.");
    this.#configuring = true;
    try {
      let verifier: Verifier | null = null;
      if (enabled) {
        const length = typeof password === "string" ? [...password].length : 0;
        if (typeof password !== "string" || length < 12 || length > 128) {
          throw new HttpError(400, "Use a password of 12 to 128 characters.", "password_length");
        }
        const salt = randomBytes(16);
        verifier = { salt, hash: await derive(password, salt) };
      }
      this.#world.tx((db) => db.prepare("INSERT OR REPLACE INTO core_web_lock (id, salt, verifier) VALUES (1, ?, ?)")
        .run(verifier?.salt ?? null, verifier?.hash ?? null));
      this.#verifier = verifier;
      this.#attempts = [];
      for (const session of this.#sessions.values()) clearTimeout(session.timer);
      this.#sessions.clear();
      this.#changed(null);
    } finally {
      this.#configuring = false;
    }
  }

  status(id: string, token: string): WebLockStatus {
    if (!this.enabled) return { enabled: false, locked: false, expiresAt: null };
    const session = this.#sessions.get(id);
    if (session && session.expiresAt <= Date.now()) this.#endSession(id);
    else if (session && session.token === token) return { enabled: true, locked: false, expiresAt: session.expiresAt };
    return { enabled: true, locked: true, expiresAt: null };
  }

  async unlock(id: string, password: unknown): Promise<string | null> {
    const verifier = this.#verifier;
    if (verifier === null) return null;
    if (verifier === "damaged") throw new HttpError(503, "Reset the web password on the home Mac.", "web_lock_unavailable");
    if (typeof password !== "string" || [...password].length > 128) throw new HttpError(400, "Invalid password input.");
    const now = Date.now();
    this.#attempts = this.#attempts.filter((attempt) => attempt.time > now - ATTEMPT_WINDOW_MS);
    if (this.#checking.has(id) || this.#checking.size >= 2 || this.#attempts.length >= 20 || this.#attempts.filter((attempt) => attempt.id === id).length >= 5) {
      throw ERROR_THROTTLED();
    }
    this.#attempts.push({ id, time: now });
    const check = { revoked: false };
    this.#checking.set(id, check);
    try {
      const hash = await derive(password, verifier.salt);
      if (check.revoked) throw new HttpError(401, "Pair this browser again.", "unpaired");
      if (verifier !== this.#verifier) throw ERROR_LOCKED();
      if (!timingSafeEqual(hash, verifier.hash)) throw new HttpError(401, "Incorrect Isocline password.", "wrong_password");
      this.#attempts = this.#attempts.filter((attempt) => attempt.id !== id);
      this.#endSession(id);
      const token = randomBytes(32).toString("base64url");
      // Re-arm the timeout on input. Status also checks the wall clock after sleep or timer suspension.
      const timer = setTimeout(() => this.#endSession(id), WEB_LOCK_IDLE_MS).unref();
      this.#sessions.set(id, { token, expiresAt: Date.now() + WEB_LOCK_IDLE_MS, timer });
      return token;
    } finally {
      this.#checking.delete(id);
    }
  }

  activity(id: string, token: string): WebLockStatus {
    const state = this.status(id, token);
    if (state.locked) throw ERROR_LOCKED();
    if (!state.enabled) return state;
    const session = this.#sessions.get(id)!;
    session.expiresAt = Date.now() + WEB_LOCK_IDLE_MS;
    session.timer.refresh();
    return { ...state, expiresAt: session.expiresAt };
  }

  revoke(id: string): void {
    const check = this.#checking.get(id);
    if (check) check.revoked = true;
    this.#endSession(id);
  }

  #endSession(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    this.#sessions.delete(id);
    this.#changed(id);
  }
}
