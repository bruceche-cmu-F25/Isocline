/** The client protocol over HTTP (see @alfred/protocol), plus the UI's files.
 *
 * Two listeners, both on loopback:
 * - the local port, for this machine (the Mac app, a browser here): it accepts requests only for a loopback Host
 *   (DNS-rebinding defence) and, when a browser sends an Origin, only from itself; everything is allowed.
 * - the ingress port (remote.ts), which only Tailscale Serve forwards to: every request is another device's and,
 *   apart from the UI's files and pairing, needs a paired device's token. Devices cannot touch credentials,
 *   remote access or other devices; those stay on this machine.
 *
 * A device's commands are not written out here. A module's are its operations (`/api/ops/<name>`); the harness's own
 * are in commands.ts, and each address below that changes something only names one of them.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import {
  listAreas, listPreferences, getSettings, listOpenProposals, userLocale, withCoreContext, listAutomations, type Locale, type World,
  acknowledgeNotice, answerRequest, claimNotice, getConversation, markConversationReplyRead, getRun, listAutomationRuns, getAutomation, latestEventSeq, listConversations, listArchivedConversations, listEvents, listNotices,
  listRunActivity, listRunReceipts, listRuns, conversationRuns, presentNotice, reportPresence, submitRun,
  deviceForToken, listDevices, requestDevAccess, DEVICE_KINDS, DEVICE_SCOPES, type Device, type DeviceKind, type DeviceScope, type LiveUpdate,
  getProject, listProjects, getFile, listRunFiles, requireOpenSession, isSession, runInSession, sessionEvent, sessionIds, sessionRoot,
} from "@alfred/core";
import { invokeOp, runQuery } from "@alfred/module-kit";
import type {
  ConversationDetail, CoreEvent, ModelsResponse, NoticeRequest, OpRequest, OutletReport, OutletsResponse, PairRequest, PresenceRequest, ProposalResponse, PushInfo, PushResult,
  RemoteResponse, RespondRequest, StateResponse, SteerRequest, LiveUpdate as WireLiveUpdate, SubmitRunRequest, SessionBranch, SessionChanges, SessionProcesses, SessionPullRequest,
} from "@alfred/protocol";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import type { Home } from "./home.ts";
import { DEVELOPER_PROFILE } from "./profiles.ts";
import { command, profileFor, sessionWrites } from "./commands.ts";
import { handleConnections, MODEL_USAGE_PATH } from "./connections-http.ts";
import { handleSkills } from "./skills-http.ts";
import { sourcesToday, runSources } from "./run-sources.ts";
import { reviewCommit } from "./commit-review.ts";
import { branchState, pullRequest, workspaceChanges, workspaceDiff } from "./workspace.ts";
import type { GoogleConnections } from "./google.ts";
import type { McpConnectors, ModelAccounts, Skills } from "@alfred/engine-pi";
import { DEVICE_COOKIE, type RemoteAccess } from "./remote.ts";
import { WEB_SESSION_COOKIE, type WebLock } from "./web-lock.ts";
import type { PushService } from "./push.ts";
import { MAX_VOICE_BYTES, type Transcriber } from "./voice.ts";
import { MAX_FILE_BYTES } from "./files.ts";
import { encodingFor, HttpError, overTheWire, pack, parseObject, readBytes, readJson, send, statusOf, type Encoding } from "./wire.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
/** A year and a bit; revoking on the Mac ends it sooner. */
const COOKIE_MAX_AGE = 400 * 24 * 3600;

/** Who is asking: this machine, or another device (paired or not) that came through Tailscale Serve. */
type Peer = { local: true } | { local: false; device: Device | null; login: string | null };

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? "";
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  return !!match && LOOPBACK_HOSTS.has(match[1].toLowerCase()) && Number(match[2] ?? 80) === port;
}

/** The ingress takes this machine's tailnet name (through Serve, which keeps the Host) or its own loopback port. */
function ingressHostAllowed(req: IncomingMessage, port: number, dnsName: string | null): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!match) return false;
  if (dnsName && match[1] === dnsName.toLowerCase()) return true;
  return LOOPBACK_HOSTS.has(match[1]) && Number(match[2] ?? 80) === port;
}

function cookieToken(req: IncomingMessage, cookie: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookie) return value.join("=");
  }
  return "";
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** An automation as devices see it (with its next time and last run). */
const automationView = (world: World, id: string) => listAutomations(world).find((candidate) => candidate.id === id);

/** Whether whoever asks may go into development sessions: this machine, or a device the user gave `dev`. */
const mayDev = (peer: Peer) => peer.local || !!peer.device?.scopes.includes("dev");
const NEEDS_DEV = "This device needs permission to use development sessions.";

/** What a device says it already holds of the modules' snapshots: `have=todo.<revision>,mail.<revision>` (the
 * revisions are the ones the last state came with), or `modules=0` from a caller that reads none of them. */
function held(query: URLSearchParams): { none: boolean; revisions: Map<string, string> } {
  const revisions = new Map<string, string>();
  for (const part of (query.get("have") ?? "").split(",").slice(0, 64)) {
    const dot = part.indexOf(".");
    if (dot > 0) revisions.set(part.slice(0, dot), part.slice(dot + 1));
  }
  return { none: query.get("modules") === "0", revisions };
}

