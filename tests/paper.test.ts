import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { Harness } from "../src/core/harness.js";
import { importSource } from "../src/core/source.js";
import { sourcePdfPath } from "../src/core/paper.js";

function paperFixture(): string {
  const text =
    "Independent bounded random variables admit concentration bounds. This paper states the assumptions and explains a reproducible scientific experiment with explicit uncertainty.";
  const stream = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Title (Bounded variables fixture) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  return `${pdf}xref\n0 7\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function importedDraft(root: string) {
  const file = path.join(root, "paper.pdf");
  await writeFile(file, paperFixture());
  const store = new Store(path.join(root, "state"));
  await store.load();
  const run = await store.create({
    agentMode: "pi",
    source: file,
    task: "",
    mode: "local",
    timeSeconds: 300,
    maxHourlyUSD: 0,
    maxTotalUSD: 0,
    cleanup: "destroy",
  });
  const source = await importSource(run, AbortSignal.timeout(10000));
  await store.patch(run.id, { source });
  return { store, run: store.get(run.id), source };
}

test("paper draft preserves the original and locks source identity before accepting its research brief", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "p2e-paper-"));
  try {
    const { store, run, source } = await importedDraft(root);
    const harness = new Harness(store);
    assert.equal(source.title, "Bounded variables fixture");
    assert.equal(source.pages[0].page, 1);
    assert.match(source.pages[0].text, /Independent bounded random variables/);
    assert.deepEqual(
      await readFile(source.original),
      Buffer.from(paperFixture()),
    );
    await assert.rejects(
      harness.sendMessage(run.id, "Start coding"),
      /research brief/,
    );
    const brief = {
      ...run.input,
      task: "Check the bound, distinguish theory from sampling uncertainty.",
      timeSeconds: 60,
    };
    await assert.rejects(
      harness.setBrief(run.id, { ...brief, source: "/different.pdf" }),
      /imported paper/,
    );
    assert.equal(run.input.task, "");
    await harness.setBrief(run.id, brief);
    await assert.rejects(
      harness.setBrief(run.id, {
        ...brief,
        task: "Silently change the objective",
      }),
      /only be set/,
    );
    const restored = new Store(store.root);
    await restored.load();
    assert.deepEqual(restored.get(run.id).input, brief);
    assert.equal(restored.get(run.id).source?.sha256, source.sha256);
    assert.equal(restored.get(run.id).sessionFile, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PDF access rejects changed bytes and symlink replacement, even when metadata still names a valid paper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "p2e-paper-integrity-"));
  try {
    const { run } = await importedDraft(root);
    const imported = await sourcePdfPath(run);
    await writeFile(imported, `${paperFixture()}changed`);
    await assert.rejects(sourcePdfPath(run), /SHA256 changed/);
    await rm(imported);
    await symlink(run.input.source, imported);
    await assert.rejects(sourcePdfPath(run), /symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
