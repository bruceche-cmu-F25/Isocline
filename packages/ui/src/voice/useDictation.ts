/** Speaking instead of typing: records on this device and has the home node turn it into words.
 *
 *   idle → starting (asking for the microphone) → recording → transcribing → idle
 *
 * One recording at a time in the whole window. The microphone is let go after each recording, so the system's
 * "microphone in use" light is only on while the user is actually talking. The home node is asked to load its
 * speech model as soon as recording starts, so the loading happens while the user speaks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.ts";
import { t } from "../i18n/dict.ts";
import { concat, downsample, encodeWav } from "./wav.ts";
import { audioSession, stopSpeaking } from "../speech/voice.ts";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

const MAX_SECONDS = 300;
const MIN_SECONDS = 0.3;

interface Session {
  owner: symbol;
  stream: MediaStream;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  chunks: Float32Array[];
}

let context: AudioContext | null = null;
let workletReady: Promise<void> | null = null;
let current: Session | null = null;
/** The start that is waiting for the microphone; cancelling clears it. */
let starting: symbol | null = null;

async function audioContext(): Promise<AudioContext> {
  context ??= new AudioContext();
  workletReady ??= context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url).href);
  await workletReady;
  if (context.state === "suspended") await context.resume();
  return context;
}

function release(session: Session) {
  session.source.disconnect();
  session.node.disconnect();
  session.node.port.onmessage = null;
  for (const track of session.stream.getTracks()) track.stop();
  audioSession("auto");
}

export const dictationSupported = () =>
  typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";

function describe(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) return t("voice.denied");
  if (error instanceof DOMException && error.name === "NotFoundError") return t("voice.noMic");
  if (error instanceof ApiError && error.code === "voice_unavailable") return t("voice.unavailable", { reason: error.message });
  if (error instanceof ApiError && error.status === 404) return t("voice.unavailable", { reason: t("voice.noServer") });
  return t("voice.failed");
}

export interface Dictation {
  state: DictationState;
  /** 0..1, how loud right now (while recording). */
  level: number;
  /** Seconds recorded so far. */
  seconds: number;
  error: string | null;
  toggle(): void;
  cancel(): void;
}

/** `onText` gets the words once they are back (never called with nothing). */
export function useDictation(onText: (text: string) => void): Dictation {
  const owner = useRef(Symbol("dictation")).current;
  const [state, setState] = useState<DictationState>("idle");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const stateRef = useRef(state);
  stateRef.current = state;

  const cancel = useCallback(() => {
    if (current?.owner === owner) { release(current); current = null; }
    if (stateRef.current === "starting") starting = null;
    if (stateRef.current === "recording" || stateRef.current === "starting") setState("idle");
    setLevel(0);
  }, [owner]);

  const stop = useCallback(async () => {
    const session = current;
    if (!session || session.owner !== owner || !context) return;
    const rate = context.sampleRate;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 300);
      session.node.port.onmessage = (event) => {
        if (event.data === "flushed") { clearTimeout(timer); resolve(); } else session.chunks.push(event.data as Float32Array);
      };
      session.node.port.postMessage("flush");
    });
    release(session);
    current = null;
    setLevel(0);
    const samples = concat(session.chunks);
    if (samples.length < rate * MIN_SECONDS) { setState("idle"); return; }
    setState("transcribing");
    try {
      const { text } = await api.transcribe(encodeWav(downsample(samples, rate)));
      if (text.trim()) onTextRef.current(text.trim());
      else setError(t("voice.nothing"));
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setState("idle");
    }
  }, [owner]);

  const start = useCallback(async () => {
    if (current || starting) return; // someone else is recording
    const attempt = Symbol("start");
    starting = attempt;
    setError(null);
    setSeconds(0);
    setState("starting");
    // The user talking is Isocline's cue to stop.
    stopSpeaking();
    void api.voiceWarm().catch(() => {});
    try {
      const ctx = await audioContext();
      audioSession("play-and-record");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (starting !== attempt) { for (const track of stream.getTracks()) track.stop(); audioSession("auto"); return; } // cancelled meanwhile
      starting = null;
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "isocline-capture");
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(node);
      source.connect(analyser);
      const session: Session = { owner, stream, node, source, analyser, chunks: [] };
      node.port.onmessage = (event) => { if (event.data !== "flushed") session.chunks.push(event.data as Float32Array); };
      current = session;
      setState("recording");
    } catch (failure) {
      if (starting === attempt) starting = null;
      audioSession("auto");
      setError(describe(failure));
      setState("idle");
    }
  }, [owner]);

  // While recording: the level meter, the clock, the time limit, and Esc to throw it away.
  useEffect(() => {
    if (state !== "recording") return;
    const data = new Float32Array(512);
    let frame = 0;
    const began = performance.now();
    const tick = () => {
      const session = current;
      if (!session || session.owner !== owner) return;
      session.analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      setLevel(Math.min(1, peak * 1.6));
      const elapsed = (performance.now() - began) / 1000;
      setSeconds(Math.floor(elapsed));
      if (elapsed >= MAX_SECONDS) { void stop(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey, true); };
  }, [state, owner, stop, cancel]);

  // Leaving the page mid-sentence lets the microphone go.
  useEffect(() => () => { if (current?.owner === owner) { release(current); current = null; } }, [owner]);

  // An error fades after a while.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const toggle = useCallback(() => {
    if (stateRef.current === "recording") void stop();
    else if (stateRef.current === "idle") void start();
    else if (stateRef.current === "starting") cancel();
  }, [start, stop, cancel]);

  return { state, level, seconds, error, toggle, cancel };
}
