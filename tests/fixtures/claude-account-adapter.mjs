// Existing account scenarios run their scripted answers through the native protocol fixture.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { answerFrom, rowFor } from "../../dist/providers/cli-agent.js";
import { discardTemp } from "../temp-dir.mjs";
export async function fakeClaudeAccounts(t, service) {
  const bin = await mkdtemp(join(tmpdir(), "claude-native-fixture-bin-")), before = process.env.PATH;
  await writeFile(join(bin, "claude"), "", { mode: 0o755 }); await writeFile(join(bin, "claude.cmd"), "");
  process.env.PATH = bin + (process.platform === "win32" ? ";" : ":") + before;
  t.after(async () => { process.env.PATH = before; await discardTemp(bin); });
  const status = service.deps.statusRun;
  service.deps.statusRun = async (row, args, env) => row.id !== "claude-code" ? status(row, args, env)
    : { code: 0, missing: false, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
  const launches = new Map();
  service.deps.claudeSubscription = {
    spawn: (_command, args, invocation) => {
      launches.set(invocation.env.ANTHROPIC_BASE_URL, { args, home: invocation.env.CLAUDE_CONFIG_DIR, rates: join(invocation.cwd, "fixture-rates.json") });
      return spawn(process.execPath, [resolve("tests/fixtures/claude-subscription-native.mjs"), ...args], { ...invocation,
        env: { ...invocation.env, BRANCH_NATIVE_FIXTURE_RELAY: invocation.env.ANTHROPIC_BASE_URL, BRANCH_NATIVE_FIXTURE_RATES: join(invocation.cwd, "fixture-rates.json") } });
    },
    connect: async (headers, payload, _query, signal) => {
      const body = JSON.parse(payload), launch = launches.get(headers["x-branch-fixture-relay"]);
      if (!launch) throw new Error("native fixture launch is missing");
      const row = { ...rowFor({ id: "claude-code" }), args: launch.args };
      const prompt = body.messages.map((message) => message.role + ": " + message.content.map((part) => part.text ?? part.content ?? "").join("\n")).join("\n\n");
      const home = launch.home === service.primaryClaudeHome ? undefined : { name: "CLAUDE_CONFIG_DIR", path: launch.home };
      const result = await service.deps.spawnAgent(row, prompt, signal, { timeoutMs: 180000, maxOutputChars: 100000 }, home);
      if (result.code !== 0 && /usage limit|rate limit|quota/i.test(result.stdout + result.stderr)) return new Response("", { status: 429 });
      if (result.code !== 0) return new Response("", { status: 401 });
      const text = answerFrom(row, result.stdout), start = { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } };
      const rateLines = result.stdout.split("\n").filter((line) => { try { return JSON.parse(line).type === "rate_limit_event"; } catch { return false; } });
      const said = [start, { type: "content_block_start", index: 0, content_block: { type: "text", text } }, { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
      await writeFile(launch.rates, JSON.stringify(rateLines));
      return new Response(said.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
  service.rewrap();
}
