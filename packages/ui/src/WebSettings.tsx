/** Settings → Web (docs/design/web.md §4): whether Zirma may search and read pages, the search services in the order
 * they are tried (Zirma's own, one the user runs themself by its address, or a connector's search tool), the reading
 * services for pages Zirma cannot read itself, their keys (kept in the home node's keychain), the sites that open
 * without asking, and a short record of what was searched and opened. Only on the home node: it holds keys.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { WebResponse, WebService, WebTestResponse } from "@zirma/protocol";
import { ApiError, request as call } from "./api.ts";
import { connectorMark, hasMark, Logo } from "./brand/Logo.tsx";
import { getLocale, t } from "./i18n/index.ts";

type Open = { id: string; what: "key" | "address" | "test" } | null;
type Kind = "search" | "read";

const CONNECTOR = /^mcp:([^:]+):/;

/** The service's own mark (a connector's tool takes its connector's), its first letter where Zirma has none. */
function Mark({ service }: { service: WebService }) {
  const name = service.connector ? connectorMark({ name: CONNECTOR.exec(service.id)?.[1] }) : hasMark(service.id) ? service.id : undefined;
  return <span className="set-logo" data-k="gray">{name ? <Logo name={name} /> : service.title.slice(0, 1).toUpperCase()}</span>;
}

/** The time of a record: the hour today, the day before that. */
function when(at: string): string {
  const date = new Date(at), now = new Date();
  const tag = getLocale() === "zh" ? "zh-CN" : "en";
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(tag, { month: "short", day: "numeric" });
}

