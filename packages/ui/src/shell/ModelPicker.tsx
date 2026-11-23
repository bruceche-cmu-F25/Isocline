import { useEffect, useState } from "react";
import type { EngineModel } from "@alfred/protocol";
import { api } from "../api.ts";
import { Logo, modelMark } from "../brand/Logo.tsx";
import { t } from "../i18n/index.ts";
import { Icon } from "./icons.tsx";
import { Select, type Choice } from "./Select.tsx";

/** A null choice follows the home node's preference, then the engine's own default. */
export function ModelPicker({ model, preferred, onChange, disabled }: {
  model: string | null; preferred?: string | null; onChange(model: string | null): void; disabled?: boolean;
}) {
  const [models, setModels] = useState<EngineModel[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    api.models().then((response) => {
      if (active) { setModels(response.models ?? []); setStatus("ready"); }
    }, () => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [attempt]);

  const idOf = (item: EngineModel) => `${item.provider}/${item.id}`;
  const engineDefault = models.find((item) => item.engineDefault);
  const fallback = preferred ?? (engineDefault ? idOf(engineDefault) : undefined);
  const defaultName = models.find((item) => idOf(item) === fallback)?.name ?? fallback?.split("/").slice(1).join("/");
  const defaultLabel = defaultName ? `${t("conv.defaultModel")} · ${defaultName}` : t("conv.defaultModel");
  const options: Choice[] = [{ value: "", label: defaultLabel, short: defaultName }];
  for (const item of models) {
    const input = item.supportsImages === undefined ? "" : ` · ${t(item.supportsImages ? "model.images" : "model.textOnly")}`;
    options.push({ value: idOf(item), label: `${item.name} · ${item.provider}${input}`, short: item.name });
  }
  if (model && !options.some((option) => option.value === model)) options.push({ value: model, label: model });
  if (status === "failed") options.push({ value: "retry", label: t("conv.retryModels") });
  else if (!models.length) options.push({ value: "status", label: t(status === "loading" ? "auto.loading" : "conv.noModels"), disabled: true });

  const mark = modelMark(model ?? fallback ?? null);
  return <Select className="pick model-picker" label={t("conv.model")} value={model ?? ""} options={options} disabled={disabled}
    icon={mark ? <Logo name={mark} /> : <Icon name="model" />}
    onChange={(value) => { if (value === "retry") setAttempt((n) => n + 1); else onChange(value || null); }} />;
}
