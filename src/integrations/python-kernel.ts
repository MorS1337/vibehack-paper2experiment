import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionEnv } from "../compute/process.js";

/**
 * Retained Python kernel, following omp's eval backend (`eval/py/kernel.ts` and
 * `eval/py/runner.py`): one `python -u runner.py` subprocess per experiment,
 * NDJSON over stdin/stdout, state kept between cells and across turns, and
 * cancellation as `SIGINT` (a real `KeyboardInterrupt`) with SIGKILL escalation
 * only when the cell cannot be interrupted.
 *
 * The runner owns its control descriptor, so `print`, `sys.stdout`, and raw
 * fd-1 writes from user code can never corrupt a frame.
 */

const STARTUP_TIMEOUT_MS = 15_000;
const INTERRUPT_ESCALATION_MS = 5_000;
const MAX_OUTPUT = 64 * 1024;

const RUNNER_SOURCE = String.raw`
import ast, io, json, os, sys, traceback

_control = os.fdopen(os.dup(0), "r", encoding="utf-8", errors="replace")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
_channel = os.fdopen(os.dup(1), "w", encoding="utf-8", errors="replace")
os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
_namespace = {"__name__": "__main__", "__builtins__": __builtins__}
_count = 0

def emit(frame):
    _channel.write(json.dumps(frame, ensure_ascii=False) + "\n")
    _channel.flush()

def describe(error):
    rows = traceback.format_exception(type(error), error, error.__traceback__)
    return "".join(row for row in rows if "runner.py" not in row).strip() or repr(error)

def cell(request):
    global _count
    identifier = request.get("id")
    filename = request.get("filename") or "<cell>"
    _count += 1
    emit({"type": "started", "id": identifier})
    out, err = io.StringIO(), io.StringIO()
    keep_out, keep_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    value, error, cancelled = None, None, False
    try:
        tree = ast.parse(request.get("code") or "", filename=filename, mode="exec")
        tail = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            tail = ast.Expression(tree.body.pop().value)
        exec(compile(tree, filename, "exec"), _namespace)
        if tail is not None:
            result = eval(compile(tail, filename, "eval"), _namespace)
            if result is not None:
                value = repr(result)
                print(value)
    except KeyboardInterrupt:
        cancelled, error = True, "KeyboardInterrupt"
    except SystemExit as exiting:
        error = "SystemExit: %s" % (exiting.code,)
    except BaseException as caught:
        error = describe(caught)
    finally:
        sys.stdout, sys.stderr = keep_out, keep_err
    emit({
        "type": "done",
        "id": identifier,
        "executionCount": _count,
        "status": "cancelled" if cancelled else ("error" if error else "ok"),
        "value": value,
        "stdout": out.getvalue()[:65536],
        "stderr": err.getvalue()[:65536],
        "error": error,
    })

emit({"type": "ready"})
for raw in _control:
    try:
        request = json.loads(raw)
    except Exception:
        continue
    if request.get("type") == "exit":
        break
    if "code" not in request:
        continue
    try:
        cell(request)
    except Exception as crash:
        emit({"type": "fatal", "error": describe(crash)})
        break
`;

export interface KernelResult {
  value: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
  cancelled: boolean;
  executionCount: number;
  durationMs: number;
}

interface Frame {
  type: string;
  id?: string;
  status?: string;
  stdout?: string;
  stderr?: string;
  value?: string | null;
  error?: string;
  executionCount?: number;
}

