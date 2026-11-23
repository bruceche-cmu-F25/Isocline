/** Sending email from the user's Gmail: a new message, or a reply in its thread. A run never sends (level `external`):
 * it proposes the whole email, which the user reads in full and accepts, declines, or asks to change. On the yes it
 * becomes an outbound change (core/outbound.ts), which the home node hands to `deliverMail`. Sending is not
 * idempotent, so it is tried once: anything other than a clear answer from Gmail leaves it `unknown`, and the user is
 * asked to look in Sent.
 */
import { enqueueOutbound, localeOf, userLocale, type Locale, type Outbound, type World, defineOp, defineTool, Type, type Delivered, type GoogleSession, type ModuleServices } from "@alfred/module-kit";
import { getMail } from "./index.ts";
import type { SendInput } from "./types.ts";

export type { SendInput } from "./types.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
/** Plain addresses only: a name with commas or a line break could add a recipient or a header nobody saw. */
export function checkAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return ADDRESS.test(address) && address.length <= 254 ? address : null;
}

/** RFC 2047 for a header that is not plain ASCII. */
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** The message as Gmail takes it (base64url of RFC 822), plain text in UTF-8. */
export function buildRaw(input: SendInput, thread?: { messageId?: string; references?: string }): string {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(oneLine(input.subject))}`,
    ...(thread?.messageId ? [`In-Reply-To: ${oneLine(thread.messageId)}`, `References: ${oneLine(`${thread.references ?? ""} ${thread.messageId}`)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8").toString("base64url");
}

const SAY: Record<Locale, { preview(input: SendInput): string; detail(input: SendInput): string; noPermission: string }> = {
  zh: {
    noPermission: "没有发信的权限：在设置里打开「Gmail：替你发」",
    preview: (input: SendInput) => `${input.replyTo ? "回复" : "发邮件给"} ${input.to.join("、")}：${input.subject}`,
    detail: (input: SendInput) => [`收件人：${input.to.join(", ")}`, ...(input.cc.length ? [`抄送：${input.cc.join(", ")}`] : []), `主题：${input.subject}`, "", input.body].join("\n"),
  },
  en: {
    noPermission: "No permission to send: turn on “Gmail: send for you” in Settings",
    preview: (input: SendInput) => `${input.replyTo ? "Reply to" : "Email"} ${input.to.join(", ")}: ${input.subject}`,
    detail: (input: SendInput) => [`To: ${input.to.join(", ")}`, ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []), `Subject: ${input.subject}`, "", input.body].join("\n"),
  },
};

function check(input: SendInput): string | null {
  if (!input.to.length) return "Nobody to send it to";
  if (input.to.length + input.cc.length > 20) return "Too many recipients";
  if ([...input.to, ...input.cc].some((address) => checkAddress(address) !== address)) return "Recipients must be plain email addresses";
  if (!input.body.trim()) return "The email has no text";
  return null;
}

export const mailOps = [
  defineOp({
    name: "mail.send",
    input: Type.Object({
      account: Type.String({ maxLength: 320 }),
      to: Type.Array(Type.String({ maxLength: 254 }), { minItems: 1, maxItems: 20 }),
      cc: Type.Array(Type.String({ maxLength: 254 }), { maxItems: 20 }),
      subject: Type.String({ maxLength: 500 }),
      body: Type.String({ minLength: 1, maxLength: 20_000 }),
      replyTo: Type.Optional(Type.Object({ id: Type.String({ maxLength: 64 }), threadId: Type.String({ maxLength: 64 }) })),
    }),
    run(world, input) {
      const problem = check(input as SendInput);
      if (problem) return { error: problem };
      const say = SAY[userLocale(world)];
      const outbound = enqueueOutbound(world, { module: "mail", action: "send", payload: input, preview: say.preview(input as SendInput), detail: say.detail(input as SendInput), idempotent: false });
      return { queued: outbound.id };
    },
  }),
];

const NO_SEND = "The user has not let Alfred send from this account. Tell them they can turn on “Gmail: send for you” in Settings; meanwhile you can show the draft in the conversation.";

