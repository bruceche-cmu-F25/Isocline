import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listEvents } from "@isocline/core";
import { todoModule } from "@isocline/module-todo";
import type { ConnectFlow, ConnectionsResponse } from "@isocline/protocol";
import { createHttpServer, openHome } from "../src/index.ts";
import { googleService } from "../src/google-service.ts";
import { GoogleConnections } from "../src/google.ts";
import { fileStore } from "../src/secrets.ts";

const SCOPE = "https://www.googleapis.com/auth/";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-google-"));
  writeFileSync(join(dataDir, "google-oauth-client.json"), JSON.stringify({ installed: { client_id: "test-client.apps.googleusercontent.com", client_secret: "test-secret" } }));
  const secrets = fileStore(join(dataDir, "secrets.json"));
  const calls: Array<{ url: string; body: URLSearchParams | null; auth: string | null }> = [];
  let granted = `openid ${SCOPE}userinfo.email ${SCOPE}calendar.readonly`;
  let refreshFails = false;
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
  // Stands in for Google: the token endpoint, revoke, and the calendar API.
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (body?.get("grant_type") === "refresh_token") {
        return refreshFails ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "access-2", expires_in: 3600 });
      }
      return json(200, { access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1", scope: granted, id_token: idToken("You@Gmail.com") });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
    if (url.startsWith("https://www.googleapis.com/calendar/")) return json(200, { items: [{}, {}, {}] });
    return json(404, { error: "unexpected" });
  }) as typeof fetch;
  return {
    dataDir, secrets, calls, fakeFetch,
    grant(scopes: string) { granted = scopes; },
    breakRefresh() { refreshFails = true; },
  };
}

/** Plays the browser: follows Google's redirect back to the loopback callback. */
async function callback(url: string, params: Record<string, string>): Promise<Response> {
  const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
  for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
  return fetch(redirect);
}

test("connecting a Google account: consent URL, callback, token in the secret store, only granted capabilities on", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  assert.deepEqual(google.status(), { client: { configured: true, source: "file" }, accounts: [] });

  const { id, url } = await google.start({ capabilities: ["calRead", "mailRead"] });
  const auth = new URL(url);
  assert.equal(auth.origin + auth.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(auth.searchParams.get("client_id"), "test-client.apps.googleusercontent.com");
  assert.match(auth.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("scope"), `openid email ${SCOPE}calendar.readonly ${SCOPE}gmail.readonly`);

  // A callback that is not ours changes nothing.
  assert.equal((await callback(url, { code: "c", state: "wrong" })).status, 400);
  assert.equal(google.flow(id)?.status, "waiting");

  // The user unticked Gmail on the consent page: only the calendar is granted.
  const page = await callback(url, { code: "the-code", state: auth.searchParams.get("state")! });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /连上了/);
  assert.deepEqual(google.flow(id), { id, status: "done", account: "you@gmail.com", capabilities: ["calRead"], missing: ["mailRead"] });

  const exchange = t.calls.find((call) => call.body?.get("grant_type") === "authorization_code")!;
  assert.equal(exchange.body!.get("code"), "the-code");
  assert.ok(exchange.body!.get("code_verifier")!.length >= 43);
  assert.equal(exchange.body!.get("redirect_uri"), auth.searchParams.get("redirect_uri"));

  const stored = JSON.parse((await t.secrets.get("google:you@gmail.com"))!);
  assert.equal(stored.refresh, "refresh-1");
  assert.equal(statSync(join(t.dataDir, "secrets.json")).mode & 0o777, 0o600);
  // The account list has no secrets in it.
  assert.doesNotMatch(readFileSync(join(t.dataDir, "connections.json"), "utf8"), /refresh|access/);
  assert.deepEqual(google.status().accounts.map((account) => [account.email, account.capabilities]), [["you@gmail.com", ["calRead"]]]);
});

