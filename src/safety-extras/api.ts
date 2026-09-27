import { z } from "zod";
import { errorText } from "../request-errors.js";
import { keyAnswerRefusal, shortLivedKeyMark } from "../key-context.js";
import { requireBoundSession } from "../people/access.js";
import type { Runtime } from "../runtime.js";
import {
  beginCodeSetup, codeApprovalsView, codesResting, confirmWithCode, finishCodeSetup, removeCodeSetup, requireCodeToLoosen,
  restingRefusal, saveCodeSetup,
} from "./code-approvals.js";
import { findingSentence, scanCommand } from "./command-scan.js";
import { engageStop, releaseStop, stopState } from "./emergency-stop.js";
import type { SafetyExtras } from "./index.js";
import { SafetyPartSchema, safetyLabels } from "./settings.js";
import { byCard, inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48
import { lockdownActive } from "../lockdown.js";
import { looseningRefusal, withoutConfirm } from "../policy-change-guard.js";

/**
 * mac7/r17-g: the owner's routes under /api/safety-extras/. They sit behind the same key and host
 * rules as everything else. A short-lived key may only read, check the activity chain, press the
 * emergency stop (never let it go) and type an authenticator code for a question it may answer
 * (src/short-lived-keys.ts); every other change is the owner's.
 */
export const handlesSafetyPath = (path: string): boolean => path === "/api/safety-extras" || path.startsWith("/api/safety-extras/");

export class SafetyHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SafetyHttpDeps {
  extras: SafetyExtras;
  runtime: Runtime;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
}

const SwitchSchema = z.object({ part: SafetyPartSchema, mode: z.enum(["off", "when-needed", "on"]), code: z.string().max(12).optional() }).strict();
const modeOrder = ["off", "when-needed", "on"] as const;
const ConfirmSchema = z.object({ sessionId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{32}$/).optional(), code: z.string().max(12) }).strict();
const CodeSchema = z.object({ code: z.string().max(12) }).strict();
const NameSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();

async function overview(deps: SafetyHttpDeps): Promise<unknown> {
  const { store, owner } = deps.runtime;
  return { modes: deps.extras.modes(), labels: safetyLabels, stop: stopState(store, owner),
    codes: codeApprovalsView(store, owner), chain: deps.extras.chain.summary(owner),
    wasm: await deps.extras.wasm.list() };
}

/** Integration review: taking the codes' guard away needs a good code while it is on (code-approvals.ts). */
async function loosening(deps: SafetyHttpDeps, code: unknown): Promise<void> {
  try { await requireCodeToLoosen(deps.runtime.store, deps.runtime.owner, code); }
  catch (error) { throw new SafetyHttpError(401, errorText(error)); }
}
/** A body's `code`, taken out so the rest can be read by its own strict shape. */
function withoutCode(body: unknown): { code: unknown; rest: Record<string, unknown> } {
  const { code, ...rest } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { code, rest };
}
const wrongCode = (store: SafetyHttpDeps["runtime"]["store"], owner: string, fallback: string): string =>
  (codesResting(store, owner) ? restingRefusal : fallback);

async function codesRoute(deps: SafetyHttpDeps, path: string): Promise<unknown> {
  const { store, owner } = deps.runtime;
  if (path === "/api/safety-extras/codes") {
    const { code, rest } = withoutCode(await deps.readBody());
    await loosening(deps, code);
    return { codes: saveCodeSetup(store, owner, rest) };
  }
  if (path === "/api/safety-extras/codes/begin") {
    const { code } = z.object({ code: z.string().max(12).optional() }).strict().parse((await deps.readBody()) ?? {});
    await loosening(deps, code);
    return beginCodeSetup(store, owner);
  }
  if (path === "/api/safety-extras/codes/finish") {
    const { code } = CodeSchema.parse(await deps.readBody());
    if (!(await finishCodeSetup(store, owner, code))) throw new SafetyHttpError(400, wrongCode(store, owner, "That code did not match. Check the time on your phone and try the next code."));
    return { codes: codeApprovalsView(store, owner) };
  }
  if (path === "/api/safety-extras/codes/remove") {
    const { code } = z.object({ code: z.string().max(12).optional() }).strict().parse((await deps.readBody()) ?? {});
    await loosening(deps, code);
    removeCodeSetup(store, owner);
    return { codes: codeApprovalsView(store, owner) };
  }
  if (path === "/api/safety-extras/codes/confirm") return confirmRoute(deps);
  return undefined;
}

