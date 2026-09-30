/* Batch C (setup, first run and invites), against a real engine:
   - setup's "Which models should answer?": each account's switch is the engine's (POST /api/accounts/update disabled),
     a connection whose list was never written down is written down on its first change, and the one account of a list
     switched off really stops that connection answering;
   - the first run's "How should Branch think?" opens the local-model picker or the plan's sign-in, then carries on;
   - Invite someone, "On their own device": the person is added, the engine's one-time code and the sign-in page's
     address are shown once in the dialog and kept nowhere, and the code really signs them in; keepoak.com stays greyed
     with its reason; adding people and making codes stay the owner's, at this computer only;
   - using other devices switched off names the window's place for it. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { updateAccount } from "../dist/accounts/manage.js";
import { allSwitchedOff } from "../dist/accounts/pool-provider.js";
import { offLine } from "../dist/devices/book.js";
import { hereOnly } from "../dist/remote/window-key.js";
import { codeLockdownRefusal } from "../dist/people/api.js";
import { newWindow } from "./new-window-places.mjs";

const POOL = "openai-test";

/** A saved OpenAI-style connection answered by a stand-in, with no list of accounts written down yet. */
function connection(app) {
  const calls = { n: 0 };
  app.store.save("settings", app.runtime.owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const provider = { name: "openai-chat", complete: async () => { calls.n++; return { content: "from the key", toolCalls: [] }; } };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider });
  app.runtime.models.configure(app.runtime.owner, { activePreset: POOL });
  return calls;
}

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-batch-c-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

/** Waits for the engine or the window to say so, never a fixed time. */
async function until(check, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { if (await check()) return; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}

test("the one account of a list switched off stops the connection; switched on, it answers again", async (t) => {
  const { app } = await engine(t);
  const calls = connection(app);
  const service = accountsServiceFor(app.runtime.models);
  assert.equal(service.pool(POOL), null, "nothing is written down yet");
  const view = await updateAccount(service, { pool: POOL, account: "primary", disabled: true });
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].disabled, true);
  assert.equal(service.pool(POOL)?.accounts[0].disabled, true, "the first change writes the list down");
  const refused = await app.runtime.run({ prompt: "hello" });
  assert.notEqual(refused.status, "completed");
  assert.equal(calls.n, 0, "a switched-off account is never asked");
  assert.ok(JSON.stringify(app.store.events(refused.id)).includes(allSwitchedOff.slice(0, 40)), "the task says why");
  await updateAccount(service, { pool: POOL, account: "primary", disabled: false });
  const answered = await app.runtime.run({ prompt: "hello" });
  assert.equal(answered.status, "completed", answered.output);
  assert.equal(calls.n, 1);
});

test("setup's account switch is the engine's, both ways, and a refusal puts it back", async (t) => {
  const { page, call, errors } = await newWindow(t, { seed: (app) => { connection(app); } });
  await call("/api/onboarding", { done: false });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("onboard")));
  await page.locator("#ob-trust").check();
  await page.locator('[data-act="ob-next"]').click();
  const sw = page.locator(`.ob9 input[data-sw="ob-brain"][data-pool="${POOL}"][data-account="primary"]`);
  await sw.waitFor();
  assert.equal(await sw.isChecked(), true, "an account not switched off may answer");
  // MODEL-045: the row names the connection as the window does, never by its id.
  const row = page.locator(".ob9 .prow", { has: page.locator(`input[data-sw="ob-brain"][data-pool="${POOL}"][data-account="primary"]`) });
  assert.match(await row.innerText(), /OpenAI test/);
  assert.doesNotMatch(await row.innerText(), /openai-test/);
  assert.equal(await sw.getAttribute("aria-disabled"), null, "the switch is live");
  await sw.uncheck();
  const disabled = async () => (await call("/api/accounts")).pools.find((p) => p.pool === POOL)?.accounts[0]?.disabled;
  await until(async () => (await disabled()) === true, "the engine has it switched off");
  await until(async () => !(await sw.isChecked()) && !(await sw.isDisabled()), "drawn from the engine's answer");
  await sw.check();
  await until(async () => (await disabled()) === false, "and on again");
  // Several accounts per connection switched off: the engine refuses, and the switch shows what the engine has.
  await call("/api/accounts/settings", { mode: "off" });
  await sw.uncheck();
  await page.locator(".toast", { hasText: "Several accounts per connection is switched off" }).first().waitFor();
  await until(async () => (await sw.isChecked()) === true, "a refused change is put back");
  assert.deepEqual(errors, []);
});

