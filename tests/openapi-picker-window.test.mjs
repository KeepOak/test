/* Settings › Developer › "Turn an OpenAPI file into tools" is live: Choose a file reads the description in the window,
   the engine's dry run lists its operations, and Add registers only the ticked ones (tools.services says so). Both go
   through POST /api/tools/try; when the engine asks first, Allow once sends the same request once.
   Mutation: in public/app/settings/openapi-pick.js send every operation in request() (allowlist: available) and the
   "only the ticked one" assertion goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, setLevel } from "./settings-window.mjs";

const DOC = JSON.stringify({
  openapi: "3.0.0", info: { title: "Tiny notes", version: "1" }, servers: [{ url: "http://127.0.0.1:9/v1" }],
  paths: {
    "/notes": { get: { operationId: "listNotes", summary: "List the notes" }, post: { operationId: "addNote", summary: "Add a note" } },
    "/notes/{id}": { delete: { operationId: "removeNote", summary: "Remove a note" } },
  },
});

test("a chosen OpenAPI file lists its operations, and Add makes tools of the ticked ones only", async (t) => {
  const { page, errors, app } = await settingsWindow(t, { name: "openapi-picker",
    before: (branch) => branch.web.policy.configure({ allowPrivateAddresses: true }) }); // the service is on this computer; nothing calls it
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".settings").waitFor();
  await setLevel(page, "technical"); // Developer is listed at Technical
  await page.locator('[data-act="setpage"][data-v="developer"]').first().click();
  const choose = page.locator('[data-act="openapi-pick"]');
  await choose.waitFor();
  assert.equal(await choose.getAttribute("aria-disabled"), null, "Choose a file is live");

  const chooser = page.waitForEvent("filechooser");
  await choose.click();
  await (await chooser).setFiles({ name: "Tiny Notes.json", mimeType: "application/json", buffer: Buffer.from(DOC) });
  const allow = async () => { if (await page.locator('.dlg [data-act="oa-yes"]').isVisible().catch(() => false)) await page.locator('.dlg [data-act="oa-yes"]').click(); };
  await page.locator(".dlg .oa-ops, .dlg [data-act='oa-yes']").first().waitFor({ timeout: 20000 });
  await allow(); // the engine may ask before the dry run
  await page.locator(".dlg .oa-ops").waitFor({ timeout: 20000 });
  assert.deepEqual(await page.locator(".dlg .oa-op b").allTextContents(), ["GET /notes", "POST /notes", "DELETE /notes/{id}"]);
  assert.equal(await page.locator("#oa-name").inputValue(), "tiny_notes", "a name the engine takes, from the file's");
  assert.equal(await page.locator('.dlg [data-act="oa-add"]').isDisabled(), true, "nothing ticked, nothing to add");

  await page.locator('.dlg [data-op="listNotes"]').check();
  await page.locator('.dlg [data-act="oa-add"]').click();
  await page.locator('.dlg [data-act="oa-yes"], .toast').first().waitFor({ timeout: 20000 });
  await allow(); // and before adding
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 20000 });
  const { services } = await app.runtime.executeTool("tools.services", {});
  assert.deepEqual(services.map((one) => [one.name, one.tools]), [["tiny_notes", ["api.tiny_notes.list_notes"]]], "only the ticked one");
  assert.deepEqual(errors, []);
});
