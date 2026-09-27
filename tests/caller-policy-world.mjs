/**
 * One engine with a real key for every kind of caller that can reach it over HTTP, and the matrix of who may call
 * each route: every route written in src/ (tests/short-lived-key-routes.mjs) × every caller × each state the whole
 * engine can be in (the window on the owner or on a household person, Lockdown off or on, the App lock locked).
 *
 * The engine is started with `policyProbe`, so a request that gets past every check about who is calling is answered
 * 204 where the route's own code would begin, and nothing is run. What comes back is either that 204 or the refusal
 * the caller would really get (its status and its sentence).
 *
 * Used by tests/caller-policy.test.mjs, and by design/redesign/tools/write-caller-policy-golden.mjs to write
 * tests/caller-policy.golden.txt.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, policyProbeHeader } from "../dist/server.js";
import { phoneSessionText } from "../dist/devices/book.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

/** The callers that can arrive over HTTP, in the order the golden file lists them. */
export const KINDS = ["here", "remote", "phone", "legacy", "person", "read", "run", "nobody"];
/** The engine's states, and which callers each is asked with (the window's switch changes only some of them). */
export const STATES = [
  { name: "owner", lockdown: false, household: false, kinds: KINDS },
  { name: "owner+lockdown", lockdown: true, household: false, kinds: KINDS },
  { name: "household", lockdown: false, household: true, kinds: ["here", "remote", "read", "run"] },
  { name: "household+lockdown", lockdown: true, household: true, kinds: ["here", "remote", "read", "run"] },
  { name: "applock", lockdown: false, household: false, locked: true, kinds: ["here"] },
];

/** Every route a caller is asked about: prefixes and the routes answered before any key is read are left out. */
export function probedRoutes() {
  const found = [];
  for (const [path, value] of Object.entries(ROUTES)) {
    const { kind, methods } = entry(value);
    if (kind === "prefix" || kind === "pre-auth" || /[[\]{}()\\|?*+^$]/.test(path)) continue;
    const asked = [...new Set(["GET", ...methods, ...(methods.length ? [] : ["POST"])])];
    for (const method of asked) found.push({ method, path });
  }
  return found;
}

function phoneKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

