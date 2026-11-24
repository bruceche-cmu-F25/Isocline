/** Settings → Connectors: the MCP servers Isocline's runs can use (docs/design/settings-and-connections.md §3.3).
 *
 * On top, the user's own: each with what it is, whether it is reached, how many tools it has, and how many of those
 * run without asking (the ones its server marks read-only; every other call still asks first). Below, the catalog:
 * one click adds a service and, where it takes a sign-in, opens it in the system browser. Last, a form for a server
 * of the user's own, by address or by command. Tokens and secrets go to the home node's keychain, never to a file.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { McpCatalogItem, McpConnector, McpConnectorsResponse, McpSignIn } from "@isocline/protocol";
import { request as call } from "./api.ts";
import { connectorMark, Logo } from "./brand/Logo.tsx";
import { getLocale, t } from "./i18n/index.ts";

const at = (name: string, action: string) => `/api/connections/mcp/${encodeURIComponent(name)}/${action}`;
const open = (url: string) => { const page = window.open(url, "_blank"); if (page) page.opener = null; };

/** The service's own mark, where Isocline has one; its first letter stands in otherwise. */
const mark = (server: { catalog?: string; name?: string; where?: string }) => { const name = connectorMark(server); return name ? <Logo name={name} /> : null; };

type Own = { kind: "url" | "command"; name: string; where: string; secretName: string; secret: string };
const EMPTY: Own = { kind: "url", name: "", where: "", secretName: "", secret: "" };

