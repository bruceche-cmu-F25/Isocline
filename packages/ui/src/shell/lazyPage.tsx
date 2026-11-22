/** A page that is loaded the first time it is opened, not with the app: its code is not something every window
 * needs before it can show anything (Settings; the Code page with its terminal and diffs).
 *
 * Nothing is drawn for the moment the code takes to come. If it does not come (the connection dropped, or the home
 * node was updated since this window opened, and the file it asks for has a new name), the page says so and offers
 * to load the app again, rather than taking the whole window down with it.
 */
import { useEffect, useState, type ComponentType } from "react";
import { t } from "../i18n/index.ts";

export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let Page: ComponentType<P> | null = null;
  return function LazyPage(props: P) {
    const [state, setState] = useState<"loading" | "ready" | "failed">(Page ? "ready" : "loading");
    useEffect(() => {
      if (Page) return;
      let alive = true;
      load().then((loaded) => { Page = loaded; if (alive) setState("ready"); }, () => { if (alive) setState("failed"); });
      return () => { alive = false; };
    }, []);
    if (Page) return <Page {...props} />;
    if (state !== "failed") return null;
    return (
      <div className="empty" role="alert">
        <p className="empty-title">{t("page.loadFailed")}</p>
        <button type="button" onClick={() => location.reload()}>{t("page.reload")}</button>
      </div>
    );
  };
}
