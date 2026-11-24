/** The client side of @isocline/protocol. Every write carries a request id, so a
 * retry after a dropped connection can never do the same thing twice.
 */
import type { Area, Preference,
  ArchivedConversation, Automation, AutomationHistory, RunSources, Schedule,
  Conversation, ConversationDetail, CoreEvent, DeviceInfo, FileInfo, DeviceKind, DeviceScopeRequest, LiveUpdate, ModelsResponse, Notice, OpResponse, PairingCode, ProposalResponse,
  Project, ProjectBranches, StartSessionRequest, SessionBranch, SessionChanges, SessionMode, SessionProcess, SessionProcesses, SessionPublished, SessionPullRequest, PushInfo, PushResult, RemoteResponse, Run, StateResponse, SubmitRunResponse, ThinkingLevel, UserSettings, SettingsRequest, ViewContext, VoiceStatus, WebLockStatus,
} from "@isocline/protocol";
import "./desktop.ts";
import type { OpName } from "./modules.ts";
import { t } from "./i18n/dict.ts";

/** The options every automation has (core automations.ts). */
export type AutomationOptions = Pick<Automation, "layout" | "keep" | "notify" | "k">;

const DEVICE_KEY = "isocline.device";

function random(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/** The name this window is handed notices under: the Mac app's when inside it,
 * otherwise this browser's, kept in localStorage when it can be (so its tabs share it).
 */
export const deviceId: string = (() => {
  if (window.alfredDesktop?.deviceId) return window.alfredDesktop.deviceId;
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[A-Za-z0-9._:-]{1,40}$/.test(stored)) return stored;
    const id = `web-${random()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return `web-${random()}`;
  }
})();

export const newRequestId = () => `${deviceId}.${random()}`;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** How many, when the refusal is about a number of things (files a worktree has not committed). */
  readonly count?: number;
  constructor(status: number, message: string, code?: string, count?: number) { super(message); this.status = status; this.code = code; this.count = count; }
}

/** This device is not paired with the home node (it came in through Tailscale without a device token). */
export const isUnpaired = (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === "unpaired";

/** The home node's answer: its JSON, or an ApiError with what it refused and why. */
async function answer<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { error, code, count } = body as { error?: string; code?: string; count?: number };
    if (response.status === 423 && code === "web_locked") window.dispatchEvent(new Event("isocline:web-locked"));
    throw new ApiError(response.status, error ?? t("api.failed", { status: response.status }), code, typeof count === "number" ? count : undefined);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // Network failures are retried with the same body (and so the same request id).
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (attempt >= 2) throw new ApiError(0, t("api.unreachable"));
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    return answer<T>(response);
  }
}

const post = <T>(path: string, body: unknown) => call<T>(path, json(body));

/** Translate the home's expiry to this browser's clock; the device clock may be hours off. */
async function webLockRequest(path: string, body?: unknown): Promise<WebLockStatus> {
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(path, { ...(body === undefined ? {} : json(body)), cache: "no-store", signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new ApiError(0, t("api.unreachable"));
  }
  const status = await answer<WebLockStatus>(response);
  if (typeof status?.enabled !== "boolean" || typeof status.locked !== "boolean") {
    throw new ApiError(0, t("webLock.unavailable"));
  }
  if (!status.enabled || status.locked) {
    if (status.expiresAt !== null || (!status.enabled && status.locked)) throw new ApiError(0, t("webLock.unavailable"));
    return status;
  }
  const serverTime = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(serverTime) || !Number.isFinite(status.expiresAt) || status.expiresAt === null) {
    throw new ApiError(0, t("webLock.unavailable"));
  }
  // HTTP dates are rounded down to a second. Cover a little early, including time in transit.
  const remaining = Math.min(15 * 60_000, status.expiresAt - serverTime - 1000) - (performance.now() - start);
  return { ...status, expiresAt: Date.now() + Math.max(0, remaining) };
}

/** One request to the home node from outside the commands below (the settings pages, the terminal): a GET, or a POST
 * when there is a body. Sent once, never again by itself: these carry no request id, so a second sending could be a
 * second doing. Fails with an ApiError, as the commands do. */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? undefined : json(body));
  } catch {
    throw new ApiError(0, t("api.unreachable"));
  }
  return answer<T>(response);
}

export const api = {
  /** `have`: the revisions of the module snapshots this device already holds (the last state's `revisions`); the
   * home node leaves those snapshots out when they still say the same. `have: null`: no snapshots at all. */
  state: (have?: Readonly<Record<string, string>> | null) => {
    const held = have ? Object.entries(have).map(([id, revision]) => `${encodeURIComponent(id)}.${encodeURIComponent(revision)}`).join(",") : "";
    return call<StateResponse>(`/api/state${have === null ? "?modules=0" : held ? `?have=${held}` : ""}`);
  },
  /** Without a conversation id, the run starts a new conversation. `context`: the page it was asked from. */
  submit: (goal: string, conversationId?: string, context?: ViewContext, attachments?: string[]) =>
    post<SubmitRunResponse>("/api/runs", { requestId: newRequestId(), goal, ...(conversationId ? { conversationId } : {}), ...(context ? { context } : {}), ...(attachments?.length ? { attachments } : {}) }),
  /** A file for the next message: kept on the home node, which says what it is (an image, a PDF, text) or refuses it. */
  upload: (file: Blob, name: string) => call<FileInfo>(`/api/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }),
  archivedConversations: () => call<{ conversations: ArchivedConversation[] }>("/api/conversations/archived"),
  conversation: (id: string, query?: { before: string } | { runs: string[] }) => {
    const suffix = !query ? "" : "before" in query ? `?before=${encodeURIComponent(query.before)}` : `?runs=${query.runs.map(encodeURIComponent).join(",")}`;
    return call<ConversationDetail>(`/api/conversations/${id}${suffix}`);
  },
  readConversationReply: (id: string, runId: string) => post<Record<string, never>>(`/api/conversations/${id}/read`, { runId }),
  /** `worktree`: what to do with a session's worktree that has uncommitted changes, when archiving it. */
  updateConversation: (id: string, change: { title?: string; archived?: boolean; model?: string | null; thinking?: ThinkingLevel | null; speed?: "fast" | null; mode?: SessionMode; forgetCommand?: string; worktree?: "keep" | "discard"; archiveRuns?: "finish" | "stop" }) =>
    post<Conversation>(`/api/conversations/${id}`, { requestId: newRequestId(), ...change }),
  /** Words into the run now working; rejects with 409 when it is not. */
  steer: (runId: string, text: string) => post<{ delivered: boolean }>(`/api/runs/${runId}/steer`, { text }),
  models: () => call<ModelsResponse>("/api/models"),
  /** Only on the home node's machine. */
  addProject: (path: string) => post<Project>("/api/projects", { requestId: newRequestId(), path }),
  trustProject: (id: string) => post<Project>(`/api/projects/${id}/trust`, { requestId: newRequestId() }),
  projectBranches: (id: string) => call<ProjectBranches>(`/api/projects/${id}/branches`),
  startSession: (input: Omit<StartSessionRequest, "requestId">) =>
    post<Conversation>("/api/conversations", { requestId: newRequestId(), ...input }),
  /** A development session's changed files since its snapshot, and one file's diff. */
  changes: (id: string) => call<SessionChanges>(`/api/conversations/${id}/changes`),
  diff: (id: string, path: string) => call<{ diff: string | null }>(`/api/conversations/${id}/diff?path=${encodeURIComponent(path)}`),
  /** Where its branch stands, and its pull request (which asks GitHub). */
  branch: (id: string) => call<SessionBranch>(`/api/conversations/${id}/branch`),
  pullRequest: (id: string) => call<SessionPullRequest>(`/api/conversations/${id}/pr`),
  commitPreview: (id: string, paths: string[]) => post<{ token: string; patch: string }>(`/api/conversations/${id}/commit-preview`, { paths }),
  /** Submit the exact selection displayed in the commit card. */
  commit: (id: string, message: string, paths: string[], token: string) => post<Conversation>(`/api/conversations/${id}/commit`, { requestId: newRequestId(), message, paths, token }),
  /** Pushes its branch and opens a pull request (or updates the open one). Outward: the user is asked first. */
  publish: (id: string, title: string, body: string) => post<SessionPublished>(`/api/conversations/${id}/publish`, { requestId: newRequestId(), title, body }),
  processes: (id: string) => call<SessionProcesses>(`/api/conversations/${id}/processes`),
  startProcess: (id: string, command: string) => post<SessionProcess>(`/api/conversations/${id}/processes`, { command }),
  stopProcess: (id: string, processId: string) => post<Record<string, never>>(`/api/conversations/${id}/processes/${processId}/stop`, {}),
  /** `seen`: the `printed` of the last reading; with nothing printed since, the answer is `unchanged` and has no text. */
  processLogs: (id: string, processId: string, seen?: number) => call<{ process: SessionProcess; text: string; printed?: number; unchanged?: true }>(
    `/api/conversations/${id}/processes/${processId}/logs${seen === undefined ? "" : `?seen=${seen}`}`),
  respond: (runId: string, requestId: string, answer: string) => post<Run>(`/api/runs/${runId}/respond`, { requestId, answer }),
  run: (runId: string) => call<{ run: Run }>(`/api/runs/${runId}`),
  /** What an automation's run actually read (its calendar, todos and opened mail), for a result shown in sections. */
  runSources: (runId: string) => call<{ evidence: RunSources | null }>(`/api/runs/${encodeURIComponent(runId)}/sources`),
  cancel: (runId: string) => post<Run>(`/api/runs/${runId}/cancel`, { requestId: newRequestId() }),
  resume: (runId: string) => post<Run>(`/api/runs/${runId}/resume`, { requestId: newRequestId() }),
  op: (op: OpName, input: unknown, requestId = newRequestId()) => post<OpResponse>(`/api/ops/${op}`, { requestId, input }),
  present: (id: string) => post<Notice>(`/api/notices/${id}/present`, { client: deviceId }),
  acknowledge: (id: string) => post<Notice>(`/api/notices/${id}/acknowledge`, {}),
  /** What this window sees (is it being looked at, when was it last used), for the home node to decide who tells the
   * user what; not recorded. `keepalive`: "not looking any more" still gets out when a phone puts the page away. */
  outlet: (attending: boolean, idleMs: number) => call<Record<string, never>>("/api/outlets", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: deviceId, kind: "window", attending, idleMs }),
  }),
  /** The user's decision on a proposal. A retry with the same request id gets the same answer. */
  accept: (id: string, requestId = newRequestId()) => post<ProposalResponse>(`/api/proposals/${id}/accept`, { requestId }),
  decline: (id: string) => post<ProposalResponse>(`/api/proposals/${id}/decline`, { requestId: newRequestId() }),
  /** `context`: the page it was changed from and what was picked there, as with a question. */
  revise: (id: string, text: string, context?: ViewContext) => post<ProposalResponse>(`/api/proposals/${id}/revise`, { requestId: newRequestId(), text, ...(context ? { context } : {}) }),
  /** The user's preferences that are not secrets, shared by every device (for now, the language). */
  settings: (patch: SettingsRequest["patch"]) => post<UserSettings>("/api/settings", { requestId: newRequestId(), patch }),
  /** A module's read that is too big for the state (one mail's body). */
  query: <T>(name: string, input: unknown) => post<{ result: T }>(`/api/queries/${name}`, { input }).then((response) => response.result),
  /** Refresh a module's mirror of an outside service now; resolves when it has been read. */
  syncModule: (id: string) => post<Record<string, never>>(`/api/modules/${id}/sync`, {}),
  /** The user's areas: each answers with the whole list, in order. `moveTo`: where what was in a removed one goes. */
  addArea: (name: string, k?: string) => post<{ areas: Area[] }>("/api/areas", { requestId: newRequestId(), name, ...(k ? { k } : {}) }),
  updateArea: (id: string, patch: { name?: string; k?: string }) => post<{ areas: Area[] }>(`/api/areas/${id}`, { requestId: newRequestId(), patch }),
  moveArea: (id: string, index: number) => post<{ areas: Area[] }>(`/api/areas/${id}/move`, { requestId: newRequestId(), index }),
  removeArea: (id: string, moveTo: string | null) => post<{ areas: Area[] }>(`/api/areas/${id}/delete`, { requestId: newRequestId(), moveTo }),
  /** What the user said about how they like things; each answers with the whole list. */
  addPreference: (text: string) => post<{ preferences: Preference[] }>("/api/preferences", { requestId: newRequestId(), text }),
  updatePreference: (id: string, text: string) => post<{ preferences: Preference[] }>(`/api/preferences/${id}`, { requestId: newRequestId(), text }),
  removePreference: (id: string) => post<{ preferences: Preference[] }>(`/api/preferences/${id}/delete`, { requestId: newRequestId() }),
  /** Automations: make one, change it (or switch it on and off), run it now, delete it. */
  createAutomation: (input: { name: string; goal: string; schedule: Schedule; enabled?: boolean } & Partial<AutomationOptions>) =>
    post<Automation>("/api/automations", { requestId: newRequestId(), ...input }),
  updateAutomation: (id: string, patch: { name?: string; goal?: string; schedule?: Schedule; enabled?: boolean } & Partial<AutomationOptions>) =>
    post<Automation>(`/api/automations/${id}`, { requestId: newRequestId(), patch }),
  automationRuns: (id: string, before?: string) => call<AutomationHistory>(`/api/automations/${id}/runs${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  runAutomation: (id: string) => post<Run>(`/api/automations/${id}/run`, { requestId: newRequestId() }),
  deleteAutomation: (id: string) => post<Record<string, never>>(`/api/automations/${id}/delete`, { requestId: newRequestId() }),
  /** Remote access and devices: on this machine the switch and the list, on another device just itself. */
  remote: () => call<RemoteResponse>("/api/remote"),
  setRemote: (enabled: boolean) => post<RemoteResponse>("/api/remote", { enabled }),
  webLock: () => webLockRequest("/api/device/web-lock"),
  unlockWeb: (password: string) => webLockRequest("/api/device/unlock", { password }),
  webActivity: () => webLockRequest("/api/device/activity", {}),
  setWebLock: (enabled: boolean, password?: string) => request<RemoteResponse>("/api/remote/web-lock", { enabled, password }),
  pairingCode: () => post<PairingCode>("/api/remote/pairing", {}),
  revokeDevice: (id: string) => post<RemoteResponse>(`/api/devices/${id}/revoke`, {}),
  /** Lets a device into development sessions, or takes that away (this machine only). */
  deviceScope: (id: string, change: DeviceScopeRequest) => post<RemoteResponse>(`/api/devices/${id}/scope`, change),
  requestDevAccess: () => post<Extract<RemoteResponse, { local: false }>>("/api/device/request-dev", {}),
  /** On a device that is not paired yet: the home node answers with the device token in a cookie. */
  pair: (code: string, name: string, kind: DeviceKind) => post<{ device: DeviceInfo }>("/api/pair", { code, name, kind }),
  forgetDevice: () => post<Record<string, never>>("/api/device/forget", {}),
  /** Push notifications for this (paired) device. */
  pushInfo: () => call<PushInfo>("/api/push"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => post<PushInfo>("/api/push/subscribe", { subscription }),
  pushUnsubscribe: () => post<PushInfo>("/api/push/unsubscribe", {}),
  pushTest: () => post<PushResult>("/api/push/test", {}),
  /** Speech to text on the home node: start loading the model (someone began talking), then send the recording. */
  voiceWarm: () => post<{ loaded: boolean }>("/api/voice/warm", {}),
  transcribe: (wav: Blob) => call<{ text: string; ms: number }>("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav }),
  /** Text to speech: what voices there are, and which is used now. */
  voice: () => call<VoiceStatus>("/api/voice"),
  /** The words as a WAV, in the user's voice and pace unless these say otherwise. */
  speak: async (text: string, voice?: string, rate?: number): Promise<Blob> => {
    const response = await fetch("/api/voice/speak", json({ text, ...(voice ? { voice } : {}), ...(rate ? { rate } : {}) }));
    if (!response.ok) return answer<never>(response);
    return response.blob();
  },
  speakWarm: () => post<Record<string, never>>("/api/voice/speak/warm", {}),
  /** A speech service's key, kept on the home node once the service has taken it (only from that machine). */
  voiceServiceKey: (service: string, key: string) => call<VoiceStatus["speak"]>(`/api/voice/services/${service}/key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }),
  voiceServiceForget: (service: string) => call<VoiceStatus["speak"]>(`/api/voice/services/${service}/key`, { method: "DELETE" }),
  /** Download and load the local voice model. */
  voiceModel: () => post<VoiceStatus["speak"]>("/api/voice/model", {}),
};

export type Connection = "connecting" | "live" | "reconnecting";

/** Follows the event stream from `after`. EventSource resumes from the last
 * id it saw on its own after a drop.
 */
export function subscribe(
  after: number,
  handlers: { event(event: CoreEvent): void; live(update: LiveUpdate): void; connection(state: Connection): void },
): () => void {
  const source = new EventSource(`/api/events?after=${after}&delta=1`);
  source.addEventListener("open", () => handlers.connection("live"));
  source.addEventListener("error", () => handlers.connection("reconnecting"));
  source.addEventListener("core", (message) => handlers.event(JSON.parse((message as MessageEvent<string>).data) as CoreEvent));
  source.addEventListener("live", (message) => handlers.live(JSON.parse((message as MessageEvent<string>).data) as LiveUpdate));
  return () => source.close();
}
