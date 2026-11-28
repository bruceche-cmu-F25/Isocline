/** What every address of the home node shares: reading what a device sent, answering in JSON, and saying a refusal
 * as a status. http.ts and the route files beside it (connections-http.ts, skills-http.ts) all go through here, so a
 * body is read one way and an error means the same status whichever address it came from.
 *
 * A route throws; it does not answer its own errors. The listener (http.ts `dispatch`) catches, asks `statusOf`,
 * and logs what was the home node's own fault.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import type { ErrorResponse } from "@zirma/protocol";

/** The most a command's JSON body may be. */
export const MAX_BODY = 64 * 1024;

/** A refusal that is about the request itself (its address, its shape), with the status it gets. */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

/** A failure that is the home node's own, whatever its message says: answered as 500 without the message, and logged.
 * For services whose every refusal has a name (connections): a bare Error out of one of them is not the device's doing. */
export class Fault extends Error {
  override name = "Fault";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

/** Answers that go to another device (through the ingress), which are worth making smaller: a phone on a mobile
 * network pays for every byte. This machine's own are not: over loopback, packing costs more than it saves. */
const remote = new WeakSet<ServerResponse>();
export function overTheWire(res: ServerResponse): void { remote.add(res); }

export type Encoding = "br" | "gzip";
/** Under this many characters an answer is sent as it is: packing would not make it fit in fewer packets. */
const PACK_FROM = 1024;

/** How to pack the answer for whoever asked: what their browser takes, and only for another device. */
export function encodingFor(res: ServerResponse): Encoding | null {
  if (!remote.has(res)) return null;
  const accepts = String(res.req?.headers["accept-encoding"] ?? "").toLowerCase();
  const weights = new Map<string, number>();
  for (const part of accepts.split(",")) {
    const match = /^(br|gzip|identity|\*)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/.exec(part.trim());
    if (match) weights.set(match[1], match[2] === undefined ? 1 : Number(match[2]));
  }
  const wildcard = weights.get("*") ?? 0;
  const br = weights.get("br") ?? wildcard;
  const gzip = weights.get("gzip") ?? wildcard;
  if (Math.max(br, gzip) === 0 || (weights.get("identity") ?? 0) > Math.max(br, gzip)) return null;
  return br >= gzip ? "br" : "gzip";
}

/** `effort`: `quick` for an answer made now (state, a conversation), `thorough` for a file packed once and kept. */
export function pack(bytes: Buffer, encoding: Encoding, effort: "quick" | "thorough"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, packed: Buffer) => (error ? reject(error) : resolve(packed));
    if (encoding === "gzip") gzip(bytes, { level: effort === "quick" ? 5 : 9 }, done);
    else brotliCompress(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: effort === "quick" ? 4 : 9, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } }, done);
  });
}

/** Answers already on their way: packing takes a moment, and a response is answered once. */
const answered = new WeakSet<ServerResponse>();

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (answered.has(res)) return;
  answered.add(res);
  const text = JSON.stringify(body);
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const plain = () => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { ...headers, "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };
  const encoding = text.length >= PACK_FROM ? encodingFor(res) : null;
  if (!encoding) return plain();
  pack(Buffer.from(text), encoding, "quick").then((packed) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { ...headers, "Content-Encoding": encoding, Vary: "Accept-Encoding", "Content-Length": packed.byteLength });
    res.end(packed);
  }, plain);
}

