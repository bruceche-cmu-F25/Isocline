/** How much of a subscription's plan is used: the provider's own limit windows (5 hours, a week…), read with the
 * credential Zirma already keeps. Read-only; the token stays in the request and is never returned or logged.
 *
 * These endpoints are not a published API and may change, so parsing is defensive and a failure stays with its
 * provider. Formats follow pi-web's lib/provider-usage.ts (https://github.com/agegr/pi-web, MIT, © 2026 agegr), itself after
 * @narumitw/pi-usage (MIT, © 2026 narumiruna); see THIRD-PARTY-NOTICES.md.
 */
import type { ModelUsage, ModelUsageWindow } from "@zirma/protocol";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

/** The subscriptions whose usage can be read. */
export const USAGE_PROVIDERS = ["anthropic", "openai-codex", "kimi-coding"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
export const hasUsage = (providerId: string): providerId is UsageProvider => (USAGE_PROVIDERS as readonly string[]).includes(providerId);

const TIMEOUT_MS = 10_000;

/** Asks the provider; `token` is the subscription's access token. */
export async function readUsage(providerId: UsageProvider, token: string, fetchFn: Fetch = fetch, now = Date.now()): Promise<ModelUsage> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let url: string;
  if (providerId === "anthropic") {
    url = "https://api.anthropic.com/api/oauth/usage";
    Object.assign(headers, { "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" });
  } else if (providerId === "openai-codex") {
    url = "https://chatgpt.com/backend-api/wham/usage";
    const account = codexAccount(token);
    if (account) headers["chatgpt-account-id"] = account;
  } else {
    url = "https://api.kimi.com/coding/v1/usages";
  }
  try {
    const response = await fetchFn(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return failed(providerId, now, response.status === 401 || response.status === 403 ? "rejected" : "unreachable");
    const body = await response.text();
    if (body.length > 65_536) return failed(providerId, now, "unreadable");
    const data = record(JSON.parse(body));
    if (!data) return failed(providerId, now, "unreadable");
    const parsed = providerId === "anthropic" ? parseAnthropic(data) : providerId === "openai-codex" ? parseCodex(data, now) : parseKimi(data);
    if (!parsed.windows.length) return failed(providerId, now, "unreadable");
    return { provider: providerId, status: "ready", checkedAt: now, ...parsed };
  } catch {
    return failed(providerId, now, "unreachable");
  }
}

const failed = (provider: string, checkedAt: number, error: NonNullable<ModelUsage["error"]>): ModelUsage => ({ provider, status: "failed", checkedAt, windows: [], error });

type Parsed = Pick<ModelUsage, "windows" | "plan">;

const ANTHROPIC: Array<[key: string, minutes: number, scope?: string]> = [
  ["five_hour", 300],
  ["seven_day", 10_080],
  ["seven_day_opus", 10_080, "Opus"],
  ["seven_day_sonnet", 10_080, "Sonnet"],
  ["seven_day_oauth_apps", 10_080, "OAuth apps"],
  ["seven_day_cowork", 10_080, "Cowork"],
];

export function parseAnthropic(data: Json): Parsed {
  const windows = ANTHROPIC.flatMap(([key, minutes, scope]): ModelUsageWindow[] => {
    const window = record(data[key]);
    const used = percent(window?.utilization);
    if (used === undefined) return [];
    const resetsAt = time(window?.resets_at);
    return [{ id: key, minutes, ...(scope ? { scope } : {}), used, ...(resetsAt !== undefined ? { resetsAt } : {}) }];
  });
  return { windows };
}

export function parseCodex(data: Json, now = Date.now()): Parsed {
  const windows: ModelUsageWindow[] = [];
  const add = (limits: Json | undefined, prefix: string, scope?: string) => {
    for (const position of ["primary", "secondary"] as const) {
      const window = record(limits?.[`${position}_window`]);
      const used = percent(window?.used_percent);
      if (used === undefined) continue;
      const seconds = number(window?.limit_window_seconds);
      const after = number(window?.reset_after_seconds);
      const resetsAt = time(window?.reset_at) ?? (after !== undefined ? now + after * 1000 : undefined);
      windows.push({
        id: `${prefix}${position}`, used,
        ...(seconds && seconds > 0 ? { minutes: Math.ceil(seconds / 60) } : {}),
        ...(scope ? { scope } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
  };
  add(record(data.rate_limit), "");
  add(record(data.code_review_rate_limit), "review:", "Code review");
  const plan = text(data.plan_type);
  return { windows, ...(plan ? { plan } : {}) };
}

const KIMI_UNIT: Record<string, number> = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86_400 };

export function parseKimi(data: Json): Parsed {
  const windows: ModelUsageWindow[] = [];
  const add = (id: string, detail: Json | undefined, seconds?: number) => {
    const limit = number(detail?.limit);
    const used = number(detail?.used) ?? (limit !== undefined && number(detail?.remaining) !== undefined ? limit - number(detail?.remaining)! : undefined);
    if (!limit || limit <= 0 || used === undefined) return;
    const resetsAt = time(detail?.resetTime);
    windows.push({ id, used: clamp(used / limit * 100), ...(seconds ? { minutes: Math.ceil(seconds / 60) } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) });
  };
  (Array.isArray(data.limits) ? data.limits : []).forEach((item, index) => {
    const value = record(item);
    const window = record(value?.window);
    const duration = number(window?.duration);
    const unit = KIMI_UNIT[text(window?.timeUnit) ?? ""];
    add(`limit-${index}`, record(value?.detail), duration && unit ? duration * unit : undefined);
  });
  // The plan's overall quota has no fixed window.
  add("plan", record(data.usage));
  const level = text(record(record(data.user)?.membership)?.level);
  return { windows, ...(level ? { plan: level.replace(/^LEVEL_/u, "").toLowerCase() } : {}) };
}

/** ChatGPT's account id, from the access token's claims; Codex sends it with every request. */
function codexAccount(token: string): string | undefined {
  try {
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    return text(record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}
function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 60);
  return cleaned || undefined;
}
const clamp = (value: number) => Math.min(100, Math.max(0, value));
function percent(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed === undefined ? undefined : clamp(parsed);
}
/** Epoch seconds, epoch ms, or an ISO date, as epoch ms. */
function time(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
