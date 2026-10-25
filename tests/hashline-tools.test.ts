import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import baseline from "../demos/bernoulli-hoeffding/spec.json" with { type: "json" };
import { SpecSchema } from "../src/shared/types.js";
import { Store, defaultSettings } from "../src/core/store.js";
import { converseWithPi } from "../src/integrations/pi.js";
import { shutdownPythonKernels } from "../src/integrations/python-kernel.js";

type ToolCall = { name: string; arguments: Record<string, unknown> };

const projectFile = "notes.txt";
const original = "alpha\nbeta\ngamma\n";

test("hashline and the retained Python kernel work through the agent, and stay approval-gated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "p2e-tools-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let turn = 0;
  let step = 0;
  const lastTurnResults: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { role: string; content: unknown }[];
    };
    const tools = body.messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    const call = (position: number, lastTool: string): ToolCall | null => {
      if (turn === 0)
        return position === 0
          ? {
              name: "hashline",
              arguments: {
                input: `[${projectFile}#0000]\nPUT 2.=2:\n+blocked`,
              },
            }
          : null;
      if (turn === 1) {
        if (position === 0)
          return { name: "read", arguments: { path: projectFile } };
        if (position === 1) {
          const tag = /\[notes\.txt#([0-9A-F]{4})\]/.exec(lastTool)?.[1];
          assert.ok(
            tag,
            `read must return a hashline header; got: ${lastTool.slice(0, 500)}`,
          );
          return {
            name: "hashline",
            arguments: {
              input: `[${projectFile}#${tag}]\nPUT 2.=2:\n+BETA\nPUT >$:\n+delta`,
            },
          };
        }
        if (position === 2) {
          return {
            name: "python",
            arguments: { code: 'counter = 5\nprint("seeded")' },
          };
        }
        return null;
      }
      if (turn === 2)
        return position === 0
          ? { name: "python", arguments: { code: "counter * 2" } }
          : null;
      return null;
    };
    const position = step++;
    const lastTool = tools.at(-1) ?? "";
    if (turn === 2 && lastTool) lastTurnResults.push(lastTool);
    const next = call(position, lastTool);
    const model = "tools-model";
    const id = `completion-${turn}-${position}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (next) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${turn}-${position}`,
            type: "function",
            function: {
              name: next.name,
              arguments: JSON.stringify(next.arguments),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: `turn ${turn} complete` });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      path.join(root, "models.json"),
      JSON.stringify({
        providers: {
          "tools-test": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "isolated-non-secret",
            models: [
              { id: "tools-model", contextWindow: 128000, maxTokens: 2048 },
            ],
          },
        },
      }),
    );
    const store = new Store(path.join(root, "state"));
    await store.load();
    const run = await store.create({
      agentMode: "pi",
      source: "local.pdf",
      task: "Check a theorem.",
      mode: "local",
      timeSeconds: 120,
      maxHourlyUSD: 0,
      maxTotalUSD: 0,
      cleanup: "destroy",
    });
    run.source = {
      original: "local.pdf",
      textPath: "source.txt",
      sha256: "fixture",
      pages: [{ page: 1, text: "Independent bounded variables." }],
    };
    const projectDir = path.join(run.dir, "project");
    const context = {
      run,
      settings: {
        ...defaultSettings,
        piProvider: "tools-test",
        piModel: "tools-model",
      },
      signal: AbortSignal.timeout(60000),
      emit: async () => undefined,
      projectDir,
      queued: [],
      persist: (patch: Partial<typeof run>) => store.patch(run.id, patch),
      publish: () => undefined,
      attach: () => undefined,
      acknowledge: async () => undefined,
    };
    const hooks = {
      propose: async () => {
        throw new Error("No proposal expected");
      },
      execute: async () => {
        throw new Error("No workload expected");
      },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, projectFile), original);

    // 1. Before approval the edit never runs, even though the model issued it.
    turn = 0;
    step = 0;
    await converseWithPi(context, "Edit the notes.", hooks);
    assert.equal(
      await readFile(path.join(projectDir, projectFile), "utf8"),
      original,
    );

    run.spec = SpecSchema.parse(baseline);
    run.planVersion = run.spec.version;
    run.approvedPlanVersion = run.planVersion;

    // 2. Approved: read → anchored edit → Python seeds state.
    turn = 1;
    step = 0;
    await converseWithPi(context, "Read, edit, then seed the kernel.", hooks);
    assert.equal(
      await readFile(path.join(projectDir, projectFile), "utf8"),
      "alpha\nBETA\ngamma\ndelta\n",
    );

    // 3. A later turn reuses the same kernel, so the binding survives.
    turn = 2;
    step = 0;
    lastTurnResults.length = 0;
    await converseWithPi(context, "Compute twice the counter.", hooks);
    assert.match(
      lastTurnResults.join("\n"),
      /^10$/m,
      "the second cell must read the first cell's binding",
    );
    assert.equal(await runPythonProbe(projectDir), "10");
  } finally {
    await shutdownPythonKernels();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});

/** Read the retained kernel's answer without starting a second process. */
async function runPythonProbe(projectDir: string): Promise<string> {
  const { pythonKernel, resolvePython } = await import(
    "../src/integrations/python-kernel.js"
  );
  const kernel = await pythonKernel(
    projectDir,
    await resolvePython(projectDir, "python3"),
  );
  const result = await kernel.execute("counter * 2");
  return result.value ?? "";
}
