/** Asking the Mac app for something only it can do (docs/design/dev-terminal-browser.md): today, what is on the page
 * in its browser pane. Zirma's tools run here, in the home node; the pane lives in the app. The app is a client like
 * any other, so it is the app that comes asking: it waits on `next` for a request, does it, and hands the answer back.
 *
 * Nothing is kept. A request nobody takes within its time fails, and with no app waiting it fails at once, so a tool
 * never hangs on a Mac app that is not running.
 */
import { randomBytes } from "node:crypto";

export interface DeskRequest { id: string; type: string; params: Record<string, unknown> }

export class DeskError extends Error {
  override name = "DeskError";
  readonly code: "absent" | "timeout" | "failed";
  constructor(code: DeskError["code"], message: string) { super(message); this.code = code; }
}

interface Waiting { request: DeskRequest; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** The app counts as there while it asked for work this recently. */
const PRESENT_MS = 40_000;

export class Desk {
  readonly #queue: Waiting[] = [];
  readonly #taken = new Map<string, Waiting>();
  #polls: Array<(request: DeskRequest | null) => void> = [];
  #seenAt = 0;

  /** The Mac app is running and asking for work. */
  get present(): boolean { return this.#polls.length > 0 || Date.now() - this.#seenAt < PRESENT_MS; }

  /** Asks the app; resolves with its answer. */
  ask<T>(type: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.present) return Promise.reject(new DeskError("absent", "The Mac app is not running"));
    return new Promise<T>((resolve, reject) => {
      const request: DeskRequest = { id: randomBytes(9).toString("base64url"), type, params };
      const waiting: Waiting = {
        request, resolve: resolve as (value: unknown) => void, reject,
        timer: setTimeout(() => {
          this.#taken.delete(request.id);
          const at = this.#queue.indexOf(waiting);
          if (at >= 0) this.#queue.splice(at, 1);
          reject(new DeskError("timeout", "The Mac app did not answer"));
        }, timeoutMs),
      };
      const poll = this.#polls.shift();
      if (poll) { this.#taken.set(request.id, waiting); poll(request); } else this.#queue.push(waiting);
    });
  }

  /** The app waits here for the next request, up to `waitMs`; null when none came. */
  next(waitMs: number, signal?: AbortSignal): Promise<DeskRequest | null> {
    this.#seenAt = Date.now();
    const queued = this.#queue.shift();
    if (queued) { this.#taken.set(queued.request.id, queued); return Promise.resolve(queued.request); }
    return new Promise((resolve) => {
      const done = (request: DeskRequest | null) => {
        clearTimeout(timer);
        this.#polls = this.#polls.filter((poll) => poll !== done);
        this.#seenAt = Date.now();
        resolve(request);
      };
      const timer = setTimeout(() => done(null), waitMs);
      signal?.addEventListener("abort", () => done(null), { once: true });
      this.#polls.push(done);
    });
  }

  /** The app's answer to a request it took. False when that request is no longer waited for. */
  answer(id: string, outcome: { ok: true; result: unknown } | { ok: false; error: string }): boolean {
    const waiting = this.#taken.get(id);
    if (!waiting) return false;
    this.#taken.delete(id);
    clearTimeout(waiting.timer);
    if (outcome.ok) waiting.resolve(outcome.result);
    else waiting.reject(new DeskError("failed", outcome.error.slice(0, 300)));
    return true;
  }

  close(): void {
    for (const waiting of [...this.#queue, ...this.#taken.values()]) { clearTimeout(waiting.timer); waiting.reject(new DeskError("absent", "The home node is stopping")); }
    this.#queue.length = 0;
    this.#taken.clear();
    for (const poll of [...this.#polls]) poll(null);
  }
}

/** What the app says is in its browser pane. */
export interface BrowserPage {
  /** The pane is open on a page. */
  open: boolean;
  url?: string;
  title?: string;
  loading?: boolean;
  /** The page's visible text, cut at a length. */
  text?: string;
  /** What the page logged as warnings and errors, newest last. */
  console?: string[];
}

/** Addresses on this machine: the user's own app under development. Anything else is someone's website. */
export function isLocalPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch { return false; }
}