/** An engine on loopback, its paired door on a spare loopback port, and a key for every caller. */
export async function world() {
  const root = await mkdtemp(join(tmpdir(), "branch-caller-policy-"));
  const dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0, policyProbe: true, authLimits: { attempts: 1_000_000 } });
  const host = new URL(server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  const doorBase = `http://127.0.0.1:${door.address().port}`;
  const close = async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await server.close(); await app.close(); await discardTemp(root);
  };
  const call = async (method, path, body, key = server.token, base = server.url, extra = {}) => {
    const response = await fetch(base + path, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text };
  };
  const must = async (what, answer) => {
    const got = await answer;
    if (got.status !== 200) throw new Error(`${what}: ${got.status} ${got.text}`);
    return got.body;
  };
  await must("phones may pair", call("POST", "/api/devices/mode", { mode: "when-needed" }));
  await must("people may sign in", call("POST", "/api/people/settings", { mode: "on" }));
  const pair = async (name) => {
    const invite = await must("invite", call("POST", "/api/devices/invite", { phone: true }));
    const key = phoneKey();
    const { requestId } = (await call("POST", "/api/devices/pair",
      { offer: invite.id, code: invite.code, name, platform: "android", publicKey: key.publicKey, offers: [] }, null)).body;
    await must("approve", call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true }));
    const session = (await call("POST", "/api/devices/pair/session", { requestId, signature: key.sign(phoneSessionText(requestId)) }, null)).body;
    return { token: session.token, headers: { "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey } };
  };
  const phone = await pair("Own-key phone");
  const legacy = await pair("Legacy phone");
  // A phone paired before phones had keys of their own: it holds the window's key, and its record has none.
  const saved = app.store.get("settings", app.runtime.owner, "remote-devices").data;
  app.store.save("settings", app.runtime.owner, "remote-devices", { ...saved,
    devices: saved.devices.map((each) => (each.id === legacy.headers["x-branch-device"] ? (({ keyFingerprint, ...rest }) => rest)(each) : each)) });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const personKey = app.people.keys.issue(sam.id, 600, "pin", "caller-policy").key;
  const read = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 600 }).token;
  const run = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 600 }).token;
  const callers = {
    here: { key: server.token, base: server.url, headers: {} },
    remote: { key: server.token, base: server.url, headers: { "x-branch-tunnel": "1" } },
    phone: { key: phone.token, base: doorBase, headers: phone.headers },
    legacy: { key: server.token, base: doorBase, headers: legacy.headers },
    person: { key: personKey, base: server.url, headers: {} },
    read: { key: read, base: server.url, headers: {} },
    run: { key: run, base: server.url, headers: {} },
    nobody: { key: null, base: server.url, headers: {} },
  };
  /** Puts the whole engine into one state, from any other. */
  const enter = async (state) => {
    if ((await call("GET", "/api/lock")).body.locked) await must("unlock", call("POST", "/api/lock/unlock", { pin: "13579" }));
    await must("back to the owner", call("POST", "/api/profiles/switch", { profileId: null, pin: "2468" }));
    await must("Lockdown", call("POST", "/api/lockdown", { on: state.lockdown }));
    if (state.household) await must("to Sam", call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" }));
    if (state.locked) {
      await must("App lock PIN", call("POST", "/api/lock/pin", { pin: "13579" }));
      await must("lock", call("POST", "/api/lock", {}));
    }
  };
  /** One probe: "ok" when every check about the caller let it through, otherwise its status and sentence. */
  const probe = async (kind, method, path) => {
    const who = callers[kind];
    const response = await fetch(who.base + path.replaceAll(":id", SAMPLE_ID), {
      method, headers: { [policyProbeHeader]: "1", ...(who.key ? { authorization: `Bearer ${who.key}` } : {}), ...who.headers },
    });
    const text = await response.text();
    if (response.status === 204) return "ok";
    let error = text;
    try { error = JSON.parse(text).error ?? text; } catch { /* not JSON */ }
    return `${response.status} ${String(error).replace(/\s+/g, " ").trim()}`;
  };
  return { app, server, call, enter, probe, close };
}

/** Runs `work` over `items`, `width` at a time, keeping their order. */
export async function pool(items, width, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]); }
  }));
  return out;
}

/**
 * The whole matrix, as golden-file lines: one line per state, method and route, each caller's answer on it.
 * Sentences are named once at the top by a short hash of their words, so a change of wording and a change of who
 * may call read differently in a diff.
 */
export async function matrix(w, { routes = probedRoutes(), states = STATES } = {}) {
  const rows = [];
  for (const state of states) {
    await w.enter(state);
    const answers = await pool(routes, 12, async ({ method, path }) => {
      const each = [];
      for (const kind of state.kinds) each.push([kind, await w.probe(kind, method, path)]);
      return { state: state.name, method, path, each };
    });
    rows.push(...answers);
  }
  await w.enter({ lockdown: false, household: false });
  return rows;
}

/** The golden file's text: the sentences, then one line per state, method and route. */
export function goldenText(rows) {
  const sentences = new Map();
  const code = (answer) => {
    if (answer === "ok") return "ok";
    const [status, ...words] = answer.split(" ");
    const sentence = words.join(" ");
    if (!sentences.has(sentence)) sentences.set(sentence, createHash("sha256").update(sentence).digest("hex").slice(0, 6));
    return `${status}/${sentences.get(sentence)}`;
  };
  const lines = rows.map(({ state, method, path, each }) =>
    `${state} ${method} ${path} | ${each.map(([kind, answer]) => `${kind}=${code(answer)}`).join(" ")}`);
  const header = [...sentences].map(([sentence, id]) => `# ${id} ${sentence}`).sort();
  return [...header, ...lines].join("\n") + "\n";
}
