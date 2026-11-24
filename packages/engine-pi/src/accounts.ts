/** Model accounts on the home node: which providers Zirma can think with, and signing in to them
 * (docs/design/settings-and-connections.md §3.2).
 *
 * Pi does the signing in (`ModelRuntime.login`): browser OAuth with a loopback callback, device codes, API keys.
 * Its questions and links arrive through an AuthInteraction; here they become a sign-in record that a device
 * polls and answers. Credentials go to Zirma's own store (credentials.ts), never to Pi's auth.json.
 *
 * Pi's own setup can seed Zirma: API keys are copied on request. Subscriptions are not: some providers rotate
 * the refresh token on every refresh, so two programs sharing one would keep signing each other out. They are
 * listed so the user can sign in again here.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelAccountsResponse, ModelAuthMethod, ModelProvider, ModelSignIn, ModelSignInPrompt, ModelUsage, ModelUsageResponse } from "@zirma/protocol";
import type { Credential, CredentialStore } from "./credentials.ts";
import { hasUsage, readUsage, type UsageProvider } from "./usage.ts";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<Interaction["prompt"]>[0];
type AuthEvent = Parameters<Interaction["notify"]>[0];

const FLOW_TIMEOUT_MS = 15 * 60_000;
const KEEP_FINISHED_MS = 5 * 60_000;

export class ModelSignInError extends Error {
  override name = "ModelSignInError";
  readonly code: "unknown_provider" | "unsupported" | "missing" | "busy" | "state";
  constructor(code: ModelSignInError["code"], message: string) { super(message); this.code = code; }
}

export interface ModelAccountsOptions {
  store: CredentialStore;
  /** The data directory: this installation's id lives there. */
  dataDir: string;
  /** Pi's agent directory, for its custom models and to offer importing its keys; defaults to ~/.pi/agent. */
  piAgentDir?: string;
  /** Called after each change, for the world's audit trail. */
  onChange?(kind: "signed_in" | "signed_out" | "imported", provider: string, detail: Record<string, unknown>): void;
  log?(message: string): void;
  /** For reading subscription usage; tests pass their own. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const USAGE_CACHE_MS = 60_000;

interface Flow {
  state: ModelSignIn;
  abort: AbortController;
  /** The question waiting for an answer. */
  waiting: { id: string; resolve(value: string): void; reject(error: Error): void } | null;
  timer: NodeJS.Timeout;
}

const id = () => randomBytes(9).toString("base64url");

export class ModelAccounts {
  private readonly options: ModelAccountsOptions;
  private readonly piAgentDir: string;
  private readonly flows = new Map<string, Flow>();
  private readonly usageCache = new Map<string, { at: number; value: Promise<ModelUsage> }>();

  constructor(options: ModelAccountsOptions) {
    this.options = options;
    this.piAgentDir = options.piAgentDir ?? join(homedir(), ".pi", "agent");
  }

  /** A fresh runtime each time, so it sees credentials a worker refreshed or another sign-in wrote. */
  private runtime(): Promise<ModelRuntime> {
    const modelsPath = join(this.piAgentDir, "models.json");
    return ModelRuntime.create({ credentials: this.options.store, refreshOnCreate: false, ...(existsSync(modelsPath) ? { modelsPath } : { modelsPath: null }) });
  }

  /** This installation's stable id, which some providers ask for at sign-in. */
  private deviceId(): string {
    const path = join(this.options.dataDir, "install-id");
    try { const existing = readFileSync(path, "utf8").trim(); if (existing) return existing; } catch { /* first time */ }
    const fresh = randomBytes(16).toString("hex");
    writeFileSync(path, fresh);
    return fresh;
  }

