import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("RES711 inbox shows saved publication status and owner retry/cancel actions", async (t) => {
  const id = "a".repeat(64), seen = [];
  let entry = { id, repository: "owner/repo", branch: "branch/change", state: "blocked", reason: "GitHub is unavailable <unsafe>", nextAttemptAt: Date.now() + 15_000 };
  const { page, errors } = await newWindow(t, { seed(app) {
    app.sourcePublications.list = () => [entry];
    app.sourcePublications.retry = async (value) => { seen.push(["retry", value]); entry = { ...entry, state: "waiting", reason: "Waiting for GitHub" }; return entry; };
    app.sourcePublications.cancel = (value) => { seen.push(["cancel", value]); entry = { ...entry, state: "cancelled" }; return entry; };
  } });
  await openPlace(page, "inbox", "needs");
  await page.locator('[data-act="source-publication-retry"]').waitFor();
  assert.equal(await page.locator("unsafe").count(), 0);
  await page.locator('[data-act="source-publication-retry"]').click();
  await page.getByText("Waiting to publish", { exact: true }).waitFor();
  await page.locator('[data-act="source-publication-cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-act="source-publication-cancel"]'));
  assert.deepEqual(seen, [["retry", id], ["cancel", id]]);
  assert.deepEqual(errors, []);
});

test("SELF-026 the Inbox publishes a prepared source change only as the reviewed draft, after the owner's consent", async (t) => {
  const id = "0b6f8a8e-5d7e-4e8a-9f35-3a1c2b4d5e6f", seen = [];
  const review = { revision: 2, contractHash: "c".repeat(64), sourceSha: "a".repeat(40), head: "b".repeat(40), tree: "d".repeat(40),
    branch: "branch/self-export", repository: "owner/repo", base: "redesign/window", remote: "origin" };
  const contract = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
    definitionOfDone: "The Export button is gone", sideEffects: [], rollbackPlan: "Remove the worktree" };
  const diff = { files: [], untracked: [], outside: [], truncated: false, allowedPaths: contract.allowedPaths, note: "One file changed.", warning: null };
  let request = { id, text: "Remove the Export button", status: "approved", at: new Date().toISOString(), from: { senderName: "Sam", channel: "chat" } };
  const { page, errors } = await newWindow(t, { seed(app) {
    app.sourceRequests.list = () => [request];
    app.sourceRequests.diff = async () => diff;
    app.sourceDrafts.preview = async (value) => { seen.push(["preview", value]); return { request, review, diff, contract }; };
    app.sourceDrafts.publish = async (value, body) => {
      seen.push(["publish", value, body]); request = { ...request, status: "published" };
      return { publication: { id: "e".repeat(64), state: "published", reason: null } };
    };
  } });
  await openPlace(page, "inbox", "needs");
  await page.locator('[data-act="selfrev15"]').click();
  const publish = page.locator('[data-act="selfdo15"][data-v="published"]');
  await publish.waitFor();
  await page.getByText(review.head, { exact: true }).waitFor();
  await page.locator("#source-title").fill("Remove the Export button");
  await page.locator("#source-summary").fill("As Sam asked.");
  await publish.click();
  assert.deepEqual(seen.filter(([what]) => what === "publish"), [], "nothing is published before the owner consents");
  await page.locator('#source-publish input[name="consent"]').check();
  await publish.click();
  await page.waitForFunction(() => !document.querySelector("#source-publish"));
  assert.deepEqual(seen.at(-1), ["publish", id, { review, title: "Remove the Export button", summary: "As Sam asked.", consent: true }]);
  assert.deepEqual(errors, []);
});

test("SELF-026 the terms form for a waiting request can be filled in: its fields are live, not greyed", async (t) => {
  const id = "1c7f9b9f-6e8f-4f9b-8a46-4b2d3c5e6f70";
  const request = { id, text: "Remove the Export button", status: "waiting", at: new Date().toISOString(), from: { senderName: "Sam", channel: "chat" } };
  const diff = { files: [], untracked: [], outside: [], truncated: false, allowedPaths: [], note: "Nothing has been changed yet.", warning: null };
  const { page, errors } = await newWindow(t, { seed(app) {
    app.sourceRequests.list = () => [request];
    app.sourceRequests.diff = async () => diff;
  } });
  await openPlace(page, "inbox", "needs");
  await page.locator('[data-act="selfrev15"]').click();
  await page.locator('[data-act="selfdo15"][data-v="editing"]').waitFor();
  for (const field of ["name", "allowedPaths", "permissions", "definitionOfDone", "rollbackPlan"]) {
    const box = page.locator(`#source-${field}`);
    assert.equal(await box.isEnabled(), true, `${field} can be filled in`);
    assert.equal(await box.evaluate((el) => el.classList.contains("soon")), false, `${field} is not greyed`);
  }
  await page.locator("#source-name").fill("remove-export");
  assert.deepEqual(errors, []);
});
