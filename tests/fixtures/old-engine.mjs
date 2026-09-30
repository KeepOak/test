/**
 * A stand-in for a background engine from a version before the engine's proof (src/engine-proof.ts), keeping that
 * version's contract: the note in the data folder names it; it answers the window's key and nothing else; it has no
 * proof to give; and it closes when asked the way `branch quit` asks (src/install/quit.ts). It writes each request it
 * hears, with whether it carried the key, to heard.jsonl in the data folder. It refuses to run outside a temporary folder.
 * Usage: node old-engine.mjs <port>, with BRANCH_DATA_DIR set.
 */
import { createServer } from "node:http";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = realpathSync(resolve(process.env.BRANCH_DATA_DIR ?? "/"));
const temporary = [tmpdir(), process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp") : tmpdir()].map((dir) => realpathSync(dir));
if (!temporary.some((dir) => dataDir.startsWith(dir))) { console.error("refusing: data folder is not temporary"); process.exit(9); }
const port = Number(process.argv[2]);
const key = readFileSync(join(dataDir, "session-token"), "utf8").trim();
const server = createServer((request, response) => {
  const withKey = request.headers.authorization === `Bearer ${key}`;
  appendFileSync(join(dataDir, "heard.jsonl"), `${JSON.stringify({ path: new URL(request.url, "http://x").pathname, method: request.method, withKey })}\n`);
  if (!withKey) { response.writeHead(401).end("{}"); return; }
  const path = new URL(request.url, "http://x").pathname;
  if (path === "/api/state") { response.end(JSON.stringify({ version: "0.0.1" })); return; }
  if (path === "/api/deployment/quit" && request.method === "POST") {
    response.end(JSON.stringify({ closing: true, pid: process.pid }));
    setTimeout(() => { server.close(); server.closeAllConnections(); process.exit(0); }, 200);
    return;
  }
  response.writeHead(404).end("{}");
});
server.listen(port, "127.0.0.1", () => {
  writeFileSync(join(dataDir, "running.json"), JSON.stringify({ port, pid: process.pid, url: `http://127.0.0.1:${port}`, mode: "daemon",
    version: "0.0.1", startedAt: new Date().toISOString() }));
  console.log("ready");
});
