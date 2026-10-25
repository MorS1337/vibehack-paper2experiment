import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppAPI } from '../../shared/types.js';
import { captureMicrophone } from '../lib/microphone.js';
import { RECORDING_MAX_SECONDS } from '../lib/recorder.js';
import { VoiceTask, type VoiceState } from '../lib/voice-task.js';

export type { VoicePhase } from '../lib/voice-task.js';

export function useVoiceTask(api: AppAPI, onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({ phase: 'idle', elapsed: 0, error: null, device: '' });
  const task = useRef<VoiceTask | null>(null);
  const transcript = useRef(onTranscript);
  transcript.current = onTranscript;
  useEffect(() => {
    let mounted = true;
    const controller = new VoiceTask(api, captureMicrophone,
      next => { if (mounted) setState(next); },
      text => { if (mounted) transcript.current(text); });
    task.current = controller;
    return () => { mounted = false; controller.cancel(); task.current = null; };
  }, [api]);
  const start = useCallback(async () => { await task.current?.start(); }, []);
  const stop = useCallback(async () => { await task.current?.stop(); }, []);
  const cancel = useCallback(() => task.current?.cancel(), []);
  return { ...state, remaining: Math.max(0, RECORDING_MAX_SECONDS - state.elapsed), start, stop, cancel };
}
