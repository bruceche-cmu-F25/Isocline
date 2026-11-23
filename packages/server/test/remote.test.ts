import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { get as httpGet, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addProject, CORE_MIGRATIONS, deviceForToken, fileStore, listDevices, listEvents, openWorld, pairDevice, revokeDevice, startSession, submitRun, trustProject, type EnginePort } from "@alfred/core";
import { createCredentialStore, ModelAccounts } from "@alfred/engine-pi";
import { todoModule } from "@alfred/module-todo";
import type { ArchivedConversation, ModelUsageResponse, OutletsResponse, PairingCode, RemoteResponse, StateResponse, SubmitRunResponse } from "@alfred/protocol";
import { createHttpServer, createIngressServer, openHome, PushService, RemoteAccess, Tailscale, type Home, type Runner } from "../src/index.ts";

const DNS = "mini.tail1234.ts.net";
const OWNER = "bruce@example.com";
const engine: EnginePort = { submit: () => Promise.reject(new Error("no engine")) };

/** A machine's Tailscale: logged in, with something else already served on :443. */
function fakeTailscale(served: Record<string, string> = { [`${DNS}:443`]: "http://127.0.0.1:30141" }) {
  const calls: string[] = [];
  const run: Runner = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 7 }, User: { 7: { LoginName: OWNER } } });
    if (args.join(" ") === "serve status --json") {
      return JSON.stringify({ Web: Object.fromEntries(Object.entries(served).map(([key, proxy]) => [key, { Handlers: { "/": { Proxy: proxy } } }])) });
    }
    if (args[0] === "serve" && args[1] === "--bg") { served[`${DNS}:${args[2].split("=")[1]}`] = args[3]; return ""; }
    if (args[0] === "serve" && args[2] === "off") { delete served[`${DNS}:${args[1].split("=")[1]}`]; return ""; }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  return { run, served, calls };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }
function ask(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: options.method ?? (payload ? "POST" : "GET"),
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...options.headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text.startsWith("{") ? JSON.parse(text) : {} }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function setUp(served?: Record<string, string>, models?: ModelAccounts) {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-"));
  const home: Home = openHome({ dataDir, engine, modules: [todoModule] });
  const tailscale = fakeTailscale(served);
  // The ingress port must be known before RemoteAccess points Serve at it; the listener reads `remote` per request.
  const pushed: string[] = [];
  const secrets = new Map<string, string>();
  const push = new PushService({
    dataDir, world: home.world, send: async (subscription, payload) => { pushed.push(`${subscription.endpoint} ${payload}`); },
    secrets: { kind: "file", get: async (name) => secrets.get(name), set: async (name, value) => { secrets.set(name, value); }, delete: async (name) => { secrets.delete(name); } },
  });
  const options = { port: 0, uiDir: "/nonexistent", remote: undefined as unknown as RemoteAccess, push, models };
  const ingressServer = createIngressServer(home, options);
  const ingress = await listen(ingressServer);
  const remote = new RemoteAccess({ dataDir, world: home.world, tailscale: new Tailscale(tailscale.run), ingressPort: ingress });
  options.remote = remote;
  remote.events.on("revoked", (id) => push.unsubscribe(id));
  const localServer = createHttpServer(home, { port: 0, uiDir: "/nonexistent", remote, push, models });
  const local = await listen(localServer);
  await remote.restore();
  const close = () => {
    for (const server of [ingressServer, localServer]) { server.close(); server.closeAllConnections(); }
    home.close();
  };
  return { home, remote, tailscale, ingress, local, close, dataDir, pushed };
}

/** A request as Serve forwards it: the tailnet Host, the user's login. */
const viaServe = (extra: Record<string, string> = {}) => ({ Host: `${DNS}:4443`, "Tailscale-User-Login": OWNER, ...extra });