function state(home: Home, peer: Peer, has: ReturnType<typeof held> = { none: false, revisions: new Map() }): StateResponse {
  // One synchronous read: no commit can land between these statements.
  // The snapshots are most of the state (a calendar, an inbox) and seldom what changed. Each goes out with a
  // revision, a digest of what it says; a device that names the one it holds is not sent the same thing again.
  const modules: Record<string, unknown> = {};
  const revisions: Record<string, string> = {};
  if (!has.none) for (const module of home.modules) if (module.snapshot) {
    const snapshot = module.snapshot(home.world);
    const revision = createHash("sha1").update(JSON.stringify(snapshot)).digest("base64url").slice(0, 16);
    revisions[module.id] = revision;
    if (has.revisions.get(module.id) !== revision) modules[module.id] = snapshot;
  }
  // A device without `dev` gets a development session's title and whether it is busy, and nothing it said or did.
  const devAccess = mayDev(peer) ? "allowed" : !peer.local && peer.device?.devAccessRequested ? "pending" : "off";
  const hidden = devAccess === "allowed" ? null : sessionIds(home.world);
  const requests = peer.local ? listDevices(home.world).filter((device) => device.devAccessRequested).map(({ id, name }) => ({ id, name })) : [];
  const hiddenConversations = hidden ? [...hidden] : [];
  const runs = listRuns(home.world, { limit: 50, includeWaiting: true, hiddenConversations });
  const views: StateResponse["views"] = {};
  for (const module of home.modules) if (module.views?.length) views[module.id] = module.views.map((view) => ({ id: view.id, title: view.title }));
  return {
    protocol: PROTOCOL_VERSION,
    devAccess,
    ...(requests.length ? { devAccessRequests: requests } : {}),
    cursor: latestEventSeq(home.world),
    conversations: listConversations(home.world).map((conversation) => (hidden?.has(conversation.id) ? { ...conversation, lastGoal: null, commands: [], unreadReplyId: null } : conversation)),
    runs,
    receipts: listRunReceipts(home.world, runs.map((run) => run.id)),
    // Presented ones too: the device that showed one keeps showing it until acknowledged.
    notices: listNotices(home.world, { states: ["pending", "claimed", "presented"], includeNeedsYou: true, hiddenConversations }),
    modules,
    revisions,
    views,
    areas: listAreas(home.world),
    preferences: listPreferences(home.world),
    proposals: listOpenProposals(home.world),
    settings: getSettings(home.world),
    automations: listAutomations(home.world),
    projects: listProjects(home.world).map((project) => ({ ...project, gitRoot: !!project.trustedAt && existsSync(join(project.path, ".git")) })),
  };
}

function conversationDetail(home: Home, id: string, query: URLSearchParams): ConversationDetail {
  const conversation = getConversation(home.world, id);
  const before = query.get("before") ?? undefined;
  const changed = query.has("runs") ? (query.get("runs") || "").split(",").filter(Boolean) : undefined;
  const validId = /^[A-Za-z0-9_-]{1,64}$/;
  if ((before !== undefined && (!validId.test(before) || changed)) || (changed && (changed.length > 64 || changed.some((key) => !validId.test(key))))) {
    throw new HttpError(400, "Invalid history query");
  }
  const page = conversationRuns(home.world, id, { before, changed });
  const ids = page.runs.map((run) => run.id);
  return { conversation, ...page, receipts: listRunReceipts(home.world, ids), activity: listRunActivity(home.world, ids), files: listRunFiles(home.world, ids) };
}

const RUN_ENDED = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);

/** Server-Sent Events: replay after the cursor, then follow commits. Live
 * updates (a reply being written) go out as they happen and are never replayed.
 */
