import { useEffect, useState } from "react";
import type { ProjectBranches } from "@alfred/protocol";
import { api } from "../api.ts";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";
import { Select, type Choice } from "./Select.tsx";

/** Prefix actual branch names so branches named "project" or "new" remain selectable. */
export type BranchTarget = "project" | "new" | `refs/heads/${string}`;
export const branchNameOf = (target: BranchTarget) => target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : undefined;

export function BranchPicker({ projectId, target, onChange }: {
  projectId: string; target: BranchTarget; onChange(target: BranchTarget): void;
}) {
  const [catalog, setCatalog] = useState<ProjectBranches | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api.projectBranches(projectId).then((next) => {
      if (active) { setCatalog(next); setFailed(false); }
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [projectId, refresh]);

  const current = catalog?.current;
  const options: Choice[] = [
    { value: "project", label: current ? t("dev.currentBranch", { name: current }) : t("dev.projectFolder") },
    ...(catalog?.branches ?? []).filter(({ name }) => name !== current).map(({ name, checkedOut }) => ({
      value: `refs/heads/${name}`, label: checkedOut ? t("dev.branchInUse", { name }) : name, disabled: checkedOut,
    })),
  ];
  if (!catalog && !failed) options.push({ value: "loading", label: t("auto.loading"), disabled: true });
  if (failed) options.push({ value: "refresh", label: t("dev.reloadBranches") });
  options.push({ value: "new", label: t("dev.newBranch") });
  return <Select className="pick branch-picker" label={t("dev.workOn")} value={target} options={options}
    icon={<Icon name="branch" />} onFocus={() => setRefresh((n) => n + 1)}
    onChange={(value) => { if (value === "refresh") setRefresh((n) => n + 1); else onChange(value as BranchTarget); }}>
    <span className="choice-value">{target === "project" ? current ?? t("dev.projectFolder")
      : target === "new" ? t("dev.newBranch") : branchNameOf(target)}</span>
  </Select>;
}
