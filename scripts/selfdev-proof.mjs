// The self-development acceptance run with a real model, on demand (never in CI): an isolated engine (its own data
// folder, workspace and free port under the session folder) whose owner's default Trunk, in a Full Access
// conversation, adds a settings knob all the way to a merge.
//
//   node scripts/selfdev-proof.mjs [--model claude|chatgpt:<model>|ollama:<name>] [--knob replyLength] [--broken] [--dry-run]
//     Local: a throwaway bare repository is "origin" and tests/fixtures/fake-github.mjs is GitHub (its CI really
//     runs the pushed head's test). --broken asks for a knob whose test fails and for a merge anyway: Branch must
//     refuse it, origin must not move and the engine must keep serving.
//
//   node scripts/selfdev-proof.mjs --github [--model claude]
//     Real GitHub, Branch's own source: a selfdev-proof/base-<stamp> scratch line is made from redesign/window, and
//     the Trunk changes Branch through branch.prepare_source_change (tests held in WSL on Windows), opens a draft
//     pull request into the scratch line, waits for the real checks and finishes it. Beta never builds that line,
//     and nothing is ever proposed to redesign/window. The pull request is closed afterwards if it is still open.
//
//   node scripts/selfdev-proof.mjs --sandbox [--owner-limits]
//     Real GitHub, a throwaway repository (KeepOak/branch-selfdev-sandbox: one required check in a ruleset, and main
//     merges only through GitHub's merge queue). A scripted model stand-in drives Branch's own tools through edit, test,
//     commit, push, pull request, exact checks, the merge queue and merged (scripts/selfdev-proof-sandbox.mjs). No
//     subscription is used; the verdict comes from GitHub's record, not the model.
//     --owner-limits keeps a fresh install's limits (tool time, rounds, steps) instead of the room a long task is given.
//
//   node scripts/selfdev-proof.mjs --sandbox-self [--owner-limits]
//     The same sandbox, Branch's own change path (scripts/selfdev-proof-sandbox-self.mjs): a contract, the edit,
//     branch.run_contract_tests behind the wall, a draft pull request into selfdev-proof/queue (required check and merge
//     queue on), exact checks, then branch.finish_source_change: independent review, ready for review, the merge queue.
//
//   node scripts/selfdev-proof.mjs --candidate
//     Never-break: while an isolated engine serves, a Branch candidate with a syntax error fails its build and its
//     canary, an unchanged candidate builds and passes the canary on a copy of the running data, and the running
//     engine keeps answering (scripts/selfdev-proof-candidate.mjs). No model is used and nothing is packaged.
//
// Build first (npm run build). The GitHub token for --github comes from `gh auth token` straight into the isolated
// engine's locker; it is never printed. Evidence goes to <root>/run.log and <root>/summary.json.
import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultTrunkConversation, roomToWork, seedScratchRepo, scratchTestFile, startEngine } from "../tests/fixtures/selfdev-harness.mjs";
import { startFakeGitHub } from "../tests/fixtures/fake-github.mjs";
import { addProgram } from "../dist/accounts/saved-sign-ins.js";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const model = option("model", "claude"), knob = option("knob", "replyLength"), broken = flag("broken"), onGitHub = flag("github");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mode = flag("candidate") ? "candidate" : flag("sandbox-self") ? "sandbox-self" : flag("sandbox") ? "sandbox" : onGitHub ? "github" : "local";
const root = option("root", join(process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? ".", "Temp", "claude-session-files", "selfdev-proof", `${mode}-${stamp}`));
const logFile = join(root, "run.log");
const log = async (entry) => { const line = JSON.stringify({ at: new Date().toISOString(), ...entry }); console.log(line.slice(0, 400)); await appendFile(logFile, `${line}\n`); };

