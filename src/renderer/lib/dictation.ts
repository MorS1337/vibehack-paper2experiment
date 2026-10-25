/**
 * Insert dictated text where the caret was. The UI is free-form text editing:
 * dictation must never replace the draft or send it.
 */
export function insertTranscript(
  current: string,
  start: number,
  end: number,
  transcript: string,
): { text: string; caret: number } {
  const from = Math.max(
    0,
    Math.min(current.length, Number.isFinite(start) ? start : current.length),
  );
  const to = Math.max(
    from,
    Math.min(current.length, Number.isFinite(end) ? end : from),
  );
  const before = current.slice(0, from);
  const after = current.slice(to);
  // Join words only when the caret sits between two non-space characters.
  const lead =
    before && !/\s$/.test(before) && !/^[\s.,;:!?)]/.test(transcript)
      ? " "
      : "";
  const tail =
    after && !/^\s/.test(after) && !/\s$/.test(transcript) ? " " : "";
  const inserted = `${lead}${transcript}${tail}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
