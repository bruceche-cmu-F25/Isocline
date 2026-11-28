/** The core's own tables. Modules add theirs through their own migrations, in
 * the same database, so a module change and its core event share a transaction.
 */
import { PREFERENCE_MIGRATION_SQL } from "./preferences.ts";
import { AREA_MIGRATION_SQL } from "./areas.ts";
import { migrateResultDelivery } from "./result-delivery.ts";
import type { Migration } from "./world.ts";

export const RUN_STATES = [
  "queued", "running", "waiting_permission", "waiting_input",
  "cancelling", "completed", "failed", "cancelled", "interrupted",
] as const;
/** States a run can still move on from by itself, or after the user answers: not yet ended. `interrupted` is not one
 * of them (it waits for the user to start it again). Code outside the core asks `isRunUnfinished`, not the table. */
export const UNFINISHED_RUN_STATES = ["queued", "running", "waiting_permission", "waiting_input", "cancelling"] as const satisfies readonly (typeof RUN_STATES)[number][];
export const NOTICE_STATES = ["pending", "claimed", "presented", "acknowledged", "expired"] as const;
export const ACTORS = ["user", "alfred", "system"] as const;
export const PROPOSAL_STATES = ["open", "executed", "declined", "stale", "failed", "superseded", "expired"] as const;

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const object = (column: string) => `json_valid(${column}) AND json_type(${column}) = 'object'`;

