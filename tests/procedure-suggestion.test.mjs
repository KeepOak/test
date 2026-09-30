/**
 * Batch E (places-030): a Trunk suggests a change to a procedure that starts itself (the procedures.auto.suggest_change
 * tool, src/autonomy/procedures.ts suggestChange), and the owner answers it in the flow editor
 * (public/app/flows/flow-editor.js: "<Trunk> suggests a change", See the change, Keep it as it is, Approve version N).
 * Nothing changes before the owner's yes; a no is kept so the same suggestion is never made again. Temporary folders
 * and a scripted model only; the browser is headless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { pickGsel, gselChoices } from "./gsel.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-procedure-suggestion-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json();
    if (response.status !== 200) throw new Error(`${response.status} ${answer.error}`);
    return answer;
  };
  await api("/api/autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
  const { procedure } = await api("/api/autonomy/procedures", { name: "Month-end report", start: { kind: "manual" },
    steps: [{ title: "Read", prompt: "Read the card statement." }, { title: "Match", prompt: "Match receipts in Downloads." }] });
  const trunk = (await api("/api/trunks", { name: "Ledger" })).trunk;
  const context = (from = trunk.id) => ({ ...app.runtime.context({ source: "owner", runId: app.store.createRun(app.runtime.owner, "month end").id }), ...(from ? { trunk: from } : {}) });
  const suggest = (input, from) => app.registry.execute("procedures.auto.suggest_change", { procedureId: procedure.id, ...input }, context(from));
  return { app, server, api, procedure, trunk, suggest, context };
}

const withCheck = [{ title: "Read", prompt: "Read the card statement." }, { title: "Check", prompt: "Ask me for any missing receipt.", confirm: true },
  { title: "Match", prompt: "Match receipts in Downloads." }];
const why = "Last month two receipts were missing and the report had to be built twice.";

test("a Trunk's suggestion waits for the owner, names the Trunk and why, and a no is never suggested again", async (t) => {
  const { app, api, procedure, trunk, suggest, context } = await fixture(t);
  const asked = await suggest({ steps: withCheck, why });
  assert.equal(asked.waiting, true);
  assert.deepEqual(app.autonomy.procedures.get(procedure.id).procedure.steps, procedure.procedure.steps, "nothing changes before the yes");
  const entry = (await api("/api/autonomy/ledger")).entries.find((e) => e.id === asked.id);
  assert.deepEqual([entry.kind, entry.from, entry.payload.procedureId, entry.payload.trunk, entry.payload.why], ["procedure", "assistant", procedure.id, trunk.id, why]);
  assert.match(entry.detail, /^Why: Last month/);
  assert.equal((await suggest({ steps: withCheck, why })).waiting, false, "the same suggestion is not asked twice");

  await api("/api/autonomy/decide", { id: asked.id, yes: false });
  const again = await suggest({ steps: withCheck, why: "Said differently this time." });
  assert.deepEqual([again.waiting, again.said], [false, "The owner already said no to this change; do not suggest it again."]);

  const other = await suggest({ steps: withCheck.slice(1), why });
  const { made } = await api("/api/autonomy/decide", { id: other.id, yes: true });
  assert.equal(made.id, procedure.id, "the same procedure, changed in place");
  assert.equal(made.version, 2);
  assert.deepEqual(made.procedure.steps, withCheck.slice(1).map((s) => ({ confirm: false, ...s })));

  await assert.rejects(suggest({ steps: withCheck }), /why/, "a suggestion says why");
  await assert.rejects(suggest({ steps: made.procedure.steps, why }), /Nothing changed/);
  const chat = { ...context(), source: "chat" };
  await assert.rejects(app.registry.execute("procedures.auto.suggest_change", { procedureId: procedure.id, steps: withCheck, why }, chat),
    /Only the owner's own conversation/, "never from a task a chat message started");
});

test("the flow editor shows the Trunk's suggestion; Keep it as it is answers no, Approve answers yes", async (t) => {
  const { app, server, api, procedure, suggest } = await fixture(t);
  await api("/api/onboarding", { done: true });
  const first = await suggest({ steps: withCheck, why });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async () => {
    await page.locator('.side-nav [data-act="view"][data-v="automations"]').first().click();
    await page.locator('[data-act="ptab"][data-place="automations"][data-v="procedures"]').first().click();
    await page.locator(".pp-pill17d").first().waitFor({ timeout: 30000 });
    await page.locator(`[data-act="flow"][data-id="${procedure.id}"]`).click();
    await page.locator(".dlg .fp17d").waitFor();
  };
  await open();
  const note = page.locator(".dlg .fp17d");
  assert.match(await note.innerText(), /Ledger suggests a change[\s\S]*Last month two receipts were missing/);
  assert.equal(await note.locator(".av").count(), 1, "the Trunk's own face");
  /* Every kind of step is one the engine runs (src/autonomy/step-kinds.ts), so every one can be picked. */
  assert.deepEqual((await gselChoices(page.locator(".dlg #fk-0"))).filter((c) => c.off), []);
  assert.deepEqual((await gselChoices(page.locator(".dlg #fk-0"))).map((c) => c.words), ["When", "Ask a Trunk", "If it says", "Ask me", "Wait", "Repeat", "Split and gather", "Run a flow"]);
  assert.doesNotMatch(await page.locator(".dlg").innerText(), /not step kinds the engine runs yet/);

  await page.locator('.dlg [data-act="ppsee17d"]').click();
  await page.locator('.dlg [data-act="ppdeny17d"]').waitFor();
  assert.match(await page.locator(".dlg").innerText(), /Ledger suggests this\. Nothing changes until you approve it/);
  assert.equal(await page.locator(".dlg .df17d li.add").count(), 1, "the added step is shown as added");
  await page.locator('.dlg [data-act="ppdeny17d"]').click();
  await page.locator(".toast", { hasText: "Kept as it is. Ledger won’t suggest this again." }).waitFor();
  await page.locator(".dlg .fp17d").waitFor({ state: "detached" });
  const denied = (await api("/api/autonomy/ledger?status=all")).entries.find((e) => e.id === first.id);
  assert.equal(denied.status, "dismissed", "the no reached the engine");
  assert.equal(app.autonomy.procedures.get(procedure.id).version ?? 1, 1);
  await page.keyboard.press("Escape");

  const second = await suggest({ steps: withCheck.slice(1), why });
  await open();
  await page.locator('.dlg [data-act="ppsee17d"]').click();
  await page.locator('.dlg [data-act="ppapprove17d"]').click();
  await page.locator(".toast", { hasText: "Version 2 approved." }).waitFor();
  const after = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
  assert.equal(after.version, 2);
  assert.deepEqual(after.procedure.steps.map((s) => s.title), ["Check", "Match"]);
  assert.equal((await api("/api/autonomy/ledger?status=all")).entries.find((e) => e.id === second.id).status, "accepted", "that very question answered yes");

  /* Branch's own assistant is named, never drawn: the mascot is only the logo. */
  const third = await suggest({ steps: withCheck.slice(0, 2), why: "One more check." }, null);
  assert.equal(third.waiting, true);
  await page.keyboard.press("Escape");
  await open();
  assert.equal(await page.locator(".dlg .fp17d .av").count(), 0);
  assert.deepEqual(errors, []);
});
