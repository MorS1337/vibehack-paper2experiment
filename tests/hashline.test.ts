import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOps,
  fileHash,
  formatHeader,
  formatNumberedLines,
  parsePatch,
  PatchError,
  splitLines,
} from "../src/integrations/hashline.js";

const source = [
  "@cache",
  "def greet(name):",
  '    print("Hello, " + name)',
  "",
  'greet("world")',
].join("\n");
const tag = (value: string) => fileHash(value);
const patch = (body: string) => parsePatch(body);

test("read output carries the omp hashline header and absolute LINE:TEXT rows", () => {
  assert.equal(tag(source), tag(source.replace(/\r\n/g, "\n")));
  assert.match(formatHeader("greet.py", source), /^\[greet\.py#[0-9A-F]{4}\]$/);
  assert.equal(
    formatNumberedLines("greet.py", source),
    [
      `[greet.py#${tag(source)}]`,
      "1:@cache",
      "2:def greet(name):",
      '3:    print("Hello, " + name)',
      "4:",
      '5:greet("world")',
    ].join("\n"),
  );
  assert.deepEqual(formatNumberedLines("x.py", source, 2, 3).split("\n"), [
    `[x.py#${tag(source)}]`,
    "2:def greet(name):",
    '3:    print("Hello, " + name)',
  ]);
  // omp drops only the terminal empty row of a newline-terminated file.
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
});

test("PUT N.=M replaces an inclusive range and the result stays valid for the next read", () => {
  const parsed = patch(`*** Begin Patch
[greet.py#${tag(source)}]
PUT 1.=3:
+@cache
+def greet(name):
+    print(f"Hi, {name}")
*** End Patch`);
  const applied = applyOps(parsed.sections[0], source);
  assert.equal(
    applied.text,
    [
      "@cache",
      "def greet(name):",
      '    print(f"Hi, {name}")',
      "",
      'greet("world")',
    ].join("\n") + "\n",
  );
  assert.equal(
    formatHeader("greet.py", applied.text),
    `[greet.py#${tag(applied.text)}]`,
  );
});

test("gap inserts, append, CUT and multi-hunk patches address the original snapshot", () => {
  const inserted = applyOps(
    patch(`[greet.py#${tag(source)}]\nPUT <1:\n+import functools`).sections[0],
    source,
  );
  assert.equal(inserted.text.split("\n")[0], "import functools");
  const appended = applyOps(
    patch(`[greet.py#${tag(source)}]\nPUT >$:\n+print("done")`).sections[0],
    source,
  );
  assert.equal(appended.text.trimEnd().split("\n").at(-1), 'print("done")');
  const after = applyOps(
    patch(`[greet.py#${tag(source)}]\nPUT >3:\n+    return name`).sections[0],
    source,
  );
  assert.equal(after.text.split("\n")[3], "    return name");
  const cut = applyOps(
    patch(`[greet.py#${tag(source)}]\nCUT 4.=4`).sections[0],
    source,
  );
  assert.equal(
    cut.text,
    [
      "@cache",
      "def greet(name):",
      '    print("Hello, " + name)',
      'greet("world")',
    ].join("\n") + "\n",
  );
  const multi = applyOps(
    patch(
      `[greet.py#${tag(source)}]\nPUT 1.=1:\n+@functools.cache\nPUT 5.=5:\n+greet("team")`,
    ).sections[0],
    source,
  );
  assert.deepEqual(multi.text.split("\n").slice(0, 2), [
    "@functools.cache",
    "def greet(name):",
  ]);
  assert.equal(multi.text.trimEnd().split("\n").at(-1), 'greet("team")');
});

test("a payload is final content: diff pairs, escaped sigils and blank + rows are literal", () => {
  const applied = applyOps(
    patch(`[values.txt#${tag("one")}]\nPUT 1.=1:\n++plus\n+-minus\n+`)
      .sections[0],
    "one",
  );
  assert.equal(applied.text, "+plus\n-minus\n\n");
  // An empty file has no addressable lines; appending one row must not invent a leading blank line.
  const fresh = applyOps(
    patch(`[values.txt#${tag("")}]\nPUT >$:\n+first`).sections[0],
    "",
  );
  assert.equal(fresh.text, "first\n");
  assert.throws(
    () =>
      applyOps(patch(`[values.txt#${tag("")}]\nPUT 1.=1:\n+x`).sections[0], ""),
    /Line 1 does not exist/,
  );
});

test("unsafe or ambiguous input fails loudly instead of guessing", () => {
  const cite = `[greet.py#${tag(source)}]`;
  assert.throws(
    () => parsePatch(`${cite}\nPUT 1*:\n+x`),
    /block anchors .* syntax tree/,
  );
  assert.throws(
    () => parsePatch(`${cite}\nCUT 2.=2 @fn`),
    /registers are not supported/,
  );
  assert.throws(
    () => parsePatch(`${cite}\nPUT 3.=1:\n+x`),
    /ends before it starts/,
  );
  assert.throws(
    () => parsePatch(`${cite}\nPUT 1.=1:\n-not a payload row`),
    /must start with \+/,
  );
  assert.throws(
    () => parsePatch("PUT 1.=1:\n+x"),
    /expected a \[path#TAG\] section/,
  );
  assert.throws(
    () =>
      applyOps(
        patch(`${cite}\nPUT 1.=3:\n+a\nPUT 3.=4:\n+b`).sections[0],
        source,
      ),
    /already targeted by another hunk/,
  );
  assert.throws(
    () => applyOps(patch(`${cite}\nPUT 9.=9:\n+x`).sections[0], source),
    /Line 9 does not exist \(file has 5 lines\)/,
  );
  assert.throws(
    () => applyOps(patch(`${cite}\nPUT >9:\n+x`).sections[0], source),
    /Line 9 does not exist/,
  );
  assert.throws(
    () => applyOps(patch(`${cite}\nREM\nPUT 1.=1:\n+x`).sections[0], source),
    /REM cannot be combined/,
  );
  assert.equal(new PatchError("x").message, "x");
});
