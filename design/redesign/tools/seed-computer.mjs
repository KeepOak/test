// Seeds a fresh engine data folder with one conversation whose tasks really used the browser, the computer and the
// command line, the way src/runtime.ts writes them down (tests/panels.test.mjs seeds the same way), plus a newer task in
// the same conversation left waiting for an answer, so Stop has something to stop. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-computer.mjs
// then start the engine with the same two folders and run verify-computer.cjs. Prints the conversation's id as JSON.
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
// A small grey picture, made here, so the window can show that the bytes arrived.
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
// Two sizes, so a check can tell the browser's picture (64 wide) from the computer's (48 wide).

const app = await createBranch({ workspace, dataDir, provider: quiet });
try {
  const run = app.store.createRun(app.runtime.owner, "Compare the quotes");
  const session = run.sessionId;
  const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
  app.store.message(session, { role: "user", content: run.prompt });
  app.store.message(session, { role: "assistant", content: "", toolCalls: [
    call("c1", "browser.navigate", { url: "https://example.com/prices" }),
    call("c2", "browser.screenshot", {}),
    call("c3", "desktop.screenshot", {}),
    call("c4", "shell.execute", { executable: "node", args: ["compare.mjs"] }),
  ] });
  const page = await app.runtime.artifacts.write(run.id, "screenshot-seed.png", "image/png", png(64, 40));
  const desk = await app.runtime.artifacts.write(run.id, "desktop-seed.png", "image/png", png(48, 30));
  const results = {
    c1: { url: "https://example.com/prices", title: "Prices" },
    c2: { ...page, url: "https://example.com/prices" },
    c3: { ...desk, window: "", width: 48, height: 30 },
    c4: { exitCode: 0, stdout: "compared", stderr: "" },
  };
  const names = { c1: "browser.navigate", c2: "browser.screenshot", c3: "desktop.screenshot", c4: "shell.execute" };
  for (const [id, result] of Object.entries(results)) {
    app.store.event(run.id, "tool.started", { name: names[id], id });
    app.store.event(run.id, "tool.completed", { name: names[id], id, result });
    app.store.message(session, { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, result }) });
  }
  app.store.message(session, { role: "assistant", content: "Compared." });
  app.store.finish(run.id, "completed", "Compared.");
  const waiting = app.store.createRun(app.runtime.owner, "And the next one", session);
  app.store.finish(waiting.id, "needs_input", "");
  console.log(JSON.stringify({ session, waiting: waiting.id, browserPicture: page.path, desktopPicture: desk.path }));
} finally {
  await app.close();
}
