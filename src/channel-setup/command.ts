import type { FeatureMode } from "../feature-switches.js";
import { cleanServer, scrub } from "./check.js";
import { createLink, recipeFor, recipes, type Recipe } from "./recipes.js";
import { isInstalled, managerName, openCommand, planInstall, planLine, type Probe, type Runner } from "./platform.js";

/**
 * `branch connect <chat app>`: gets the official app, opens the page that makes the bot, takes the
 * token without showing it, checks it, saves it and, if the owner says so, switches the app on.
 * Nothing is installed or switched on without a yes typed here. Every outside effect goes through
 * `io` (the terminal, programs, links) or `backend` (the running Branch or this launch's own).
 */
export interface ConnectIo {
  platform: NodeJS.Platform;
  runner: Runner;
  probe: Probe;
  write(line: string): void;
  ask(question: string): Promise<string>;
  /** Reads a line without echoing it. Only offered when `canHide` is true. */
  askHidden(question: string): Promise<string>;
  canHide: boolean;
  /** A one-time page on this computer for pasting, when the terminal cannot hide what is typed. */
  pastePage?(recipe: Recipe): Promise<{ url: string; values: Promise<Record<string, string>> }>;
  sleep(ms: number): Promise<void>;
  /** How long to wait for an app to finish installing. */
  waitMs?: number;
  /** The clock the wait is measured against (tests hand in their own). */
  now?(): number;
}
export interface ConnectBackend {
  mode(): Promise<FeatureMode>;
  setMode(mode: FeatureMode): Promise<void>;
  save(id: string, values: Record<string, string>, enable: FeatureMode | undefined): Promise<SaveAnswer>;
  /** Only when the running Branch can take the code the bot sent. */
  approvePairing?(code: string): Promise<void>;
}
export interface SaveAnswer {
  saved: string[]; checked: boolean | null; botName: string | null; checkNote: string | null;
  switched: FeatureMode | null; connectNote: string | null; entry: string | null; pairing: string | null;
  /** Whether the app connected to the running Branch just now (null when not tried: the Telegram card, or Branch closed). */
  connected?: boolean | null;
}

const yes = (answer: string): boolean => /^\s*(y|yes|o|oui)\s*$/i.test(answer);

async function open(io: ConnectIo, url: string): Promise<void> {
  let opener: { command: string; args: string[] };
  // A link that is not a plain official one (an odd server address) is said, never opened.
  try { opener = openCommand(url, io.platform); }
  catch (error) { io.write(error instanceof Error ? error.message : String(error)); return; }
  await io.runner.run(opener.command, opener.args, { timeoutMs: 15_000 }).catch(() => undefined);
}

async function switchedOn(io: ConnectIo, backend: ConnectBackend): Promise<boolean> {
  if ((await backend.mode()) !== "off") return true;
  io.write("Setting up chat apps from the terminal is switched off (it ships off).");
  if (!yes(await io.ask("Switch it to \"when needed\" now? [y/N] "))) return false;
  await backend.setMode("when-needed");
  return true;
}

/** Installs with a yes, or opens the vendor's page. Answers whether the app is (probably) there now. */
async function getTheApp(io: ConnectIo, recipe: Recipe): Promise<boolean | null> {
  const app = recipe.app;
  if (!app) { io.write(recipe.noApp ?? "There is nothing to install."); return null; }
  if (await isInstalled(recipe, io.platform, io.probe, io.runner)) { io.write(`${app.name} is already installed.`); return true; }
  const plan = await planInstall(recipe, io.platform, io.probe);
  if (plan.kind === "package") {
    io.write(`This installs ${app.name}, the official app, with ${managerName(plan.manager)}:`);
    io.write(`  ${planLine(plan)}`);
    if (plan.sudo) io.write("It runs with sudo, so your computer may ask for your password.");
    if (!yes(await io.ask("Install it? [y/N] "))) { io.write("Nothing was installed."); return null; }
    const done = await io.runner.run(plan.command, plan.args, { interactive: true }).catch(() => ({ code: 1, stdout: "" }));
    if (done.code === 0) return waitForApp(io, recipe);
    io.write(`${managerName(plan.manager)} did not finish, so the official download page opens instead.`);
  } else if (plan.kind === "download") io.write(plan.reason);
  if (!yes(await io.ask(`Open ${app.name}'s official download page? [y/N] `))) return null;
  await open(io, app.download);
  return waitForApp(io, recipe);
}

/**
 * Waits a bounded time for the app to appear; when this computer cannot tell, asks instead. The limit
 * holds by the clock as well as by the pauses, since each look (winget list) can itself take 30 seconds.
 */
async function waitForApp(io: ConnectIo, recipe: Recipe): Promise<boolean | null> {
  const limit = io.waitMs ?? 10 * 60_000;
  const now = io.now ?? Date.now;
  const started = now();
  const first = await isInstalled(recipe, io.platform, io.probe, io.runner);
  if (first === null) { await io.ask(`Press Enter once ${recipe.app!.name} is installed.`); return null; }
  if (first) return true;
  io.write(`Waiting for ${recipe.app!.name} to finish installing (up to ${Math.round(limit / 60_000)} minutes).`);
  for (let waited = 0; waited < limit && now() - started < limit; waited += 5_000) {
    await io.sleep(5_000);
    if (await isInstalled(recipe, io.platform, io.probe, io.runner)) return true;
  }
  io.write("It is not there yet. Carry on once it is.");
  return false;
}

