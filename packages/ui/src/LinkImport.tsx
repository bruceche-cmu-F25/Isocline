/** Bringing bookmarks in (docs/design/links.md §4.10.4): the user picks a browser's exported bookmarks file; the page
 * reads it and lays out where each bookmark would go, merging folders of the same name and matching the user's own
 * categories. The user renames, sets areas and merges on this card; only then is anything written, in parts, as one
 * import that can be undone. */
import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Area } from "@isocline/protocol";
import type { Topic } from "@isocline/module-links/types";
import { IMPORT_CHUNK, importEntries, parseBookmarks, proposeImport, type ImportProposal } from "@isocline/module-links/bookmarks";
import { mergeProposed, setProposedArea } from "./linkTree.ts";
import { Mark } from "./LinkRows.tsx";
import { api } from "./api.ts";
import { Pop } from "./shell/Pop.tsx";
import { Select } from "./shell/Select.tsx";
import { Icon } from "./shell/icons.tsx";
import { t } from "./i18n/index.ts";

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

export function ImportBookmarks({ topics, areas, onClose, onDone }: {
  topics: Topic[]; areas: Area[]; onClose(): void; onDone(result: { importId: string; added: number; filed: number }): void;
}) {
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const read = async (chosen: File | undefined) => {
    if (!chosen) return;
    setProblem(null);
    const text = await chosen.text();
    const marks = parseBookmarks(text);
    if (!marks.length) { setProblem(t("links.import.none")); return; }
    const next = proposeImport(marks, topics, areas);
    setProposal(next);
    setPicked(next.nodes[0]?.key ?? "");
  };
  const dropped = (event: DragEvent) => { event.preventDefault(); void read(event.dataTransfer.files[0]); };

  const write = async () => {
    if (!proposal) return;
    const entries = importEntries(proposal, topics);
    const importId = `imp-${Date.now().toString(36)}`;
    let added = 0, filed = 0;
    setSent(0);
    try {
      for (let at = 0; at < entries.length; at += IMPORT_CHUNK) {
        const response = await api.op("link.import", { importId, entries: entries.slice(at, at + IMPORT_CHUNK) });
        const result = response.result as { added?: number; filed?: number; error?: string };
        if (result?.error) throw new Error(result.error);
        added += result.added ?? 0;
        filed += result.filed ?? 0;
        setSent(Math.min(entries.length, at + IMPORT_CHUNK));
      }
      onDone({ importId, added, filed });
    } catch (reason) {
      setProblem((reason as Error).message);
      setSent(null);
    }
  };

  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name;
  const choices = [{ value: "", label: t("links.tree.noArea") }, ...areas.map((area) => ({ value: area.id, label: area.name }))];
  const groups = useMemo(() => {
    if (!proposal) return [];
    const tops = proposal.nodes.filter((node) => !node.parent);
    const order = [...areas.map((area) => area.id), undefined];
    return order.map((area) => ({ area, nodes: tops.filter((node) => (node.area ?? undefined) === area || (area === undefined && !areas.some((a) => a.id === node.area))) }))
      .filter((group) => group.nodes.length);
  }, [proposal, areas]);
  const current = proposal?.nodes.find((node) => node.key === picked);
  // Top categories with no area: the import goes ahead, but the card says so, and marks them.
  const unplaced = proposal?.nodes.filter((node) => !node.parent && !node.area).length ?? 0;
  const count = (key: string) => (proposal?.nodes.find((node) => node.key === key)?.items.length ?? 0) + (proposal?.nodes.filter((node) => node.parent === key).reduce((sum, child) => sum + child.items.length, 0) ?? 0);

  const nodeRow = (key: string, depth: number) => {
    const node = proposal!.nodes.find((candidate) => candidate.key === key)!;
    const others = proposal!.nodes.filter((candidate) => candidate.key !== key && candidate.parent !== key);
    return (
      <li key={key} className="li-node" aria-current={picked === key || undefined} data-need={!node.parent && !node.area || undefined} style={{ "--d": depth } as CSSProperties} data-k={areas.find((area) => area.id === node.area)?.k ?? "gray"}>
        <button type="button" className="li-pick" onClick={() => setPicked(key)}>
          {renaming === key
            ? <input className="lt-input" autoFocus defaultValue={node.name} maxLength={60} aria-label={t("links.tree.rename")} onClick={(event) => event.stopPropagation()}
                onBlur={(event) => { const name = event.target.value.trim(); setRenaming(null); if (name) setProposal({ ...proposal!, nodes: proposal!.nodes.map((n) => n.key === key ? { ...n, name, topicId: undefined } : n) }); }}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) (event.target as HTMLInputElement).blur(); if (event.key === "Escape") setRenaming(null); }} />
            : <span className="li-name">{node.name}{node.topicId ? <span className="li-tag">{t("links.import.yours")}</span> : <span className="li-tag new">{t("links.import.new")}</span>}</span>}
          <span className="li-from">{t("links.import.from", { names: node.from.join("、") })}</span>
        </button>
        <span className="lt-count">{count(key)}</span>
        <span className="li-acts">
          {!node.parent && <Select className="li-area" label={t("links.import.area", { name: node.name })} value={node.area ?? ""} options={choices}
            onChange={(area) => setProposal(setProposedArea(proposal!, key, area || undefined))}>{areaName(node.area) ?? t("links.import.pickArea")}</Select>}
          <button type="button" className="lk-btn quiet" onClick={() => setRenaming(key)} aria-label={t("links.tree.rename")}><Icon name="write" /></button>
          <Select className="li-merge" label={t("links.tree.mergeInto", { name: node.name })} value="" options={[{ value: "", label: t("links.tree.merge") }, ...others.map((other) => ({ value: other.key, label: other.name }))]}
            onChange={(into) => { if (into) { setProposal(mergeProposed(proposal!, key, into)); if (picked === key) setPicked(into); } }}><Icon name="layers" /></Select>
        </span>
      </li>
    );
  };

  return (
    <Pop onClose={() => sent === null && onClose()}>
      <div className="li-sheet" role="dialog" aria-label={t("links.import.title")} onDragOver={(event) => event.preventDefault()} onDrop={dropped}>
        <header>
          <h3>{proposal ? t("links.import.titleN", { n: proposal.total }) : t("links.import.title")}</h3>
          <p className="quiet">{proposal ? t("links.import.hint", { folders: new Set(proposal.nodes.flatMap((node) => node.from)).size, n: proposal.nodes.length }) : t("links.import.how")}</p>
        </header>
        {!proposal && (
          <div className="li-drop">
            <Icon name="import" />
            <button type="button" className="lk-btn solid" onClick={() => file.current?.click()}>{t("links.import.choose")}</button>
            <p className="quiet">{t("links.import.where")}</p>
            <input ref={file} type="file" accept=".html,.htm,text/html" hidden onChange={(event) => void read(event.target.files?.[0])} />
          </div>
        )}
        {proposal && (
          <div className="li-cols">
            <ul className="li-tree">
              {groups.map(({ area, nodes }) => [
                <li key={`area:${area ?? ""}`} className="li-area-head" data-k={areas.find((candidate) => candidate.id === area)?.k ?? "gray"}><span className="lt-dot" />{areaName(area) ?? t("links.tree.noArea")}</li>,
                ...nodes.flatMap((node) => [nodeRow(node.key, 1), ...proposal.nodes.filter((child) => child.parent === node.key).map((child) => nodeRow(child.key, 2))]),
              ])}
              {proposal.loose.length > 0 && <li className="li-node" aria-current={picked === "" || undefined}>
                <button type="button" className="li-pick" onClick={() => setPicked("")}><span className="li-name">{t("links.tree.none")}</span></button>
                <span className="lt-count">{proposal.loose.length}</span></li>}
            </ul>
            <ul className="li-items">
              {(current ? current.items : proposal.loose).map((item) => (
                <li key={item.url} className="lr-row"><span className="lr-open">
                  <Mark url={item.url} title={item.title} />
                  <span className="lr-text"><span className="lr-title">{item.title}</span><span className="lr-sub">{host(item.url)}{item.folder ? ` · ${item.folder}` : ""}</span></span>
                  <span className="lr-type">{t(item.kind === "place" ? "links.type.site" : "links.import.saved")}</span>
                </span></li>
              ))}
            </ul>
          </div>
        )}
        {problem && <p className="problem small" role="alert">{problem}</p>}
        <footer>
          <span className="quiet">{proposal ? [
            proposal.over ? t("links.import.over", { n: proposal.over }) : t("links.import.undo"),
            ...(unplaced ? [t("links.import.needArea", { n: unplaced })] : []),
          ].join(" ") : ""}</span>
          <button type="button" className="lk-btn" disabled={sent !== null} onClick={onClose}>{t("common.cancel")}</button>
          {proposal && <button type="button" className="lk-btn solid" disabled={sent !== null || !proposal.total} onClick={() => void write()}>
            {sent === null ? t("links.import.go", { n: proposal.total }) : t("links.import.sending", { n: sent, of: proposal.total })}</button>}
        </footer>
      </div>
    </Pop>
  );
}
