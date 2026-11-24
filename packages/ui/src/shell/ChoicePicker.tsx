import type { ReactNode } from "react";
import type { SessionMode } from "@zirma/protocol";
import { Select, type Choice } from "./Select.tsx";

interface ChoicePickerProps {
  label: string;
  title?: string;
  value: string;
  options: Choice[];
  onChange(value: string): void;
  icon: ReactNode;
  mode?: SessionMode;
  fast?: boolean;
  /** Something other than the default is chosen: where the trigger is only an icon, its colour says so. */
  on?: boolean;
}

/** The composer's small pickers (model, thinking, mode): our Select, dressed as a quiet chip in the bar. */
export function ChoicePicker({ label, title, value, options, onChange, icon, mode, fast, on }: ChoicePickerProps) {
  return <Select label={label} title={title} value={value} options={options} onChange={onChange} icon={icon}
    className={`pick${mode ? " mode" : ""}`} data-mode={mode} data-fast={fast || undefined} data-on={on || undefined} />;
}
