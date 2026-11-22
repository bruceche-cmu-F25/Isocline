import { useCallback, useEffect, useState } from "react";
import { api, type LinkSampleState } from "./api.ts";
import { Links } from "./Links.tsx";
import { LinkLibrary } from "./linkControls.tsx";
import { t } from "./i18n/index.ts";

const noHighlights = new Set<string>();

/** Each sample write returns the complete snapshot. Ignore a slower read if a newer write already arrived. */
export function useLinkSample(active: boolean) {
  const [data, setData] = useState<LinkSampleState>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const accept = useCallback((next: LinkSampleState) => {
    setData((current) => !current || next.revision >= current.revision ? next : current);
    setError(undefined);
  }, []);
  useEffect(() => {
    if (!active) {
      setData(undefined);
      setError(undefined);
      return;
    }
    let stopped = false;
    let reading = false;
    let timer: number;
    let reads = 0;
    async function refresh() {
      window.clearTimeout(timer);
      if (reading || document.hidden) return;
      reading = true;
      let delay = 15000;
      try {
        const next = await api.linkSample();
        if (!stopped) accept(next);
        if (++reads < 20 && next.snapshot.clips.some((clip) => clip.type === "video" && !clip.cover)) delay = 1200;
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        reading = false;
        if (!stopped) timer = window.setTimeout(refresh, delay);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, accept, attempt]);
  async function op(name: string, input: unknown) {
    const next = await api.linkSampleOp(name, input);
    accept(next);
    return next;
  }
  async function restore() { accept(await api.restoreLinkSample()); }
  return { data, error, op, restore, retry: () => setAttempt((value) => value + 1) };
}

export function LibrarySwitcher({ sample = false, restore }: { sample?: boolean; restore?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function restoreVideos() {
    if (!restore || busy) return;
    setBusy(true);
    try { await restore(); setMessage(t("links.sample.restored")); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return (
    <div className="lk-library">
      <nav aria-label={t("page.links")}>
        <a href="#p=link.list" aria-current={!sample ? "page" : undefined}>{t("links.sample.personal")}</a>
        <a href="#p=link.sample" aria-current={sample ? "page" : undefined}>{t("links.sample.entry")}</a>
      </nav>
      {restore && <button type="button" className="lk-btn" disabled={busy} onClick={restoreVideos}>{t("links.sample.restore")}</button>}
      {message && <span role="status">{message}</span>}
    </div>
  );
}

export function SampleLinks({ model, focus, onFocused }: {
  model: ReturnType<typeof useLinkSample>; focus: string | null; onFocused(): void;
}) {
  if (!model.data) return (
    <section className="links">
      <LibrarySwitcher sample />
      {model.error
        ? <p className="problem" role="alert">{model.error} <button className="lk-btn" onClick={model.retry}>{t("links.retry")}</button></p>
        : <p className="quiet" role="status">{t("links.sample.loading")}</p>}
    </section>
  );
  return (
    <LinkLibrary.Provider value={{ op: model.op, files: "/api/link-sample/files/" }}>
      <Links snapshot={model.data.snapshot} fresh={noHighlights} areas={[]} focus={focus} onFocused={onFocused}
        libraryControls={<LibrarySwitcher sample restore={model.restore} />} />
    </LinkLibrary.Provider>
  );
}
