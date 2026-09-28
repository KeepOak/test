/**
 * QA retest 2026-09-28 (X1, m15): a gateway and its engine both ended with nothing written anywhere, because the gateway
 * kept its notes in memory only; and `branch quit` under a gateway was refused by the engine behind it, so it ended the
 * process from outside (exit code 1). The gateway now keeps `logs/gateway.jsonl` (started, engine ready, engine stopped
 * and how, closed and why, or ended without being asked) and answers `branch quit` itself. Node only: the real dist/,
 * a real `branch start` with the gateway switched on, no model, temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const record = async (dataDir) => (await readFile(join(dataDir, "logs", "gateway.jsonl"), "utf8").catch(() => ""))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));
const until = async (check, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

test("the gateway writes when it starts, when its engine stops, and why it closed; branch quit closes it cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-record-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "when-needed" }));
  const env = { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace, BRANCH_PORT: "0" };
  const gateway = spawn(process.execPath, [cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  gateway.stdout.on("data", (chunk) => { out += chunk; });
  gateway.stderr.on("data", (chunk) => { out += chunk; });
  const ended = new Promise((resolve) => gateway.once("exit", (code) => resolve(code)));
  t.after(async () => { if (gateway.exitCode === null) gateway.kill(); await ended; await discardTemp(root); });

  assert.ok(await until(async () => (await record(dataDir)).some((line) => line.message === "The engine is ready")), `the engine came up: ${out}`);
  const url = /Branch gateway listening at (\S+)/.exec(out)?.[1];
  assert.ok(url, "the gateway said where it listens");
  const first = (await record(dataDir))[0];
  assert.equal(first.message, "The gateway started");
  assert.equal(first.component, "gateway");

  const health = await (await fetch(`${url}/gateway/health`)).json();
  process.kill(health.worker.pid);
  assert.ok(await until(async () => (await record(dataDir)).some((line) => line.message === "The engine stopped unexpectedly")), "an engine that stopped is written down");
  assert.ok(await until(async () => (await record(dataDir)).filter((line) => line.message === "The engine is ready").length >= 2), "and a new one came up");

  // Asked without blocking: this test is the gateway's parent, and on Linux and macOS a parent stuck in spawnSync cannot
  // reap the gateway once it exits, so `branch quit` saw its process id alive until it gave up.
  const quit = await promisify(execFile)(process.execPath, [cli, "quit"], { env, encoding: "utf8", timeout: 60000, windowsHide: true })
    .catch((error) => ({ stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) }));
  assert.match(quit.stdout, /has closed/, quit.stdout + quit.stderr);
  assert.equal(await ended, 0, "branch quit closes the gateway itself, cleanly");
  const last = (await record(dataDir)).at(-1);
  assert.equal(last.message, "The gateway closed");
  assert.equal(last.fields.why, "branch quit");
});

test("a gateway that ends without being asked says so as it ends", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-unasked-"));
  t.after(() => discardTemp(root));
  const module = new URL("../dist/never-break/flight-record.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { openGatewayRecord } = await import(${JSON.stringify(module)}); openGatewayRecord(${JSON.stringify(root)}, "test"); process.exit(3);`],
  { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(child.status, 3, child.stderr);
  const lines = await record(root);
  assert.deepEqual(lines.map((line) => line.message), ["The gateway started", "The gateway ended without being asked to"]);
  assert.equal(lines[1].fields.code, 3);
  assert.equal(lines[1].level, "error");
});
