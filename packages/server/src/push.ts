/** Web Push to paired devices (docs/research/remote-access.md): the phones' notifications, as one outlet the home node
 * can reach by itself. This file knows how to send; it does not decide. Which notices go to the phone, and when, is
 * the attention table's to say (core attention.ts), and the home node's attention (attention.ts) does the handing: a
 * notice nobody took is pushed to every subscribed device, and from then on it was told on the phone, so no other
 * place shows it again later. A push service accepting it is not proof the user saw it: what still needs them stays
 * in the list, and the welcome says how many things wait when they come back.
 *
 * Lessons carried over from Robin: Apple refuses a VAPID subject that is not a valid URL; urgency `high`, or an idle
 * iPhone delays delivery; a 404/410 means the subscription is gone. Subscriptions live in <data>/push.json (0600),
 * one per device; the VAPID private key lives in the secret store.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { isSession, listDevices, userLocale, type DeviceScope, type Outlet, type World } from "@zirma/core";
import { getAssistant, translate, type Key } from "@zirma/ui/i18n";
import { inboxTarget, inboxUrl, outboundWhat, pageUrl, reminderPage, reminderText } from "@zirma/ui/notice";
import { plainText } from "@zirma/ui/markdown";
import type { Reach } from "./attention.ts";
import type { SecretStore } from "./secrets.ts";

export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path opened when the notification is tapped. */
  url: string;
  /** Notifications with one tag replace each other. */
  tag: string;
  /** The notice it is about; tapping it acknowledges the notice when `ack`. */
  notice?: string;
  ack?: boolean;
}
export interface PushResult { accepted: number; failed: number; expired: number }
interface VapidKeys { publicKey: string; privateKey: string }
type Subscriptions = Record<string, PushSubscriptionJson & { at: string }>;
/** Sends one payload; rejects with an error carrying `statusCode` when the push service refuses. */
export type PushSender = (subscription: PushSubscriptionJson, payload: string, keys: VapidKeys) => Promise<void>;

/** How long a push service keeps a message for a phone that is off. */
const PUSH_KEEP_MS = 12 * 3600_000;
const SECRET = "push:vapid";
export const PUSH_CLIENT = "push";
/** The phones' push notifications, as the attention table sees them: one outlet, which nobody is ever looking at. */
const PUSH_OUTLET: Outlet = { id: PUSH_CLIENT, kind: "push", attending: false };
/** Push services of the browsers people use. Anything else is refused, so a device cannot make the node call elsewhere. */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export class PushError extends Error {
  override name = "PushError";
}

/** Who sends these, as push services ask (the VAPID subject): `ZIRMA_PUSH_SUBJECT` when the person running the node
 * sets it (their own site, or `mailto:` an address of theirs), else the project's home page from the repository's
 * package.json, so a copy of Zirma under another name says its own. Nothing about the user goes here. */
export function subject(): string {
  const set = process.env.ZIRMA_PUSH_SUBJECT?.trim();
  if (set) return set;
  subject.homepage ??= projectHomepage();
  if (!subject.homepage) throw new PushError("Set ZIRMA_PUSH_SUBJECT (a https:// address or mailto:) to send notifications");
  return subject.homepage;
}
subject.homepage = undefined as string | null | undefined;

function projectHomepage(): string | null {
  try {
    const root = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { homepage?: unknown };
    return typeof root.homepage === "string" && /^https:\/\/\S+$/.test(root.homepage) ? root.homepage : null;
  } catch { return null; }
}

const defaultSender: PushSender = async (subscription, payload, keys) => {
  await webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: PUSH_KEEP_MS / 1000, urgency: "high", timeout: 15_000,
  });
};

export function checkSubscription(value: unknown): PushSubscriptionJson {
  const sub = value as Partial<PushSubscriptionJson> | null;
  const text = (item: unknown, max: number) => typeof item === "string" && item.length > 0 && item.length <= max && /^[A-Za-z0-9_=-]+$/.test(item);
  if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 1000 || !sub.keys || !text(sub.keys.p256dh, 200) || !text(sub.keys.auth, 100)) {
    throw new PushError("Not a push subscription");
  }
  let url: URL;
  try { url = new URL(sub.endpoint); } catch { throw new PushError("Not a push subscription"); }
  if (url.protocol !== "https:" || url.port || !PUSH_HOSTS.some((host) => host.test(url.hostname))) throw new PushError("Unknown push service");
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

