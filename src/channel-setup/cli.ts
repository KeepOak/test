import { createInterface } from "node:readline/promises";
import { connect as attach, type Client } from "../cli-attach.js";
import type { FeatureMode } from "../feature-switches.js";
import { connectUsage, runConnect, type ConnectBackend, type ConnectIo, type SaveAnswer } from "./command.js";
import { openPastePage } from "./paste-page.js";
import { systemProbe, systemRunner } from "./platform.js";
import { recipeFor } from "./recipes.js";
import { saveSetup, saveSetupMode, setupMode } from "./service.js";

/**
 * The real terminal and the real Branch behind `branch connect`. When Branch is already running, the
 * command goes through the same door as the window (the data folder's own key), so the bot can be
 * connected and paired straight away. Otherwise it opens this launch's own copy of the saved work.
 */
async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  try { return await lines.question(question); } finally { lines.close(); }
}

/** Reads one line with nothing shown on screen, not even stars. Ctrl+C stops the command. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(question);
    let typed = "";
    const finish = (error?: Error) => {
      input.setRawMode(false); input.pause(); input.off("data", onData); process.stdout.write("\n");
      if (error) reject(error); else resolve(typed);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Stopped."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") typed = typed.slice(0, -1);
        else if (character >= " ") typed += character;
      }
    };
    input.setRawMode(true); input.resume(); input.on("data", onData);
  });
}

function terminalIo(): ConnectIo {
  const canHide = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return { platform: process.platform, runner: systemRunner, probe: systemProbe(), write: (line) => console.log(line),
    ask, askHidden, canHide, pastePage: (recipe) => openPastePage(recipe), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };
}

function attachedBackend(client: Client): ConnectBackend {
  return {
    mode: async () => (await client.get<{ mode: FeatureMode }>("/api/channel-setup")).mode,
    setMode: async (mode) => { await client.post("/api/channel-setup", { mode }); },
    save: (id, values, enable) => client.post<SaveAnswer>(`/api/channel-setup/${id}/check`, { values, ...(enable ? { enable } : {}) }, 60_000),
    approvePairing: async (code) => { await client.post("/api/channels/pairings/approve", { code }); },
  };
}

async function localBackend(dataDir: string, workspace: string): Promise<{ backend: ConnectBackend; close: () => Promise<void> }> {
  const { createBranch } = await import("../index.js");
  // Saving a chat app's setup asks no model, so none is named here.
  const app = await createBranch({ workspace, dataDir, presets: [] });
  const owner = app.runtime.owner;
  // No `connect` here: this launch ends with the command, so the bot connects when Branch next starts.
  const host = { store: app.store, owner, fetch: app.web.policy.guard(globalThis.fetch), telegram: { save: app.neverBreak.telegram.save } };
  const backend: ConnectBackend = {
    mode: async () => setupMode(app.store, owner),
    setMode: async (mode) => { saveSetupMode(app.store, owner, { mode }); },
    save: async (id, values, enable) => {
      const answer = await saveSetup(host, id, { values, enable }) as unknown as SaveAnswer;
      return { ...answer, connectNote: enable && enable !== "off" ? "Branch is not running: it connects the next time it starts." : null };
    },
  };
  return { backend, close: () => app.close() };
}

/** `branch connect <app>`: the exit code. */
export async function connectCommand(words: string[], options: { dataDir: string; workspace: string }): Promise<number> {
  if (!words[0] || !recipeFor(words[0])) { console.log(connectUsage()); return 2; }
  const io = terminalIo();
  const client = await attach(options.dataDir).catch(() => null);
  if (client) return runConnect(words[0], io, attachedBackend(client));
  const local = await localBackend(options.dataDir, options.workspace);
  try { return await runConnect(words[0], io, local.backend); } finally { await local.close(); }
}
