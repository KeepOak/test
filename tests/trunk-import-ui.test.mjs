import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

/* TRUNK-036: a .branch-trunk file is reviewed by name and then brought in as a new Trunk that only looks. */
test("Customize › Trunks imports a Trunk file after showing its name", async (t) => {
  let file;
  const { app, page, errors } = await newWindow(t, { seed: async (branch) => {
    const ada = branch.trunks.create({ name: "Ada" });
    file = branch.trunks.exportFile(ada.id);
    file = { ...file, trunk: { ...file.trunk, name: "Moss" } };
  } });
  const before = app.trunks.records.list().length;
  const place = await openPlace(page, "customize", "trunks");
  await place.locator('[data-act="trunk-import"]').click();
  const dialog = page.locator(".dlg");
  const save = dialog.locator('[data-act="trunk-import-save"]');
  assert.equal(await save.isDisabled(), true, "nothing to import before a file is chosen");
  await dialog.locator("#trunk-import-file").setInputFiles({ name: "moss.branch-trunk", mimeType: "application/json", buffer: Buffer.from("not json") });
  await page.locator(".toast, [role=status]").filter({ hasText: /JSON|Unexpected|not a Branch Trunk/ }).first().waitFor();
  assert.equal(await save.isDisabled(), true, "a broken file cannot be imported");
  await dialog.locator("#trunk-import-file").setInputFiles({ name: "moss.branch-trunk", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await dialog.getByText("Moss", { exact: true }).waitFor();
  await save.click();
  await dialog.waitFor({ state: "detached" });
  const trunks = app.trunks.records.list();
  assert.equal(trunks.length, before + 1);
  const moss = trunks.find((trunk) => trunk.name === "Moss");
  assert.ok(moss, "the file became a new Trunk");
  assert.ok(moss.permissions.length > 0 && moss.permissions.every((permission) => permission.endsWith(".read")), "it only looks");
  assert.deepEqual(moss.mcpServers, []);
  assert.deepEqual(errors, []);
});
