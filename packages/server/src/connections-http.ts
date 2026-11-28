/** `/api/connections/*`: connected accounts and model sign-in (see @zirma/protocol). The host and
 * origin checks of http.ts have already run. Paired devices can read subscription usage. Nothing here
 * returns a secret. Errors are thrown; the listener says a GoogleError, ModelSignInError or McpConnectorError as its
 * status (wire.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpConnectors, ModelAccounts } from "@zirma/engine-pi";
import type { ConnectionsResponse, GoogleConnectRequest, McpSearchResponse, NewMcpConnector } from "@zirma/protocol";
import { isGoogleCapability, type GoogleConnections } from "./google.ts";
import { Fault, HttpError, readJson, send } from "./wire.ts";

const ACCOUNT = /^\/api\/connections\/google\/([^/]{3,200})\/(disable|disconnect|check)$/;
const FLOW = /^\/api\/connections\/flows\/([A-Za-z0-9_-]{1,32})(\/cancel)?$/;
const MODEL_PROVIDER = /^\/api\/connections\/models\/([a-z0-9][a-z0-9._-]{0,63})\/(login|logout)$/;
const MODEL_FLOW = /^\/api\/connections\/models\/flows\/([A-Za-z0-9_-]{1,32})(?:\/(answer|cancel))?$/;
export const MODEL_USAGE_PATH = "/api/connections/models/usage";

const MCP_FLOW = /^\/api\/connections\/mcp\/flows\/([A-Za-z0-9_-]{1,32})(\/cancel)?$/;
const MCP_SERVER = /^\/api\/connections\/mcp\/([A-Za-z0-9_-]{1,64})\/(login|logout|enable|disable|check|remove)$/;

/** What the connections routes can reach; each part's routes are 404 without it. */
export interface Connections { google?: GoogleConnections; models?: ModelAccounts; mcp?: McpConnectors }

const texts = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every((item) => typeof item === "string")) throw new HttpError(400, "headers, env and values are names with text values");
  return value as Record<string, string>;
};

/** Connectors (MCP servers): the list and the catalog, adding and removing, signing in. */
async function mcpRoutes(mcp: McpConnectors, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/connections/mcp") return send(res, 200, await mcp.describe()), true;
  if (method === "POST" && path === "/api/connections/mcp/search") {
    const body = await readJson(req);
    if (typeof body.query !== "string" || !body.query.trim()) throw new HttpError(400, "query is required");
    return send(res, 200, { results: await mcp.search(body.query) } satisfies McpSearchResponse), true;
  }
  if (method === "POST" && path === "/api/connections/mcp") {
    const body = await readJson(req);
    const text = (key: string) => (typeof body[key] === "string" ? body[key] as string : undefined);
    const input: NewMcpConnector = {
      catalog: text("catalog"), token: text("token"), found: text("found"), registry: text("registry"), values: texts(body.values),
      name: text("name"), url: text("url"), command: text("command"),
      ...(Array.isArray(body.args) ? { args: body.args.filter((item): item is string => typeof item === "string") } : {}),
      headers: texts(body.headers), env: texts(body.env),
    };
    return send(res, 200, await mcp.add(input)), true;
  }
  const flow = MCP_FLOW.exec(path);
  if (flow && (method === "GET" ? !flow[2] : method === "POST" && !!flow[2])) {
    if (method === "POST") await readJson(req);
    const state = flow[2] ? mcp.cancel(flow[1]) : mcp.flow(flow[1]);
    return send(res, state ? 200 : 404, state ?? { error: "No such sign-in (finished long ago, or the home node restarted)" }), true;
  }
  const server = MCP_SERVER.exec(path);
  if (server && method === "POST") {
    await readJson(req);
    const [, name, action] = server;
    if (action === "login") return send(res, 200, await mcp.login(name)), true;
    if (action === "logout") return send(res, 200, await mcp.logout(name)), true;
    if (action === "check") return send(res, 200, await mcp.check(name)), true;
    if (action === "remove") { await mcp.remove(name); return send(res, 200, {}), true; }
    return send(res, 200, await mcp.setEnabled(name, action === "enable")), true;
  }
  return false;
}

