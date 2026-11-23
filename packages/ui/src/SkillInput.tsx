/** A leading slash opens Alfred's installed skills and the ones available to add on this Mac. */
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type RefObject } from "react";
import type { FoundSkill, SkillInfo, SkillsResponse } from "@alfred/protocol";
import { ApiError, request } from "./api.ts";
import { t } from "./i18n/index.ts";
import "./skill-input.css";

type Option = SkillInfo | FoundSkill;
type Props = Omit<ComponentProps<"textarea">, "ref" | "value" | "onChange"> & {
  field?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange(value: string): void;
  skills?: boolean;
};

function matches(catalog: SkillsResponse, query: string): Option[] {
  const choices: Option[] = [...catalog.skills.filter((skill) => skill.enabled), ...catalog.found];
  const rank = (skill: Option) => {
    const name = skill.name.toLowerCase();
    if (name.startsWith(query)) return 0;
    if (name.includes(query)) return 1;
    if (skill.description.toLowerCase().includes(query)) return 2;
    return 3;
  };
  return choices.filter((skill) => rank(skill) < 3).sort((a, b) => rank(a) - rank(b));
}

export function SkillInput({ field, value, onValueChange, skills = true, onKeyDown, ...props }: Props) {
  const localField = useRef<HTMLTextAreaElement>(null);
  const input = field ?? localField;
  const menu = useRef<HTMLDivElement>(null);
  const editRevision = useRef(0);
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [catalog, setCatalog] = useState<SkillsResponse | null>(null);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const query = /^\/(?:skill:)?([^\s/:]*)$/u.exec(value)?.[1]?.toLowerCase();
  const open = skills && focused && !dismissed && query !== undefined;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCatalog(null);
    setError("");
    request<SkillsResponse>("/api/skills").then((result) => {
      if (active) setCatalog(result);
    }, (reason: Error) => {
      if (active) setError(reason instanceof ApiError && reason.code === "local_only" ? t("skills.localOnly") : reason.message);
    });
    return () => { active = false; };
  }, [open]);

  const options = open && catalog ? matches(catalog, query) : [];
  const activeIndex = Math.min(index, options.length - 1);
  const choose = async (skill: Option) => {
    if (adding) return;
    const element = input.current;
    if (!element) return;
    const revision = editRevision.current;
    let name = skill.name;
    if ("path" in skill) {
      setAdding(true);
      setError("");
      try {
        const installed = await request<SkillInfo>("/api/skills/add", { path: skill.path });
        setCatalog((old) => old && ({ ...old, skills: [...old.skills, installed], found: old.found.filter((entry) => entry.path !== skill.path) }));
        if (!installed.enabled) { setError(t("skills.enableFirst")); return; }
        name = installed.name;
      } catch (reason) { setError((reason as Error).message); return; }
      finally { setAdding(false); }
    }
    // An import can finish after the user edits the draft, changes focus, or leaves this session.
    if (revision !== editRevision.current || element !== document.activeElement || element.value !== value) return;
    onValueChange(`/skill:${name} `);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editRevision.current++; setDismissed(true); return; }
      if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const next = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        setIndex(next);
        menu.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter" && (activeIndex >= 0 || (!catalog && !error))) {
        event.preventDefault();
        if (activeIndex >= 0) void choose(options[activeIndex]);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return <>
    <textarea {...props} ref={input} value={value} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => { editRevision.current++; setFocused(false); }}
      onChange={(event) => { editRevision.current++; setIndex(0); setDismissed(false); onValueChange(event.target.value); }} onKeyDown={keyDown}
      aria-autocomplete={skills ? "list" : undefined} aria-controls={open ? id : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined} />
    {open && <div className="code-skill-menu" onMouseDown={(event) => event.preventDefault()}>
      <div className="code-skill-heading">{t("settings.tab.skills")}</div>
      {error && <p role="alert">{error}</p>}
      <div ref={menu} id={id} role="listbox" aria-label={t("settings.tab.skills")} aria-busy={adding || (!catalog && !error)}>
        {options.map((skill, i) => <button key={skill.name} type="button" tabIndex={-1} role="option" aria-selected={i === activeIndex}
          aria-disabled={adding || undefined} id={`${id}-${i}`} title={skill.description}
          onClick={() => void choose(skill)}>
          <b>{skill.name}</b>{"path" in skill && <small>{t("skills.addUse")}</small>}<span>{skill.description}</span>
        </button>)}
      </div>
      {!options.length && !error && <p role="status">{t(!catalog ? "auto.loading" : query ? "skills.find.none" : "skills.none")}</p>}
    </div>}
  </>;
}
