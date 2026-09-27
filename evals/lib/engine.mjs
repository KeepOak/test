/**
 * One throwaway Branch engine for the evals: its own data folder, its own workspace, its own port, started exactly the
 * way a person starts it (`node dist/cli.js start`). Nothing here reads or touches anyone's real Branch data.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const clockShift = fileURLToPath(new URL("./clock-shift.mjs", import.meta.url));

/**
 * Starts the engine and waits for its token. `clockOffsetMs` moves the engine's clock forward (the simulated clock):
 * a preload shifts Date for that process only, so "three days later" is real to everything the engine does.
 */
/* Every engine still running, so a run can stop them all before it exits (none is ever left behind on the PC). */
const live = new Set();
export function stopAllEngines() { for (const child of live) child.kill(); }

export async function startEngine({ root, port, env = {}, clockOffsetMs = 0, timeoutMs = 85_000 }) {
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const cli = join(repo, "dist", "cli.js");
  const args = clockOffsetMs ? ["--import", pathToFileUrl(clockShift), cli, "start"] : [cli, "start"];
  // The engine runs in its own workspace, so a coding assistant it starts as a model sees only that folder.
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: { ...cleanEnv(), ...env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace, BRANCH_PORT: String(port),
      EVAL_CLOCK_OFFSET_MS: String(clockOffsetMs) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  live.add(child);
  child.once("exit", () => live.delete(child));
  let output = "";
  const found = await new Promise((resolve, reject) => {
    // An engine that did not come up is stopped here: left running, it kept the whole run (and the nightly) waiting on it.
    const timer = setTimeout(() => { child.kill(); reject(new Error(`engine did not start in ${timeoutMs} ms:\n${output.slice(-2000)}`)); }, timeoutMs);
    const read = (chunk) => {
      output += chunk.toString("utf8");
      const token = /Local session token \(paste into browser\): ([A-Za-z0-9_-]+)/.exec(output);
      // BRANCH_PORT may be 0 (an ephemeral port for parallel CI shards); the real one is in the "listening at" line.
      const url = /listening at (https?:\/\/[^\s]+)/.exec(output);
      if (token) { clearTimeout(timer); resolve({ token: token[1], boundPort: url ? new URL(url[1]).port : String(port) }); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`engine exited ${code}:\n${output.slice(-2000)}`)); });
  });
  const token = found.token;
  const base = `http://127.0.0.1:${found.boundPort}`;
  const engine = { child, token, base, dataDir, workspace, root, log: () => output };
  engine.api = (path, body, options = {}) => api(engine, path, body, options);
  engine.stop = () => stopEngine(engine);
  return engine;
}

/** The engine gets only what it needs to run; the harness's own variables (and any key) stay out. */
function cleanEnv() {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
    "HOME", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "ComSpec", "PROGRAMFILES", "ProgramFiles", "LANG"];
  const env = {};
  for (const name of keep) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function pathToFileUrl(path) { return new URL(`file:///${path.replace(/\\/g, "/").replace(/^\//, "")}`).href; }

/** One call to the engine's HTTP API. A non-2xx answer throws with the engine's own words unless `raw` is set. */
export async function api(engine, path, body, { method, raw = false, timeoutMs = 600_000 } = {}) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(`${engine.base}/api/${path}`, {
    method: verb,
    headers: { authorization: `Bearer ${engine.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (raw) return { status: response.status, data };
  if (!response.ok) throw new Error(`${verb} /api/${path}: ${response.status} ${data?.error ?? JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function stopEngine(engine) {
  if (engine.child.exitCode !== null) return;
  const gone = new Promise((resolve) => engine.child.once("exit", resolve));
  engine.child.kill();
  const timer = setTimeout(() => { try { engine.child.kill("SIGKILL"); } catch { /* already gone */ } }, 8000);
  await gone;
  clearTimeout(timer);
}
