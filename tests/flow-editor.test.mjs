/**
 * Wave 8: changing a flow from the page rather than only looking at one. A step is added, the
 * picture redraws, and Save reaches the same saved shape the API already had; the timeline under
 * the picture says where each step has got to; and the rhythm picker says in plain words what it
 * would do before anything uses it.
 */
import test from "node:test";
import { openPlace } from "./places.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-flow-editor-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000 }); // a busy Windows build machine once took over 30 s (tests/places.mjs waits 120 s too)
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "procedures");
  await page.locator("#flow-editor").waitFor({ state: "visible" });
  return { app, page, server, errors };
}

test.skip("F1 a step is added, the picture redraws, and the flow saves through the same shape", async (t) => {
  // Redesign: Coming soon (flow-add, flow-save), checked at fc541c24. The flow editor is Automations › Procedures › a row (data-act="flow"); its "Add a step" and "Save" are drawn aria-disabled, class soon.
  const { app, page, errors } = await fixture(t);
  await page.locator("#editor-name").fill("Morning tidy-up");
  await page.locator("#editor-description").fill("What to do first thing");
  await page.locator("#editor-kind").selectOption("prompt");
  await page.getByRole("button", { name: "Add a step", exact: true }).click();
  await page.locator("#editor-steps .editor-step").first().waitFor();

  /* A prompt step needs a prompt; the form shows that box and nothing that kind does not need. */
  await page.locator("#editor-0-prompt").fill("Read yesterday's notes");
  assert.equal(await page.locator("#editor-0-contains").count(), 0, "a prompt step was offered a branch's box");
  /* The picture is drawn from the steps being edited, before anything is saved. */
  assert.equal(await page.locator("#editor-picture svg").count(), 1, "the picture never redrew");

  await page.getByRole("button", { name: "Save this flow", exact: true }).click();
  await page.waitForFunction(() => /Saved\./.test(document.getElementById("editor-status")?.textContent ?? ""));

  const saved = app.flows.list();
  assert.equal(saved.length, 1, "the flow never reached the app");
  assert.equal(saved[0].name, "Morning tidy-up");
  assert.deepEqual(saved[0].steps.map((step) => step.kind), ["prompt"]);
  assert.equal(saved[0].steps[0].prompt, "Read yesterday's notes");
  assert.deepEqual(errors, []);
});

test.skip("F1 a second step is added, moved and taken out again", async (t) => {
  // Redesign: Coming soon (flow-add, flow-mv, flow-rm, flow-save), checked at fc541c24.
  const { app, page, errors } = await fixture(t);
  await page.locator("#editor-name").fill("Two steps");
  for (const [kind, box, value] of [["prompt", "prompt", "First"], ["approval", "question", "May I?"]]) {
    await page.locator("#editor-kind").selectOption(kind);
    await page.getByRole("button", { name: "Add a step", exact: true }).click();
    const at = (await page.locator("#editor-steps .editor-step").count()) - 1;
    await page.locator(`#editor-${at}-${box}`).fill(value);
  }
  assert.equal(await page.locator("#editor-steps .editor-step").count(), 2);

  await page.locator("#editor-steps .editor-step").last().getByRole("button", { name: "Move up", exact: true }).click();
  await page.getByRole("button", { name: "Save this flow", exact: true }).click();
  await page.waitForFunction(() => /Saved\./.test(document.getElementById("editor-status")?.textContent ?? ""));
  assert.deepEqual(app.flows.list()[0].steps.map((step) => step.kind), ["approval", "prompt"],
    "moving a step earlier did not change the order that was saved");

  await page.locator("#editor-steps .editor-step").first().getByRole("button", { name: "Take it out", exact: true }).click();
  assert.equal(await page.locator("#editor-steps .editor-step").count(), 1);
  /* ci-flakes-4: this save was never waited for. The step count was already 1 before the press, so the
     wait below it was always true at once and the flow was read back before the save had landed — on a
     busy Windows runner that read the two steps that were still there ('approval', 'prompt'). The
     status line is emptied first so that waiting for "Saved." waits for THIS save, not the one above. */
  await page.evaluate(() => { document.getElementById("editor-status").textContent = ""; });
  await page.getByRole("button", { name: "Save this flow", exact: true }).click();
  await page.waitForFunction(() => /Saved\./.test(document.getElementById("editor-status")?.textContent ?? ""));
  assert.equal(await page.locator("#editor-steps .editor-step").count(), 1);
  assert.deepEqual(app.flows.list()[0].steps.map((step) => step.kind), ["prompt"]);
  assert.deepEqual(errors, []);
});

