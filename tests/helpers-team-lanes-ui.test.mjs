/**
 * Pass 18b in the window (public/app/places/team-tabs.js, public/app/chat/helpframe.js and chat/pane.js), headless
 * against a scripted model: the team run board's Steer and Stop on a member's lane, and a room member's lane opening its
 * conversation view only.
 *
 * - A member whose run works has Steer and Stop on its lane: Stop stops that member only; Steer reaches that member only.
 *   The board is read again while the turn works, so a stopped member's lane loses its Stop.
 *   A member run is a helper of the team's turn (run.started parentRunId), so the engine's helper guard decides who may
 *   act on it: a household person at the window can neither stop nor steer the owner's team member.
 * - A room member's lane opens its conversation in the room view only: "In <room> · view only", no message box, no
 *   action on its messages, Back to <room> returns to the room, and a reload never leaves it open to send in.
 * - While a turn works, each member's lane is named by its member (the engine pairs a run to its member by specialist).
 *
 * Mutation notes (each turns this file red; each was tried):
 * - team-tabs.js lane: draw no controls (drop `steerable(m) ? helperControls(...) : null`) and there is no Stop to press.
 * - helpframe.js byId: search the frame's helpers only (drop the sources loop) and the lane's Stop does nothing.
 * - helpframe.js viewingHelper: drop `|| member()` and the member's conversation has a message box.
 * - chat.js acts: draw msgActs in view only and the member's messages carry actions that start work.
 * - src/team-task-view.ts: drop namedWhileWorking and a working member is listed twice, as "a member not in the plan".
 * - the household person is refused twice over: drop both src/server.ts /api/runs/:id's `run.owner !== profiles.scope()`
 *   refusal and src/helper-control.ts helperStopRefusal (return null) and she stops the owner's member; either one alone holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newWindow, openPlace } from "./new-window-places.mjs";

const until = async (check, tries = 400) => { for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };
const text = (request) => JSON.stringify(request.messages);
const roleOf = (request) => /Your role in team \\?"[^"\\]+\\?": ([a-z]+)\./.exec(text(request))?.[1] ?? null;

/* Each member reads a note, then works (held until let go or stopped), reads again and answers. */
function crew() {
  const gates = new Map(), requests = {};
  const provider = { name: "scripted", async complete(request) {
    const role = roleOf(request);
    if (!role) return { content: "done", toolCalls: [] };
    (requests[role] ??= []).push(request);
    const round = request.messages.filter((m) => m.role === "tool").length + 1;
    const read = { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name: "files.read", arguments: JSON.stringify({ path: "notes.txt" }) }] };
    if (round === 1) return read;
    if (round === 2) {
      await new Promise((resolve, reject) => {
        gates.set(role, resolve);
        request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return read;
    }
    return { content: `answer from ${role}`, toolCalls: [] };
  } };
  return { provider, gates, requests };
}