export function Connectors() {
  const [data, setData] = useState<McpConnectorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<Extract<McpSignIn, { status: "waiting" }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The catalog entry whose token is being pasted. */
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [own, setOwn] = useState<Own>(EMPTY);
  const [removing, setRemoving] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => call<McpConnectorsResponse>("/api/connections/mcp").then((next) => { if (alive.current) setData(next); }, (reason: Error) => setError(reason.message)), []);
  useEffect(() => { void load(); }, [load]);
  // A server not looked at yet is looked at in the background: ask again until none is left.
  const checking = data?.servers.some((server) => server.state === "checking") ?? false;
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(() => void load(), 1200);
    return () => clearTimeout(timer);
  }, [checking, data, load]);
  // Watch a sign-in until the browser comes back (or the user gives up).
  useEffect(() => {
    if (!flow) return;
    const timer = setInterval(() => {
      call<McpSignIn>(`/api/connections/mcp/flows/${flow.id}`).then((next) => {
        if (!alive.current || next.status === "waiting") return;
        setFlow(null);
        if (next.status === "failed") setError(t("mcp.signInFailed", { error: next.error }));
        void load();
      }, () => { setFlow(null); void load(); });
    }, 1000);
    return () => clearInterval(timer);
  }, [flow, load]);

  const run = (key: string, action: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    return action().then(() => load(), (reason: Error) => { setError(reason.message); void load(); }).finally(() => { if (alive.current) setBusy(null); });
  };
  const signIn = (name: string) => run(name, async () => {
    const started = await call<McpSignIn>(at(name, "login"), {});
    if (started.status === "waiting") { setFlow(started); open(started.url); }
  });
  const addFromCatalog = (entry: McpCatalogItem, secret?: string) => run(entry.id, async () => {
    const added = await call<McpConnector>("/api/connections/mcp", { catalog: entry.id, ...(secret ? { token: secret } : {}) });
    setTokenFor(null);
    setToken("");
    if (added.state === "needs_login") {
      const started = await call<McpSignIn>(at(added.name, "login"), {});
      if (started.status === "waiting") { setFlow(started); open(started.url); }
    }
  });
  const addOwn = (event: FormEvent) => {
    event.preventDefault();
    const where = own.where.trim();
    const secret = own.secretName.trim() && own.secret ? { [own.secretName.trim()]: own.secret } : undefined;
    const [command, ...args] = where.split(/\s+/);
    void run("own", async () => {
      await call<McpConnector>("/api/connections/mcp", own.kind === "url"
        ? { name: own.name.trim(), url: where, ...(secret ? { headers: secret } : {}) }
        : { name: own.name.trim(), command, args, ...(secret ? { env: secret } : {}) });
      setOwn(EMPTY);
      setAdding(false);
    });
  };

  const status = (server: McpConnector) => {
    if (server.state === "connected") return <span className="set-status on">{t("settings.status.connected")}</span>;
    if (server.state === "needs_login") return <span className="set-status need">{t("mcp.needsLogin")}</span>;
    if (server.state === "error") return <span className="set-status need" title={server.error}>{t("mcp.error")}</span>;
    if (server.state === "off") return <span className="set-status">{t("mcp.off")}</span>;
    return <span className="set-status">{t("mcp.checking")}</span>;
  };
  const note = (server: McpConnector) => {
    if (server.state === "error" && server.error) return server.error;
    if (server.tools === undefined) return server.where;
    const asks = server.tools - (server.readOnly ?? 0);
    return `${t("mcp.tools", { n: server.tools })}${server.tools ? ` · ${t(asks ? "mcp.asks" : "mcp.asksNone", { n: asks })}` : ""}`;
  };

  const servers = data?.servers ?? [];
  const offered = (data?.catalog ?? []).filter((entry) => !entry.added);
  const locale = getLocale();
  return (
    <section className="set-section">
      <h2>{t("settings.connectors")}</h2>
      <p className="quiet">{t("mcp.sub")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      {data?.error && <p className="problem small" role="alert">{data.error}</p>}

      {servers.length > 0 && (
        <div className="set-rows">
          {servers.map((server) => (
            <div className="set-rows-item" key={server.name}>
              <div className="set-row has-logo mcp-row">
                <span className="set-logo" data-k="gray">{mark(server) ?? server.title.slice(0, 1).toUpperCase()}</span>
                <span className="set-name">{server.title}</span>
                <span className="set-note" title={server.where}>{note(server)}</span>
                <span className="set-end">
                  {status(server)}
                  {server.state === "needs_login" && <button type="button" className="set-button" disabled={!!busy || !!flow} onClick={() => void signIn(server.name)}>{t("models.signIn")}</button>}
                  {server.signedIn && server.state !== "needs_login" && (
                    <button type="button" className="set-button ghost" disabled={!!busy} onClick={() => void run(server.name, () => call(at(server.name, "logout"), {}))}>{t("models.signOut")}</button>
                  )}
                  {server.state === "error" && <button type="button" className="set-button ghost" disabled={!!busy} onClick={() => void run(server.name, () => call(at(server.name, "check"), {}))}>{t("mcp.retry")}</button>}
                  <button type="button" className="set-button ghost" onClick={() => setRemoving(removing === server.name ? null : server.name)}>{t("mcp.remove")}</button>
                  <button type="button" className="set-switch" role="switch" aria-checked={server.enabled} aria-label={t("mcp.use", { name: server.title })} disabled={!!busy}
                    onClick={() => void run(server.name, () => call(at(server.name, server.enabled ? "disable" : "enable"), {}))} />
                </span>
              </div>
              {flow?.server === server.name && (
                <div className="set-flow">
                  <div className="set-flow-head small"><span className="pulse" />{t("mcp.waiting", { name: server.title })}</div>
                  <div className="set-actions">
                    <a className="set-button" href={flow.url} target="_blank" rel="noopener noreferrer">{t("models.flow.open")}</a>
                    <button type="button" className="set-button ghost" onClick={() => { void call(`/api/connections/mcp/flows/${flow.id}/cancel`, {}).finally(() => { setFlow(null); void load(); }); }}>{t("common.cancel")}</button>
                  </div>
                </div>
              )}
              {removing === server.name && (
                <div className="set-flow">
                  {t("mcp.remove.confirm", { name: server.title })}
                  <div className="set-actions">
                    <button type="button" className="set-button" onClick={() => { setRemoving(null); void run(server.name, () => call(at(server.name, "remove"), {})); }}>{t("mcp.remove")}</button>
                    <button type="button" className="set-button ghost" onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {offered.length > 0 && (
        <>
          <h3 className="set-sub">{t("mcp.catalog")}</h3>
          <div className="set-rows">
            {offered.map((entry) => (
              <div className="set-rows-item" key={entry.id}>
                <div className="set-row has-logo">
                  <span className="set-logo" data-k="gray">{mark({ catalog: entry.id, where: entry.url }) ?? entry.title.slice(0, 1)}</span>
                  <span className="set-name">{entry.title}</span>
                  <span className="set-note">{entry.about[locale]}</span>
                  <span className="set-end">
                    <button type="button" className="set-button" disabled={!!busy || !!flow}
                      onClick={() => (entry.auth === "token" ? setTokenFor(tokenFor === entry.id ? null : entry.id) : void addFromCatalog(entry))}>
                      {t(entry.auth === "none" ? "mcp.add" : "mcp.connect")}
                    </button>
                  </span>
                </div>
                {tokenFor === entry.id && (
                  <form className="set-flow" onSubmit={(event) => { event.preventDefault(); if (token.trim()) void addFromCatalog(entry, token.trim()); }}>
                    <label className="small" htmlFor={`mcp-token-${entry.id}`}>{t("mcp.token", { name: entry.title })}</label>
                    <div className="set-actions">
                      <input id={`mcp-token-${entry.id}`} className="model-input" type="password" value={token} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setToken(event.target.value)} />
                      <button type="submit" className="set-button" disabled={!token.trim() || !!busy}>{t("models.flow.save")}</button>
                      {entry.tokenPage && <a className="dev-link" href={entry.tokenPage} target="_blank" rel="noopener noreferrer">{t("mcp.token.make")} ↗</a>}
                    </div>
                  </form>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="set-sub">{t("mcp.own")}</h3>
      <p className="quiet small">{t("mcp.own.note")}</p>
      {adding ? (
        <form className="set-flow mcp-own" onSubmit={addOwn}>
          <div className="chips set-chips" role="radiogroup" aria-label={t("mcp.own")}>
            <button type="button" className="chip" role="radio" aria-checked={own.kind === "url"} aria-pressed={own.kind === "url"} onClick={() => setOwn({ ...own, kind: "url" })}>{t("mcp.own.url")}</button>
            <button type="button" className="chip" role="radio" aria-checked={own.kind === "command"} aria-pressed={own.kind === "command"} onClick={() => setOwn({ ...own, kind: "command" })}>{t("mcp.own.command")}</button>
          </div>
          <input className="model-input" value={own.name} placeholder={t("mcp.own.name")} aria-label={t("mcp.own.name")} autoComplete="off" spellCheck={false} maxLength={64}
            onChange={(event) => setOwn({ ...own, name: event.target.value })} />
          <input className="model-input" value={own.where} placeholder={own.kind === "url" ? "https://example.com/mcp" : "npx -y some-mcp-server"} aria-label={t(own.kind === "url" ? "mcp.own.url" : "mcp.own.command")}
            autoComplete="off" spellCheck={false} onChange={(event) => setOwn({ ...own, where: event.target.value })} />
          <div className="mcp-secret">
            <input className="model-input" value={own.secretName} placeholder={own.kind === "url" ? t("mcp.own.header") : t("mcp.own.env")} aria-label={own.kind === "url" ? t("mcp.own.header") : t("mcp.own.env")}
              autoComplete="off" spellCheck={false} onChange={(event) => setOwn({ ...own, secretName: event.target.value })} />
            <input className="model-input" type="password" value={own.secret} placeholder={t("mcp.own.secret")} aria-label={t("mcp.own.secret")} autoComplete="off" spellCheck={false}
              onChange={(event) => setOwn({ ...own, secret: event.target.value })} />
          </div>
          <div className="set-actions">
            <button type="submit" className="set-button" disabled={!own.name.trim() || !own.where.trim() || busy === "own"}>{t("mcp.add")}</button>
            <button type="button" className="set-button ghost" onClick={() => { setAdding(false); setOwn(EMPTY); }}>{t("common.cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="set-actions"><button type="button" className="set-button ghost" onClick={() => setAdding(true)}>{t("mcp.own.add")}</button></div>
      )}
      <p className="quiet small">{t("mcp.privacy")}</p>
    </section>
  );
}
