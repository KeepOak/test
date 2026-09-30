/**
 * A stand-in engine for the gateway tests. It opens no database and touches nothing outside its
 * own process: it answers a few addresses, says it is ready (or misbehaves as FAKE_MODE asks), and
 * closes when the gateway asks or goes away. It refuses to run outside a temporary folder.
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { joinGateway } from "../../dist/never-break/worker-link.js";

const dataDir = realpathSync(resolve(process.env.BRANCH_DATA_DIR ?? "/"));
if (!dataDir.startsWith(realpathSync(tmpdir()))) { console.error("refusing: data folder is not temporary"); process.exit(9); }
const mode = process.env.FAKE_MODE ?? "";
if (mode === "crash-start" || process.env.BRANCH_PROVIDER === "never-break-crash") process.exit(3);

const link = joinGateway();
let port = 0;
const server = createServer((request, response) => {
  if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403); response.end("wrong host"); return; }
  if (request.url === "/api/state") { response.end(JSON.stringify({ version: process.env.FAKE_VERSION ?? "9.9.9", pid: process.pid })); return; }
  if (request.url === "/api/headers") { response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, ask: request.headers["x-branch-ask"] ?? null })); return; }
  if (request.url === "/api/echo") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => response.end(JSON.stringify({ body, origin: request.headers.origin ?? null })));
    return;
  }
  // As Restart the engine does (src/dashboard-api.ts restartEngine): stop with exit code 75 to be started again.
  if (request.url === "/api/dashboard/restart" && request.method === "POST") {
    response.end(JSON.stringify({ restarting: true }));
    setTimeout(() => process.exit(75), 50);
    return;
  }
  if (request.url === "/api/deployment/close" && request.method === "POST") {
    response.end("{}");
    setTimeout(() => process.exit(0), 50);
    return;
  }
  response.writeHead(404); response.end("{}");
});
const tunnels = new Set();
server.on("upgrade", (request, socket) => {
  tunnels.add(socket);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");
  socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
});
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  if (mode === "never-ready") return;
  if (mode === "future-contract") {
    process.send?.({ type: "ready", contract: 99, accepts: [99, 99], port, version: "99.0.0", pid: process.pid });
    return;
  }
  link?.ready(port, process.env.FAKE_VERSION ?? "9.9.9");
});
link?.onStop(() => new Promise((done) => {
  server.close(() => done());
  server.closeAllConnections();
  for (const socket of tunnels) socket.destroy();
}));
