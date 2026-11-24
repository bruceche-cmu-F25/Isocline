/** Alfred's voice on this device (docs/design/voice.md §2): the home node makes the sound, this plays it.
 *
 * One voice at a time in a window. Saying something new stops what was being said; so does the user starting to
 * talk (useDictation calls `stopSpeaking`), and closing the card it belongs to. Text is said sentence by sentence:
 * the next one is asked for while the first plays, so even the slower local model starts within a few seconds.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { VoiceSettings } from "@alfred/protocol";
import { api } from "../api.ts";

// ── The user's voice settings, as this window last heard them from the home node ──

const VOICE_DEFAULTS: VoiceSettings = { speakFigure: true, muted: false, voice: null, rate: 1, words: [] };
let settings: VoiceSettings = VOICE_DEFAULTS;
const settingsListeners = new Set<() => void>();

/** The window's root keeps this current from the home node's settings. */
export function useKeepVoiceSettings(current: VoiceSettings | undefined): void {
  useEffect(() => {
    const next = current ?? VOICE_DEFAULTS;
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    if (settings.muted) stopSpeaking();
    for (const listener of settingsListeners) listener();
  }, [current]);
}

export function voiceSettings(): VoiceSettings { return settings; }

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore((listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); }, () => settings, () => settings);
}

export { firstSentences, forSpeech, sentences } from "./spoken.ts";
import { sentences } from "./spoken.ts";

// ── The player ──

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
/** What is being said now: its key, so a card or a button knows it is theirs. Null when quiet. */
let speakingKey: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

function audio(): AudioContext {
  context ??= new AudioContext();
  return context;
}

/** Call from a click or key press on a phone: browsers only let sound start after one. */
export function unlockAudio(): void {
  void audio().resume().catch(() => {});
}

export function stopSpeaking(key?: string): void {
  if (key !== undefined && key !== speakingKey) return;
  generation++;
  try { source?.stop(); } catch { /* already ended */ }
  source = null;
  if (speakingKey !== null) { speakingKey = null; notify(); }
}

export interface SayOptions {
  /** Says whose this is (a card's id, a reply's id); `stopSpeaking(key)` stops only it. */
  key?: string;
  /** A voice to use instead of the user's choice (trying voices in settings). */
  voice?: string;
  rate?: number;
}

/** Says `text` (plain text; see `forSpeech`), replacing whatever was being said. Resolves when it has all been
 * said, or was stopped, or failed (a failure is quiet: the words are on screen anyway). */
export async function say(text: string, options: SayOptions = {}): Promise<"done" | "stopped" | "failed"> {
  stopSpeaking();
  if (settings.muted && !options.voice) return "stopped";
  const pieces = sentences(text);
  if (!pieces.length) return "done";
  const mine = ++generation;
  speakingKey = options.key ?? "";
  notify();
  const ctx = audio();
  void ctx.resume().catch(() => {});
  const fetchPiece = async (piece: string) => {
    const wav = await api.speak(piece, options.voice, options.rate);
    return ctx.decodeAudioData(await wav.arrayBuffer());
  };
  try {
    let next = fetchPiece(pieces[0]!);
    for (let index = 0; index < pieces.length; index++) {
      const buffer = await next;
      if (mine !== generation) return "stopped";
      // Ask for the next while this one plays.
      if (index + 1 < pieces.length) { next = fetchPiece(pieces[index + 1]!); next.catch(() => {}); }
      await new Promise<void>((resolve) => {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.onended = () => resolve();
        source = node;
        node.start();
      });
      if (mine !== generation) return "stopped";
    }
    return "done";
  } catch {
    return mine === generation ? "failed" : "stopped";
  } finally {
    if (mine === generation) { source = null; speakingKey = null; notify(); }
  }
}

/** The key of what is being said now (null when quiet), kept current. */
export function useSpeaking(): string | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => speakingKey, () => null);
}
