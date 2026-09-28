// A scripted stand-in for OpenAI's `codex`, for tests/trunk-add-account.test.mjs only: `login status`, `login` (it
// "finishes" by itself, as the real one does once the owner signs in on its page) and `exec --json -`. It keeps its
// sign-in as a file in CODEX_HOME, refuses to run without CODEX_HOME, and logs every start beside itself.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), dir = process.env.CODEX_HOME;
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex-log.jsonl"), JSON.stringify({ args, dir: dir ?? null }) + "\n");
if (!dir) process.exit(2);
const signedIn = join(dir, "fixture-signed-in");
if (args[0] === "login" && args[1] === "status") { process.stdout.write(existsSync(signedIn) ? "Logged in using ChatGPT\n" : "Not logged in\n"); process.exit(existsSync(signedIn) ? 0 : 1); }
if (args[0] === "login") { await new Promise((done) => setTimeout(done, 300)); writeFileSync(signedIn, "yes"); process.exit(0); }
if (args[0] === "exec") {
  process.stdin.resume(); await new Promise((done) => process.stdin.on("end", done));
  if (!existsSync(signedIn)) process.exit(1);
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\n");
  process.exit(0);
}
process.exit(3);