function events(home: Home, peer: Peer, req: IncomingMessage, res: ServerResponse, url: URL, canStream: () => boolean): void {
  // A device without `dev` still hears that something happened in a development session (so its lists stay right),
  // but not what: such an event goes out with an empty payload, and what a session is writing does not go out.
  const open = mayDev(peer);
  const fromHeader = Number(req.headers["last-event-id"]);
  const fromQuery = Number(url.searchParams.get("after"));
  let cursor = Number.isInteger(fromHeader) && fromHeader >= 0 ? fromHeader : Number.isInteger(fromQuery) && fromQuery >= 0 ? fromQuery : latestEventSeq(home.world);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 2000\n\n`);
  /** What this device has been sent of each reply being written, by run. */
  const written = url.searchParams.get("delta") === "1" ? new Map<string, string>() : null;
  const flush = () => {
    if (!canStream()) { res.end(); return; }
    for (;;) {
      const page = listEvents(home.world, { after: cursor, limit: 500 });
      for (const event of page.events as CoreEvent[]) {
        if (event.runId && RUN_ENDED.has(event.kind)) written?.delete(event.runId);
        if (event.kind === "device.dev_requested" && !peer.local && event.subject !== `device:${peer.device?.id}`) continue;
        const sent = open || !sessionEvent(home.world, event) ? event : { ...event, payload: {} };
        res.write(`id: ${event.seq}\nevent: core\ndata: ${JSON.stringify(sent)}\n\n`);
      }
      cursor = page.cursor;
      if (page.events.length < 500) return;
    }
  };
  flush();
  const unsubscribe = home.world.onCommit(() => setImmediate(() => { if (!res.writableEnded) flush(); }));
  const onLive = (update: LiveUpdate) => {
    if (res.writableEnded || !canStream() || (!open && isSession(home.world, update.conversationId))) return;
    // The engine says the whole reply so far each time. A device is sent it once, then only what was written since;
    // the whole again whenever the text does not simply go on from what this device has.
    const had = written?.get(update.runId);
    written?.set(update.runId, update.text);
    const sent: WireLiveUpdate = had !== undefined && update.text.length >= had.length && update.text.startsWith(had)
      ? { runId: update.runId, conversationId: update.conversationId, at: had.length, add: update.text.slice(had.length) }
      : update;
    res.write(`event: live\ndata: ${JSON.stringify(sent)}\n\n`);
  };
  home.live.on("update", onLive);
  const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 25_000);
  req.on("close", () => { unsubscribe(); home.live.off("update", onLive); clearInterval(keepAlive); });
}

/** The interface's files as other devices get them: packed once, kept while the file stays as it is. */
const PACKED_TYPES = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest"]);
const packed = new Map<string, Promise<Buffer>>();
function packedFile(file: string, stat: { mtimeMs: number; size: number }, encoding: Encoding): Promise<Buffer> {
  const key = `${encoding}:${file}:${stat.mtimeMs}:${stat.size}`;
  let bytes = packed.get(key);
  if (!bytes) {
    // A rebuilt interface has new names for its files: the old ones' copies go with the next that is packed.
    if (packed.size >= 64) packed.clear();
    bytes = readFile(file).then((plain) => pack(plain, encoding, "thorough"));
    packed.set(key, bytes);
    bytes.catch(() => packed.delete(key));
  }
  return bytes;
}

function serveFile(res: ServerResponse, uiDir: string, pathname: string): void {
  if (!existsSync(join(uiDir, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("The interface is not built yet. Run: npm run build:ui\n");
    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(uiDir, relative);
  if (!file.startsWith(uiDir + sep) && file !== uiDir) file = join(uiDir, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) file = join(uiDir, "index.html");
  const hashed = file.includes(`${sep}assets${sep}`);
  const headers = {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  };
  const plain = () => { if (res.headersSent) return; res.writeHead(200, headers); createReadStream(file).pipe(res); };
  const stat = statSync(file);
  const encoding = PACKED_TYPES.has(extname(file)) && stat.size >= 1024 ? encodingFor(res) : null;
  if (!encoding) return plain();
  packedFile(file, stat, encoding).then((bytes) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": bytes.byteLength });
    res.end(bytes);
  }, plain);
}

const LOCAL_ONLY = "Only on the machine Alfred runs on";
const guessKind = (kind: unknown): DeviceKind => (DEVICE_KINDS as readonly unknown[]).includes(kind) ? kind as DeviceKind : "browser";

/** The device list, with which devices get push notifications. */
function withPush<T extends RemoteResponse>(response: T, push: PushService | undefined): T {
  if (!push) return response;
  if (response.local) return { ...response, devices: response.devices.map((device) => ({ ...device, push: push.subscribed(device.id) })) };
  return { ...response, device: { ...response.device, push: push.subscribed(response.device.id) } };
}

/** Push notifications for the device asking (only other devices: this machine shows its own). */
async function pushRoute(push: PushService | undefined, device: Device, req: IncomingMessage, res: ServerResponse, path: string, locale: Locale): Promise<void> {
  const method = req.method ?? "GET";
  if (!push) throw new HttpError(404, "Not found");
  const info = async (): Promise<PushInfo> => ({ publicKey: await push.publicKey(), subscribed: push.subscribed(device.id) });
  if (method === "GET" && path === "/api/push") return send(res, 200, await info());
  if (method === "POST" && path === "/api/push/subscribe") {
    const body = await readJson<{ subscription?: unknown }>(req);
    push.subscribe(device.id, body.subscription);
    return send(res, 200, await info());
  }
  if (method === "POST" && path === "/api/push/unsubscribe") {
    await readJson(req);
    push.unsubscribe(device.id);
    return send(res, 200, await info());
  }
  if (method === "POST" && path === "/api/push/test") {
    await readJson(req);
    if (!push.subscribed(device.id)) throw new HttpError(409, "Turn notifications on first");
    const works: Record<Locale, string> = { zh: "推送通知能用了。", en: "Notifications work." };
    return send(res, 200, await push.sendTo({ title: "Alfred", body: works[locale], url: "/", tag: "test" }, [device.id]) satisfies PushResult);
  }
  throw new HttpError(404, "Not found");
}

/** Remote access and devices. True when it answered. */
async function remoteRoute(home: Home, options: ServeOptions, peer: Peer, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";
  const remote = options.remote;
  const isPush = path === "/api/push" || path.startsWith("/api/push/");
  if (!remote || !(isPush || path === "/api/remote" || path.startsWith("/api/remote/") || path.startsWith("/api/devices/") || path === "/api/pair" || path === "/api/device/forget" || path === "/api/device/request-dev")) return false;
  if (isPush && peer.local) throw new HttpError(400, "This machine shows notifications itself");
  if (method === "POST" && path === "/api/pair") {
    if (peer.local) throw new HttpError(400, "This machine needs no pairing");
    const body = await readJson<PairRequest>(req);
    if (typeof body.code !== "string" || typeof body.name !== "string") throw new HttpError(400, "code and name are required");
    const { device, token } = remote.pair({ code: body.code, name: body.name, kind: guessKind(body.kind), via: peer.login });
    res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`);
    send(res, 200, { device });
    return true;
  }
  if (!peer.local) {
    if (!peer.device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
    if (method === "GET" && path === "/api/remote") return send(res, 200, withPush({ local: false, device: peer.device } satisfies RemoteResponse, options.push)), true;
    if (isPush) return await pushRoute(options.push, peer.device, req, res, path, userLocale(home.world)), true;
    if (method === "POST" && path === "/api/device/request-dev") {
      const body = await readJson(req);
      if (Object.keys(body).length) throw new HttpError(400, "Send an empty object to request access for this device");
      const device = requestDevAccess(home.world, peer.device.id);
      return send(res, 200, withPush({ local: false, device } satisfies RemoteResponse, options.push)), true;
    }
    if (method === "POST" && path === "/api/device/forget") {
      await readJson(req);
      remote.revoke(peer.device.id);
      res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return send(res, 200, {}), true;
    }
    throw new HttpError(403, LOCAL_ONLY, "local_only");
  }
  if (method === "GET" && path === "/api/remote") return send(res, 200, withPush(await remote.describe(), options.push) satisfies RemoteResponse), true;
  if (method === "POST" && path === "/api/remote") {
    const body = await readJson<{ enabled?: unknown }>(req);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    return send(res, 200, withPush(await remote.setEnabled(body.enabled), options.push) satisfies RemoteResponse), true;
  }
  if (method === "POST" && path === "/api/remote/web-lock") {
    const body = await readJson<{ enabled?: unknown; password?: unknown }>(req, 2048);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    await remote.webLock.configure(body.enabled, body.password);
    return send(res, 200, withPush(await remote.describe(), options.push)), true;
  }
  if (method === "POST" && path === "/api/remote/pairing") {
    await readJson(req);
    await remote.describe();
    return send(res, 200, remote.newPairing()), true;
  }
  const scope = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})\/scope$/.exec(path);
  if (scope && method === "POST") {
    const body = await readJson<{ scope?: unknown; enabled?: unknown; onlyIfRequested?: unknown }>(req);
    if (!(DEVICE_SCOPES as readonly unknown[]).includes(body.scope) || typeof body.enabled !== "boolean") throw new HttpError(400, "scope and enabled are required");
    if (body.onlyIfRequested !== undefined && typeof body.onlyIfRequested !== "boolean") throw new HttpError(400, "onlyIfRequested must be a boolean");
    remote.setScope(scope[1], body.scope as DeviceScope, body.enabled, body.onlyIfRequested);
    return send(res, 200, withPush(await remote.describe(), options.push) satisfies RemoteResponse), true;
  }
  const revoke = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(path);
  if (revoke && method === "POST") {
    await readJson(req);
    remote.revoke(revoke[1]);
    return send(res, 200, withPush(await remote.describe(), options.push) satisfies RemoteResponse), true;
  }
  throw new HttpError(404, "Not found");
}