test("devices: tokens are kept only as hashes, and a revoked device is refused at once", () => {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const token = "t".repeat(43);
  const device = pairDevice(world, { token, name: "Bruce's iPhone", kind: "phone", via: OWNER });
  const row = world.db.prepare("SELECT * FROM core_devices").get()!;
  assert.notEqual(row.token_hash, token);
  assert.equal(deviceForToken(world, token)?.id, device.id);
  assert.equal(deviceForToken(world, "nope"), null);
  revokeDevice(world, device.id);
  assert.equal(deviceForToken(world, token), null);
  assert.deepEqual(listDevices(world), []);
  const kinds = world.db.prepare("SELECT kind FROM core_events ORDER BY seq").all().map((event) => event.kind);
  assert.deepEqual(kinds, ["device.paired", "device.revoked"]);
  assert.throws(() => pairDevice(world, { token: "short", name: "x", kind: "phone" }), /32 characters/);
  world.close();
});

test("turning remote access on adds one Serve entry for Alfred and leaves the user's others alone", async () => {
  const { local, ingress, tailscale, close } = await setUp();
  try {
    const off = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(off.enabled, false);
    assert.equal(off.tailscale.dnsName, DNS);
    assert.equal(off.tailscale.owner, OWNER);

    const on = (await ask(local, "/api/remote", { body: { enabled: true } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(on.serving, true);
    assert.equal(on.url, `https://${DNS}:4443`);
    assert.deepEqual(tailscale.served, { [`${DNS}:443`]: "http://127.0.0.1:30141", [`${DNS}:4443`]: `http://127.0.0.1:${ingress}` });

    const again = (await ask(local, "/api/remote", { body: { enabled: false } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(again.serving, false);
    assert.deepEqual(tailscale.served, { [`${DNS}:443`]: "http://127.0.0.1:30141" });
  } finally { close(); }
});

test("a port already served by something else is left alone and reported", async () => {
  const { local, tailscale, close } = await setUp({ [`${DNS}:4443`]: "http://127.0.0.1:9999" });
  try {
    const on = (await ask(local, "/api/remote", { body: { enabled: true } })).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(on.serving, false);
    assert.match(on.error ?? "", /used by something else/);
    assert.equal(tailscale.served[`${DNS}:4443`], "http://127.0.0.1:9999");
    assert.ok(!tailscale.calls.some((call) => call.startsWith("serve --bg")));
  } finally { close(); }
});

test("a device pairs with a one-time code, then reaches everything but credentials and other devices", async () => {
  const { local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });

    // Not paired: the interface loads, the API does not.
    const unpaired = await ask(ingress, "/api/state", { headers: viaServe() });
    assert.equal(unpaired.status, 401);
    assert.equal(unpaired.body.code, "unpaired");
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "AAAA-AAAA", name: "Phone", kind: "phone" } })).body.code, "none");

    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(pairing.url, `https://${DNS}:4443/?pair=${pairing.code.replace("-", "")}`);
    // Pairing is for other devices; this machine cannot hand out codes from the ingress.
    assert.equal((await ask(ingress, "/api/remote/pairing", { headers: viaServe(), body: {} })).status, 401);

    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "WRONGCOD", name: "Phone", kind: "phone" } })).body.code, "invalid");
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code.toLowerCase(), name: "Bruce's iPhone", kind: "phone" } });
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers["set-cookie"]?.[0]);
    assert.match(cookie, /^alfred_device=[\w-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    const token = cookie.split(";")[0];
    // The code was spent.
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "Again", kind: "phone" } })).body.code, "none");

    const as = viaServe({ Cookie: token });
    assert.equal((await ask(ingress, "/api/state", { headers: as })).status, 200);
    assert.equal((await ask(ingress, "/api/ops/todo.add", { headers: as, body: { requestId: "p-1", input: { title: "From the phone" } } })).status, 200);
    const self = (await ask(ingress, "/api/remote", { headers: as })).body as Extract<RemoteResponse, { local: false }>;
    assert.equal(self.local, false);
    assert.equal(self.device.name, "Bruce's iPhone");
    assert.equal(self.device.via, OWNER);
    for (const [path, body] of [["/api/connections", undefined], ["/api/remote", { enabled: false }], ["/api/remote/pairing", {}], [`/api/devices/${self.device.id}/revoke`, {}],
      ["/api/projects", { path: "/tmp" }], ["/api/projects/abc/trust", {}]] as const) {
      const reply = await ask(ingress, path, { headers: as, body });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.body.code, "local_only", path);
    }

    // Another tailnet account's device is turned away even with a token; so is a foreign Host or Origin.
    assert.equal((await ask(ingress, "/api/state", { headers: viaServe({ Cookie: token, "Tailscale-User-Login": "friend@example.com" }) })).status, 403);
    assert.equal((await ask(ingress, "/api/state", { headers: { ...as, Host: "evil.example" } })).status, 403);
    assert.equal((await ask(ingress, "/api/ops/todo.add", { headers: { ...as, Origin: "https://evil.example" }, body: { requestId: "p-2", input: { title: "x" } } })).status, 403);
    // The local port does not accept the tailnet name: Serve only ever reaches the ingress.
    assert.equal((await ask(local, "/api/state", { headers: { Host: `${DNS}:4443` } })).status, 403);

    // The Mac sees the device; revoking it ends its open stream and refuses its next request.
    const listed = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.deepEqual(listed.devices.map((device) => device.name), ["Bruce's iPhone"]);
    const stream = new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: ingress, path: "/api/events", headers: as }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on("data", () => {});
        res.on("end", () => resolve("ended"));
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ask(local, `/api/devices/${self.device.id}/revoke`, { body: {} });
    assert.equal(await stream, "ended");
    assert.equal((await ask(ingress, "/api/state", { headers: as })).status, 401);
  } finally { close(); }
});

