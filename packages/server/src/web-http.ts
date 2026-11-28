/** `/api/web/*`: Settings → Web (docs/design/web.md §4, §6). The host and origin checks of http.ts have already run,
 * and only this machine reaches these routes: they hold keys. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebResponse, WebService, WebTestResponse } from "@zirma/protocol";
import { WebSettingsError, type WebAccess } from "./web/access.ts";
import { CONNECTOR_ID } from "./web/connectors.ts";
import { SearchError } from "./web/providers/index.ts";
import { HttpError, readJson, send } from "./wire.ts";

/** What Settings shows: the switch, every service Zirma knows with whether it is used and has a key, the sites, and
 * the record. Keys themselves never leave the home node. */
export async function describeWeb(web: WebAccess): Promise<WebResponse> {
  const config = web.config();
  const today = web.today();
  const one = async (service: { id: string; title: string; zhTitle?: string; about: { zh: string; en: string }; needs: WebService["needs"]; keyPage?: string; modelProvider?: string }, connector = false): Promise<WebService> => ({
    id: service.id, title: service.title, ...(service.zhTitle ? { zhTitle: service.zhTitle } : {}), about: service.about, needs: service.needs,
    ...(service.keyPage ? { keyPage: service.keyPage } : {}),
    ...(service.modelProvider ? { modelProvider: service.modelProvider } : {}),
    // One that searches with a model's key has one when Models does; the key itself stays on the home node.
    hasKey: connector ? false : service.needs === "model"
      ? Boolean(service.modelProvider && await web.modelKeys?.apiKey(service.modelProvider).catch(() => null))
      : Boolean(await web.key(service.id).catch(() => null)),
    ...(config.addresses[service.id] ? { address: config.addresses[service.id] } : {}),
    today: today[service.id] ?? 0,
    ...(web.limitedToday(service.id) ? { limited: true } : {}),
    ...(connector ? { connector: true } : {}),
  });
  const own = await Promise.all(web.providers.map((provider) => one(provider)));
  const connected = await Promise.all((await web.connectorProviders(false)).map((provider) => one(provider, true)));
  // A connector's tool in the list whose server is away still shows, so it can be taken out.
  const away = config.search.filter((id) => CONNECTOR_ID.test(id) && !connected.some((service) => service.id === id)).map((id): WebService => {
    const [, server, tool] = CONNECTOR_ID.exec(id)!;
    return { id, title: `${server} · ${tool}`, about: { zh: "连接器现在连不上", en: "The connector cannot be reached now" }, needs: "nothing", hasKey: false, today: today[id] ?? 0, connector: true };
  });
  const readers = await Promise.all(web.readers.map((reader) => one(reader)));
  return { on: config.on, search: config.search, services: [...own, ...connected, ...away], read: config.read, readers, sites: config.sites, records: web.records() };
}

const bad = (error: unknown): never => {
  if (error instanceof WebSettingsError) throw new HttpError(400, error.message, "web_invalid");
  throw error;
};

/** Handles the request when it is one of the web routes; false when it is not. */
export async function handleWeb(web: WebAccess, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path === "/api/web") {
    if (method === "GET") return send(res, 200, await describeWeb(web)), true;
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson<Record<string, unknown>>(req);
    try {
      web.update({
        ...(body.on !== undefined ? { on: body.on as boolean } : {}),
        ...(body.search !== undefined ? { search: body.search as string[] } : {}),
        ...(body.read !== undefined ? { read: body.read as string[] } : {}),
        ...(body.sites !== undefined ? { sites: body.sites as string[] } : {}),
      });
    } catch (error) { bad(error); }
    return send(res, 200, await describeWeb(web)), true;
  }
  const key = /^\/api\/web\/keys\/([a-z0-9-]{1,40})(\/remove)?$/.exec(path);
  if (key) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    try {
      if (key[2]) await web.deleteKey(key[1]!);
      else await web.setKey(key[1]!, String((await readJson<Record<string, unknown>>(req)).key ?? ""));
    } catch (error) { bad(error); }
    return send(res, 200, await describeWeb(web)), true;
  }
  const address = /^\/api\/web\/address\/([a-z0-9-]{1,40})$/.exec(path)?.[1];
  if (address) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    try { web.setAddress(address, String((await readJson<Record<string, unknown>>(req)).address ?? "")); } catch (error) { bad(error); }
    return send(res, 200, await describeWeb(web)), true;
  }
  // A connector's tool is `mcp:<server>:<tool>`, sent encoded.
  const testing = /^\/api\/web\/test\/([^/]{1,240})$/.exec(path)?.[1];
  let tried: string | undefined;
  try { tried = testing ? decodeURIComponent(testing) : undefined; } catch { throw new HttpError(404, "No such service"); }
  if (tried) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const query = String((await readJson<Record<string, unknown>>(req)).query ?? "").trim().slice(0, 200);
    if (!query) throw new HttpError(400, "query is required", "web_invalid");
    if (!/^[a-z0-9-]{1,40}$/.test(tried) && !CONNECTOR_ID.test(tried)) throw new HttpError(404, "No such service");
    try {
      return send(res, 200, await web.test(tried, query) satisfies WebTestResponse), true;
    } catch (error) {
      // A refused key or a used-up quota is the service's answer, not the home node failing.
      if (error instanceof SearchError) throw new HttpError(error.code === "refused" ? 400 : error.code === "limit" ? 429 : 502, error.message, `web_${error.code}`);
      return bad(error);
    }
  }
  if (path === "/api/web/records/clear") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    web.clearRecords();
    return send(res, 200, await describeWeb(web)), true;
  }
  return false;
}