export function WebSettings() {
  const [data, setData] = useState<WebResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [key, setKey] = useState("");
  const [tested, setTested] = useState<{ id: string; reading?: boolean; result?: WebTestResponse; error?: string; code?: string } | null>(null);
  const [site, setSite] = useState("");
  /** What is typed into the key or address field of a service not yet in use. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [allRecords, setAllRecords] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => call<WebResponse>("/api/web").then((next) => { if (alive.current) setData(next); }, (reason: Error) => setError(reason.message)), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<WebResponse>) => {
    setBusy(label);
    setError(null);
    try {
      const next = await action();
      if (alive.current) setData(next);
      return true;
    } catch (reason) {
      if (alive.current) setError((reason as Error).message);
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const save = (change: Partial<Pick<WebResponse, "on" | "search" | "read" | "sites">>) => run("save", () => call<WebResponse>("/api/web", change));

  if (!data) {
    return (
      <section className="set-section">
        <h2>{t("web.title")}</h2>
        {error ? <p className="problem small" role="alert">{error}</p> : <p className="quiet" role="status">{t("web.loading")}</p>}
      </section>
    );
  }

  const locale = getLocale();
  const name = (service: WebService) => (locale === "zh" && service.zhTitle) || service.title;
  const all = [...data.services, ...data.readers];
  const byId = new Map(all.map((service) => [service.id, service]));
  const order = (kind: Kind) => (kind === "search" ? data.search : data.read);
  const setOrder = (kind: Kind, next: string[]) => save(kind === "search" ? { search: next } : { read: next });
  const move = (kind: Kind, id: string, step: -1 | 1) => {
    const next = [...order(kind)];
    const at = next.indexOf(id), to = at + step;
    if (at < 0 || to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to]!, next[at]!];
    void setOrder(kind, next);
  };
  const toggle = (id: string, what: "key" | "address") => {
    setKey("");
    setOpen(open?.id === id && open.what === what ? null : { id, what });
  };
  const ready = (service: WebService) => service.needs === "key" ? service.hasKey : service.needs === "address" ? !!service.address : true;
  const saveSecret = async (event: FormEvent, service: WebService, kind: Kind, thenUse: boolean, typed = key) => {
    event.preventDefault();
    const value = typed.trim();
    if (!value) return;
    const ok = await run(service.id, () => service.needs === "address"
      ? call<WebResponse>(`/api/web/address/${service.id}`, { address: value })
      : call<WebResponse>(`/api/web/keys/${service.id}`, { key: value }));
    if (!ok) return;
    setKey("");
    setDrafts(({ [service.id]: _, ...rest }) => rest);
    setOpen(null);
    if (thenUse && !order(kind).includes(service.id)) await setOrder(kind, [...order(kind), service.id]);
    // A new key or address is tried at once, so a wrong one shows now and not in a conversation.
    void test(service, kind);
  };
  const test = async (service: WebService, kind: Kind) => {
    setOpen({ id: service.id, what: "test" });
    setTested({ id: service.id, reading: kind === "read" });
    try {
      const result = await call<WebTestResponse>(`/api/web/test/${encodeURIComponent(service.id)}`, { query: t("web.test.query") });
      if (alive.current) setTested({ id: service.id, result });
    } catch (reason) {
      if (alive.current) setTested({ id: service.id, error: (reason as Error).message, ...(reason instanceof ApiError && reason.code ? { code: reason.code } : {}) });
    }
  };
  const note = (service: WebService) => {
    if (service.needs === "key" && !service.hasKey) return t("web.needsKey");
    if (service.needs === "address" && !service.address) return t("web.needsAddress");
    if (service.limited) return t("web.limited");
    return [service.address ?? service.about[locale], service.today ? t("web.today", { n: service.today }) : ""].filter(Boolean).join(" · ");
  };
  /** Where to get its key (or, for one the user runs themself, how to set it up), on every row that has one. */
  const keyLink = (service: WebService) => service.keyPage && (
    <> · <a href={service.keyPage} target="_blank" rel="noopener noreferrer">{t(service.needs === "address" ? "web.address.howto" : service.hasKey ? "web.key.manage" : "web.key.make")}</a></>
  );
  const addSite = (event: FormEvent) => {
    event.preventDefault();
    const value = site.trim();
    if (!value) return;
    void save({ sites: [...data.sites, value] }).then((ok) => { if (ok) setSite(""); });
  };

  /** The form for a key, or for one the user runs themself, its address. */
  const secretForm = (service: WebService, kind: Kind, thenUse: boolean) => {
    const address = service.needs === "address";
    const has = address ? !!service.address : service.hasKey;
    const field = `web-${address ? "address" : "key"}-${service.id}`;
    return (
      <form className="set-flow" onSubmit={(event) => void saveSecret(event, service, kind, thenUse)}>
        <label className="small" htmlFor={field}>
          {t(address ? "web.address.label" : has ? "web.key.replace" : "web.key.label", { name: name(service) })}
        </label>
        <div className="set-actions">
          {address
            ? <input id={field} className="model-input" type="url" inputMode="url" value={key} placeholder={service.address ?? "http://localhost:8080"} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setKey(event.target.value)} />
            : <input id={field} className="model-input" type="password" value={key} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setKey(event.target.value)} />}
          <button type="submit" className="set-button" disabled={!key.trim() || !!busy}>{t("models.flow.save")}</button>
        </div>
        {has && (
          <div className="set-actions">
            <button type="button" className="set-button ghost" disabled={!!busy}
              onClick={() => { setOpen(null); void run(service.id, () => (address ? call<WebResponse>(`/api/web/address/${service.id}`, { address: "" }) : call<WebResponse>(`/api/web/keys/${service.id}/remove`, {}))); }}>
              {t(address ? "web.address.remove" : "web.key.remove")}
            </button>
          </div>
        )}
      </form>
    );
  };

  const testResult = (service: WebService) => open?.id === service.id && open.what === "test" && tested?.id === service.id && (
    <div className="set-flow web-test" role="status">
      {!tested.result && !tested.error && <span className="small"><span className="pulse" />{t(tested.reading ? "web.test.reading" : "web.test.running")}</span>}
      {tested.error && <span className="problem small">{failure(service, tested.code, tested.error)}</span>}
      {tested.result?.page && (
        <span className="small quiet">{t("web.test.read", { n: tested.result.page.chars, s: (tested.result.ms / 1000).toFixed(1) })}{tested.result.page.title ? ` · ${tested.result.page.title}` : ""}</span>
      )}
      {tested.result && !tested.result.page && (
        <>
          <span className="small quiet">{t("web.test.done", { n: tested.result.results.length, s: (tested.result.ms / 1000).toFixed(1) })}</span>
          <ol className="web-results">
            {tested.result.results.map((result) => (
              <li key={result.url}><a href={result.url} target="_blank" rel="noopener noreferrer">{result.title}</a><span className="quiet small">{result.url}</span></li>
            ))}
          </ol>
        </>
      )}
    </div>
  );

  /** Why a try failed, in the page's words where Zirma knows them; the service's own words otherwise. */
  const failure = (service: WebService, code: string | undefined, said: string) => {
    if (code === "web_limit") return t("web.limited");
    if (code === "web_refused") return service.needs === "address" ? t("web.address.json") : t("web.test.refused", { name: name(service) });
    return said;
  };

  /** The services in use, in order, with their buttons; then the others, each with a button that puts it at the end
   * of the order (asking for its key or address first, if it cannot work without). */
  const list = (kind: Kind, offered: WebService[]) => {
    const used = order(kind).flatMap((id) => byId.get(id) ?? []);
    const rest = offered.filter((service) => !order(kind).includes(service.id));
    const secret = (service: WebService, thenUse: boolean) => open?.id === service.id && (open.what === "key" || open.what === "address") && secretForm(service, kind, thenUse);
    return (
      <div className="set-rows">
        {used.map((service, index) => (
          <div className="set-rows-item" key={service.id}>
            <div className="set-row has-logo web-row">
              <Mark service={service} />
              <span className="set-name">{name(service)}</span>
              <span className={`set-note${service.limited ? " web-limited" : ""}`} {...(service.limited ? { "data-k": "warm" } : {})}>{note(service)}{keyLink(service)}</span>
              <span className="set-end">
                {used.length > 1 && (
                  <span className="web-order">
                    <button type="button" className="set-button ghost" disabled={!!busy || index === 0} aria-label={t("web.up", { name: name(service) })} title={t("web.up", { name: name(service) })} onClick={() => move(kind, service.id, -1)}>↑</button>
                    <button type="button" className="set-button ghost" disabled={!!busy || index === used.length - 1} aria-label={t("web.down", { name: name(service) })} title={t("web.down", { name: name(service) })} onClick={() => move(kind, service.id, 1)}>↓</button>
                  </span>
                )}
                <button type="button" className="set-button ghost" disabled={!!busy || !ready(service)} onClick={() => void test(service, kind)}>{t("web.test")}</button>
                {!service.connector && (
                  <button type="button" className="set-button ghost" onClick={() => toggle(service.id, service.needs === "address" ? "address" : "key")}>
                    {service.needs === "address" ? t(service.address ? "web.address.change" : "web.address.add") : t(service.hasKey ? "web.key.change" : "web.key.add")}
                  </button>
                )}
                <button type="button" className="set-button ghost" disabled={!!busy} onClick={() => void setOrder(kind, order(kind).filter((id) => id !== service.id))}>{t("web.stop")}</button>
              </span>
            </div>
            {secret(service, false)}
            {testResult(service)}
          </div>
        ))}
        {rest.map((service) => (
          <div className="set-rows-item web-unused" key={service.id}>
            {ready(service) ? (
              <div className="set-row has-logo web-row">
                <Mark service={service} />
                <span className="set-name">{name(service)}</span>
                <span className="set-note">{service.about[locale]}{keyLink(service)}</span>
                <span className="set-end">
                  <button type="button" className="set-button ghost" disabled={!!busy} onClick={() => void setOrder(kind, [...order(kind), service.id])}>{t("web.use")}</button>
                </span>
              </div>
            ) : (
              // One that cannot work without a key or an address takes it right here; adding it tries it at once.
              <form className="set-row has-logo web-row web-ask" onSubmit={(event) => void saveSecret(event, service, kind, true, drafts[service.id] ?? "")}>
                <Mark service={service} />
                <span className="set-name">{name(service)}</span>
                <span className="set-note">
                  {service.about[locale]}
                  {keyLink(service)}
                </span>
                <span className="set-end">
                  <input className="model-input" type={service.needs === "address" ? "url" : "password"} inputMode={service.needs === "address" ? "url" : undefined}
                    value={drafts[service.id] ?? ""} autoComplete="off" spellCheck={false}
                    placeholder={service.needs === "address" ? "http://localhost:8080" : "API key"}
                    aria-label={t(service.needs === "address" ? "web.address.label" : "web.key.label", { name: name(service) })}
                    onChange={(event) => setDrafts({ ...drafts, [service.id]: event.target.value })} />
                  <button type="submit" className="set-button" disabled={!!busy || !(drafts[service.id] ?? "").trim()}>{busy === service.id ? t("web.adding") : t("web.use")}</button>
                </span>
              </form>
            )}
            {testResult(service)}
          </div>
        ))}
      </div>
    );
  };

  const records = allRecords ? data.records : data.records.slice(0, 8);
  return (
    <section className="set-section web-settings">
      <h2>{t("web.title")}</h2>
      <div className="set-row web-on">
        <span className="set-name">{t("web.on")}</span>
        <span className="set-end">
          <button type="button" className="set-switch" role="switch" aria-checked={data.on} aria-label={t("web.on")} disabled={!!busy} onClick={() => void save({ on: !data.on })} />
        </span>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}

      {data.on && (
        <>
          <h3 className="set-sub">{t("web.search")}</h3>
          {list("search", data.services)}

          <h3 className="set-sub">{t("web.read")}</h3>
          {list("read", data.readers)}

          <h3 className="set-sub">{t("web.sites")}</h3>
          {data.sites.length > 0 && (
            <ul className="web-sites">
              {data.sites.map((host) => (
                <li key={host} className="chip">
                  <span>{host}</span>
                  <button type="button" className="web-site-remove" aria-label={t("web.sites.remove", { site: host })} title={t("web.sites.remove", { site: host })} disabled={!!busy}
                    onClick={() => void save({ sites: data.sites.filter((other) => other !== host) })}>×</button>
                </li>
              ))}
            </ul>
          )}
          <form className="set-actions web-site-add" onSubmit={addSite}>
            <input className="model-input" value={site} placeholder="example.com" aria-label={t("web.sites.add")} autoComplete="off" spellCheck={false} maxLength={253} onChange={(event) => setSite(event.target.value)} />
            <button type="submit" className="set-button ghost" disabled={!site.trim() || !!busy}>{t("web.sites.add")}</button>
          </form>
        </>
      )}

      {data.records.length > 0 && (
        <>
          <h3 className="set-sub">{t("web.records")}</h3>
          <ul className="web-records">
            {records.map((record, index) => (
              <li key={`${record.at}-${index}`}>
                <span className="web-record-when quiet">{when(record.at)}</span>
                <span className="web-record-kind quiet">{t(record.kind === "search" ? "web.records.search" : "web.records.open")}</span>
                <span className="web-record-what" title={record.what}>{record.what}</span>
                {record.provider && <span className="web-record-by quiet">{(() => { const by = byId.get(record.provider); return by ? name(by) : record.provider; })()}</span>}
              </li>
            ))}
          </ul>
          <div className="set-actions">
            {data.records.length > records.length && <button type="button" className="set-button ghost" onClick={() => setAllRecords(true)}>{t("web.records.all", { n: data.records.length })}</button>}
            <button type="button" className="set-button ghost" disabled={!!busy} onClick={() => void run("clear", () => call<WebResponse>("/api/web/records/clear", {}))}>{t("web.records.clear")}</button>
          </div>
        </>
      )}
    </section>
  );
}