test("a paired phone reads and refreshes subscription usage while model accounts stay on the home node", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-phone-usage-"));
  const store = createCredentialStore({ secrets: fileStore(join(dataDir, "secrets.json")), lockDir: dataDir });
  await store.modify("anthropic", async () => ({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000 }));
  let utilization = 20;
  const models = new ModelAccounts({ dataDir, piAgentDir: join(dataDir, "pi"), store,
    fetch: async () => Response.json({ five_hour: { utilization } }),
  });
  const { home, local, ingress, close } = await setUp(undefined, models);
  try {
    const usage = "/api/connections/models/usage";
    assert.equal((await ask(ingress, usage, { headers: viaServe() })).status, 401);
    const token = "p".repeat(43);
    pairDevice(home.world, { name: "Phone", kind: "phone", token });
    const headers = viaServe({ Cookie: `alfred_device=${token}` });
    const first = await ask(ingress, usage, { headers });
    assert.equal(first.status, 200);
    const [item] = (first.body as unknown as ModelUsageResponse).usage;
    assert.equal(item.provider, "anthropic");
    assert.deepEqual(item.windows, [{ id: "five_hour", minutes: 300, used: 20 }]);
    assert.doesNotMatch(JSON.stringify(first.body), /test-access|test-refresh/);
    utilization = 35;
    assert.deepEqual((await ask(ingress, usage, { headers })).body, first.body);
    const fresh = await ask(ingress, usage + "?fresh=1", { headers });
    assert.equal(fresh.status, 200);
    assert.equal((fresh.body as unknown as ModelUsageResponse).usage[0].windows[0].used, 35);
    assert.deepEqual((await ask(local, usage)).body, fresh.body);
    for (const [path, method] of [[usage, "POST"], ["/api/connections/models", "GET"], ["/api/connections/models/anthropic/logout", "POST"]]) {
      const reply = await ask(ingress, path, { headers, method });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.body.code, "local_only", path);
    }
  } finally { close(); models.close(); }
});