test("setup's model with no accounts says why its switch cannot be used", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/onboarding", { done: false });
  const model = await call("/api/state").then((s) => s.activeModel);
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("onboard")));
  await page.locator("#ob-trust").check();
  await page.locator('[data-act="ob-next"]').click();
  await page.locator(".ob9 h2").filter({ hasText: /./ }).first().waitFor();
  if (!model) { assert.equal(await page.locator('.ob9 [data-sw^="ob-brain"]').count(), 0); return; }
  const sw = page.locator('.ob9 input[data-sw="ob-brain-model"]');
  await sw.waitFor();
  assert.equal(await sw.getAttribute("aria-disabled"), "true");
  assert.match(await sw.getAttribute("data-tip"), /no accounts to switch/);
  assert.deepEqual(errors, []);
});

test("UP-UI-062: Replay the first run opens the one setup journey, which carries on to the models and accounts", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/onboarding", { done: false });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("firstrun")));
  await page.locator("#ob-trust").waitFor();
  assert.equal(await page.locator(".first").count(), 0, "the old eight-step first run is gone");
  assert.equal(await page.locator(".welcome10").count(), 0, "the New to Branch card closes");
  await page.locator("#ob-trust").check();
  await page.locator('[data-act="ob-next"]').click();
  await page.locator('.ob9 [data-act="addacct"]').waitFor();
  assert.equal(await page.locator('.ob9 [data-act="addacct"]').getAttribute("aria-disabled"), null, "adding an account is live");
  assert.deepEqual(errors, []);
});

test("invite on their own device: added, a real one-time code and the sign-in address, shown once and kept nowhere", async (t) => {
  const { page, call, errors, server } = await newWindow(t);
  await call("/api/people/settings", { mode: "on" });
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/profiles") posts.push(r.url()); });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("invite")));
  const dlg = page.locator(".scrim .dlg");
  const keepoak = dlg.locator('[data-act="p-inv-ko"]');
  assert.equal(await keepoak.getAttribute("aria-disabled"), "true", "keepoak.com stays greyed");
  assert.match(await keepoak.getAttribute("data-tip"), /keepoak\.com account/);
  await dlg.locator('[data-act="p-inv-tab"][data-v="device"]').click();
  await dlg.locator('[data-act="p-inv-tab"][data-v="device"][aria-selected="true"]').waitFor();
  // A PIN is emptied from its box as it is read, even when the form is not right yet.
  await dlg.locator("#inv-pin").fill("2468");
  await dlg.locator('[data-act="p-inv-go"]').click();
  assert.equal(await dlg.locator("#inv-pin").inputValue(), "");
  assert.equal(await dlg.locator("#inv-n").getAttribute("aria-invalid"), "true");
  await dlg.locator("#inv-n").fill("<b>Robin</b>");
  await dlg.locator("#inv-pin").fill("2468");
  if (await dlg.locator("#inv-own").count()) await dlg.locator("#inv-own").fill("97531");
  // One invite at a time: pressed again (with the PIN typed again) while the first is still being answered, nothing is sent.
  let release;
  const held = new Promise((done) => { release = done; });
  await page.route("**/api/profiles", async (route) => { if (route.request().method() === "POST") await held; await route.continue(); });
  await dlg.locator('[data-act="p-inv-go"]').click();
  await until(() => posts.length === 1, "the first invite is sent");
  await dlg.locator("#inv-pin").fill("2468");
  await dlg.locator('[data-act="p-inv-go"]').click();
  release();
  const code = dlg.locator("#inv-code");
  await code.waitFor();
  await page.unroute("**/api/profiles");
  assert.equal(posts.length, 1, "one invite, however often it is pressed");
  assert.equal(await dlg.locator("b b, .dlg-b > p > b > *").count(), 0, "the name is shown as text");
  const text = await dlg.innerText();
  assert.ok(text.includes(`${server.url.replace(/\/$/, "")}/people`), "this Branch's own sign-in page");
  assert.match(text, /Right now Branch here only answers on this computer itself/, "and that it answers here only");
  assert.match(text, /Works once, for 1[45] minutes\./);
  const shown = (await code.innerText()).trim();
  assert.match(shown, /^[A-Z0-9]{8}$/);
  const profiles = await call("/api/profiles");
  assert.ok(profiles.profiles.some((p) => p.name === "<b>Robin</b>"), "the person is added");
  // Kept nowhere: another tab, or the dialog opened again, never shows it.
  await dlg.locator('[data-act="p-inv-tab"][data-v="device"]').click();
  await until(async () => await dlg.locator("#inv-code").count() === 0, "another tab takes the code away");
  await page.locator('.scrim [data-act="dlg-close"]').first().click();
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("invite")));
  await dlg.locator("#inv-n").waitFor();
  assert.ok(!(await page.content()).includes(shown), "the code is nowhere in the window");
  // The code is the engine's: it signs Robin in from another device, once.
  const redeem = (c) => fetch(new URL("/api/people/sign-in/code", server.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "<b>Robin</b>", code: c, device: "Robin's phone" }) });
  const first = await redeem(shown);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).setupOnly, true);
  assert.notEqual((await redeem(shown)).status, 200, "it works once");
  assert.deepEqual(errors, []);
});