test("more capabilities later ask for the account's existing scopes plus the new one, as that account", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  const first = await google.start({ capabilities: ["calRead"] });
  await callback(first.url, { code: "c1", state: new URL(first.url).searchParams.get("state")! });

  t.grant(`openid ${SCOPE}userinfo.email ${SCOPE}calendar.readonly ${SCOPE}calendar.events`);
  const more = await google.start({ capabilities: ["calWrite"], account: "you@gmail.com" });
  const auth = new URL(more.url);
  assert.equal(auth.searchParams.get("login_hint"), "you@gmail.com");
  assert.equal(auth.searchParams.get("include_granted_scopes"), "true");
  assert.equal(auth.searchParams.get("scope"), `openid email ${SCOPE}calendar.readonly ${SCOPE}calendar.events`);
  await callback(more.url, { code: "c2", state: auth.searchParams.get("state")! });
  assert.deepEqual(google.status().accounts[0].capabilities, ["calRead", "calWrite"]);

  // Turning one off needs no trip to Google.
  google.disable("you@gmail.com", "calWrite");
  assert.deepEqual(google.status().accounts[0].capabilities, ["calRead"]);
});

test("cancelling at Google, and cancelling from Isocline, end the sign-in without connecting", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  const denied = await google.start({ capabilities: ["calRead"] });
  await callback(denied.url, { error: "access_denied", state: new URL(denied.url).searchParams.get("state")! });
  assert.equal(google.flow(denied.id)?.status, "cancelled");

  const abandoned = await google.start({ capabilities: ["calRead"] });
  assert.equal(google.cancel(abandoned.id)?.status, "cancelled");
  await assert.rejects(callback(abandoned.url, { code: "c", state: "s" }));
  assert.deepEqual(google.status().accounts, []);
});

test("access tokens refresh when expired; a refused refresh marks the account broken", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  const flow = await google.start({ capabilities: ["calRead"] });
  await callback(flow.url, { code: "c", state: new URL(flow.url).searchParams.get("state")! });

  assert.equal(await google.accessToken("you@gmail.com"), "access-1");
  const stored = JSON.parse((await t.secrets.get("google:you@gmail.com"))!);
  await t.secrets.set("google:you@gmail.com", JSON.stringify({ ...stored, expires: Date.now() - 1 }));
  assert.equal(await google.accessToken("you@gmail.com"), "access-2");
  assert.deepEqual(await google.check("you@gmail.com"), { calendar: 3 });
  assert.equal(t.calls.at(-1)!.auth, "Bearer access-2");

  await t.secrets.set("google:you@gmail.com", JSON.stringify({ ...stored, access: undefined }));
  t.breakRefresh();
  await assert.rejects(google.accessToken("you@gmail.com"), { name: "GoogleError", code: "broken" });
  assert.equal(google.status().accounts[0].broken, true);
});

test("disconnecting revokes at Google and forgets the token", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  const flow = await google.start({ capabilities: ["calRead"] });
  await callback(flow.url, { code: "c", state: new URL(flow.url).searchParams.get("state")! });
  assert.deepEqual(await google.disconnect("you@gmail.com"), { revoked: true });
  assert.equal(t.calls.at(-1)!.body!.get("token"), "refresh-1");
  assert.equal(await t.secrets.get("google:you@gmail.com"), undefined);
  assert.deepEqual(google.status().accounts, []);
});

test("over HTTP: status, connect, poll the flow; every change is a connection event", async () => {
  const t = setup();
  const home = openHome({ dataDir: t.dataDir, engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: [todoModule] });
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, world: home.world, fetch: t.fakeFetch });
  const server: Server = createHttpServer(home, { port: 0, uiDir: "/nonexistent", google });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const status = (await (await fetch(`${base}/api/connections`)).json()) as ConnectionsResponse;
    assert.equal(status.google.client.configured, true);
    assert.equal((await post("/api/connections/google/connect", { capabilities: ["nope"] })).status, 400);

    const { flow } = (await (await post("/api/connections/google/connect", { capabilities: ["calRead"] })).json()) as { flow: { id: string; url: string } };
    assert.equal(((await (await fetch(`${base}/api/connections/flows/${flow.id}`)).json()) as ConnectFlow).status, "waiting");
    await callback(flow.url, { code: "c", state: new URL(flow.url).searchParams.get("state")! });
    assert.equal(((await (await fetch(`${base}/api/connections/flows/${flow.id}`)).json()) as ConnectFlow).status, "done");

    const check = await fetch(`${base}/api/connections/google/${encodeURIComponent("you@gmail.com")}/check`);
    assert.deepEqual(await check.json(), { calendar: 3 });
    assert.equal((await post(`/api/connections/google/${encodeURIComponent("you@gmail.com")}/disconnect`, {})).status, 200);
    assert.equal((await post(`/api/connections/google/${encodeURIComponent("nobody@gmail.com")}/disconnect`, {})).status, 404);

    const kinds = listEvents(home.world).events.filter((event) => event.kind.startsWith("connection.")).map((event) => [event.kind, event.subject, event.actor]);
    assert.deepEqual(kinds, [["connection.connected", "google:you@gmail.com", "user"], ["connection.disconnected", "google:you@gmail.com", "user"]]);
  } finally {
    server.close();
    google.close();
    home.close();
  }
});