async function route(home: Home, peer: Peer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (method === "GET" && path === "/api/state") return send(res, 200, state(home, peer, held(url.searchParams)));
  /** Development sessions are for this machine and the devices the user let in (4.7). */
  const dev = mayDev(peer);
  const needDev = (session: boolean) => { if (session && !dev) throw new HttpError(403, NEEDS_DEV, "needs_dev"); };
  /** One of the harness's commands (commands.ts): the body's fields are its input, with what the address names. */
  const ask = async (name: string, where?: Record<string, unknown>) => command(home, name, await readJson<Record<string, unknown>>(req), where);

  // A new run replays by its request id in the runs themselves, so it is not one of those commands.
  if (method === "POST" && path === "/api/runs") {
    const body = await readJson<SubmitRunRequest>(req);
    if (typeof body.requestId !== "string" || typeof body.goal !== "string") throw new HttpError(400, "requestId and goal are required");
    if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.every((id) => typeof id === "string"))) throw new HttpError(400, "attachments is a list of file ids");
    needDev(isSession(home.world, body.conversationId));
    const profile = profileFor(home.world, body.conversationId);
    // A session is its own page: what page the user had open is not its context.
    const context = profile === DEVELOPER_PROFILE ? undefined : body.context;
    const result = withCoreContext({ actor: "user" }, () => submitRun(home.world, { requestId: body.requestId, goal: body.goal, profile, conversationId: body.conversationId, context, attachments: body.attachments }));
    home.kick();
    return send(res, result.replayed ? 200 : 202, result);
  }
  // A file for the next message: its bytes are the body. What it is, is made out from them (files.ts).
  if (method === "POST" && path === "/api/files") {
    const bytes = await readBytes(req, MAX_FILE_BYTES, () => new HttpError(413, "A file can be 20 MB at most", "file_too_big"));
    return send(res, 201, await home.files.save({ name: url.searchParams.get("name") ?? "file", bytes }));
  }
  const kept = /^\/api\/files\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (kept && method === "GET") {
    const found = getFile(home.world, kept[1]);
    needDev(isSession(home.world, found.conversationId));
    // Read as it is sent: a 20 MB file held whole would stop every other answer while it was read.
    const stored = home.files.open(found.id);
    // The user's own file, but still only bytes to a browser: an image is shown as an image, anything else is
    // handed over as a download; neither may load or run anything.
    res.writeHead(200, {
      "Content-Type": found.kind === "image" ? found.type : found.kind === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
      "Content-Length": stored.size, "Cache-Control": peer.local ? "private, max-age=86400" : "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...(found.kind === "image" ? {} : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}` }),
    });
    stored.stream().on("error", () => res.destroy()).pipe(res);
    return;
  }
  if (method === "POST" && path === "/api/conversations") { needDev(true); return send(res, 201, (await ask("conversation.start")).result); }
  if (method === "GET" && path === "/api/conversations/archived") {
    return send(res, 200, { conversations: listArchivedConversations(home.world, { includeSessions: dev }) });
  }
  // Projects: only from the home node's own machine (dispatch refuses other devices).
  if (method === "POST" && path === "/api/projects") return send(res, 200, (await ask("project.add")).result);
  const project = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/(trust|remove)$/.exec(path);
  if (project && method === "POST") return send(res, 200, (await ask(`project.${project[2]}`, { id: project[1] })).result);
  const readReply = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})\/read$/.exec(path);
  if (readReply && method === "POST") {
    needDev(isSession(home.world, readReply[1]));
    const { runId } = await readJson<{ runId?: unknown }>(req);
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new HttpError(400, "runId is required");
    markConversationReplyRead(home.world, readReply[1], runId);
    return send(res, 200, {});
  }
  const conversation = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (conversation) needDev(isSession(home.world, conversation[1]));
  if (conversation && method === "GET") return send(res, 200, conversationDetail(home, conversation[1], url.searchParams));
  if (conversation && method === "POST") return send(res, 200, (await ask("conversation.update", { id: conversation[1] })).result);
  // The Mac app comes for what only it can do (desk.ts): it waits here for a request and posts back its answer.
  // Whether the Mac app is there to be asked (it is running and comes for requests).
  if (method === "GET" && path === "/api/desktop") return send(res, 200, { present: home.desk.present });
  if (path === "/api/desktop/requests" || path.startsWith("/api/desktop/requests/")) {
    if (!peer.local) throw new HttpError(403, LOCAL_ONLY, "local_only");
    if (method === "GET" && path === "/api/desktop/requests") {
      const gone = new AbortController();
      req.on("close", () => gone.abort());
      return send(res, 200, { request: await home.desk.next(25_000, gone.signal) });
    }
    const taken = /^\/api\/desktop\/requests\/([A-Za-z0-9_-]{1,32})$/.exec(path);
    if (taken && method === "POST") {
      // A page's text is longer than a command's body may be.
      const body = parseObject<{ ok?: unknown; result?: unknown; error?: unknown }>((await readBytes(req, 512 * 1024)).toString("utf8"));
      const known = home.desk.answer(taken[1], body.ok === true ? { ok: true, result: body.result } : { ok: false, error: typeof body.error === "string" ? body.error : "failed" });
      return send(res, known ? 200 : 404, known ? {} : { error: "That request is no longer waited for" });
    }
    throw new HttpError(404, "Not found");
  }
  // The user's own terminal in a development session: a shell with everything their account can do, so only this
  // machine opens one, types into it or watches it. No device scope lets another device in.
  const terminal = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})\/terminal(?:\/(stream|input|resize|close))?$/.exec(path);
  if (terminal) {
    if (!peer.local) throw new HttpError(403, LOCAL_ONLY, "local_only");
    const [, id, action] = terminal;
    const found = getConversation(home.world, id);
    if (!found.projectId) throw new HttpError(404, "Not a development session");
    if (method === "GET" && action === "stream") {
      const from = Number(url.searchParams.get("from")) || 0;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const stop = home.terminals.follow(id, from, (event) => { if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
      req.on("close", () => { stop(); clearInterval(keepAlive); });
      return;
    }
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson<{ cols?: unknown; rows?: unknown; data?: unknown }>(req);
    if (!action || action === "input") requireOpenSession(home.world.db, id);
    if (!action) {
      const project = getProject(home.world, found.projectId);
      if (!project.trustedAt) throw new HttpError(409, "This folder is not trusted yet", "untrusted");
      return send(res, 200, home.terminals.open(id, sessionRoot(home.world, found) ?? project.path, body));
    }
    if (action === "input") { home.terminals.write(id, typeof body.data === "string" ? body.data : ""); return send(res, 200, {}); }
    if (action === "resize") { home.terminals.resize(id, body.cols, body.rows); return send(res, 200, {}); }
    home.terminals.close(id);
    return send(res, 200, {});
  }
  // A development session's changes since its snapshot, and one file's diff; where its branch stands (and its pull
  // request, which asks GitHub); committing them, and pushing them with a pull request.
  const session = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})\/(changes|diff|branch|pr|commit|commit-preview|publish)$/.exec(path);
  if (session) {
    needDev(true);
    const found = getConversation(home.world, session[1]);
    if (!found.projectId) throw new HttpError(404, "Not a development session");
    if (method === "POST" && (session[2] === "commit" || session[2] === "publish")) return send(res, 200, (await ask(`session.${session[2]}`, { id: found.id })).result);
    const preview = method === "POST" && session[2] === "commit-preview";
    if (!preview && method !== "GET") throw new HttpError(405, "Method not allowed");
    const root = sessionRoot(home.world, found);
    if (!root || !existsSync(root)) {
      if (session[2] === "changes") return send(res, 200, { branch: found.branch, base: found.base, files: [], gone: true } satisfies SessionChanges);
      throw new HttpError(409, "This session's folder is not there", "git_gone");
    }
    if (session[2] === "diff") return send(res, 200, { diff: await workspaceDiff(root, found.base, url.searchParams.get("path") ?? "") });
    if (session[2] === "branch") return send(res, 200, await branchState(root) satisfies SessionBranch);
    if (session[2] === "pr") {
      const branch = (await branchState(root)).branch;
      return send(res, 200, { pr: branch ? await pullRequest(root, branch) : null } satisfies SessionPullRequest);
    }
    const writes = sessionWrites(home, found.id);
    const changes = await workspaceChanges(root, found.base, writes);
    if (session[2] === "commit-preview") {
      if (!preview) throw new HttpError(405, "Method not allowed");
      const { paths } = await readJson<{ paths?: unknown }>(req);
      if (!Array.isArray(paths) || paths.length > 1000 || !paths.every((path) => typeof path === "string")) throw new HttpError(400, "Choose files for the preview");
      const { token, patch } = await reviewCommit(root, paths, changes.files.map((f) => f.path));
      return send(res, 200, { token, patch });
    }
    const touched = new Set(writes.map((entry) => entry.path));
    const suggested = changes.files.filter((file) => found.worktree || touched.has(file.path)).map((file) => file.path);
    return send(res, 200, { ...changes, suggested } satisfies SessionChanges);
  }
  // Background processes in a development session. Starting one is the user's own command, so only this machine
  // may (like the terminal); seeing, reading and stopping them is a development session's business.
  const proc = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})\/processes(?:\/([A-Za-z0-9_-]{1,64})(?:\/(logs|stop))?)?$/.exec(path);
  if (proc) {
    needDev(true);
    const [, id, processId, action] = proc;
    const found = getConversation(home.world, id);
    if (!found.projectId) throw new HttpError(404, "Not a development session");
    if (method === "GET" && !processId) return send(res, 200, { processes: home.processes.list(id) } satisfies SessionProcesses);
    if (method === "GET" && action === "logs") return send(res, 200, home.processes.logs(id, processId, Number(url.searchParams.get("lines")) || 400, url.searchParams.has("seen") ? Number(url.searchParams.get("seen")) : undefined));
    if (method === "POST" && action === "stop") { await readJson(req); home.processes.stop(id, processId); return send(res, 200, {}); }
    if (method === "POST" && !processId) {
      if (!peer.local) throw new HttpError(403, LOCAL_ONLY, "local_only");
      const body = await readJson<{ command?: unknown; name?: unknown }>(req);
      const root = sessionRoot(home.world, found);
      if (!root || typeof body.command !== "string") throw new HttpError(400, "command is required");
      requireOpenSession(home.world.db, id);
      return send(res, 201, home.processes.start(id, { command: body.command, cwd: root, name: typeof body.name === "string" ? body.name : undefined, by: "user" }));
    }
    throw new HttpError(405, "Method not allowed");
  }

  if (method === "GET" && path === "/api/models") {
    return send(res, 200, { models: await home.models() } satisfies ModelsResponse);
  }

  const run = /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(cancel|resume|respond|steer|sources))?$/.exec(path);
  if (run) needDev(runInSession(home.world, run[1]));
  if (run && method === "GET" && !run[2]) return send(res, 200, getRun(home.world, run[1]));
  if (run && method === "GET" && run[2] === "sources") {
    const detail = getRun(home.world, run[1]);
    const evidence = await runSources(home.world, detail.run);
    const now = (id: string) => home.modules.find((module) => module.id === id)?.snapshot?.(home.world) as Parameters<typeof sourcesToday>[2] | undefined;
    return send(res, 200, { evidence: evidence && sourcesToday(evidence, detail.run.outcome?.reply ?? "", { events: now("calendar")?.events, messages: now("mail")?.messages }) });
  }
  if (run && method === "POST" && run[2] === "steer") {
    const body = await readJson<SteerRequest>(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
    if (!(await home.steer(run[1], body.text))) throw new HttpError(409, "That run is not working right now; send it as a new message", "not_running");
    return send(res, 200, { delivered: true });
  }
  if (run && method === "POST" && run[2] === "respond") {
    const body = await readJson<RespondRequest>(req);
    if (typeof body.requestId !== "string" || typeof body.answer !== "string") throw new HttpError(400, "requestId and answer are required");
    // Who answered: an `always` (this command, for the rest of the session) ends with the device that gave it.
    return send(res, 200, answerRequest(home.world, run[1], { requestId: body.requestId, answer: body.answer, by: peer.local ? "home" : peer.device?.id }));
  }
  if (run && method === "POST" && run[2]) return send(res, 200, (await ask(`run.${run[2]}`, { id: run[1] })).result);

  const op = /^\/api\/ops\/([a-z][a-z0-9]*\.[a-z][a-z_]*)$/.exec(path);
  if (op && method === "POST") {
    const body = await readJson<OpRequest>(req);
    if (typeof body.requestId !== "string") throw new HttpError(400, "requestId is required");
    const answer = invokeOp(home.world, home.modules, { op: op[1], requestId: body.requestId, input: body.input });
    home.deliver();
    return send(res, 200, answer);
  }

  // A module's read that is too big for the state (one mail's body). Changes nothing, so it is not a command.
  const query = /^\/api\/queries\/([a-z][a-z0-9]*\.[a-z][a-z_]*)$/.exec(path);
  if (query && method === "POST") {
    const body = await readJson<{ input?: unknown }>(req);
    return send(res, 200, { result: runQuery(home.modules, home.world, query[1], body.input) });
  }

  // A small image a module keeps (a site's icon). It came from the web, so it is served as an image and nothing
  // else: its type is one of a few, never sniffed by the browser, and it may load and run nothing.
  const file = /^\/api\/modules\/([a-z][a-z0-9]*)\/files\/([A-Za-z0-9._-]{1,255})$/.exec(path);
  if (method === "GET" && file) {
    const found = home.modules.find((module) => module.id === file[1])?.file?.(home.world, file[2]);
    if (!found || !/^image\/(png|jpeg|gif|webp|x-icon|svg\+xml)$/.test(found.type)) throw new HttpError(404, "Not found");
    res.writeHead(200, {
      "Content-Type": found.type, "Content-Length": found.bytes.byteLength, "Cache-Control": peer.local ? "private, max-age=86400" : "no-store",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(Buffer.from(found.bytes));
    return;
  }

  if (method === "POST" && path === "/api/modules/mail/favorite") {
    if (!home.modules.some((module) => module.id === "mail")) throw new HttpError(404, "Mail is unavailable");
    const { account, id, starred } = await readJson(req);
    if (typeof account !== "string" || !account.length || account.length > 320 || typeof id !== "string" || !id.length || id.length > 64 || typeof starred !== "boolean") {
      throw new HttpError(400, "Provide an account, message id and starred boolean");
    }
    return send(res, 200, await home.setMailFavorite(account, id, starred));
  }

  // Refresh a module's mirror of an outside service now (the calendar, the inbox); answers when it is done.
  const sync = /^\/api\/modules\/([a-z][a-z0-9]*)\/sync$/.exec(path);
  if (sync && method === "POST") {
    await readJson(req);
    if (!home.modules.some((module) => module.id === sync[1] && module.sync)) throw new HttpError(404, "Not found");
    await home.syncModule(sync[1]);
    return send(res, 200, {});
  }

  if (method === "POST" && path === "/api/presence") {
    const body = await readJson<PresenceRequest>(req);
    if (typeof body.client !== "string" || (body.kind !== "active" && body.kind !== "away")) throw new HttpError(400, "client and kind (active or away) are required");
    return send(res, 200, reportPresence(home.world, { clientId: body.client, kind: body.kind, ...home.presence }));
  }

  const notice = /^\/api\/notices\/([A-Za-z0-9_-]+)\/(claim|present|acknowledge)$/.exec(path);
  if (notice && method === "POST") {
    const body = await readJson<NoticeRequest>(req);
    if (notice[2] === "acknowledge") return send(res, 200, acknowledgeNotice(home.world, notice[1]));
    if (typeof body.client !== "string") throw new HttpError(400, "client is required");
    return send(res, 200, notice[2] === "claim" ? claimNotice(home.world, notice[1], body.client) : presentNotice(home.world, notice[1], body.client));
  }

  if (method === "POST" && path === "/api/settings") return send(res, 200, (await ask("settings.update")).result);

  // The user's areas; each answers with the whole list, in order.
  if (method === "POST" && path === "/api/areas") {
    await ask("area.create");
    return send(res, 200, { areas: listAreas(home.world) });
  }
  const area = /^\/api\/areas\/([A-Za-z0-9_-]{1,64})(?:\/(move|delete))?$/.exec(path);
  if (area && method === "POST") {
    await ask(area[2] === "move" ? "area.move" : area[2] === "delete" ? "area.delete" : "area.update", { id: area[1] });
    return send(res, 200, { areas: listAreas(home.world) });
  }
  if (method === "POST" && path === "/api/preferences") {
    await ask("preference.create");
    return send(res, 200, { preferences: listPreferences(home.world) });
  }
  const preference = /^\/api\/preferences\/([A-Za-z0-9_-]{1,64})(?:\/(delete))?$/.exec(path);
  if (preference && method === "POST") {
    await ask(preference[2] === "delete" ? "preference.delete" : "preference.update", { id: preference[1] });
    return send(res, 200, { preferences: listPreferences(home.world) });
  }

  // Automations answer as devices see one (with its next time and its last run).
  if (method === "POST" && path === "/api/automations") {
    const made = (await ask("automation.create")).result as { id: string };
    return send(res, 200, automationView(home.world, made.id) ?? made);
  }
  const history = /^\/api\/automations\/([A-Za-z0-9_-]{1,64})\/runs$/.exec(path);
  if (history && method === "GET") {
    const rule = getAutomation(home.world, history[1]);
    if (rule.conversationId) needDev(isSession(home.world, rule.conversationId));
    const before = url.searchParams.get("before");
    if (before !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(before)) throw new HttpError(400, "Invalid history cursor");
    return send(res, 200, listAutomationRuns(home.world, rule.id, before));
  }
  const automation = /^\/api\/automations\/([A-Za-z0-9_-]{1,64})(?:\/(run|delete))?$/.exec(path);
  if (automation && method === "POST") {
    const [, id, action] = automation;
    if (action === "run") return send(res, 202, (await ask("automation.run", { id })).result);
    if (action === "delete") return send(res, 200, (await ask("automation.delete", { id })).result);
    const changed = (await ask("automation.update", { id })).result;
    return send(res, 200, automationView(home.world, id) ?? changed);
  }

  // The user's decisions on proposals.
  const proposal = /^\/api\/proposals\/([A-Za-z0-9_-]{1,64})\/(accept|decline|revise)$/.exec(path);
  if (proposal && method === "POST") {
    const decided = await ask(`proposal.${proposal[2]}`, { id: proposal[1] });
    return send(res, 200, { ...(decided.result as Omit<ProposalResponse, "replayed">), replayed: decided.replayed } satisfies ProposalResponse);
  }

  if (path.startsWith("/api/")) throw new HttpError(404, "Not found");
  throw new HttpError(405, "Method not allowed");
}

const OUTLET_CLIENT = /^[A-Za-z0-9._:-]{1,80}$/;

/** A window or the Mac's figure says what it sees, and anyone who may talk to Alfred may ask who is looking. None
 * of it is recorded: the home node only keeps the latest from each outlet (attention.ts). */
async function outletRoute(home: Home, peer: Peer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    const now = Date.now();
    return send(res, 200, {
      outlets: home.outlets.list(now).map((outlet) => ({
        client: outlet.id, kind: outlet.kind as OutletReport["kind"], device: outlet.device, attending: outlet.attending,
        idleSeconds: outlet.activeAt === undefined ? null : Math.max(0, Math.round((now - outlet.activeAt) / 1000)),
        reportedSecondsAgo: Math.round((now - outlet.reportedAt) / 1000),
      })),
    } satisfies OutletsResponse);
  }
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await readJson<OutletReport>(req);
  const idle = body.idleMs;
  if (typeof body.client !== "string" || !OUTLET_CLIENT.test(body.client) || (body.kind !== "window" && body.kind !== "figure") || typeof body.attending !== "boolean"
    || (idle !== undefined && (typeof idle !== "number" || !(idle >= 0)))) {
    throw new HttpError(400, "client, kind (window or figure) and attending are required");
  }
  // It is taken as coming from whoever sent it: a paired device, or this machine.
  const device = peer.local ? "home" : peer.device?.id;
  if (!device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
  home.outlets.report(device, { client: body.client, kind: body.kind, attending: body.attending, ...(idle === undefined ? {} : { idleMs: idle }) });
  return send(res, 200, {});
}

export interface ServeOptions {
  port: number;
  host?: string;
  uiDir: string;
  log?: (message: string) => void;
  /** Connected Google accounts (`/api/connections`); left out, those routes are 404. */
  google?: GoogleConnections;
  /** Model providers and signing in to them (`/api/connections/models`); left out, those routes are 404. */
  models?: ModelAccounts;
  /** Connectors, the MCP servers runs can use (`/api/connections/mcp`); left out, those routes are 404. */
  mcp?: McpConnectors;
  /** Alfred's skills (Settings → Skills); only on this machine. */
  skills?: Skills;
  /** Remote access and devices (`/api/remote`, `/api/devices`, `/api/pair`); left out, those routes are 404. */
  remote?: RemoteAccess;
  /** Push notifications to paired devices (`/api/push`). */
  push?: PushService;
  /** Speech to text (`/api/voice/*`); left out, those routes are 404. */
  voice?: Transcriber;
}

async function readAudio(req: IncomingMessage): Promise<Buffer> {
  if (!/^audio\/(wav|wave|x-wav)\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send 16-bit PCM WAV");
  const wav = await readBytes(req, MAX_VOICE_BYTES, () => new HttpError(413, "Recording too long"));
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new HttpError(400, "Not a WAV file");
  return wav;
}

/** Any device that may talk to Alfred may talk to it out loud. */
async function voiceRoute(voice: Transcriber | undefined, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!voice) throw new HttpError(404, "Not found");
  if (req.method === "GET" && path === "/api/voice") {
    const why = await voice.unavailable();
    return send(res, 200, { available: !why, reason: why, loaded: voice.loaded });
  }
  if (req.method === "POST" && path === "/api/voice/warm") {
    await readJson(req);
    voice.warm();
    return send(res, 200, { loaded: voice.loaded });
  }
  if (req.method === "POST" && path === "/api/voice/transcribe") {
    return send(res, 200, await voice.transcribe(await readAudio(req)));
  }
  throw new HttpError(404, "Not found");
}

async function authorizeBrowser(lock: WebLock, device: Device, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const id = device.id;
  const token = cookieToken(req, WEB_SESSION_COOKIE);
  if (req.method === "GET" && path === "/api/device/web-lock") return send(res, 200, lock.status(id, token)), true;
  if (req.method === "POST" && path === "/api/device/unlock") {
    const body = await readJson<{ password?: unknown }>(req, 2048);
    const fresh = await lock.unlock(id, body.password);
    if (fresh) res.setHeader("Set-Cookie", `${WEB_SESSION_COOKIE}=${fresh}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return send(res, 200, lock.status(id, fresh ?? "")), true;
  }
  if (req.method === "POST" && path === "/api/device/activity") {
    await readJson(req, 256);
    return send(res, 200, lock.activity(id, token)), true;
  }
  if (lock.status(id, token).locked) throw new HttpError(423, "Unlock this browser to use Alfred.", "web_locked");
  return false;
}

function dispatch(home: Home, options: ServeOptions, peer: Peer, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname;
  const answer = async () => {
    if (peer.local && req.method === "GET" && path === "/api/device/web-lock") {
      return send(res, 200, { enabled: false, locked: false, expiresAt: null });
    }
    if (!peer.local && !(req.method === "POST" && path === "/api/pair")) {
      if (!peer.device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
      if (await authorizeBrowser(options.remote!.webLock, peer.device, req, res, path)) return;
    }
    if (await remoteRoute(home, options, peer, req, res, path)) return;
    if (!peer.local) {
      if (!peer.device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
      const readingUsage = path === MODEL_USAGE_PATH && req.method === "GET";
      if (path.startsWith("/api/connections") && !readingUsage) throw new HttpError(403, LOCAL_ONLY, "local_only");
      // Skills are files on the home node's machine, and adding one reads its other folders.
      if (path === "/api/skills" || path.startsWith("/api/skills/")) throw new HttpError(403, LOCAL_ONLY, "local_only");
      // A folder path means something only on the home node's machine, and trusting one lets Alfred read it.
      if (path.startsWith("/api/projects") && req.method === "POST") throw new HttpError(403, LOCAL_ONLY, "local_only");
      if (path === "/api/events" && req.method === "GET" && options.remote) {
        // The reconnect checks the device's current scopes and rejects a revoked device.
        const id = peer.device.id;
        const remote = options.remote;
        const token = cookieToken(req, WEB_SESSION_COOKIE);
        const unlocked = () => !remote.webLock.status(id, token).locked;
        const endStream = (changed: string | null) => { if (changed === null || changed === id) res.end(); };
        remote.events.on("revoked", endStream);
        remote.events.on("scopeChanged", endStream);
        remote.events.on("lockChanged", endStream);
        req.on("close", () => {
          remote.events.off("revoked", endStream);
          remote.events.off("scopeChanged", endStream);
          remote.events.off("lockChanged", endStream);
        });
        return events(home, peer, req, res, url, unlocked);
      }
    }
    if (peer.local && path === "/api/events" && req.method === "GET") return events(home, peer, req, res, url, () => true);
    if (path === "/api/voice" || path.startsWith("/api/voice/")) return voiceRoute(options.voice, req, res, path);
    if (path.startsWith("/api/connections") && (options.google || options.models || options.mcp)
      && await handleConnections({ google: options.google, models: options.models, mcp: options.mcp }, req, res, url)) return;
    if (options.skills && (path === "/api/skills" || path.startsWith("/api/skills/")) && await handleSkills(options.skills, req, res, url)) return;
    if (path === "/api/outlets") return outletRoute(home, peer, req, res);
    await route(home, peer, req, res, url);
  };
  answer().catch((error: unknown) => {
    const { status, body } = statusOf(error);
    if (status >= 500) options.log?.(`${req.method} ${path} failed: ${error instanceof Error ? error.stack : String(error)}`);
    if (!res.headersSent) send(res, status, body);
    else res.end();
  });
}

function serveUi(options: ServeOptions, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || url.pathname.startsWith("/api/")) return false;
  try { serveFile(res, options.uiDir, url.pathname); } catch { send(res, 400, { error: "Bad path" }); }
  return true;
}

/** This machine's listener. `port: 0` picks a free port; the Host check then uses the one actually bound. */
export function createHttpServer(home: Home, options: ServeOptions): Server {
  const server: Server = createServer((req, res) => {
    const port = options.port || (server.address() as AddressInfo | null)?.port || 0;
    if (!hostAllowed(req, port) || !originAllowed(req)) return send(res, 403, { error: "Forbidden host or origin" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (serveUi(options, req, res, url)) return;
    dispatch(home, options, { local: true }, req, res, url);
  });
  return server;
}

/** The listener Tailscale Serve forwards other devices to (bind it to loopback). Nothing here counts as local. */
export function createIngressServer(home: Home, options: ServeOptions & { remote: RemoteAccess }): Server {
  const server: Server = createServer((req, res) => {
    overTheWire(res);
    const port = (server.address() as AddressInfo | null)?.port || 0;
    if (!ingressHostAllowed(req, port, options.remote.dnsName) || !originAllowed(req)) return send(res, 403, { error: "Forbidden host or origin" });
    // Serve sets this for tailnet users (and drops any the device sent). Another account's device is refused outright.
    const header = req.headers["tailscale-user-login"];
    const login = typeof header === "string" && header ? header : null;
    if (login && options.remote.owner && login !== options.remote.owner) return send(res, 403, { error: "This Alfred belongs to another Tailscale account", code: "other_account" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (serveUi(options, req, res, url)) return;
    const device = deviceForToken(home.world, cookieToken(req, DEVICE_COOKIE));
    dispatch(home, options, { local: false, device, login }, req, res, url);
  });
  return server;
}
