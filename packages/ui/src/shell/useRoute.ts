import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@alfred/protocol";

type Route = { page: string | null; selected: string | null; session: string | null; item: string | null };
type Visit = { index: number; hasNext: boolean };
const first: Visit = { index: 0, hasNext: false };

function readRoute(): Route {
  const params = new URLSearchParams(location.hash.slice(1));
  return { page: params.get("p"), selected: params.get("c"), session: params.get("s"), item: params.get("item") };
}

function address(route: Route) {
  const url = new URL(location.href);
  const params = new URLSearchParams();
  if (route.page) params.set("p", route.page);
  if (route.selected) params.set("c", route.selected);
  if (route.session) params.set("s", route.session);
  if ((route.page === "core.inbox" || route.page === "mail.inbox") && route.item) params.set("item", route.item);
  url.hash = params.toString();
  return url;
}

function savedVisit(): Visit | undefined {
  return history.state?.alfredPage;
}

function directions(visit: Visit) {
  // A trip outside Alfred can replace a forward entry while this document is suspended.
  const navigation = window.navigation;
  if (navigation?.currentEntry) {
    const entries = navigation.entries();
    const index = navigation.currentEntry.index;
    return { canGoBack: !!entries[index - 1]?.sameDocument, canGoForward: !!entries[index + 1]?.sameDocument };
  }
  return { canGoBack: visit.index > 0, canGoForward: visit.hasNext };
}

const pageOf = (route: Route) => route.page ?? "core.today";

/** A workspace page is one browser history entry. Its conversation, session and focused item update in place. */
export function useRoute(revealPage: () => void) {
  const [current, setCurrent] = useState(() => ({ route: readRoute(), visit: savedVisit() ?? first }));
  const latest = useRef(current);
  const show = useCallback((route: Route, visit: Visit) => {
    latest.current = { route, visit };
    setCurrent(latest.current);
    return route;
  }, []);

  useEffect(() => {
    if (!savedVisit()) history.replaceState({ ...history.state, alfredPage: latest.current.visit }, "");
    const update = () => {
      const previous = latest.current;
      const route = readRoute();
      // An ordinary #p= link also makes a visit; the browser creates that entry without our marker.
      let visit = savedVisit() ?? { index: previous.visit.index + 1, hasNext: false };
      if (visit.index < previous.visit.index) visit = { ...visit, hasNext: true };
      history.replaceState({ ...history.state, alfredPage: visit }, "");
      show(route, visit);
      if (pageOf(route) !== pageOf(previous.route)) revealPage();
    };
    window.addEventListener("hashchange", update);
    const resume = (event: PageTransitionEvent) => { if (event.persisted) update(); };
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("pageshow", resume);
    };
  }, [revealPage, show]);

  const go = useCallback((patch: Partial<Route>) => {
    const { route, visit } = latest.current;
    const next = { ...route, ...patch };
    if (pageOf(next) === pageOf(route)) {
      history.replaceState({ ...history.state, alfredPage: visit }, "", address(next));
      return show(next, visit);
    }
    history.replaceState({ ...history.state, alfredPage: { ...visit, hasNext: true } }, "");
    const nextVisit: Visit = { index: visit.index + 1, hasNext: false };
    history.pushState({ alfredPage: nextVisit }, "", address(next));
    return show(next, nextVisit);
  }, [show]);

  // Reopen on undo only if the user is still where archiving left them.
  function leaveArchived(conversation: Conversation) {
    const field = conversation.projectId ? "session" : "selected";
    if (latest.current.route[field] !== conversation.id) return;
    const left = go({ [field]: null });
    return () => {
      if (latest.current.route !== left) return false;
      go({ [field]: conversation.id });
      return true;
    };
  }
  const { canGoBack, canGoForward } = useMemo(() => directions(current.visit), [current]);
  return {
    ...current.route, go, leaveArchived, canGoBack, canGoForward,
    goBack: () => { if (canGoBack) history.back(); },
    goForward: () => { if (canGoForward) history.forward(); },
  };
}
