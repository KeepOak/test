/**
 * The flow editor (public/app/flows/flow-editor.js) with every step kind the engine runs: a person adds a Repeat, an
 * "If it says" with its two ways and a Wait, approves the new version, and is then shown the engine's own separate
 * question about what it would repeat by itself, which they answer Yes. Checked through the engine's routes.
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

test("a person builds Repeat, If it says and Wait steps, approves them, and says yes to what it would repeat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-step-kinds-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error}`);
    return data;
  };
  await api("/api/onboarding", { done: true });
  await api("/api/autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
  const { procedure } = await api("/api/autonomy/procedures", { name: "Price check", level: "ask-to-start", start: { kind: "manual" },
    steps: [{ title: "Read", prompt: "Read the supplier pages." }] });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('.side-nav [data-act="view"][data-v="automations"]').first().click();
  await page.locator('[data-act="ptab"][data-place="automations"][data-v="procedures"]').first().click();
  await page.locator(`[data-act="flow"][data-id="${procedure.id}"]`).click();
  const dlg = page.locator(".dlg");
  await dlg.locator("#fk-0").waitFor();
  assert.deepEqual((await gselChoices(dlg.locator("#fk-0"))).filter((c) => c.off), [], "every kind can be picked");

  const add = async (kind, text) => {
    const j = await dlg.locator("[id^='fk-']").count();
    await dlg.locator('[data-act="flow-add"]').click();
    await pickGsel(dlg.locator(`#fk-${j}`), kind);
    await dlg.locator(`#ft-${j}`).fill(text);
    return j;
  };
  // A new step's deferred focus that lands late (a busy computer) never pulls typing out of the field the person moved to.
  await page.evaluate(() => {
    const real = window.setTimeout, held = [];
    window.setTimeout = (fn, ms, ...args) => (ms === 0 ? held.push(() => fn(...args)) : real(fn, ms, ...args));
    window.releaseHeld = () => { window.setTimeout = real; for (const run of held.splice(0)) run(); };
  });
  await dlg.locator('[data-act="flow-add"]').click();
  await dlg.locator("#ft-0").click();
  await page.evaluate(() => window.releaseHeld());
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ft-0", "the late focus left the person's field alone");
  await dlg.locator('[data-act="flow-rm"][data-j="1"]').click();
  await page.waitForFunction(() => !document.getElementById("fk-1"));
  await add("loop", "Check the prices again.");
  const cond = await add("if", "cheaper");
  await dlg.locator(`#fy-${cond}`).fill("Draft an order.");
  await dlg.locator(`#fn-${cond}`).fill("Just report the prices.");
  await add("wait", "30 minutes");
  assert.match(await dlg.locator("#flow-pic").innerHTML(), /Repeat \(up to 5\): Check the prices again\.[\s\S]*If it says “cheaper”[\s\S]*Yes: Draft an order\.[\s\S]*No: Just report the prices\.[\s\S]*Wait: 30 minutes/,
    "the picture draws each kind in the prototype's words");
  await dlg.locator('[data-act="flow-save"]').click();
  await dlg.locator('[data-act="ppapprove17d"]').click();

  // The engine asks its own question about what the procedure would repeat, and the procedure opens on it.
  const note = page.locator(".dlg .un-flow");
  await note.waitFor({ timeout: 15000 });
  const words = await note.innerText();
  assert.match(words, /Let "Price check" repeat and run steps without asking each time\?/);
  assert.match(words, /Step 2, Check the prices again\.: asks a Trunk the same request up to 5 times: Check the prices again\./);
  assert.match(words, /In all, one run makes at most 7 requests to a Trunk/);
  const kept = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
  assert.equal(kept.version, 2);
  assert.deepEqual(kept.procedure.steps.map((s) => s.kind ?? "do"), ["do", "loop", "if", "wait"]);
  assert.deepEqual([kept.procedure.steps[1].times, kept.procedure.steps[2].contains, kept.procedure.steps[2].yes, kept.procedure.steps[2].no, kept.procedure.steps[3].minutes],
    [5, "cheaper", "Draft an order.", "Just report the prices.", 30]);
  assert.equal(kept.unattended, undefined, "the yes to the version is not the yes to what it repeats");
  assert.match((await api(`/api/autonomy/procedures/${procedure.id}/run`, {})).reason, /waits for your yes to what it would repeat/);

  await note.locator('[data-act="flow-unatt"][data-v="yes"]').click();
  await note.waitFor({ state: "detached" });
  const allowed = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
  assert.ok(allowed.unattended?.fingerprint, "the yes reached the engine");
  assert.match((await api(`/api/autonomy/procedures/${procedure.id}/run`, {})).reason, /asked you first/, "now it only asks to start, as its level says");

  // Names are not unique: saving a different step must preserve the exact sub-flow the owner chose.
  const make = async (steps) => (await api("/api/autonomy/procedures", { name: "Duplicate", level: "auto", start: { kind: "manual" }, steps })).procedure;
  const second = await make([{ title: "Second", prompt: "Second target." }]);
  const first = await make([{ title: "First", prompt: "First target." }]);
  const outer = await make([{ title: "Start", prompt: "Begin." }, { kind: "sub", title: "Chosen", flowId: second.id }]);
  const change = async (prompt) => {
    const q = await api(`/api/autonomy/procedures/${outer.id}/propose`, { steps: [{ title: "Start", prompt }, { kind: "sub", title: "Chosen", flowId: second.id }] });
    await api("/api/autonomy/decide", { id: q.id, yes: true });
  };
  await change("Begin again.");
  const latest = (await api("/api/autonomy/ledger")).entries.find((e) => e.kind === "unattended" && e.payload.procedureId === outer.id);
  await page.reload();
  await page.locator('.side-nav [data-act="view"][data-v="automations"]').first().click();
  await page.locator('[data-act="ptab"][data-place="automations"][data-v="procedures"]').first().click();
  await page.locator(`[data-act="flow"][data-id="${outer.id}"]`).click();
  assert.equal(await page.locator('.dlg [data-act="flow-unatt"][data-v="yes"]').getAttribute("data-id"), latest.id,
    "the newest question appears despite the older pending one");
  await page.locator(".dlg #ft-0").fill("Begin with care.");
  await page.locator('.dlg [data-act="flow-save"]').click();
  await page.locator('.dlg [data-act="ppapprove17d"]').click();
  await page.locator(".dlg .un-flow").waitFor();
  const saved = (await api("/api/autonomy/procedures")).procedures.find((p) => p.id === outer.id);
  assert.equal(saved.procedure.steps[1].flowId, second.id);
  assert.notEqual(saved.procedure.steps[1].flowId, first.id);
  assert.deepEqual(errors, []);
});
