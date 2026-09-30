/**
 * SELF-309: the lead publishes owner-facing pages from inside Branch and keeps them live. A page bound to a workspace
 * file (the master plan) is shown from that file every time it is opened, so a change to the file is on the page with
 * no turn of the lead's; a page that holds its own words is updated by id and its revision moves on; nothing outside
 * the workspace can be bound; and the page opens in the window at a stable address, /#page=<id>, and stays current
 * there while it is open. Scripted model, isolated engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const until = async (check, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return true; return false; };

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-lead-pages-"));
  const results = [];
  const provider = { name: "scripted", async complete(request) {
    const asked = (m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>");
    const said = [...request.messages].reverse().find(asked)?.content ?? "";
    const from = request.messages.findLastIndex(asked);
    const done = request.messages.slice(from).filter((m) => m.role === "tool");
    if (done.length) results.push(done.at(-1).content);
    const steps = Object.entries(script).find(([key]) => said.includes(key))?.[1] ?? [];
    return done.length < steps.length ? steps[done.length](results) : { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, api, root, workspace: join(root, "workspace"), results };
}
const resultOf = (text) => { const parsed = JSON.parse(text); return parsed.result ?? parsed; };
const idOf = (text) => resultOf(text).id;

test("the lead publishes the master plan as a live page: every change to the file is on the page with no turn of the lead's", async (t) => {
  const f = await fixture(t, {
    "Publish the master plan": [() => call("pages.publish", { title: "Master plan", sourcePath: "MASTER-PLAN.md" }, "p1")],
    "Publish the nightly report": [
      () => call("pages.publish", { title: "Nightly report", body: "# Night 1\n- 3 PRs merged" }, "r1"),
      (results) => call("pages.publish", { id: idOf(results.at(-1)), title: "Nightly report", body: "# Night 1\n- 4 PRs merged" }, "r2")],
    "Bind a file outside": [() => call("pages.publish", { title: "Secrets", sourcePath: "../secrets.md" }, "x1")],
  });
  const plan = join(f.workspace, "MASTER-PLAN.md");
  await writeFile(plan, "# Master plan\n\n| ID | Status |\n|---|---|\n| SELF-309 | IN PROGRESS |\n");
  const home = f.app.trunks.ensureDefault(true);
  const published = await f.app.runtime.run({ prompt: "Publish the master plan for me", trunkId: home.id, mode: "full" });
  assert.equal(published.status, "completed", published.output);
  assert.equal(f.app.store.events(published.id).filter((e) => /approval|needs_input/.test(e.kind)).length, 0, "no question in Full Access");
  const id = idOf(f.results.at(-1));
  assert.equal(resultOf(f.results.at(-1)).link, `#page=${id}`);
  const first = (await f.api(`asks/pages/${id}`)).body.page;
  assert.equal(first.sourcePath, "MASTER-PLAN.md");
  assert.match(first.body, /\| SELF-309 \| IN PROGRESS \|/);
  const runsBefore = f.app.store.runs(f.app.runtime.owner).length;
  await writeFile(plan, "# Master plan\n\n| ID | Status |\n|---|---|\n| SELF-309 | DONE |\n");
  await utimes(plan, new Date(), new Date(Date.now() + 60_000));
  const second = (await f.api(`asks/pages/${id}`)).body.page;
  assert.match(second.body, /\| SELF-309 \| DONE \|/, "the page shows the file as it is now");
  assert.ok(second.updatedAt > first.updatedAt, "dated by the file's own change");
  assert.equal(second.revision, first.revision, "nobody rewrote the page");
  assert.equal(f.app.store.runs(f.app.runtime.owner).length, runsBefore, "no turn of the lead's was needed");
  assert.match((await f.api(`asks/pages/${id}/export`)).body.html, /SELF-309 \| DONE/, "a handed-on copy is the file as it is now");

  const report = await f.app.runtime.run({ prompt: "Publish the nightly report", trunkId: home.id, mode: "full" });
  assert.equal(report.status, "completed", report.output);
  const kept = resultOf(f.results.at(-1));
  assert.equal(kept.revision, 2, "updated by id, its revision moved on");
  assert.equal((await f.api(`asks/pages/${kept.id}`)).body.page.body, "# Night 1\n- 4 PRs merged");
  const listed = (await f.api("asks/pages")).body.pages.map((p) => [p.title, p.sourcePath]);
  assert.deepEqual(listed.sort(), [["Master plan", "MASTER-PLAN.md"], ["Nightly report", null]]);

  await f.app.runtime.run({ prompt: "Bind a file outside the workspace", trunkId: home.id, mode: "full" });
  assert.match(f.results.at(-1), /outside|denied|not allowed|workspace/i, "nothing outside the workspace is bound");
  assert.equal((await f.api("asks/pages")).body.pages.length, 2);
  await assert.rejects(f.app.registry.execute("pages.publish", { title: "Both", body: "x", sourcePath: "MASTER-PLAN.md" }, f.app.runtime.context()), /either its words/);
});

test("a published page opens in the window at /#page=<id> and stays current while it is open", async (t) => {
  const f = await fixture(t, {});
  const plan = join(f.workspace, "MASTER-PLAN.md");
  await writeFile(plan, "# Master plan\n\nSELF-309 is IN PROGRESS.\n");
  await f.api("onboarding", { done: true });
  await f.api("deployment/suggestion", { id: "updates", answer: "never" });
  const page = (await f.app.registry.execute("pages.publish", { title: "Master plan", sourcePath: "MASTER-PLAN.md" }, f.app.runtime.context()));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const tab = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await signIn(tab, f.server);
  await tab.evaluate((id) => { location.hash = "page=" + id; }, page.id);
  await tab.locator(".page19 h1").waitFor({ timeout: 15000 });
  assert.equal(await tab.locator(".page19 h1").innerText(), "Master plan", "drawn as Markdown");
  assert.match(await tab.locator("[data-page19]").innerText(), /Live from MASTER-PLAN\.md/);
  await writeFile(plan, "# Master plan\n\nSELF-309 is DONE.\n");
  await tab.waitForFunction(() => /SELF-309 is DONE/.test(document.querySelector(".page19")?.textContent ?? ""), null, { timeout: 15000 });

  // Closed while a read is on its way: the answer that comes back afterwards never opens the page again.
  await tab.route(`**/api/asks/pages/${page.id}`, async (route) => { await new Promise((done) => setTimeout(done, 2500)); await route.continue(); });
  await writeFile(plan, "# Master plan\n\nSELF-309 is CLOSED.\n");
  await tab.waitForRequest((request) => request.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.locator('.dlg [data-act="dlg-close"]').last().click();
  await tab.locator("[data-page19]").waitFor({ state: "detached" });
  await tab.waitForResponse((response) => response.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator("[data-page19]").count(), 0, "a closed page stays closed");

  // A newer open while an older one is still being read: the older answer never replaces what is on screen now.
  const other = await f.app.registry.execute("pages.publish", { title: "Nightly report", body: "Night 2" }, f.app.runtime.context());
  await tab.evaluate(() => { location.hash = ""; });
  const slow = tab.waitForResponse((response) => response.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.evaluate((id) => { location.hash = "page=" + id; }, page.id);
  await tab.waitForRequest((request) => request.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.evaluate((id) => { location.hash = "page=" + id; }, other.id);
  await tab.locator(`[data-page19="${other.id}"]`).waitFor({ timeout: 15000 });
  await slow;
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator(`[data-page19="${page.id}"]`).count(), 0, "the older page did not open over the newer one");
  assert.equal(await tab.locator(`[data-page19="${other.id}"]`).count(), 1, "the newer page is still the one shown");

  // Nothing open, then another dialog opened and closed while the page was read: the screen looks the same, but the
  // late answer still does not open the page.
  await tab.locator('.dlg [data-act="dlg-close"]').last().click();
  await tab.locator(".dlg").waitFor({ state: "detached" });
  await tab.evaluate(() => { location.hash = ""; });
  const late = tab.waitForResponse((response) => response.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.evaluate((id) => { location.hash = "page=" + id; }, page.id);
  await tab.waitForRequest((request) => request.url().endsWith(`/api/asks/pages/${page.id}`), { timeout: 15000 });
  await tab.locator('[data-act="whatcan"]').first().click();
  await tab.locator(".dlg").first().waitFor();
  await tab.locator('.dlg [data-act="dlg-close"]').first().click();
  await tab.locator(".dlg").waitFor({ state: "detached" });
  await late;
  await tab.waitForTimeout(500);
  assert.equal(await tab.locator("[data-page19]").count(), 0, "opened and closed meanwhile: the page is not brought back");
  assert.deepEqual(errors, []);
});

test("a live page shows only the file it was bound to: another project's file of the same name is never shown", async (t) => {
  const f = await fixture(t, {});
  const owner = f.app.runtime.owner;
  await writeFile(join(f.workspace, "MASTER-PLAN.md"), "# The workspace's plan\n");
  const page = await f.app.registry.execute("pages.publish", { title: "Master plan", sourcePath: "MASTER-PLAN.md" }, f.app.runtime.context());
  await mkdir(join(f.workspace, "other"), { recursive: true });
  await writeFile(join(f.workspace, "other", "MASTER-PLAN.md"), "# Another project's plan\n");
  f.app.store.projects.save(owner, { id: "other", name: "Other", folder: "other" });
  f.app.store.projects.setActive(owner, { active: "other" });
  const moved = (await f.api(`asks/pages/${page.id}`)).body.page;
  assert.doesNotMatch(moved.body, /Another project/, "the other project's file is not shown");
  assert.match(moved.missing, /another project or worktree/);
  assert.doesNotMatch((await f.api(`asks/pages/${page.id}/export`)).body.html, /Another project/, "nor handed on");
  f.app.store.projects.setActive(owner, { active: "default" });
  assert.match((await f.api(`asks/pages/${page.id}`)).body.page.body, /The workspace's plan/, "back in its own project, it shows again");

  // A switch that lands between the check and the read: the bytes still come from the path that was checked.
  const files = f.app.asks.pages["files"], checked = files.checked.bind(files);
  files.checked = async (...args) => { const where = await checked(...args); f.app.store.projects.setActive(owner, { active: "other" }); return where; };
  const raced = (await f.api(`asks/pages/${page.id}`)).body.page;
  files.checked = checked;
  assert.doesNotMatch(raced.body, /Another project/, "a switch mid-read never shows the other project's file");
  assert.match(raced.body, /The workspace's plan/);
});
