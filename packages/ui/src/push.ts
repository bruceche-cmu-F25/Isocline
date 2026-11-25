/** Turning push notifications on and off on this device (a phone paired through Tailscale). The service worker
 * (public/sw.js) only shows them. On an iPhone, Web Push works only in the app added to the home screen.
 */
import { api } from "./api.ts";
import { resumeStep } from "./push-resume.ts";

export type PushSupport = "ok" | "homeScreen" | "unsupported" | "denied";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos() && !standalone()) return "homeScreen";
  if (!capable || !window.isSecureContext) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** Set while the user wants notifications on this device, so a subscription lost on the way is made again. */
const WANTED = "zirma.push";
const wanted = (on: boolean) => { try { if (on) localStorage.setItem(WANTED, "on"); else localStorage.removeItem(WANTED); } catch { /* private mode */ } };
const isWanted = () => { try { return localStorage.getItem(WANTED) === "on"; } catch { return false; } };

const keyText = (key: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Subscribes this browser for the home node's key and hands the subscription over. Permission must be granted. */
async function subscribe(publicKey: string, worker: ServiceWorkerRegistration): Promise<void> {
  let subscription = await worker.pushManager.getSubscription();
  // A subscription made for another key (a home node that started over) cannot receive from this one.
  const key = subscription?.options.applicationServerKey;
  if (subscription && key && keyText(key) !== publicKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(subscription.toJSON());
}

/** Call straight from a tap: iOS shows the permission prompt only inside the user's gesture. */
export async function enablePush(): Promise<void> {
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error("denied");
  const [{ publicKey }, worker] = await Promise.all([api.pushInfo(), registration()]);
  await subscribe(publicKey, worker);
  wanted(true);
}

/** On start, where notifications were turned on: the browser's current subscription goes to the home node again
 * (push-resume.ts says why every time), made anew first if it is gone or for another key (a push service said it was
 * gone, iOS dropped it, the node got a new key). Without asking, as the permission is still granted. Nothing happens
 * on a device that never turned them on. */
export async function resumePush(): Promise<void> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return;
  const worker = await navigator.serviceWorker.getRegistration("/");
  const existing = await worker?.pushManager.getSubscription();
  // Turned on before this was remembered: the browser still holds the subscription.
  if (!isWanted() && !existing) return;
  const { publicKey } = await api.pushInfo();
  const key = existing?.options.applicationServerKey;
  if (existing && resumeStep(key ? keyText(key) : null, publicKey) === "resend") await api.pushSubscribe(existing.toJSON());
  else await subscribe(publicKey, worker ?? await registration());
  wanted(true);
}

export async function disablePush(): Promise<void> {
  wanted(false);
  try {
    const worker = await navigator.serviceWorker.getRegistration("/");
    await (await worker?.pushManager.getSubscription())?.unsubscribe();
  } finally {
    await api.pushUnsubscribe();
  }
}
