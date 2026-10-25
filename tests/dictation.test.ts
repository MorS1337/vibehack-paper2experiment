import test from "node:test";
import assert from "node:assert/strict";
import { insertTranscript } from "../src/renderer/lib/dictation.js";

test("dictation inserts at the caret and preserves the existing draft", () => {
  const draft = "Compare the bound with the exact tail.";
  const middle = draft.indexOf("the exact");
  const result = insertTranscript(draft, middle, middle, "and its uncertainty");
  assert.equal(
    result.text,
    "Compare the bound with and its uncertainty the exact tail.",
  );
  assert.equal(result.caret, 43);
  assert.equal(
    result.text.slice(0, result.caret),
    "Compare the bound with and its uncertainty ",
  );
  assert.deepEqual(insertTranscript("", 0, 0, "First words."), {
    text: "First words.",
    caret: 12,
  });
});

test("dictation does not glue words together or eat existing spacing", () => {
  assert.equal(
    insertTranscript("Existing draft. ", 16, 16, "Spoken.").text,
    "Existing draft. Spoken.",
  );
  assert.equal(
    insertTranscript("Question: ", 10, 10, "what changed?").text,
    "Question: what changed?",
  );
  assert.equal(
    insertTranscript("No trailing space", 17, 17, "next").text,
    "No trailing space next",
  );
  assert.equal(
    insertTranscript("Existing", 8, 8, ". Confirmed.").text,
    "Existing. Confirmed.",
  );
});

test("a selection is replaced, and stale caret indexes cannot corrupt the draft", () => {
  const draft = "Keep this and remove that";
  assert.equal(
    insertTranscript(draft, 5, 9, "Rewrite").text,
    "Keep Rewrite and remove that",
  );
  assert.equal(insertTranscript("Short", 999, 999, "end").text, "Short end");
  assert.equal(
    insertTranscript("Short", -4, Number.NaN, "start").text,
    "start Short",
  );
  assert.equal(insertTranscript("Short", 3, 1, "x").text, "Sho x rt");
});