export const CORE_MIGRATIONS: readonly Migration[] = [{
  id: "core:1",
  sql: `
CREATE TABLE core_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  at TEXT NOT NULL CHECK (length(at) > 0),
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*.[a-z]*' AND length(kind) <= 64),
  subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 160),
  run_id TEXT,
  actor TEXT CHECK (actor IS NULL OR actor IN (${list(ACTORS)})),
  payload TEXT NOT NULL CHECK (${object("payload")})
) STRICT;
CREATE INDEX core_events_subject ON core_events(subject, seq);
CREATE INDEX core_events_run ON core_events(run_id, seq);

CREATE TABLE core_runs (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 64),
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 8000),
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN (${list(RUN_STATES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  outcome TEXT CHECK (outcome IS NULL OR ${object("outcome")})
) STRICT;
CREATE INDEX core_runs_state ON core_runs(state, created_at);
CREATE INDEX core_runs_conversation ON core_runs(conversation_id, created_at);

CREATE TABLE core_notices (
  id TEXT PRIMARY KEY NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES core_events(seq),
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND length(kind) <= 64),
  state TEXT NOT NULL CHECK (state IN (${list(NOTICE_STATES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_by TEXT,
  claim_until TEXT,
  expires_at TEXT,
  payload TEXT NOT NULL CHECK (${object("payload")})
) STRICT;
CREATE INDEX core_notices_state ON core_notices(state, created_at);

CREATE TABLE core_commands (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  command TEXT NOT NULL,
  at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result))
) STRICT;
`,
}, {
  // Conversations become threads of their own; a run may wait on a question to the user.
  id: "core:2",
  sql: `
CREATE TABLE core_conversations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;
CREATE INDEX core_conversations_updated ON core_conversations(updated_at);
INSERT INTO core_conversations (id, title, created_at, updated_at)
  SELECT r.conversation_id,
    (SELECT substr(f.goal, 1, 40) FROM core_runs f WHERE f.conversation_id = r.conversation_id ORDER BY f.created_at, f.rowid LIMIT 1),
    min(r.created_at), max(r.updated_at)
  FROM core_runs r GROUP BY r.conversation_id;
ALTER TABLE core_runs ADD COLUMN request TEXT CHECK (request IS NULL OR (json_valid(request) AND json_type(request) = 'object'));
`,
}, {
  // A conversation may choose its model and how hard it thinks; unset means the engine's default.
  id: "core:3",
  sql: `
ALTER TABLE core_conversations ADD COLUMN model TEXT CHECK (model IS NULL OR (length(model) BETWEEN 3 AND 200 AND instr(model, '/') > 1));
ALTER TABLE core_conversations ADD COLUMN thinking TEXT CHECK (thinking IS NULL OR thinking IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
`,
}, {
  // Changes Zirma prepares that wait for the user's yes (proposals.ts).
  id: "core:4",
  sql: `
CREATE TABLE core_proposals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN (${list(PROPOSAL_STATES)})),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) <= 2000),
  steps TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps) = 'array' AND json_array_length(steps) BETWEEN 1 AND 20),
  subjects TEXT NOT NULL CHECK (json_valid(subjects) AND json_type(subjects) = 'array'),
  opened_seq INTEGER NOT NULL,
  run_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR (json_valid(outcome) AND json_type(outcome) = 'object'))
) STRICT;
CREATE INDEX core_proposals_state ON core_proposals(state, created_at);
`,
}, {
  // The user's preferences that are not secrets (settings.ts); each change is also a settings.changed event.
  id: "core:5",
  sql: `
CREATE TABLE core_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;
`,
}, {
  // The page a request came from (runs.ts ViewContext): context for the engine, shown with the user's words.
  id: "core:6",
  sql: `
ALTER TABLE core_runs ADD COLUMN context TEXT CHECK (context IS NULL OR (json_valid(context) AND json_type(context) = 'object'));
`,
}, {
  // Paired devices (devices.ts): only a hash of each device's token is kept.
  id: "core:7",
  sql: `
CREATE TABLE core_devices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'phone', 'browser')),
  via TEXT CHECK (via IS NULL OR length(via) <= 200),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
) STRICT;
`,
}, {
  // Automations (automations.ts): rules that start a run on a schedule. A run they start says which (core_runs.automation_id).
  id: "core:8",
  sql: `
CREATE TABLE core_automations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
  template TEXT CHECK (template IS NULL OR template IN ('brief')),
  goal TEXT CHECK (goal IS NULL OR length(goal) BETWEEN 1 AND 2000),
  schedule TEXT NOT NULL CHECK (json_valid(schedule) AND json_type(schedule) = 'object'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  conversation_id TEXT,
  last_slot TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (template IS NOT NULL OR (name IS NOT NULL AND goal IS NOT NULL))
) STRICT;
ALTER TABLE core_runs ADD COLUMN automation_id TEXT CHECK (automation_id IS NULL OR length(automation_id) BETWEEN 1 AND 64);
`,
}, {
  // Projects (projects.ts): folders Zirma may work in. A conversation in one is a development session, fixed at creation.
  id: "core:9",
  sql: `
CREATE TABLE core_projects (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND substr(path, 1, 1) = '/'),
  created_at TEXT NOT NULL,
  trusted_at TEXT,
  removed_at TEXT
) STRICT;
CREATE UNIQUE INDEX core_projects_path ON core_projects(path) WHERE removed_at IS NULL;
ALTER TABLE core_conversations ADD COLUMN project_id TEXT CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 64);
`,
}, {
  // A development session's permission mode (projects.ts SESSION_MODES), and the snapshot of its folder it started
  // from (a git commit), which its changes are measured against.
  id: "core:10",
  sql: `
ALTER TABLE core_conversations ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('plan', 'ask', 'edits'));
ALTER TABLE core_conversations ADD COLUMN base TEXT CHECK (base IS NULL OR length(base) BETWEEN 4 AND 64);
UPDATE core_conversations SET mode = 'plan' WHERE project_id IS NOT NULL;
`,
}, {
  // Changes made outside the home node (outbound.ts): recorded with the decision, delivered after, never twice.
  id: "core:11",
  sql: `
CREATE TABLE core_outbound (
  id TEXT PRIMARY KEY NOT NULL,
  module TEXT NOT NULL CHECK (length(module) BETWEEN 1 AND 32),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  preview TEXT NOT NULL CHECK (length(preview) BETWEEN 1 AND 300),
  detail TEXT,
  idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
  proposal_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'done', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX core_outbound_queue ON core_outbound(module, state, created_at);
`,
}, {
  // When the user was last seen (presence.ts): one row of state instead of a `presence.active` event every few
  // minutes. Seeded from those events, so nobody is greeted for the upgrade itself.
  id: "core:12",
  sql: `
CREATE TABLE core_presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_at TEXT,
  active_seq INTEGER,
  away_at TEXT,
  away_seq INTEGER
) STRICT;
INSERT INTO core_presence (id, active_at, active_seq, away_at, away_seq)
  SELECT 1, a.at, a.seq, w.at, w.seq FROM (SELECT 1)
    LEFT JOIN (SELECT at, seq FROM core_events WHERE subject = 'presence' AND kind = 'presence.active' ORDER BY seq DESC LIMIT 1) a ON 1
    LEFT JOIN (SELECT at, seq FROM core_events WHERE subject = 'presence' AND kind = 'presence.away' ORDER BY seq DESC LIMIT 1) w ON w.seq > COALESCE(a.seq, 0);
`,
}, {
  // Commands in development sessions (shell.ts): the commands the user allowed for the rest of a session. And what a
  // paired device may do beyond the everyday (devices.ts): `dev` lets it into development sessions.
  id: "core:13",
  sql: `
ALTER TABLE core_conversations ADD COLUMN commands TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(commands) AND json_type(commands) = 'array');
ALTER TABLE core_devices ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array');
`,
}, {
  // A second automation Zirma ships with (automation-templates.ts): picking todos out of mail. The templates a row
  // may name are in the table's own check, which SQLite cannot change in place, so the table is made again.
  id: "core:14",
  sql: `
CREATE TABLE core_automations_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
  template TEXT CHECK (template IS NULL OR template IN ('brief', 'mail_todos')),
  goal TEXT CHECK (goal IS NULL OR length(goal) BETWEEN 1 AND 2000),
  schedule TEXT NOT NULL CHECK (json_valid(schedule) AND json_type(schedule) = 'object'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  conversation_id TEXT,
  last_slot TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (template IS NOT NULL OR (name IS NOT NULL AND goal IS NOT NULL))
) STRICT;
INSERT INTO core_automations_next (id, name, template, goal, schedule, enabled, conversation_id, last_slot, last_run_id, created_at, updated_at)
  SELECT id, name, template, goal, schedule, enabled, conversation_id, last_slot, last_run_id, created_at, updated_at FROM core_automations;
DROP TABLE core_automations;
ALTER TABLE core_automations_next RENAME TO core_automations;
`,
}, {
  // A change the user made themselves, in place (an event typed into the calendar page): that it went through is
  // not news to them, so only its failing is told (outbound.ts).
  id: "core:15",
  sql: `
ALTER TABLE core_outbound ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1));
`,
}, {
  // Files the user sends with a message (files.ts): what each is; its bytes are on the home node's disk under its id.
  id: "core:16",
  sql: `
CREATE TABLE core_files (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'pdf')),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  meta TEXT CHECK (meta IS NULL OR json_valid(meta)),
  conversation_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX core_files_run ON core_files(run_id);
`,
}, {
  // A development session in a worktree of its own (docs/design/dev-mode.md 4.2, D5): the folder it works in instead of
  // the project's, and the branch checked out there.
  id: "core:17",
  sql: `
ALTER TABLE core_conversations ADD COLUMN worktree TEXT;
ALTER TABLE core_conversations ADD COLUMN branch TEXT;
`,
}, {
  // How fast a conversation's model writes (conversations.ts `speed`): null standard, `fast` where the provider
  // offers it for a higher price.
  id: "core:18",
  sql: `
ALTER TABLE core_conversations ADD COLUMN speed TEXT CHECK (speed IS NULL OR speed IN ('fast'));
`,
}, {
  // Older clients could resume from the conversation without acknowledging the interruption.
  // A run may have stopped again since; only the interruption after its last resume is current.
  id: "core:19",
  sql: `
UPDATE core_notices
SET state = 'acknowledged', claimed_by = NULL, claim_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE kind = 'run_interrupted' AND state IN ('pending','claimed','presented')
  AND (NOT EXISTS (
    SELECT 1 FROM core_runs r WHERE r.id = json_extract(core_notices.payload, '$.runId') AND r.state = 'interrupted'
  ) OR EXISTS (
    SELECT 1 FROM core_events e WHERE e.run_id = json_extract(core_notices.payload, '$.runId')
      AND e.kind = 'run.resumed' AND e.seq > core_notices.event_seq
  ));
`,
}, {
  id: "core:20",
  sql: `
CREATE INDEX core_notices_run_result ON core_notices(json_extract(payload, '$.runId')) WHERE kind = 'run_result';
CREATE INDEX core_runs_updated_at ON core_runs(updated_at);
`,
  apply: migrateResultDelivery,
}, {
  // Only new ordinary replies set this marker. An upgrade never marks the user's existing history unread.
  id: "core:21",
  sql: `
ALTER TABLE core_conversations ADD COLUMN unread_reply_id TEXT REFERENCES core_runs(id);
`,
}, {
  id: "core:22",
  sql: `
ALTER TABLE core_conversations ADD COLUMN archive_plan TEXT CHECK (archive_plan IN ('now', 'finish', 'stop'));
CREATE INDEX core_conversations_archiving ON core_conversations(archive_plan) WHERE archive_plan IS NOT NULL;
`,
}, {
  // Large replies live beside the compact outcomes used in /state and result previews.
  id: "core:23",
  sql: `
CREATE TABLE core_run_replies (
  run_id TEXT PRIMARY KEY REFERENCES core_runs(id) ON DELETE CASCADE,
  reply TEXT NOT NULL
) STRICT;
`,
}, {
  id: "core:24",
  sql: `
ALTER TABLE core_devices ADD COLUMN dev_access_requested INTEGER NOT NULL DEFAULT 0 CHECK (dev_access_requested IN (0, 1));
`,
}, {
  // A salted web-unlock verifier. Keep it separate from settings, which every device can read.
  id: "core:25",
  sql: `
CREATE TABLE core_web_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt BLOB,
  verifier BLOB,
  CHECK ((salt IS NULL AND verifier IS NULL)
    OR (salt IS NOT NULL AND length(salt) = 16 AND verifier IS NOT NULL AND length(verifier) = 32))
) STRICT;
INSERT INTO core_web_lock (id) VALUES (1);
`,
}, {
  // Where the upkeep of the log has got to (upkeep.ts): events up to this one have had their bulk dropped.
  id: "core:26",
  sql: `
CREATE TABLE core_upkeep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  trimmed_seq INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO core_upkeep (id) VALUES (1);
`,
}, {
  id: "core:27",
  sql: "ALTER TABLE core_outbound ADD COLUMN after_id TEXT REFERENCES core_outbound(id);",
}, {
  // The user's areas, with the seven samples written in once (areas.ts).
  id: "core:28",
  sql: AREA_MIGRATION_SQL,
}, {
  // What made the morning brief different becomes options every automation has (automations.ts,
  // docs/design/user-defined.md §3.3); the two samples keep how they behaved. Results already in the Inbox say how
  // they are drawn, so an edition does not depend on which sample it came from.
  id: "core:29",
  sql: `
ALTER TABLE core_automations ADD COLUMN layout TEXT NOT NULL DEFAULT 'text' CHECK (layout IN ('text', 'sections'));
ALTER TABLE core_automations ADD COLUMN keep TEXT NOT NULL DEFAULT 'all' CHECK (keep IN ('all', 'latest'));
ALTER TABLE core_automations ADD COLUMN notify TEXT NOT NULL DEFAULT 'always' CHECK (notify IN ('always', 'changes'));
ALTER TABLE core_automations ADD COLUMN k TEXT NOT NULL DEFAULT 'green' CHECK (k IN ('blue', 'green', 'violet', 'orange', 'teal', 'yellow', 'pink', 'gray'));
UPDATE core_automations SET layout = 'sections', keep = 'latest', k = 'orange' WHERE template = 'brief';
UPDATE core_automations SET notify = 'changes', k = 'blue' WHERE template = 'mail_todos';
UPDATE core_notices SET payload = json_set(payload, '$.layout', 'sections', '$.keep', 'latest')
  WHERE kind = 'run_result' AND json_extract(payload, '$.template') = 'brief';
`,
}, {
  // What the user has said about how they like things (preferences.ts; ARCHITECTURE.md §8's USER.md).
  id: "core:30",
  sql: PREFERENCE_MIGRATION_SQL,
}, {
  id: "core:32",
  sql: "ALTER TABLE core_projects ADD COLUMN default_mode TEXT NOT NULL DEFAULT 'edits' CHECK (default_mode IN ('plan', 'ask', 'edits'));",
}, {
  // A proposal the user asked to change stays in the inbox while this run writes the new version (proposals.ts).
  id: "core:33",
  sql: `
ALTER TABLE core_proposals ADD COLUMN revising_run_id TEXT;
ALTER TABLE core_proposals ADD COLUMN revising_request TEXT;
`,
}, {
  // A turn can have versions: regenerated, or its message edited and sent again (docs/design/chat-regenerate.md).
  // `version_of`: the group's first run; `set_aside`: not the version the conversation goes on from.
  id: "core:34",
  sql: `
ALTER TABLE core_runs ADD COLUMN version_of TEXT CHECK (version_of IS NULL OR length(version_of) BETWEEN 1 AND 64);
ALTER TABLE core_runs ADD COLUMN set_aside INTEGER NOT NULL DEFAULT 0 CHECK (set_aside IN (0, 1));
CREATE INDEX core_runs_version ON core_runs(version_of) WHERE version_of IS NOT NULL;
`,
}];