  /** Pi's stored credentials by provider, as types only. Unreadable or absent: none. */
  private piCredentials(): Record<string, Credential> {
    const path = join(this.piAgentDir, "auth.json");
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Credential> : {};
    } catch {
      return {};
    }
  }

  async describe(): Promise<ModelAccountsResponse> {
    const runtime = await this.runtime();
    const stored = new Map((await this.options.store.list()).map((info) => [info.providerId, info.type]));
    const providers: ModelProvider[] = [];
    for (const provider of runtime.getProviders()) {
      const { oauth, apiKey } = provider.auth;
      // Only what a person can sign in to; providers reached only through ambient cloud credentials are left out.
      if (!oauth && !apiKey?.login) continue;
      const method = stored.get(provider.id);
      let status: ModelProvider["status"] = method ? { configured: true, method, source: "alfred" } : { configured: false };
      if (!method) {
        const check = await runtime.checkAuth(provider.id).catch(() => undefined);
        if (check) status = { configured: true, method: check.type, source: "environment" };
      }
      providers.push({
        id: provider.id,
        name: provider.name,
        oauth: oauth ? { label: oauth.loginLabel ?? oauth.name, subscription: Boolean(oauth.isSubscription) } : null,
        apiKey: Boolean(apiKey?.login),
        status,
        models: provider.getModels().length,
      });
    }
    const pi = this.piCredentials();
    const name = (providerId: string) => providers.find((provider) => provider.id === providerId)?.name ?? providerId;
    const offered = (providerId: string) => providers.some((provider) => provider.id === providerId) && !stored.has(providerId);
    return {
      providers,
      piKeys: Object.entries(pi).filter(([providerId, credential]) => credential?.type === "api_key" && importable(credential) && offered(providerId))
        .map(([providerId]) => ({ id: providerId, name: name(providerId) })),
      piSubscriptions: Object.entries(pi).filter(([providerId, credential]) => credential?.type === "oauth" && offered(providerId))
        .map(([providerId]) => ({ id: providerId, name: name(providerId) })),
    };
  }

  /** Starts signing in; the device polls `flow(id)` and answers its questions. */
  async start(providerId: string, method: ModelAuthMethod): Promise<ModelSignIn> {
    if (method !== "oauth" && method !== "api_key") throw new ModelSignInError("unsupported", "method is oauth or api_key");
    const runtime = await this.runtime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new ModelSignInError("unknown_provider", `Unknown provider: ${providerId}`);
    if (method === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login) throw new ModelSignInError("unsupported", `${provider.name} cannot sign in that way`);
    if ([...this.flows.values()].some((flow) => flow.state.status === "running")) throw new ModelSignInError("busy", "Another sign-in is in progress; finish or cancel it first");

    const flowId = id();
    const abort = new AbortController();
    const state: ModelSignIn = { id: flowId, provider: providerId, method, status: "running", steps: [], prompt: null };
    const flow: Flow = { state, abort, waiting: null, timer: setTimeout(() => this.cancel(flowId, "Sign-in timed out"), FLOW_TIMEOUT_MS) };
    flow.timer.unref();
    this.flows.set(flowId, flow);

    const interaction: Interaction = {
      signal: abort.signal,
      notify: (event: AuthEvent) => {
        const step = toStep(event);
        if (step) state.steps.push(step);
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        const promptId = id();
        const asked: ModelSignInPrompt = {
          id: promptId, type: prompt.type, message: prompt.message,
          ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
          ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
        };
        state.prompt = asked;
        flow.waiting = { id: promptId, resolve, reject };
        // The flow may withdraw a question, e.g. a pasted-code prompt when the browser callback won the race.
        prompt.signal?.addEventListener("abort", () => {
          if (flow.waiting?.id !== promptId) return;
          flow.waiting = null;
          state.prompt = null;
          reject(Object.assign(new Error("withdrawn"), { name: "AbortError" }));
        }, { once: true });
      }),
    };

    runtime.login(providerId, method, interaction, { agentName: "Zirma", getDeviceId: () => this.deviceId() }).then(
      () => {
        this.finish(flowId, { status: "done" });
        this.options.onChange?.("signed_in", providerId, { method });
        this.options.log?.(`models: signed in to ${provider.name} (${method === "oauth" ? "account" : "API key"})`);
      },
      (error: unknown) => {
        if (state.status !== "running") return;
        const message = error instanceof Error ? error.message : String(error);
        this.finish(flowId, abort.signal.aborted ? { status: "cancelled" } : { status: "failed", error: message });
        if (!abort.signal.aborted) this.options.log?.(`models: signing in to ${provider.name} failed: ${message}`);
      },
    );
    return state;
  }

  private finish(flowId: string, outcome: Pick<ModelSignIn, "status" | "error">): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.state.status !== "running") return;
    Object.assign(flow.state, outcome, { prompt: null });
    clearTimeout(flow.timer);
    setTimeout(() => this.flows.delete(flowId), KEEP_FINISHED_MS).unref();
  }

  flow(flowId: string): ModelSignIn | null {
    return this.flows.get(flowId)?.state ?? null;
  }

  answer(flowId: string, promptId: string, value: string): ModelSignIn {
    const flow = this.flows.get(flowId);
    if (!flow) throw new ModelSignInError("missing", "No such sign-in");
    if (flow.state.status !== "running" || flow.waiting?.id !== promptId) throw new ModelSignInError("state", "That question is no longer waiting");
    const { resolve } = flow.waiting;
    flow.waiting = null;
    flow.state.prompt = null;
    resolve(value);
    return flow.state;
  }

  cancel(flowId: string, reason?: string): ModelSignIn | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (flow.state.status === "running") {
      flow.waiting?.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      flow.waiting = null;
      flow.abort.abort();
      this.finish(flowId, reason ? { status: "failed", error: reason } : { status: "cancelled" });
    }
    return flow.state;
  }

  /** Forgets Zirma's credential for a provider. (A key in the environment still counts; it is not Zirma's to remove.) */
  async logout(providerId: string): Promise<ModelAccountsResponse> {
    const runtime = await this.runtime();
    await runtime.logout(providerId);
    this.options.onChange?.("signed_out", providerId, {});
    this.options.log?.(`models: signed out of ${providerId}`);
    return this.describe();
  }

  /** Copies API keys from Pi's setup. Commands (`!…`) and subscriptions are never copied. */
  async importFromPi(providerIds: readonly string[]): Promise<ModelAccountsResponse> {
    const pi = this.piCredentials();
    for (const providerId of providerIds) {
      const credential = pi[providerId];
      if (credential?.type !== "api_key" || !importable(credential)) continue;
      await this.options.store.modify(providerId, async (current) => current ?? { type: "api_key", ...(credential.key ? { key: credential.key } : {}), ...(credential.env ? { env: credential.env } : {}) });
      this.options.onChange?.("imported", providerId, { from: "pi" });
    }
    return this.describe();
  }

  /** How much of each signed-in subscription's plan is used. Each provider is asked at most once a minute unless
   * `fresh`; Pi refreshes an expiring token on the way (into Zirma's store, like a worker would). */
  async usage(fresh = false): Promise<ModelUsageResponse> {
    const signedIn = (await this.options.store.list()).filter((info) => info.type === "oauth" && hasUsage(info.providerId)).map((info) => info.providerId as UsageProvider);
    for (const providerId of this.usageCache.keys()) if (!signedIn.includes(providerId as UsageProvider)) this.usageCache.delete(providerId);
    if (!signedIn.length) return { usage: [] };
    const runtime = await this.runtime();
    const usage = await Promise.all(signedIn.map((providerId) => {
      const cached = this.usageCache.get(providerId);
      if (cached && !fresh && Date.now() - cached.at < USAGE_CACHE_MS) return cached.value;
      const value = (async (): Promise<ModelUsage> => {
        const resolved = await runtime.getAuth(providerId).catch(() => undefined);
        // Most give the token as a key; Kimi gives it as an Authorization header.
        const header = resolved?.auth.headers?.Authorization ?? resolved?.auth.headers?.authorization;
        const token = resolved?.auth.apiKey ?? (typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined);
        return token ? readUsage(providerId, token, this.options.fetch) : { provider: providerId, status: "failed", checkedAt: Date.now(), windows: [], error: "rejected" };
      })();
      this.usageCache.set(providerId, { at: Date.now(), value });
      // A failure is not kept: the next look asks again.
      void value.then((result) => { if (result.status === "failed") this.usageCache.delete(providerId); });
      return value;
    }));
    return { usage };
  }

  close(): void {
    for (const flowId of this.flows.keys()) this.cancel(flowId);
  }
}

/** A plain stored key (not a command Pi would run). */
function importable(credential: Credential): boolean {
  return credential.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0 && !credential.key.startsWith("!");
}

function toStep(event: AuthEvent): ModelSignIn["steps"][number] | null {
  switch (event.type) {
    case "auth_url": return { kind: "open_url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
    case "device_code": return { kind: "device_code", code: event.userCode, url: event.verificationUri, ...(event.expiresInSeconds ? { expiresIn: event.expiresInSeconds } : {}) };
    case "info": return { kind: "info", message: event.message, ...(event.links?.length ? { links: event.links.map((link) => ({ url: link.url, ...(link.label ? { label: link.label } : {}) })) } : {}) };
    case "progress": return { kind: "progress", message: event.message };
    default: return null;
  }
}
