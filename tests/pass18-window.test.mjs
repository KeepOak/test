/* Pass 18 in the window (design/redesign/pass18/PASS18.md): friendly empty states, live lines under faces, "Who's in the
   room" lanes and the team run board, each read back from the engine. Headless; a scripted model.
   design/redesign/tools/mutate-pass18.mjs turns each test red by breaking the part it checks. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { newWindow } from "./new-window-places.mjs";
import { TeamTasks } from "../dist/team-tasks.js";
import { TeamHandoffs } from "../dist/team-handoff.js";

const place = async (page, v) => { await page.locator(`[data-act="view"][data-v="${v}"]`).first().click(); await page.waitForTimeout(500); };
const tab = async (page, v) => { await page.locator(`#main [data-act="ptab"][data-v="${v}"]`).first().click(); await page.waitForTimeout(800); };
const said = (loc) => loc.first().textContent({ timeout: 4000 }).catch(() => "");

test("an empty list is a welcome once the engine answered with nothing; Make a team stays greyed", async (t) => {
  const { page, call, errors } = await newWindow(t);
  assert.equal((await call("/api/teams")).teams.length, 0);
  await place(page, "team");
  await tab(page, "live");
  assert.match(await said(page.locator("#main .empty18c p")), /^Nobody is working right now\./);
  await tab(page, "agents");
  assert.match(await said(page.locator("#main .empty18c p")), /^No teams yet\./);
  assert.equal(await page.locator('#main [data-act="mkteam18c"]').getAttribute("aria-disabled"), "true", "POST /api/teams needs specialists");
  await place(page, "inbox");
  await tab(page, "finished");
  assert.match(await said(page.locator("#main .empty18c p")), /^Nothing has finished yet\./);
  assert.deepEqual(errors, []);
});

test("each Trunk's live line is the engine's: Idle, Paused", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const a = (await call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  const b = (await call("/api/trunks", { name: "Pike", title: "Checks" })).trunk;
  await call(`/api/trunks/${b.id}/pause`, {});
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await place(page, "customize");
  await tab(page, "trunks");
  assert.equal(await said(page.locator(`#main .prow[data-trunk="${a.id}"] .live18`)), "Idle");
  assert.equal(await said(page.locator(`#main .prow[data-trunk="${b.id}"] .live18`)), "Paused");
  assert.deepEqual(errors, []);
});

test("a room's Activity opens with one lane per member, in seat order, each opening the room's conversation for it", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await call("/api/trunks/switch", { part: "rooms", mode: "on" });
  const a = (await call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  const b = (await call("/api/trunks", { name: "Pike", title: "Checks" })).trunk;
  const made = await call("/api/trunks/rooms", { name: "Desk", members: [b.id, a.id] });
  const room = made.room ?? made;
  const view = await call(`/api/trunks/rooms/${room.id}`);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await page.locator(`#side [data-act="chat"][data-id="${room.sessionId}"]`).first().click();
  await page.waitForTimeout(1200);
  if (!(await page.locator("#pane .lanes18b").count())) await page.locator('[data-act="pane"]').first().click();
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.locator("#pane .lanes18b .lane18b b").allTextContents(), ["Pike", "Wren"]);
  assert.deepEqual(await page.locator('#pane [data-act="lane18b"]').evaluateAll((els) => els.map((el) => el.dataset.id)), [view.memberSessions[b.id], view.memberSessions[a.id]]);
  assert.deepEqual(errors, []);
});

/* A team whose task ran (three members, one batch) and one with a handoff offered to a member. */
async function seedTeams(app) {
  const owner = app.runtime.owner;
  const specialists = (roles) => roles.map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { version: 1, definition: { name: `Seed ${role}`, instructions: role }, evaluationPassed: false, activeVersion: null, previousActive: null, history: [] });
    return { specialistId, role, brief: "" };
  });
  const crew = app.teams.save({ name: "Crew", purpose: "Plans and builds.", members: specialists(["planner", "builder", "reviewer"]) });
  await app.teams.run(app.runtime, { activeSpecialist: () => ({ permissions: [], instructions: "" }) }, crew.id, "ship it", { requestId: randomUUID() });
  const deskMembers = specialists(["writer", "checker"]);
  const desk = app.teams.save({ name: "Desk", purpose: "Writes.", members: deskMembers });
  const scope = { owner, source: "window" }, tasks = new TeamTasks(app.store);
  const claim = tasks.claim(scope, tasks.observe(scope, desk.id, randomUUID(), "desk").taskId);
  new TeamHandoffs(app.store).offer(claim, `member:${deskMembers[1].specialistId}`, "needs checking");
}
const roleOf = (request) => /Your role in team \\?"[^"\\]+\\?": ([a-z]+)\./.exec(JSON.stringify(request.messages))?.[1] ?? null;
const crewModel = { name: "scripted", async complete(request) { return { content: roleOf(request) ? `answer from ${roleOf(request)}` : "done", toolCalls: [] }; } };

test("the team run board: a card per team, a lane per member of its newest task, a handoff's Accept and Reject held", async (t) => {
  const { page, call, errors } = await newWindow(t, { provider: crewModel, seed: seedTeams });
  const teams = (await call("/api/teams")).teams;
  await place(page, "team");
  await tab(page, "agents");
  assert.deepEqual(await page.locator("#main .team18b .th18 b").allTextContents(), teams.map((x) => x.name));
  const crew = teams.find((x) => x.name === "Crew"), desk = teams.find((x) => x.name === "Desk");
  const [task] = (await call(`/api/teams/${crew.id}/tasks`)).tasks;
  const head = page.locator(`#main [data-act="tboard18b"][data-id="${crew.id}"]`);
  if ((await head.getAttribute("aria-expanded")) !== "true") { await head.click(); await page.waitForTimeout(400); }
  assert.equal(await page.locator(`#main .team18b:has([data-id="${crew.id}"]) .card18a`).count(), task.members.length);
  assert.equal(await said(page.locator(`#main .team18b:has([data-id="${crew.id}"]) .round18b small`)), `Round ${task.members[0].batch}`);
  await head.click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(`#main .team18b:has([data-id="${crew.id}"]) .board18b`).count(), 0, "the header folds the board");
  for (const act of ["hoaccept18b", "horeject18b"]) {
    const btn = page.locator(`#main .team18b:has([data-id="${desk.id}"]) [data-act="${act}"]`);
    assert.equal(await btn.getAttribute("data-held"), "security");
    assert.equal(await btn.isDisabled(), true, `${act} is held for the security review`);
  }
  assert.deepEqual(errors, []);
});
