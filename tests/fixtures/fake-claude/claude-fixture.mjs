// A scripted stand-in for Anthropic's `claude` program, for tests/trunk-add-account.test.mjs only. It answers the three
// commands Branch starts (auth status, auth login, -p) in the shapes the real program documents, keeps its "sign-in" as a
// file in CLAUDE_CONFIG_DIR, and writes every start to claude-log.jsonl beside itself (Branch gives it a clean environment). It refuses to run without CLAUDE_CONFIG_DIR, so
// a test can never reach the real program's own folder through it.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const args = process.argv.slice(2), dir = process.env.CLAUDE_CONFIG_DIR;
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "claude-log.jsonl"), JSON.stringify({ args, dir: dir ?? null }) + "\n");
if (!dir) { process.stderr.write("fixture: no CLAUDE_CONFIG_DIR\n"); process.exit(2); }
const signedIn = join(dir, "fixture-signed-in");
const line = () => new Promise((done) => { const input = createInterface({ input: process.stdin }); input.once("line", (text) => { done(text); input.close(); }); input.once("close", () => done("")); });

if (args[0] === "auth" && args[1] === "status") {
  const on = existsSync(signedIn);
  process.stdout.write(JSON.stringify(on ? { loggedIn: true, authMethod: "claude.ai", email: "owner@example.test", orgName: "Fixture Org" } : { loggedIn: false }));
  process.exit(on ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login") {
  const back = encodeURIComponent("https://platform.claude.com/oauth/code/callback");
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write(`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&redirect_uri=${back}&state=FIXTURESTATE\n`);
  const pasted = await line();
  if (pasted.trim() !== "FIXTURECODE#FIXTURESTATE") {
    appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "claude-log.jsonl"), JSON.stringify({ wrongCode: pasted.length }) + "\n");
    process.exit(1);
  }
  writeFileSync(signedIn, "yes");
  process.stdout.write("Login successful.\n");
  process.exit(0);
}
if (args[0] === "-p") {
  await line();
  if (!existsSync(signedIn)) { process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }) + "\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\n");
  process.exit(0);
}
process.stderr.write(`fixture: unknown command ${args.join(" ")}\n`);
process.exit(3);
