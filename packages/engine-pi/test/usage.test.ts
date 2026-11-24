import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileStore } from "@zirma/core";
import { createCredentialStore, ModelAccounts } from "../src/index.ts";
import { parseAnthropic, parseCodex, parseKimi, readUsage } from "../src/usage.ts";

test("Claude's usage becomes a 5-hour and weekly window, model-specific weeks scoped, empty ones left out", () => {
  const parsed = parseAnthropic({
    five_hour: { utilization: 12.5, resets_at: "2026-11-19T20:00:00Z" },
    seven_day: { utilization: 140, resets_at: null },
    seven_day_opus: { utilization: 3 },
    seven_day_oauth_apps: null,
  });
  assert.deepEqual(parsed.windows, [
    { id: "five_hour", minutes: 300, used: 12.5, resetsAt: Date.parse("2026-11-19T20:00:00Z") },
    { id: "seven_day", minutes: 10_080, used: 100 },
    { id: "seven_day_opus", minutes: 10_080, scope: "Opus", used: 3 },
  ]);
});

test("Codex's windows carry their length and reset; the plan name comes along", () => {
  const now = 1_000_000;
  const parsed = parseCodex({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 2_000_000 },
      secondary_window: { used_percent: "7", limit_window_seconds: 604_800, reset_after_seconds: 60 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604_800 } },
  }, now);
  assert.equal(parsed.plan, "pro");
  assert.deepEqual(parsed.windows, [
    { id: "primary", used: 40, minutes: 300, resetsAt: 2_000_000_000 },
    { id: "secondary", used: 7, minutes: 10_080, resetsAt: now + 60_000 },
    { id: "review:primary", used: 0, minutes: 10_080, scope: "Code review" },
  ]);
});

test("Kimi's counts become percents", () => {
  const parsed = parseKimi({
    usage: { limit: "200", used: "50" },
    limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", remaining: "75" } }],
    user: { membership: { level: "LEVEL_PRO" } },
  });
  assert.deepEqual(parsed, { windows: [{ id: "limit-0", used: 25, minutes: 300 }, { id: "plan", used: 25 }], plan: "pro" });
});

test("a refused or unreadable answer says why, and never carries the token", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const reply = (status: number, body: string) => async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(body, { status });
  };
  const refused = await readUsage("anthropic", "secret-token", reply(401, "{}"), 5);
  assert.deepEqual(refused, { provider: "anthropic", status: "failed", checkedAt: 5, windows: [], error: "rejected" });
  assert.equal((await readUsage("anthropic", "secret-token", reply(200, "{}"))).error, "unreadable");
  assert.equal((await readUsage("anthropic", "secret-token", async () => { throw new Error("offline"); })).error, "unreachable");
  assert.equal(seen[0]!.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(seen[0]!.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(!JSON.stringify(refused).includes("secret-token"));
});

test("Codex is sent the ChatGPT account from the token", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
  let headers: Record<string, string> = {};
  await readUsage("openai-codex", `x.${claims}.y`, async (_url, init) => {
    headers = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }));
  });
  assert.equal(headers["chatgpt-account-id"], "acct-1");
});

test("usage asks only signed-in subscriptions that have it, once a minute unless fresh", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-usage-"));
  const store = createCredentialStore({ secrets: fileStore(join(dataDir, "secrets.json")), lockDir: dataDir, cacheMs: 0 });
  const far = Date.now() + 3_600_000;
  await store.modify("anthropic", async () => ({ type: "oauth", access: "a-token", refresh: "r", expires: far }));
  await store.modify("github-copilot", async () => ({ type: "oauth", access: "g", refresh: "r", expires: far }));
  await store.modify("openai", async () => ({ type: "api_key", key: "sk" }));
  let calls = 0;
  const accounts = new ModelAccounts({
    store, dataDir, piAgentDir: join(dataDir, "pi"),
    fetch: async (_url, init) => {
      calls++;
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer a-token");
      return new Response(JSON.stringify({ five_hour: { utilization: 20 } }));
    },
  });
  const first = await accounts.usage();
  assert.deepEqual(first.usage.map((item) => [item.provider, item.status, item.windows[0]?.used]), [["anthropic", "ready", 20]]);
  await accounts.usage();
  assert.equal(calls, 1);
  await accounts.usage(true);
  assert.equal(calls, 2);
  await store.delete("anthropic");
  assert.deepEqual(await accounts.usage(), { usage: [] });
});
