import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

/* TRUNK-190: the Later tab gives each kind of handed-over work its own action, and the window sends that action. */
test("Later shows I've signed it and Finish now for their kinds, and settles the job it was pressed on", async (t) => {
  let round = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Carried on.", toolCalls: [] };
    round++;
    const call = round === 1 ? ["user.task", { description: "sign the lease", kind: "signing" }]
      : round === 2 ? ["user.later", { description: "write chapter two" }] : null;
    return call ? { content: "", toolCalls: [{ id: `c${round}`, name: call[0], arguments: JSON.stringify(call[1]) }] } : { content: "Picked up.", toolCalls: [] };
  } };
  const { app, page, errors } = await newWindow(t, { provider, seed: async (branch) => {
    await branch.runtime.run({ prompt: "get the lease signed" });
    await branch.runtime.run({ prompt: "leave chapter two for later" });
  } });
  const place = await openPlace(page, "inbox", "later");
  const jobs = app.runtime.deferrals.list({ waiting: true });
  const signing = jobs.find((job) => job.kind === "signing"), later = jobs.find((job) => job.kind === "later");
  assert.ok(signing && later);
  const sign = place.locator(`[data-act="laterb17"][data-id="${signing.id}"]`);
  await sign.waitFor();
  assert.equal(await sign.getAttribute("data-v"), "signed");
  assert.equal((await sign.textContent()).trim(), "I've signed it");
  const finish = place.locator(`[data-act="laterb17"][data-id="${later.id}"]`);
  assert.equal(await finish.getAttribute("data-v"), "finish");
  assert.equal((await finish.textContent()).trim(), "Finish now");
  await sign.click();
  await sign.waitFor({ state: "detached" });
  assert.match(app.runtime.deferrals.get(signing.id).outcome, /reports that they signed it/);
  assert.equal(app.runtime.deferrals.get(later.id).settledAt, null, "the other job is still waiting");
  assert.deepEqual(errors, []);
});
