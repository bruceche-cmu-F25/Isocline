/** What devices get from the goals module (StateResponse.modules.goal). No imports, so browser code can use them.
 * docs/design/goals.md §3 has the words: a goal is one long thing the user wants to reach; its big picture says what
 * the thing is and why; its route is the stages and steps of getting there. */

/** One step of the route. `key` names it in an operation: its block id in the route's file (`s3`), or `#<n>` (the
 * n-th step, from 1) while it has none. Whether it is done is the user's word, never Zirma's judgement. */
export interface GoalStep {
  key: string;
  title: string;
  done: boolean;
}

/** One stage of the route. A stage with no steps yet is a later stretch: one line, laid out when the user gets there. */
export interface GoalStage {
  title: string;
  steps: GoalStep[];
}

export interface GoalSummary {
  /** Stable: kept in the goal's own file, so renaming its folder loses nothing. */
  id: string;
  /** The folder's name: a short handle the user can change. */
  name: string;
  /** The goal in the user's own words. Zirma never rewrites it. */
  sentence: string;
  /** `YYYY-MM-DD`, the user's; null while they have not set one. */
  deadline: string | null;
  /** Sittings a week, the user's; null while not set. */
  pace: number | null;
  /** How much of the big picture there is: its parts, and the topics in them. */
  parts: number;
  topics: number;
  stages: GoalStage[];
}

export interface GoalsSnapshot {
  goals: GoalSummary[];
}

/** A page of a goal, as a page of the notes: where it is, so the notes' editor can open it. */
export interface GoalPages {
  folder: string;
  goal: string;
  picture: string | null;
  route: string | null;
}

/** The big picture as its file says it: what comes before the first part is the whole thing explained; a part is a
 * second-level heading, a topic a third-level one under it. Parts without topics (sources, what was not found) come
 * after the board. Every text is Markdown. */
export interface GoalPicture {
  whole: string;
  parts: Array<{ title: string; line: string; topics: Array<{ title: string; body: string }> }>;
  more: Array<{ title: string; text: string }>;
}

export interface GoalRoute {
  intro: string;
  stages: Array<{ title: string; note: string; steps: Array<GoalStep & { body: string }> }>;
}

export interface GoalDetail extends GoalSummary {
  /** Why the user wants it: theirs to write, never Zirma's. */
  why: string;
  pages: GoalPages;
  picture: GoalPicture;
  route: GoalRoute;
}

/** The operations a device may ask of the goals module (POST /api/ops/<name>). Writing the big picture and the
 * route by hand is the notes' own save (POST /api/notes/save): they are pages of the notes. */
export const GOAL_OPS = ["goal.create", "goal.update", "goal.step", "goal.page", "goal.remove", "goal.restore"] as const;
export type GoalOp = (typeof GOAL_OPS)[number];
export const GOAL_QUERIES = ["goal.detail"] as const;
