import type { Client } from "./cli-attach.js";
import { loadGatewayConfig, saveGatewayConfig } from "./never-break/gateway-config.js";
import {
  checkedContrast, checkedLanguage, confirmWords, lockdownLines, lockdownSwitch, modeOf, modelAction, modelLines, modelUsedLine,
  themeLine, themeListLines,
} from "./terminal-cli.js";
import { presetLinesFor, presetWords } from "./terminal-commands.js";
import { loadThemeCatalogue, lookLanguage, type Look } from "./terminal-theme.js";
import { loadWords, type Words } from "./terminal-words.js";

/**
 * B5 (CL-04): the commands that change something, beside a Branch that is already open.
 *
 * Only one Branch may write to the saved work at a time, so these never open the database. They ask
 * the Branch that is running, through the same local key and the same routes the window uses, so every
 * guard the window meets is met here too: a household profile switched on at the window is refused what
 * the window refuses it, Lockdown is changed only where the engine allows it, and an answer to a waiting
 * question is exactly the window's own answer — once, bound to the request's fingerprint. Nothing here
 * decides who may do what; the engine does, and its refusal is printed as it says it.
 */
export interface EngineIo { json: boolean; env: NodeJS.ProcessEnv; write(line: string): void }

interface LockdownView { on: boolean; since: string | null; effects: string[] }
interface PresetView { id: string; label: string; description: string }
interface WaitingView { runId: string; sessionId: string; tool: string; target: string; label: string; fingerprint?: string; bytes?: string }
interface PolicyView { policy: { preset: string } | null; presets: PresetView[]; waiting: WaitingView[] }
interface ModelsView { presets: { id: string; name: string; model: string }[]; activePreset?: string | null; defaultPreset: string }
interface StateView { models: ModelsView; modelNeeded: string | null; preferences: Record<string, unknown> }

/** The running Branch's saved language, or this terminal's own when it follows the computer. */
export async function engineWords(client: Client, env: NodeJS.ProcessEnv): Promise<Words> {
  const look = await client.get<Look>("/api/look").catch(() => null);
  return loadWords(lookLanguage(look ?? ({ language: "auto" } as Look), env));
}
const say = (io: EngineIo, lines: string[]): void => lines.forEach((line) => io.write(line));

/** `branch lockdown [on|off]`: read, or switched where the engine allows (never by a key or a household profile). */
export async function engineLockdown(client: Client, args: string[], io: EngineIo): Promise<void> {
  const on = lockdownSwitch(args);
  const state = on === null ? await client.get<LockdownView>("/api/lockdown") : await client.post<LockdownView>("/api/lockdown", { on });
  if (io.json) return io.write(JSON.stringify(state, null, 2));
  say(io, lockdownLines(state, await engineWords(client, io.env)));
}

/**
 * `branch permissions [preset] [confirm]`. POST /api/policy refuses under Lockdown and asks for the
 * owner's separate yes before anything less careful; its words name the window's tick box, so the
 * command's own way of saying yes is put in their place.
 */
