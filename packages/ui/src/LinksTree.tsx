/** The category tree beside the Links page (docs/design/links.md §4.10.1): the areas, the topics under them two levels
 * deep, a count on each. Pick a node to see what is in it; drag a link onto one to file it there, or a category onto
 * another to put it under (holding ⌥, to merge them). A category's ⋯ adds one under it, renames, merges or removes it. */
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { Area } from "@isocline/protocol";
import { MAX_TOPIC_DEPTH, topicDepth } from "@isocline/module-links/tree";
import type { Tree } from "./linkTree.ts";
import { useOp } from "./linkControls.tsx";
import { Pop } from "./shell/Pop.tsx";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import { t } from "./i18n/index.ts";

export const DRAG_LINK = "application/x-isocline-link";
const DRAG_TOPIC = "application/x-isocline-topic";

export function TreeNav({ tree, areas, counts, node, open, searching, onPick, onToggle, onDropLink, onError, onSaid }: {
  tree: Tree; areas: Area[]; counts: Map<string, number>; node: string; open: ReadonlySet<string>; searching: boolean;
  onPick(node: string): void; onToggle(node: string): void; onDropLink(id: string, node: string): void; onError(message: string | null): void; onSaid(message: string): void;
}) {
  const { busy, run } = useOp(onError);
  const [menu, setMenu] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ node: string; mode: "rename" | "child" } | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const area = (id: string) => areas.find((candidate) => candidate.id === id);
  const areaName = (key: string) => key === "area:" ? t("links.tree.noArea") : area(key.slice(5))?.name ?? key.slice(5);

  const drop = (event: DragEvent, target: string) => {
    const link = event.dataTransfer.getData(DRAG_LINK), topic = event.dataTransfer.getData(DRAG_TOPIC);
    setOver(null);
    if (link && !target.startsWith("area:")) { event.preventDefault(); onDropLink(link, target === "none" ? "" : target); return; }
    if (!topic || topic === target) return;
    event.preventDefault();
    if (event.altKey && !target.startsWith("area:")) { void run("link.merge", { id: topic, into: target }, () => onSaid(t("links.tree.merged", { name: tree.byId.get(topic)?.name ?? "", into: tree.byId.get(target)?.name ?? "" }))); return; }
    if (target.startsWith("area:")) void run("link.topic", { id: topic, parentId: "", area: target.slice(5) });
    else void run("link.topic", { id: topic, parentId: target });
  };
  const accepts = (event: DragEvent, target: string) => {
    const types = event.dataTransfer.types;
    const ok = types.includes(DRAG_TOPIC) || (types.includes(DRAG_LINK) && !target.startsWith("area:"));
    if (!ok) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== target) setOver(target);
  };

  const row = (key: string, depth: number, label: ReactNode, opts: { dot?: string; kids?: boolean; topic?: string; strong?: boolean } = {}) => {
    const count = counts.get(key) ?? 0;
    const isOpen = searching || open.has(key);
    return (
      <div key={key} className="lt-node" role="treeitem" aria-selected={node === key} aria-expanded={opts.kids ? isOpen : undefined} data-strong={opts.strong || undefined}
        data-over={over === key || undefined} style={{ "--d": depth } as CSSProperties} data-k={opts.dot}
        draggable={!!opts.topic && naming?.node !== key} tabIndex={node === key ? 0 : -1}
        onClick={() => onPick(key)} onKeyDown={(event) => { if (event.key === "Enter") onPick(key); if (opts.kids && (event.key === "ArrowRight" || event.key === "ArrowLeft")) onToggle(key); }}
        onDragStart={(event) => { if (!opts.topic) return; event.dataTransfer.setData(DRAG_TOPIC, opts.topic); event.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(event) => accepts(event, key)} onDragLeave={() => over === key && setOver(null)} onDrop={(event) => drop(event, key)}>
        <button type="button" className="lt-twist" tabIndex={-1} aria-hidden={!opts.kids} data-open={isOpen || undefined} disabled={!opts.kids}
          onClick={(event) => { event.stopPropagation(); onToggle(key); }}><Icon name="forward" /></button>
        {opts.dot && <span className="lt-dot" />}
        {naming?.node === key && naming.mode === "rename"
          ? <NameInput initial={typeof label === "string" ? label : ""} onDone={(name) => { setNaming(null); if (name) void run("link.topic", { id: key, name }); }} />
          : <span className="lt-name">{label}</span>}
        <span className="lt-count">{count || ""}</span>
        {(opts.topic || key.startsWith("area:")) && (
          <button type="button" className="lt-more" aria-label={t("links.tree.more", { name: typeof label === "string" ? label : "" })} aria-expanded={menu === key}
            onClick={(event) => { event.stopPropagation(); setMenu(menu === key ? null : key); }}><Icon name="more" /></button>
        )}
        {menu === key && <Menu onClose={() => setMenu(null)}>
          {(key.startsWith("area:") || topicDepth(tree, key) < MAX_TOPIC_DEPTH) && (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); if (!open.has(key)) onToggle(key); setNaming({ node: key, mode: "child" }); }}>
              {t(key.startsWith("area:") ? "links.tree.newTop" : "links.tree.newChild")}</button>
          )}
          {opts.topic && <>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); setNaming({ node: key, mode: "rename" }); }}>{t("links.tree.rename")}</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); setMerging(key); }}>{t("links.tree.merge")}</button>
            <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => {
              setMenu(null);
              const name = tree.byId.get(key)?.name ?? "";
              void run("link.topic", { id: key, remove: true }, (result) => {
                if (node === key) onPick(tree.byId.get(key)?.parentId ?? "all");
                onSaid(t("links.tree.removed", { name, n: (result as { moved?: number })?.moved ?? 0 }));
              });
            }}>{t("links.tree.remove")}</button>
          </>}
        </Menu>}
      </div>
    );
  };

  const branch = (parent: string, depth: number): ReactNode[] => (tree.children.get(parent) ?? []).flatMap((topic) => {
    if (searching && !counts.get(topic.id)) return [];
    const kids = (tree.children.get(topic.id) ?? []).length > 0;
    return [
      row(topic.id, depth, topic.name, { kids, topic: topic.id }),
      ...((searching || open.has(topic.id)) ? branch(topic.id, depth + 1) : []),
      ...(naming?.node === topic.id && naming.mode === "child" ? [newRow(topic.id, depth + 1)] : []),
    ];
  });
  const newRow = (parent: string, depth: number) => (
    <div key={parent + ":new"} className="lt-node" style={{ "--d": depth } as CSSProperties}>
      <span className="lt-twist" aria-hidden="true" />
      <NameInput initial="" placeholder={t("links.tree.newName")} onDone={(name) => {
        setNaming(null);
        if (name) void run("link.topic", parent.startsWith("area:") ? { name, area: parent.slice(5) } : { name, parentId: parent });
      }} />
    </div>
  );

  return (
    <nav className="lt" aria-label={t("links.tree.label")}>
      <div role="tree" aria-label={t("links.tree.label")}>
        {row("all", 0, t("links.tree.all"), { strong: true })}
        {!searching && row("recent", 0, t("links.recent"))}
        <div className="lt-sep" />
        {tree.roots.map((root) => {
          if (searching && !counts.get(root)) return null;
          const k = root === "area:" ? "gray" : area(root.slice(5))?.k ?? "gray";
          const kids = (tree.children.get(root) ?? []).length > 0;
          return [
            row(root, 0, areaName(root), { dot: k, kids, strong: true }),
            ...((searching || open.has(root)) ? branch(root, 1) : []),
            ...(naming?.node === root && naming.mode === "child" ? [newRow(root, 1)] : []),
          ];
        })}
        {!searching && <NewCategory areas={areas} onAdd={(area, name) => void run("link.topic", { name, area }, () => { if (!open.has(`area:${area}`)) onToggle(`area:${area}`); })} />}
        {(counts.get("none") ?? 0) > 0 && <><div className="lt-sep" />{row("none", 0, t("links.tree.none"))}</>}
      </div>
      {merging && <MergePick tree={tree} areaName={areaName} from={merging} onClose={() => setMerging(null)}
        onPick={(into) => { const from = merging; setMerging(null); void run("link.merge", { id: from, into }, () => { if (node === from) onPick(into); onSaid(t("links.tree.merged", { name: tree.byId.get(from)?.name ?? "", into: tree.byId.get(into)?.name ?? "" })); }); }} />}
    </nav>
  );
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone(name: string): void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => { if (done.current) return; done.current = true; onDone(name.trim()); };
  return <input className="lt-input" autoFocus value={value} maxLength={60} placeholder={placeholder} aria-label={placeholder ?? t("links.tree.rename")}
    onClick={(event) => event.stopPropagation()} onChange={(event) => setValue(event.target.value)} onBlur={() => finish(value === initial ? "" : value)}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") finish(value === initial ? "" : value);
      if (event.key === "Escape") finish("");
    }} />;
}

