import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  acknowledgeNotice, addProject, claimNextRun, CORE_MIGRATIONS, ensureTemplates, finishRun, getSettings, listAutomations,
  listNotices, listRuns, openWorld, reportPresence, runAutomationNow, startSession, submitRun, trustProject,
} from "@alfred/core";
import { PROTOCOL_VERSION, type AwayDigest, type StateResponse } from "@alfred/protocol";
import { setLocale } from "../src/i18n/dict.ts";
import { editionTitle } from "../src/automationText.ts";
import { inboxItems } from "../src/shell/inbox.ts";

const start = Date.UTC(2026, 10, 20, 7);
const minute = 60_000;
const active = { clientId: "mac", kind: "active" } as const;

test("the inbox merges a single brief and its return notice into one dated, directly readable edition", () => {
  setLocale("en");
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  ensureTemplates(w, start);
  const brief = listAutomations(w).find((item) => item.template === "brief")!;
  reportPresence(w, { ...active, now: start });
  const run = runAutomationNow(w, brief.id, "once", { profile: "automation", now: start + minute });
  claimNextRun(w, "worker", { now: start + 2 * minute, leaseMs: 3 * minute });
  finishRun(w, run.id, "worker", { status: "completed", reply: "Your schedule is ready." }, { now: start + 3 * minute });
  const now = start + 40 * minute;
  const welcome = reportPresence(w, { ...active, now }).notice!;
  const state = (): StateResponse => ({
    protocol: PROTOCOL_VERSION, cursor: 0, modules: {}, views: {}, areas: [], receipts: {}, conversations: [],
    projects: [], proposals: [], settings: getSettings(w), automations: listAutomations(w), runs: listRuns(w),
    notices: listNotices(w, { states: ["pending", "claimed", "presented"], now }),
  });
  const items = inboxItems(state());
  assert.equal(items.length, 1);
  const [edition] = items;
  assert.equal(edition.kind, "result");
  assert.equal(edition.notice?.kind, "run_result");
  assert.equal(edition.title, editionTitle("Morning brief", run.createdAt));
  assert.equal(edition.summary, "Your schedule is ready.");
  assert.equal(edition.edition?.run?.id, run.id);
  assert.equal(edition.edition?.morningBrief, true);
  const renamed = state();
  renamed.automations = [{ ...brief, template: null, name: "Morning brief" }];
  assert.equal(inboxItems(renamed)[0].edition?.morningBrief, false, "display names never select the brief reader");
  assert.deepEqual(edition.alsoNotices?.map((notice) => notice.id), [welcome.id]);

  const onlyWelcome = state();
  onlyWelcome.notices = onlyWelcome.notices.filter((notice) => notice.id === welcome.id);
  assert.equal(inboxItems(onlyWelcome)[0].edition?.runId, run.id);
  onlyWelcome.runs = [];
  assert.equal(inboxItems(onlyWelcome)[0].summary, "Your schedule is ready.");
  assert.equal(inboxItems(onlyWelcome)[0].edition?.morningBrief, true);
  assert.equal(inboxItems(onlyWelcome)[0].edition?.run, undefined); // the reader fetches this run by id

  const moreNews = state();
  const mixed = moreNews.notices.find((item) => item.id === welcome.id)!.payload as unknown as AwayDigest;
  mixed.waiting = 1;
  const recap = inboxItems(moreNews).find((item) => item.kind === "away")!;
  assert.match(recap.summary, /waits for you/);
  assert.equal(recap.results?.[0].edition?.runId, run.id);

  const old = state();
  const legacy = old.notices.find((item) => item.id === welcome.id)!.payload as unknown as AwayDigest;
  delete legacy.runs.results;
  legacy.runs.goals = [run.goal.slice(0, 80)];
  assert.deepEqual(inboxItems(old).map((item) => item.edition?.runId), [run.id]);
  old.runs.push({ ...old.runs[0], id: "another-match" });
  const ambiguous = inboxItems(old).find((item) => item.kind === "away")!;
  assert.deepEqual(ambiguous.results, []);
  assert.equal(ambiguous.summary, "Finished 1 thing.");
  acknowledgeNotice(w, welcome.id, { now });
  assert.deepEqual(inboxItems(state()).map((item) => item.runId), [run.id]);
  w.close();
});

test("quiet returns still greet; ordinary project replies stay in the conversation", () => {
  const w = openWorld(":memory:", CORE_MIGRATIONS);
  reportPresence(w, { ...active, now: start });
  const quiet = reportPresence(w, { ...active, now: start + 40 * minute }).notice!;
  assert.ok(quiet);
  assert.equal(inboxItems({ notices: [quiet], runs: [], proposals: [] } as unknown as StateResponse).length, 0);
  const project = trustProject(w, addProject(w, { path: tmpdir(), name: "Example" }).id);
  const session = startSession(w, { projectId: project.id, title: "Source changes" });
  const run = submitRun(w, { requestId: "private", goal: "a private coding instruction", profile: "dev", conversationId: session.id, now: start + 41 * minute }).run;
  claimNextRun(w, "worker", { now: start + 41 * minute, leaseMs: 3 * minute });
  finishRun(w, run.id, "worker", { status: "completed" }, { now: start + 42 * minute });
  const recap = reportPresence(w, { ...active, now: start + 80 * minute }).notice!.payload as unknown as AwayDigest;
  assert.equal(recap.runs.completed, 0);
  assert.deepEqual([recap.runs.results, recap.runs.goals], [[], []]);
  w.close();
});
