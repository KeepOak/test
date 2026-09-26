#!/usr/bin/env node
import { reportCommand } from "./diagnostic-cli.js"; // mac7/diagnostics
import { installTypeOf } from "./diagnostic-api.js"; // mac7/diagnostics
import { resolve } from "node:path";
import { createBranch } from "./index.js";
import { maximumPolicyRules } from "./policy.js"; // Q215
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { presetsFromEnv } from "./providers.js";
import { noModelWords } from "./no-model.js";
import { ChatGPTAuth, FileTokenVault } from "./chatgpt-auth.js";
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { startServer } from "./server.js";
import { loadIntegrations } from "./integrations/bootstrap.js";
import { startTerminal } from "./terminal.js";
import { startTui } from "./terminal-tui.js";
import { looksInteractive } from "./terminal-style.js";
import { readOnlyTerminalCommands, runTerminalCommand, statusCommand, terminalArgv, terminalCommandNames, versionText } from "./terminal-cli.js";
import { asksForHelp, cliCommands, commandHelp, completionScript, usageText } from "./cli-completion.js";
import { nodeCommand } from "./devices/node/cli.js"; // mac7/nodes
// Batch 20 (wave 8): short-lived keys, schedules and the attach client for the running engine.
import { clientFor, connect, conversations, messagesOf, since, transcriptLines, type Client } from "./cli-attach.js";
// mac7/smoke-fixes (B4): the terminal beside a Branch that is already open.
import { attachToRunning } from "./install/running.js";
import { traceLines, traceReport, type TraceReport } from "./trace-report.js";
import { scopeDescriptions } from "./session-tokens.js";
import { errorText, type Run } from "./contracts.js";
import { watchFolder } from "./watch.js";
import {
  answerFromCommand, usePreset, exitCodeFor, parseRunArgs, runForScripts,
  timelineLines, type RunFlags,
} from "./cli-run.js";
// Bucket 8 (wave 9): the whole assistant with no window, for a job a script starts.
import { parseHeadlessArgs, promptsFromScript, runHeadless } from "./headless.js";
import { serveMcpStdio } from "./mcp-stdio.js";
import { serveAcpStdio } from "./acp.js";
import { serveAppServerStdio } from "./asks/app-server.js"; // mac6/bucket-23
import { healthReport } from "./health.js";
import { summaryLine } from "./evaluation-runner.js";
import { runMemoryEvaluation } from "./memory-evaluation.js";
// Wave 7 (benchmarks and experiments): studies and the tool checks.
import { compareStudies, comparisonTable, studyLines, studyTable } from "./study.js";
import { runToolChecksSafely, toolEvaluationLine } from "./tool-evaluations.js";
import { readFile, writeFile } from "node:fs/promises";
// Wave 5 (deployment): background running and setting-up repairs.
import { daemonCommand, daemonLauncherName, type DaemonAction } from "./install/daemon.js";
import { doctorFix, doctorText } from "./doctor-fix.js";
import { activityCommand } from "./safety-extras/cli.js"; // mac7/r17-g
// mac3/security-check: the security self-check on the command line.
import { securityAuditCommand } from "./security-audit/api.js";
import { probeAll } from "./provider-probe.js";
// Wave 7 (a coder's toolbox): handing the whole assistant over as one file.
import { agentSections, exportAgent, importAgent, openAgent } from "./agent-export.js";
import { applyPiiGuard } from "./pii.js";
// --- mac3/never-break: the gateway that keeps the engine running (src/never-break/) ---
import { createRequire } from "node:module";
import { joinGateway, runGatewayIfSwitchedOn } from "./never-break/worker-link.js";
import { selfTestCommand } from "./never-break/self-test.js";
// --- end mac3/never-break ---
// --- bucket 22: commands a script uses to manage an installed Branch (src/install/manage-cli.ts) ---
import { manageCommand } from "./install/manage-cli.js";
import { bringInShareable, shareableSections } from "./interop/agent-market.js";
// --- end bucket 22 ---
import { sendCommand } from "./reach/send-cli.js"; // r17-i: branch send
import { qaCommand, qaDeps } from "./qa-api.js"; // w911 (A1753) hook.
import { sayOnceIfNodeIsTooOld } from "./node-floor.js"; // mac7/node-floor
import { phoneCommand } from "./phone-app/cli.js";
import { scheduleCommand } from "./schedule-cli.js";

