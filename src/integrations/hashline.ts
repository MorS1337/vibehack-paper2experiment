import { createHash } from "node:crypto";

/**
 * Hashline editing, following omp's wire format (`crates/pi-edit/src/modes/hashline`):
 * a whole-file snapshot tag plus absolute line numbers, and one hashline patch
 * language shared by every edit.
 *
 *   [src/example.ts#1A2B]
 *   PUT 4.=4:
 *   +const value = 2;
 *
 * `read` prints the header and `LINE:TEXT` rows; edits cite those numbers. A
 * stale tag fails deterministically instead of guessing, so a file changed
 * behind the agent's back is never silently rewritten.
 *
 * Deliberately NOT implemented: syntax-tree block anchors (`N*`), named
 * registers (`@name`), and omp's indentation/echo recovery heuristics. Each of
 * those exists to repair malformed model output; without the tree-sitter
 * machinery here they would guess. They are rejected with an explicit message.
 */

export const HL_FILE_HASH_LENGTH = 4;
export const MAX_ANCHORED_BYTES = 4 * 1024 * 1024;

const HEADER = /^\[(.+)#([0-9A-F]{4})\]$/;
const OPERATION = /^(PUT|CUT|REM|MV)(?:\s+(.*))?$/;

/** omp splits on LF and drops the terminal empty row of a newline-terminated file.
 * An empty file has zero addressable lines: create it with path+content instead. */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export function fileHash(text: string): string {
  return createHash("sha256")
    .update(text.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex")
    .slice(0, HL_FILE_HASH_LENGTH)
    .toUpperCase();
}

export function formatHeader(relativePath: string, text: string): string {
  return `[${relativePath}#${fileHash(text)}]`;
}

/** Header plus `LINE:TEXT` rows, exactly the anchors `edit` consumes. */
export function formatNumberedLines(
  relativePath: string,
  text: string,
  firstLine = 1,
  lastLine = Number.MAX_SAFE_INTEGER,
): string {
  const lines = splitLines(text);
  const from = Math.max(1, firstLine);
  const to = Math.min(lines.length, lastLine);
  const rows = lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}:${line}`);
  return [formatHeader(relativePath, text), ...rows].join("\n");
}

export type Cursor =
  | { kind: "before"; line: number }
  | { kind: "after"; line: number }
  | { kind: "eof" };

export type EditOp =
  | { kind: "replace"; from: number; to: number; text: string[]; line: number }
  | { kind: "insert"; at: Cursor; text: string[]; line: number }
  | { kind: "cut"; from: number; to: number; line: number }
  | { kind: "remove"; line: number }
  | { kind: "move"; destination: string; line: number };

export interface FilePatch {
  path: string;
  tag: string;
  ops: EditOp[];
}

export interface ParsedPatch {
  sections: FilePatch[];
}

export class PatchError extends Error {}

function fail(line: number, message: string): never {
  throw new PatchError(`line ${line}: ${message}`);
}

export function parseRange(
  spec: string,
  line: number,
): { from: number; to: number } {
  if (spec.endsWith("*")) {
    fail(
      line,
      `block anchors (${JSON.stringify(spec)}) need a syntax tree, which is unavailable here. Use an explicit N.=M line range.`,
    );
  }
  if (spec.includes("@")) {
    fail(
      line,
      "named clipboard registers are not supported. Use explicit N.=M line ranges and final content.",
    );
  }
  const match = /^([1-9]\d*)\.=([1-9]\d*)$/.exec(spec);
  if (!match)
    fail(
      line,
      `malformed range ${JSON.stringify(spec)}; expected the inclusive form N.=M`,
    );
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (to < from) fail(line, `range ${spec} ends before it starts`);
  return { from, to };
}

export function parseCursor(spec: string, line: number): Cursor {
  if (spec.endsWith("*")) {
    fail(
      line,
      `block anchors (${JSON.stringify(spec)}) need a syntax tree, which is unavailable here. Use <N, >N, or >$ with an explicit line.`,
    );
  }
  if (spec === ">$") return { kind: "eof" };
  if (spec.includes("@"))
    fail(
      line,
      "named clipboard registers are not supported. Paste final content with PUT instead.",
    );
  const before = /^<([1-9]\d*)$/.exec(spec);
  if (before) return { kind: "before", line: Number(before[1]) };
  const after = /^>([1-9]\d*)$/.exec(spec);
  if (after) return { kind: "after", line: Number(after[1]) };
  fail(line, `malformed gap ${JSON.stringify(spec)}; expected <N, >N, or >$`);
}

/** A payload row is `+TEXT`; `+` alone is a blank line. The sigil is removed once, so
 * `++x` writes `+x` and `+-x` writes `-x` (literal diff-looking content). */
export function parsePayloadRow(raw: string, line: number): string {
  if (!raw.startsWith("+"))
    fail(
      line,
      "payload rows must start with + (the payload is final content, not a diff)",
    );
  return raw.slice(1);
}

/**
 * Parse a hashline payload. `*** Begin Patch` / `*** End Patch` are optional; line
 * numbers always address the tagged snapshot, never earlier hunks in the call.
 */
export function parsePatch(input: string): ParsedPatch {
  const rows = input.replace(/\r\n?/g, "\n").split("\n");
  if (rows[0]?.trim() === "*** Begin Patch") rows.shift();
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.at(-1)?.trim() === "*** End Patch") rows.pop();
  if (!rows.length) throw new PatchError("Empty patch");
  const sections: FilePatch[] = [];
  let section: FilePatch | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const line = index + 1;
    if (!row.trim()) continue;
    const header = HEADER.exec(row.trim());
    if (header) {
      section = { path: header[1], tag: header[2], ops: [] };
      sections.push(section);
      continue;
    }
    if (!section)
      fail(
        line,
        "expected a [path#TAG] section before operations; read the file first to get its tag",
      );
    const operation = OPERATION.exec(row.trim());
    if (!operation)
      fail(line, `unknown operation ${JSON.stringify(row.slice(0, 80))}`);
    const [, keyword, rawSpec = ""] = operation;
    const spec = rawSpec.trim();
    if (keyword === "REM") {
      if (spec) fail(line, "REM takes no arguments");
      section.ops.push({ kind: "remove", line });
      continue;
    }
    if (keyword === "MV") {
      const destination = spec.replace(/^"(.*)"$/, "$1");
      if (!destination) fail(line, "MV needs a destination path");
      section.ops.push({ kind: "move", destination, line });
      continue;
    }
    if (keyword === "CUT") {
      if (!spec) fail(line, "CUT needs a range");
      const range = parseRange(spec, line);
      section.ops.push({ kind: "cut", ...range, line });
      continue;
    }
    // PUT
    if (!spec.endsWith(":"))
      fail(
        line,
        `a body-bearing PUT must end with ':' (got ${JSON.stringify(spec)})`,
      );
    const locator = spec.slice(0, -1).trim();
    const body: string[] = [];
    while (index + 1 < rows.length && rows[index + 1].startsWith("+")) {
      index += 1;
      body.push(parsePayloadRow(rows[index], index + 1));
    }
    if (rows[index + 1]?.startsWith("-")) {
      fail(
        index + 2,
        'payload rows must start with + and carry final content; a "-" row means a before/after diff was sent',
      );
    }
    if (/^[<>]/.test(locator) || locator === ">$") {
      section.ops.push({
        kind: "insert",
        at: parseCursor(locator, line),
        text: body,
        line,
      });
      continue;
    }
    const range = parseRange(locator, line);
    section.ops.push({ kind: "replace", ...range, text: body, line });
  }
  if (!sections.length) throw new PatchError("No [path#TAG] sections found");
  return { sections };
}

export interface AppliedFile {
  text: string;
  changed: { from: number; to: number; before: string[]; after: string[] }[];
}

/**
 * Apply one section's operations to the snapshot. Bounds match omp: every anchor
 * line must exist. Overlapping hunks are a caller error, not something to
 * silently reorder.
 */
export function applyOps(section: FilePatch, original: string): AppliedFile {
  const lines = splitLines(original);
  const count = lines.length;
  if (section.ops.some((op) => op.kind === "remove")) {
    if (section.ops.length > 1)
      throw new PatchError(
        `${section.path}: REM cannot be combined with other operations`,
      );
    return { text: "", changed: [] };
  }
  const removals = section.ops.filter((op) => op.kind === "cut") as Extract<
    EditOp,
    { kind: "cut" }
  >[];
  const insertions = section.ops.filter(
    (op) => op.kind === "insert",
  ) as Extract<EditOp, { kind: "insert" }>[];
  const replacements = section.ops.filter(
    (op) => op.kind === "replace",
  ) as Extract<EditOp, { kind: "replace" }>[];
  const boundaries: {
    start: number;
    end: number;
    text: string[];
    label: string;
  }[] = [];
  for (const op of replacements) {
    if (op.from > count)
      throw new PatchError(
        `Line ${op.from} does not exist (file has ${count} lines)`,
      );
    const to = Math.min(op.to, count);
    boundaries.push({
      start: op.from,
      end: to,
      text: op.text,
      label: `PUT ${op.from}.=${op.to}`,
    });
  }
  for (const op of removals) {
    if (op.from > count)
      throw new PatchError(
        `Line ${op.from} does not exist (file has ${count} lines)`,
      );
    boundaries.push({
      start: op.from,
      end: Math.min(op.to, count),
      text: [],
      label: `CUT ${op.from}.=${op.to}`,
    });
  }
  for (const op of insertions) {
    if (op.at.kind === "eof") {
      boundaries.push({
        start: count + 1,
        end: count,
        text: op.text,
        label: "PUT >$",
      });
      continue;
    }
    if (op.at.line > count)
      throw new PatchError(
        `Line ${op.at.line} does not exist (file has ${count} lines)`,
      );
    if (op.at.kind === "before")
      boundaries.push({
        start: op.at.line,
        end: op.at.line - 1,
        text: op.text,
        label: `PUT <${op.at.line}`,
      });
    else
      boundaries.push({
        start: op.at.line + 1,
        end: op.at.line,
        text: op.text,
        label: `PUT >${op.at.line}`,
      });
  }
  boundaries.sort((a, b) => a.start - b.start);
  for (let index = 1; index < boundaries.length; index += 1) {
    const previous = boundaries[index - 1];
    const current = boundaries[index];
    if (current.start <= previous.end) {
      throw new PatchError(
        `anchor line ${current.start} is already targeted by another hunk (${previous.label}). Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`,
      );
    }
  }
  const changed: AppliedFile["changed"] = [];
  let output = [...lines];
  for (const boundary of [...boundaries].reverse()) {
    const start = boundary.start - 1;
    const deleteCount = Math.max(0, boundary.end - boundary.start + 1);
    const before = output.slice(start, start + deleteCount);
    output.splice(start, deleteCount, ...boundary.text);
    changed.unshift({
      from: boundary.start,
      to: boundary.end,
      before,
      after: boundary.text,
    });
  }
  return { text: output.length ? `${output.join("\n")}\n` : "", changed };
}

/** Compact changed-line preview so one rewrite cannot flood the context. */
export function previewChanges(applied: AppliedFile, limit = 24): string[] {
  const rows: string[] = [];
  for (const change of applied.changed) {
    for (const line of change.before) {
      if (rows.length >= limit) return rows;
      rows.push(`-${line.length > 160 ? `${line.slice(0, 160)}…` : line}`);
    }
    for (const line of change.after) {
      if (rows.length >= limit) return rows;
      rows.push(`+${line.length > 160 ? `${line.slice(0, 160)}…` : line}`);
    }
  }
  return rows;
}
