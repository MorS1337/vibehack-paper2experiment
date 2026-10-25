import { useCallback, useEffect, useRef, useState } from "react";
import type { AppAPI } from "../../shared/types.js";
import { captureMicrophone } from "../lib/microphone.js";
import { RECORDING_MAX_SECONDS } from "../lib/recorder.js";
import { VoiceTask, type VoiceState } from "../lib/voice-task.js";

export type { VoicePhase } from "../lib/voice-task.js";

export function useVoiceTask(
  api: AppAPI,
  onTranscript: (text: string) => void,
) {
  const [state, setState] = useState<VoiceState>({
    phase: "idle",
    elapsed: 0,
    error: null,
    device: "",
  });
  const [level, setLevel] = useState(0);
  const task = useRef<VoiceTask | null>(null);
  const transcript = useRef(onTranscript);
  transcript.current = onTranscript;
  useEffect(() => {
    let mounted = true;
    const controller = new VoiceTask(
      api,
      (signal, ended) =>
        captureMicrophone(signal, ended, (value) => {
          if (mounted) setLevel(value);
        }),
      (next) => {
        if (mounted) setState(next);
      },
      (text) => {
        if (mounted) transcript.current(text);
      },
    );
    task.current = controller;
    return () => {
      mounted = false;
      controller.cancel();
      task.current = null;
    };
  }, [api]);
  const start = useCallback(async () => {
    setLevel(0);
    await task.current?.start();
  }, []);
  const stop = useCallback(async () => {
    setLevel(0);
    await task.current?.stop();
  }, []);
  const cancel = useCallback(() => {
    setLevel(0);
    task.current?.cancel();
  }, []);
  const clearError = useCallback(() => task.current?.dismissError(), []);
  return {
    ...state,
    level,
    remaining: Math.max(0, RECORDING_MAX_SECONDS - state.elapsed),
    start,
    stop,
    cancel,
    clearError,
  };
}
