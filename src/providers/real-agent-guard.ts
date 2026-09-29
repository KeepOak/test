import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { standInProgram } from "../integrations/real-screen-guard.js";

/**
 * owner-dm-signin: nothing run by the test runner may start this computer's real Claude Code or Codex, which answer
 * through the owner's own sign-in (a test once did, twice, before its fixture swapped the spawn). The places Branch
 * starts either program with its own spawn (src/providers/cli-agent.ts, claude-subscription-process.ts and
 * src/asks/codex-app-server.ts) ask here first; a test that hands in its own spawn (fakeClaudeAccounts,
 * deps.spawnAgent, a stand-in start) never reaches them.
 *
 * As with the real screen (src/integrations/real-screen-guard.ts), the test runner's NODE_TEST_CONTEXT turns it on and
 * Branch itself never runs with it, so it can only add refusals. Still allowed under it: a stand-in program a test wrote
 * into the temporary folder, a name with no program behind it (the "not installed" answer stays testable), and a person
 * opting in on this computer with BRANCH_REAL_AGENT_TESTS=1.
 */
export const realAgentTestRefusal =
  "A test tried to start this computer's real Claude Code or Codex, which answers through the owner's own sign-in. " +
  "Hand the test a stand-in spawn (fakeClaudeAccounts or deps.spawnAgent), or set BRANCH_REAL_AGENT_TESTS=1.";

const guarded = /^(claude|codex)(\.(cmd|exe|ps1|js))?$/i;

/** The program a bare name starts, looked up on PATH as the system would, or null when there is none. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const endings = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean))
    for (const ending of endings) { const path = join(folder, name + ending); if (existsSync(path)) return path; }
  return null;
}

/** Why starting `command` is refused here, or null when it may start. */
export function realAgentRefusal(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!process.env.NODE_TEST_CONTEXT || process.env.BRANCH_REAL_AGENT_TESTS === "1") return null;
  if (!guarded.test(basename(command))) return null;
  const program = isAbsolute(command) ? (existsSync(command) ? command : null) : onPath(command, env);
  return program && !standInProgram(program) ? realAgentTestRefusal : null;
}
export function assertRealAgentAllowed(command: string, env: NodeJS.ProcessEnv = process.env): void {
  const refused = realAgentRefusal(command, env);
  if (refused) throw new Error(refused);
}
