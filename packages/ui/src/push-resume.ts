/** What a device that turned notifications on does about its push subscription when Zirma opens (push.ts
 * resumePush). Kept apart so it can be tested without a browser.
 *
 * The browser's subscription is handed over again on every start, even when the home node says it has one: the node
 * knows only that it holds *a* subscription for this device, not that it is the one the browser holds now. iOS can
 * replace a subscription without telling the page; the push service then accepts what the node sends to the old one
 * and nothing shows. Handing it over again costs one small request and puts the current one in place.
 */
export type ResumeStep =
  /** The browser holds a subscription for the node's key: give it to the node again. */
  | "resend"
  /** None, or one for another key or for a key it does not say (a node that started over): subscribe, hand that over. */
  | "renew";

/** `existingKey`: the key the browser's subscription was made for; null when there is none or it does not say. */
export function resumeStep(existingKey: string | null, publicKey: string): ResumeStep {
  return existingKey !== null && existingKey === publicKey ? "resend" : "renew";
}
