import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, CORE_MIGRATIONS, createRunDrain, getConversation, openWorld, submitRun, updateConversation, type EnginePort, type Run, type World } from "@zirma/core";
import { createTitler } from "../src/titles.ts";

const profiles = { chat: { instructions: "", tools: [] } };

/** A world, an engine that replies and names, and a drain that tells the titler. Resolves once titles are asked. */
function setup(name: (input: { goal: string; reply: string; model: string | null }) => Promise<string>) {
  const world: World = openWorld(":memory:", CORE_MIGRATIONS);
  const asked: Array<{ goal: string; reply: string; model: string | null }> = [];
  const pending: Promise<unknown>[] = [];
  const engine: EnginePort = {
    submit: async (request) => ({ reply: `About ${request.goal}` }),
    title: (input) => { asked.push(input); const answer = name(input); pending.push(answer.catch(() => {})); return answer; },
  };
  const titler = createTitler(world, engine);
  const drain = createRunDrain(world, engine, { owner: "home", profiles, onFinished: (run: Run) => titler(run) });
  const settle = async () => { await drain.kick(); await Promise.all(pending); await new Promise((resolve) => setImmediate(resolve)); };
  return { world, asked, settle };
}

test("a new chat gets a short title after its first reply, from the conversation's own model", async () => {
  const { world, asked, settle } = setup(async () => "“Lisbon trip with kids.”");
  const { run } = submitRun(world, { requestId: "r1", goal: "Plan the trip to Lisbon in March with the kids, we have a week", profile: "chat" });
  updateConversation(world, run.conversationId, { model: "openai/gpt-5.4" });
  await settle();
  assert.deepEqual(asked, [{ goal: "Plan the trip to Lisbon in March with the kids, we have a week", reply: "About Plan the trip to Lisbon in March with the kids, we have a week", model: "openai/gpt-5.4" }]);
  assert.equal(getConversation(world, run.conversationId).title, "Lisbon trip with kids");

  // Only once: a second message does not rename it again.
  submitRun(world, { requestId: "r2", goal: "and a hotel", profile: "chat", conversationId: run.conversationId });
  await settle();
  assert.equal(asked.length, 1);
});

test("a rename, a second message or a failing model keeps the title there is", async () => {
  let rename: (() => void) | undefined;
  const { world, asked, settle } = setup(async (input) => {
    rename?.();
    if (input.goal === "broken") throw new Error("no key");
    return "Model's title";
  });
  const renamed = submitRun(world, { requestId: "a", goal: "first question here", profile: "chat" }).run;
  rename = () => updateConversation(world, renamed.conversationId, { title: "Mine" });
  await settle();
  assert.equal(getConversation(world, renamed.conversationId).title, "Mine", "renamed while the model was writing");
  rename = undefined;

  const broken = submitRun(world, { requestId: "b", goal: "broken", profile: "chat" }).run;
  await settle();
  assert.equal(getConversation(world, broken.conversationId).title, "broken");

  // Renamed before the reply came: not asked at all.
  const early = submitRun(world, { requestId: "c", goal: "named already", profile: "chat" }).run;
  updateConversation(world, early.conversationId, { title: "Named by me" });
  await settle();
  assert.equal(getConversation(world, early.conversationId).title, "Named by me");
  assert.deepEqual(asked.map((input) => input.goal), ["first question here", "broken"]);
});

test("a model's title is one clean line, or nothing", () => {
  assert.equal(cleanTitle("Title: \"Moving checklist\"."), "Moving checklist");
  assert.equal(cleanTitle("<think>hmm</think>\n\n「搬家清单」。"), "搬家清单");
  assert.equal(cleanTitle("**Budget for May**\nextra words"), "Budget for May");
  assert.equal(cleanTitle("  \n \"\" "), null);
  assert.equal([...cleanTitle("字".repeat(80))!].length, 60);
});
