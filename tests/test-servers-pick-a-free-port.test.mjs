import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

/*
 * A test that starts the app without saying which port listens on the default one, 3210. That is the
 * port the owner's own Branch Agent holds on this computer, so such a test fails there with
 * EADDRINUSE (tests/memory-context.test.mjs did), and on any other machine it would collide with the
 * next test to do the same. `port: 0` asks the system for a free one.
 *
 * The calls are found by parsing, not by pattern: a callback inside the options (`quit: () => {
 * quits++; }`) holds semicolons, and a pattern that stopped at the first one lost the whole call.
 */
const dir = import.meta.dirname;

/**
 * Line numbers of `startServer(...)` calls in `source` whose options do not say `port: 0` in so many
 * words. A fixed port (`port: 3210`, `port: 8080`) collides just the same, and a value held in a
 * variable (`{ port }`) cannot be read from here, so both count. The one exception is a real restart, which must come
 * back on the port the same test's first server was given by `port: 0`: its line says "same-port-restart".
 */
function portless(source, name = "test.mjs") {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const keyIsPort = (name) => (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "port";
  const isZero = (property) => ts.isPropertyAssignment(property) && keyIsPort(property.name)
    && ts.isNumericLiteral(property.initializer) && Number(property.initializer.text) === 0;
  /* The last word on `port` wins: a spread after it may bring a port of its own. */
  const names = (options) => {
    const last = options.properties.findLastIndex((property) => isZero(property) || ts.isSpreadAssignment(property)
      || (!ts.isSpreadAssignment(property) && property.name && keyIsPort(property.name)));
    return last >= 0 && isZero(options.properties[last]);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "startServer"
      && !/same-port-restart/.test(source.split("\n")[file.getLineAndCharacterOfPosition(node.getStart(file)).line] ?? "")) {
      const options = node.arguments[1];
      // Options built elsewhere cannot be read from here, so they count as not saying `port: 0`.
      if (!options || !ts.isObjectLiteralExpression(options) || !names(options))
        found.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("the guard finds a portless call whatever its options hold, and accepts one that names a port", () => {
  const caught = [
    "const s = await startServer(app);",
    "const s = await startServer(app, { dataDir });",
    "const s = await startServer(app, { dataDir, quit: () => { quits++; } });",
    "const s = await startServer(app, {\n  dataDir: join(root, 'data'),\n  onReady() { ready = true; },\n});",
    "const s = await startServer(app, options);",
    "const s = await startServer(app, { ...options });",
    "const s = await startServer(app, { dataDir, note: 'port: 0' });",
    "const s = await startServer(app, { dataDir, port: 3210 });",
    "const s = await startServer(app, { dataDir, port: 8080, quit: () => { quits++; } });",
    "const port = 0; const s = await startServer(app, { dataDir, port });",
    "const s = await startServer(app, { dataDir, port: free });",
    "const s = await startServer(app, { port: 0, ...options });",
    "const s = await startServer(app, { port: 0, dataDir, port: 3210 });",
  ];
  for (const source of caught) assert.deepEqual(portless(source), [1], `missed: ${source}`);
  const allowed = [
    "const s = await startServer(app, { dataDir, port: 0 });",
    "const s = await startServer(app, { dataDir, quit: () => { quits++; }, port: 0 });",
    "const s = await startServer(app, {\n  dataDir: join(root, 'data'),\n  onReady() { ready = true; },\n  port: 0,\n});",
    "const s = await startServer(app, { dataDir, \"port\": 0 });",
    "const s = await startServer(app, { ...options, port: 0 });",
    "// startServer(app, { dataDir });\nconst text = 'startServer(app)';",
    "const s = await startServer(app, { dataDir, port }); // same-port-restart",
  ];
  for (const source of allowed) assert.deepEqual(portless(source), [], `wrongly caught: ${source}`);
});

test("every test that starts the app asks for a port of its own", async () => {
  const found = [];
  let calls = 0;
  for (const name of (await readdir(dir)).filter((file) => /\.m?js$/.test(file))) {
    const source = await readFile(join(dir, name), "utf8");
    calls += (source.match(/\bstartServer\(/g) ?? []).length;
    for (const line of portless(source, name)) found.push(`${name}:${line}`);
  }
  assert.ok(calls > 40, `only ${calls} calls were found; the tests moved`);
  assert.deepEqual(found, [], "pass { port: 0 } to startServer so the test never takes the default port");
});