test("Gmail star syncing is a separate, incremental grant and preserves read-only access", async () => {
  const t = setup();
  const google = new GoogleConnections({ dataDir: t.dataDir, secrets: t.secrets, fetch: t.fakeFetch });
  try {
    t.grant(`openid ${SCOPE}gmail.readonly`);
    const read = await google.start({ capabilities: ["mailRead"] });
    assert.doesNotMatch(new URL(read.url).searchParams.get("scope")!, /gmail\.modify/);
    await callback(read.url, { code: "read", state: new URL(read.url).searchParams.get("state")! });
    const addStar = async () => {
      const flow = await google.start({ account: "you@gmail.com", capabilities: ["mailModify"] });
      const params = new URL(flow.url).searchParams;
      assert.match(params.get("scope")!, /gmail\.modify/);
      await callback(flow.url, { code: "modify", state: params.get("state")! });
      return google.flow(flow.id);
    };
    const denied = await addStar();
    assert.ok(denied?.status === "done");
    assert.deepEqual(denied.missing, ["mailModify"]);
    assert.deepEqual(google.status().accounts[0].capabilities, ["mailRead"]);
    t.grant(`openid ${SCOPE}gmail.modify`);
    await addStar();
    assert.deepEqual(google.status().accounts[0].capabilities, ["mailRead", "mailModify"]);
    google.disable("you@gmail.com", "mailModify");
    assert.deepEqual(google.status().accounts[0].capabilities, ["mailRead"]);
  } finally { google.close(); }
});


test("a Google session keeps its request deadline when a sync also supplies a shutdown signal", async (t) => {
  const fixture = setup();
  const connection = new GoogleConnections({ dataDir: fixture.dataDir, secrets: fixture.secrets, fetch: fixture.fakeFetch });
  t.mock.method(connection, "accessToken", async () => "fixture-token");
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const request = t.mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return new Response("{}");
  });
  const session = await googleService(connection, request as typeof fetch).session("sample@example.com");
  const caller = new AbortController();
  await session.get("https://example.test/messages", caller.signal);
  assert.equal(request.mock.calls.length, 1);
  caller.abort();
  await assert.rejects(session.get("https://example.test/messages", caller.signal), { code: "unavailable" });
  deadline.abort();
  const live = new AbortController().signal;
  await assert.rejects(session.get("https://example.test/messages", live), { code: "unavailable" });
  await assert.rejects(session.send("POST", "https://example.test/modify", {}, { signal: live }), { code: "unavailable" });
});

test("Google out of reach names the network's reason, not only \"fetch failed\"", async (t) => {
  const fixture = setup();
  const connection = new GoogleConnections({ dataDir: fixture.dataDir, secrets: fixture.secrets, fetch: fixture.fakeFetch });
  t.mock.method(connection, "accessToken", async () => "fixture-token");
  const offline = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); };
  const session = await googleService(connection, offline as typeof fetch).session("sample@example.com");
  await assert.rejects(session.get("https://example.test/messages"), { code: "unavailable", message: "Google could not be reached: fetch failed (ENOTFOUND)" });
});

test("a newcomer's own Google client: a Desktop app client file is checked, kept privately, and used at once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-google-client-"));
  const google = new GoogleConnections({ dataDir, secrets: fileStore(join(dataDir, "secrets.json")) });
  assert.equal(google.status().client.configured, false);
  assert.throws(() => google.saveClient({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } }), /Desktop app/);
  assert.throws(() => google.saveClient({ installed: { client_id: "not-google", client_secret: "s" } }), /not a Google OAuth client/);
  assert.throws(() => google.saveClient("nonsense"), /not a Google OAuth client/);
  assert.equal(google.status().client.configured, false);
  const status = google.saveClient({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-x", redirect_uris: ["http://localhost"] } });
  assert.deepEqual(status.client, { configured: true, source: "file" });
  const path = join(dataDir, "google-oauth-client.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-x" } });
});