test("an outlet's report is filed under the device it came from, and is not an event; an outlet in use says the user is here", async () => {
  const { home, local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "iPhone", kind: "phone" } });
    const as = viaServe({ Cookie: String(paired.headers["set-cookie"]?.[0]).split(";")[0] });
    const phone = ((await ask(ingress, "/api/remote", { headers: as })).body as Extract<RemoteResponse, { local: false }>).device.id;
    const before = listEvents(home.world).cursor;

    // A device that is not paired has no say in where the user is.
    assert.equal((await ask(ingress, "/api/outlets", { headers: viaServe(), body: { client: "tab-1", kind: "window", attending: true } })).status, 401);
    for (const body of [{}, { client: "tab-1", kind: "push", attending: true }, { client: "tab 1", kind: "window", attending: true },
      { client: "tab-1", kind: "window", attending: "yes" }, { client: "tab-1", kind: "window", attending: true, idleMs: -5 }]) {
      assert.equal((await ask(ingress, "/api/outlets", { headers: as, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await ask(local, "/api/outlets", { body: { client: "mac", kind: "figure", attending: false, idleMs: 300_000 } })).status, 200);
    assert.equal((await ask(ingress, "/api/outlets", { headers: as, body: { client: "tab-1", kind: "window", attending: true, idleMs: 2_000 } })).status, 200);

    // The home node now knows the phone is in the user's hand, and the Mac is not being used. Either side may ask.
    for (const reply of [await ask(local, "/api/outlets"), await ask(ingress, "/api/outlets", { headers: as })]) {
      const { outlets } = reply.body as unknown as OutletsResponse;
      assert.deepEqual(outlets.map((outlet) => [outlet.client, outlet.kind, outlet.device, outlet.attending, outlet.idleSeconds]), [
        ["tab-1", "window", phone, true, 2],
        ["mac", "figure", "home", false, 300],
      ]);
    }
    // What a device sees right now is not something that happened. That the user is here is: the phone in their
    // hand is the first sign of them, and saying it again is not news.
    const happened = () => listEvents(home.world, { after: before }).events.map((event) => [event.kind, event.payload.client]);
    assert.deepEqual(happened(), [["presence.active", "tab-1"]]);
    assert.equal((await ask(ingress, "/api/outlets", { headers: as, body: { client: "tab-1", kind: "window", attending: true, idleMs: 0 } })).status, 200);
    assert.deepEqual(happened(), [["presence.active", "tab-1"]]);
  } finally { close(); }
});

test("five wrong codes burn the code; a device can forget itself", async () => {
  const { local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    for (let i = 0; i < 5; i++) assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: "WRONGCOD", name: "x", kind: "phone" } })).body.code, "invalid");
    assert.equal((await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "x", kind: "phone" } })).body.code, "none");

    const fresh = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: fresh.code, name: "Laptop", kind: "browser" } });
    const token = String(paired.headers["set-cookie"]?.[0]).split(";")[0];
    const forgot = await ask(ingress, "/api/device/forget", { headers: viaServe({ Cookie: token }), body: {} });
    assert.equal(forgot.status, 200);
    assert.match(String(forgot.headers["set-cookie"]?.[0]), /Max-Age=0/);
    assert.equal((await ask(ingress, "/api/state", { headers: viaServe({ Cookie: token }) })).status, 401);
    assert.equal(((await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>).devices.length, 0);
    // This machine needs no pairing.
    assert.equal((await ask(local, "/api/pair", { body: { code: "x", name: "x", kind: "phone" } })).status, 400);
  } finally { close(); }
});

test("a paired device turns notifications on, gets a test one, and loses them when revoked", async () => {
  const { local, ingress, pushed, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    assert.equal((await ask(local, "/api/push")).status, 400);
    assert.equal((await ask(ingress, "/api/push", { headers: viaServe() })).status, 401);
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "iPhone", kind: "phone" } });
    const as = viaServe({ Cookie: String(paired.headers["set-cookie"]?.[0]).split(";")[0] });

    const info = (await ask(ingress, "/api/push", { headers: as })).body;
    assert.match(String(info.publicKey), /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(info.subscribed, false);
    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).status, 409);
    assert.equal((await ask(ingress, "/api/push/subscribe", { headers: as, body: { subscription: { endpoint: "https://evil.example/x", keys: { p256dh: "a", auth: "b" } } } })).status, 400);
    const subscription = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" } };
    assert.equal((await ask(ingress, "/api/push/subscribe", { headers: as, body: { subscription } })).body.subscribed, true);
    const listed = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(listed.devices[0].push, true);

    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).body.accepted, 1);
    assert.match(pushed[0], /^https:\/\/web\.push\.apple\.com\/abc .*Notifications work/);

    await ask(local, `/api/devices/${listed.devices[0].id}/revoke`, { body: {} });
    const after = (await ask(local, "/api/remote")).body as Extract<RemoteResponse, { local: true }>;
    assert.equal(after.devices.length, 0);
    assert.equal((await ask(ingress, "/api/push/test", { headers: as, body: {} })).status, 401);
  } finally { close(); }
});

