import {
  encodePcm16Wav,
  RECORDING_MAX_SECONDS,
  resampleTo16k,
} from "./recorder.js";
import { abortable, type VoiceCapture } from "./voice-task.js";

export async function captureMicrophone(
  signal: AbortSignal,
  onEnded: () => void,
  onLevel?: (level: number) => void,
): Promise<VoiceCapture> {
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    clearTimeout(flushTimer);
    signal.removeEventListener("abort", dispose);
    if (processor) {
      processor.port.onmessage = null;
      processor.onprocessorerror = null;
    }
    source?.disconnect();
    processor?.disconnect();
    sink?.disconnect();
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (context) void context.close().catch(() => undefined);
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", dispose, { once: true });
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone is unavailable in this environment");
    stream = await abortable(
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        .then((result) => {
          // getUserMedia has no abort API. Release a stream arriving after timeout/unmount.
          if (signal.aborted) {
            result.getTracks().forEach((track) => track.stop());
            signal.throwIfAborted();
          }
          return result;
        }),
      signal,
    );
    signal.throwIfAborted();
    context = new AudioContext();
    await abortable(context.resume(), signal);
    await abortable(
      context.audioWorklet.addModule(
        new URL("capture-worklet.js", window.location.href).href,
      ),
      signal,
    );
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream!);
    processor = new AudioWorkletNode(context, "paper2-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    sink = context.createGain();
    sink.gain.value = 0;
    const chunks: Float32Array[] = [];
    let samples = 0;
    let levelSamples = 0;
    let levelPeak = 0;
    const sampleRate = context.sampleRate;
    const maxSamples = sampleRate * RECORDING_MAX_SECONDS;
    const flushed = Promise.withResolvers<void>();
    processor.port.onmessage = ({
      data,
    }: MessageEvent<{ samples?: Float32Array; flushed?: boolean }>) => {
      if (data.samples && samples < maxSamples) {
        const chunk = data.samples.subarray(0, maxSamples - samples);
        chunks.push(chunk);
        samples += chunk.length;
        if (onLevel) {
          // Real peak amplitude per ~50 ms of captured audio; drives the meter, never the transcript.
          for (const sample of chunk)
            levelPeak = Math.max(levelPeak, Math.abs(sample));
          levelSamples += chunk.length;
          if (levelSamples >= sampleRate * 0.05) {
            onLevel(Math.min(1, levelPeak * 3));
            levelSamples = 0;
            levelPeak = 0;
          }
        }
      }
      if (data.flushed) flushed.resolve();
    };
    processor.onprocessorerror = onEnded;
    for (const track of stream!.getAudioTracks()) track.onended = onEnded;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    return {
      device: stream!.getAudioTracks()[0]?.label || "System microphone",
      dispose,
      stop: async () => {
        try {
          signal.throwIfAborted();
          processor!.port.postMessage("flush");
          flushTimer = setTimeout(
            () =>
              flushed.reject(
                new Error("The audio processor did not finish recording"),
              ),
            2000,
          );
          await abortable(flushed.promise, signal);
          const merged = new Float32Array(samples);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          if (samples < sampleRate * 0.2)
            throw new Error("Recording too short. Speak the task again.");
          const energy =
            merged.reduce((sum, value) => sum + value * value, 0) / samples;
          if (Math.sqrt(energy) < 0.0001)
            throw new Error(
              "The recording is silent. Check the selected microphone and its input level.",
            );
          return encodePcm16Wav(resampleTo16k(merged, sampleRate));
        } finally {
          dispose();
        }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
