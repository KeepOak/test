import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newWindow, openSettings } from "./new-window-places.mjs";
import { waitInPage } from "./wait-in-page.mjs";

test("Practice is an explicit next-task choice, keeps a rejected draft, and the next ordinary task is real", async (t) => {
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    // QA R1: after a yes the engine makes the approved call itself; the model never makes it again.
    if (last?.role === "user") return { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write",
      arguments: JSON.stringify({ path: "chosen.txt", content: "real" }) }] };
    return { content: "Finished.", toolCalls: [] };
  } };
  const { page, app, call, root, errors } = await newWindow(t, { provider, seed(app) { app.coding.setMode("read-first", "off"); } });
  await page.locator('[data-act="plusmenu"]').click();
  await page.locator("#pm-practice").click();
  await page.locator(".c-flags").filter({ hasText: "Practice this task" }).waitFor();
  await page.locator("#prompt").fill("/dry-run");
  await page.locator("#prompt").press("Enter");
  assert.equal(await page.locator("#prompt").inputValue(), "/dry-run", "a command never bypasses the Practice flag");
  await page.locator("#prompt").fill("propose file changes");
  await call("/api/practice-runs", { enabled: false });
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "propose file changes");
  assert.equal(await page.locator(".c-flags").innerText().then((s) => s.includes("Practice this task")), true);
  await assert.rejects(readFile(join(root, "workspace", "chosen.txt")), /ENOENT/);
  await call("/api/practice-runs", { enabled: true });
  await page.locator("#prompt").press("Enter");
  await waitInPage(page, async () => { const { S } = await import("/app/core/state.js"); return !!S.chat && !document.querySelector(".c-flags")?.textContent.includes("Practice this task"); });
  await page.waitForFunction(() => document.querySelector("#send")?.type === "submit");
  await assert.rejects(readFile(join(root, "workspace", "chosen.txt")), /ENOENT/);
  await page.locator("#prompt").fill("now write it");
  await page.locator("#prompt").press("Enter");
  // The ordinary task still follows the conversation's real approval policy.
  await page.locator('[data-act="ask"][data-v="allow"]').click();
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 100; i++) { try { assert.equal(await readFile(join(root, "workspace", "chosen.txt"), "utf8"), "real"); return; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    throw new Error("ordinary task never wrote the file: " + await page.locator("#main").innerText());
  });
  await openSettings(page, "permissions");
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  await page.locator("#f15-practice-runs").uncheck();
  await waitInPage(page, async () => { const { api } = await import("/app/core/api.js"); return (await api("practice-runs")).enabled === false; });
  assert.deepEqual(errors, []);
});