async function confirmRoute(deps: SafetyHttpDeps): Promise<unknown> {
  const { store, owner } = deps.runtime;
  const input = ConfirmSchema.parse(await deps.readBody());
  const asked = deps.runtime.approvals.questionFor(input.sessionId, input.fingerprint);
  if (!asked) throw new SafetyHttpError(404, "Nothing in this conversation is waiting for your answer.");
  // A short-lived key types a code only for a question it may answer, exactly as /api/policy/approve holds it.
  try { requireBoundSession(shortLivedKeyMark().sessionId, input.sessionId); } catch (error) { throw new SafetyHttpError(401, errorText(error)); }
  const keyRefusal = keyAnswerRefusal(store, asked.runId);
  if (keyRefusal) throw new SafetyHttpError(401, keyRefusal);
  // Integration review: the code is bound to the question that is waiting, whether or not its fingerprint was sent.
  if (!(await confirmWithCode(store, owner, input.sessionId, asked.fingerprint, input.code)))
    throw new SafetyHttpError(400, wrongCode(store, owner, "That code did not match, or it was already used. Wait for the next code."));
  return { confirmed: true };
}

async function wasmRoute(deps: SafetyHttpDeps, path: string): Promise<unknown> {
  const { wasm } = deps.extras;
  if (path === "/api/safety-extras/wasm") return { addOn: await wasm.install(await deps.readBody()) };
  if (path === "/api/safety-extras/wasm/remove") return { removed: await wasm.remove(NameSchema.parse(await deps.readBody()).name) };
  if (path === "/api/safety-extras/wasm/run") return { run: await deps.runtime.executeTool("wasm.run", await deps.readBody(), { mode: "owner" }) };
  return undefined;
}

async function changeRoute(deps: SafetyHttpDeps, path: string): Promise<unknown> {
  const { store, owner } = deps.runtime;
  if (path === "/api/safety-extras/switch") {
    const { part, mode, code } = SwitchSchema.parse(await deps.readBody());
    if (part === "code-approvals" && modeOrder.indexOf(mode) < modeOrder.indexOf(deps.extras.modes()[part])) await loosening(deps, code);
    return { part, mode: recordedWrite(store, owner, byCard(`safety-${part}`), inCatalogue(`safety-${part}`), () => deps.extras.setMode(part, { mode })) };
  }
  if (path === "/api/safety-extras/stop") return { stop: engageStop(store, owner, await deps.readBody()) };
  if (path === "/api/safety-extras/stop/release") {
    // Letting the stop go needs the owner's yes, and never under Lockdown (src/policy-change-guard.ts); pressing it never does.
    const { confirmLoosening, input } = withoutConfirm(await deps.readBody());
    const looser = stopState(store, owner).engaged ? "the emergency stop would be let go, and stopped work could start again" : null;
    const refusal = looseningRefusal(looser, confirmLoosening, lockdownActive(store, owner));
    if (refusal) throw new SafetyHttpError(409, refusal);
    try { return { stop: await releaseStop(store, owner, input) }; }
    catch (error) { throw error instanceof z.ZodError ? error : new SafetyHttpError(401, errorText(error)); }
  }
  if (path === "/api/safety-extras/activity/verify") {
    const { tip } = z.object({ tip: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict().parse(await deps.readBody() ?? {});
    return { check: deps.extras.chain.verify(owner, tip) };
  }
  if (path === "/api/safety-extras/scan") {
    const { command } = z.object({ command: z.string().max(8000) }).strict().parse(await deps.readBody());
    const findings = scanCommand(command);
    return { findings, sentence: findings.length ? findingSentence(findings) : null };
  }
  return (await codesRoute(deps, path)) ?? wasmRoute(deps, path);
}

export async function safetyApi(deps: SafetyHttpDeps, path: string): Promise<unknown> {
  if (deps.method === "GET") {
    if (path === "/api/safety-extras") return overview(deps);
    if (path === "/api/safety-extras/activity") {
      const limit = Number(deps.query.get("limit") ?? 100);
      return { entries: deps.extras.chain.list(deps.runtime.owner, Number.isFinite(limit) ? limit : 100) };
    }
    throw new SafetyHttpError(404, "Not found");
  }
  if (deps.method !== "POST") throw new SafetyHttpError(405, "Use GET or POST");
  const answer = await changeRoute(deps, path);
  if (answer === undefined) throw new SafetyHttpError(404, "Not found");
  return answer;
}
