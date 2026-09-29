/**
 * The isolated engine and scratch repository the self-development loop proof runs on: its own data
 * folder, workspace and free port, a throwaway bare repository as "origin", and the launch settings
 * that switch on commands, sending work and GitHub (pointed at tests/fixtures/fake-github.mjs, or at
 * real GitHub for scripts/selfdev-proof.mjs --github).
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { promisify } from "node:util";
import { createBranch } from "../../dist/index.js";
import { startServer } from "../../dist/server.js";
import { loadIntegrations } from "../../dist/integrations/bootstrap.js";
import { saveKnobs } from "../../dist/knobs/settings.js";
import { ChatGPTAuth, FileTokenVault } from "../../dist/chatgpt-auth.js";

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

/**
 * A CI machine has no Git identity, and Branch reports that rather than inventing one, so the engine's own commits
 * would fail there. Only then, this process's home becomes a folder of the run's own with a test identity in it
 * (Git reads HOME; Branch passes HOME on to Git). A computer with an identity is left exactly as it is.
 */
async function gitIdentity(root) {
  const known = await git(root, "config", "--get", "user.email").catch(() => "");
  if (known) return;
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Selfdev Proof\n\temail = selfdev@example.invalid\n");
  process.env.HOME = home;
}

/** Room for a long piece of work, set as the owner would in Settings: more rounds and a longer tool wait for checks. */
export function roomToWork(app) {
  saveKnobs(app.store, app.runtime.owner, "limits", { maxSteps: 400, maxModelRounds: 300, maxTaskTokens: 20_000_000 });
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: 1800, commandTimeoutSeconds: 1800 });
}

/** The owner's designated default Trunk ("Ada"), introduced, with its conversation in Full Access; its session id. */
export async function defaultTrunkConversation(engine) {
  const { trunks } = engine.app;
  trunks.setMode("trunks", { mode: "on" });
  const ada = trunks.create({ name: "Ada" });
  trunks.setDefault(ada.id);
  await trunks.introduced();
  const mode = await engine.api("conversation-mode", { sessionId: ada.chatSessionId, mode: "full" });
  if (mode.status !== 200) throw new Error(`Full Access was not selected: ${JSON.stringify(mode.body)}`);
  return ada.chatSessionId;
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
  await gitIdentity(root);
  const executables = {
    git: { path: await executablePath("git"), args: [] },
    node: { path: process.execPath, args: [] },
    // Windows has no native npm program: its alias is node.exe with npm's own script (src/integrations/shell-config.ts).
    ...(options.npm ? { npm: process.platform === "win32"
      ? { path: process.execPath, args: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] }
      : { path: await executablePath("npm"), args: [] } } : {}),
    ...(options.python ? { python: { path: await executablePath("python"), args: [] } } : {}),
  };
  const integrations = {
    shell: { executables, timeoutMs: 1_800_000, maxCpuSeconds: 7200, maxOutputBytes: 8192, useJobObject: false,
      inheritEnv: ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "HOME"] },
    git: { remote: true, github: { ...(options.githubApiBase ? { apiBase: options.githubApiBase } : {}), ...(options.githubPollSeconds ? { checksPollSeconds: options.githubPollSeconds } : {}) } },
    ...(options.privateAddresses ? { web: { allowPrivateAddresses: true } } : {}),
  };
  const file = join(root, "integrations.json");
  await writeFile(file, JSON.stringify(integrations, null, 2));
  // `chatgptAuth`: a bench ChatGPT sign-in (Branch's own chatgpt-auth.json from `branch login` on a bench folder, never
  // another program's) is copied in, and copied back on close, so its refreshed tokens stay one chain.
  const chatgptFile = join(dataDir, "chatgpt-auth.json");
  if (options.chatgptAuth) { await mkdir(dataDir, { recursive: true }); await copyFile(options.chatgptAuth, chatgptFile); }
  const chatgpt = () => options.chatgptAuth ? { chatgpt: new ChatGPTAuth(new FileTokenVault(chatgptFile), { userAgent: "BranchAgent" }) } : {};
  // `connect(app)` saves a model connection and asks for a restart, as the owner's app does when one is added.
  let app = await createBranch({ workspace, dataDir, ...chatgpt(), ...(options.provider ? { provider: options.provider } : {}) });
  if (options.connect && await options.connect(app)) { await app.close(); app = await createBranch({ workspace, dataDir, ...chatgpt() }); }
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
    close: async () => {
      await server.close().catch(() => undefined); await loaded.close().catch(() => undefined); await app.close();
      if (options.chatgptAuth) await copyFile(chatgptFile, options.chatgptAuth).catch(() => undefined);
    } };
}