test("the team run board: Steer and Stop reach one member each; a household person reaches none", async (t) => {
  const model = crew();
  const { app, page, errors, call, server } = await newWindow(t, { provider: model.provider });
  await writeFile(join(app.runtime.workspace, "notes.txt"), "the plan");
  const owner = app.runtime.owner, members = ["planner", "builder"].map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { version: 1, definition: { name: `Seed ${role}`, instructions: role }, evaluationPassed: false, activeVersion: null, previousActive: null, history: [] });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Crew", purpose: "Plans and builds.", members });
  const running = app.teams.run(app.runtime, { activeSpecialist: () => ({ permissions: ["files.read"], instructions: "" }) }, team.id, "ship it", { requestId: randomUUID() });
  assert.ok(await until(() => model.gates.has("planner") && model.gates.has("builder")), "control: both members work");
  const [task] = (await call(`/api/teams/${team.id}/tasks`)).tasks;
  /* While the turn works, each member's run is named by its specialist (run.started agent) before the record lands. */
  const working = task.members.filter((m) => m.runId && m.task?.state === "working");
  assert.deepEqual(working.map((m) => m.role).sort(), ["builder", "planner"], JSON.stringify(task.members));
  assert.equal(task.members.length, 2, "no member is listed twice while it works");
  const run = (role) => working.find((m) => m.role === role).runId;
  for (const role of ["planner", "builder"]) {
    const started = app.store.events(run(role)).find((e) => e.kind === "run.started");
    assert.equal(typeof started?.data.parentRunId, "string", `the ${role}'s run is a helper of the team's turn`);
  }

  await openPlace(page, "team", "agents");
  const lane = (role) => page.locator(`#main .card18a:has([data-id="${run(role)}"])`);
  await lane("planner").locator('[data-act="hfstop18a"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#main .board18b [data-act="hfstop18a"]').count(), 2, "a Stop on each working member's lane");
  assert.doesNotMatch(await page.locator("#main .board18b").innerText(), /not in the plan/, "each lane names its member");
  await lane("planner").locator('[data-act="hfstop18a"]').click();
  assert.ok(await until(() => app.store.run(run("planner")).status === "cancelled"), "the member asked for is stopped");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.run(run("builder")).status, "running", "the other member carries on");
  await page.waitForFunction((id) => !document.querySelector(`#main [data-act="hfstop18a"][data-id="${id}"]`), run("planner"), { timeout: 15000 });

  const note = "only the September pages";
  await lane("builder").locator('[data-act="hfsteer18a"]').click();
  await page.locator("#steer18").fill(note);
  await page.locator("#steer18").press("Enter");
  await page.waitForFunction(() => !document.querySelector("#steer18"), null, { timeout: 15000 });
  assert.ok(await until(() => app.store.events(run("builder")).some((e) => e.kind === "run.steered")), "the note reached the member's record");
  // A household person at the window can neither stop nor steer the owner's team member.
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  app.store.profiles.switch({ profileId: dana.id, pin: "4826" });
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
  try {
    assert.equal(await post(`/api/runs/${run("builder")}/cancel`, {}), 404);
    assert.equal(await post(`/api/runs/${run("builder")}/steer`, { text: "stop" }), 404);
  } finally { app.store.profiles.switch({ profileId: null }); }
  assert.equal(app.store.run(run("builder")).status, "running", "the member still works");
  assert.equal(app.store.events(run("builder")).filter((e) => e.kind === "run.steered").length, 1, "and was steered once, by the owner");

  model.gates.get("builder")();
  await running.catch(() => undefined);
  assert.match(text(model.requests.builder.at(-1)), new RegExp(note), "the member read the note on its next round");
  assert.ok(model.requests.planner.every((r) => !text(r).includes(note)), "the other member never saw it");
  assert.deepEqual(errors, []);
});

test("a room member's lane opens its conversation in the room view only, with Back to the room", async (t) => {
  const { app, page, call, errors } = await newWindow(t);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await call("/api/trunks/switch", { part: "rooms", mode: "on" });
  const a = (await call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  const b = (await call("/api/trunks", { name: "Pike", title: "Checks" })).trunk;
  const made = await call("/api/trunks/rooms", { name: "Desk", members: [b.id, a.id] });
  const room = made.room ?? made;
  const view = await call(`/api/trunks/rooms/${room.id}`);
  const member = view.memberSessions[b.id];
  // What Pike said in the room, kept in the conversation the room keeps for it.
  app.store.message(member, { role: "user", content: "What changed this week?" });
  app.store.message(member, { role: "assistant", content: "Two invoices came in." });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await page.locator(`#side [data-act="chat"][data-id="${room.sessionId}"]`).first().click();
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  if (!(await page.locator("#pane .lanes18b").count())) await page.locator('[data-act="pane"]').first().click();
  const open = page.locator(`#pane [data-act="lane18b"][data-id="${view.memberSessions[b.id]}"]`);
  await open.waitFor({ timeout: 15000 });
  await open.click();
  await page.locator(".vo18").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#composer, #prompt").count(), 0, "no message box");
  assert.match(await page.locator(".head .vo18h").innerText(), /Pike[\s\S]*In Desk · view only/);
  assert.equal(await page.locator('[data-act="voback18"]').innerText(), "Back to Desk");
  await page.locator("#conversation .b").first().waitFor({ timeout: 15000 });
  assert.match(await page.locator("#conversation").innerText(), /Two invoices came in\./, "its own messages");
  assert.equal(await page.locator("#conversation button, #conversation [data-act]").count(), 0, "and nothing on them starts work");
  // A reload never lands in the member's conversation with a message box.
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await page.waitForTimeout(1500);
  const landed = await page.evaluate((sid) => [!!document.querySelector("#prompt"), document.querySelector("#conversation")?.innerText.includes("Two invoices came in.") ?? false], member);
  assert.ok(!(landed[0] && landed[1]), `after a reload the member's conversation is not open to send in: ${JSON.stringify(landed)}`);
  await page.locator(`#side [data-act="chat"][data-id="${room.sessionId}"]`).first().click();
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  if (!(await page.locator("#pane .lanes18b").count())) await page.locator('[data-act="pane"]').first().click();
  await open.click();
  await page.locator(".vo18").waitFor({ timeout: 15000 });
  await page.locator('[data-act="voback18"]').click();
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  await page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, room.sessionId, { timeout: 15000 });
  assert.equal(await page.locator(".vo18").count(), 0);
  assert.deepEqual(errors, []);
});
