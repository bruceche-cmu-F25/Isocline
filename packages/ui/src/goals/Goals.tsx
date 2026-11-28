/** The Goals mode (docs/design/goals.md 4.13; G1): one long-term goal at a time. The sidebar says which goal and
 * lists its three pages and the steps of the stage at hand; the page is the desk, the big picture or the route.
 *
 * A goal is a folder of the notes. The big picture and the route are read from their pages by their headings and
 * shown as a board and as steps; changing them by hand is the notes' own editor on the same page. Nothing here asks
 * a model for anything yet, and nothing judges the user: a step is done when they say so. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GoalDetail, GoalsSnapshot, GoalStep, GoalSummary } from "@zirma/module-goals/types";
import type { NotesSnapshot, PageDetail } from "@zirma/module-notes/types";
import { PickerPill } from "../AddBar.tsx";
import { api } from "../api.ts";
import { intlLocale, t } from "../i18n/index.ts";
import { Markdown } from "../Markdown.tsx";
import type { OpName } from "../modules.ts";
import { NoteEditor, type EditorHandle, type SaveState } from "../notes/NoteEditor.tsx";
import { Icon, type IconName } from "../shell/icons.tsx";
import { Pop } from "../shell/Pop.tsx";
import "../side-tree.css";
import "../notes/notes.css";
import "./goals.css";

type View = "desk" | "picture" | "route";
const VIEWS: readonly View[] = ["desk", "picture", "route"];
const VIEW_ICON: Record<View, IconName> = { desk: "desk", picture: "globe", route: "route" };
const PAGE = "goal.home";
const KEPT = "zirma.goal";

type Answer = { error?: string; code?: string; id?: string; page?: string; key?: string; entry?: string | null; ok?: boolean };
async function op(name: OpName, input: unknown): Promise<Answer> {
  const response = await api.op(name, input);
  return (response.result ?? {}) as Answer;
}

/** Where the address points: a goal and one of its pages (`<id>/route`), or the page for a new goal. */
function place(item: string | null): { goal: string | null; view: View } {
  if (!item || item === "new") return { goal: null, view: "desk" };
  const [goal, view] = item.split("/");
  return { goal: goal || null, view: VIEWS.includes(view as View) ? view as View : "desk" };
}
function kept(): string | null { try { return localStorage.getItem(KEPT); } catch { return null; } }
function keep(item: string): void { try { localStorage.setItem(KEPT, item); } catch { /* not remembered; fine */ } }

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** The last day of the month `months` from now: a deadline is a rough day, not an exact one. */
const monthEnd = (months: number, now = new Date()) => iso(new Date(now.getFullYear(), now.getMonth() + months + 1, 0));

/** A deadline in words: "the end of May" when it is a month's last day, the date otherwise; the year when it is not this one. */
function dateWord(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d), sameYear = y === new Date().getFullYear();
  if (new Date(y, m, 0).getDate() === d) return t(sameYear ? "goals.monthEnd" : "goals.monthEndYear", { m, y, month: date.toLocaleDateString(intlLocale(), { month: "long" }) });
  return date.toLocaleDateString(intlLocale(), sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" });
}
const objective = (goal: Pick<GoalSummary, "sentence" | "deadline">) => (goal.deadline ? t("goals.objective", { date: dateWord(goal.deadline), sentence: goal.sentence }) : goal.sentence);

/** The stage at hand: the first with a step not done yet; when every step is done, the last one that has steps. */
function stageAtHand(goal: GoalSummary) {
  const laidOut = goal.stages.filter((stage) => stage.steps.length);
  return laidOut.find((stage) => stage.steps.some((step) => !step.done)) ?? laidOut.at(-1) ?? null;
}

