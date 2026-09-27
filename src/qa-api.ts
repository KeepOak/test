import { summaryLine } from "./evaluation-runner.js";
import { errorText } from "./request-errors.js";
import {
  acceptScenario, draftScenario, listScenarios, qaMode, qaOff, qaSettings, rejectScenario, runScenario, saveQaSettings,
  type QaDeps,
} from "./qa-scenarios.js";

/**
 * w911 (A1753): the routes and the terminal command for page test scenarios, so src/server.ts and
 * src/cli.ts each gain one short hook.
 *
 *   GET/POST /api/qa/settings                  the switch (always answers, so it can be turned on)
 *   GET      /api/qa/scenarios                 every scenario, drafts and accepted
 *   POST     /api/qa/scenarios                 a new draft from { name, target, steps }
 *   POST     /api/qa/scenarios/:id/accept      saves the draft as a suite of the owner's own
 *   POST     /api/qa/scenarios/:id/reject      deletes it
 *   POST     /api/qa/scenarios/:id/run         runs an accepted one through the suite runner
 */
const oneScenario = /^\/api\/qa\/scenarios\/([a-f0-9-]{36})\/(accept|reject|run)$/;
export const handlesQa = (path: string): boolean =>
  path === "/api/qa/settings" || path === "/api/qa/scenarios" || oneScenario.test(path);

export async function qaApi(deps: QaDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (path === "/api/qa/settings") {
    if (method === "POST") saveQaSettings(deps.store, deps.owner, await body());
    return { settings: qaSettings(deps.store, deps.owner) };
  }
  if (qaMode(deps.store, deps.owner) === "off") throw new Error(qaOff);
  if (path === "/api/qa/scenarios") {
    if (method === "POST") return { scenario: await draftScenario(deps, await body()) };
    return { scenarios: listScenarios(deps) };
  }
  const [, id, action] = oneScenario.exec(path) ?? [];
  if (method !== "POST" || !id) throw new Error("That is not something page test scenarios can do");
  if (action === "accept") return { scenario: acceptScenario(deps, id) };
  if (action === "reject") return rejectScenario(deps, id);
  return { result: await runScenario(deps, id) };
}

/** `branch qa list` and `branch qa run <id>`. Answers the exit code. */
export async function qaCommand(deps: QaDeps, args: string[], write: (line: string) => void): Promise<number> {
  if (qaMode(deps.store, deps.owner) === "off") { write(qaOff); return 1; }
  const [action, id] = args;
  if (action === "list") {
    const all = listScenarios(deps);
    if (!all.length) write("No page test scenarios yet.");
    for (const s of all) write(`${s.id}  ${s.status === "draft" ? "draft   " : "accepted"}  ${s.name}  (${s.target})`);
    return 0;
  }
  if (action === "run" && id) {
    try {
      const result = await runScenario(deps, id);
      write(summaryLine(result));
      for (const task of result.tasks) for (const reason of task.reasons ?? []) write(`  ${reason}`);
      return result.summary.passed === result.summary.total ? 0 : 1;
    } catch (error) {
      write(errorText(error));
      return 1;
    }
  }
  write("Use: branch qa list | branch qa run <id>");
  return 1;
}

/** The pieces of the app the scenarios use, gathered once for the server and the terminal. */
export interface QaApp {
  store: QaDeps["store"];
  runtime: { owner: string; workspace: string; run(options: { prompt: string; permissions: string[]; budget: { maxSteps: number; maxTokens: number } }): Promise<{ status: string; output: string }> };
  evaluationSuites: { run(input: unknown): ReturnType<QaDeps["runSuite"]> };
  web: { policy: { assertAllowed(target: URL, what?: string): Promise<void> } };
}
export function qaDeps(app: QaApp): QaDeps {
  return {
    store: app.store, owner: app.runtime.owner, workspace: app.runtime.workspace,
    // A tool-less question with a small budget of its own, as a rubric grader asks.
    ask: async (prompt) => {
      const run = await app.runtime.run({ prompt, permissions: [], budget: { maxSteps: 2, maxTokens: 20000 } });
      if (run.status !== "completed") throw new Error(`The draft could not be written (${run.status})`);
      return run.output;
    },
    runSuite: (input) => app.evaluationSuites.run(input),
    checkAddress: (url) => app.web.policy.assertAllowed(url, "page address"),
  };
}
