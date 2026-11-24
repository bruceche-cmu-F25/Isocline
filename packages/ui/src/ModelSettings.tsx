/** Settings → Models: who Alfred thinks with (docs/design/settings-and-connections.md §3.2).
 *
 * Signing in runs on the home node through Pi. This page starts it and follows it: it opens the provider's page,
 * shows a device code, or asks for a key, as Pi's flow asks. The default model and thinking level are the user's
 * settings, used by any conversation that has not chosen its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineModel, ModelAccountsResponse, ModelAuthMethod, ModelProvider, ModelSignIn, StateResponse, ThinkingLevel } from "@alfred/protocol";
import { api, request as call } from "./api.ts";
import { Logo, providerMark } from "./brand/Logo.tsx";
import { t } from "./i18n/index.ts";
import { UsageMeter, useSubscriptionUsage } from "./SubscriptionUsage.tsx";
import { Select } from "./shell/Select.tsx";

/** API-key providers shown before "show all": the ones most people have. Configured ones always show. */
const COMMON = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "groq", "moonshotai", "kimi-coding"];
const SUBSCRIPTION_PRIORITY = new Map([["openai", 0], ["openai-codex", 1]]);
/** In the first run, how many of each kind show before "more ways": a newcomer picks from a few, not forty. */
const SETUP_SUBSCRIPTIONS = 3, SETUP_KEYS = 5;
const THINKING: Array<ThinkingLevel | null> = [null, "off", "low", "medium", "high", "xhigh"];
const PI_DISMISSED = "alfred.models.piDismissed";

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const dismissedPi = () => { try { return localStorage.getItem(PI_DISMISSED) === "1"; } catch { return false; } };

type Said = { kind: "done" | "signedOut"; name: string } | { kind: "imported"; n: number };