/** A category in any area, from the foot of the tree: the area first (our own menu), then its name. */
function NewCategory({ areas, onAdd }: { areas: Area[]; onAdd(area: string, name: string): void }) {
  const [area, setArea] = useState<string | null>(null);
  if (area === null) return <button type="button" className="lt-add" onClick={() => setArea(areas[0]?.id ?? "")}><Icon name="plus" />{t("links.tree.newTop")}</button>;
  const k = areas.find((candidate) => candidate.id === area)?.k ?? "gray";
  return <div className="lt-new" data-k={k}>
    <Select className="lt-new-area" label={t("links.tree.newArea")} value={area} options={areas.map((candidate) => ({ value: candidate.id, label: candidate.name }))} onChange={setArea}>
      <span className="lt-dot" />{areas.find((candidate) => candidate.id === area)?.name}
    </Select>
    <input className="lt-input" autoFocus maxLength={60} placeholder={t("links.tree.newName")} aria-label={t("links.tree.newName")}
      // Choosing the area moves focus to its menu, inside this row: that is not leaving.
      onBlur={(event) => { if (!(event.relatedTarget as Element | null)?.closest(".lt-new")) setArea(null); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const name = event.currentTarget.value.trim();
        if (event.key === "Enter" && name) { const where = area; setArea(null); onAdd(where, name); }
        if (event.key === "Escape") setArea(null);
      }} />
  </div>;
}

