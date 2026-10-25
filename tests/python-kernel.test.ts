import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PythonKernel,
  pythonKernel,
  resolvePython,
  shutdownPythonKernels,
} from "../src/integrations/python-kernel.js";

const python = process.platform === "win32" ? "python" : "python3";

test("retained kernel keeps state across cells and echoes the trailing expression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "methodiy-kernel-"));
  try {
    const kernel = await PythonKernel.start({ python, cwd: root });
    try {
      const first = await kernel.execute(
        "value = 41\nrows = [1, 2]\nimport math",
      );
      assert.equal(first.error, null);
      assert.equal(first.cancelled, false);
      assert.equal(first.executionCount, 1);
      const second = await kernel.execute(
        'import os\nprint("cwd", os.path.basename(os.getcwd()))\nvalue + len(rows) + int(math.sqrt(1))',
      );
      assert.equal(second.error, null);
      assert.match(second.stdout, /cwd /);
      assert.match(second.stdout, /44/);
      assert.equal(second.value, "44");
      assert.equal(second.executionCount, 2);
      // A later call still sees the earlier bindings: that is the point of the retained kernel.
      const third = await kernel.execute(
        'sorted(name for name in ("value", "rows", "math") if name in globals())',
      );
      assert.deepEqual(JSON.parse(third.value!.replace(/'/g, '"')), [
        "math",
        "rows",
        "value",
      ]);
    } finally {
      await kernel.shutdown();
    }
    assert.equal(kernel.alive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cells capture prints separately from errors, and a failed cell keeps completed bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "methodiy-kernel-"));
  try {
    const kernel = await PythonKernel.start({ python, cwd: root });
    try {
      const failed = await kernel.execute(
        'kept = 7\nprint("before")\nraise ValueError("boom")',
      );
      assert.match(failed.stdout, /before/);
      assert.match(failed.error ?? "", /ValueError: boom/);
      assert.doesNotMatch(failed.error ?? "", /runner\.py/);
      const after = await kernel.execute("kept");
      assert.equal(after.value, "7");
      const stderr = await kernel.execute(
        'import sys\nprint("warn", file=sys.stderr)',
      );
      assert.match(stderr.stderr, /warn/);
      const raw = await kernel.execute(
        'import os\nos.write(1, b"raw-bytes\\n")\nprint("python-level")',
      );
      assert.match(raw.stdout, /python-level/);
      assert.doesNotMatch(raw.stdout, /raw-bytes/);
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout raises KeyboardInterrupt and the kernel survives for the next cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "methodiy-kernel-"));
  try {
    const kernel = await PythonKernel.start({ python, cwd: root });
    try {
      const interrupted = await kernel.execute("while True:\n    pass", {
        timeoutMs: 1_200,
      });
      assert.equal(interrupted.cancelled, true);
      assert.match(interrupted.error ?? "", /KeyboardInterrupt/);
      const next = await kernel.execute("2 + 2");
      assert.equal(next.value, "4");
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one retained kernel per project, a dead kernel is replaced, and shutdown clears the registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "methodiy-kernel-"));
  try {
    const first = await pythonKernel(root, python);
    await first.execute('token = "persisted"');
    const same = await pythonKernel(root, python);
    assert.equal((await same.execute("token")).value, "'persisted'");
    await first.shutdown();
    const restarted = await pythonKernel(root, python);
    const afterRestart = await restarted.execute('"token" in globals()');
    assert.equal(afterRestart.value, "False");
    await shutdownPythonKernels();
    assert.equal(restarted.alive, false);
    assert.equal(await resolvePython(root, python), python);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing interpreter is reported before any cell runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "methodiy-kernel-"));
  try {
    await assert.rejects(
      resolvePython(root, path.join(root, "absent-python")),
      /Python interpreter not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
