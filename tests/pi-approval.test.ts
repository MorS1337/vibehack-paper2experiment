import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import baseline from "../demos/bernoulli-hoeffding/spec.json" with { type: "json" };
import { SpecSchema } from "../src/shared/types.js";
import { Store, defaultSettings } from "../src/core/store.js";
import { converseWithPi } from "../src/integrations/pi.js";

test("one persistent conversation rejects writes before approval and again after approval is revoked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "p2e-approval-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const filenames = ["blocked-before.py", "approved.py", "blocked-after.py"];
  const results: string[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const index = requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `completion-${index}`, object: "chat.completion.chunk", created: 1, model: "permission-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (index % 2 === 0) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `write-${index}`,
            type: "function",
            function: {
              name: "hashline",
              arguments: JSON.stringify({
                path: filenames[Math.floor(index / 2)],
                content: "approved scientific work\n",
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      results.push(
        String(
          body.messages.findLast(
            (message: { role: string }) => message.role === "tool",
          )?.content,
        ),
      );
      send({
        role: "assistant",
        content: "The requested operation has finished.",
      });
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
          "permission-test": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "isolated-non-secret",
            models: [
              {
                id: "permission-model",
                contextWindow: 128000,
                maxTokens: 1024,
              },
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
      timeSeconds: 60,
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
        piProvider: "permission-test",
        piModel: "permission-model",
      },
      signal: AbortSignal.timeout(30000),
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
    await converseWithPi(context, "Write the implementation.", hooks);
    await assert.rejects(stat(path.join(projectDir, filenames[0])), {
      code: "ENOENT",
    });
    assert.match(results[0], /not been approved/);
    run.spec = SpecSchema.parse(baseline);
    run.planVersion = run.spec.version;
    run.approvedPlanVersion = run.planVersion;
    await converseWithPi(
      context,
      "The protocol is now approved. Write the implementation.",
      hooks,
    );
    assert.equal(
      await readFile(path.join(projectDir, filenames[1]), "utf8"),
      "approved scientific work\n",
    );
    run.approvedPlanVersion = undefined;
    await converseWithPi(
      context,
      "A revision invalidated approval. Try writing again.",
      hooks,
    );
    await assert.rejects(stat(path.join(projectDir, filenames[2])), {
      code: "ENOENT",
    });
    assert.match(results[2], /not been approved/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});
