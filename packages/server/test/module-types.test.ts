import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { calendarModule } from "@isocline/module-calendar";
import { CALENDAR_OPS } from "@isocline/module-calendar/types";
import { linksModule } from "@isocline/module-links";
import { LINK_OPS } from "@isocline/module-links/types";
import { mailModule } from "@isocline/module-mail";
import { MAIL_OPS } from "@isocline/module-mail/types";
import { todoModule } from "@isocline/module-todo";
import { TODO_OPS } from "@isocline/module-todo/types";

/** Devices name a module's operations from its `types` (they cannot load the module itself). Those lists must be the
 * module's own: an operation renamed or added on one side only would fail at the click, not at the build. */
test("each module's operation list for devices is the module's own", () => {
  for (const [module, listed] of [[todoModule, TODO_OPS], [calendarModule, CALENDAR_OPS], [mailModule, MAIL_OPS], [linksModule, LINK_OPS]] as const) {
    assert.deepEqual(module.ops.map((op) => op.name).sort(), [...listed].sort(), module.id);
    assert.ok(listed.every((name) => name.startsWith(`${module.id}.`)), module.id);
  }
});

/** A module reaches the core only through module-kit, which says what of it a module may use. */
test("modules import nothing from @isocline/core directly", () => {
  const modules = fileURLToPath(new URL("../../../modules/", import.meta.url));
  const offenders: string[] = [];
  for (const module of readdirSync(modules)) {
    const src = join(modules, module, "src");
    for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file)) continue;
      if (/from\s+["']@isocline\/core["']/.test(readFileSync(join(src, file), "utf8"))) offenders.push(`${module}/src/${file}`);
    }
  }
  assert.deepEqual(offenders, []);
});
