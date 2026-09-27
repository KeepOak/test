// Seeds a fresh engine data folder for verify-shell3.cjs: one conversation whose task changed one file and made
// another, written down the way src/index.ts writes a file change (a "file.changed" event with the engine's own line
// diff), and one paired device in the Devices book, so the switcher has a device to rename. Run it while the engine
// is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-shell.mjs
// then start the engine with the same two folders. Prints the conversation's id and the device's id as JSON.
import { resolve } from "node:path";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { createBranch } from "../../../dist/index.js";
import { lineDiff } from "../../../dist/workspace-history.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };

const app = await createBranch({ workspace, dataDir, provider: quiet });
try {
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "Tidy the notes");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  const changed = { path: "notes/plan.md", versionId: randomUUID(), existed: true, ...lineDiff("one\ntwo\nthree", "one\n2\nthree\nfour") };
  const made = { path: "notes/new.md", versionId: randomUUID(), existed: false, ...lineDiff("", "# New\nhello") };
  app.store.event(run.id, "file.changed", changed);
  app.store.event(run.id, "file.changed", made);
  app.store.message(run.sessionId, { role: "assistant", content: "Tidied." });
  app.store.finish(run.id, "completed", "Tidied.");

  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const device = { id: randomBytes(8).toString("hex"), name: "seed-phone", platform: "android", publicKey, pairedAt: new Date().toISOString() };
  app.store.save("settings", owner, "devices-book", { mode: "off", devices: [device], requests: [] });
  console.log(JSON.stringify({ session: run.sessionId, device: device.id, changed: changed.path, made: made.path }));
} finally {
  await app.close();
}