export const mailWriteTools = [
  defineTool({
    name: "mail_send",
    label: "Send email",
    description: [
      "Send an email from the user's Gmail, or reply to one in its thread (reply_to: its id from mail_list).",
      "Only through `propose`: the user reads the whole email and it goes out only when they accept.",
      "Write it in the user's voice and language; a reply goes to the sender with “Re:” unless you say otherwise.",
    ].join(" "),
    level: "external",
    parameters: Type.Object({
      reply_to: Type.Optional(Type.String({ maxLength: 64, description: "The id of the message this answers" })),
      to: Type.Optional(Type.Array(Type.String({ maxLength: 254 }), { maxItems: 20, description: "Addresses; for a reply, the sender if left out" })),
      cc: Type.Optional(Type.Array(Type.String({ maxLength: 254 }), { maxItems: 20 })),
      subject: Type.Optional(Type.String({ maxLength: 500, description: "For a reply, “Re: …” if left out" })),
      body: Type.String({ minLength: 1, maxLength: 20_000, description: "The text, plain, signed as the user would" }),
    }),
    describe: (_world, params) => params.subject ?? params.reply_to ?? "",
    execute: () => "Sending email is never done directly: put this call in `propose`, and it is sent when the user accepts.",
    pin(world, params) {
      const original = params.reply_to ? getMail(world, params.reply_to) : null;
      if (params.reply_to && !original) return { error: `No message ${params.reply_to} in the inbox mirror. Use mail_list.` };
      const accounts = world.db.prepare("SELECT account FROM mail_sources WHERE can_send = 1 ORDER BY account").all().map((row) => row.account as string);
      const account = original ? original.account : accounts[0];
      if (!account || !accounts.includes(account)) return { error: NO_SEND };
      const to = (params.to?.length ? params.to : original ? [original.fromEmail] : []).map((address) => checkAddress(address) ?? address);
      const cc = (params.cc ?? []).map((address) => checkAddress(address) ?? address);
      const subject = params.subject?.trim() || (original ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : "");
      const input: SendInput = { account, to, cc, subject, body: params.body.trim(), ...(original ? { replyTo: { id: original.id, threadId: original.threadId } } : {}) };
      const problem = check(input);
      if (problem) return { error: problem };
      const say = SAY[userLocale(world)];
      return { op: "mail.send", input, preview: say.preview(input), detail: say.detail(input) };
    },
  }),
];

async function sendOne(session: GoogleSession, outbound: Outbound, signal?: AbortSignal): Promise<Delivered> {
  const input = outbound.payload as SendInput;
  let thread: { messageId?: string; references?: string } | undefined;
  if (input.replyTo) {
    // The original's ids, read fresh, so the reply threads in every mail program, not just Gmail.
    const original = await session.get(`${API}/messages/${encodeURIComponent(input.replyTo.id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`, signal).catch(() => null);
    const headers = ((original?.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers) ?? [];
    const value = (name: string) => headers.find((header) => header.name?.toLowerCase() === name)?.value;
    thread = { messageId: value("message-id"), references: value("references") };
  }
  const answer = await session.send("POST", `${API}/messages/send`, { raw: buildRaw(input, thread), ...(input.replyTo ? { threadId: input.replyTo.threadId } : {}) }, { signal });
  if (answer.status < 300) return { state: "done", result: { id: answer.body.id, threadId: answer.body.threadId } };
  const message = (answer.body.error as { message?: unknown } | undefined)?.message;
  const why = `Gmail answered ${answer.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`;
  // A refusal (4xx) means it was not sent. Anything else may or may not have gone out.
  return answer.status < 500 ? { state: "failed", error: why } : { state: "unclear", error: why };
}

/** Sends one accepted email (the module's `deliver`). An email is not safe to send again, so the queue marks an
 * unclear ending as unknown and never tries it twice. */
export async function deliverMail(world: World, outbound: Outbound, services: ModuleServices, signal?: AbortSignal): Promise<Delivered> {
  const google = services.google;
  const account = (outbound.payload as SendInput).account;
  if (!google?.accounts().find((candidate) => candidate.email === account)?.capabilities.includes("mailSend")) {
    return { state: "failed", error: SAY[localeOf(world.db)].noPermission };
  }
  let session: GoogleSession;
  try {
    session = await google.session(account);
  } catch (error) {
    // Nothing was sent yet, so this is a plain failure: say why; the user can accept a new proposal once it is fixed.
    return { state: "failed", error: (error as Error).message };
  }
  // From here on a thrown error means Gmail could not be reached, or refused the account, mid-send.
  return sendOne(session, outbound, signal);
}
