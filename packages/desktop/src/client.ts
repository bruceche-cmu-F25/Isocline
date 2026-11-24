/** The Mac app's own connection to the home node: it is one device among
 * others and speaks only the public protocol.
 */
import type { StateResponse } from "@zirma/protocol";

/** Events that are only a run's own progress. Inside a payload the quotes are escaped, so this is the event's kind. */
const QUIET = /"kind":"run\.(step|usage)"/;

export class HomeClient {
  readonly base: string;
  connected = false;
  private stopped = false;

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  /** Without the modules' snapshots (a calendar, an inbox): the app itself reads what waits, not those. */
  async state(): Promise<StateResponse> {
    const response = await fetch(`${this.base}/api/state?modules=0`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`state: ${response.status}`);
    return await response.json() as StateResponse;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error((value as { error?: string }).error ?? `HTTP ${response.status}`), { status: response.status });
    return value as T;
  }

  /** Calls `onChange` (debounced) whenever the world changes, and
   * `onConnection` when the stream drops or returns. Reconnects by itself.
   */
  follow(onChange: () => void, onConnection: (connected: boolean) => void): () => void {
    let lastId = "";
    let timer: NodeJS.Timeout | null = null;
    let controller: AbortController | null = null;
    const changed = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; onChange(); }, 150);
    };
    const setConnected = (value: boolean) => {
      if (this.connected === value) return;
      this.connected = value;
      onConnection(value);
    };
    const loop = async () => {
      while (!this.stopped) {
        controller = new AbortController();
        try {
          const response = await fetch(`${this.base}/api/events`, { headers: lastId ? { "Last-Event-ID": lastId } : {}, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
          setConnected(true);
          changed();
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const id = block.split("\n").find((line) => line.startsWith("id: "));
              // A step of a run's work (and what it spent) changes nothing the app reads from the state.
              if (id) { lastId = id.slice(4); if (!QUIET.test(block)) changed(); }
            }
          }
        } catch {
          // dropped; retry below
        }
        setConnected(false);
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void loop();
    return () => { this.stopped = true; controller?.abort(); if (timer) clearTimeout(timer); };
  }
}
