import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExperimentRun } from "../shared/types.js";

/** Only the imported, hashed PDF is exposed to the renderer, never an arbitrary local path. */
export async function sourcePdfPath(run: ExperimentRun): Promise<string> {
  if (!run.source) throw new Error("Paper has not been imported");
  const root = await realpath(run.dir);
  const folder = path.join(root, "source");
  const file = path.join(folder, "document.pdf");
  if (
    (await lstat(folder)).isSymbolicLink() ||
    (await lstat(file)).isSymbolicLink()
  )
    throw new Error("Paper symlinks are not allowed");
  if ((await realpath(file)) !== file)
    throw new Error("Paper path is not canonical");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 40 * 1024 * 1024)
      throw new Error("Invalid PDF size");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 40 * 1024 * 1024)
        throw new Error("PDF exceeds the import limit");
      hash.update(chunk);
    }
    if (hash.digest("hex") !== run.source.sha256)
      throw new Error("Paper SHA256 changed since import");
  } finally {
    await handle.close();
  }
  return file;
}
