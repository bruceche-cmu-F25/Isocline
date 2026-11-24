import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationError, ProjectError, ProposalStateError, RunError } from "@isocline/core";
import { McpConnectorError, ModelSignInError, SkillError } from "@isocline/engine-pi";
import { OpInputError, UnknownOpError } from "@isocline/module-kit";
import { TerminalError, VoiceError } from "../src/index.ts";
import { Fault, HttpError, parseObject, statusOf } from "../src/wire.ts";

test("a refusal is said as a status by its name and code, whichever address it came from", () => {
  const said = (error: unknown) => { const { status, body } = statusOf(error); return [status, body.code]; };
  // About the request itself.
  assert.deepEqual(statusOf(new HttpError(403, "Only here", "local_only")), { status: 403, body: { error: "Only here", code: "local_only" } });
  assert.deepEqual(statusOf(new HttpError(415, "Send JSON")), { status: 415, body: { error: "Send JSON" } });
  // Core's: missing is 404, a wrong state 409, a wrong command 400.
  assert.deepEqual(said(new ConversationError("missing")), [404, "missing"]);
  assert.deepEqual(said(new ConversationError("invalid")), [400, "invalid"]);
  assert.deepEqual(said(new RunError("state", "It is not running")), [409, "state"]);
  assert.deepEqual(said(new ProjectError("untrusted")), [409, "untrusted"]);
  assert.deepEqual(said(new ProposalStateError("expired")), [409, "expired"]);
  assert.deepEqual(said(new ProposalStateError("missing")), [404, "missing"]);
  // Operations.
  assert.deepEqual(said(new UnknownOpError("todo.nope")), [404, undefined]);
  assert.deepEqual(said(new OpInputError("title is required")), [400, undefined]);
  assert.deepEqual(said(Object.assign(new Error("It changed"), { name: "TodoConflictError" })), [409, "conflict"]);
  // The home node's services and the engine's, each code spelled its own way.
  assert.deepEqual(said(new TerminalError("unavailable", "No shell")), [503, "terminal_unavailable"]);
  assert.deepEqual(said(new VoiceError("busy", "One at a time")), [429, "voice_busy"]);
  assert.deepEqual(said(new SkillError("not_found", "No such skill")), [404, "skill_not_found"]);
  assert.deepEqual(said(new SkillError("unreachable", "skills.sh is away")), [502, "skill_unreachable"]);
  assert.deepEqual(said(new ModelSignInError("unknown_provider", "No such provider")), [404, "unknown_provider"]);
  assert.deepEqual(said(new ModelSignInError("state", "Not waiting for that")), [409, "state"]);
  assert.deepEqual(said(new McpConnectorError("exists", "Already there")), [409, "exists"]);
  assert.deepEqual(said(new McpConnectorError("invalid", "A url or a command")), [400, "invalid"]);
});

test("what core says without a name is about what it was given; anything else is a fault, and says nothing", () => {
  assert.deepEqual(statusOf(new Error("A title is 1\u2013200 characters")), { status: 400, body: { error: "A title is 1\u2013200 characters" } });
  assert.deepEqual(statusOf(new TypeError("x is not a function")), { status: 500, body: { error: "Internal error" } });
  assert.deepEqual(statusOf(new Fault(new Error("credentials are busy"))), { status: 500, body: { error: "Internal error" } });
  assert.deepEqual(statusOf("boom"), { status: 500, body: { error: "Internal error" } });
});

test("a body is a JSON object or it is refused", () => {
  assert.deepEqual(parseObject(""), {});
  assert.deepEqual(parseObject('{"a":1}'), { a: 1 });
  for (const text of ["[1]", "null", '"x"', "{"]) assert.throws(() => parseObject(text), (error) => error instanceof HttpError && error.status === 400);
});
