import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { titleThinkingLevel } from "../src/title-thinking.ts";

const model = (fields: Partial<Model<Api>>) => ({ id: "m", provider: "p", api: "openai-completions", reasoning: true, ...fields }) as Model<Api>;

test("a title is written with the least thinking the model allows", () => {
  assert.equal(titleThinkingLevel(model({ reasoning: false })), "off", "a model that does not think");
  assert.equal(titleThinkingLevel(model({})), "off", "a thinking model that can stop");
  assert.equal(titleThinkingLevel(model({ thinkingLevelMap: { off: null } })), "minimal", "one that cannot stop: its lowest level");
  assert.equal(titleThinkingLevel(model({ thinkingLevelMap: { off: null, minimal: null } })), "low");
  assert.equal(titleThinkingLevel(model({ id: "gemini-3-flash" })), "low", "Gemini refuses minimal, which its SDK sends for off");
  assert.equal(titleThinkingLevel(model({ id: "g", api: "google-generative-ai" })), "low");
});