test("a paired device stays out of development sessions until the user lets it in on this machine", async () => {
  const { home, local, ingress, close } = await setUp();
  try {
    await ask(local, "/api/remote", { body: { enabled: true } });
    const pairing = (await ask(local, "/api/remote/pairing", { body: {} })).body as unknown as PairingCode;
    const paired = await ask(ingress, "/api/pair", { headers: viaServe(), body: { code: pairing.code, name: "Phone", kind: "phone" } });
    const as = viaServe({ Cookie: String(paired.headers["set-cookie"]?.[0]).split(";")[0] });
    const device = (paired.body.device as { id: string; scopes: string[] });
    assert.deepEqual(device.scopes, []);

    const project = trustProject(home.world, addProject(home.world, { path: mkdtempSync(join(tmpdir(), "alfred-dev-")), name: "Shop" }).id);
    const session = startSession(home.world, { projectId: project.id, title: "Run the secret tests" });
    const run = submitRun(home.world, { requestId: "s-1", goal: "run the secret tests", profile: "developer", conversationId: session.id }).run;

    // It sees that the session is there and busy, and nothing it said or did.
    const seen = (await ask(ingress, "/api/state", { headers: as })).body as unknown as StateResponse;
    const listed = seen.conversations.find((conversation) => conversation.id === session.id)!;
    assert.equal(listed.title, "Run the secret tests");
    assert.equal(listed.lastGoal, null);
    assert.equal(seen.runs.some((candidate) => candidate.id === run.id), false);
    for (const [path, body] of [
      [`/api/projects/${project.id}/branches`, undefined], [`/api/conversations/${session.id}`, undefined], [`/api/conversations/${session.id}/changes`, undefined], [`/api/runs/${run.id}`, undefined],
      [`/api/runs/${run.id}/respond`, { requestId: "x", answer: "allow" }], [`/api/runs/${run.id}/cancel`, {}],
      ["/api/runs", { requestId: "p-9", goal: "rm -rf", conversationId: session.id }],
      ["/api/conversations", { projectId: project.id, title: "Another" }], [`/api/conversations/${session.id}`, { mode: "edits" }],
    ] as const) {
      const reply = await ask(ingress, path, { headers: as, body });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.body.code, "needs_dev", path);
    }
    // Everyday conversations are as before.
    const daily = await ask(ingress, "/api/runs", { headers: as, body: { requestId: "p-10", goal: "hello" } });
    assert.equal(daily.status, 202);
    const dailyId = (daily.body as unknown as SubmitRunResponse).run.conversationId;
    assert.equal((await ask(ingress, `/api/conversations/${dailyId}`, { headers: as, body: { archived: true } })).status, 200);
    assert.equal((await ask(local, `/api/conversations/${session.id}`, { body: { archived: true } })).status, 200);
    const archive = async () => (await ask(ingress, "/api/conversations/archived", { headers: as })).body.conversations as ArchivedConversation[];
    assert.deepEqual((await archive()).map((chat) => chat.id), [dailyId]);
    assert.equal((await ask(ingress, `/api/conversations/${dailyId}`, { headers: as, body: { archived: false } })).status, 200);
    assert.deepEqual(await archive(), []);
    // A device cannot give itself the scope.
    assert.equal((await ask(ingress, `/api/devices/${device.id}/scope`, { headers: as, body: { scope: "dev", enabled: true } })).body.code, "local_only");

    const granted = (await ask(local, `/api/devices/${device.id}/scope`, { body: { scope: "dev", enabled: true } })).body as Extract<RemoteResponse, { local: true }>;
    assert.deepEqual(granted.devices[0].scopes, ["dev"]);
    const [archived] = await archive();
    assert.equal(archived.id, session.id);
    assert.equal(archived.projectId, project.id);
    assert.equal(archived.title, session.title);
    assert.ok(archived.archivedAt);
    assert.equal((await ask(ingress, `/api/conversations/${session.id}`, { headers: as, body: { archived: false } })).status, 200);
    assert.deepEqual(await archive(), []);
    assert.equal((await ask(ingress, `/api/conversations/${session.id}`, { headers: as })).status, 200);
    const now = (await ask(ingress, "/api/state", { headers: as })).body as unknown as StateResponse;
    assert.ok(now.runs.some((candidate) => candidate.id === run.id));
    assert.equal((await ask(local, `/api/devices/${device.id}/scope`, { body: { scope: "root", enabled: true } })).status, 400);
  } finally { close(); }
});