/** `setup`: inside the first run (shell/FirstRun.tsx), only the ways to connect; `onConfigured` hears how many are. */
export function ModelSettings({ setup, onConfigured }: { setup?: boolean; onConfigured?(n: number): void } = {}) {
  const [data, setData] = useState<ModelAccountsResponse | null>(null);
  const [models, setModels] = useState<EngineModel[]>([]);
  const [preferred, setPreferred] = useState<{ model: string | null; thinking: ThinkingLevel | null }>({ model: null, thinking: null });
  const [flow, setFlow] = useState<ModelSignIn | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [piHidden, setPiHidden] = useState(dismissedPi);
  const [copied, setCopied] = useState(false);
  const { usage, checking, loadUsage } = useSubscriptionUsage();
  const opened = useRef(new Set<string>());

  const load = useCallback(() => {
    call<ModelAccountsResponse>("/api/connections/models").then(setData, (reason: Error) => setError(reason.message));
    api.models().then((response) => setModels(response.models), () => setModels([]));
    loadUsage();
  }, [loadUsage]);
  useEffect(() => {
    load();
    call<StateResponse>("/api/state?modules=0").then((state) => setPreferred({ model: state.settings.model ?? null, thinking: state.settings.thinking ?? null }), () => {});
  }, [load]);

  // Follow a sign-in while it runs; open the provider's page the first time it appears (the Mac app sends it to the
  // system browser; a plain browser may block it, so the card has a link too).
  useEffect(() => {
    if (!flow || flow.status !== "running") return;
    const timer = setInterval(() => {
      call<ModelSignIn>(`/api/connections/models/flows/${flow.id}`).then((next) => {
        setFlow(next);
        if (next.status !== "running") {
          const name = data?.providers.find((provider) => provider.id === next.provider)?.name ?? next.provider;
          if (next.status === "done") setSaid({ kind: "done", name });
          if (next.status === "failed") setError(t("models.failed", { error: next.error ?? "" }));
          load();
        }
      }, () => {});
    }, 800);
    return () => clearInterval(timer);
  }, [flow, data, load]);
  useEffect(() => {
    for (const step of flow?.steps ?? []) {
      const url = step.kind === "open_url" ? step.url : step.kind === "device_code" ? step.url : null;
      if (!url || opened.current.has(url)) continue;
      opened.current.add(url);
      if (step.kind === "open_url") { const page = window.open(url, "_blank"); if (page) page.opener = null; }
    }
  }, [flow]);

  const configured = data ? data.providers.filter((provider) => provider.status.configured).length : null;
  useEffect(() => { if (configured !== null) onConfigured?.(configured); }, [configured]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (provider: ModelProvider, method: ModelAuthMethod) => {
    setError(null);
    setSaid(null);
    setAnswer("");
    setCopied(false);
    call<ModelSignIn>(`/api/connections/models/${provider.id}/login`, { method }).then(setFlow, (reason: Error) => setError(reason.message));
  };
  const cancel = () => {
    if (flow) call<ModelSignIn>(`/api/connections/models/flows/${flow.id}/cancel`, {}).then(setFlow, () => setFlow(null));
  };
  const reply = (value: string) => {
    if (!flow?.prompt) return;
    call<ModelSignIn>(`/api/connections/models/flows/${flow.id}/answer`, { promptId: flow.prompt.id, value }).then((next) => { setFlow(next); setAnswer(""); }, (reason: Error) => setError(reason.message));
  };
  const logout = (provider: ModelProvider) => {
    setError(null);
    call<ModelAccountsResponse>(`/api/connections/models/${provider.id}/logout`, {}).then((next) => {
      setData(next);
      loadUsage();
      setSaid({ kind: "signedOut", name: provider.name });
      api.models().then((response) => setModels(response.models), () => {});
    }, (reason: Error) => setError(reason.message));
  };
  const importPi = () => {
    if (!data) return;
    call<ModelAccountsResponse>("/api/connections/models/import", { providers: data.piKeys.map((item) => item.id) }).then((next) => {
      setSaid({ kind: "imported", n: data.piKeys.length - next.piKeys.length });
      setData(next);
      api.models().then((response) => setModels(response.models), () => {});
    }, (reason: Error) => setError(reason.message));
  };
  const skipPi = () => {
    setPiHidden(true);
    try { localStorage.setItem(PI_DISMISSED, "1"); } catch { /* this view only */ }
  };
  const choose = (patch: { model?: string | null; thinking?: ThinkingLevel | null }) => {
    setPreferred((current) => ({ ...current, ...patch }));
    api.settings(patch).catch((reason: Error) => setError(reason.message));
  };

  const piSub = new Set(data?.piSubscriptions.map((item) => item.id) ?? []);
  const statusOf = (provider: ModelProvider, kind: "subscription" | "key") => {
    const { status } = provider;
    // "Signed in in Pi" is about the subscription, so only its row says so.
    if (!status.configured) return kind === "subscription" && piSub.has(provider.id) ? <span className="set-status need">{t("models.status.pi")}</span> : null;
    if (status.source === "environment") return <span className="set-status on">{t("models.status.env")}</span>;
    return <span className="set-status on">{t(status.method === "oauth" ? "models.status.oauth" : "models.status.key")}</span>;
  };

  const flowCard = (provider: ModelProvider) => {
    if (!flow || flow.provider !== provider.id || flow.status !== "running") return null;
    const last = flow.steps.at(-1);
    const prompt = flow.prompt;
    return (
      <div className="set-flow">
        {flow.steps.map((step, index) => {
          if (step.kind === "open_url") {
            return (
              <div key={index} className="set-actions">
                <a className="set-button" href={step.url} target="_blank" rel="noopener noreferrer">{t("models.flow.open")}</a>
                {step.instructions && <span className="quiet small">{step.instructions}</span>}
              </div>
            );
          }
          if (step.kind === "device_code") {
            return (
              <div key={index} className="model-device">
                <span className="small">{t("models.flow.device")}</span>
                <span className="model-code">{step.code}</span>
                <div className="set-actions">
                  <a className="set-button" href={step.url} target="_blank" rel="noopener noreferrer">{t("models.flow.openDevice", { host: host(step.url) })}</a>
                  <button type="button" className="set-button ghost" onClick={() => { void navigator.clipboard?.writeText(step.code).then(() => setCopied(true), () => {}); }}>
                    {copied ? t("models.flow.copied") : t("models.flow.copy")}
                  </button>
                </div>
              </div>
            );
          }
          if (step.kind === "info") {
            return (
              <p key={index} className="small">{step.message}{step.links?.map((link) => (
                <a key={link.url} className="dev-link" href={link.url} target="_blank" rel="noopener noreferrer"> {link.label ?? host(link.url)}</a>
              ))}</p>
            );
          }
          return null;
        })}
        {prompt ? (
          prompt.type === "select" ? (
            <div className="set-actions">
              <span className="small">{prompt.message}</span>
              {prompt.options?.map((option) => (
                <button type="button" key={option.id} className="set-button ghost" title={option.description} onClick={() => reply(option.id)}>{option.label}</button>
              ))}
            </div>
          ) : (
            <form className="model-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) reply(answer.trim()); }}>
              <label className="small" htmlFor={`answer-${flow.id}`}>{prompt.message}</label>
              <div className="set-actions">
                <input id={`answer-${flow.id}`} className="model-input" type={prompt.type === "secret" ? "password" : "text"} value={answer}
                  placeholder={prompt.placeholder} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setAnswer(event.target.value)} />
                <button type="submit" className="set-button" disabled={!answer.trim()}>{t(prompt.type === "secret" ? "models.flow.save" : "models.flow.submit")}</button>
              </div>
            </form>
          )
        ) : (
          <div className="set-flow-head small"><span className="pulse" />{last?.kind === "progress" ? last.message : t("models.flow.waiting")}</div>
        )}
        <div className="set-actions"><button type="button" className="set-button ghost" onClick={cancel}>{t("common.cancel")}</button></div>
      </div>
    );
  };

  const busy = flow?.status === "running";
  const row = (provider: ModelProvider, kind: "subscription" | "key") => {
    const ours = provider.status.configured && provider.status.source === "alfred";
    const oauthOn = ours && provider.status.method === "oauth";
    const keyOn = ours && provider.status.method === "api_key";
    const item = !setup && kind === "subscription" && provider.status.method === "oauth" && usage.find((item) => item.provider === provider.id);
    const mark = providerMark(provider.id, kind);
    return (
      <div className="set-rows-item" key={provider.id}>
        <div className="set-row has-logo">
          <span className="set-logo" data-k="gray">{mark ? <Logo name={mark} /> : provider.name.slice(0, 1).toUpperCase()}</span>
          <span className="set-name">{provider.name}</span>
          <span className="set-note">{kind === "subscription" ? provider.oauth?.label : t("models.provider.models", { n: provider.models })}</span>
          <span className="set-end">
            {statusOf(provider, kind)}
            {kind === "subscription" ? (
              oauthOn
                ? <button type="button" className="set-button ghost" onClick={() => logout(provider)}>{t("models.signOut")}</button>
                : <button type="button" className="set-button" disabled={busy} onClick={() => start(provider, "oauth")}>{t("models.signIn")}</button>
            ) : (
              <>
                {provider.oauth && !provider.oauth.subscription && !ours && (
                  <button type="button" className="set-button ghost" disabled={busy} onClick={() => start(provider, "oauth")}>{t("models.signIn")}</button>
                )}
                <button type="button" className={keyOn ? "set-button ghost" : "set-button"} disabled={busy} onClick={() => start(provider, "api_key")}>
                  {t(keyOn ? "models.changeKey" : "models.addKey")}
                </button>
                {ours && <button type="button" className="set-button ghost" onClick={() => logout(provider)}>{t(oauthOn ? "models.signOut" : "models.removeKey")}</button>}
              </>
            )}
          </span>
        </div>
        {item && <UsageMeter item={item} refresh={
          <button type="button" className="usage-refresh" disabled={checking} onClick={() => loadUsage(true)}>
            {t(checking ? "models.usage.checking" : "models.usage.refresh")}
          </button>
        } />}
        {flowCard(provider)}
      </div>
    );
  };

  const providers = data?.providers ?? [];
  const subscriptions = providers.filter((provider) => provider.oauth?.subscription)
    .sort((a, b) => (SUBSCRIPTION_PRIORITY.get(a.id) ?? 2) - (SUBSCRIPTION_PRIORITY.get(b.id) ?? 2));
  const keyed = providers.filter((provider) => provider.apiKey).sort((a, b) => {
    const rank = (provider: ModelProvider) => (COMMON.includes(provider.id) ? COMMON.indexOf(provider.id) : COMMON.length);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const mine = (provider: ModelProvider) => provider.status.configured || flow?.provider === provider.id;
  const shownKeys = showAll ? keyed : keyed.filter((provider, index) => (setup ? index < SETUP_KEYS : COMMON.includes(provider.id)) || mine(provider));
  const shownSubscriptions = showAll || !setup ? subscriptions : subscriptions.filter((provider, index) => index < SETUP_SUBSCRIPTIONS || mine(provider));
  const hidden = subscriptions.length - shownSubscriptions.length + keyed.length - shownKeys.length;
  const modelOptions = models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.name} · ${providers.find((provider) => provider.id === model.provider)?.name ?? model.provider}` }));
  const piSubNames = data?.piSubscriptions.map((item) => item.name) ?? [];

  return (
    <section className="set-section">
      {!setup && <h2>{t("settings.models")}</h2>}
      {!setup && <p className="quiet">{t("models.sub")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}
      {said && (
        <p className="set-message" role="status">
          {said.kind === "imported" ? t("models.imported", { n: said.n }) : t(said.kind === "done" ? "models.done" : "models.signedOut", { name: said.name })}
        </p>
      )}

      {data && data.piKeys.length > 0 && !piHidden && (
        <div className="set-flow">
          <span>{t("models.pi.keys", { names: data.piKeys.map((item) => item.name).join(t("list.sep")) })}</span>
          <div className="set-actions">
            <button type="button" className="set-button" onClick={importPi}>{t("models.pi.import")}</button>
            <button type="button" className="set-button ghost" onClick={skipPi}>{t("models.pi.skip")}</button>
          </div>
        </div>
      )}

      {!setup && <div className="set-rows">
        <div className="set-row">
          <span className="set-name">{t("models.default")}</span>
          <span className="set-note">{t("models.default.note")}</span>
          <span className="set-end">
            {modelOptions.length ? (
              <Select className="model-select field-select" label={t("models.default")} value={preferred.model ?? ""} onChange={(next) => choose({ model: next || null })}
                options={[
                  { value: "", label: t("models.default.engine") },
                  ...(preferred.model && !modelOptions.some((option) => option.value === preferred.model) ? [{ value: preferred.model, label: preferred.model }] : []),
                  ...modelOptions.map((option) => ({ value: option.value, label: option.label })),
                ]} />
            ) : <span className="quiet small">{t("models.default.none")}</span>}
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("models.thinking")}</span>
          <span className="set-note">{t("models.thinking.note")}</span>
          <span className="set-end">
            <Select className="model-select field-select" label={t("models.thinking")} value={preferred.thinking ?? ""} onChange={(next) => choose({ thinking: (next || null) as ThinkingLevel | null })}
              options={THINKING.map((level) => ({ value: level ?? "", label: t(level ? `models.thinking.${level}` as Parameters<typeof t>[0] : "models.thinking.default") }))} />
          </span>
        </div>
      </div>}

      <h3 className="set-sub">{t("models.subs")}</h3>
      <p className="quiet small">{t("models.subs.note")}</p>
      {piSubNames.length > 0 && <p className="quiet small">{t("models.pi.subs", { names: piSubNames.join(t("list.sep")), n: piSubNames.length })}</p>}
      <div className="set-rows">{shownSubscriptions.map((provider) => row(provider, "subscription"))}</div>

      <h3 className="set-sub">{t("models.keys")}</h3>
      <p className="quiet small">{t("models.keys.note")}</p>
      <div className="set-rows">{shownKeys.map((provider) => row(provider, "key"))}</div>
      {hidden > 0 || showAll ? (
        <div className="set-actions">
          <button type="button" className="set-button ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? t("models.keys.fewer") : setup ? t("models.more", { n: hidden }) : t("models.keys.all", { n: keyed.length })}
          </button>
        </div>
      ) : null}
    </section>
  );
}
