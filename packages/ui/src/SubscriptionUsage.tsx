/** Subscription quota windows, shared by the home node's model settings and the paired-device view. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelUsage, ModelUsageResponse, ModelUsageWindow } from "@zirma/protocol";
import { request } from "./api.ts";
import { Logo, providerMark } from "./brand/Logo.tsx";
import { t } from "./i18n/index.ts";

export function useSubscriptionUsage() {
  const [usage, setUsage] = useState<ModelUsage[]>([]);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const loadUsage = useCallback((fresh = false) => {
    const id = ++latest.current;
    setChecking(true);
    setFailed(false);
    request<ModelUsageResponse>(`/api/connections/models/usage${fresh ? "?fresh=1" : ""}`)
      .then(({ usage }) => { if (id === latest.current) setUsage(usage); },
        () => { if (id === latest.current) setFailed(true); })
      .finally(() => { if (id === latest.current) setChecking(false); });
  }, []);
  useEffect(() => () => { ++latest.current; }, []);
  return { usage, checking, failed, loadUsage };
}

/** "5 hours", "Week", "Opus · Week": what a usage window covers. */
function windowName(window: ModelUsageWindow): string {
  const { minutes } = window;
  const length = minutes === undefined ? t("models.usage.plan")
    : minutes === 10_080 ? t("models.usage.week")
    : minutes % 1440 === 0 ? t("models.usage.days", { n: minutes / 1440 })
    : minutes % 60 === 0 ? t("models.usage.hours", { n: minutes / 60 })
    : t("models.usage.minutes", { n: minutes });
  return window.scope ? `${window.scope} · ${length}` : length;
}
/** "in 3 h", "4 天后": until a window resets. */
function untilReset(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  const span = minutes < 60 ? t("models.usage.minutes", { n: minutes })
    : minutes < 48 * 60 ? t("models.usage.hours", { n: Math.round(minutes / 60) })
    : t("models.usage.days", { n: Math.round(minutes / 1440) });
  return t("models.usage.resets", { span });
}

export function UsageMeter({ item, refresh }: { item: ModelUsage; refresh?: ReactNode }) {
  const now = Date.now();
  if (item.status === "failed") {
    return <div className="usage"><p className="usage-note small">{t(`models.usage.${item.error ?? "unreachable"}`)}{refresh}</p></div>;
  }
  return (
    <div className="usage">
      {item.windows.map((window) => {
        const level = window.used >= 90 ? "high" : window.used >= 70 ? "mid" : "low";
        return (
          <div className="usage-row" key={window.id}>
            <span className="usage-name">{windowName(window)}</span>
            <span className="usage-bar" data-level={level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.used)} aria-label={windowName(window)}>
              <span style={{ width: `${window.used}%` }} />
            </span>
            <span className="usage-pct" data-level={level}>{Math.round(window.used)}%</span>
            <span className="usage-reset">{window.resetsAt && window.resetsAt > now ? untilReset(window.resetsAt, now) : ""}</span>
          </div>
        );
      })}
      {(item.plan || refresh) && <p className="usage-note small">{item.plan && t("models.usage.planName", { plan: item.plan })}{refresh}</p>}
    </div>
  );
}

const providerNames: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "ChatGPT (Codex)",
  "kimi-coding": "Kimi For Coding",
};

export function SubscriptionUsage() {
  const { usage, checking, failed, loadUsage } = useSubscriptionUsage();
  useEffect(() => { loadUsage(); }, [loadUsage]);
  return (
    <section className="set-section">
      <header className="usage-heading">
        <h2>{t("models.usage.title")}</h2>
        <button type="button" className="set-button ghost" disabled={checking} onClick={() => loadUsage(true)}>
          {t(checking ? "models.usage.checking" : "models.usage.refresh")}
        </button>
      </header>
      {failed && <p className="problem small" role="alert">{t("models.usage.unreachable")}</p>}
      {!checking && !failed && !usage.length && <p className="quiet" role="status">{t("models.usage.empty")}</p>}
      {usage.length > 0 && <div className="set-rows">
        {usage.map((item) => {
          const name = providerNames[item.provider] ?? item.provider;
          const mark = providerMark(item.provider, "subscription");
          return (
            <div className="set-rows-item" key={item.provider}>
              <div className="set-row has-logo">
                <span className="set-logo" data-k="gray">{mark ? <Logo name={mark} /> : name.slice(0, 1).toUpperCase()}</span>
                <span className="set-name">{name}</span>
              </div>
              <UsageMeter item={item} />
            </div>
          );
        })}
      </div>}
    </section>
  );
}
