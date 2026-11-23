/** Which steps of the first run (FirstRun.tsx) are still owed: a step that is already set is not shown, so someone
 * who was using Alfred before the walkthrough existed sees only what is new to them. */
import type { Automation } from "@alfred/protocol";

export type FirstRunStep = "name" | "model" | "google" | "samples" | "tour";

export interface FirstRunFacts {
  name: string | null;
  /** Providers with a model connected; null: could not be read (a device that does not hold the credentials). */
  models: number | null;
  /** `ready`: this Alfred can start a Google sign-in at all. Null: could not be read. */
  google: { accounts: number; ready: boolean } | null;
  /** The automations Alfred ships with (the morning brief among them), as they are now. */
  samples: ReadonlyArray<Pick<Automation, "enabled">>;
}

/** In order. The walk round always is. */
export function owedSteps({ name, models, google, samples }: FirstRunFacts): FirstRunStep[] {
  const steps: FirstRunStep[] = [];
  if (!name) steps.push("name");
  if (models === 0) steps.push("model");
  if (google?.ready && google.accounts === 0) steps.push("google");
  if (samples.some((sample) => !sample.enabled)) steps.push("samples");
  steps.push("tour");
  return steps;
}

/** Leaving the model step with none connected: there is nothing to run on a schedule, so that question waits. */
export function withoutSamples(steps: FirstRunStep[]): FirstRunStep[] {
  return steps.filter((step) => step !== "samples");
}