async function askFields(io: ConnectIo, recipe: Recipe): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of recipe.fields) values[field.name] = (await io.ask(`${field.what}: `)).trim();
  return values;
}

async function makeTheBot(io: ConnectIo, recipe: Recipe, installed: boolean | null, server: string | undefined): Promise<void> {
  if (!recipe.create) {
    io.write(recipe.noCreate ?? "");
    for (const [index, step] of (recipe.steps ?? []).entries()) io.write(`  ${index + 1}. ${step}`);
    return;
  }
  let link: string | null = null;
  try { link = createLink(recipe, server ? cleanServer(server) : undefined); }
  catch (error) { io.write(error instanceof Error ? error.message : String(error)); }
  if (!link) return;
  io.write(recipe.create.how);
  const target = installed === true && recipe.create.app ? recipe.create.app : link;
  if (yes(await io.ask("Open that page now? [y/N] "))) await open(io, target);
  else io.write(`  ${link}`);
}

async function askPasted(io: ConnectIo, recipe: Recipe): Promise<Record<string, string> | null> {
  if (!recipe.paste.length) return {};
  if (io.canHide) {
    const values: Record<string, string> = {};
    for (const paste of recipe.paste) {
      const answer = (await io.askHidden(`${paste.what}${paste.optional ? " (Enter to skip)" : ""} (hidden): `)).trim();
      if (answer) values[paste.secret] = answer;
    }
    return values;
  }
  if (!io.pastePage) { io.write("This terminal cannot hide what is typed. Paste it in the window instead: Customize, Chat apps, Set up."); return null; }
  const page = await io.pastePage(recipe);
  io.write(`This terminal cannot hide what is typed. Paste it on this one-time page on this computer instead:\n  ${page.url}`);
  return page.values;
}

async function askEnable(io: ConnectIo, recipe: Recipe): Promise<FeatureMode | undefined> {
  if (recipe.turnOn === "file") return undefined;
  const answer = (await io.ask(`Switch ${recipe.name} on now? [on / when-needed / N] `)).trim().toLowerCase();
  return answer === "on" ? "on" : answer === "when-needed" || answer === "when needed" ? "when-needed" : undefined;
}

function report(io: ConnectIo, recipe: Recipe, answer: SaveAnswer): void {
  if (answer.checked) io.write(`${recipe.name} accepted it${answer.botName ? `: this is ${answer.botName}` : ""}.`);
  if (answer.checkNote) io.write(answer.checkNote);
  if (answer.saved.length) io.write(`Saved in the locker as ${answer.saved.join(", ")}. It is not shown again.`);
  if (answer.switched) io.write(`${recipe.name} is switched ${answer.switched === "on" ? "on" : "to when needed"}.`);
  else if (recipe.turnOn !== "file") io.write(`${recipe.name} stays off until you switch it on under Customize, Chat apps.`);
  if (answer.connected === true) io.write(`${recipe.name} is connected now. Nothing needs restarting.`);
  if (answer.connectNote) io.write(answer.connectNote);
}

async function pair(io: ConnectIo, backend: ConnectBackend, answer: SaveAnswer): Promise<void> {
  if (!answer.pairing) return;
  io.write(answer.pairing);
  if (!answer.switched || !backend.approvePairing) return;
  const code = (await io.ask("The six-digit code (Enter to do it later): ")).trim();
  if (!/^\d{6}$/.test(code)) return;
  try { await backend.approvePairing(code); io.write("Paired: you can talk to the assistant there now."); }
  catch (error) { io.write(error instanceof Error ? error.message : String(error)); }
}

export function connectUsage(): string {
  return `Usage: branch connect <chat app>\nChat apps: ${recipes().map((recipe) => recipe.id).join(", ")}`;
}

/** The whole command. Answers the exit code. */
export async function runConnect(id: string | undefined, io: ConnectIo, backend: ConnectBackend): Promise<number> {
  const recipe = id ? recipeFor(id) : undefined;
  if (!recipe) { io.write(connectUsage()); return 2; }
  if (!(await switchedOn(io, backend))) return 1;
  io.write(`Setting up ${recipe.name}. Only official apps and pages are used.`);
  const installed = await getTheApp(io, recipe);
  if (recipe.app) await io.ask(`Sign in to ${recipe.app.name} (here or on your phone), then press Enter.`);
  const fields = await askFields(io, recipe);
  await makeTheBot(io, recipe, installed, fields.server);
  const pasted = await askPasted(io, recipe);
  if (pasted === null) return 1;
  const enable = await askEnable(io, recipe);
  const values = { ...fields, ...pasted };
  let answer: SaveAnswer;
  try { answer = await backend.save(recipe.id, values, enable); }
  catch (error) { io.write(scrub(`Nothing was saved: ${error instanceof Error ? error.message : String(error)}`, values)); return 1; }
  report(io, recipe, answer);
  await pair(io, backend, answer);
  return 0;
}
