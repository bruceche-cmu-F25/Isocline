import type { DatabaseSync } from "node:sqlite";
import { TEMPLATE_TEXT, type AutomationTemplate } from "./automation-templates.ts";
import type { AwayDigest } from "./presence.ts";
import { localeOf } from "./settings.ts";

// A user can ask for delivery in the initial message or change their mind while it runs.
// Match explicit requests in their own prose. An ordinary question asking for the answer in
// chat, a condition to monitor, and instructions inside a quoted example are different intents.
const quoted = /```[\s\S]*?(?:```|$)|`[^`]*`|"[^"]*"|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|(?:^|\s)'[^'\n]+'|^\s*>.*$/gm;
const aboutWords = /\b(?:translate|translation|quoted?|example|phrasing|wording|what does|how (?:do|would) (?:you|i) say|saying|that says|(?:it|the (?:message|email|text)) says|why (?:did|do|would)|how (?:do|does) .{0,15}work)\b|翻译|举例|例句|什么意思|这句话|原文写|为什么|为何/;
const futureCondition = /\b(?:if|unless)\b|如果|假如|要是/;
const englishAction = /\b(?:(?:notify|ping|alert|message|tell|remind) me|let me know|report back|send me (?:an? (?:alert|notification|message)|a ping))\b/;
const chineseAction = /(?:通知|提醒|告诉|告知|喊|叫|发给?)我|(?:给我|跟我)(?:个?提醒|发(?:个|条)?(?:消息|通知)|说一声)/;
const englishFinished = /\b(?:when|once|after|upon|on|as soon as)\b[^,，]{0,40}\b(?:done|ready|finished|finish(?:es|ing)?|complete(?:d|s)?|completion)\b/;
const chineseFinished = /(?:做|写|查|看|读|弄|搞|办|跑|整理|处理|检查|分析|总结|准备|编译|生成)(?:完|好)|搞定|完成|结束|有了?结果|结果(?:出来|好了)/;
const inboxDestination = /\b(?:send|deliver|put|post|drop|leave|add)\b[^,，]{0,45}\b(?:to|in|into) (?:my |the )?inbox\b|(?:发|放|送|投递|推送|丢)[^，,]{0,12}(?:收件箱|inbox)/;
const resultToMe = /(?:把|将)?(?:最终)?(?:结果|报告)[^,，]{0,4}(?:发给?我|发我一份)/;
const directRequest = /(?:^|[,，]|\band\b|\bthen\b)\s*(?:please\s+|also\s+|然后|再|记得|请|也)?(?:notify me|ping me|alert me|message me|通知我(?:一下|一声)?|提醒我(?:一下|一声)?|给我发(?:个|条)?通知)\s*$/;
const negative = /\b(?:do not|don't|never|no need to|without|stop|skip|avoid|cancel)\s+(?:(?:ever|also|additionally|separately|automatically|personally)\s+)*(?:notif\w*|ping\w*|messag\w*|tell\w*|let\w*|remind\w*|send\w*|alert\w*|deliver\w*|put\w*|post\w*|report\w*)\b|(?:不(?:想|要|用|必|需要)?|别|无需|取消)(?:再|另外|额外|单独|特意|主动|给我|向我|完成后|做完后|发到|发送|任何|放进|放到|投递到|把结果){0,5}(?:通知|提醒|告知|告诉|消息|收件箱|inbox|发给?我|跟我说)/;
const retract = /\b(?:cancel|skip|stop|disable|no) (?:the |that |any )?(?:completion )?notifications?\b|(?:取消|不用|无需|不要)(?:这个|完成后?的?)?(?:通知|提醒)/;
const correction = /[.!?。！？；;\n]|[,，]?\s*(?:\b(?:actually|on second thought|instead|but)\b|改主意了|不过|但是|还是要|改成)[,，]?/;

export function completionNotification(text: string): boolean | undefined {
  // A pasted message introduced as source material belongs to its author.
  const prose = text.replace(/((?:following|this) (?:email|message|text|example)|(?:邮件|原文|示例|引用)(?:内容)?)[：:]\s*\n[\s\S]*/i, "")
    .replace(quoted, " ").replace(/’/g, "'").toLowerCase();
  let choice: boolean | undefined;
  for (const clause of prose.split(correction)) {
    if (aboutWords.test(clause) || futureCondition.test(clause)) continue;
    if (retract.test(clause)) { choice = false; continue; }
    const inbox = inboxDestination.test(clause);
    if (!inbox && !englishAction.test(clause) && !chineseAction.test(clause)) continue;
    if (negative.test(clause)) { choice = false; continue; }
    // “告诉我哪些任务完成了” asks for information now. In a completion request the
    // completion comes first (“整理完这份报告告诉我”).
    const finish = chineseFinished.exec(clause);
    const afterFinish = finish && chineseAction.test(clause.slice(finish.index + finish[0].length));
    if (inbox || resultToMe.test(clause) || directRequest.test(clause) || englishFinished.test(clause) || afterFinish) choice = true;
  }
  return choice;
}

type DeliveryRun = { id: string; goal: string; automationId: string | null };
/** Where a finished run's result goes, and for an automation's, how it is drawn and kept (its options). */
export function resultDestination(db: DatabaseSync, run: DeliveryRun, status: string): { delivery: "inbox"; template?: AutomationTemplate; layout?: "sections"; keep?: "latest" } | null {
  const rule = run.automationId ? db.prepare("SELECT * FROM core_automations WHERE id = ?").get(run.automationId) : undefined;
  const template = rule?.template as AutomationTemplate | undefined;
  // Columns a world at an older migration does not have yet read as their defaults.
  const options = { layout: rule?.layout ?? "text", keep: rule?.keep ?? (template === "brief" ? "latest" : "all"), notify: rule?.notify ?? (template === "mail_todos" ? "changes" : "always") };
  let requested = template ? undefined : completionNotification(run.goal);
  const steers = db.prepare("SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.notifyOnCompletion') AS requested FROM core_events WHERE run_id = ? AND kind = 'run.steered' AND actor = 'user' ORDER BY seq").all(run.id);
  for (const steer of steers) {
    if (steer.requested !== null) requested = steer.requested === 1;
    else if (typeof steer.text === "string") requested = completionNotification(steer.text) ?? requested;
  }
  if (requested === false || (!run.automationId && !requested)) return null;
  // "Only when there is something": a run that changed nothing and proposed nothing stays quiet.
  if (options.notify === "changes" && status === "completed" && !requested &&
      !db.prepare("SELECT 1 FROM core_events WHERE run_id = ? AND kind NOT LIKE 'run.%' LIMIT 1").get(run.id)) return null;
  return {
    delivery: "inbox", ...(template ? { template } : {}),
    ...(options.layout === "sections" ? { layout: "sections" as const } : {}), ...(options.keep === "latest" ? { keep: "latest" as const } : {}),
  };
}

export function awayResults(db: DatabaseSync, since: string, until: string): AwayDigest["runs"] {
  const rows = db.prepare(`SELECT r.id, r.conversation_id, r.updated_at, r.state, r.goal, c.project_id,
      a.name, a.template, json_extract(n.payload, '$.goal') AS notice_goal
    FROM core_runs r JOIN core_conversations c ON c.id = r.conversation_id
    LEFT JOIN core_automations a ON a.id = r.automation_id
    LEFT JOIN core_notices n ON n.kind = 'run_result' AND json_extract(n.payload, '$.runId') = r.id
      AND json_extract(n.payload, '$.delivery') = 'inbox' AND n.state IN ('pending','claimed','presented')
    WHERE r.updated_at > ? AND r.updated_at <= ? AND (r.state = 'interrupted' OR (n.id IS NOT NULL AND r.state IN ('completed','failed')))
    ORDER BY r.updated_at, r.rowid`).all(since, until);
  const completed = rows.filter((row) => row.state === "completed");
  const recent = completed.filter((row) => !row.project_id).slice(-3);
  const locale = localeOf(db);
  const results = recent.map((row) => ({
    runId: String(row.id), conversationId: String(row.conversation_id), at: String(row.updated_at),
    name: (row.name as string | null) ?? (row.template ? TEMPLATE_TEXT[row.template as AutomationTemplate][locale].name : null),
  }));
  return {
    completed: completed.length, failed: rows.filter((row) => row.state === "failed").length,
    interrupted: rows.filter((row) => row.state === "interrupted").length,
    goals: recent.map((row, i) => results[i].name ?? String(row.notice_goal ?? row.goal).slice(0, 80)), results,
  };
}

/** For an automation that keeps only its latest result (`keep: latest`, like the morning brief): one successful
 * edition in the Inbox. Failed editions leave the last good one available.
 * A return summary covers a time interval; refresh affected summaries so an old link cannot restore a retired edition. */
export function retirePreviousEditions(db: DatabaseSync, automationId: string, latestRunId: string, updateWelcomes = true): void {
  const retired = db.prepare(`UPDATE core_notices SET payload = json_set(payload, '$.delivery', 'history'),
      state = CASE WHEN state IN ('pending','claimed','presented') THEN 'expired' ELSE state END,
      claimed_by = NULL, claim_until = NULL
    WHERE kind = 'run_result' AND json_extract(payload, '$.automationId') = ? AND json_extract(payload, '$.delivery') = 'inbox'
      AND json_extract(payload, '$.status') = 'completed'
      AND json_extract(payload, '$.runId') != ? RETURNING created_at`).all(automationId, latestRunId);
  if (retired.length && updateWelcomes) refreshResultRecaps(db, retired.map((row) => String(row.created_at)));
}

/** For an automation that has failed several firings in a row: the notice that says so takes the place of the
 * earlier failures', so the Inbox holds one. */
export function retireFailedEditions(db: DatabaseSync, automationId: string, latestRunId: string): void {
  const retired = db.prepare(`UPDATE core_notices SET payload = json_set(payload, '$.delivery', 'history'),
      state = CASE WHEN state IN ('pending','claimed','presented') THEN 'expired' ELSE state END,
      claimed_by = NULL, claim_until = NULL
    WHERE kind = 'run_result' AND json_extract(payload, '$.automationId') = ? AND json_extract(payload, '$.delivery') = 'inbox'
      AND json_extract(payload, '$.status') = 'failed'
      AND json_extract(payload, '$.runId') != ? RETURNING created_at`).all(automationId, latestRunId);
  if (retired.length) refreshResultRecaps(db, retired.map((row) => String(row.created_at)));
}

export function refreshResultRecaps(db: DatabaseSync, times: string[]): void {
  const recaps = db.prepare(`SELECT id, created_at, json_extract(payload, '$.since') AS since FROM core_notices
    WHERE kind = 'welcome' AND state IN ('pending','claimed','presented')
      AND EXISTS (SELECT 1 FROM json_each(?) WHERE value > json_extract(payload, '$.since') AND value <= created_at)`).all(JSON.stringify(times));
  const update = db.prepare("UPDATE core_notices SET payload = json_set(payload, '$.runs', json(?)) WHERE id = ?");
  for (const row of recaps) update.run(JSON.stringify(awayResults(db, String(row.since), String(row.created_at))), row.id);
}

export function migrateResultDelivery(db: DatabaseSync): void {
  // Dismissed results from before the oldest visible recap (or last presence) are already
  // history. Reclassify only open notifications and results a return can still summarize.
  const cutoff = db.prepare(`SELECT min(at) AS at FROM (
    SELECT active_at AS at FROM core_presence UNION ALL
    SELECT json_extract(payload, '$.since') FROM core_notices WHERE kind = 'welcome' AND state IN ('pending','claimed','presented')
  )`).get()?.at;
  const rows = db.prepare(`SELECT n.id, r.id AS runId, r.automation_id, r.goal, json_extract(n.payload, '$.status') AS status
    FROM core_notices n JOIN core_runs r ON r.id = json_extract(n.payload, '$.runId') WHERE n.kind = 'run_result' AND (n.state IN ('pending','claimed','presented') OR n.created_at >= ?)`).all(cutoff ?? '9999');
  const mark = db.prepare("UPDATE core_notices SET payload = json_patch(payload, ?) WHERE id = ?");
  const expire = db.prepare("UPDATE core_notices SET state = 'expired', claimed_by = NULL, claim_until = NULL WHERE id = ? AND state IN ('pending','claimed','presented')");
  for (const row of rows) {
    const destination = resultDestination(db, { id: String(row.runId), goal: String(row.goal), automationId: row.automation_id as string | null }, String(row.status));
    if (destination) mark.run(JSON.stringify(destination), row.id);
    else expire.run(row.id);
  }
  const briefs = db.prepare("SELECT id FROM core_automations WHERE template = 'brief'").all();
  for (const brief of briefs) {
    const latest = db.prepare("SELECT id FROM core_runs WHERE automation_id = ? AND state = 'completed' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(brief.id);
    if (latest) retirePreviousEditions(db, String(brief.id), String(latest.id), false);
  }
  const welcomes = db.prepare("SELECT id, payload, created_at, event_seq FROM core_notices WHERE kind = 'welcome' AND state IN ('pending','claimed','presented')").all();
  // Only the upgrade reconstructs sequence cursors from timestamps. Keep the lookup cheap
  // even for a long history without adding a permanent index to every event write.
  if (welcomes.length) db.exec("CREATE INDEX core_delivery_upgrade_events_at ON core_events(at)");
  for (const row of welcomes) {
    const digest = JSON.parse(String(row.payload)) as AwayDigest;
    if (typeof digest.since !== "string") continue;
    const before = db.prepare("SELECT seq FROM core_events WHERE at <= ? ORDER BY at DESC, seq DESC LIMIT 1").get(digest.since);
    const changes = awayChanges(db, Number(before?.seq ?? 0), Number(row.event_seq));
    const runs = awayResults(db, digest.since, String(row.created_at));
    db.prepare("UPDATE core_notices SET payload = ? WHERE id = ?").run(JSON.stringify({ ...digest, runs, changes }), row.id);
  }
  if (welcomes.length) db.exec("DROP INDEX core_delivery_upgrade_events_at");
}

export function awayChanges(db: DatabaseSync, sinceSeq: number, untilSeq: number): Record<string, number> {
  const changes: Record<string, number> = {};
  const rows = db.prepare(`SELECT e.kind, sum(coalesce(json_extract(e.payload, '$.count'), 1)) AS n FROM core_events e
    WHERE e.seq > ? AND e.seq <= ? AND e.kind NOT LIKE 'run.%' AND e.kind NOT LIKE 'presence.%' AND e.kind NOT LIKE 'notice.%'
      AND e.actor IN ('alfred', 'system') AND (e.run_id IS NULL OR EXISTS (
        SELECT 1 FROM core_notices n WHERE n.kind = 'run_result' AND json_extract(n.payload, '$.runId') = e.run_id
          AND json_extract(n.payload, '$.delivery') = 'inbox' AND n.state IN ('pending','claimed','presented')))
    GROUP BY e.kind`).all(sinceSeq, untilSeq);
  for (const row of rows) {
    const module = String(row.kind).split(".")[0];
    changes[module] = (changes[module] ?? 0) + Number(row.n);
  }
  return changes;
}
