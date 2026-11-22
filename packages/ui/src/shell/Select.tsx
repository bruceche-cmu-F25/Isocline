import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";

export interface Choice {
  value: string;
  label: string;
  /** A shorter name for the trigger on a narrow bar; the menu always shows `label`. */
  short?: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange" | "children"> {
  /** Names the control for screen readers and heads the open menu. */
  label: string;
  value: string;
  options: Choice[];
  onChange(value: string): void;
  icon?: ReactNode;
  /** What the closed trigger shows in place of the chosen option's name. */
  children?: ReactNode;
  /** The trigger lies unseen over its parent (a pill, a phone title), which draws what is chosen. */
  cover?: boolean;
}

/**
 * Our own select, in place of the browser's: a native <select> opens the system's menu (on a Mac, an NSMenu with
 * its blue highlight), which no page style reaches and which differs on every computer the web app runs on.
 * A select-only combobox: focus stays on the trigger, so Tab follows the page's normal order; the menu is portalled
 * to the body and placed above or below the trigger, wherever there is more room.
 */
export function Select({ label, value, options, onChange, icon, children, cover, className, title, disabled, ...rest }: SelectProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", time: 0 });
  const followKeyboard = useRef(true);
  const [highlight, setHighlight] = useState<string | null>(null);
  const open = highlight !== null;
  const enabled = options.filter((option) => !option.disabled);
  const selected = options.find((option) => option.value === value);
  const initial = selected && !selected.disabled ? selected : enabled[0];
  const active = enabled.find((option) => option.value === highlight) ?? initial;
  const activeIndex = active ? options.indexOf(active) : -1;
  const shown = selected?.label ?? value;

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!;
    const popup = menu.current!;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= window.innerHeight) { setHighlight(null); return; }
      const inset = 8, gap = 5;
      const above = anchor.top - inset - gap, below = window.innerHeight - anchor.bottom - inset - gap;
      popup.style.minWidth = `${Math.min(window.innerWidth - inset * 2, Math.max(156, anchor.width))}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(324, Math.max(above, below)))}px`;
      const box = popup.getBoundingClientRect();
      const roomBelow = below >= Math.min(box.height, 200);
      popup.style.top = `${roomBelow || below >= above ? anchor.bottom + gap : anchor.top - gap - box.height}px`;
      popup.style.left = `${Math.max(inset, Math.min(anchor.left, window.innerWidth - box.width - inset))}px`;
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.contains(target) && !popup.contains(target)) setHighlight(null);
    };
    const scrolled = (event: Event) => { if (!popup.contains(event.target as Node)) position(); };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(button);
    resize.observe(popup);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", position);
      typed.current.text = "";
      followKeyboard.current = true;
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open && followKeyboard.current && activeIndex >= 0) {
      document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex, id]);

  const choose = (option: Choice) => {
    setHighlight(null);
    if (option.value !== value) onChange(option.value);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !active) return;
    followKeyboard.current = true;
    const key = event.key;
    if (key === "Tab") { setHighlight(null); return; }
    if (key === "Escape") { if (!open) return; setHighlight(null); }
    else if (key === "Enter" || key === " ") {
      if (open) choose(active);
      else setHighlight(active.value);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      const next = enabled.indexOf(active) + (key === "ArrowDown" ? 1 : -1);
      setHighlight(open ? enabled[Math.max(0, Math.min(next, enabled.length - 1))].value : active.value);
    } else if (key === "Home" || key === "End") {
      if (!open) return;
      setHighlight(enabled[key === "Home" ? 0 : enabled.length - 1].value);
    } else if (key.length === 1) {
      const now = Date.now(), letter = key.toLocaleLowerCase();
      const prefix = now - typed.current.time < 600 && typed.current.text !== letter ? typed.current.text + letter : letter;
      typed.current = { text: prefix, time: now };
      const from = enabled.indexOf(active) + (prefix.length === 1 ? 1 : 0);
      const match = [...enabled.slice(from), ...enabled.slice(0, from)].find((option) => option.label.toLocaleLowerCase().startsWith(prefix));
      if (match) { if (open) setHighlight(match.value); else choose(match); }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return <>
    <button type="button" {...rest} ref={trigger} className={`choice-trigger${cover ? " choice-cover" : ""}${className ? ` ${className}` : ""}`} role="combobox"
      aria-label={`${label}: ${shown}`} title={title ?? (cover ? undefined : `${label}: ${shown}`)} disabled={disabled || !enabled.length}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
      onClick={(event) => { event.currentTarget.focus(); setHighlight(open ? null : initial?.value ?? null); }}
      onBlur={() => setHighlight(null)} onKeyDown={keyDown}>
      {!cover && <>
        {icon}
        {children ?? <span className="choice-value">{selected?.short ? <><span className="choice-long">{selected.label}</span><span className="choice-short">{selected.short}</span></> : shown}</span>}
        <svg className="caret" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>
      </>}
    </button>
    {open && createPortal(
      <div ref={menu} id={id} className="choice-menu" role="listbox" aria-label={label}
        onMouseDown={(event) => event.preventDefault()}>
        <div className="choice-heading" aria-hidden="true">{label}</div>
        {options.map((option, index) => (
          <button type="button" role="option" key={option.value} id={`${id}-${index}`} tabIndex={-1}
            className="choice-option" aria-selected={option.value === value} disabled={option.disabled}
            aria-disabled={option.disabled || undefined} data-active={index === activeIndex || undefined}
            onPointerMove={(event) => {
              if (event.pointerType === "mouse" && !option.disabled && index !== activeIndex) {
                followKeyboard.current = false;
                setHighlight(option.value);
              }
            }}
            onClick={() => choose(option)}>
            <span>{option.label}</span>{option.value === value && <Icon name="check" />}
          </button>
        ))}
      </div>, document.body,
    )}
  </>;
}
