/* RES-719: GitLab as a connection of its own, set up from the window: a token checked with GitLab before it is kept in
   the locker, the tools only in the index once connected and switched on, reading and writing issues and merge requests
   against a stand-in GitLab on this computer, the token only ever in a header and never in an answer, and Disconnect
   taking it out of the locker.
   Mutations: in src/gitlab-connection.ts connect keep the token before checking it (move secrets.put above whoami), and
   the refused token is kept: red. In src/feature-switches.ts drop the gitlabConnected check, and the tools reach the
   index before anything is connected: red. In src/integrations/gitlab.ts drop the "Draft: " prefix, and a draft merge
   request opens as ready: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { gitlabApi } from "../dist/gitlab-connection.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { discardTemp } from "./temp-dir.mjs";

const TOKEN = "glpat-test-0123456789";

/** A stand-in GitLab: who the token is, merge requests, issues and notes; it records every request. */
async function standIn(t) {
  const hits = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      hits.push({ method: request.method, url: request.url, token: request.headers["private-token"], body: body ? JSON.parse(body) : null });
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers["private-token"] !== TOKEN) return send(401, { message: "401 Unauthorized" });
      const path = request.url.split("?")[0];
      if (path === "/api/v4/user") return send(200, { username: "sam", name: "Sam Rivera" });
      if (path === "/api/v4/projects/team%2Fapp/merge_requests" && request.method === "GET")
        return send(200, [{ iid: 4, title: "Fix totals", state: "opened", draft: false, source_branch: "fix", target_branch: "main", web_url: "https://git.example/team/app/-/merge_requests/4" }]);
      if (path === "/api/v4/projects/team%2Fapp/merge_requests" && request.method === "POST") {
        const made = JSON.parse(body);
        return send(201, { iid: 5, title: made.title, draft: made.title.startsWith("Draft:"), state: "opened", web_url: "https://git.example/team/app/-/merge_requests/5" });
      }
      if (path === "/api/v4/projects/team%2Fapp/merge_requests/4/notes" && request.method === "POST") return send(201, { id: 99, body: JSON.parse(body).body });
      if (path === "/api/v4/projects/team%2Fapp/issues" && request.method === "POST")
        return send(201, { iid: 12, title: JSON.parse(body).title, web_url: "https://git.example/team/app/-/issues/12" });
      return send(404, { message: "404 Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, base: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-gitlab-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.web.configure({ allowPrivateAddresses: true });
  app.web.policy.resolve = async () => [];
  const owner = app.runtime.owner;
  const api = (method, path, body) => gitlabApi({ connection: app.gitlab, store: app.store, owner, requireOwner: () => {} }, method, path, async () => body);
  const hidden = () => switchedToolTiers(app.store, owner, app.registry.names()).hidden.filter((name) => name.startsWith("gitlab."));
  const run = (name, args) => app.registry.execute(name, args, app.runtime.context({ runId: "gitlab-test", permissions: ["gitlab.read", "gitlab.manage"] }));
  return { app, owner, api, hidden, run, project: app.store.projects.active(owner).id };
}

test("a token is checked with GitLab before it is kept, and the tools reach the index only once connected", async (t) => {
  const gitlab = await standIn(t);
  const f = await fixture(t);
  const before = await f.api("GET", "/api/gitlab");
  assert.equal(before.settings.mode, "when-needed", "GitLab ships when needed");
  assert.equal(before.account.connected, false);
  assert.equal(f.hidden().length, 10, "not connected: none of the ten tools is advertised");
  await assert.rejects(f.run("gitlab.merge_requests", { project: "team/app" }), /isn't connected/);

  await assert.rejects(f.api("POST", "/api/gitlab/connect", { token: "glpat-wrong-000000", apiBase: gitlab.base }), /did not accept the token/);
  assert.deepEqual(f.app.store.secrets.list(f.owner, f.project).map((s) => s.name), [], "a refused token is not kept");

  const view = await f.api("POST", "/api/gitlab/connect", { token: TOKEN, apiBase: gitlab.base });
  assert.deepEqual([view.account.connected, view.account.who, view.account.server], [true, "Sam Rivera", new URL(gitlab.base).host]);
  assert.equal(JSON.stringify(view).includes(TOKEN), false, "the token is never read back");
  assert.deepEqual(f.app.store.secrets.list(f.owner, f.project).map((s) => s.name), ["GITLAB_TOKEN"], "kept in the locker");
  assert.deepEqual(f.hidden(), [], "connected: the tools are in the index");
});

test("issues and merge requests are read and written, the token only in a header, and a draft opens as a draft", async (t) => {
  const gitlab = await standIn(t);
  const f = await fixture(t);
  await f.api("POST", "/api/gitlab/connect", { token: TOKEN, apiBase: gitlab.base });
  const listed = await f.run("gitlab.merge_requests", { project: "team/app" });
  assert.deepEqual(listed.mergeRequests.map((mr) => [mr.number, mr.from, mr.into]), [[4, "fix", "main"]]);
  const opened = await f.run("gitlab.open_merge_request", { project: "team/app", title: "Tidy the cart", from: "tidy", into: "main", draft: true });
  assert.deepEqual([opened.number, opened.draft, opened.title], [5, true, "Draft: Tidy the cart"]);
  const noted = await f.run("gitlab.comment", { project: "team/app", on: "merge_request", number: 4, body: "Looks right." });
  assert.equal(noted.added, true);
  const raised = await f.run("gitlab.create_issue", { project: "team/app", title: "Totals are off" });
  assert.equal(raised.number, 12);
  const calls = gitlab.hits.filter((hit) => hit.url !== "/api/v4/user");
  assert.ok(calls.every((hit) => hit.token === TOKEN && !hit.url.includes(TOKEN)), "the token travels only in the header");
  assert.deepEqual(calls.filter((hit) => hit.method === "POST").map((hit) => hit.url),
    ["/api/v4/projects/team%2Fapp/merge_requests", "/api/v4/projects/team%2Fapp/merge_requests/4/notes", "/api/v4/projects/team%2Fapp/issues"]);
  const writes = f.app.registry.inventory().filter((tool) => tool.name.startsWith("gitlab.") && tool.permission === "gitlab.manage").map((tool) => tool.name).sort();
  assert.deepEqual(writes, ["gitlab.comment", "gitlab.create_issue", "gitlab.create_project", "gitlab.open_merge_request"], "every change is behind gitlab.manage, which asks first");
});

test("switched off, the tools refuse and leave the index; Disconnect takes the token out of the locker", async (t) => {
  const gitlab = await standIn(t);
  const f = await fixture(t);
  await f.api("POST", "/api/gitlab/connect", { token: TOKEN, apiBase: gitlab.base });
  await f.api("POST", "/api/gitlab", { mode: "off" });
  assert.equal(f.hidden().length, 10);
  await assert.rejects(f.run("gitlab.merge_requests", { project: "team/app" }), /switched off/);
  await f.api("POST", "/api/gitlab", { mode: "when-needed" });
  const gone = await f.api("POST", "/api/gitlab/disconnect", {});
  assert.equal(gone.account.connected, false);
  assert.deepEqual(f.app.store.secrets.list(f.owner, f.project), [], "the token is out of the locker");
  assert.equal(f.hidden().length, 10);
  await assert.rejects(f.api("POST", "/api/gitlab/connect", { token: TOKEN, apiBase: "http://gitlab.example.org" }), /https/);
});
