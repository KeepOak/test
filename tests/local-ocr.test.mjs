/**
 * RES-127: documents.ocr reads text from a workspace picture or scanned PDF on this computer. It takes
 * only pictures and PDFs inside the task's workspace, and refuses an oversized picture before any
 * OCR program runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/** Just a PNG signature and header claiming a picture far over the 4-megapixel cap. */
function hugePng() {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(9000, 16); header.writeUInt32BE(9000, 20); header[24] = 8; header[25] = 2;
  return header;
}

test("RES-127: OCR takes workspace pictures only, and refuses an oversized one before reading it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-local-ocr-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await writeFile(join(workspace, "notes.txt"), "plain words");
  await writeFile(join(workspace, "big.png"), hugePng());
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "read a scan").id, permissions: app.registry.permissions() });
  await assert.rejects(app.registry.execute("documents.ocr", { path: "notes.txt" }, context), /PNG, JPEG and PDF/);
  await assert.rejects(app.registry.execute("documents.ocr", { path: "../outside.png" }, context));
  await assert.rejects(app.registry.execute("documents.ocr", { path: "big.png" }, context), /4 megapixels/);
});
