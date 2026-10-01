/** Isolated account-check authority: scripted DNS/password and actual IMAP code over VM-owned sockets. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { HealthCheck, withHealthCheck, assertHealthCurrent, currentHealthCheck } from "../dist/health-check.js";
import { healthChanged } from "../dist/health-changes.js";
import { MailSearch } from "../dist/personal/mail-search.js";

const owner = "fixture-owner";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const source = await readFile(new URL("../src/channels/mail-client.ts", import.meta.url), "utf8");
// Remove imports structurally; all production methods, including private open/command, remain intact.
const tree = ts.createSourceFile("mail-client.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const isolated = ts.createPrinter().printFile(ts.factory.updateSourceFile(tree,
  tree.statements.filter(node => !ts.isImportDeclaration(node))));
const code = ts.transpileModule(isolated, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function authority() {
  const profiles = new Set(), locks = new Set(), projects = new Set();
  let scope = "owner:original", project = "default", locked = false;
  const records = new Map([
    ["personal-mail-search", { mode: "when-needed" }],
    ["personal-mail-search-settings", { host: "mail.invalid", user: "fixture-user" }],
  ]);
  let credentials = [{ project: "default", name: "EMAIL_PASSWORD", iv: "fake", tag: "fake", ciphertext: "fake" }];
  const subscribe = (set, fn) => { set.add(fn); return () => set.delete(fn); };
  const sqlite = { prepare(sql) {
    if (sql.startsWith("SELECT id,data FROM settings")) return { all: () => [...records].map(([id, data]) => ({ id, data: JSON.stringify(data) })) };
    if (sql.startsWith("SELECT project,name,hex(iv)")) return { all: () => credentials };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  } };
  const store = {
    sqlite, get(_table, _owner, id) { const data = records.get(id); return data ? { data } : undefined; },
    profiles: { scope: () => scope, isOwner: () => scope.startsWith("owner:"), onSwitched: fn => subscribe(profiles, fn) },
    projects: { active: () => ({ id: project }), onSwitched: fn => subscribe(projects, fn) },
  };
  const lock = { locked: () => locked, onLocked: fn => subscribe(locks, fn) };
  const roundTrip = kind => {
    if (kind === "profile") { scope = "guest:other"; for (const fn of profiles) fn(); scope = "owner:original"; }
    if (kind === "lock") { locked = true; for (const fn of locks) fn(); locked = false; }
    if (kind === "project") { project = "other"; for (const fn of projects) fn(owner); project = "default"; }
    if (kind === "settings") {
      const original = records.get("personal-mail-search"); records.set("personal-mail-search", { mode: "off" });
      healthChanged(sqlite, { kind: "setting", owner, id: "personal-mail-search" }); records.set("personal-mail-search", original);
    }
    if (kind === "password") {
      const original = credentials; credentials = [{ ...original[0], ciphertext: "replacement" }];
      healthChanged(sqlite, { kind: "credential", owner, project: "default", id: "EMAIL_PASSWORD" }); credentials = original;
    }
  };
  return { store, lock, roundTrip, subscriptions: () => profiles.size + locks.size + projects.size };
}

function sockets(stage, readOnly = true) {
  const reached = deferred(), resume = deferred();
  const owned = [], tlsOptions = [], timers = new Map();
  let timerId = 0, clock = 1_000;
  class FakeSocket extends EventEmitter {
    commands = []; destroyed = false;
    setEncoding(value) { assert.equal(value, "latin1"); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
    write(line) {
      assert.equal(this.destroyed, false, "no writes after abort");
      this.commands.push(line.trim());
      const [tag, command] = line.trim().split(" ");
      assert.ok(["LOGIN", "EXAMINE", "LOGOUT"].includes(command), `health must not issue ${command}`);
      const response = `${tag} OK ${command === "EXAMINE" ? (readOnly ? "[READ-ONLY]" : "[READ-WRITE]") : "done"}\r\n`;
      if (stage === command) { reached.resolve(); resume.promise.then(() => { if (!this.destroyed) this.emit("data", response); }); }
      else queueMicrotask(() => { if (!this.destroyed) this.emit("data", response); });
      return true;
    }
  }
  const connect = options => {
    tlsOptions.push(options);
    const socket = new FakeSocket(); owned.push(socket);
    const connected = () => {
      if (socket.destroyed) return;
      socket.emit("secureConnect");
      queueMicrotask(() => {
        if (stage === "greeting") { reached.resolve(); resume.promise.then(() => { if (!socket.destroyed) socket.emit("data", "* OK fixture\r\n"); }); }
        else if (!socket.destroyed) socket.emit("data", "* OK fixture\r\n");
      });
    };
    if (stage === "connect") { reached.resolve(); resume.promise.then(connected); }
    else queueMicrotask(connected);
    return socket;
  };
  const exports = {};
  const sandbox = {
    exports, Buffer, assertHealthCurrent, currentHealthCheck, tlsConnect: connect,
    netConnect() { throw new Error("health must use TLS"); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date: class extends Date { static now() { return clock; } },
  };
  vm.runInNewContext(code, sandbox, { filename: "mail-client.fixture.js" });
  // Unrelated standing client must never be destroyed by check cancellation.
  const unrelated = new FakeSocket();
  return { ImapClient: exports.ImapClient, owned, unrelated, tlsOptions, reached, resume,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } } };
}

function scenario(stage, readOnly = true) {
  const auth = authority(), transport = sockets(stage, readOnly), reached = deferred(), resume = deferred();
  const calls = { dns: 0, password: 0, clients: 0, close: 0, abort: 0 };
  const mail = new MailSearch({ store: auth.store, owner, files: {},
    async assertHost(host, port) {
      calls.dns++; assert.equal(host, "mail.invalid"); assert.equal(port, 993);
      if (stage === "DNS") { reached.resolve(); await resume.promise; }
    },
    async secret(name) {
      calls.password++; assert.equal(name, "EMAIL_PASSWORD");
      if (stage === "password") { reached.resolve(); await resume.promise; }
      return "synthetic-fixture-password";
    },
    imap(server) {
      calls.clients++;
      assert.equal(server.tls, undefined, "production default is TLS");
      const client = new transport.ImapClient({ ...server, timeoutMs: 20 });
      const close = client.close.bind(client), abort = client.abort.bind(client);
      client.close = async () => { calls.close++; return close(); };
      client.abort = () => { calls.abort++; abort(); };
      return client;
    },
  });
  const check = new HealthCheck(auth.store, owner, auth.lock);
  const run = () => withHealthCheck(check, () => mail.test());
  return { ...auth, ...transport, check, calls, run,
    reached: ["DNS", "password"].includes(stage) ? reached : transport.reached,
    resume: ["DNS", "password"].includes(stage) ? resume : transport.resume };
}

for (const kind of ["profile", "lock", "project", "settings", "password"]) {
  for (const stage of ["DNS", "password", "connect", "greeting", "LOGIN", "EXAMINE"]) {
    test(`${kind} round trip during ${stage} irreversibly revokes mail health`, async () => {
      const f = scenario(stage);
      const pending = f.run();
      const rejected = assert.rejects(pending, error => error === f.check.signal.reason);
      await f.reached.promise;
      const commands = f.owned.flatMap(socket => socket.commands);
      f.roundTrip(kind);
      assert.equal(f.check.signal.aborted, true);
      f.resume.resolve();
      await rejected;
      assert.deepEqual(f.owned.flatMap(socket => socket.commands), commands, "revocation cannot issue a later LOGIN/EXAMINE or become healthy");
      assert.equal(f.unrelated.destroyed, false);
      assert.ok(f.owned.every(socket => socket.destroyed), "every test-owned socket is closed");
      assert.equal(f.calls.clients, ["DNS", "password"].includes(stage) ? 0 : 1);
      if (stage === "DNS") assert.equal(f.calls.password, 0, "revoked DNS cannot borrow a password");
      if (f.calls.clients) { assert.equal(f.calls.abort, 1); assert.equal(f.calls.close, 1); }
      assert.equal(f.subscriptions(), 0, "request subscriptions released");
      for (const options of f.tlsOptions) { assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, "mail.invalid"); }
    });
  }
}

test("valid mail health uses certificate-verified TLS, LOGIN, mandatory read-only EXAMINE, then LOGOUT", async () => {
  const f = scenario("none");
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.owned[0].commands, ['b1 LOGIN "fixture-user" "synthetic-fixture-password"', "b2 EXAMINE INBOX", "b3 LOGOUT"]);
  assert.equal(f.tlsOptions[0].rejectUnauthorized, true);
  assert.equal(f.owned[0].destroyed, true);
  assert.equal(f.unrelated.destroyed, false);
  assert.equal(f.calls.close, 1);
  assert.equal(f.subscriptions(), 0);
});

test("an EXAMINE reply without READ-ONLY cannot report healthy and still logs out", async () => {
  const f = scenario("none", false);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.checks[0].reason, /could not be verified/);
  assert.equal(f.owned[0].commands.at(-1), "b3 LOGOUT");
  assert.equal(f.owned[0].destroyed, true);
});

test("a fake TLS connect timeout closes its own socket and cannot report healthy", async () => {
  const f = scenario("connect");
  const pending = f.run();
  await f.reached.promise;
  f.advance(21);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(f.owned[0].commands, []);
  assert.equal(f.owned[0].destroyed, true);
  assert.equal(f.unrelated.destroyed, false);
  assert.equal(f.subscriptions(), 0);
});

for (const stage of ["greeting", "LOGIN", "EXAMINE"]) {
  test(`a fake ${stage} response timeout cannot report healthy and keeps LOGOUT cleanup`, async () => {
    const f = scenario(stage);
    const pending = f.run();
    await f.reached.promise;
    f.advance(21);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(f.owned[0].commands.at(-1).split(" ")[1], "LOGOUT");
    assert.equal(f.owned[0].destroyed, true);
    assert.equal(f.unrelated.destroyed, false);
    assert.equal(f.subscriptions(), 0);
  });
}

test("revocation while LOGOUT settles cannot return an already prepared healthy result", async () => {
  const f = scenario("LOGOUT");
  const pending = f.run();
  const rejected = assert.rejects(pending, error => error === f.check.signal.reason);
  await f.reached.promise;
  f.roundTrip("lock");
  f.resume.resolve();
  await rejected;
  assert.equal(f.check.signal.aborted, true);
  assert.equal(f.owned[0].destroyed, true);
  assert.equal(f.unrelated.destroyed, false);
  assert.equal(f.calls.abort, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.subscriptions(), 0);
});
