import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptProposal, CORE_MIGRATIONS, listEvents, listNotices, listOpenProposals, listOutbound, openWorld, updateSettings, type World } from "@isocline/core";
import { applyStep, assistantTools, deliverQueued, invokeOp, runTools, ServiceError, type GoogleService } from "@isocline/module-kit";
import { buildRaw, checkAddress, mailModule, syncMail, type MailSnapshot } from "../src/index.ts";

const world = (): World => openWorld(":memory:", [...CORE_MIGRATIONS, ...mailModule.migrations]);
const signal = new AbortController().signal;
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const bodyOf = (message: string) => Buffer.from(message.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");

/** One message in the inbox from Leo; `answers` scripts Gmail's replies to sends. */
function fakeGmail(options: { capabilities?: string[]; answers?: Array<{ status: number; body?: Record<string, unknown> } | Error> } = {}) {
  const sent: Array<{ url: string; body: { raw: string; threadId?: string } }> = [];
  const answers = [...(options.answers ?? [])];
  const google: GoogleService = {
    accounts: () => [{ email: "me@example.com", capabilities: options.capabilities ?? ["mailRead", "mailSend"] }],
    async session() {
      return {
        async get(url) {
          if (url.includes("format=metadata")) return { payload: { headers: [{ name: "Message-ID", value: "<leo-1@studio.example>" }, { name: "References", value: "<leo-0@studio.example>" }] } };
          if (/\/messages\?/.test(url)) return { messages: [{ id: "m1" }] };
          return { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now()), snippet: "Can you sign by Friday?",
            payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Leo Chen <leo@studio.example>" }, { name: "Subject", value: "合同第二版" }], body: { data: Buffer.from("Can you sign by Friday?").toString("base64url") } } };
        },
        async send(_method, url, body) {
          sent.push({ url, body: body as { raw: string; threadId?: string } });
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { status: next?.status ?? 200, body: next?.body ?? { id: "s1", threadId: "t1" } };
        },
      };
    },
  };
  return { google, sent };
}

async function propose(w: World, params: Record<string, unknown>): Promise<string> {
  const tool = assistantTools(w, [mailModule]).find((candidate) => candidate.name === "propose")!;
  return tool.execute({ title: "Reply to Leo?", summary: "", calls: [{ tool: "mail_send", params }] }, signal);
}
const accept = (w: World) => acceptProposal(w, listOpenProposals(w)[0].id, (step) => { applyStep(w, [mailModule], step); });

test("an email is written so nothing in it can add a header or a recipient", () => {
  assert.equal(checkAddress(" Leo@Studio.example "), "leo@studio.example");
  for (const bad of ["leo@studio.example\r\nBcc: spy@x.com", "Leo <leo@studio.example>", "leo@studio.example, spy@x.com", "not-an-address"]) assert.equal(checkAddress(bad), null, bad);
  const message = decode(buildRaw({ account: "me@example.com", to: ["leo@studio.example"], cc: [], subject: "Re: 合同\r\nBcc: spy@x.com", body: "好的，周五前签。\n\nBruce" }, { messageId: "<leo-1@studio.example>", references: "<leo-0@studio.example>" }));
  const headers = message.split("\r\n\r\n")[0].split("\r\n");
  assert.deepEqual(headers.filter((line) => /^(bcc|to|cc):/i.test(line)), ["To: leo@studio.example"]);
  assert.ok(headers.includes(`Subject: =?UTF-8?B?${Buffer.from("Re: 合同 Bcc: spy@x.com").toString("base64")}?=`), "the subject is one encoded line");
  assert.ok(headers.includes("In-Reply-To: <leo-1@studio.example>") && headers.includes("References: <leo-0@studio.example> <leo-1@studio.example>"));
  assert.equal(bodyOf(message), "好的，周五前签。\r\n\r\nBruce");
});

test("nothing is sent without the user's yes: no run can call mail_send, it can only propose it", async () => {
  const w = world();
  const { google, sent } = fakeGmail();
  await syncMail(w, { google });
  assert.deepEqual(runTools(w, [mailModule], { askFor: ["irreversible", "batch"] }).map((tool) => tool.name), ["mail_list", "mail_read"]);
  assert.match(String(mailModule.tools.find((tool) => tool.name === "mail_send")!.execute(w, {} as never)), /never done directly/);

  assert.match(await propose(w, { reply_to: "m1", body: "Friday works." }), /^Proposed/);
  await deliverQueued(w, mailModule, { google }, signal);
  assert.equal(sent.length, 0, "proposed, not accepted: nothing to send");
  const [proposal] = listOpenProposals(w);
  assert.deepEqual([proposal.steps[0].preview, proposal.steps[0].detail], [
    "Reply to leo@studio.example: Re: 合同第二版",
    "To: leo@studio.example\nSubject: Re: 合同第二版\n\nFriday works.",
  ]);
});

test("a reply, accepted: sent once in its thread, threaded for every mail program, and told", async () => {
  const w = world();
  const { google, sent } = fakeGmail();
  await syncMail(w, { google });
  updateSettings(w, { locale: "zh" });
  await propose(w, { reply_to: "m1", body: "可以，周五前签好发你。" });
  const accepted = accept(w);
  assert.equal(accepted.state, "executed");
  assert.equal(accepted.outcome?.deliveryQueued, true);
  assert.equal(sent.length, 0, "approval did not confirm Gmail delivery");
  assert.equal(listOutbound(w)[0].preview, "回复 leo@studio.example：Re: 合同第二版");

  await deliverQueued(w, mailModule, { google }, signal);
  await deliverQueued(w, mailModule, { google }, signal);
  assert.equal(sent.length, 1, "exactly once");
  assert.equal(sent[0].body.threadId, "t1");
  const message = decode(sent[0].body.raw);
  assert.match(message, /^To: leo@studio\.example\r\n/);
  assert.match(message, /In-Reply-To: <leo-1@studio\.example>/);
  assert.equal(bodyOf(message), "可以，周五前签好发你。");
  assert.deepEqual([listOutbound(w)[0].state, listOutbound(w)[0].result], ["done", { id: "s1", threadId: "t1" }]);
});

test("when Gmail's answer is unclear the email is not sent again: the user is asked to check", async () => {
  for (const [answer, state] of [[{ status: 503 }, "unknown"], [new ServiceError("unavailable", "connection reset"), "unknown"], [{ status: 400, body: { error: { message: "Invalid To header" } } }, "failed"]] as const) {
    const w = world();
    const { google, sent } = fakeGmail({ answers: [answer] });
    await syncMail(w, { google });
    await propose(w, { to: ["ana@example.com"], subject: "Hello", body: "Hi Ana" });
    accept(w);
    await deliverQueued(w, mailModule, { google }, signal);
    await deliverQueued(w, mailModule, { google }, signal);
    assert.equal(sent.length, 1);
    assert.equal(listOutbound(w)[0].state, state);
    const receipt = listNotices(w).find((notice) => notice.kind === "outbound")!;
    assert.equal(receipt.payload.account, "me@example.com", "the user can check the sending account");
  }
});

test("no permission to send: not proposable, and an accepted email whose permission was taken away is not sent", async () => {
  const w = world();
  const readOnly = fakeGmail({ capabilities: ["mailRead"] });
  await syncMail(w, { google: readOnly.google });
  assert.match(await propose(w, { reply_to: "m1", body: "Friday works." }), /has not let Isocline send/);

  await syncMail(w, { google: fakeGmail().google });
  await propose(w, { reply_to: "m1", body: "Friday works." });
  accept(w);
  await deliverQueued(w, mailModule, { google: readOnly.google }, signal);
  assert.equal(readOnly.sent.length, 0);
  assert.equal(listOutbound(w)[0].state, "failed");
});

test("the mail page hears what was sent from here: Isocline's draft once accepted, and a reply the user wrote themself", async () => {
  const w = world();
  const { google, sent } = fakeGmail();
  await syncMail(w, { google });
  const page = () => (mailModule.snapshot!(w) as MailSnapshot).sent.map((mail) => [mail.replyTo, mail.to.join(), mail.body, mail.state]);
  await propose(w, { reply_to: "m1", body: "Friday works." });
  assert.deepEqual(page(), [], "a draft is not sent mail");
  accept(w);
  assert.deepEqual(page(), [["m1", "leo@studio.example", "Friday works.", "queued"]]);
  await deliverQueued(w, mailModule, { google }, signal);
  assert.deepEqual(page(), [["m1", "leo@studio.example", "Friday works.", "done"]]);

  // The user's own words, sent by their click: the same operation a proposal's yes runs, with no proposal.
  const own = { account: "me@example.com", to: ["leo@studio.example"], cc: [], subject: "Re: 合同第二版", body: "One more thing: who signs first?", replyTo: { id: "m1", threadId: "t1" } };
  assert.ok((invokeOp(w, [mailModule], { op: "mail.send", requestId: "own-1", input: own }).result as { queued?: string }).queued);
  invokeOp(w, [mailModule], { op: "mail.send", requestId: "own-1", input: own });
  await deliverQueued(w, mailModule, { google }, signal);
  assert.equal(sent.length, 2, "a retried click does not send twice");
  assert.equal(bodyOf(decode(sent[1].body.raw)), "One more thing: who signs first?");
  assert.deepEqual(page().map((mail) => mail[3]), ["done", "done"]);
  assert.match(String((invokeOp(w, [mailModule], { op: "mail.send", requestId: "own-2", input: { ...own, to: ["Leo <leo@studio.example>"] } }).result as { error?: string }).error), /plain email addresses/);
});

test("a send-only account can compose new mail without reading an inbox or starting a proposal", async () => {
  const w = world();
  const { google, sent } = fakeGmail({ capabilities: ["mailSend"] });
  const page = () => mailModule.snapshot!(w) as MailSnapshot;
  await syncMail(w, { google: fakeGmail().google });
  assert.equal(page().messages.length, 1);
  await syncMail(w, { google: { ...google, session: async () => assert.fail("send-only sync must not read Gmail") } });
  assert.deepEqual(page().messages, [], "removing read access clears the previous mirror");
  assert.deepEqual(page().sources.map((source) => [source.account, source.canRead, source.canSend]), [["me@example.com", false, true]]);
  const input = { account: "me@example.com", to: ["ana@example.com"], cc: ["leo@example.com"], subject: "你好", body: "周五见。" };
  const click = { op: "mail.send", requestId: "compose-click", input };
  const queued = invokeOp(w, [mailModule], click);
  assert.equal(invokeOp(w, [mailModule], click).replayed, true);
  assert.deepEqual(queued.result, { queued: page().sent[0].id });
  assert.equal(page().sent[0].state, "queued");
  await deliverQueued(w, mailModule, { google }, signal);
  assert.equal(sent.length, 1);
  const message = decode(sent[0].body.raw);
  assert.equal(sent[0].body.threadId, undefined);
  assert.doesNotMatch(message, /In-Reply-To:|References:/);
  assert.match(message, /To: ana@example\.com\r\nCc: leo@example\.com/);
  assert.equal(bodyOf(message), input.body);
  assert.equal(page().sent[0].state, "done");
  await syncMail(w, { google: fakeGmail({ capabilities: ["mailRead"] }).google });
  assert.deepEqual(page().sources.map((source) => [source.canRead, source.canSend]), [[true, false]]);
  assert.equal(page().messages.length, 1);
  const syncCount = () => listEvents(w).events.filter((event) => event.kind === "mail.synced").length;
  const before = syncCount();
  await syncMail(w, { google: fakeGmail().google });
  assert.equal(syncCount(), before + 1, "send access changed while the inbox stayed the same");
});
