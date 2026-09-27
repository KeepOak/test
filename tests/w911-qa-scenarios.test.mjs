/**
 * w911 (A1753): plain-language page tests, over HTTP against a real app with a scripted model. The
 * page is a local .html file in the workspace; the suite runner and the html scorer are the real ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, allSuites, SuiteSchema, qaCommand, qaDeps, qaOff, draftNotRunnable } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const goodPage = `<!doctype html><html><body><form id="checkout"><button class="send">Place order</button></form></body></html>`;
const badPage = `<!doctype html><html><body><form id="checkout"><button class="send">Cancel</button></form></body></html>`;
const scenario = { name: "Checkout page", target: "page.html",
  steps: ["Given the checkout page is open", "When I look for the send button", "Then it says Place order"] };
const goodDraft = JSON.stringify({
  prompt: "Look at page.html and say whether the send button says Place order.",
  scorers: [{ kind: "html", selector: "button.send", source: "file", path: "page.html", text: "Place order" }],
});

async function served(t, { mode = "on" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-w911-qa-"));
  const provider = { name: "scripted", draft: goodDraft, drafts: 0, async complete(request) {
    const text = request.messages.map((m) => m.content).join("\n");
    if (text.includes("Turn this plain-language test into one evaluation task")) { provider.drafts++; return { content: provider.draft, toolCalls: [] }; }
    return { content: "I looked at the page.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "page.html"), goodPage);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  // Scenarios ship "when needed" (the ship-on rule), so every position, off included, is set through the owner's route.
  assert.equal((await call("POST", "/api/qa/settings", { mode })).body.settings.mode, mode);
  return { app, provider, call, workspace };
}

test("A1753: a scenario becomes a draft from the model's reply, and a draft is never run", async (t) => {
  const { app, provider, call } = await served(t);
  const drafted = await call("POST", "/api/qa/scenarios", scenario);
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  const { scenario: saved } = drafted.body;
  assert.equal(provider.drafts, 1);
  assert.equal(saved.status, "draft");
  assert.equal(saved.task.scorers[0].path, "page.html");
  assert.deepEqual((await call("GET", "/api/qa/scenarios")).body.scenarios.map((s) => s.id), [saved.id]);
  const refused = await call("POST", `/api/qa/scenarios/${saved.id}/run`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, draftNotRunnable);
  assert.ok(!allSuites(app.store, app.runtime.owner).some((s) => s.id === saved.suiteId), "a draft is not a suite");
  assert.equal(app.evaluationSuites.history().length, 0, "nothing ran");
});

test("A1753: accepting makes a valid suite task; the real runner passes a matching page and fails a changed one", async (t) => {
  const { app, call, workspace } = await served(t);
  const { scenario: saved } = (await call("POST", "/api/qa/scenarios", scenario)).body;
  const accepted = await call("POST", `/api/qa/scenarios/${saved.id}/accept`);
  assert.equal(accepted.body.scenario.status, "accepted");
  const suite = allSuites(app.store, app.runtime.owner).find((s) => s.id === saved.suiteId);
  assert.equal(suite.source, "yours");
  const { source: _source, ...plain } = suite;
  assert.equal(SuiteSchema.safeParse(plain).success, true, "the saved suite is valid by the real schema");
  const passed = await call("POST", `/api/qa/scenarios/${saved.id}/run`);
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  assert.equal(passed.body.result.tasks[0].passed, true, JSON.stringify(passed.body.result.tasks[0]));
  assert.equal(passed.body.result.tasks[0].method, "scorers");
  // The ordinary suite route runs the same suite.
  const direct = await call("POST", "/api/evaluation/run", { suite: saved.suiteId });
  assert.equal(direct.body.tasks[0].passed, true);
  await writeFile(join(workspace, "page.html"), badPage);
  const failed = (await call("POST", `/api/qa/scenarios/${saved.id}/run`)).body.result.tasks[0];
  assert.equal(failed.passed, false);
  assert.match(failed.reasons.join(" "), /should mention "Place order"/);
  // The terminal command reads the same records and runs through the same runner.
  const lines = [];
  const deps = qaDeps(app);
  assert.equal(await qaCommand(deps, ["list"], (l) => lines.push(l)), 0);
  assert.match(lines[0], new RegExp(`${saved.id}\\s+accepted\\s+Checkout page`));
  assert.equal(await qaCommand(deps, ["run", saved.id], (l) => lines.push(l)), 1, "a failing page is a failing exit");
  await writeFile(join(workspace, "page.html"), goodPage);
  assert.equal(await qaCommand(deps, ["run", saved.id], (l) => lines.push(l)), 0);
});

test("A1753: a bad draft or a bad page is refused by name, and nothing is kept", async (t) => {
  const { provider, call } = await served(t);
  const bad = async (draft, pattern, body = scenario) => {
    provider.draft = draft;
    const answer = await call("POST", "/api/qa/scenarios", body);
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.match(answer.body.error, pattern);
  };
  await bad("not json at all", /"Checkout page" was refused: the reply was not a JSON object/);
  await bad(JSON.stringify({ prompt: "x", scorers: [{ kind: "html", source: "file", path: "page.html" }] }),
    /"Checkout page" was refused: it is not a valid evaluation task \(scorers\.0/);
  await bad(JSON.stringify({ prompt: "x", scorers: [{ kind: "file-exists", path: "page.html" }] }), /does not check the page page\.html/);
  await bad(JSON.stringify({ prompt: "x", scorers: [{ kind: "html", selector: "b", source: "file", path: "other.html" }] }), /does not check the page page\.html/);
  await bad(JSON.stringify({ prompt: "x", judge: { rubric: "good" }, scorers: [{ kind: "html", selector: "b", source: "file", path: "page.html" }] }), /only scorers may decide/);
  await bad(goodDraft, /not in the workspace/, { ...scenario, target: "missing.html" });
  await bad(goodDraft, /outside|not allowed|invalid|path/i, { ...scenario, target: "../page.html" });
  await bad(goodDraft, /this computer or a private network|private or local address/, { ...scenario, target: "http://localhost:8080/page" });
  await bad(goodDraft, /Given, When, Then/, { ...scenario, steps: ["click the button"] });
  assert.deepEqual((await call("GET", "/api/qa/scenarios")).body.scenarios, []);
});

test("A1753: rejecting deletes a draft, and an accepted test's suite with it", async (t) => {
  const { app, call } = await served(t);
  const first = (await call("POST", "/api/qa/scenarios", scenario)).body.scenario;
  assert.deepEqual((await call("POST", `/api/qa/scenarios/${first.id}/reject`)).body, { removed: true });
  const second = (await call("POST", "/api/qa/scenarios", scenario)).body.scenario;
  await call("POST", `/api/qa/scenarios/${second.id}/accept`);
  await call("POST", `/api/qa/scenarios/${second.id}/reject`);
  assert.ok(!allSuites(app.store, app.runtime.owner).some((s) => s.id === second.suiteId));
  assert.deepEqual((await call("GET", "/api/qa/scenarios")).body.scenarios, []);
  assert.equal((await call("POST", `/api/qa/scenarios/${second.id}/run`)).status, 400);
});

test("A1753: off refuses every scenario route and the terminal command; the switch itself still answers", async (t) => {
  const { app, provider, call } = await served(t, { mode: "off" });
  assert.equal((await call("GET", "/api/qa/settings")).body.settings.mode, "off");
  const id = "00000000-0000-4000-8000-000000000000";
  for (const [method, path] of [["GET", "/api/qa/scenarios"], ["POST", "/api/qa/scenarios"],
    ["POST", `/api/qa/scenarios/${id}/accept`], ["POST", `/api/qa/scenarios/${id}/reject`], ["POST", `/api/qa/scenarios/${id}/run`]]) {
    const answer = await call(method, path, scenario);
    assert.equal(answer.status, 400, `${method} ${path}`);
    assert.equal(answer.body.error, qaOff, `${method} ${path}`);
  }
  assert.equal(provider.drafts, 0);
  const lines = [];
  assert.equal(await qaCommand(qaDeps(app), ["list"], (l) => lines.push(l)), 1);
  assert.deepEqual(lines, [qaOff]);
});

test("A1753: a short-lived key cannot draft, accept, reject or change the switch, but may run an accepted test", async (t) => {
  const { app, call } = await served(t, { mode: "when-needed" });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const drafted = (await call("POST", "/api/qa/scenarios", scenario)).body.scenario;
  assert.equal((await call("POST", "/api/qa/scenarios", scenario, key)).status, 401);
  const accept = await call("POST", `/api/qa/scenarios/${drafted.id}/accept`, {}, key);
  assert.equal(accept.status, 401);
  assert.match(accept.body.error, /short-lived key/);
  assert.equal((await call("POST", `/api/qa/scenarios/${drafted.id}/reject`, {}, key)).status, 401);
  assert.equal((await call("POST", "/api/qa/settings", { mode: "off" }, key)).status, 401);
  assert.equal((await call("GET", "/api/qa/scenarios", undefined, key)).status, 200, "a key may look");
  await call("POST", `/api/qa/scenarios/${drafted.id}/accept`);
  const ran = await call("POST", `/api/qa/scenarios/${drafted.id}/run`, {}, key);
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.result.tasks[0].passed, true);
});