test("a paired device requests development access for itself and the decision takes effect on open streams", async () => {
  const { home, local, ingress, close } = await setUp();
  try {
    const token = "p".repeat(43);
    const phone = pairDevice(home.world, { name: "Phone", kind: "phone", token });
    const as = viaServe({ Cookie: `alfred_device=${token}` });
    const otherToken = "b".repeat(43);
    const other = pairDevice(home.world, { name: "Browser", kind: "browser", token: otherToken });
    const request = "/api/device/request-dev";
    const scope = `/api/devices/${phone.id}/scope`;
    const decide = (enabled: boolean) => ask(local, scope, { body: { scope: "dev", enabled } });
    const status = async () => (await ask(ingress, "/api/state", { headers: as })).body.devAccess;
    const outstanding = async () => (await ask(local, "/api/state")).body.devAccessRequests;
    const askForAccess = () => ask(ingress, request, { headers: as, body: {} });
    const watch = async () => {
      const get = httpGet({ host: "127.0.0.1", port: ingress, path: "/api/events", headers: as });
      const [res] = await once(get, "response") as [IncomingMessage];
      assert.equal(res.statusCode, 200);
      res.resume();
      return res;
    };

    assert.equal(await status(), "off");
    assert.equal((await ask(local, "/api/state")).body.devAccess, "allowed");
    assert.equal((await ask(ingress, request, { headers: viaServe(), body: {} })).status, 401);
    assert.equal((await ask(ingress, request, { headers: as, body: { id: other.id } })).status, 400);
    assert.equal(await outstanding(), undefined);
    const pending = (await askForAccess()).body as Extract<RemoteResponse, { local: false }>;
    assert.equal(pending.local, false);
    assert.equal(pending.device.id, phone.id);
    assert.equal(pending.device.devAccessRequested, true);
    assert.deepEqual(pending.device.scopes, []);
    assert.equal((await askForAccess()).status, 200);
    assert.equal(listEvents(home.world, { subject: `device:${phone.id}` }).events.filter((event) => event.kind === "device.dev_requested").length, 1);
    assert.equal(await status(), "pending");
    assert.deepEqual(await outstanding(), [{ id: phone.id, name: phone.name }]);
    const otherState = (await ask(ingress, "/api/state", { headers: viaServe({ Cookie: `alfred_device=${otherToken}` }) })).body;
    assert.equal(otherState.devAccess, "off");
    assert.equal(otherState.devAccessRequests, undefined);
    assert.equal((await ask(ingress, scope, { headers: as, body: { scope: "dev", enabled: true } })).body.code, "local_only");
    assert.equal((await ask(ingress, "/api/conversations", { headers: as, body: {} })).body.code, "needs_dev");

    assert.equal((await decide(false)).status, 200);
    assert.equal(await status(), "off");
    assert.equal(await outstanding(), undefined);
    // Another Mac window still showing the request cannot approve it after it was declined.
    assert.equal((await ask(local, scope, { body: { scope: "dev", enabled: true, onlyIfRequested: true } })).status, 200);
    assert.equal(await status(), "off");
    await askForAccess();
    for (const enabled of [true, false]) {
      // The old stream closes before it can deliver more data with its previous permissions.
      const stream = await watch();
      const ended = once(stream, "end", { signal: AbortSignal.timeout(3000) });
      assert.equal((await decide(enabled)).status, 200);
      await ended;
      assert.equal(await status(), enabled ? "allowed" : "off");
      assert.equal(await outstanding(), undefined);
      if (enabled) assert.equal(((await askForAccess()).body.device as { devAccessRequested: boolean }).devAccessRequested, false);
    }
    await askForAccess();
    await ask(local, `/api/devices/${phone.id}/revoke`, { body: {} });
    assert.equal((await askForAccess()).status, 401);
    assert.equal(await outstanding(), undefined);
  } finally { close(); }
});