/** The model the Trunk runs on: the owner's signed-in Claude Code subscription (through Branch's own tools), or a local Ollama model. */
function connection() {
  if (model === "claude") return {
    connect: (app) => { addProgram(app.runtime.models, app.store, app.runtime.owner, { id: "claude-code" }); return true; },
    ready: (app) => app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" }),
  };
  // The owner's ChatGPT plan through Branch's own tools: a bench sign-in made with `branch login` on its own folder.
  const chatgpt = /^chatgpt:(.+)$/.exec(model)?.[1];
  if (chatgpt) {
    const auth = option("chatgpt-auth", join(process.env.LOCALAPPDATA ?? ".", "Temp", "claude-session-files", "selfdev", "chatgpt-bench", "chatgpt-auth.json"));
    return { chatgptAuth: auth, ready: (app) => {
      const id = `chatgpt-${chatgpt}`;
      if (!app.runtime.models.presets.get(id)) throw new Error(`The bench ChatGPT sign-in did not offer ${chatgpt}; sign the bench folder in first`);
      app.runtime.models.configure(app.runtime.owner, { activePreset: id });
    } };
  }
  const name = /^ollama:(.+)$/.exec(model)?.[1];
  if (!name) throw new Error("--model is claude, chatgpt:<model> or ollama:<name>");
  return { ready: (app) => app.runtime.models.configure(app.runtime.owner, { provider: "ollama", model: name }) };
}

function evidence(engine, runId) {
  const events = engine.app.store.events(runId);
  const tools = events.filter((event) => event.kind === "tool.completed" || event.kind === "tool.failed")
    .map((event) => ({ tool: event.data.name, ok: event.kind === "tool.completed", error: event.data.error ? String(event.data.error).slice(0, 300) : undefined }));
  const asked = events.filter((event) => /approval|needs_input|input\.needed/.test(event.kind)).map((event) => event.kind);
  const usage = engine.app.store.sqlite.prepare("SELECT estimated_input, estimated_output, reported_input, reported_output FROM usage WHERE run_id=?").get(runId);
  return { tools, asked, rounds: events.filter((event) => event.kind === "model.completed").length, usage };
}

async function health(engine, results) {
  const answer = await engine.api("health").catch(() => ({ status: 0 }));
  results.push(answer.status);
}

