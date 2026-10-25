import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppAPI } from '../../shared/types.js';
import { errorMessage } from '../lib/api.js';
import {
  encodePcm16Wav,
  RECORDING_MAX_SECONDS,
  RECORDING_TARGET_RATE,
  resampleTo16k
} from '../lib/recorder.js';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing';

interface CaptureSession {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  sink: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
  startedAt: number;
  active: boolean;
  interval: number;
  maxTimer: number;
  flush: () => Promise<void>;
}

export interface VoiceTaskController {
  phase: VoicePhase;
  elapsed: number;
  remaining: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

/**
 * Records one short voice note and hands a 16 kHz PCM16 WAV to the main process.
 * Audio is never persisted in the renderer and transcription never starts a run.
 */
export function useVoiceTask(api: AppAPI, onTranscript: (text: string) => void): VoiceTaskController {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef<VoicePhase>('idle');
  const sessionRef = useRef<CaptureSession | null>(null);
  const mountedRef = useRef(false);
  const apiRef = useRef(api);
  const onTranscriptRef = useRef(onTranscript);
  const stopRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    apiRef.current = api;
    onTranscriptRef.current = onTranscript;
  });

  const disposeCapture = useCallback((): CaptureSession | null => {
    const session = sessionRef.current;
    if (!session) return null;
    sessionRef.current = null;
    session.active = false;
    window.clearInterval(session.interval);
    window.clearTimeout(session.maxTimer);
    session.processor.port.onmessage = null;
    session.source.disconnect();
    session.processor.disconnect();
    session.sink.disconnect();
    for (const track of session.stream.getTracks()) track.stop();
    void session.context.close().catch(() => undefined);
    return session;
  }, []);

  const stop = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || phaseRef.current !== 'recording') return;
    setElapsed(Math.min(RECORDING_MAX_SECONDS, Math.floor((performance.now() - current.startedAt) / 1000)));
    phaseRef.current = 'transcribing';
    setPhase('transcribing');

    try {
      await current.flush();
      const session = disposeCapture();
      if (!session) return;
      const totalSamples = session.chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (totalSamples === 0) throw new Error('Запись не содержит аудиоданных');
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of session.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const resampled = resampleTo16k(merged, session.sampleRate);
      const wav = encodePcm16Wav(resampled, RECORDING_TARGET_RATE);
      const text = (await apiRef.current.transcribe(wav)).trim();
      if (!mountedRef.current) return;
      if (text) {
        onTranscriptRef.current(text);
        setError(null);
      } else {
        setError('Речь не распознана. Проверьте микрофон и настройки Whisper.');
      }
    } catch (captureError) {
      disposeCapture();
      if (mountedRef.current) {
        setError(`Не удалось распознать речь: ${errorMessage(captureError)}`);
      }
    } finally {
      if (mountedRef.current) {
        phaseRef.current = 'idle';
        setPhase('idle');
      }
    }
  }, [disposeCapture]);

  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const start = useCallback(async () => {
    if (sessionRef.current || phaseRef.current !== 'idle') return;
    setError(null);
    setElapsed(0);
    phaseRef.current = 'requesting';
    setPhase('requesting');

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Микрофон недоступен в этом окружении');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      context = new AudioContext();
      await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      await context.audioWorklet.addModule(new URL('capture-worklet.js', window.location.href).href);
      if (!mountedRef.current) { for (const track of stream.getTracks()) track.stop(); await context.close(); return; }
      const processor = new AudioWorkletNode(context, 'paper2-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const flushed = Promise.withResolvers<void>();
      let flushTimer: number | undefined;
      const sink = context.createGain();
      sink.gain.value = 0;

      const session: CaptureSession = {
        stream,
        context,
        source,
        processor,
        sink,
        chunks: [],
        sampleRate: context.sampleRate,
        startedAt: performance.now(),
        active: true,
        interval: 0,
        maxTimer: 0,
        flush: () => {
          processor.port.postMessage('flush');
          flushTimer = window.setTimeout(() => flushed.reject(new Error('Аудиопроцессор не завершил запись')), 2000);
          return flushed.promise;
        }
      };
      sessionRef.current = session;

      processor.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; flushed?: boolean }>) => {
        if (!session.active) return;
        if (data.samples) session.chunks.push(data.samples);
        if (data.flushed) { window.clearTimeout(flushTimer); flushed.resolve(); }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);

      session.interval = window.setInterval(() => {
        if (!mountedRef.current) return;
        setElapsed(
          Math.min(RECORDING_MAX_SECONDS, Math.floor((performance.now() - session.startedAt) / 1000))
        );
      }, 200);
      session.maxTimer = window.setTimeout(() => {
        if (sessionRef.current === session) void stopRef.current?.();
      }, RECORDING_MAX_SECONDS * 1000);

      phaseRef.current = 'recording';
      setPhase('recording');
    } catch (captureError) {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (context) void context.close().catch(() => undefined);
      sessionRef.current = null;
      if (mountedRef.current) {
        phaseRef.current = 'idle';
        setPhase('idle');
        setError(`Не удалось начать запись: ${errorMessage(captureError)}`);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    disposeCapture();
    phaseRef.current = 'idle';
    setPhase('idle');
    setElapsed(0);
  }, [disposeCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeCapture();
    };
  }, [disposeCapture]);

  return {
    phase,
    elapsed,
    remaining: Math.max(0, RECORDING_MAX_SECONDS - elapsed),
    error,
    start,
    stop,
    cancel
  };
}
