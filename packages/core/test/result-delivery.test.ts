import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CORE_MIGRATIONS, acknowledgeNotice, claimNextRun, createNotice, createRunDrain, ensureTemplates, finishRun,
  getConversation, getRun, listAutomations, listNotices, openWorld, presentNotice, recordDomainEvent, reportPresence,
  runAutomationNow, submitRun, undeliveredNotices, type AwayDigest,
} from "../src/index.ts";
import { oldAutomation } from "./old-world.ts";
import { completionNotification } from "../src/result-delivery.ts";

test("completion notification is an explicit request in the user's own words", () => {
  const yes = ["做完告诉我", "整理完这份报告告诉我", "整理好后发我", "不用改邮件，做完记得提醒我", "做完跟我说一声", "把结果发给我", "结果放到收件箱。",
    "When you’re done, let me know", "Notify me when it's ready.", "Send the result to my Inbox.", "Run the check and ping me."];
  for (const words of yes) assert.equal(completionNotification(words), true, words);
  const normal = ["告诉我这封邮件是什么意思", "Tell me what you found", "Tell me the result.", "告诉我哪些任务完成了", "Why did you notify me when done?",
    "If a new email arrives, notify me", "Translate: notify me when done.", "Explain ‘notify me when done’.",
    "Review the following email:\nNotify me when done.", "What did she mean by “做完告诉我”？", "Run the sample.\n> Notify me when done."];
  for (const words of normal) assert.equal(completionNotification(words), undefined, words);
  for (const words of ["做完不用通知我", "做完告诉我。不过不用提醒我了", "Don't ping me when done", "cancel the notification"])
    assert.equal(completionNotification(words), false, words);
  assert.equal(completionNotification("Don't ping me. Actually notify me when it's ready."), true);
});

test("a late accepted steer chooses delivery even when the engine has already returned its answer", async (t) => {
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => w.close());
  const reply = Promise.withResolvers<{ reply: string }>(), steer = Promise.withResolvers<boolean>();
  const drain = createRunDrain(w, { submit: () => reply.promise, steer: () => steer.promise }, { owner: "home", profiles: { tasks: { tools: [], instructions: "" } } });
  const { run } = submitRun(w, { requestId: "steer", goal: "Read this.", profile: "tasks" });
  const working = drain.kick();
  const accepted = drain.steer(run.id, "A".repeat(2500) + ". 做完告诉我");
  reply.resolve({ reply: "The report is ready." });
  await new Promise((resolve) => setImmediate(resolve));
  steer.resolve(true);
  assert.equal(await accepted, true);
  await working;
  assert.deepEqual(listNotices(w).map((n) => [n.payload.runId, n.payload.delivery]), [[run.id, "inbox"]]);
  assert.equal(getConversation(w, run.conversationId).unreadReplyId, null);
});

test("only the user's latest delivery request counts; quiet replies keep their conversation and no return recap", (t) => {
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => w.close());
  const now = Date.now();
  reportPresence(w, { clientId: "mac", kind: "active", now });
  const { run } = submitRun(w, { requestId: "quiet", goal: "Write a brief and notify me when done", profile: "tasks", now: now + 1 });
  claimNextRun(w, "home", { now: now + 2 });
  w.tx(() => {
    recordDomainEvent(w, { kind: "run.steered", actor: "user", runId: run.id, payload: { text: "Actually, don't notify me." }, now: now + 3 });
    recordDomainEvent(w, { kind: "run.steered", actor: "alfred", runId: run.id, payload: { text: "Notify me when done." }, now: now + 4 });
    recordDomainEvent(w, { kind: "todo.updated", actor: "alfred", runId: run.id, payload: {}, now: now + 5 });
  });
  finishRun(w, run.id, "home", { status: "completed", reply: "Report." }, { now: now + 6 });
  assert.equal(getRun(w, run.id).run.outcome?.reply, "Report.");
  assert.equal(getConversation(w, run.conversationId).unreadReplyId, run.id);
  assert.deepEqual(undeliveredNotices(w), []);
  const digest = reportPresence(w, { clientId: "mac", kind: "active", now: now + 3600_000 }).notice!.payload as unknown as AwayDigest;
  assert.equal(digest.runs.completed, 0);
  assert.deepEqual(digest.changes, {});
});

test("mail suggestions announce actual findings, while a zero-result sweep stays in its activity history", (t) => {
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => w.close());
  ensureTemplates(w);
  const rule = listAutomations(w).find((a) => a.template === "mail_todos")!;
  const run = (id: string, found: boolean) => {
    const run = runAutomationNow(w, rule.id, id, { profile: "automation" });
    claimNextRun(w, "home");
    if (found) w.tx(() => recordDomainEvent(w, { kind: "todo.suggested", actor: "alfred", runId: run.id, payload: {} }));
    finishRun(w, run.id, "home", { status: "completed", reply: "I suggested one todo." });
    return run.id;
  };
  const none = run("none", false), one = run("one", true);
  assert.equal(getRun(w, none).run.state, "completed");
  assert.deepEqual(listNotices(w).map((n) => [n.payload.runId, n.payload.template]), [[one, "mail_todos"]]);
});

