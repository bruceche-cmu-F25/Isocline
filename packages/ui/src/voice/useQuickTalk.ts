/** Quick talk (docs/design/voice.md §1): say one thing to Isocline without a text box. What is said goes straight to
 * Isocline as a message marked spoken; when Isocline has answered, the caller says the reply out loud.
 *
 *   idle → recording → transcribing → sending → waiting (Isocline works) → idle (reply handed over)
 *
 * The Mac's figure and the phone's Isocline bubble use it. Recording is useDictation's, so the microphone, the warm-up
 * and the one-recording-at-a-time rule are the same as in every text box.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Run, ViewContext } from "@isocline/protocol";
import { api } from "../api.ts";
import { t } from "../i18n/dict.ts";
import { unlockAudio } from "../speech/voice.ts";
import { useDictation, type Dictation } from "./useDictation.ts";

export type QuickTalkState = "idle" | "starting" | "recording" | "transcribing" | "sending" | "waiting";

const DONE = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface QuickTalkOptions {
  /** The conversation quick talk goes into, if there is one to continue. */
  conversation(): string | undefined;
  /** The conversation a message went into (a new one when there was none, or the old one was closed). */
  remember(conversationId: string): void;
  /** Where the user is: a page, or `core.voice` when there is none. */
  context(): Omit<ViewContext, "spoken">;
  /** The runs the device knows about, kept current: how the answer is noticed. */
  runs: readonly Run[] | undefined;
  /** Isocline answered (or the run ended without an answer, or is waiting on the user). */
  onReply(run: Run): void;
  onError?(message: string): void;
}

export interface QuickTalk {
  state: QuickTalkState;
  dictation: Dictation;
  /** The run being waited on. */
  runId: string | null;
  start(): void;
  /** Stop recording and send what was said. */
  finish(): void;
  toggle(): void;
  cancel(): void;
}

export function useQuickTalk(options: QuickTalkOptions): QuickTalk {
  const opts = useRef(options);
  opts.current = options;
  const [phase, setPhase] = useState<"idle" | "sending" | "waiting">("idle");
  const [runId, setRunId] = useState<string | null>(null);

  const send = useCallback(async (text: string) => {
    setPhase("sending");
    const context: ViewContext = { ...opts.current.context(), spoken: true };
    const known = opts.current.conversation();
    try {
      // The conversation may have been closed since: then this starts a new one.
      const { run } = await api.submit(text, known, context).catch((error) => {
        if (!known) throw error;
        return api.submit(text, undefined, context);
      });
      opts.current.remember(run.conversationId);
      setRunId(run.id);
      setPhase("waiting");
    } catch (error) {
      setPhase("idle");
      opts.current.onError?.((error as Error).message || t("voice.failed"));
    }
  }, []);

  const dictation = useDictation(send);

  useEffect(() => {
    if (dictation.error) opts.current.onError?.(dictation.error);
  }, [dictation.error]);

  // The answer: the run has ended, or it waits on the user (a question, a permission).
  useEffect(() => {
    if (!runId) return;
    const run = options.runs?.find((item) => item.id === runId);
    if (!run || !(DONE.has(run.state) || run.request)) return;
    setRunId(null);
    setPhase("idle");
    opts.current.onReply(run);
  }, [runId, options.runs]);

  const start = useCallback(() => {
    if (dictation.state !== "idle") return;
    // A phone lets sound play only after a touch: this is the touch the reply will be said after.
    unlockAudio();
    dictation.toggle();
  }, [dictation]);
  const finish = useCallback(() => {
    if (dictation.state === "recording") dictation.toggle();
    else if (dictation.state === "starting") dictation.cancel();
  }, [dictation]);
  const toggle = useCallback(() => { if (dictation.state === "idle") start(); else finish(); }, [dictation.state, start, finish]);

  const state: QuickTalkState = dictation.state !== "idle" ? dictation.state : phase;
  return { state, dictation, runId, start, finish, toggle, cancel: dictation.cancel };
}