test("invite on their own device says when people may not sign in from their own device", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/people/settings", { mode: "off" });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("invite")));
  const dlg = page.locator(".scrim .dlg");
  await dlg.locator('[data-act="p-inv-tab"][data-v="device"]').click();
  await dlg.getByText("“Let people sign in from their own device” must be on.").waitFor();
  assert.equal(await dlg.locator('[data-act="p-inv-go"]').innerText(), "Invite");
  assert.deepEqual(errors, []);
});

test("the sign-in page's address is only ever http(s): the phone door's when open, else this window's", async (t) => {
  const { page } = await newWindow(t);
  const got = await page.evaluate(() => import("/app/flows/people.js").then(({ signInPage: s }) => [
    s({ enabled: true, url: "https://pc.tail1.ts.net" }, "http://127.0.0.1:1"),
    s({ enabled: false, url: "https://pc.tail1.ts.net" }, "http://127.0.0.1:1"),
    s({ enabled: true, url: "javascript:alert(1)//" }, "http://127.0.0.1:1"),
    s(null, "file:///c:/x"),
    s(null, "not an address"),
  ]));
  assert.deepEqual(got, ["https://pc.tail1.ts.net/people", "http://127.0.0.1:1/people", null, null, null]);
});

test("adding somebody and making their code are the owner's, at this computer only", async (t) => {
  const { app, root } = await engine(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body, key = server.token, headers = {}) => {
    const response = await fetch(server.url + "/api/" + path, { method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const made = await post("profiles", { name: "Kim", pin: "1357", role: "adult" });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const door = { "x-branch-tunnel": "1" };
  const byDoor = await post("profiles", { name: "Lee", pin: "1357", role: "adult" }, server.token, door);
  assert.equal(byDoor.status, 403);
  assert.equal(byDoor.data.error, hereOnly);
  const codeByDoor = await post(`people/${made.data.id}/reset-code`, {}, server.token, door);
  assert.equal(codeByDoor.status, 403);
  assert.equal(codeByDoor.data.error, hereOnly);
  const short = (await post("tokens", { scope: "run", minutes: 5 })).data.token;
  assert.ok((await post(`people/${made.data.id}/reset-code`, {}, short)).status >= 400, "a short-lived key is refused");
  assert.ok((await post("profiles", { name: "Lee", pin: "1357", role: "adult" }, short)).status >= 400);
  app.store.profiles.switch({ profileId: made.data.id, pin: "1357" });
  assert.ok((await post(`people/${made.data.id}/reset-code`, {}, server.token)).status >= 400, "a household person is refused");
  assert.ok((await post("profiles", { name: "Lee", pin: "1357", role: "adult" })).status >= 400);
  app.store.profiles.switch({ profileId: null });
  const code = await post(`people/${made.data.id}/reset-code`, {});
  assert.equal(code.status, 200);
  const record = JSON.stringify(app.store.audit.list(app.runtime.owner));
  assert.match(record, /a one-time sign-in code/, "making it is written down");
  assert.ok(!record.includes(code.data.code), "the code itself never is");
});

test("using other devices switched off names the window's place for it", async (t) => {
  const { app, root } = await engine(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = (path, body) => fetch(server.url + "/api/" + path, { method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
  await post("devices/mode", { mode: "off" });
  const refused = await post("devices/invite", {});
  assert.ok(refused.status >= 400);
  assert.equal(refused.data.error, offLine);
  assert.match(offLine, /Settings, Computer & browser, Add a computer/);
  assert.doesNotMatch(offLine, /Customize, Channels, Devices/);
});

test("under Lockdown no invite code is made, and turning Lockdown on voids every code not used yet", async (t) => {
  const { app, root } = await engine(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body, key = server.token) => {
    const response = await fetch(server.url + "/api/" + path, { method: "POST",
      headers: { ...(key ? { authorization: "Bearer " + key } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await post("people/settings", { mode: "on" })).status, 200);
  const kim = (await post("profiles", { name: "Kim", pin: "1357", role: "adult" })).data;
  const before = await post(`people/${kim.id}/reset-code`, {});
  assert.equal(before.status, 200);
  assert.equal((await post("lockdown", { on: true })).status, 200);
  const locked = await post(`people/${kim.id}/reset-code`, {});
  assert.equal(locked.status, 409);
  assert.equal(locked.data.error, codeLockdownRefusal);
  assert.equal((await post("lockdown", { on: false })).status, 200);
  const redeem = await post("people/sign-in/code", { name: "Kim", code: before.data.code, device: "Kim's phone" }, null);
  assert.notEqual(redeem.status, 200, "a code made before Lockdown no longer works after it");
  const after = await post(`people/${kim.id}/reset-code`, {});
  assert.equal(after.status, 200, "with Lockdown off codes are made again");
  assert.equal((await post("people/sign-in/code", { name: "Kim", code: after.data.code, device: "Kim's phone" }, null)).status, 200);
});
