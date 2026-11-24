/** Settings → General → Pages: which pages the sidebar lists, and in what order (core settings `pages`). The pages
 * themselves come with the modules; the user arranges them. One row each: its icon and name, up and down within its
 * group, and a switch to keep it in the sidebar. The Today page, the Inbox, coding and Settings always stay.
 */
import { Fragment, useState } from "react";
import type { StateResponse } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";
import { availablePages, canHide, type PageDef } from "./shell/pages.tsx";

export function PagesSetting({ state }: { state: StateResponse }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = availablePages(state);
  const rows = all.filter(canHide);
  const hidden = new Set(state.settings?.pages?.hidden ?? []);

  const save = async (next: { order?: string[]; hidden?: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      await api.settings({ pages: { order: next.order ?? all.map((page) => page.key), hidden: next.hidden ?? [...hidden] } });
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  /** Swap a page with its neighbour in the same group. */
  const move = (page: PageDef, by: -1 | 1) => {
    const group = rows.filter((other) => other.group === page.group);
    const other = group[group.indexOf(page) + by];
    if (!other) return;
    const order = all.map((each) => each.key);
    const a = order.indexOf(page.key), b = order.indexOf(other.key);
    [order[a], order[b]] = [order[b]!, order[a]!];
    void save({ order });
  };
  const toggle = (page: PageDef) => {
    const next = new Set(hidden);
    if (next.has(page.key)) next.delete(page.key); else next.add(page.key);
    void save({ hidden: [...next] });
  };

  return (
    <section className="set-section areas" aria-busy={busy}>
      <h2>{t("pagesSet.title")}</h2>
      <p className="areas-note">{t("pagesSet.note")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      <ul className="set-rows area-rows">
        {rows.map((page) => {
          const group = rows.filter((other) => other.group === page.group);
          const index = group.indexOf(page);
          const shown = !hidden.has(page.key);
          return (
            <Fragment key={page.key}>
            {/* The sidebar's own groups: a page moves within its group. */}
            {index === 0 && <li className="page-group">{t(page.group === "work" ? "nav.g.work" : "nav.g.modules")}</li>}
            <li className="area-row" data-k={page.k}>
              <div className="area-line page-line" data-off={!shown || undefined}>
                <span className="page-icon"><Icon name={page.icon} /></span>
                <span className="page-name">{page.title}</span>
                <span className="area-tools">
                  <button type="button" className="area-tool" aria-label={t("areas.up", { name: page.title })} disabled={busy || index === 0}
                    onClick={() => move(page, -1)}><span className="flip"><Icon name="down" /></span></button>
                  <button type="button" className="area-tool" aria-label={t("areas.down", { name: page.title })} disabled={busy || index === group.length - 1}
                    onClick={() => move(page, 1)}><Icon name="down" /></button>
                  <button type="button" className="switch" role="switch" aria-checked={shown} aria-label={t("pagesSet.show", { name: page.title })} disabled={busy}
                    onClick={() => toggle(page)} />
                </span>
              </div>
            </li>
            </Fragment>
          );
        })}
      </ul>
    </section>
  );
}