test.skip("F2 the timeline under the picture says where each step has got to", async (t) => {
  // Redesign: Coming soon (flow-run), checked at fc541c24. The procedure dialog's Run is greyed and has no timeline yet.
  const { app, page, errors } = await fixture(t);
  /* A flow saved by the app itself, so the editor is opening something that already exists. */
  app.flows.save({ name: "Two things", description: "",
    steps: [{ name: "Ask", kind: "prompt", prompt: "say hello", retries: 0, timeoutMs: 120000 },
      { name: "Ask again", kind: "prompt", prompt: "say goodbye", retries: 0, timeoutMs: 120000 }] });
  /* The page keeps its key for this browser session, so a reload comes back connected. */
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "procedures");
  await page.locator("#editor-flow").selectOption({ label: "Two things" });
  await page.locator("#editor-timeline .card-row").first().waitFor();
  const before = await page.locator("#editor-timeline .card-row").allInnerTexts();
  assert.equal(before.length, 2, "the timeline does not have a row per step");
  assert.match(before[0], /Ask/);
  assert.match(before[0], /waiting|not started yet/i, "a step that has not run says it has");

  await page.getByRole("button", { name: "Run this flow", exact: true }).click();
  /* ci-flakes-4: this ran the flow and gave the timeline 20 s to catch up. On a Windows build machine
     that was crawling (this one test took 103 s in run 35484288929) the run itself had not finished by
     then. It now gets the 120 s tests/places.mjs gives the window; what it proves is unchanged. */
  await page.waitForFunction(() =>
    /done|completed|failed/i.test(document.querySelector("#editor-timeline .card-row")?.textContent ?? ""),
    undefined, { timeout: 120000 });
  const after = await page.locator("#editor-timeline .card-row").first().innerText();
  assert.match(after, /done|completed/i, "the timeline never caught up with the run");
  assert.deepEqual(errors, []);
});

test.skip("F3 the rhythm picker says in plain words what it would do", async (t) => {
  // Redesign: Coming soon (nl-add), checked at fc541c24. A rhythm is given in words in Automations › Scheduled ("Describe it", prototype.html), whose Add is greyed; the old rhythm picker is replaced by that box.
  const { page, errors } = await fixture(t);
  const said = async (rhythm, time) => {
    await page.locator("#repeat-every").selectOption(rhythm);
    await page.locator("#repeat-at").fill(time);
    await page.locator("#repeat-at").dispatchEvent("input");
    return page.locator("#repeat-preview").innerText();
  };
  assert.match(await said("weekday", "09:00"), /every weekday at 09:00/);
  assert.match(await said("daily", "18:30"), /every day at 18:30/);
  assert.match(await said("6h", "09:00"), /every six hours/);

  /* And the same rhythm as the schedules understand it: a clock time, or a gap, never both. */
  const shapes = await page.evaluate(async () => {
    const { rhythmAsSchedule } = await import("/flow-editor.js");
    return { weekday: rhythmAsSchedule("weekday", "09:00"), hourly: rhythmAsSchedule("hourly", "09:00") };
  });
  assert.equal(shapes.weekday.dailyAt, "09:00");
  assert.ok(shapes.weekday.timezone, "a daily time was given with no timezone, which the app refuses");
  assert.equal(shapes.weekday.intervalMs, undefined, "a daily time came with a gap as well");
  assert.equal(shapes.hourly.intervalMs, 3_600_000);
  assert.equal(shapes.hourly.dailyAt, undefined);
  assert.deepEqual(errors, []);
});
