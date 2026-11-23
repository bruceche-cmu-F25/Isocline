import { useRef, type FormEvent, type ReactNode } from "react";

/** The line a page adds things with (a todo, a link): one rounded field, as the ask bar under the page is, with
 * the words first, what goes with them as small pills inside it (a day, an hour, an area, a topic), and a round
 * button at the end. The whole field lights when any part of it has focus; the pills are quiet until they are set. */
export function AddBar({ value, onChange, onSubmit, placeholder, label, submitLabel, showSubmitLabel, ready, busy, maxLength, spellCheck, children }: {
  value: string; onChange(value: string): void; onSubmit(): void; placeholder: string; label: string; submitLabel: string;
  showSubmitLabel?: boolean; ready: boolean; busy?: boolean; maxLength?: number; spellCheck?: boolean; children?: ReactNode;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (ready && !busy) onSubmit(); };
  return (
    <form className="add-bar" onSubmit={submit}>
      <input className="add-text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label}
        maxLength={maxLength} spellCheck={spellCheck} />
      {children && <span className="add-pills">{children}</span>}
      <button type="submit" className="add-go" disabled={!ready || busy} aria-label={submitLabel} title={submitLabel}>
        {showSubmitLabel ? submitLabel : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5" /></svg>}
      </button>
    </form>
  );
}

const ICONS = {
  day: <path d="M3.5 5.5h13v11h-13zM3.5 8.5h13M7 3.5v3M13 3.5v3" />,
  hour: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.5" /></>,
  tag: <><path d="M3.5 3.5h6l7 7-6 6-7-7z" /><circle cx="7" cy="7" r="1" /></>,
  clear: <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" />,
};

/** A pill with a picker lying unseen over it: our Select, or a date or time field (opened with the system's own picker). */
export function Pill({ icon, text, set, k, label, onClear, children }: {
  icon: keyof typeof ICONS; text: string; set: boolean; k?: string; label: string; onClear?: () => void; children: ReactNode;
}) {
  return (
    <span className="add-pill" data-set={set || undefined} data-k={set ? k : undefined} title={label}>
      <svg viewBox="0 0 20 20" aria-hidden="true">{ICONS[icon]}</svg>
      <span className="add-pill-text">{text}</span>
      {children}
      {set && onClear && (
        <button type="button" className="add-pill-clear" onClick={onClear} aria-label={label}>
          <svg viewBox="0 0 20 20" aria-hidden="true">{ICONS.clear}</svg>
        </button>
      )}
    </span>
  );
}

/** A date or an hour, picked with the system's own picker. */
export function PickerPill({ type, value, onChange, icon, empty, text, label, k }: {
  type: "date" | "time"; value: string; onChange(value: string): void; icon: keyof typeof ICONS; empty: string; text?: string; label: string; k?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Pill icon={icon} text={value ? text ?? value : empty} set={!!value} k={k} label={label} onClear={() => onChange("")}>
      <input ref={input} type={type} value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}
        onClick={() => { try { input.current?.showPicker(); } catch { /* not every browser has it; the field still takes typing */ } }} />
    </Pill>
  );
}
