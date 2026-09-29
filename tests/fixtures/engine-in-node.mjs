/* The desktop engine's process (dist/desktop/engine-process.js) run under plain Node for tests: Node's own IPC channel
   stands in for Electron's parentPort, so a test can play the window's main process without starting Electron. */
import { pathToFileURL } from "node:url";
process.parentPort = {
  on: (_event, listener) => process.on("message", (data) => listener({ data })),
  postMessage: (message) => process.send(message),
};
/* hot-update: a live build's engine is started from its own folder (BRANCH_TEST_ENGINE_FILE), as main starts it. */
const own = process.env.BRANCH_TEST_ENGINE_FILE;
await import(own ? pathToFileURL(own).href : "../../dist/desktop/engine-process.js");