export async function enginePermissions(client: Client, args: string[], io: EngineIo): Promise<void> {
  const view = await client.get<PolicyView>("/api/policy");
  if (!args.length) {
    if (io.json) return io.write(JSON.stringify({ policy: view.policy, presets: view.presets }, null, 2));
    return say(io, presetLinesFor(view.presets, view.policy?.preset, await engineWords(client, io.env)));
  }
  const [name = "", word, ...rest] = args;
  if (!view.presets.some((preset) => preset.id === name) || (word !== undefined && word !== "confirm") || rest.length)
    throw new Error(`Pick one of: ${view.presets.map((preset) => preset.id).join(", ")}`);
  const words = await engineWords(client, io.env);
  const saved = await client.post<{ policy: { preset: string } }>("/api/policy", { preset: name, ...(word === "confirm" ? { confirmLoosening: true } : {}) })
    .catch((error: Error) => { throw new Error(error.message.replace(/Tick "[^"]*" to go ahead\./, confirmWords(words, name))); });
  if (io.json) return io.write(JSON.stringify(saved, null, 2));
  const chosen = view.presets.find((preset) => preset.id === saved.policy.preset) ?? { id: saved.policy.preset };
  io.write(`[${words.t("settings-kit.name.policy", "When to check with me")}: ${presetWords(chosen, words).label}]`);
}

/** `branch model [list | use <id>]`: which model new conversations start with, as Settings › Models sets it. */
export async function engineModel(client: Client, args: string[], io: EngineIo): Promise<void> {
  const action = modelAction(args);
  const state = await client.get<StateView>("/api/state");
  const words = await engineWords(client, io.env);
  if (action) {
    const preset = state.models.presets.find((entry) => entry.id === action.use);
    if (!preset) throw new Error(`There is no model called ${action.use}. \`branch model\` lists them.`);
    await client.post("/api/models", { activePreset: action.use });
    return io.write(modelUsedLine(preset.name, words));
  }
  if (io.json) return io.write(JSON.stringify(state.models, null, 2));
  say(io, modelLines(state.models, state.modelNeeded === null, words));
}

/**
 * `branch theme [...]`, shared with the window. Light and dark live in the window's preferences, and
 * POST /api/preferences replaces the whole object, so the saved preferences are read first and only
 * the two fields that mean light, dark or following the computer are changed.
 */
export async function engineTheme(client: Client, args: string[], io: EngineIo): Promise<void> {
  const word = args[0] ?? "list";
  let look = await client.get<Look>("/api/look");
  if (word === "light" || word === "dark" || word === "follow") {
    const { preferences } = await client.get<StateView>("/api/state");
    await client.post("/api/preferences", word === "follow" ? { ...preferences, followSystem: true }
      : { ...preferences, followSystem: false, appearance: word === "light" ? "daylight" : "forest" });
  } else if (word === "contrast") look = await client.post<Look>("/api/look", { contrast: checkedContrast(args[1], look.contrast) });
  else if (word === "language") look = await client.post<Look>("/api/look", { language: checkedLanguage(args[1], await engineWords(client, io.env)) });
  else if (word !== "list") look = await client.post<Look>("/api/look", { theme: word });
  if (io.json) return io.write(JSON.stringify(look, null, 2));
  const table = await loadThemeCatalogue();
  if (word === "list") say(io, themeListLines(table.THEMES, look.theme));
  const { preferences } = await client.get<StateView>("/api/state");
  const name = table.THEMES.find((theme) => theme[0] === look.theme)?.[1] ?? look.theme;
  io.write(themeLine(look, name, modeOf(preferences), await engineWords(client, io.env)));
}

/**
 * `branch gateway [on|off]`: the gateway that keeps Branch running, as Settings › Gateway switches it.
 * It is on or off; a saved "when needed" from before reads as on, which is what the gateway does with it.
 * With Branch open the change goes through its door (the owner's alone); with it closed, the gateway's
 * own file is written, which is all the switch is. It takes effect the next time Branch starts.
 */
export async function gatewayCommand(client: Client | null, dataDir: string, args: string[], io: EngineIo): Promise<void> {
  const words = client ? await engineWords(client, io.env) : loadWords(lookLanguage({ language: "auto" } as Look, io.env));
  const want = args[0];
  if ((want !== undefined && want !== "on" && want !== "off") || args.length > 1)
    throw new Error(words.t("terminal.cli.gateway.choose", "Choose on or off: branch gateway on"));
  let mode: string;
  if (client) mode = (want ? await client.post<{ mode: string }>("/api/never-break", { mode: want }) : await client.get<{ mode: string }>("/api/never-break")).mode;
  else {
    const { config } = await loadGatewayConfig(dataDir);
    if (want) await saveGatewayConfig(dataDir, { ...config, mode: want });
    mode = want ?? config.mode;
  }
  const on = mode !== "off";
  if (io.json) return io.write(JSON.stringify({ on, ...(want ? { changed: true } : {}) }));
  io.write(on ? words.t("window.settings.gateway.the-gateway-is-on", "The gateway is on") : words.t("window.settings.gateway.the-gateway-is-off", "The gateway is off"));
  if (want) io.write(words.t("never-break.saved", "Saved. This takes effect the next time Branch starts."));
}

export interface ApproveFlags { json: boolean; request?: string; code?: string }
const exactRequest = (asked: WaitingView): boolean => /^[a-f0-9]{32}$/.test(asked.fingerprint ?? "");

/** The one waiting question this answer is for: of this task, that this terminal may answer, named exactly. */
function questionFor(waiting: WaitingView[], id: string, flags: ApproveFlags, words: Words): WaitingView {
  const theirs = waiting.filter((asked) => asked.runId === id || asked.sessionId === id);
  const chosen = flags.request ? theirs.filter((asked) => (asked.fingerprint ?? "").startsWith(flags.request!)) : theirs;
  if (!chosen.length)
    throw new Error(words.t("terminal.cli.approve.nothing", "Nothing in that task is waiting for your answer. `branch status` lists the ones waiting."));
  if (chosen.length > 1)
    throw new Error([words.t("terminal.cli.approve.several", "That task is waiting on more than one question. Name one with --request and its code:"),
      ...chosen.map((asked) => `  ${(asked.fingerprint ?? "-").slice(0, 8)}  ${asked.label}`)].join("\n"));
  const asked = chosen[0]!;
  // As the window does (Q257): a question with no fingerprint is not answered from here, because a yes
  // without one is not bound to what was shown.
  if (!exactRequest(asked))
    throw new Error(words.t("terminal.cli.approve.notExact", "That question is not tied to an exact request, so answer it in the app window."));
  return asked;
}

/**
 * `branch approve <task id> yes|no` beside an open Branch: the question the task is waiting on now,
 * answered just this once, exactly as the window's Allow and Deny answer it (POST /api/policy/approve,
 * remember "never", the fingerprint of the request shown, carry on). Never a standing rule from here.
 * Which questions are listed at all — the owner's, a household person's own, a key's own tasks' — and
 * whether this answer may be given is the engine's rule, and its refusal is printed as it says it.
 */
export async function engineApprove(client: Client, args: string[], flags: ApproveFlags, io: EngineIo): Promise<void> {
  const [id, answer] = args;
  if (!id || !answer || args.length > 2) throw new Error("Answer a task: branch approve <task id> yes|no");
  const decision = /^(y|yes|allow)$/i.test(answer) ? "allow" : /^(n|no|deny)$/i.test(answer) ? "deny" : null;
  if (!decision) throw new Error("Answer yes or no: branch approve <task id> yes");
  const words = await engineWords(client, io.env);
  const asked = questionFor((await client.get<PolicyView>("/api/policy")).waiting, id, flags, words);
  const said = await client.post<{ task?: string; standingNote?: string }>("/api/policy/approve", {
    sessionId: asked.sessionId, decision, remember: "never", fingerprint: asked.fingerprint, carryOn: true,
    ...(flags.code ? { code: flags.code } : {}),
  });
  if (io.json) return io.write(JSON.stringify({ runId: asked.runId, sessionId: asked.sessionId, decision, label: asked.label, ...said }));
  io.write(decision === "allow" ? words.t("terminal.cli.approve.allowed", "Allowed, just this once: {label}", { label: asked.label })
    : words.t("terminal.cli.approve.refused", "Refused: {label}", { label: asked.label }));
  if (asked.bytes) io.write(`  ${asked.bytes.length > 300 ? `${asked.bytes.slice(0, 299)}…` : asked.bytes}`);
  if (said.standingNote) io.write(said.standingNote);
  if (said.task === "carrying-on") io.write(words.t("terminal.cli.approve.carriesOn", "The task carries on."));
}
