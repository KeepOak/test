/* The desktop engine's process (dist/desktop/engine-process.js) run under plain Node for tests: Node's own IPC channel
   stands in for Electron's parentPort, so a test can play the window's main process without starting Electron. */
process.parentPort = {
  on: (_event, listener) => process.on("message", (data) => listener({ data })),
  postMessage: (message) => process.send(message),
};
await import("../../dist/desktop/engine-process.js");
