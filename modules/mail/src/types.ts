/** What devices get from the mail module (StateResponse.modules.mail). Bodies are not here: a device reads one
 * message at a time through the `mail.message` query. */
export type MailCategory = "primary" | "promotions" | "social" | "updates" | "forums";

export interface MailMessage {
  id: string;
  account: string;
  threadId: string;
  /** The sender's name, or their address when there is no name. */
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  important: boolean;
  /** The latest star reported by Gmail. */
  starred: boolean;
  /** Saved only in Isocline when Gmail star sync is off. */
  localSaved?: boolean;
  /** Within Isocline's current inbox window. Older snapshots contained only inbox mail. */
  inInbox?: boolean;
  category: MailCategory;
  /** The message in Gmail. */
  link: string;
}

export interface MailDetail extends MailMessage {
  to: string;
  /** Plain text: text/plain when there is one, else HTML stripped of markup. Attachments are never read. */
  body: string;
  attachments: string[];
  /** Some of the body could not be read (encrypted, or only an attachment). */
  bodyIncomplete: boolean;
}

export interface MailSource {
  account: string;
  syncedAt: string | null;
  error: string | null;
  reconnect: boolean;
  /** Older snapshots include only accounts with inbox access. */
  canRead?: boolean;
  /** The user let Isocline send from this account (Settings: Gmail：替你发). */
  canSend: boolean;
  /** This account allows Isocline to change Gmail stars and archive messages. */
  canModify?: boolean;
}

/** An email to send: what the `mail.send` operation takes, and so what a draft (a proposal's step) holds. */
export interface SendInput {
  account: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** The message this answers: its thread, so Gmail keeps them together. */
  replyTo?: { id: string; threadId: string };
}

/** An email the user sent from Isocline (their own, or Isocline's draft they accepted), and how sending it went. */
export interface MailSent {
  id: string;
  account: string;
  /** The message it answers, when it is a reply. */
  replyTo: string | null;
  to: string[];
  subject: string;
  /** The text, cut at 1500 characters. */
  body: string;
  /** `unknown`: Gmail gave no clear answer, and it is never sent again. */
  state: "queued" | "sending" | "done" | "failed" | "unknown";
  error: string | null;
  at: string;
}

export interface MailSnapshot {
  /** Recent inbox mail and retained favorites/important messages, newest first. */
  messages: MailMessage[];
  sources: MailSource[];
  /** What was sent from here in the last two weeks, oldest first (at most 30). */
  sent: MailSent[];
}

/** The operations a device may ask of this module (POST /api/ops/<name>), as the module defines them. A test on the
 * home node checks this list against the module's own, so a device cannot name one that is not there. */
export const MAIL_OPS = ["mail.send", "mail.mark_read", "mail.favorite", "mail.archive"] as const;
export type MailOp = (typeof MAIL_OPS)[number];