/** What a notice says on a lock screen, in the user's language (the Mac's notifications say the same). */
export function noticeMessage(notice: { id: string; kind: string; payload: Record<string, unknown> }, locale: "zh" | "en"): PushMessage {
  const say = (key: string, vars?: Record<string, string>) => translate(locale, key as Key, vars);
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const goal = cut(String(notice.payload.goal ?? ""), 120);
  const conversation = typeof notice.payload.conversationId === "string" ? notice.payload.conversationId : null;
  const at = conversation ? `/#c=${encodeURIComponent(conversation)}` : "/";
  const inbox = inboxUrl(inboxTarget(notice));
  const base = { tag: `notice:${notice.id}`, notice: notice.id };
  if (notice.kind === "reminder") {
    // An event about to start, a todo about to be due, mail from someone the user named: opening it is seeing it.
    const { title, body } = reminderText(notice, locale);
    const page = reminderPage(notice);
    return { ...base, title: cut(title, 120), body: cut(body, 200), url: page ? pageUrl(page.page, page.item) : "/", ack: true };
  }
  if (notice.kind === "proposal") {
    return { ...base, title: say("mac.proposal.title"), body: cut(String(notice.payload.title ?? ""), 200), url: inbox, ack: false };
  }
  if (notice.kind === "run_request") {
    const title = say(notice.payload.kind === "permission" ? "mac.permission.title" : "mac.input.title");
    return { ...base, title, body: cut(String(notice.payload.question ?? goal), 200), url: inboxTarget(notice) ? inbox : at, ack: false };
  }
  if (notice.kind === "run_interrupted") return { ...base, title: say("mac.interrupted.title"), body: say("mac.interrupted.body", { goal }), url: inbox, ack: false };
  if (notice.kind === "outbound") {
    // A change outside Zirma (an event, an email) after the user's yes: it is told on the phone when it did not go
    // through, or may not have. That stays in the inbox until they have looked.
    const preview = cut(String(notice.payload.preview ?? ""), 120);
    const error = notice.payload.error ? cut(String(notice.payload.error), 100) : "";
    if (notice.payload.state === "failed") return { ...base, title: say("mac.outbound.failed"), body: error ? say("mac.outbound.failedBody", { preview, error }) : preview, url: inbox, ack: false };
    if (notice.payload.state === "unknown") return { ...base, title: say("mac.outbound.unknown"), body: say("mac.outbound.unknownBody", { preview }), url: inbox, ack: false };
    return { ...base, title: say("mac.outbound.done"), body: cut(outboundWhat(notice.payload, say), 120), url: inbox, ack: false };
  }
  const target = inboxTarget(notice);
  const destination = target ? { url: inbox, ack: false } : { url: at, ack: true };
  const status = notice.payload.status;
  const streak = Number(notice.payload.streak) || 0;
  if (status === "failed") return { ...base, title: streak ? say("mac.failed.streak", { n: String(streak) }) : say("mac.failed.title"), body: say("mac.goal", { goal }), ...destination };
  if (status === "cancelled") return { ...base, title: say("mac.cancelled.title"), body: say("mac.goal", { goal }), ...destination };
  // A reply is written in Markdown; a notification shows it as plain text.
  const said = typeof notice.payload.reply === "string" ? plainText(notice.payload.reply).trim() : "";
  const reply = said ? cut(said, 200) : say("mac.done.body", { goal });
  return { ...base, title: getAssistant(), body: reply, ...destination };
}

export interface PushOptions {
  dataDir: string;
  world: World;
  secrets: SecretStore;
  send?: PushSender;
  /** With the web lock on, notifications can arrive on a locked screen or sit in a delivery queue. */
  hidePreviews?: () => boolean;
  log?: (message: string) => void;
}

export class PushService {
  readonly #options: PushOptions;
  readonly #file: string;
  readonly #send: PushSender;
  #subscriptions: Subscriptions = {};
  #keys: Promise<VapidKeys> | null = null;

