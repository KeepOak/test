// SELF-021: the owner connects GitHub by its device flow, and the token lands in the locker, never in settings.
// A stand-in GitHub answers every request; nothing leaves this computer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { GitHubDeviceConnection } from "../dist/github-device-connection.js";
import { asCaller } from "../dist/caller.js";
import { discardTemp } from "./temp-dir.mjs";

const owner = { kind: "owner-here", lockdown: false, appLocked: false, throughDoor: false, fromThisComputer: true, household: false };
const token = "gho_standInToken123456"; // not-a-real-secret
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function standInGitHub() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input); calls.push({ url, auth: init.headers?.Authorization ?? null });
    if (url === "https://github.com/login/device/code")
      return json({ device_code: "device-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: token, token_type: "bearer", scope: "repo,read:user" });
    if (url === "https://api.github.com/user") return json({ login: "owner-on-github", id: 7 });
    return json({ error: "unexpected" }, 404);
  };
  return { calls, fetchImpl };
}

test("the owner's device sign-in keeps the token in the locker and says who is connected; disconnect removes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-github-device-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const github = standInGitHub();
  // The network rules are tested on their own (network-policy); here the stand-in GitHub is reached as it is.
  const connection = new GitHubDeviceConnection({ store: app.store, owner: app.runtime.owner, policy: { guard: (send) => send }, locked: () => false, fetchImpl: github.fetchImpl });
  await asCaller(owner, async () => {
    await assert.rejects(connection.begin(), /client ID first/);
    connection.configure({ clientId: "Iv1.standin" });
    const started = await connection.begin();
    assert.equal(started.flow.userCode, "ABCD-1234");
    await new Promise((resolve) => setTimeout(resolve, 1100)); // GitHub's own interval before the first poll
    const done = await connection.poll({ flowId: started.flow.flowId });
    assert.equal(done.connected, true);
    assert.equal(done.who, "owner-on-github");
    const saved = JSON.stringify(app.store.get("settings", app.runtime.owner, "github.device.account")?.data ?? {});
    assert.doesNotMatch(saved, new RegExp(token), "settings hold the secret's name, never the token");
    assert.ok(app.store.secrets.list(app.runtime.owner, "default").some((entry) => entry.name.startsWith("BRANCH_GITHUB_")), "the token is in the locker");
    const disconnected = connection.disconnect();
    assert.equal(disconnected.connected, false);
    assert.equal(app.store.secrets.list(app.runtime.owner, "default").some((entry) => entry.name.startsWith("BRANCH_GITHUB_")), false, "disconnect takes it out");
  });
  assert.equal(github.calls.find((call) => call.url === "https://api.github.com/user")?.auth, `Bearer ${token}`);
  // Anyone but the owner in the app window is refused.
  assert.throws(() => connection.view(), /owner's app window/);
});
