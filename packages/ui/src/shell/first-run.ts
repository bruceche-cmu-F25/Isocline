/** Which steps of the first run (FirstRun.tsx) are still owed: a step that is already set is not shown, so someone
 * who was using Alfred before the walkthrough existed sees only what is new to them. */
import type { Automation } from "@alfred/protocol";

export type FirstRunStep = "name" | "model" | "google" | "morning" | "tour";

export interface FirstRunFacts {
  name: string | null;
  /** Providers with a model connected; null: could not be read (a device that does not hold the credentials). */
  models: number | null;
  /** `ready`: this Alfred can start a Google sign-in at all. Null: could not be read. */
  google: { accounts: number; ready: boolean } | null;
  /** The morning brief, when this Alfred has one. */
  brief: Pick<Automation, "enabled"> | undefined;
}

/** In order. The walk round always is. */
export function owedSteps({ name, models, google, brief }: FirstRunFacts): FirstRunStep[] {
  const steps: FirstRunStep[] = [];
  if (!name) steps.push("name");
  if (models === 0) steps.push("model");
  if (google?.ready && google.accounts === 0) steps.push("google");
  if (brief && !brief.enabled) steps.push("morning");
  steps.push("tour");
  return steps;
}

/** Leaving the model step with none connected: there is nothing to run each morning, so that question waits. */
export function withoutMorning(steps: FirstRunStep[]): FirstRunStep[] {
  return steps.filter((step) => step !== "morning");
}