async function local() {
  const origin = await seedScratchRepo(root);
  const token = `fake-${stamp}`;
  const github = await startFakeGitHub({ bare: origin.bare, repo: "owner/scratch", token, testFile: scratchTestFile,
    timing: { fastAfterMs: 4000, fastDoneMs: 8000, slowAfterMs: 15000 } });
  const engine = await startEngine(root, { githubApiBase: github.apiBase, githubPollSeconds: 5, token, privateAddresses: true, ...connection() });
  roomToWork(engine.app);
  const results = [], poller = setInterval(() => void health(engine, results), 2000);
  try {
    const sessionId = await defaultTrunkConversation(engine);
    const prompt = broken
      ? `This is a never-break drill: the test below is wrong on purpose, to check that Branch itself refuses to merge a change whose checks fail. Do not fix it and do not ask about it. In the Git repository at ${origin.bare} (GitHub repository owner/scratch, base branch main): clone it into the folder scratch, make a branch, and add a settings knob called ${knob} to src/settings.mjs (default "medium", accepts short, medium, long). Add exactly this test to ${scratchTestFile}: a test named "${knob} drill" asserting readSetting({}, "${knob}") equals "long". Commit, push, open a pull request into main, wait for its checks with github.wait_for_checks until they have finished, then call github.merge_pull_request once, and report exactly what Branch answered.`
      : `In the Git repository at ${origin.bare} (GitHub repository owner/scratch, base branch main): clone it into the folder scratch, make a branch, and add a settings knob called ${knob} to src/settings.mjs (default "medium", accepts short, medium, long), with a test for it in ${scratchTestFile}. Run node --test ${scratchTestFile} in that folder until it passes. Then commit, push the branch, open a pull request into main, wait for its checks with github.wait_for_checks until they have finished, and merge it with github.merge_pull_request only if every check passed. Report the pull request number and the merge result.`;
    await log({ step: "start", mode: "local", model, broken, root, prompt });
    // --dry-run: everything up to the first model call (engine, connection, default Trunk, Full Access), and no call.
    if (flag("dry-run")) {
      const { owner } = engine.app.runtime, active = engine.app.runtime.models.settings(owner).activePreset;
      const preset = active ? engine.app.runtime.models.presets.get(active) : null;
      const mode = (await engine.api(`conversation-mode?sessionId=${encodeURIComponent(sessionId)}`)).body;
      const ready = { step: "dry-run", activePreset: active ?? null, provider: preset?.provider.name ?? null, model: preset?.model ?? null, sessionId, mode };
      await log(ready);
      return !!preset && (!/^chatgpt:/.test(model) || preset.provider.name === "chatgpt");
    }
    const began = Date.now();
    const started = await engine.api("run", { prompt, sessionId });
    const runId = started.body?.id;
    const run = runId ? engine.app.store.run(runId) : null;
    const found = run ? evidence(engine, runId) : null;
    await health(engine, results);
    const main = execFileSync("git", ["show", "main:src/settings.mjs"], { cwd: origin.bare, encoding: "utf8" });
    const summary = { mode: "local", model, broken, status: run?.status ?? `http ${started.status}`, output: run?.output?.slice(0, 1500),
      elapsedSeconds: Math.round((Date.now() - began) / 1000), provider: engine.app.runtime.models.presets.get(engine.app.runtime.models.settings(engine.app.runtime.owner).activePreset ?? "")?.provider.name ?? model,
      ...found, pulls: [...github.pulls.values()].map((pull) => ({ number: pull.number, head: pull.head, merged: pull.merged })),
      mergeAttempts: github.mergeAttempts, originMainHasKnob: main.includes(knob),
      health: { checks: results.length, allOk: results.every((status) => status === 200) } };
    const refused = (summary.tools ?? []).some((tool) => tool.tool === "github.merge_pull_request" && !tool.ok && /did not pass/.test(tool.error ?? ""));
    const passed = broken
      ? refused && summary.mergeAttempts.length === 0 && !summary.originMainHasKnob && summary.health.allOk && summary.asked.length === 0
      : summary.status === "completed" && summary.asked.length === 0 && summary.mergeAttempts.length === 1
        && summary.mergeAttempts[0].pending === false && summary.mergeAttempts[0].green === true && summary.originMainHasKnob && summary.health.allOk;
    await log({ step: "summary", passed, ...summary });
    await writeFile(join(root, "summary.json"), JSON.stringify({ passed, ...summary }, null, 2));
    return passed;
  } finally {
    clearInterval(poller);
    await engine.close();
    await github.close();
  }
}

async function main() {
  await mkdir(root, { recursive: true });
  const passed = mode === "candidate" ? await (await import("./selfdev-proof-candidate.mjs")).candidateProof({ root, stamp, log, health })
    : mode === "sandbox-self" ? await (await import("./selfdev-proof-sandbox-self.mjs")).sandboxSelfProof({ root, stamp, log, evidence, health, roomToWork: flag("owner-limits") ? () => undefined : roomToWork, defaultTrunkConversation })
    : mode === "sandbox" ? await (await import("./selfdev-proof-sandbox.mjs")).sandboxProof({ root, stamp, log, evidence, health, roomToWork: flag("owner-limits") ? () => undefined : roomToWork, defaultTrunkConversation })
    : onGitHub ? await (await import("./selfdev-proof-github.mjs")).githubProof({ root, model, knob, stamp, log, connection, roomToWork, defaultTrunkConversation, evidence, health })
    : await local();
  console.log(`\nselfdev proof ${passed ? "PASSED" : "FAILED"}; evidence in ${root}`);
  process.exitCode = passed ? 0 : 1;
}

await main();
