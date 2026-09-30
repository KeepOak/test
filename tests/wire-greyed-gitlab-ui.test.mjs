/* wire-greyed (RES-719): Settings › Advanced › GitLab was greyed ("GitLab isn't in Branch's connections yet"). It is now
   the engine's own switch (POST /api/gitlab) with its connection under it: Connect checks a pasted token with GitLab
   (here a stand-in on this computer) and keeps it in the locker; Disconnect, after a yes, takes it out again.
   Mutation: in public/app/settings/p17-advanced.js drop "+ gitlabRow()", and there is no way to connect: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

const TOKEN = "glpat-window-0123456789";

async function standIn(t) {
  const server = createServer((request, response) => {
    const ok = request.headers["private-token"] === TOKEN && request.url.startsWith("/api/v4/user");
    response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(ok ? { username: "sam", name: "Sam Rivera" } : { message: "401 Unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("GitLab in Settings › Advanced: a live switch, Connect keeps a checked token in the locker, Disconnect takes it out", { timeout: 180000 }, async (t) => {
  const gitlab = await standIn(t);
  const before = (app) => { app.web.configure({ allowPrivateAddresses: true }); app.web.policy.resolve = async () => []; };
  const { app, page, errors, call } = await settingsWindow(t, { before, name: "wire-gitlab" });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const box = page.locator("#f15-gitlab");
  await box.waitFor();
  assert.equal(await box.getAttribute("aria-disabled"), null, "the switch is live");
  assert.equal(await box.isChecked(), true, "it ships when needed");

  const row = page.locator("#gl-row");
  await row.locator('[data-act="gl-connect"]').click();
  await page.locator("#gl-server").fill(gitlab);
  await page.locator("#gl-token").fill("glpat-wrong-0000000");
  await page.locator('[data-act="gl-connect-go"]').click();
  await page.getByText("GitLab did not accept the token", { exact: false }).first().waitFor();
  assert.equal((await call("/api/gitlab")).account.connected, false, "a refused token is not kept");

  await page.locator("#gl-token").fill(TOKEN);
  await page.locator('[data-act="gl-connect-go"]').click();
  await row.getByText(`Connected to ${new URL(gitlab).host} as Sam Rivera.`).waitFor();
  const owner = app.runtime.owner, project = app.store.projects.active(owner).id;
  assert.deepEqual(app.store.secrets.list(owner, project).map((s) => s.name), ["GITLAB_TOKEN"], "kept in the locker");
  assert.equal((await page.content()).includes(TOKEN), false, "the token is not left in the window");

  await row.locator('[data-act="gl-disconnect"]').click();
  await page.locator('[data-act="gl-disconnect-yes"]').click();
  await row.locator('[data-act="gl-connect"]').waitFor();
  assert.deepEqual(app.store.secrets.list(owner, project), [], "Disconnect takes the token out");

  await box.click();
  await page.locator("#gl-row").waitFor({ state: "detached" });
  assert.equal((await call("/api/gitlab")).settings.mode, "off", "switched off in the engine");
  assert.deepEqual(errors, []);
});