async function configuredApp(options: Parameters<typeof createBranch>[0]) {
  const app = await createBranch(options);
  try {
    const integrations = await loadIntegrations(
      app.registry,
      process.env.BRANCH_INTEGRATIONS,
      process.env,
      app.secretsFor,
      app.channelHost,
    );
    app.browser = integrations.hosted.browser ?? null;
    app.studies.browser = integrations.hosted.browser; // w911 (A1726) hook: MiniWoB studies open their page in this browser
    app.reach = { browserOrigins: integrations.hosted.browserOrigins ?? [],
      commandsMayReachInternet: integrations.hosted.commandsNetless !== true };
    app.issues = integrations.hosted.issues ?? null;
    return {
      app,
      close: async () => {
        try {
          await integrations.close();
        } finally {
          await app.close();
        }
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function serve(
  app: Awaited<ReturnType<typeof createBranch>>,
  dataDir: string,
  close: () => Promise<void>,
): Promise<void> {
  let stopEngine: (() => Promise<void>) | undefined; // bucket 22
  const port = Number(process.env.BRANCH_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid BRANCH_PORT");
  const link = joinGateway(); // mac3/never-break: an engine run by the gateway leaves presence to it
  const server = await startServer(app, {
    dataDir, port, ...(link ? {} : { presence: "daemon" as const }),
    executable: process.env.BRANCH_EXECUTABLE ?? null,
    installRoot: process.env.BRANCH_INSTALL_ROOT ?? null,
    // bucket 22: `branch quit` is the same stop as Ctrl+C (an engine run by the gateway is stopped through the gateway).
    ...(link ? {} : { quit: () => void stopEngine?.() }),
  });
  console.log(
    `Branch Agent listening at ${server.url}\nProvider: ${app.runtime.models.configured ? app.runtime.provider.name : noModelWords}\nWorkspace: ${app.runtime.workspace}\nLocal session token (paste into browser): ${server.token}`,
  );
  let closing: Promise<void> | null = null;
  const stop = () => {
    closing ??= server
      .close()
      .finally(close)
      .catch((error) =>
        console.error(error instanceof Error ? error.message : String(error)),
      );
    return closing;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  // bucket 22: after a `branch quit`, leave even if something still holds the process open.
  stopEngine = () => stop().finally(() => { setTimeout(() => process.exit(0), 1000).unref(); });
  // mac3/never-break: tell the gateway where the engine is, and close when it asks or goes away.
  link?.onStop(stop);
  link?.ready(Number(new URL(server.url).port), app.version);
}

async function main(): Promise<void> {
  // mac7/node-floor: on a Node older than Branch supports, say so plainly, once, before anything
  // else is printed — and carry on, because everything but the proxy still works. See src/node-floor.ts.
  sayOnceIfNodeIsTooOld((line) => console.error(line));
  // ---- Wave mac3 (terminal): `branch` alone opens the terminal view when it runs in a terminal (and
  // starts the web app anywhere else, as before); names brought from Hermes and OpenClaw become the
  // Branch command they mean; `version` needs nothing opened. See src/terminal-cli.ts.
  const inTerminal = looksInteractive(process.env, process.stdout.isTTY === true && process.stdin.isTTY === true);
  process.argv.splice(2, Infinity, ...terminalArgv(process.argv.slice(2), inTerminal));
  // ---- bucket 22: `--version --json`, `quit`, `uninstall` and an installed copy's `update` ----
  if (!asksForHelp(process.argv.slice(3))) {
    const code = await manageCommand(process.argv.slice(2), {
      env: process.env, platform: process.platform, print: (line) => console.log(line),
      version: String(createRequire(import.meta.url)("../package.json").version),
      packageRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    });
    if (code !== null) { process.exitCode = code; return; }
  }
  // ---- end of the bucket 22 block
  if (process.argv[2] === "version" && !asksForHelp(process.argv.slice(3))) { console.log(versionText()); return; }
  // ---- end of the terminal block
  const command = process.argv[2] ?? "start";
  // Batch 20 (wave 8): `branch <command> --help` says what that command does and stops. Asking must
  // never be the same thing as doing, so this comes before every command, workspace and database.
  if (cliCommands.some((entry) => entry.name === command) && asksForHelp(process.argv.slice(3))) {
    console.log(commandHelp(command));
    return;
  }
  // ---- mac7/nodes: `branch node` lends this computer to Branch elsewhere; it opens no workspace or database. ----
  if (command === "node") {
    process.exitCode = await nodeCommand({ argv: process.argv.slice(3), env: process.env, platform: process.platform, print: (line) => console.log(line) });
    return;
  }
  // ---- end mac7/nodes ----
  if (command === "update") return updateCheckout();
  if (command === "daemon") return runDaemonCommand();
  // Printing a completion script or the command list needs no workspace, database or integrations.
  if (command === "completion") { console.log(completionScript(process.argv[3] ?? "")); return; }
  if (["help", "--help", "-h"].includes(command)) { console.log(usageText()); return; }
  // One list drives the command check, `branch help` and the completion scripts: see cliCommands.
  if (!cliCommands.some((entry) => entry.name === command))
    throw new Error(`${usageText()}\n\nI do not know the command "${command}".`);
  const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace"),
    dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
  // These two talk to the engine that is already running and never start one of their own, so they
  // come before the workspace and the database are opened at all.
  if (command === "schedule") return scheduleCommand(dataDir);
  // --- mac7/connect: `branch connect <chat app>` (src/channel-setup/cli.ts) ---
  if (command === "connect") {
    const { connectCommand } = await import("./channel-setup/cli.js");
    process.exitCode = await connectCommand(process.argv.slice(3), { dataDir, workspace });
    return;
  }
  // --- end mac7/connect ---
  if (command === "send") return sendCommand(process.argv.slice(3), dataDir); // r17-i
  // --- mac3/never-break: a new version checking itself on a copy of the data before an update ---
  if (command === "start" && process.env.BRANCH_SELF_TEST)
    return selfTestCommand(process.env.BRANCH_SELF_TEST, { dataDir, workspace, version: String(createRequire(import.meta.url)("../package.json").version) });
  // --- mac3/never-break: with the switch on, `start` runs the gateway, which runs the engine ---
  if (command === "start" && await runGatewayIfSwitchedOn({ dataDir, script: fileURLToPath(import.meta.url),
    version: String(createRequire(import.meta.url)("../package.json").version), port: Number(process.env.BRANCH_PORT ?? 3210) })) return;
  // --- end mac3/never-break ---
  if (command === "chat" && process.argv.includes("--attach")) return attachedChat(dataDir);
  // mac7/smoke-fixes (B4): the Branch already open holds the saved work, so the commands that only
  // look - and making a key, which a script needs at exactly that moment - go through its door
  // instead of refusing. With nothing running this answers null and everything opens here as before.
  const answered = await overRunningBranch(command, dataDir);
  if (answered !== null) { process.exitCode = answered; return; }
  const presets = presetsFromEnv();
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(dataDir, "chatgpt-auth.json")), { userAgent: "BranchAgent" });
  const { app, close } = await configuredApp({ workspace, dataDir, presets, chatgpt });
  if (command === "start") {
    try {
      await serve(app, dataDir, close);
    } catch (error) {
      await close();
      throw error;
    }
    return;
  }
  try {
    if (command === "trigger") {
      const id = process.argv[3];
      if (!id) throw new Error("Provide a schedule id: node dist/cli.js trigger <schedule-id>");
      const run = await app.scheduler.trigger(app.runtime.owner, id, undefined, "local");
      console.log(JSON.stringify({ run, events: app.store.events(run.id) }, null, 2));
      if (run.status !== "completed") process.exitCode = 1;
    } else if (command === "login") await loginChatGPT(app);
    else if (command === "logout") {
      await app.chatgpt!.signOut();
      syncChatGPTPresets(app.runtime.models, app.chatgpt!, false, app.userAgent);
      console.log("Signed out of ChatGPT.");
    } else if (command === "chat") {
      // The full view needs a terminal that can be drawn on; anything else gets the plain stream.
      const full = looksInteractive(process.env, process.stdout.isTTY) && !process.argv.includes("--plain");
      const session = flag("session");
      await (full ? startTui(app.runtime, { app, ...(session ? { sessionId: session } : {}) }) : startTerminal(app.runtime));
      return;
    } else if (command === "status") {
      await statusCommand(app, { json: process.argv.includes("--json"), write: (line) => console.log(line) });
      return;
    }
    else if (command === "logs") { printLogs(app); return; }
    else if (command === "approve") { printApproval(app); return; }
    else if (command === "mcp-serve") {
      await serveMcpStdio(app.mcpServer);
      return;
    } else if (command === "acp-serve") {
      await serveAcpStdio(app.runtime, app.store);
      return;
    } else if (command === "app-server") {
      // mac6/bucket-23 (A0032): the app-server protocol on standard input and output, while switched on.
      await serveAppServerStdio(app.runtime, app.version);
      return;
    }
    // Wave mac3 (terminal): places, Settings pages and the everyday commands, in src/terminal-cli.ts.
    if (terminalCommandNames.has(command)) {
      const json = process.argv.includes("--json");
      await runTerminalCommand(app, command, process.argv.slice(3).filter((word) => word !== "--json"),
        { interactive: inTerminal && !json, env: process.env, json, write: (line) => console.log(line) });
      return;
    }
    if (command === "watch") { await watchCommand(app); return; }
    if (command === "skill") { await skillCommand(app); return; }
    if (command === "plugin") { await pluginCommand(app); return; }
    if (command === "doctor") {
      await printDoctor(app, dataDir);
      return;
    }
    if (command === "backup") {
      const target = process.argv[3];
      if (!target) throw new Error("Provide a file: node dist/cli.js backup <file>");
      await writeFile(target, JSON.stringify(app.store.backup(app.version)), { mode: 0o600 });
      console.log(`Backup written to ${target}. Secrets are not included; they stay on this device.`);
      return;
    }
    if (command === "token") { await tokenCommand(ownKeys(app)); return; }
    // mac7/phone-qr: the "Get Branch on your phone" code, in the terminal (src/phone-app/cli.ts).
    if (command === "phone") {
      process.exitCode = await phoneCommand({ store: app.store, owner: app.runtime.owner, write: (line) => console.log(line),
        colour: !process.env.NO_COLOR }, process.argv.slice(3));
      return;
    }
    // mac3/security-check: `branch security audit [--fix] [--json]` (src/security-audit/api.ts).
    if (command === "security") {
      const { text, urgent } = await securityAuditCommand(app.security, process.argv.slice(3));
      console.log(text);
      if (urgent) process.exitCode = 1;
      return;
    }
    if (command === "trace") { traceCommand(app); return; }
    // mac7/diagnostics: "Report a problem" from the terminal (src/diagnostic-cli.ts). Nothing is sent.
    if (command === "report") {
      process.exitCode = await reportCommand({ app, dataDir, installType: installTypeOf({ packageRoot: dirname(dirname(fileURLToPath(import.meta.url))) }), startedAt: Date.now() },
        process.argv.slice(3), (line) => console.log(line));
      return;
    }
    // mac7/r17-g: `branch activity verify [--tip <hash>] [--json]` checks the tamper-evident chain.
    if (command === "activity") { process.exitCode = activityCommand(app.safetyExtras.chain, app.runtime.owner, process.argv.slice(3)); return; }
    // w911 (A1753) hook: `branch qa list` and `branch qa run <id>`.
    if (command === "qa") { process.exitCode = await qaCommand(qaDeps(app), process.argv.slice(3), (line) => console.log(line)); return; }
    if (command === "eval") {
      await runEvaluation(app);
      return;
    }
    // Wave 7: written-down experiments over suites and benchmarks.
    if (command === "study") {
      await runStudy(app);
      return;
    }
    if (command === "export-agent" || command === "import-agent") {
      await agentPortability(app, command);
      return;
    }
    if (command === "restore") {
      const source = process.argv[3];
      if (!source) throw new Error("Provide a file: node dist/cli.js restore <file>");
      console.log(JSON.stringify(app.store.restore(JSON.parse(await readFile(source, "utf8")))));
      return;
    }
    if (command === "headless") return await headlessJob(app);
    await runOnce(app, command, inTerminal);
  } finally {
    await close();
  }
}
/**
 * Handing the assistant over as one file, and reading one back in. The manifest is always printed
 * first; nothing is brought in until the person says which parts they want with --sections, so an
 * import can never quietly replace what they already have.
 */
async function agentPortability(app: Awaited<ReturnType<typeof configuredApp>>["app"], command: string): Promise<void> {
  const target = process.argv[3];
  if (!target) throw new Error(`Provide a file: node dist/cli.js ${command} <file>`);
  if (command === "export-agent") {
    const withMemory = process.argv.includes("--memory");
    const redact = process.argv.includes("--redact") ? (text: string) => applyPiiGuard(text, "mask").text : undefined;
    const { bytes, manifest } = exportAgent(app.store, app.runtime.owner, app.version, { memory: withMemory, ...(redact ? { redact } : {}) });
    await writeFile(target, bytes, { mode: 0o600 });
    for (const section of manifest.sections) console.log(`  ${section.name}: ${section.summary}`);
    console.log(`Written to ${target}. No secret is inside: the locker was never opened.`);
    return;
  }
  const opened = openAgent(await readFile(target));
  console.log(`Exported ${opened.manifest.exportedAt} by Branch ${opened.manifest.appVersion}. Inside:`);
  for (const section of opened.manifest.sections) console.log(`  ${section.name}: ${section.summary}`);
  const chosen = (flag("sections") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  // bucket 22 integration: an installer's `--assistant` file follows a market's rules (only the parts
  // that cannot widen anything, yours kept, new skills off), never the whole-file import below.
  if (process.argv.includes("--shareable-only")) {
    const parts = shareableSections.filter((name) => chosen.includes(name));
    const label = { subject: `${basename(target)}, a custom distribution`, from: "Brought in by the installer" };
    for (const report of parts.length ? bringInShareable(app.store, app.runtime.owner, opened, parts, label) : [])
      console.log(`  ${report.section}: ${report.brought} ${report.note}`);
    if (!parts.length) console.log(`Nothing was brought in. Choose parts with --sections ${shareableSections.join(",")}`);
    return;
  }
  const wanted = agentSections.filter((name) => chosen.includes(name));
  if (!wanted.length) {
    console.log(`Nothing was brought in. Choose parts with --sections ${agentSections.join(",")}`);
    return;
  }
  const origin = { writer: "owner-by-command", source: "import", detail: `branch import-agent ${basename(target)}` } as const;
  for (const report of importAgent(app.store, app.runtime.owner, opened, wanted, origin))
    console.log(`  ${report.section}: ${report.brought} ${report.note}`);
}

/** The value after a --flag on the command line, or undefined. */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}
/** Where `branch token` gets its answers: the copy this terminal opened, or the Branch already open. */
interface TokenAccess {
  create(input: { scope: string; name: string; minutes: number }): Promise<{ token: string; entry: TokenRow; scopeNote: string }>;
  list(): Promise<TokenRow[]>;
  revoke(id: string): Promise<boolean>;
}
interface TokenRow { id: string; scope: string; name: string; expiresAt: string; revokedAt: string | null; uses: number }
/** mac7/smoke-fixes (B4): the keys of the copy this terminal opened itself. */
function ownKeys(app: Awaited<ReturnType<typeof createBranch>>): TokenAccess {
  const owner = app.runtime.owner;
  return {
    async create(input) {
      const made = app.sessionTokens.create(owner, input);
      return { token: made.token, entry: made.entry, scopeNote: scopeDescriptions[made.entry.scope] };
    },
    async list() { return app.sessionTokens.list(owner); },
    async revoke(id) { return app.sessionTokens.revoke(owner, id); },
  };
}
/** mac7/smoke-fixes (B4): the keys of the Branch already open, through the door the window uses. */
function runningKeys(client: Client): TokenAccess {
  return {
    create: (input) => client.post("/api/tokens", input),
    list: async () => (await client.get<{ tokens: TokenRow[] }>("/api/tokens")).tokens,
    revoke: async (id) => (await client.post<{ revoked: boolean }>(`/api/tokens/${id}/revoke`, {})).revoked,
  };
}
/**
 * `branch token create|list|revoke`. A short-lived key for a script, an extension or the SDK —
 * never the local key itself, which never stops working and may do everything.
 */
async function tokenCommand(keys: TokenAccess): Promise<void> {
  const action = process.argv[3] ?? "list", asJson = process.argv.includes("--json");
  if (action === "create") {
    const made = await keys.create({
      scope: flag("scope") ?? "read", name: flag("name") ?? "A script",
      minutes: Number(flag("minutes") ?? 60) || 60,
    });
    if (asJson) return void console.log(JSON.stringify({ token: made.token, entry: made.entry }));
    console.log(made.token);
    console.log(`\nThis is the only time it is shown. ${made.scopeNote}`);
    console.log(`It stops working at ${made.entry.expiresAt}. Take it back sooner with: branch token revoke ${made.entry.id}`);
    return;
  }
  if (action === "revoke") {
    const id = process.argv[4];
    if (!id) throw new Error("Name the key to take back: branch token revoke <id>");
    const done = await keys.revoke(id);
    if (asJson) return void console.log(JSON.stringify({ id, revoked: done }));
    console.log(done ? `That key stops working now.` : `There is no key of yours with the number ${id}.`);
    return;
  }
  if (action !== "list") throw new Error("Usage: branch token create [--scope read|run] [--minutes 60] | token list | token revoke <id>");
  const entries = await keys.list();
  if (asJson) return void console.log(JSON.stringify({ tokens: entries }, null, 2));
  if (!entries.length) return void console.log("You have not made any short-lived keys.");
  for (const entry of entries)
    console.log([entry.id, entry.scope, entry.name, entry.revokedAt ? "taken back" : `until ${entry.expiresAt}`, `${entry.uses} use(s)`].join("\t"));
}

/**
 * mac7/smoke-fixes (B4): what a second terminal may do while a Branch is already open.
 *
 * Only one Branch may write to the saved work at a time, and that rule is not weakened here: none of
 * these opens the database. They ask the Branch that is running, through the same local key and the
 * same rules the app window goes through, exactly as `branch schedule` already did. Answers the exit
 * code, or null when nothing is running and this copy should open the saved work itself.
 *
 * What is here: `doctor` (the checks), `trace` (one task's steps), `token` (a short-lived key for a
 * script — the one moment a script needs one is while Branch is running), and every terminal
 * command that only looks, `status` included (the running Branch writes its lines, with the same
 * function as here). Everything else would fight the running Branch for the same files and still
 * refuses, in a sentence that now says which commands do work.
 */
async function overRunningBranch(command: string, dataDir: string): Promise<number | null> {
  const wanted = ["doctor", "trace", "token"].includes(command) || readOnlyTerminalCommands.has(command);
  if (!wanted) return null;
  // `branch doctor --fix` repairs things, so it is not one of the ones that only look.
  if (command === "doctor" && (process.argv.includes("--fix") || process.argv.includes("--repair"))) return null;
  const found = await attachToRunning(dataDir);
  if (!found) return null;
  const client = clientFor(found);
  if (command === "token") { await tokenCommand(runningKeys(client)); return 0; }
  if (command === "doctor") {
    const health = await client.get<unknown>(`/api/health${process.argv.includes("--probe") ? "?probe=1" : ""}`);
    console.log(JSON.stringify({ from: `the Branch already open at ${client.url}`, dataDir, health }, null, 2));
    return 0;
  }
  if (command === "trace") {
    const report = await client.get<TraceReport>(`/api/runs/${traceRunId()}/trace`);
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else for (const line of traceLines(report)) console.log(line);
    return 0;
  }
  const args = process.argv.slice(3).filter((word) => !word.startsWith("--"));
  // This terminal's own language, so a person on "follow the computer" reads the same words here.
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const query = [`command=${encodeURIComponent(command)}`, ...(process.argv.includes("--json") ? ["json=1"] : []),
    ...(locale ? [`locale=${encodeURIComponent(locale.slice(0, 40))}`] : []),
    ...args.map((word) => `arg=${encodeURIComponent(word)}`)].join("&");
  const { lines } = await client.get<{ lines: string[] }>(`/api/terminal?${query}`);
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * `branch trace <task id>`. The number a tracing tool knows this task by, and whether its steps
 * went anywhere. Printing it is the join between what happened here and what a viewer shows.
 */
function traceCommand(app: Awaited<ReturnType<typeof createBranch>>): void {
  const report = traceReport(app.store, app.traceExport.settings(), traceRunId());
  if (process.argv.includes("--json")) return void console.log(JSON.stringify(report, null, 2));
  for (const line of traceLines(report)) console.log(line);
}
/** The task named after `branch trace`, refused in the same words whatever shape it is. */
function traceRunId(): string {
  const runId = process.argv[3];
  if (!runId) throw new Error("Name a task: branch trace <task id>");
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error(`Nothing was recorded for the task ${runId}.`);
  return runId;
}
/**
 * `branch chat --attach`: a second terminal joining the conversation the engine already running is
 * having. Without `--session` it lists the conversations and picks the newest. `--watch` only
 * listens, which is what a second window open beside the first one wants.
 */
async function attachedChat(dataDir: string): Promise<void> {
  const client = await connect(dataDir);
  const asked = flag("session");
  const sessions = await conversations(client, 10);
  if (!asked && !sessions.length) throw new Error("That copy of Branch has no conversations yet. Say something in the app window first.");
  const sessionId = asked ?? sessions[0]!.id;
  console.error(`[attached to ${client.url}, conversation ${sessionId}]`);
  for (const line of transcriptLines(await messagesOf(client, sessionId))) console.log(line);
  let last = (await since(client, sessionId, -1)).last;
  const prompt = process.argv.slice(3).filter((word) => !word.startsWith("--")).join(" ").trim();
  if (prompt) {
    const run = await client.post<{ output?: string; status?: string }>("/api/run", { prompt, sessionId });
    console.log(`branch: ${run.output ?? "(no reply)"}`);
    last = (await since(client, sessionId, last)).last;
    return;
  }
  // Nothing to say: watch what the other terminal is doing until Ctrl+C.
  console.error("[watching; Ctrl+C stops it]");
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const rounds = Number(flag("watch") ?? 0) || Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds && !stopped; round++) {
    const fresh = await since(client, sessionId, last).catch(() => ({ lines: [], last }));
    for (const line of fresh.lines) console.log(line);
    last = fresh.last;
    if (!stopped && round + 1 < rounds) await new Promise((wait) => setTimeout(wait, 500));
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
/** Reads the files of a `skill/` folder that belong in a package. */
async function packageFiles(folder: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const files: Record<string, string> = {};
  for (const name of await readdir(folder))
    if (["SKILL.md", "tools.json", "hooks.json"].includes(name) || name.endsWith(".md"))
      files[name] = await readFile(join(folder, name), "utf8");
  return files;
}
/** `branch skill pack <folder> [out]` and `branch skill install <file> [--approve]`. */
async function skillCommand(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const action = process.argv[3], target = process.argv[4];
  if (action === "pack") {
    if (!target) throw new Error('Provide a folder: node dist/cli.js skill pack <folder> --author "Your name"');
    const author = flag("author");
    if (!author) throw new Error('Say who made it: --author "Your name"');
    const { packSkill } = await import("./skill-package.js");
    const bytes = packSkill({ files: await packageFiles(resolve(target)), author, packageVersion: flag("package-version") ?? "1.0.0" });
    const out = process.argv[5] && !process.argv[5].startsWith("--") ? process.argv[5] : `${resolve(target)}.branchskill`;
    await writeFile(out, bytes, { mode: 0o600 });
    console.log(`Wrote ${out} (${bytes.length} bytes).`);
    return;
  }
  if (action === "install") {
    if (!target) throw new Error("Provide a package file: node dist/cli.js skill install <file.branchskill>");
    const bytes = await readFile(resolve(target));
    const approve = process.argv.includes("--approve");
    const result = app.skillPackages.install(bytes, approve);
    console.log(`${result.manifest.name} ${result.manifest.packageVersion} by ${result.manifest.author}`);
    for (const asked of result.permissions) console.log(`  asks to: ${asked.why}`);
    console.log(approve ? "Installed. The skill is switched off until you turn it on in Skills." : "Nothing was installed. Run again with --approve to accept the list above.");
    return;
  }
  throw new Error("Usage: node dist/cli.js skill pack <folder> [out] --author \"Name\" | skill install <file.branchskill> [--approve]");
}
/** `branch plugin list | enable <id> | disable <id>`. */
async function pluginCommand(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const action = process.argv[3], id = process.argv[4];
  if (action === "list") {
    const entries = await app.plugins.list();
    if (!entries.length) console.log("No plugin files found. Put <name>.mjs in the plugins folder beside your data.");
    for (const entry of entries) console.log(`${entry.enabled ? "on " : "off"} ${entry.id}${entry.summary ? ` — ${entry.summary.name}` : ""}`);
    return;
  }
  if (!id) throw new Error("Provide a plugin id: node dist/cli.js plugin enable <id>");
  if (action === "enable") {
    const summary = await app.plugins.enable(id);
    console.log(`${summary.name} is on. It adds: ${summary.tools.map((tool) => tool.name).join(", ") || "no tools"}; it needs: ${summary.permissions.join(", ") || "nothing"}.`);
    return;
  }
  if (action === "disable") { app.plugins.disable(id); console.log(`${id} is off. Its tools are out of the catalog.`); return; }
  throw new Error("Usage: node dist/cli.js plugin list | plugin enable <id> | plugin disable <id>");
}
/**
 * `branch watch <folder> [<procedure-id>]`: runs a saved procedure whenever a file under that folder
 * is written. It keeps going until Ctrl+C, and `--once` stops after the first run.
 * `branch watch <folder> --ai-comments`: watches for AI comments in code and starts a task for them.
 * Nothing is watched until the person names a folder.
 */
/** bucket-18 (A0344): `branch watch <folder> --ai-comments [--once]`. */
async function aiCommentsCommand(app: Awaited<ReturnType<typeof configuredApp>>["app"], folder: string): Promise<void> {
  const { watchAIComments, aiCommentTaskStarter } = await import("./ai-comments.js");
  const once = process.argv.includes("--once");
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  let tasks = 0;
  const handle = await watchAIComments({
    folder, files: app.files, settleMs: Number(flag("settle") ?? 400),
    // Integration review: a comment's task only reads and changes files, and is not the owner's own.
    startTask: aiCommentTaskStarter(app),
    onTask: (outcome) => {
      tasks += 1;
      console.log(JSON.stringify({ type: "ai-comments", ...outcome }));
      if (once) finished?.();
    },
    onError: (error) => console.error(`[watch] ${errorText(error)}`),
  });
  console.error(`[watch] watching ${folder} for comments ending in AI! or AI?; Ctrl+C stops it.`);
  const stop = () => finished?.();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await done;
  await handle.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  console.error(`[watch] stopped after ${tasks} task(s).`);
}
async function watchCommand(app: Awaited<ReturnType<typeof configuredApp>>["app"]): Promise<void> {
  const folder = process.argv[3];
  if (!folder) throw new Error("Give a folder: node dist/cli.js watch <folder> [<procedure-id> | --ai-comments]");

  // bucket-18: AI comments (A0344): comments ending in AI! or AI? become a task.
  if (process.argv.includes("--ai-comments")) return aiCommentsCommand(app, folder);
  const procedureId = process.argv[4];
  if (!procedureId)
    throw new Error("Give a procedure: node dist/cli.js watch <folder> <procedure-id>");
  const once = process.argv.includes("--once");
  const settle = Number(flag("settle") ?? 400);
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const handle = watchFolder(folder, async (reason) => {
    console.error(`[watch] ${reason}; running ${procedureId}`);
    const context = app.runtime.context({ signal: AbortSignal.timeout(120000), source: "owner" });
    const result = await app.knowledge.replayProcedure(context, procedureId, {});
    console.log(JSON.stringify({ reason, procedureId, version: result.version, results: result.results }));
    if (once) finished?.();
  }, { settleMs: settle }, (error) => console.error(`[watch] ${errorText(error)}`));
  console.error(`[watch] watching ${folder}; Ctrl+C stops it.`);
  const stop = () => { finished?.(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await done;
  await handle.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  console.error(`[watch] stopped after ${handle.runs} run(s).`);
}
/**
 * `branch run`. With `--json` every event goes to stdout as one JSON object per
 * line while the task works, and the human wording goes to stderr, so a script can read one and a
 * person can watch the other. The exit code says what happened: see `exitCodeFor`.
 */
async function runOnce(
  app: Awaited<ReturnType<typeof createBranch>>,
  command: string,
  /** mac7/tests-unattended: a person at a terminal, who can be asked (the same test `branch` itself uses). */
  inTerminal: boolean,
): Promise<void> {
  const flags: RunFlags = parseRunArgs(process.argv.slice(3));
  // Carrying a stopped task on needs no new words: it takes up its own request again.
  if (!flags.prompt && !flags.resumeRunId) throw new Error('Provide a prompt: branch run "your request"');
  const writer = {
    line: (value: unknown) => { if (flags.json) process.stdout.write(JSON.stringify(value) + "\n"); },
    note: (text: string) => console.error(text),
  };
  const preset = flags.preset ? usePreset(app.store, app.runtime.owner, flags.preset, flags.savePreset, { confirm: flags.confirm === true, tools: app.registry }) : undefined;
  if (preset) writer.note(preset.message);
  let run: Run;
  try {
    run = await runForScripts(app.runtime, flags, writer, inTerminal);
  } finally {
    preset?.restore();
  }
  if (flags.json) {
    writer.line({ type: "run", run, usage: app.store.usage(run.id), exitCode: exitCodeFor(run.status) });
    writer.note(run.status === "completed" ? run.output : `[task ${run.status}] ${run.output}`);
  } else console.log(JSON.stringify({ run, usage: app.store.usage(run.id), events: app.store.events(run.id) }, null, 2));
  process.exitCode = exitCodeFor(run.status);
}
/**
 * `branch headless`: no window, no web page, no terminal conversation — one request or a file of
 * them, carried out in order in one conversation, and the exit code `branch run` already uses.
 */
async function headlessJob(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const { script, stopEarly, rest } = parseHeadlessArgs(process.argv.slice(3));
  const flags: RunFlags = parseRunArgs(rest);
  const prompts = script ? promptsFromScript(await readFile(script, "utf8")) : flags.prompt ? [flags.prompt] : [];
  if (!prompts.length) throw new Error('Provide a request or a script: branch headless --script jobs.txt');
  const writer = {
    line: (value: unknown) => { if (flags.json) process.stdout.write(`${JSON.stringify(value)}\n`); },
    note: (text: string) => console.error(text),
  };
  const preset = flags.preset ? usePreset(app.store, app.runtime.owner, flags.preset, flags.savePreset, { confirm: flags.confirm === true, tools: app.registry }) : undefined;
  if (preset) writer.note(preset.message);
  try {
    const report = await runHeadless(app.runtime, { prompts, flags, stopEarly }, writer);
    if (!flags.json) console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  } finally { preset?.restore(); }
}
function printLogs(app: Awaited<ReturnType<typeof createBranch>>): void {
  const runId = process.argv[3];
  if (!runId) throw new Error("Name a task: branch logs <task id>");
  if (process.argv.includes("--json")) {
    for (const event of app.store.events(runId)) process.stdout.write(JSON.stringify(event) + "\n");
    return;
  }
  for (const line of timelineLines(app.store, runId)) console.log(line);
}
function printApproval(app: Awaited<ReturnType<typeof createBranch>>): void {
  const [, , , id, answer] = process.argv;
  if (!id || !answer) throw new Error("Answer a task: branch approve <task id> yes|no");
  const result = answerFromCommand(app.runtime, id, answer);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(result)); return; }
  // The run that asked has already ended, so there is nothing left to answer just this once: the
  // answer has to be saved as a rule. Say that plainly rather than letting it look like a one-off.
  // Q215: the asking run has ended, so an answer that was not saved holds nowhere; say so rather than "Saved".
  if (!result.kept) {
    console.log(`Nothing was saved: your approval rules are full (${maximumPolicyRules}), and making room would drop one of your refusals or "ask first" rules.`);
    console.log("Remove some rules under \"When to check with me\" in Settings, then answer again. The task will ask again when you run it.");
    return;
  }
  console.log(result.decision === "allow"
    ? `Saved a standing rule: ${result.rule} may go ahead from now on, without asking.`
    : `Saved a standing rule: ${result.rule} is refused from now on, without asking.`);
  console.log("This applies to every future task, not just this one. Change it under \"When to check with me\" in Settings.");
  if (result.decision === "allow") console.log("Run the task again to carry on.");
}
/**
 * `branch eval [--suite <id>] [--preset <id>] [--compare a,b] [--json]`. Without a suite it runs
 * the standard three-task suite, as it always has.
 */
async function runEvaluation(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const asJson = process.argv.includes("--json"), suite = flag("suite"), compare = flag("compare");
  // `branch eval memory` measures whether saved facts are actually found, against the set in data/.
  if (process.argv[3] === "memory") return printMemoryEvaluation(app, asJson);
  if (compare) {
    const result = await app.evaluationSuites.compare({ suite: suite ?? "cost", presets: compare.split(",").map((part) => part.trim()).filter(Boolean) });
    if (asJson) return void console.log(JSON.stringify(result, null, 2));
    console.log(["model choice", "right", "accuracy", "mean ms", "tokens", "cost"].join("\t"));
    for (const row of result.rows)
      console.log([row.preset, `${row.passed}/${row.total}`, row.accuracy, row.meanMs, row.tokens, row.dollars === null ? "no price on file" : `$${row.dollars.toFixed(4)}`].join("\t"));
    return void console.log(`\nBest on this suite: ${result.best ?? "none"}`);
  }
  if (process.argv[3] === "tools") return runToolChecks(app);
  if (!suite) return void console.log(JSON.stringify(await app.evaluation.run(app.runtime), null, 2));
  // Wave 7: `--gate` is the bar a release script stops on: JSON on the command line, or a file.
  const gates = await readGates(flag("gate"));
  const result = await app.evaluationSuites.run({ suite, ...(flag("preset") ? { preset: flag("preset")! } : {}), ...(gates ? { gates } : {}) });
  if (asJson) return void console.log(JSON.stringify(result, null, 2));
  console.log(["task", "result", "score", "ms", "tokens", "why"].join("\t"));
  for (const task of result.tasks)
    console.log([task.id, task.skipped ? "skipped" : task.passed ? "passed" : "failed", task.score, task.ms, task.tokens, task.problem ?? ""].join("\t"));
  console.log(`\n${summaryLine(result)}`);
  if (result.gate) return void (process.exitCode = result.gate.passed ? 0 : 1);
  if (!result.summary.total || result.summary.passed < result.summary.total) process.exitCode = 1;
}
/** How often the right saved fact came back, before the nightly pass and after it. */
async function printMemoryEvaluation(app: Awaited<ReturnType<typeof createBranch>>, asJson: boolean): Promise<void> {
  const result = await runMemoryEvaluation(app.store, app.memory.retrieval, app.consolidation);
  if (asJson) return void console.log(JSON.stringify(result, null, 2));
  console.log(["question", "found", "where"].join("\t"));
  for (const row of result.results) console.log([row.ask, row.found ? "yes" : "no", row.rank ?? "-"].join("\t"));
  console.log(`\n${result.name}: found the right fact for ${Math.round(result.hitRateBefore * 100)}% of `
    + `${result.questions} questions, ${Math.round(result.hitRateAfter * 100)}% after the nightly pass.`);
  if (result.meaningSearch) console.log(result.meaningSearch);
  if (result.hitRateAfter < 1) process.exitCode = 1;
}
/** The gates for this run: JSON written out on the command line, or the name of a file holding it. */
async function readGates(value: string | undefined): Promise<unknown> {
  if (!value) return null;
  const text = value.trim().startsWith("{") ? value : await readFile(value, "utf8");
  return JSON.parse(text);
}
/** `branch eval tools`: every tool called directly with a known input, no model involved. */
async function runToolChecks(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  // The checks write files and save facts for real, so they run in a project and under a name of
  // their own: nothing they do reaches the owner's folder or the owner's memory.
  const result = await runToolChecksSafely(app, AbortSignal.timeout(120000));
  if (process.argv.includes("--json")) return void console.log(JSON.stringify(result, null, 2));
  for (const one of result.cases) console.log([one.tool, one.name, one.passed ? "ok" : "wrong", one.problem ?? ""].join("\t"));
  console.log(`\n${toolEvaluationLine(result)}`);
  if (result.summary.passed < result.summary.total) process.exitCode = 1;
}
/**
 * `branch study run <id> [--fresh]`, `branch study list`, `branch study compare <a> <b>` and
 * `branch study replay <id>`, which reads the journal and says what changed since the run before.
 * A study that is stopped part way carries on from its checkpoints unless `--fresh` is given.
 */
async function runStudy(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const action = process.argv[3] ?? "list", asJson = process.argv.includes("--json");
  if (action === "list") {
    for (const study of app.studies.list()) console.log([study.id, study.name, study.presets.join(",")].join("\t"));
    return;
  }
  if (action === "compare") {
    const [, , , , a, b] = process.argv;
    if (!a || !b) throw new Error("Compare two results: branch study compare <result id> <result id>");
    const all = app.studies.results();
    const left = all.find((entry) => entry.id === a), right = all.find((entry) => entry.id === b);
    if (!left || !right) throw new Error("One of those study results is not on file");
    const comparison = compareStudies(left, right);
    return void console.log(asJson ? JSON.stringify(comparison, null, 2) : comparisonTable(comparison));
  }
  if (action === "replay") {
    const studyId = process.argv[4];
    if (!studyId) throw new Error("Name a study: branch study replay <id>");
    const { entry, report } = app.studies.replay(studyId);
    return void console.log(asJson ? JSON.stringify(entry, null, 2) : report);
  }
  if (action !== "run") throw new Error("Usage: branch study list | run <id> [--fresh] | compare <a> <b> | replay <id>");
  const id = process.argv[4];
  if (!id) throw new Error("Name a study: branch study run <id>");
  const result = await app.studies.run(id, { fresh: process.argv.includes("--fresh") });
  if (asJson) return void console.log([...studyLines(result)].join("\n"));
  console.log(studyTable(result));
  if (result.stoppedEarly) console.log(result.stoppedEarly);
}
async function loginChatGPT(app: Awaited<ReturnType<typeof createBranch>>): Promise<void> {
  const auth = app.chatgpt!;
  const prompt = await auth.startDeviceLogin();
  console.log(`\nTo connect your ChatGPT account:\n\n  1. Open ${prompt.verificationUrl}\n  2. Enter this code: ${prompt.userCode}\n\nWaiting for you to finish in the browser...`);
  const status = await finishChatGPTSignIn(app.runtime.models, auth, app.runtime.owner, app.userAgent);
  console.log(`Signed in${status.email ? " as " + status.email : ""}. ChatGPT models are now available.`);
}
/**
 * `branch daemon install|uninstall|status`: keeps the assistant's engine working in the background,
 * with no window, from the moment the owner signs in to Windows.
 */
async function runDaemonCommand(): Promise<void> {
  const action = (process.argv[3] ?? "status") as DaemonAction;
  if (!["install", "uninstall", "status"].includes(action))
    throw new Error("Usage: node dist/cli.js daemon install | uninstall | status");
  const executable = process.env.BRANCH_EXECUTABLE ?? process.execPath;
  const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
  const report = await daemonCommand(action, {
    executable,
    script: process.env.BRANCH_DAEMON_SCRIPT ?? fileURLToPath(new URL("cli.js", import.meta.url)),
    dataDir,
    workspace: resolve(process.env.BRANCH_WORKSPACE ?? "workspace"),
    port: Number(process.env.BRANCH_PORT ?? 3210),
    launcherPath: join(dataDir, daemonLauncherName),
  });
  console.log(report.message);
}
/** Refreshes a source checkout in place: pull, install exact dependencies, rebuild. */
function updateCheckout(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, ".git")))
    throw new Error("This copy was not installed from Git. Download the newest release from GitHub instead.");
  const steps: [string, string[]][] = [["git", ["pull", "--ff-only"]], ["npm", ["ci"]], ["npm", ["run", "build"]]];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  }
  console.log("Branch Agent is up to date. Restart it to use the new version.");
}
async function printDoctor(
  app: Awaited<ReturnType<typeof createBranch>>,
  dataDir: string,
): Promise<void> {
  if (process.argv.includes("--fix") || process.argv.includes("--repair")) {
    console.log(doctorText(await doctorFix({
      fix: true, workspace: app.runtime.workspace, port: Number(process.env.BRANCH_PORT ?? 3210),
      security: async () => (await app.security.check()).summary, // mac3/security-check
    })));
    return;
  }
  const probe = process.argv.includes("--probe");
  const health = await healthReport(app, { probeProvider: probe });
  // What each connection can actually do, asked of the service itself. Only with --probe, because
  // it means one small request per connection.
  const connections = probe
    ? await probeAll(app.runtime.models, app.web.policy, app.web.policy.guard(globalThis.fetch))
    : [];
  console.log(
    JSON.stringify(
      {
        health,
        node: process.version,
        sqlite: "opened",
        workspace: app.runtime.workspace,
        dataDir,
        provider: app.runtime.provider.name,
        modelPresets: [...app.runtime.models.presets.values()].map((preset) => ({
          id: preset.id, name: preset.name, provider: preset.provider.name, model: preset.model,
        })),
        connections,
        registeredTools: app.registry.permissions(),
        networkProviderTested: false,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
