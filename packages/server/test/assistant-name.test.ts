import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateSettings } from "@isocline/core";
import { getAssistant, translate } from "@isocline/ui/i18n";
import { openHome } from "../src/home.ts";
import { syncAssistantName } from "../src/assistant-name.ts";
import { ASSISTANT_PROFILE, DEVELOPER_PROFILE, profiles } from "../src/profiles.ts";

test("the run is told the assistant's name, and what the node writes itself uses it", () => {
  const home = openHome({ dataDir: mkdtempSync(join(tmpdir(), "isocline-name-")), engine: { submit: async () => ({ reply: "ok" }) }, modules: [] });
  try {
    const told = () => profiles(home.world, [])[ASSISTANT_PROFILE]!.instructions;
    assert.match(told(), /^You are Ana, the user's personal assistant in Isocline/);
    assert.equal(getAssistant(), "Ana", "set when the node opened");
    updateSettings(home.world, { character: "kata", assistantName: "Alfred" });
    syncAssistantName(home.world);
    assert.match(told(), /^You are Alfred, /);
    assert.match(profiles(home.world, [])[DEVELOPER_PROFILE]!.instructions, /^You are Alfred, /);
    assert.equal(translate("en", "mac.proposal.title"), "Alfred has a proposal for you");
    assert.equal(translate("en", "mac.open"), "Open Isocline", "the app itself keeps the product's name");
  } finally {
    home.close();
  }
});