export interface KernelOptions {
  python: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Stage the runner once per content hash rather than per kernel start. */
let runnerPath: Promise<string> | undefined;
function stageRunner(): Promise<string> {
  runnerPath ??= (async () => {
    const hash = createHash("sha256")
      .update(RUNNER_SOURCE)
      .digest("hex")
      .slice(0, 12);
    const directory = path.join(
      os.tmpdir(),
      `methodiy-python-runner-${process.getuid?.() ?? process.pid}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `runner-${hash}.py`);
    await writeFile(file, RUNNER_SOURCE, { mode: 0o600 });
    return file;
  })();
  return runnerPath;
}

function trim(text: string): string {
  return text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, MAX_OUTPUT)}\n[output truncated]`;
}

export class PythonKernel {
  private child?: ChildProcess;
  private pending?: {
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
  };
  private buffer = "";
  private diagnostics = "";
  private failure?: Error;
  private ready = false;
  private sequence = 0;
  private exited = true;

  private constructor(
    readonly python: string,
    readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static async start(options: KernelOptions): Promise<PythonKernel> {
    const kernel = new PythonKernel(options.python, options.cwd, {
      ...executionEnv(),
      ...options.env,
    });
    await kernel.launch();
    return kernel;
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  private async launch(): Promise<void> {
    const runner = await stageRunner();
    const child = spawn(this.python, ["-u", runner], {
      cwd: this.cwd,
      env: {
        ...this.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        MPLBACKEND: this.env.MPLBACKEND ?? "Agg",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.exited = false;
    this.ready = false;
    this.failure = undefined;
    this.buffer = "";
    this.diagnostics = "";
    const ready = Promise.withResolvers<void>();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.diagnostics = trim(this.diagnostics + chunk);
    });
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        if (frame.type === "ready") {
          this.ready = true;
          ready.resolve();
          continue;
        }
        this.settle(frame);
      }
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.ready = false;
      const reason = new Error(
        `Python kernel exited (${signal ?? code ?? "unknown"}); retained state was lost. The next call starts a fresh kernel.`,
      );
      this.failure ??= reason;
      ready.reject(this.failure);
      this.pending?.reject(reason);
      this.pending = undefined;
    });
    child.on("error", (error: Error) => {
      this.failure = error;
      this.exited = true;
      ready.reject(error);
      this.pending?.reject(error);
      this.pending = undefined;
    });
    const timeout = setTimeout(
      () =>
        ready.reject(
          new Error(
            `Python kernel did not start within ${STARTUP_TIMEOUT_MS / 1000}s`,
          ),
        ),
      STARTUP_TIMEOUT_MS,
    );
    try {
      await ready.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  private settle(frame: Frame): void {
    if (frame.type === "fatal") {
      this.failure = new Error(frame.error ?? "Python runner failed");
      this.pending?.reject(this.failure);
      this.pending = undefined;
      return;
    }
    if (frame.type === "done" || frame.type === "error") {
      this.pending?.resolve(frame);
      this.pending = undefined;
    }
  }

  async execute(
    code: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<KernelResult> {
    if (!this.child || !this.alive || !this.ready)
      throw this.failure ?? new Error("Python kernel is not running");
    const started = Date.now();
    const id = `cell-${++this.sequence}`;
    const deferred = Promise.withResolvers<Frame>();
    this.pending = deferred;
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      void this.interrupt();
    }, options.timeoutMs ?? 30_000);
    const abort = () => {
      void this.interrupt();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) {
        abort();
      } else
        this.child.stdin?.write(
          `${JSON.stringify({ id, code, cwd: this.cwd })}\n`,
        );
      const frame = await deferred.promise;
      if (timedOut.value && !frame.error)
        frame.error = "Cell interrupted after the timeout";
      return {
        value: frame.value ?? null,
        stdout: trim(frame.stdout ?? ""),
        stderr: trim(
          [frame.stderr ?? "", this.diagnostics].filter(Boolean).join("\n"),
        ),
        error: frame.error ?? (frame.status === "error" ? "Cell failed" : null),
        cancelled: frame.status === "cancelled",
        executionCount: frame.executionCount ?? 0,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (this.pending === deferred) this.pending = undefined;
    }
  }

  /** SIGINT first, exactly like omp; escalate to SIGKILL only if the cell will not yield. */
  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.kill("SIGINT");
    const settled = await Promise.race([
      new Promise<boolean>((resolve) => {
        const timer = setInterval(() => {
          if (!this.pending) {
            clearInterval(timer);
            resolve(true);
          }
        }, 25);
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), INTERRUPT_ESCALATION_MS),
      ),
    ]);
    if (!settled) await this.shutdown(true);
  }

  async shutdown(kill = false): Promise<void> {
    const child = this.child;
    if (!child || this.exited) {
      this.child = undefined;
      return;
    }
    const closed = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    if (kill) {
      this.child = undefined;
      this.exited = true;
      child.kill("SIGKILL");
      await closed;
      return;
    }
    try {
      child.stdin?.write('{"type":"exit"}\n');
    } catch {
      /* stdin already closed */
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    await closed;
    clearTimeout(timer);
    this.child = undefined;
    this.exited = true;
  }
}

const kernels = new Map<string, Promise<PythonKernel>>();

/** The experiment's own `.venv` wins, so the agent explores with installed dependencies. */
export async function resolvePython(
  projectDir: string,
  configured: string,
): Promise<string> {
  const venv =
    process.platform === "win32"
      ? path.join(projectDir, ".venv", "Scripts", "python.exe")
      : path.join(projectDir, ".venv", "bin", "python");
  if (
    await access(venv).then(
      () => true,
      () => false,
    )
  )
    return venv;
  const candidate = configured.trim() || "python3";
  if (!candidate.includes("/") && !candidate.includes("\\")) return candidate;
  if (
    await access(candidate).then(
      () => true,
      () => false,
    )
  )
    return candidate;
  throw new Error(
    `Python interpreter not found: ${candidate}. Correct the path in Settings → Python.`,
  );
}

/** One retained kernel per experiment project directory, shared across turns. */
export function pythonKernel(
  projectDir: string,
  python: string,
): Promise<PythonKernel> {
  const key = path.resolve(projectDir);
  const existing = kernels.get(key);
  if (existing)
    return existing.then((kernel) =>
      kernel.alive ? kernel : start(key, python),
    );
  return start(key, python);
}

function start(key: string, python: string): Promise<PythonKernel> {
  const created = PythonKernel.start({ python, cwd: key }).catch((error) => {
    kernels.delete(key);
    throw error;
  });
  kernels.set(key, created);
  return created;
}

export async function shutdownPythonKernels(): Promise<void> {
  const all = [...kernels.values()];
  kernels.clear();
  await Promise.all(
    all.map(async (entry) => {
      try {
        const kernel = await entry;
        await kernel.shutdown();
      } catch {
        /* already dead */
      }
    }),
  );
}