/** A request's body as bytes, refused past `max` (with `tooBig`, when the address has its own words for that). */
export async function readBytes(req: IncomingMessage, max: number, tooBig: () => HttpError = () => new HttpError(413, "Request too large")): Promise<Buffer> {
  if (Number(req.headers["content-length"] ?? 0) > max) throw tooBig();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw tooBig();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** JSON text as an object (an empty body is `{}`); anything else is refused. */
export function parseObject<T>(text: string): T {
  try {
    const value: unknown = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** A command's body: a JSON object, sent as JSON. */
export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, max: number = MAX_BODY): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON");
  return parseObject<T>((await readBytes(req, max)).toString("utf8"));
}

/** How a named refusal is said to a device. `by`: the status for each of its codes, `otherwise` for the rest.
 * `code`: how its code is spelled on the wire (a prefix, `""` for as it is); left out, no code is sent. */
interface Refusal { by?: Record<string, number>; otherwise: number; code?: string }

/** Every refusal the home node's parts throw by name. They are matched by name, not by class: core and the modules
 * know nothing of HTTP, and this file need not import each of them. A name that is not here is a fault (500). */
const REFUSALS: Record<string, Refusal> = {
  // Core.
  SettingsError: { otherwise: 400 },
  AutomationError: { by: { missing: 404 }, otherwise: 400 },
  AreaError: { by: { missing: 404, taken: 409 }, otherwise: 400, code: "area_" },
  PreferenceError: { by: { missing: 404, full: 409 }, otherwise: 400, code: "preference_" },
  DeviceError: { by: { missing: 404 }, otherwise: 400, code: "" },
  ProjectError: { by: { missing: 404, untrusted: 409 }, otherwise: 400, code: "" },
  FileError: { by: { missing: 404, taken: 409 }, otherwise: 400, code: "file_" },
  // Something is not in the state the command needs, unless the code says the command itself was wrong.
  RunError: { by: { invalid: 400, missing: 404 }, otherwise: 409, code: "" },
  NoticeStateError: { by: { invalid: 400, missing: 404 }, otherwise: 409, code: "" },
  ConversationError: { by: { invalid: 400, missing: 404 }, otherwise: 409, code: "" },
  // Operations (module-kit).
  UnknownOpError: { otherwise: 404 },
  OpInputError: { otherwise: 400 },
  // The home node's own services.
  PairingError: { otherwise: 400, code: "" },
  RemoteError: { otherwise: 409 },
  PushError: { otherwise: 400 },
  UploadError: { by: { too_big: 413, unsupported: 415 }, otherwise: 400, code: "file_" },
  WorkspaceError: { by: { not_git: 400, no_commit: 400, nothing: 400 }, otherwise: 409, code: "git_" },
  ProcessError: { by: { missing: 404, too_many: 409 }, otherwise: 400, code: "process_" },
  TerminalError: { by: { missing: 404, unavailable: 503, too_many: 409 }, otherwise: 400, code: "terminal_" },
  VoiceError: { by: { unavailable: 503, busy: 429 }, otherwise: 502, code: "voice_" },
  MailLabelError: { by: { missing: 404, permission: 403, reconnect: 409 }, otherwise: 502, code: "mail_" },
  ServiceError: { by: { reconnect: 409 }, otherwise: 502, code: "google_" },
  GoogleError: { by: { unknown_account: 404, no_client: 409, busy: 429 }, otherwise: 502, code: "" },
  // The engine's (skills, model sign-in, connectors).
  SkillError: { by: { not_found: 404, exists: 409, too_large: 413, unreachable: 502 }, otherwise: 400, code: "skill_" },
  ModelSignInError: { by: { unknown_provider: 404, missing: 404, busy: 409, state: 409 }, otherwise: 400, code: "" },
  McpConnectorError: { by: { missing: 404, exists: 409, state: 409, busy: 409, unreachable: 502 }, otherwise: 400, code: "" },
};

/** The status and body an error is answered with. */
export function statusOf(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "Request failed";
  const refusal = REFUSALS[name];
  if (refusal) {
    const code = (error as { code?: unknown }).code;
    const said = refusal.code !== undefined && code !== undefined ? { code: `${refusal.code}${String(code)}` } : {};
    // How many, when the refusal is about a number of things (files not committed).
    const count = (error as { count?: unknown }).count;
    return { status: refusal.by?.[String(code)] ?? refusal.otherwise, body: { error: message, ...said, ...(typeof count === "number" ? { count } : {}) } };
  }
  // A proposal says the state it is in, and that is its code.
  if (name === "ProposalStateError") {
    const state = (error as { state?: string }).state;
    return { status: state === "missing" ? 404 : 409, body: { error: message, code: state ?? "state" } };
  }
  // A module's own "it changed under you" (TodoConflictError), and a request id used for two different commands.
  if (name.endsWith("ConflictError")) return { status: 409, body: { error: message, code: "conflict" } };
  // What core and the modules throw without a name is about what they were given.
  if (name === "Error") return { status: 400, body: { error: message } };
  return { status: 500, body: { error: "Internal error" } };
}
