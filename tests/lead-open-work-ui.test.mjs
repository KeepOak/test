/**
 * The lead's workbench in the window (public/app/chat/helpframe.js, GET /api/open-work): the helpers frame shows what the
 * conversation still has going, not only the newest task's helpers. A helper an earlier turn started, a wake-up and a
 * program left running all show while a later turn is the newest; Cancel ends the wake-up, Stop ends the program and
 * the helper, each through the engine. Headless, against a scripted model; no provider.
 *
 * Mutation notes (each turns this file red):
 * - helpframe.js helpersHere: drop the loop over `helperRuns` and the earlier turn's helper is not shown.
 * - helpframe.js helpFrame: return "" when no helper works and the wake-up and program never show.
 * - orchestration-api.ts openWorkApi: drop the ownsSession check and another conversation's id is answered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { signIn } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveBackgroundSettings } from "../dist/processes.js";

const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check, tries = 400) => { for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };

test("the frame shows an earlier turn's helper, a wake-up and a program, and Cancel and Stop end them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-open-work-ui-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plan = [
    call("schedules.wake_later", { message: "Check the build on #687.", inMinutes: 30 }),
    call("process.start", { program: "node", args: ["-e", "setInterval(() => {}, 1000)"], name: "the watcher" }),
    call("helpers.start", { brief: "Read the CI logs of #697.", minutes: 5 }),
  ];
  const provider = { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    if (/You are a helper working in the background/.test(system)) {
      await new Promise((resolve, reject) => { gate.then(resolve); request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); });
      return { content: "Logs read.", toolCalls: [] };
    }
    // Branch's own notes (the open work, sent in place each round) are not what the owner asked.
    const asked = (m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>") && !/Work still open/.test(m.content);
    const said = [...request.messages].reverse().find(asked)?.content ?? "";
    const from = request.messages.findLastIndex(asked);
    const done = request.messages.slice(from).filter((m) => m.role === "tool").length;
    if (/Watch the build/.test(said) && done < plan.length) return plan[done];
    return { content: "All set.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await saveBackgroundSettings(app.store, app.runtime.owner, { programs: { node: { path: process.execPath } } });
  const api = async (path, body, method) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await api("onboarding", { done: true });
  await api("deployment/suggestion", { id: "updates", answer: "never" });

  const first = await app.runtime.run({ prompt: "Watch the build and read the logs", mode: "full" });
  assert.equal(first.status, "completed", first.output);
  const helper = app.store.events(first.id).find((e) => e.kind === "delegation.background_started").data.childRunId;
  const later = await app.runtime.run({ prompt: "Anything else?", sessionId: first.sessionId });
  assert.equal(later.status, "completed", later.output);
  const open = (await api(`open-work?session=${first.sessionId}`)).body;
  assert.deepEqual(open.helperRuns, [first.id]);
  assert.equal(open.wakeups.length, 1);
  assert.equal(open.programs.length, 1);
  const other = await app.runtime.run({ prompt: "unrelated" });
  assert.deepEqual((await api(`open-work?session=${other.sessionId}`)).body, { helperRuns: [], wakeups: [], programs: [] });
  assert.equal((await api("open-work?session=not-a-conversation")).status, 404);

  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await page.evaluate((id) => { location.hash = "open=" + id; }, first.sessionId);
  await page.locator(".dock > .hf18a").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /1 helper/.test(document.querySelector(".hfh18a")?.textContent ?? ""), null, { timeout: 15000 });
  const header = await page.locator(".hfh18a").innerText();
  assert.match(header, /1 helper/, "the earlier turn's helper is shown");
  assert.match(header, /1 wake-up/);
  assert.match(header, /1 program running/);
  await page.locator(".hfh18a").click();
  await page.locator('.hf18a [data-act="owcancel19"]:visible').first().waitFor({ timeout: 10000 });
  assert.match(await page.locator(".hf18a").innerText(), /Check the build on #687\./);

  await page.locator('.hf18a [data-act="owcancel19"]:visible').first().click();
  assert.ok(await until(async () => (await api(`open-work?session=${first.sessionId}`)).body.wakeups.length === 0), "Cancel ends the wake-up");
  await page.locator('.hf18a [data-act="owstop19"]:visible').first().click();
  assert.ok(await until(() => app.processes.list({ sessionId: first.sessionId, active: true }).length === 0), "Stop ends the program");
  await page.locator('.hf18a [data-act="hfstop18a"]:visible').first().click();
  assert.ok(await until(() => app.store.run(helper).status !== "running"), "Stop ends the earlier turn's helper");
  await page.waitForFunction(() => !document.querySelector(".dock > .hf18a"), null, { timeout: 15000 });
  assert.deepEqual(errors, []);
});