export function Menu({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    box.current?.querySelector("button")?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [onClose]);
  return <div ref={box} className="lt-menu" role="menu" onClick={(event) => event.stopPropagation()}>{children}</div>;
}

/** Choosing the category another one joins. */
function MergePick({ tree, areaName, from, onPick, onClose }: { tree: Tree; areaName(key: string): string; from: string; onPick(into: string): void; onClose(): void }) {
  const gone = new Set<string>([from]);
  for (const child of tree.children.get(from) ?? []) gone.add(child.id);
  const name = tree.byId.get(from)?.name ?? "";
  return <Pop onClose={onClose}>
    <div className="ev-edit lt-pick" role="dialog" aria-label={t("links.tree.mergeInto", { name })}>
      <h3>{t("links.tree.mergeInto", { name })}</h3>
      <p className="quiet">{t("links.tree.mergeHint")}</p>
      <TopicList tree={tree} areaName={areaName} skip={gone} onPick={onPick} />
      <div className="lr-foot"><span /><button type="button" className="lk-btn" onClick={onClose}>{t("common.cancel")}</button></div>
    </div>
  </Pop>;
}

/** Every category, indented under its area, to choose one. */
export function TopicList({ tree, areaName, skip, value, onPick }: { tree: Tree; areaName(key: string): string; skip?: Set<string>; value?: string; onPick(id: string): void }) {
  const rows: ReactNode[] = [];
  const walk = (parent: string, depth: number) => {
    for (const topic of tree.children.get(parent) ?? []) {
      if (skip?.has(topic.id)) continue;
      rows.push(<button key={topic.id} type="button" role="option" aria-selected={value === topic.id} className="lt-option" style={{ "--d": depth } as CSSProperties}
        onClick={() => onPick(topic.id)}>{topic.name}</button>);
      walk(topic.id, depth + 1);
    }
  };
  for (const root of tree.roots) {
    rows.push(<p key={root} className="lt-option-area">{areaName(root)}</p>);
    walk(root, 1);
  }
  return <div className="lt-options" role="listbox">{rows}</div>;
}