export function Goals({ snapshot, notes, item, go, side }: {
  snapshot: GoalsSnapshot | undefined;
  notes: NotesSnapshot | undefined;
  item: string | null;
  go(page: string, item?: string): void;
  side: HTMLElement | null;
}) {
  const goals = snapshot?.goals ?? [];
  // With nothing named in the address: back where this device last was, else the first goal, else a new one.
  const asked = item ?? (() => {
    const last = kept();
    return last && goals.some((goal) => goal.id === place(last).goal) ? last : goals[0] ? `${goals[0].id}/desk` : "new";
  })();
  const { goal: goalId, view } = place(asked);
  const listed = goals.find((goal) => goal.id === goalId);

  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const [card, setCard] = useState(false);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ which: "picture" | "route"; page: PageDetail } | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const editor = useRef<EditorHandle>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // The goal as its files say it now; read again when the index says something about it changed.
  const stamp = JSON.stringify(listed ?? null);
  useEffect(() => {
    if (!goalId) { setDetail(null); return; }
    let alive = true;
    api.query<GoalDetail & { error?: string }>("goal.detail", { id: goalId }).then((found) => {
      if (!alive) return;
      if (found.error) { setDetail(null); setGone(goalId); } else { setDetail(found); setGone(null); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [goalId, stamp, tick]);
  useEffect(() => { if (goalId) keep(`${goalId}/${view}`); }, [goalId, view]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 6000); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!menu) return;
    const away = (down: PointerEvent) => { if (!(down.target as HTMLElement).closest?.(".gl-pick-wrap")) setMenu(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);

  const goal = detail?.id === goalId ? detail : null;
  const shown: GoalSummary | null = goal ?? listed ?? null;
  const fresh = !goalId || gone === goalId;

  /** Leaves the editor, with its last words saved, before going anywhere else. */
  const closeEditor = async () => {
    if (!editing) return;
    await editor.current?.flush();
    setEditing(null);
    setSave({ kind: "saved" });
    reload();
  };
  const open = async (to: string) => { await closeEditor(); setMenu(false); go(PAGE, to); };
  const fail = (answer: Answer) => { if (answer.error) setToast({ text: t("goals.failed") }); return !!answer.error; };

  const edit = async (which: "picture" | "route") => {
    if (!goal) return;
    const made = await op("goal.page", { id: goal.id, which });
    if (fail(made) || !made.page) return;
    const page = await api.query<PageDetail & { error?: string }>("note.page", { id: made.page });
    if (page.error) { setToast({ text: t("goals.failed") }); return; }
    setSave({ kind: "saved" });
    setEditing({ which, page });
  };
  const setDone = async (step: GoalStep, done: boolean) => {
    if (!goal) return;
    const answer = await op("goal.step", { id: goal.id, step: step.key, done });
    if (fail(answer)) return;
    // A step that just got its id is still the open one.
    if (openStep === step.key && answer.key) setOpenStep(answer.key);
    reload();
  };
  /** The page of the notes a link names, if there is one. */
  const linked = (target: string) => {
    const name = target.toLowerCase().replace(/\.md$/, "");
    return (notes?.pages ?? []).find((one) => one.id.toLowerCase() === name || one.title.toLowerCase() === name);
  };
  const exists = (target: string) => !!linked(target);

  /* ── The sidebar ── */
  const stage = shown ? stageAtHand(shown) : null;
  const sideEl = (
    <div className="st-list gl-side" data-k="violet">
      {!fresh && shown ? (
        <>
          <div className="gl-pick-wrap">
            <button type="button" className="gl-pick" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((was) => !was)} title={shown.sentence}>
              <Icon name="scope" /><span className="st-name">{shown.name}</span><Icon name="down" />
            </button>
            {menu && (
              <div className="gl-menu" role="menu" aria-label={t("page.goals")}>
                {goals.map((one) => (
                  <button type="button" key={one.id} role="menuitemradio" aria-checked={one.id === shown.id} onClick={() => void open(`${one.id}/desk`)}>
                    <span className="gl-ck">{one.id === shown.id && <Icon name="check" />}</span><span className="st-name">{one.name}</span>
                  </button>
                ))}
                <hr />
                <button type="button" role="menuitem" onClick={() => void open("new")}><span className="gl-ck"><Icon name="plus" /></span><span className="st-name">{t("goals.new")}</span></button>
              </div>
            )}
          </div>
          {VIEWS.map((one) => (
            <button type="button" key={one} className="st-node" aria-current={view === one ? "true" : undefined} onClick={() => void open(`${shown.id}/${one}`)}>
              <span className="st-space" /><Icon name={VIEW_ICON[one]} /><span className="st-name">{t(`goals.view.${one}`)}</span>
            </button>
          ))}
          {stage && (
            <>
              <p className="st-label"><span className="st-name">{t("goals.thisStage", { stage: stage.title })}</span></p>
              {stage.steps.map((step) => (
                <button type="button" key={step.key} className="st-node gl-side-step" data-done={step.done || undefined} title={t(step.done ? "goals.st.done" : "goals.st.none")}
                  onClick={() => { setOpenStep(step.key); void open(`${shown.id}/route`); }}>
                  <span className="st-space" /><Icon name={step.done ? "ringDone" : "ring"} /><span className="st-name">{step.title}</span>
                </button>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <p className="st-label">{t("page.goals")}</p>
          {goals.map((one) => (
            <button type="button" key={one.id} className="st-node" onClick={() => void open(`${one.id}/desk`)} title={one.sentence}>
              <span className="st-space" /><Icon name="scope" /><span className="st-name">{one.name}</span>
            </button>
          ))}
          <button type="button" className="st-node" aria-current="true"><span className="st-space" /><Icon name="plus" /><span className="st-name">{t("goals.new")}</span></button>
        </>
      )}
    </div>
  );

  /* ── The page ── */
  let body: ReactNode = null;
  if (fresh) {
    body = <NewGoal onMade={(id) => void open(`${id}/picture`)} onFailed={() => setToast({ text: t("goals.failed") })} />;
  } else if (goal && editing) {
    const state = save.kind;
    body = (
      <div className="gl-col gl-edit">
        <header className="gl-head">
          <h2>{t(`goals.view.${editing.which}`)}</h2>
          <span className="gl-saved" data-state={state} role="status">{t(state === "saved" ? "goals.edit.saved" : state === "saving" ? "goals.edit.saving" : "goals.edit.unsaved")}</span>
          <button type="button" className="nt-btn nt-pri" onClick={() => void closeEditor()}>{t("goals.edit.done")}</button>
        </header>
        <p className="gl-hint">{t(`goals.${editing.which}.shape`)}</p>
        {save.kind === "changed" && (
          <div className="nt-banner" role="alert">
            <span>{t("goals.edit.changed")}</span>
            {save.current && <button type="button" className="nt-btn" onClick={() => { editor.current?.load(save.current!.text, save.current!.fp); setSave({ kind: "saved" }); }}>{t("goals.edit.theirs")}</button>}
          </div>
        )}
        {(save.kind === "offline" || save.kind === "library" || save.kind === "unsaved") && <p className="nt-banner" role="alert">{t("goals.edit.notSaved")}</p>}
        <NoteEditor key={`${editing.page.library}:${editing.page.id}`} detail={editing.page} readOnly={false} handle={editor} onState={setSave}
          onLink={(target) => { const page = linked(target); if (page) void closeEditor().then(() => go("note.list", page.id)); }}
          exists={exists} onError={(message) => setToast({ text: message })} />
      </div>
    );
  } else if (goal) {
    const head = (which: "picture" | "route", empty: boolean) => (
      <header className="gl-head">
        <h2>{t(`goals.view.${which}`)}</h2>
        {!empty && <button type="button" className="nt-btn" onClick={() => void edit(which)}><Icon name="write" />{t("goals.edit")}</button>}
      </header>
    );
    const blank = (which: "picture" | "route") => (
      <div className="gl-empty">
        <p className="gl-empty-title">{t(`goals.${which}.empty`)}</p>
        <p>{t(`goals.${which}.emptyHint`)}</p>
        <p className="gl-hint">{t(`goals.${which}.shape`)}</p>
        <button type="button" className="nt-btn nt-pri" onClick={() => void edit(which)}><Icon name="write" />{t("goals.write")}</button>
      </div>
    );
    const stepButton = (step: GoalStep) => (
      <button type="button" className={step.done ? "nt-btn" : "nt-btn nt-pri"} onClick={() => void setDone(step, !step.done)}>
        {!step.done && <Icon name="check" />}{t(step.done ? "goals.step.undo" : "goals.step.done")}
      </button>
    );
    if (view === "picture") {
      const { whole, parts, more } = goal.picture;
      const empty = !whole && !parts.length && !more.length;
      const picked = parts.flatMap((part, p) => part.topics.map((topic, i) => ({ key: `${p}:${i}`, part, topic }))).find((one) => one.key === openTopic);
      body = (
        <div className="gl-col gl-wide">
          {head("picture", empty)}
          {empty ? blank("picture") : (
            <>
              {whole && <Markdown className="gl-whole" text={whole} />}
              {parts.length > 0 && (
                <div className="gl-board">
                  {parts.map((part, p) => (
                    <section className="gl-part" key={p} aria-label={part.title || undefined}>
                      {part.title && <h3>{part.title}</h3>}
                      {part.line && <Markdown className="gl-line" text={part.line} />}
                      {part.topics.map((topic, i) => (
                        <button type="button" key={i} className="gl-row" aria-expanded={openTopic === `${p}:${i}`} onClick={() => setOpenTopic((was) => (was === `${p}:${i}` ? null : `${p}:${i}`))}>{topic.title}</button>
                      ))}
                    </section>
                  ))}
                </div>
              )}
              {picked && (
                <article className="gl-topic" aria-live="polite">
                  {picked.part.title && <p className="gl-over">{picked.part.title}</p>}
                  <h3>{picked.topic.title}</h3>
                  {picked.topic.body ? <Markdown text={picked.topic.body} /> : <p className="quiet">{t("goals.picture.noBody")}</p>}
                </article>
              )}
              {more.map((section, index) => (
                <section className="gl-more" key={index}>
                  {section.title && <h4>{section.title}</h4>}
                  {section.text && <Markdown text={section.text} />}
                </section>
              ))}
            </>
          )}
        </div>
      );
    } else if (view === "route") {
      const { intro, stages } = goal.route;
      const empty = !intro && !stages.length;
      body = (
        <div className="gl-col">
          {head("route", empty)}
          {empty ? blank("route") : (
            <>
              {intro && <Markdown className="gl-whole" text={intro} />}
              {stages.map((one, at) => (
                <section className="gl-stage" key={at} data-later={!one.steps.length || undefined}>
                  {one.title && <h3>{one.title}</h3>}
                  {one.note && <Markdown className="gl-line" text={one.note} />}
                  {one.steps.length > 0 && (
                    <ol className="gl-steps">
                      {one.steps.map((step) => (
                        <li key={step.key} data-done={step.done || undefined}>
                          <button type="button" className="gl-step" aria-expanded={openStep === step.key} onClick={() => setOpenStep((was) => (was === step.key ? null : step.key))}>
                            <Icon name={step.done ? "ringDone" : "ring"} /><span className="gl-step-name">{step.title}</span>
                            {step.done && <span className="gl-st">{t("goals.st.done")}</span>}
                          </button>
                          {openStep === step.key && (
                            <div className="gl-step-body">
                              {step.body && <Markdown text={step.body} />}
                              <div className="gl-acts">{stepButton(step)}</div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      );
    } else {
      const steps = goal.route.stages.flatMap((one) => one.steps.map((step) => ({ step, stage: one })));
      const next = steps.find((one) => !one.step.done);
      body = (
        <div className="gl-col">
          {next ? (
            <article className="gl-now">
              <p className="gl-over">{next.stage.title ? t("goals.desk.step", { stage: next.stage.title }) : t("goals.desk.stepOnly")}</p>
              <h2>{next.step.title}</h2>
              {next.step.body && <Markdown text={next.step.body} />}
              <div className="gl-acts">
                {stepButton(next.step)}
                <button type="button" className="nt-btn" onClick={() => { setOpenStep(next.step.key); void open(`${goal.id}/route`); }}><Icon name="route" />{t("goals.desk.seeRoute")}</button>
              </div>
            </article>
          ) : (
            <div className="gl-empty">
              <p className="gl-empty-title">{t(steps.length ? "goals.desk.allDone" : "goals.desk.empty")}</p>
              <p>{t(steps.length ? "goals.desk.allDoneHint" : "goals.desk.emptyHint")}</p>
              <div className="gl-acts">
                {!steps.length && <button type="button" className="nt-btn" onClick={() => void open(`${goal.id}/picture`)}><Icon name="globe" />{t("goals.view.picture")}</button>}
                <button type="button" className="nt-btn" onClick={() => void open(`${goal.id}/route`)}><Icon name="route" />{t("goals.view.route")}</button>
              </div>
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <section className="goals" data-k="violet" aria-label={t("page.goals")}>
      {side ? createPortal(sideEl, side) : <aside className="gl-side-here">{sideEl}</aside>}
      <div className="gl-main">
        {!fresh && shown && (
          <div className="gl-obj">
            <button type="button" className="gl-objb" onClick={() => setCard(true)} disabled={!goal} title={t("goals.obj.title")}>{objective(goal ?? shown)}</button>
          </div>
        )}
        <div className="gl-scroll">{body}</div>
        {toast && (
          <div className="nt-toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && <button type="button" onClick={() => { toast.undo!(); setToast(null); }}>{t("goals.undo")}</button>}
          </div>
        )}
      </div>
      {card && goal && (
        <GoalCard goal={goal} onClose={() => setCard(false)} onSaved={reload} onFailed={() => setToast({ text: t("goals.failed") })}
          onRemoved={(entry) => {
            setCard(false);
            const name = goal.name, id = goal.id;
            const rest = goals.find((one) => one.id !== id);
            void open(rest ? `${rest.id}/desk` : "new");
            setToast({ text: t("goals.removed", { name }), undo: entry ? () => { void op("goal.restore", { entry }).then((answer) => { if (!fail(answer)) go(PAGE, `${id}/desk`); }); } : undefined });
          }} />
      )}
    </section>
  );
}

/** The page for a goal that does not exist yet: one question, and the user's own sentence as the answer. */
function NewGoal({ onMade, onFailed }: { onMade(id: string): void; onFailed(): void }) {
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const words = sentence.trim();
    if (!words || busy) return;
    setBusy(true);
    try {
      const made = await op("goal.create", { sentence: words });
      if (made.id) onMade(made.id); else onFailed();
    } catch { onFailed(); } finally { setBusy(false); }
  };
  return (
    <div className="gl-col gl-new">
      <h2>{t("goals.new.title")}</h2>
      <p>{t("goals.new.lead")}</p>
      <form onSubmit={(event) => void submit(event)}>
        <textarea value={sentence} rows={2} maxLength={500} autoFocus aria-label={t("goals.new.label")} placeholder={t("goals.new.placeholder")}
          onChange={(event) => setSentence(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        <button type="submit" className="nt-btn nt-pri" disabled={!sentence.trim() || busy}>{t("goals.new.go")}</button>
      </form>
    </div>
  );
}

const PACES = [1, 2, 3, 4, 5, 6, 7];
const AHEAD = [3, 6, 12] as const;

/** The goal's card: what the user wants to reach and why, in their words; a deadline and a pace if they want them;
 * the folder's name. Every field is theirs: Zirma writes none of them. */
function GoalCard({ goal, onClose, onSaved, onRemoved, onFailed }: { goal: GoalDetail; onClose(): void; onSaved(): void; onRemoved(entry: string | null): void; onFailed(): void }) {
  const [sentence, setSentence] = useState(goal.sentence);
  const [why, setWhy] = useState(goal.why);
  const [deadline, setDeadline] = useState<string | null>(goal.deadline);
  const [pace, setPace] = useState<number | null>(goal.pace);
  const [name, setName] = useState(goal.name);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !sentence.trim() || !name.trim()) return;
    const patch = {
      ...(sentence.trim() !== goal.sentence ? { sentence: sentence.trim() } : {}),
      ...(why.trim() !== goal.why ? { why: why.trim() } : {}),
      ...(deadline !== goal.deadline ? { deadline } : {}),
      ...(pace !== goal.pace ? { pace } : {}),
      ...(name.trim() !== goal.name ? { name: name.trim() } : {}),
    };
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true);
    try {
      const answer = await op("goal.update", { id: goal.id, ...patch });
      if (answer.error) onFailed(); else { onSaved(); onClose(); }
    } catch { onFailed(); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const answer = await op("goal.remove", { id: goal.id });
      if (answer.error) onFailed(); else onRemoved(answer.entry ?? null);
    } catch { onFailed(); } finally { setBusy(false); }
  };
  return (
    <Pop onClose={onClose}>
      <form className="ev-edit gl-card" data-k="violet" onSubmit={(event) => void submit(event)} aria-label={t("goals.card.label")}>
        <label className="gl-field">
          <span>{t("goals.card.goal")}</span>
          <textarea value={sentence} rows={2} maxLength={500} onChange={(event) => setSentence(event.target.value)} />
        </label>
        <label className="gl-field">
          <span>{t("goals.card.why")}</span>
          <textarea value={why} rows={4} maxLength={4000} placeholder={t("goals.card.whyHint")} onChange={(event) => setWhy(event.target.value)} />
        </label>
        <div className="gl-field">
          <span>{t("goals.card.deadline")}</span>
          <div className="gl-chips">
            {AHEAD.map((months) => (
              <button type="button" key={months} className="chip" aria-pressed={deadline === monthEnd(months)} onClick={() => setDeadline(monthEnd(months))}>{t(`goals.card.in${months}`)}</button>
            ))}
            <PickerPill type="date" icon="day" value={deadline ?? ""} empty={t("goals.card.pickDay")} text={deadline ? dateWord(deadline) : undefined} label={t("goals.card.deadline")}
              onChange={(value) => setDeadline(value || null)} />
          </div>
        </div>
        <div className="gl-field">
          <span>{t("goals.card.pace")}</span>
          <div className="gl-chips" role="radiogroup" aria-label={t("goals.card.pace")}>
            {PACES.map((n) => (
              <button type="button" key={n} role="radio" className="chip gl-n" aria-checked={pace === n} aria-pressed={pace === n} onClick={() => setPace(pace === n ? null : n)}>{n}</button>
            ))}
            <span className="gl-unit">{t("goals.card.paceUnit")}</span>
          </div>
        </div>
        <label className="gl-field">
          <span>{t("goals.card.name")}</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        {removing ? (
          <div className="gl-foot" role="alert">
            <span className="gl-ask">{t("goals.card.removeAsk")}</span>
            <button type="button" className="nt-btn" onClick={() => setRemoving(false)}>{t("common.cancel")}</button>
            <button type="button" className="nt-btn gl-bad" disabled={busy} onClick={() => void remove()}>{t("goals.card.removeYes")}</button>
          </div>
        ) : (
          <div className="gl-foot">
            <button type="button" className="link gl-remove" onClick={() => setRemoving(true)}>{t("goals.card.remove")}</button>
            <span className="gl-grow" />
            <button type="button" className="nt-btn" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className="nt-btn nt-pri" disabled={busy || !sentence.trim() || !name.trim()}>{t("goals.card.save")}</button>
          </div>
        )}
      </form>
    </Pop>
  );
}
