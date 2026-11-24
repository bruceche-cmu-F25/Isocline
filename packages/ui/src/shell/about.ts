/** What the next words in the ask bar are about, when the user picked a thing on the page to say something about: a
 * mail to answer, a draft to change. The words then go to that thing, not to Zirma as a new question, so every
 * page has one place to write (shell/AskBar.tsx) and nothing on a page needs a field of its own. */
import type { ViewContext } from "@zirma/protocol";

export interface About {
  /** Which thing it is. The button that attached it stays pressed while this is the one in the bar. */
  key: string;
  /** A few words in the bar, before the field ("回 Leo"). */
  label: string;
  placeholder: string;
  /** Likely words, one tap each. */
  chips?: string[];
  /** Takes the words. The thing leaves the bar once this resolves. */
  send(text: string): Promise<void>;
}

/** What was picked on the page, as a run hears about it (ViewContext.selection). */
export type Picked = NonNullable<ViewContext["selection"]>;

/** How a page reaches the bar under it. */
export interface PageLine {
  /** The key of what is in the bar now, if anything. */
  about: string | null;
  /** Puts a thing in the bar and the cursor after it; null takes it out. */
  attach(about: About | null): void;
  /** Asks Zirma about something picked on this page. What it makes of it shows on the page, where the thing is.
   * Resolves with the run's id, for the page to follow. */
  ask(goal: string, picked: Picked): Promise<string>;
  /** Asks for a change to a proposal that is shown on this page, with the thing it is about. Resolves with the id
   * of the run that writes the new version. */
  revise(proposalId: string, text: string, picked: Picked): Promise<string | null>;
}
