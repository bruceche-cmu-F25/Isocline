import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ATTENTION, addProject, claimNotice, CORE_MIGRATIONS, createNotice, listNotices, openWorld, pairDevice, recordDomainEvent, revokeDevice, setDeviceScope, startSession, trustProject, type World } from "@zirma/core";
import { checkSubscription, noticeMessage, PushService, watchAttention, type PushSender } from "../src/index.ts";
import type { SecretStore } from "../src/secrets.ts";

const APPLE = { endpoint: "https://web.push.apple.com/QGx1a2V", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };

const memorySecrets = (): SecretStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    kind: "file", values,
    get: async (name) => values.get(name),
    set: async (name, value) => { values.set(name, value); },
    delete: async (name) => { values.delete(name); },
  };
};

function notice(world: World, kind = "run_result", payload: Record<string, unknown> = { goal: "Book the dentist", reply: "Booked for Friday 3pm.", conversationId: "c1", status: "completed" }) {
  return world.tx((db) => {
    const event = recordDomainEvent(world, { kind: "run.completed", payload: {} });
    return createNotice(db, { eventSeq: event.seq, kind, payload });
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setUp(send: PushSender, hidePreviews?: () => boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-push-"));
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const secrets = memorySecrets();
  const push = new PushService({ dataDir, world, secrets, send, hidePreviews });
  const phone = pairDevice(world, { token: "p".repeat(43), name: "iPhone", kind: "phone" });
  // The home node's attention hands notices to push; here with a short wait before a notice is the phone's.
  let attention: { close(): void } | null = null;
  const watch = () => { attention = watchAttention({ world, reaches: () => push.reaches(), policy: { ...ATTENTION, pushAfterMs: 40 } }); };
  const close = () => attention?.close();
  return { dataDir, world, secrets, push, phone, watch, close };
}

test("only real push services are accepted as endpoints", () => {
  assert.equal(checkSubscription(APPLE).endpoint, APPLE.endpoint);
  assert.ok(checkSubscription({ ...APPLE, endpoint: "https://fcm.googleapis.com/fcm/send/abc" }));
  for (const endpoint of ["http://web.push.apple.com/x", "https://127.0.0.1/x", "https://evil.example/x", "https://push.apple.com.evil.example/x", "https://web.push.apple.com:8443/x", "nope"]) {
    assert.throws(() => checkSubscription({ ...APPLE, endpoint }), /push/i, endpoint);
  }
  assert.throws(() => checkSubscription({ endpoint: APPLE.endpoint, keys: { p256dh: "a b", auth: "x" } }));
});

test("a notice reads on a lock screen as on the Mac, in the user's language", () => {
  const brief = noticeMessage({ id: "brief", kind: "run_result", payload: { automationId: "morning", runId: "today", conversationId: "all-briefs", reply: "First meeting at 10." } }, "en");
  assert.equal(brief.url, "/#p=core.inbox&item=n%3Abrief");
  assert.equal(brief.ack, false, "opening a push leaves the report available to the Inbox reader");
  const done = noticeMessage({ id: "n1", kind: "run_result", payload: { goal: "Book", reply: "Booked for Friday.", conversationId: "c 1", status: "completed" } }, "en");
  assert.deepEqual(done, { tag: "notice:n1", notice: "n1", title: "Ana", body: "Booked for Friday.", url: "/#c=c%201", ack: true });
  const proposal = noticeMessage({ id: "n2", kind: "proposal", payload: { proposalId: "change-1", title: "Move 3 todos to next week?" } }, "zh");
  assert.equal(proposal.title, "Ana 有个提议等你决定");
  assert.equal(proposal.url, "/#p=core.inbox&item=p%3Achange-1");
  assert.equal(proposal.ack, false);
  const question = noticeMessage({ id: "n3", kind: "run_request", payload: { kind: "input", question: "Which Friday?", conversationId: "c1" } }, "zh");
  assert.deepEqual([question.title, question.body, question.ack], ["Ana 在等你回答", "Which Friday?", false]);
  assert.ok(noticeMessage({ id: "n4", kind: "run_result", payload: { reply: "x".repeat(500) } }, "en").body.length <= 200);
});

test("a notice nobody takes within the grace period goes to the phone once, and from then on it was told there", async () => {
  const sent: string[] = [];
  const { dataDir, world, secrets, push, phone, watch, close } = setUp(async (subscription, payload) => { sent.push(`${subscription.endpoint} ${payload}`); });
  try {
    push.subscribe(phone.id, APPLE);
    assert.equal(statSync(join(dataDir, "push.json")).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(dataDir, "push.json"), "utf8").includes("privateKey"));
    watch();
    const left = notice(world);
    const taken = notice(world);
    claimNotice(world, taken.id, "mac");
    await wait(120);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Booked for Friday 3pm/);
    assert.ok(JSON.parse(secrets.values.get("push:vapid")!).privateKey);
    const [after] = listNotices(world, { states: ["presented"] }).filter((item) => item.id === left.id);
    assert.deepEqual([after.claimedBy, after.claimUntil], ["push", null], "told on the phone: there is no hold to run out and show it again");
    // A later commit does not push it again.
    notice(world, "welcome", {});
    await wait(80);
    assert.equal(sent.length, 1);
  } finally { close(); world.close(); }
});

test("a change outside that failed or may not have happened reaches the phone; one that went through does not", async () => {
  const sent: Array<{ title: string; body: string; url: string; ack: boolean }> = [];
  const { world, push, phone, watch, close } = setUp(async (_subscription, payload) => { sent.push(JSON.parse(payload)); });
  try {
    push.subscribe(phone.id, APPLE);
    watch();
    notice(world, "outbound", { state: "done", preview: "Add “Dentist” to Me: Fri 15:00" });
    const uncertain = notice(world, "outbound", { state: "unknown", preview: "Email ana@example.com: Plan" });
    notice(world, "outbound", { state: "failed", preview: "Reply to leo@example.com: Contract", error: "Gmail answered 400" });
    await wait(150);
    assert.deepEqual(sent.map((message) => message.title).sort(), ["Not sure it went through", "That didn't go through"]);
    const unsure = sent.find((message) => message.title === "Not sure it went through")!;
    assert.match(unsure.body, /^Email ana@example.com: Plan\. Google didn't confirm it/);
    assert.deepEqual([unsure.url, unsure.ack], [`/#p=core.inbox&item=n%3A${uncertain.id}`, false], "it opens the exact receipt and stays until explicitly reviewed");
    assert.equal(sent.find((message) => message.title === "That didn't go through")!.body, "Reply to leo@example.com: Contract: Gmail answered 400");
    assert.deepEqual(listNotices(world, { states: ["pending", "claimed", "presented"] }).map((item) => [item.payload.state, item.state, item.claimedBy]).sort(),
      [["done", "pending", null], ["failed", "presented", "push"], ["unknown", "presented", "push"]]);
  } finally { close(); world.close(); }
});

test("nothing is claimed when no push went out, and a gone subscription is dropped", async () => {
  const { world, push, phone, watch, close } = setUp(async () => { throw Object.assign(new Error("Gone"), { statusCode: 410 }); });
  try {
    push.subscribe(phone.id, APPLE);
    watch();
    const left = notice(world);
    await wait(120);
    assert.equal(push.subscribed(phone.id), false);
    assert.equal(listNotices(world).find((item) => item.id === left.id)?.state, "pending");
  } finally { close(); world.close(); }
});

test("a revoked device gets nothing", async () => {
  const sent: string[] = [];
  const { world, push, phone, watch, close } = setUp(async (subscription) => { sent.push(subscription.endpoint); });
  try {
    push.subscribe(phone.id, APPLE);
    revokeDevice(world, phone.id);
    const result = await push.sendTo({ title: "Zirma", body: "hi", url: "/", tag: "t" });
    assert.deepEqual(result, { accepted: 0, failed: 0, expired: 0 });
    assert.deepEqual(sent, []);
  } finally { close(); world.close(); }
});

test("protected web notifications contain no work content, even with the app in the foreground", async () => {
  let protectedBrowser = true;
  const sent: string[] = [];
  const { push, phone, world } = setUp(async (_sub, payload) => { sent.push(payload); }, () => protectedBrowser);
  try {
    push.subscribe(phone.id, APPLE);
    const message = { title: "Private title", body: "Private text", tag: "sensitive", url: "/#c=private", notice: "private-id", ack: true };
    await push.sendTo(message);
    const hidden = JSON.parse(sent[0]);
    assert.equal(hidden.title, "Ana", "the assistant, by its name");
    assert.ok(hidden.body.length > 0);
    assert.equal(hidden.url, "/#p=core.inbox");
    assert.doesNotMatch(sent[0], /private|sensitive|"ack"|"notice"/i);
    protectedBrowser = false;
    await push.sendTo(message);
    assert.deepEqual(JSON.parse(sent[1]), message);
  } finally { world.close(); }
});

test("only devices with development access receive development conversation notifications", async () => {
  const sent: string[] = [];
  const { push, phone, world, dataDir } = setUp(async (_sub, payload) => { sent.push(payload); });
  try {
    push.subscribe(phone.id, APPLE);
    const project = trustProject(world, addProject(world, { path: dataDir, name: "Example" }).id);
    const session = startSession(world, { projectId: project.id, title: "Example" });
    const update = notice(world, "run_request", { conversationId: session.id, question: "Private development question" });
    const outlet = push.reaches()[0];
    assert.equal(await outlet.send(update), false);
    assert.equal(sent.length, 0);
    setDeviceScope(world, phone.id, "dev", true);
    assert.equal(await outlet.send(update), true);
    assert.match(sent[0], /Private development question/);
    setDeviceScope(world, phone.id, "dev", false);
    assert.equal(await outlet.send(update), false);
  } finally { world.close(); }
});

test("a device handing over a new subscription replaces the old one, and the next push goes to the new one", async () => {
  const sent: string[] = [];
  const logged: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "zirma-push-"));
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  const push = new PushService({ dataDir, world, secrets: memorySecrets(), send: async (subscription) => { sent.push(subscription.endpoint); }, log: (line) => logged.push(line) });
  const phone = pairDevice(world, { token: "p".repeat(43), name: "iPhone", kind: "phone" });
  try {
    push.subscribe(phone.id, APPLE);
    const saved = statSync(join(dataDir, "push.json")).mtimeMs;
    // The same one again, as every start hands it over: nothing changes, nothing is written.
    await wait(15);
    push.subscribe(phone.id, APPLE);
    assert.equal(statSync(join(dataDir, "push.json")).mtimeMs, saved);
    assert.deepEqual(logged, []);
    // iOS replaced it without telling the page; the push service would still accept sends to the old one.
    const replaced = { ...APPLE, endpoint: "https://web.push.apple.com/NEWONE" };
    push.subscribe(phone.id, replaced);
    assert.match(logged.join("\n"), /new subscription/);
    assert.match(readFileSync(join(dataDir, "push.json"), "utf8"), /NEWONE/);
    await push.sendTo({ title: "t", body: "b", url: "/", tag: "test" });
    assert.deepEqual(sent, [replaced.endpoint]);
  } finally { world.close(); }
});
