import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCESS, accessFor, checkAccess, type Access } from "../src/access.ts";
import { HttpError } from "../src/wire.ts";

/** The addresses whose level matters most, written out so a change to the table has to change this too. */
const EXPECTED: Array<[string, string, Access]> = [
  ["POST", "/api/pair", "device"],
  ["GET", "/api/state", "device"],
  ["GET", "/api/events", "device"],
  ["POST", "/api/ops/todo.add", "device"],
  ["POST", "/api/runs", "device"],
  ["POST", "/api/runs/r1/steer", "device"],
  ["GET", "/api/remote", "device"],
  ["POST", "/api/remote", "local"],
  ["POST", "/api/remote/pairing", "local"],
  ["POST", "/api/remote/web-lock", "local"],
  ["POST", "/api/devices/d1/scope", "local"],
  ["POST", "/api/devices/d1/revoke", "local"],
  ["GET", "/api/connections", "local"],
  ["GET", "/api/connections/models/usage", "device"],
  ["POST", "/api/connections/models/usage", "local"],
  ["POST", "/api/connections/google/connect", "local"],
  ["POST", "/api/voice/speak", "device"],
  ["PUT", "/api/voice/services/elevenlabs/key", "local"],
  ["DELETE", "/api/voice/services/boson/key", "local"],
  ["GET", "/api/skills", "local"],
  ["POST", "/api/skills/add", "local"],
  ["POST", "/api/projects", "local"],
  ["POST", "/api/projects/p1/trust", "local"],
  ["GET", "/api/projects/p1/branches", "dev"],
  ["GET", "/api/desktop", "device"],
  ["GET", "/api/desktop/requests", "local"],
  ["POST", "/api/desktop/requests/q1", "local"],
  ["POST", "/api/conversations", "dev"],
  ["GET", "/api/conversations/archived", "device"],
  ["GET", "/api/conversations/c1", "device"],
  ["POST", "/api/conversations/c1/terminal", "local"],
  ["GET", "/api/conversations/c1/terminal/stream", "local"],
  ["POST", "/api/conversations/c1/terminal/input", "local"],
  ["POST", "/api/conversations/c1/processes", "local"],
  ["GET", "/api/conversations/c1/processes", "dev"],
  ["POST", "/api/conversations/c1/processes/x1/stop", "dev"],
  ["GET", "/api/conversations/c1/changes", "dev"],
  ["POST", "/api/conversations/c1/publish", "dev"],
];

test("each address has the level written out for it", () => {
  for (const [method, path, access] of EXPECTED) assert.equal(accessFor(method, path), access, `${method} ${path}`);
});

test("an address that is not listed is refused to everyone, this machine included", () => {
  for (const path of ["/api/nope", "/api/conversations/c1/somethingnew", "/api/connectionsx", "/api/stateful"]) {
    assert.equal(accessFor("GET", path), null, path);
    assert.throws(() => checkAccess({ local: true, dev: true }, "GET", path), (error: unknown) => error instanceof HttpError && error.status === 404);
  }
});

test("devices get 403 above their level; this machine is never refused a listed address", () => {
  const code = (asker: { local: boolean; dev: boolean }, method: string, path: string) => {
    try { checkAccess(asker, method, path); return "ok"; } catch (error) { return error instanceof HttpError ? error.code ?? error.status : "threw"; }
  };
  const phone = { local: false, dev: false };
  const devPhone = { local: false, dev: true };
  const mac = { local: true, dev: false };
  assert.equal(code(phone, "GET", "/api/state"), "ok");
  assert.equal(code(phone, "POST", "/api/conversations"), "needs_dev");
  assert.equal(code(devPhone, "POST", "/api/conversations"), "ok");
  assert.equal(code(devPhone, "POST", "/api/conversations/c1/terminal"), "local_only");
  assert.equal(code(devPhone, "POST", "/api/skills/add"), "local_only");
  for (const { method, path } of ACCESS) assert.equal(code(mac, method === "*" ? "GET" : method, path.replace(/:[a-z]+/g, "x").replace(/\/\*$/, "").replace(/\(([^|)]+)[^)]*\)/g, "$1")), "ok", path);
});
