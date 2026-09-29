/**
 * Bucket 21 (A1509): the Go client in packages/sdk-go, proved three ways: its own `go test` suite
 * against a fake server, the same package driving a real Branch Agent over the network, and every
 * Go snippet and starter program the sdk tools hand out compiled against it. All need Go 1.23 or
 * later on the computer; where there is none, the tests say so and are skipped rather than failing.
 * GOTOOLCHAIN=local keeps Go from downloading a newer toolchain in the middle of a test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { apiRoutes, createBranch, routeSnippets, starterProgram } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveSdkKitSettings } from "../dist/sdk-kit.js";
import { discardTemp } from "./temp-dir.mjs";

const run = promisify(execFile);
const packageDir = join(import.meta.dirname, "..", "packages", "sdk-go");
const goEnv = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", GOWORK: "off" };

async function findGo() {
  try {
    const { stdout } = await run("go", ["env", "GOVERSION"], { timeout: 15000, env: goEnv });
    const [, minor] = /^go1\.(\d+)/.exec(stdout.trim()) ?? [];
    return Number(minor) >= 23;
  } catch { return false; }
}
const skip = (await findGo()) ? false : "no Go 1.23+ on this computer";
const go = (args, options = {}) => run("go", args, { timeout: 240000, env: goEnv, ...options });

test("the Go client's own tests pass, and it has no dependency", { skip }, async () => {
  const { stdout } = await go(["test", "-count=1", "./..."], { cwd: packageDir });
  assert.match(stdout, /^ok\s+github\.com\/stabrea\/Branch-Agent\/packages\/sdk-go\/branch/m);
  const { stdout: listed } = await go(["list", "-m", "all"], { cwd: packageDir });
  assert.deepEqual(listed.trim().split("\n"), ["github.com/stabrea/Branch-Agent/packages/sdk-go"], "standard library only");
  await go(["vet", "./..."], { cwd: packageDir });
});

test("the Go client drives a real Branch Agent: start, stream, read, search, refusals", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-go-"));
  const provider = { name: "scripted", async complete() { return { content: "Three lines about the meeting.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  // Building on Branch ships when needed (defaults audit); switched off here, so the client's refusal is exercised.
  saveSdkKitSettings(app.store, app.runtime.owner, { mode: "off" });

  // The key is read from the data folder by the client itself, never passed on a command line.
  const env = { ...goEnv, BRANCH_DATA_DIR: join(root, "data"), BRANCH_PORT: new URL(server.url).port };
  const { stdout } = await go(["test", "-count=1", "-run", "^TestLive$", "-v", "./branch"], { cwd: packageDir, env });
  const line = stdout.split("\n").find((entry) => entry.startsWith("LIVE "));
  assert.ok(line, stdout);
  const out = JSON.parse(line.slice(5));

  assert.equal(out.kinds.at(-1), "end", "the stream says when the task is over");
  assert.equal(out.output, "Three lines about the meeting.");
  assert.ok(out.found >= 1, "documents are found through the Go client");
  for (const path of ["/api/run", "/api/runs/{runId}", "/api/memory/search", "/api/flows/yaml"])
    assert.ok(out.described.split(" ").includes(path), `${path}, which the Go client calls, is in the OpenAPI description`);
  assert.equal(out.refused[0], 404);
  assert.match(out.refused[1], /not found/i);
  assert.equal(out.wrongKey, 401);
  assert.equal(out.yamlOff[0], 409, "writing a flow out as YAML waits for the switch");
});

test("every Go snippet and the Go starter the sdk tools hand out compile against the client", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-go-snippets-"));
  t.after(() => discardTemp(root));
  const module = "github.com/stabrea/Branch-Agent/packages/sdk-go";
  const goMod = `module example.com/uses-branch\n\ngo 1.23\n\nrequire ${module} v0.0.0\n\nreplace ${module} => ${JSON.stringify(packageDir.replaceAll("\\", "/"))}\n`;
  const calls = apiRoutes.map((route) => `\t_, _ = ${routeSnippets(route).go}`).join("\n");
  const snippets = `package main

import (
\t"context"
\t"net/url"

\t"${module}/branch"
)

func main() {
\tctx := context.Background()
\tclient, _ := branch.New("http://127.0.0.1:1", "key")
\trunId, sessionId, flowId := "r", "s", "f"
\t_, _, _, _ = runId, sessionId, flowId, url.PathEscape
${calls}
}
`;
  for (const [folder, source] of [["snippets", snippets], ["starter", starterProgram("go").text]]) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, "go.mod"), goMod);
    await writeFile(join(root, folder, "main.go"), source);
    await go(["vet", "."], { cwd: join(root, folder) });
  }
});