/** Model sign-in: providers, signing in and out, importing keys from Pi. */
async function modelRoutes(models: ModelAccounts, req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/connections/models") return send(res, 200, await models.describe()), true;
  if (method === "GET" && path === MODEL_USAGE_PATH) return send(res, 200, await models.usage(url.searchParams.get("fresh") === "1")), true;
  if (method === "POST" && path === "/api/connections/models/import") {
    const body = await readJson(req);
    const providers = Array.isArray(body.providers) ? body.providers.filter((item): item is string => typeof item === "string") : [];
    return send(res, 200, await models.importFromPi(providers)), true;
  }
  const flow = MODEL_FLOW.exec(path);
  if (flow) {
    const [, id, action] = flow;
    if (method === "GET" && !action) {
      const state = models.flow(id);
      return send(res, state ? 200 : 404, state ?? { error: "No such sign-in (finished long ago, or the home node restarted)" }), true;
    }
    if (method === "POST" && action === "answer") {
      const body = await readJson(req);
      if (typeof body.promptId !== "string" || typeof body.value !== "string") return send(res, 400, { error: "promptId and value are required" }), true;
      return send(res, 200, models.answer(id, body.promptId, body.value)), true;
    }
    if (method === "POST" && action === "cancel") {
      await readJson(req);
      const state = models.cancel(id);
      return send(res, state ? 200 : 404, state ?? { error: "No such sign-in" }), true;
    }
  }
  const provider = MODEL_PROVIDER.exec(path);
  if (provider && method === "POST") {
    const body = await readJson(req);
    if (provider[2] === "logout") return send(res, 200, await models.logout(provider[1])), true;
    if (body.method !== "oauth" && body.method !== "api_key") return send(res, 400, { error: "method is oauth or api_key" }), true;
    return send(res, 200, await models.start(provider[1], body.method)), true;
  }
  return false;
}

/** Handles the request when it is under /api/connections; false when it is not. */
export async function handleConnections(services: Connections, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/connections")) return false;
  const method = req.method ?? "GET";
  const { google, models, mcp } = services;
  try {
    if (path === "/api/connections/mcp" || path.startsWith("/api/connections/mcp/")) {
      if (mcp && await mcpRoutes(mcp, req, res, path)) return true;
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (path.startsWith("/api/connections/models")) {
      if (models && await modelRoutes(models, req, res, path, url)) return true;
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (!google) {
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (method === "GET" && path === "/api/connections") {
      send(res, 200, { google: google.status() } satisfies ConnectionsResponse);
      return true;
    }
    if (method === "POST" && path === "/api/connections/google/client") {
      const body = (await readJson(req)) as { client?: unknown };
      send(res, 200, { google: google.saveClient(body.client) } satisfies ConnectionsResponse);
      return true;
    }
    if (method === "POST" && path === "/api/connections/google/connect") {
      const body = (await readJson(req)) as Partial<GoogleConnectRequest>;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
      if (!capabilities.every(isGoogleCapability)) return send(res, 400, { error: "Unknown capability" }), true;
      if (body.account !== undefined && typeof body.account !== "string") return send(res, 400, { error: "account is an email" }), true;
      send(res, 200, { flow: await google.start({ capabilities, account: body.account }) });
      return true;
    }
    const flow = FLOW.exec(path);
    if (flow && (method === "GET" ? !flow[2] : method === "POST" && !!flow[2])) {
      if (method === "POST") await readJson(req);
      const status = flow[2] ? google.cancel(flow[1]) : google.flow(flow[1]);
      send(res, status ? 200 : 404, status ?? { error: "No such sign-in (finished long ago, or the home node restarted)" });
      return true;
    }
    const account = ACCOUNT.exec(path);
    if (account) {
      const email = decodeURIComponent(account[1]);
      const action = account[2];
      if (action === "check" && method === "GET") return send(res, 200, await google.check(email)), true;
      if (method === "POST" && action === "disable") {
        const body = await readJson(req);
        if (!isGoogleCapability(body.capability)) return send(res, 400, { error: "Unknown capability" }), true;
        send(res, 200, google.disable(email, body.capability));
        return true;
      }
      if (method === "POST" && action === "disconnect") {
        await readJson(req);
        send(res, 200, await google.disconnect(email));
        return true;
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    // These services name every refusal of theirs, so a bare Error out of one is the home node's fault (500, logged),
    // not something about what was sent.
    throw error instanceof Error && error.constructor === Error ? new Fault(error) : error;
  }
  return true;
}