test("upgrade retires old ordinary notifications and rebuilds mixed return summaries using exact runs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite"), now = Date.now();
  const old = openWorld(path, CORE_MIGRATIONS.filter((m) => Number(m.id.split(":")[1]) < 20));
  reportPresence(old, { clientId: "mac", kind: "active", now });
  const notices: string[] = [];
  for (const [i, goal] of ["Tell me the time.", "整理完这份报告告诉我"].entries()) {
    const run = submitRun(old, { requestId: "old" + i, goal, profile: "tasks", now: now + i + 1 }).run;
    claimNextRun(old, "home", { now: now + i + 1 });
    finishRun(old, run.id, "home", { status: "completed" }, { now: now + i + 10 });
    const created = listNotices(old).find((n) => n.payload.runId === run.id);
    const notice = created ?? old.tx((db) => createNotice(db, {
      eventSeq: Number(db.prepare("SELECT seq FROM core_events WHERE kind = 'run.completed' AND run_id = ?").get(run.id)!.seq),
      kind: "run_result", payload: { runId: run.id, goal, status: "completed", conversationId: run.conversationId }, now: now + i + 10,
    }));
    old.db.prepare("UPDATE core_notices SET payload=json_remove(payload, '$.delivery') WHERE id=?").run(notice.id);
    notices.push(notice.id);
  }
  const welcome = reportPresence(old, { clientId: "mac", kind: "active", now: now + 3600_000 }).notice!;
  old.db.prepare("UPDATE core_notices SET payload=json_set(payload, '$.runs.completed', 2) WHERE id=?").run(welcome.id);
  old.close();
  const w = openWorld(path, CORE_MIGRATIONS);
  t.after(() => w.close());
  const remaining = listNotices(w, { states: ["pending","claimed","presented"] });
  assert.deepEqual(remaining.filter((n) => n.kind === "run_result").map((n) => [n.id, n.payload.delivery]), [[notices[1], "inbox"]]);
  const digest = remaining.find((n) => n.id === welcome.id)!.payload as unknown as AwayDigest;
  assert.equal(digest.runs.completed, 1);
  assert.deepEqual(digest.runs.goals, ["整理完这份报告告诉我"]);
  assert.equal(w.db.prepare("SELECT count(*) AS n FROM core_runs").get()!.n, 2);
});

test("only the latest successful brief stays in Inbox, including on return after a failed edition", (t) => {
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => w.close());
  ensureTemplates(w);
  const brief = listAutomations(w).find((a) => a.template === "brief")!;
  const start = Date.now() - 86_400_000, day = 86_400_000;
  reportPresence(w, { clientId: "mac", kind: "active", now: start });
  const edition = (slot: string, when: number, status: "completed" | "failed") => {
    const run = runAutomationNow(w, brief.id, slot, { now: when, profile: "automation" });
    claimNextRun(w, "home", { now: when + 1 });
    finishRun(w, run.id, "home", { status }, { now: when + 2 });
    return run.id;
  };
  const visible = () => listNotices(w, { states: ["pending","claimed","presented"] });
  const yesterday = edition("one", start + 10, "completed");
  const recap = reportPresence(w, { clientId: "mac", kind: "active", now: start + 3600_000 }).notice!;
  presentNotice(w, recap.id, "mac", { now: start + 3600_001 });
  const failed = edition("two", start + day, "failed");
  assert.ok(visible().some((n) => n.payload.runId === yesterday));
  const today = edition("retry", start + day + 10, "completed");
  assert.deepEqual(visible().filter((n) => n.kind === "run_result").map((n) => n.payload.runId), [failed,today]);
  const old = visible().find((n) => n.id === recap.id);
  assert.deepEqual((old!.payload as unknown as AwayDigest).runs.results, []);
  assert.equal(getRun(w, yesterday).run.state, "completed");
  const result = visible().find((n) => n.payload.runId === today)!;
  acknowledgeNotice(w, result.id, { now: start + day + 20 });
  const back = reportPresence(w, { clientId: "mac", kind: "active", now: start + day + 3600_000 }).notice!;
  assert.equal((back.payload as unknown as AwayDigest).runs.completed, 0, "reading the latest edition is remembered on the next return");
});

test("upgrade keeps an already-read latest edition read and retires earlier unread briefs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-brief-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "world.sqlite");
  const old = openWorld(path, CORE_MIGRATIONS.filter((m) => Number(m.id.split(":")[1]) < 20));
  oldAutomation(old, { id: "brief1", template: "brief", schedule: { at: "07:30", days: [1, 2, 3, 4, 5, 6, 7] }, enabled: false, at: Date.now() });
  const rule = { id: "brief1" };
  const ids: string[] = [];
  for (const slot of ["first", "second"]) {
    const run = runAutomationNow(old, rule.id, slot, { profile: "automation" });
    claimNextRun(old, "home");
    finishRun(old, run.id, "home", { status: "completed", reply: slot });
    ids.push(run.id);
  }
  // The older app kept both daily notices after the reader dismissed the second one.
  old.db.prepare(`UPDATE core_notices SET payload = json_remove(payload, '$.delivery', '$.template'),
    state = CASE json_extract(payload, '$.runId') WHEN ? THEN 'pending' ELSE 'acknowledged' END WHERE kind = 'run_result'`).run(ids[0]);
  old.close();
  const upgraded = openWorld(path, CORE_MIGRATIONS);
  t.after(() => upgraded.close());
  assert.deepEqual(listNotices(upgraded), []);
  assert.deepEqual(ids.map((id) => getRun(upgraded, id).run.outcome?.reply), ["first", "second"]);
});
