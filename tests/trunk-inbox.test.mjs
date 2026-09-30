import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const quiet = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

/* TRUNK-135: each Trunk has its own Inbox, read from the Trunk each task recorded, never from today's chat routing. */
test("a Trunk's Inbox lists only the tasks that Trunk ran", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-inbox-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, method = "GET") => fetch(new URL(path, server.url), { method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  const adas = await app.runtime.run({ prompt: "plan the week", trunkId: ada.id });
  const bos = await app.runtime.run({ prompt: "water the plants", trunkId: bo.id });
  const nobody = await app.runtime.run({ prompt: "what time is it" });

  const response = await call(`/api/trunks/${ada.id}/inbox`);
  assert.equal(response.status, 200);
  const inbox = await response.json();
  assert.deepEqual(inbox.trunk, { id: ada.id, name: "Ada" });
  const ids = inbox.runs.map((run) => run.id);
  assert.ok(ids.includes(adas.id), "Ada's own task is listed");
  assert.ok(!ids.includes(bos.id), "Bo's task is not");
  assert.ok(!ids.includes(nobody.id), "a task with no recorded Trunk is not guessed");
  assert.deepEqual([inbox.asks, inbox.deferred, inbox.messages], [[], [], []]);
  assert.equal(inbox.limits.historyCapped, false);

  const other = await (await call(`/api/trunks/${bo.id}/inbox`)).json();
  assert.deepEqual(other.runs.map((run) => run.id).filter((id) => [adas.id, bos.id, nobody.id].includes(id)), [bos.id]);
  assert.notEqual((await call(`/api/trunks/${ada.id}/inbox`, "POST")).status, 200, "reading only");
});

test("the Trunk's conversation menu opens its Inbox with that Trunk's own task", async (t) => {
  const { newWindow } = await import("./new-window-places.mjs");
  const w = await newWindow(t, { provider: quiet });
  await w.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const wren = (await w.call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  const pike = (await w.call("/api/trunks", { name: "Pike", title: "Checks" })).trunk;
  await w.page.reload();
  await w.page.locator("#app #side").waitFor({ state: "visible" });
  // The Trunk's own conversation is open (its menu has the Trunk's items); its tasks run in their own conversations.
  await w.page.locator(`#side [data-act="chat"][data-line="${wren.id}"]`).first().click();
  await w.page.locator(`#side [data-act="chat"][data-line="${wren.id}"][aria-current="true"]`).first().waitFor();
  await w.app.runtime.run({ prompt: "check the gutters", trunkId: wren.id });
  await w.app.runtime.run({ prompt: "sweep the porch", trunkId: pike.id });
  await w.page.locator('[data-act="chatmenu"]').filter({ visible: true }).first().click();
  await w.page.locator(`.pop [data-act="trunk-inbox"][data-id="${wren.id}"]`).click();
  const dialog = w.page.locator(".dlg");
  await dialog.getByText("check the gutters").first().waitFor();
  assert.equal(await dialog.getByText("sweep the porch").count(), 0, "another Trunk's task is not listed");
  assert.deepEqual(w.errors, []);
});