  constructor(options: PushOptions) {
    this.#options = options;
    this.#file = join(options.dataDir, "push.json");
    this.#send = options.send ?? defaultSender;
    try {
      const stored = JSON.parse(readFileSync(this.#file, "utf8")) as { subscriptions?: Subscriptions };
      this.#subscriptions = stored.subscriptions ?? {};
    } catch { /* first start */ }
  }

  /** Made once and kept; the private half never leaves the secret store and this process. */
  keys(): Promise<VapidKeys> {
    this.#keys ??= (async () => {
      const stored = await this.#options.secrets.get(SECRET);
      if (stored) return JSON.parse(stored) as VapidKeys;
      const fresh = webpush.generateVAPIDKeys();
      await this.#options.secrets.set(SECRET, JSON.stringify(fresh));
      return fresh;
    })();
    this.#keys.catch(() => { this.#keys = null; });
    return this.#keys;
  }

  async publicKey(): Promise<string> { return (await this.keys()).publicKey; }
  subscribed(deviceId: string): boolean { return deviceId in this.#subscriptions; }

  /** A device hands its subscription over when notifications are turned on and again every time it opens (ui
   * push-resume.ts), so one the browser replaced without saying takes the old one's place here. */
  subscribe(deviceId: string, subscription: unknown): void {
    const fresh = checkSubscription(subscription);
    const held = this.#subscriptions[deviceId];
    if (held && held.endpoint === fresh.endpoint && held.keys.p256dh === fresh.keys.p256dh && held.keys.auth === fresh.keys.auth) return;
    // What was sent to the old one since it changed was taken by the push service and never shown.
    if (held) this.#options.log?.(`push: ${deviceId} has a new subscription; the old one is replaced`);
    this.#subscriptions[deviceId] = { ...fresh, at: new Date().toISOString() };
    this.#save();
  }

  unsubscribe(deviceId: string): void {
    if (!(deviceId in this.#subscriptions)) return;
    delete this.#subscriptions[deviceId];
    this.#save();
  }

  /** To the given devices (default: every paired device that subscribed). Gone subscriptions are dropped. */
  async sendTo(message: PushMessage, deviceIds?: string[], requiredScope?: DeviceScope): Promise<PushResult> {
    const targets = Object.keys(this.#subscriptions).filter((id) => !deviceIds || deviceIds.includes(id));
    const result: PushResult = { accepted: 0, failed: 0, expired: 0 };
    if (!targets.length) return result;
    const keys = await this.keys();
    for (const id of targets) {
      // Check again at delivery time: other sends may have been waiting on the network.
      const device = listDevices(this.#options.world).find((candidate) => candidate.id === id);
      const subscription = this.#subscriptions[id];
      if (!device || !subscription || (requiredScope && !device.scopes.includes(requiredScope))) continue;
      const payload = this.#options.hidePreviews?.()
        ? { title: getAssistant(), body: translate(userLocale(this.#options.world), "push.privateBody"), url: "/#p=core.inbox", tag: "zirma-inbox" }
        : message;
      try {
        await this.#send(subscription, JSON.stringify(payload), keys);
        result.accepted++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // The device makes a new one when it next opens (ui push.ts resumePush); until then it gets nothing.
          this.unsubscribe(id);
          result.expired++;
          this.#options.log?.(`push to ${id}: the push service says the subscription is gone (${status}); dropped until the device opens again`);
        }
        else { result.failed++; this.#options.log?.(`push to ${id} failed: ${status ?? ""} ${(error as Error).message}`); }
      }
    }
    return result;
  }

  /** The phones as the home node's attention reaches them: one outlet, there only while a device has notifications
   * on. Sending is to every subscribed device; it counts as gone out when at least one push service took it. */
  reaches(): Reach[] {
    if (!Object.keys(this.#subscriptions).length) return [];
    return [{
      outlet: PUSH_OUTLET,
      send: async (notice) => {
        const { world } = this.#options;
        const conversation = notice.payload.conversationId;
        const dev = typeof conversation === "string" && isSession(world, conversation);
        const result = await this.sendTo(noticeMessage(notice, userLocale(world)), undefined, dev ? "dev" : undefined);
        // One line per notice, so "nothing arrived" can be told apart from "nothing was sent".
        this.#options.log?.(`push: notice ${notice.id} (${notice.kind}) to ${result.accepted} device(s)${result.failed ? `, ${result.failed} failed` : ""}${result.expired ? `, ${result.expired} gone` : ""}`);
        return result.accepted > 0;
      },
    }];
  }

  #save(): void {
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ subscriptions: this.#subscriptions }, null, 2), { mode: 0o600 });
    renameSync(temp, this.#file);
  }
}
