import type { VoicePhase } from "../hooks/useVoiceTask.js";
import { MicIcon } from "./icons.js";

export interface DictationState {
  phase: VoicePhase;
  elapsed: number;
  remaining: number;
  level: number;
  device: string;
}

const BARS = 14;

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A dictation strip, not a fake live transcript: the local Whisper CLI transcribes only after
 * the recording is flushed. Bar heights come from real captured audio levels.
 */
export function DictationControl({
  state,
  disabled,
  onStart,
  onStop,
  onCancel,
}: {
  state: DictationState;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "idle") {
    return (
      <button
        type="button"
        className="dictation-button"
        aria-label="Dictate with Whisper"
        title="Dictate with local Whisper"
        disabled={disabled}
        onClick={onStart}
      >
        <MicIcon size={15} />
      </button>
    );
  }
  if (state.phase !== "recording") {
    return (
      <div className="dictation-strip" role="status" aria-live="polite">
        <span className="dictation-status">
          <span className="spinner" aria-hidden="true" />
          {state.phase === "requesting"
            ? "Waiting for microphone…"
            : "Transcribing locally…"}
        </span>
        <button type="button" className="dictation-cancel" onClick={onCancel}>
          {state.phase === "transcribing" ? "Stop" : "Cancel"}
        </button>
      </div>
    );
  }
  return (
    <div
      className="dictation-strip is-recording"
      role="group"
      aria-label="Recording"
    >
      <span className="dictation-status">
        <span className="record-dot" aria-hidden="true" />
        <span className="dictation-device" title={state.device}>
          {state.device}
        </span>
      </span>
      <span className="dictation-meter" aria-hidden="true">
        {Array.from({ length: BARS }, (_, index) => {
          // Symmetric centre-weighted bars keep quiet speech visible and loud speech bounded.
          const weight =
            0.35 + 0.65 * Math.sin(((index + 0.5) / BARS) * Math.PI);
          return (
            <i
              key={index}
              style={{
                height: `${Math.round(12 + 88 * Math.min(1, state.level * weight))}%`,
              }}
            />
          );
        })}
      </span>
      <span
        className={`dictation-clock${state.remaining <= 10 ? " is-ending" : ""}`}
      >
        {clock(state.elapsed)}
      </span>
      <span className="dictation-limit">
        / {clock(state.remaining + state.elapsed)}
      </span>
      <button type="button" className="dictation-cancel" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="dictation-done" onClick={onStop}>
        Done
      </button>
    </div>
  );
}

export function DictationError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <p className="dictation-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  );
}