test("the host controls the web lock and paired clients need their own unlock session for every private route", async () => {
  const { home, local, ingress, close } = await setUp();
  try {
    const device = pairDevice(home.world, { name: "Existing phone", kind: "phone", token: "p".repeat(43) });
    pairDevice(home.world, { name: "Other browser", kind: "browser", token: "b".repeat(43) });
    const paired = "alfred_device=" + "p".repeat(43);
    const phone = viaServe({ Cookie: paired });
    const localStatus = await ask(local, "/api/device/web-lock");
    assert.deepEqual(localStatus.body, { enabled: false, locked: false, expiresAt: null });
    assert.equal((await ask(ingress, "/api/state", { headers: phone })).status, 200);
    const password = "test-only password for this run";
    const config = (enabled: boolean, value?: string) => ask(local, "/api/remote/web-lock", { body: { enabled, password: value } });
    assert.equal((await config(true, "short")).status, 400);
    const enabled = await config(true, password);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.webLockEnabled, true);
    assert.ok(!JSON.stringify(enabled.body).includes(password));
    assert.equal((await ask(ingress, "/api/device/unlock", { headers: viaServe(), body: { password } })).body.code, "unpaired");
    const status = () => ask(ingress, "/api/device/web-lock", { headers: phone });
    assert.equal((await status()).body.locked, true);
    for (const [path, body] of [
      ["/api/state"], ["/api/events"], ["/api/remote"], ["/api/files/example"], ["/api/modules/mail/files/example"],
      ["/api/push"], ["/api/outlets"], ["/api/connections/models/usage"], ["/api/device/activity", {}], ["/api/queries/mail.body", {}],
      ["/api/ops/todo.add", {}], ["/api/runs", {}],
    ] as const) {
      const response = await ask(ingress, path, { headers: phone, body });
      assert.equal(response.status, 423, path);
      assert.equal(response.body.code, "web_locked", path);
    }
    const unlock = (value: string) => ask(ingress, "/api/device/unlock", { headers: phone, body: { password: value } });
    assert.equal((await unlock("incorrect-password")).body.code, "wrong_password");
    const ok = await unlock(password);
    assert.equal(ok.status, 200);
    const raw = ok.headers["set-cookie"]![0];
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(raw.includes(flag));
    const cookie = raw.split(";")[0];
    const opened = viaServe({ Cookie: paired + "; " + cookie });
    assert.equal((await status()).body.locked, true);
    assert.equal((await ask(ingress, "/api/state", { headers: opened })).status, 200);
    assert.equal((await ask(ingress, "/api/remote/web-lock", { headers: opened, body: { enabled: false } })).status, 403);
    assert.equal((await ask(ingress, "/api/state", { headers: viaServe({ Cookie: "alfred_device=" + "b".repeat(43) + "; " + cookie }) })).status, 423);
    assert.equal((await ask(ingress, "/api/device/web-lock", { headers: opened })).body.expiresAt, ok.body.expiresAt);
    const activity = await ask(ingress, "/api/device/activity", { headers: opened, body: {} });
    assert.ok(Number(activity.body.expiresAt) >= Number(ok.body.expiresAt));

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpGet({ host: "127.0.0.1", port: ingress, path: "/api/events", headers: opened }, resolve);
      request.on("error", reject);
    });
    assert.equal(response.statusCode, 200);
    const ended = once(response, "end");
    response.resume();
    await config(true, password + " new");
    await ended;
    assert.equal((await ask(ingress, "/api/state", { headers: opened })).status, 423);
    assert.equal((await unlock(password)).body.code, "wrong_password");
    await config(false);
    assert.equal((await ask(ingress, "/api/state", { headers: phone })).status, 200);
    await ask(local, `/api/devices/${device.id}/revoke`, { body: {} });
    assert.equal((await status()).body.code, "unpaired");
  } finally { close(); }
});
