/**
 * The isolated engine and scratch repository the self-development loop proof runs on: its own data
 * folder, workspace and free port, a throwaway bare repository as "origin", and the launch settings
 * that switch on commands, sending work and GitHub (pointed at tests/fixtures/fake-github.mjs, or at
 * real GitHub for scripts/selfdev-proof.mjs --github).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { promisify } from "node:util";
import { createBranch } from "../../dist/index.js";
import { startServer } from "../../dist/server.js";
import { loadIntegrations } from "../../dist/integrations/bootstrap.js";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", args, { cwd, windowsHide: true })).stdout.trim();

export const scratchTestFile = "tests/settings.test.mjs";
const files = {
  "package.json": `${JSON.stringify({ name: "scratch-settings", private: true, type: "module" }, null, 2)}\n`,
  "src/settings.mjs": [
    "/** The app's settings knobs: each has a default and says which values it accepts. */",
    "export const knobs = {",
    "  theme: { default: \"light\", valid: (value) => [\"light\", \"dark\"].includes(value) },",
    "};",
    "",
    "/** A saved value when it is valid, else the knob's default. Unknown names are refused. */",
    "export function readSetting(saved, name) {",
    "  const knob = knobs[name];",
    "  if (!knob) throw new Error(`No setting called ${name}`);",
    "  return Object.hasOwn(saved, name) && knob.valid(saved[name]) ? saved[name] : knob.default;",
    "}",
    "",
  ].join("\n"),
  [scratchTestFile]: [
    "import test from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { readSetting } from \"../src/settings.mjs\";",
    "",
    "test(\"theme defaults to light and keeps a valid saved value\", () => {",
    "  assert.equal(readSetting({}, \"theme\"), \"light\");",
    "  assert.equal(readSetting({ theme: \"dark\" }, \"theme\"), \"dark\");",
    "  assert.equal(readSetting({ theme: \"purple\" }, \"theme\"), \"light\");",
    "});",
    "",
  ].join("\n"),
};

/** A bare "origin" with one commit on main holding a tiny settings module and its test. */
export async function seedScratchRepo(root) {
  const bare = join(root, "origin.git"), seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  await git(seed, "init", "--quiet", "--initial-branch=main");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(seed, name, ".."), { recursive: true });
    await writeFile(join(seed, name), text);
  }
  await git(seed, "add", "-A");
  await git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "Seed settings");
  await git(seed, "push", "--quiet", bare, "HEAD:refs/heads/main");
  return { bare, head: await git(bare, "rev-parse", "main") };
}

/** Where git, node and npm live on this computer, for the command aliases. */
async function executablePath(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const lines = (await run(finder, [name], { windowsHide: true })).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const wanted = process.platform === "win32" ? lines.find((line) => /\.(exe|cmd)$/i.test(line)) : lines[0];
  if (!wanted) throw new Error(`${name} was not found on this computer`);
  return wanted;
}

/**
 * The isolated engine. `github.apiBase` is the fake's address, or real GitHub's; the token goes
 * straight into this engine's locker and is never printed.
 */
export async function startEngine(root, options) {
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const executables = {
    git: { path: await executablePath("git"), args: [] },
    node: { path: process.execPath, args: [] },
    // Windows has no native npm program: its alias is node.exe with npm's own script (src/integrations/shell-config.ts).
    ...(options.npm ? { npm: process.platform === "win32"
      ? { path: process.execPath, args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] }
      : { path: await executablePath("npm"), args: [] } } : {}),
  };
  const integrations = {
    shell: { executables, timeoutMs: 120000, maxCpuSeconds: 600, maxOutputBytes: 8192, useJobObject: false,
      inheritEnv: ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "HOME"] },
    git: { remote: true, github: { ...(options.githubApiBase ? { apiBase: options.githubApiBase } : {}), ...(options.githubPollSeconds ? { checksPollSeconds: options.githubPollSeconds } : {}) } },
    ...(options.privateAddresses ? { web: { allowPrivateAddresses: true } } : {}),
  };
  const file = join(root, "integrations.json");
  await writeFile(file, JSON.stringify(integrations, null, 2));
  // `connect(app)` saves a model connection and asks for a restart, as the owner's app does when one is added.
  let app = await createBranch({ workspace, dataDir, ...(options.provider ? { provider: options.provider } : {}) });
  if (options.connect && await options.connect(app)) { await app.close(); app = await createBranch({ workspace, dataDir }); }
  let loaded;
  try {
    await options.ready?.(app);
    loaded = await loadIntegrations(app.registry, file, process.env, app.secretsFor, app.channelHost);
    await app.store.secrets.put(app.runtime.owner, "default", "GITHUB_TOKEN", options.token, { expiresInDays: 0 });
  } catch (error) { await app.close(); throw error; }
  const server = await startServer(app, { dataDir, port: 0, host: "127.0.0.1" });
  const api = async (path, body, method) => {
    // node:http rather than fetch: a real task can take longer than fetch's five-minute wait for the first byte.
    const text = JSON.stringify(body ?? {});
    const answer = await new Promise((resolve, reject) => {
      const outgoing = request(new URL(`/api/${path}`, server.url), { method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", ...(body === undefined ? {} : { "content-length": Buffer.byteLength(text) }) } },
      (incoming) => { let data = ""; incoming.setEncoding("utf8"); incoming.on("data", (chunk) => { data += chunk; }); incoming.on("end", () => resolve({ status: incoming.statusCode, data })); });
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : text);
    });
    let parsed; try { parsed = JSON.parse(answer.data); } catch { parsed = answer.data; }
    return { status: answer.status, body: parsed };
  };
  return { app, server, api, workspace, dataDir,
    close: async () => { await server.close().catch(() => undefined); await loaded.close().catch(() => undefined); await app.close(); } };
}
