/* Every POST route the engine serves, sent a malformed body that carries a secret-looking value: whatever it refuses
   with is plain words, never Zod's own wording or its JSON issue dump, and never the value that was sent. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SECRET = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"; // not-a-real-secret
const BAD = { zzSecretKey: SECRET, name: 12345, enabled: SECRET };

/* Routes never called, even with a body they should refuse: a schema with only optional fields would let the malformed
   body through and the route would act. These leave this computer (network, other programs, the OS) or end the engine. */
const NEVER = [
  [/quit|restart|remove-branch|uninstall|\/updates\/|update-plan|update-readiness|\/registry\//, "stops, removes or updates Branch"],
  [/\/deployment\//, "changes how Branch is installed and started (autostart, daemon, phone door)"],
  [/keychain|os-permissions|os-sandbox|firewall|lockdown|host-bridge|linux-desktop|\/terminal|code-run|coding\/shell|\/usb\//, "touches the operating system"],
  [/local-models|\/voice\/|panels\/screen|\/browser\/|runtime\/start|machines\/start|tunnel|phone-app/, "starts programs, the mic or the screen"],
  [/send|publish|pull|download|install|market|oauth|sign-?in|login|logout|\/test$|probe|\/try$|\/arena|\/research|\/sync|\/pair|invite|\/join|devices\/find|\/remote/, "reaches the network or another device"],
  [/diagnostics\/report|analytics|counters|brief\/play|x\/search|home\/states/, "sends a report out or reaches a service"],
];
/* Features that ship off refuse with a 409 before reading the body; they are switched on (never loosening anything)
   and their routes asked again. Reach stays off: switching it on starts its relay. */
const SWITCHES = ["/api/asks/switch", "/api/flows-boards/switch", "/api/personal/switch", "/api/learning-more/switch", "/api/interop/switch"];
const skipReason = (path) => NEVER.find(([pattern]) => pattern.test(path))?.[1];

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(path, out); else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every exact /api/… path the engine's source names; prefixes (ending in "/") and patterns are left out. */
async function enginePaths() {
  const paths = new Set();
  for (const file of await sourceFiles("src"))
    for (const match of (await readFile(file, "utf8")).matchAll(/["'`](\/api\/[A-Za-z0-9/_.-]*[A-Za-z0-9_-])(?=["'`])/g))
      paths.add(match[1]);
  return [...paths].sort();
}

const ZOD = /Too small|Too big|Invalid input|Unrecognized key|expected [a-z]+, received|"code":|"path":/;
/* validationText's own sentence for a wrong type ("\"x\" is not valid: expected boolean, received string.") is plain
   words that name the field and the type it needs; only the raw forms around it are Zod's. */
const withoutPlainSentences = (text) => text.replace(/is not valid: expected [a-z ]+, received [a-z]+\./g, "");

test("every POST route refuses a malformed body in plain words, without the value it was sent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-every-route-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  const skipped = [], called = [], problems = [];
  const all = await enginePaths();
  for (const path of all) { if (skipReason(path)) skipped.push(path); else called.push(path); }
  const probe = async (path) => {
    const response = await fetch(new URL(path, server.url), {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(BAD),
    }).catch((error) => ({ status: 0, text: async () => String(error) }));
    if (response.status < 400 || response.status >= 500) return { path, status: response.status };
    const raw = await response.text();
    let error = raw;
    try { const parsed = JSON.parse(raw); error = typeof parsed?.error === "string" ? parsed.error : JSON.stringify(parsed?.error ?? parsed); } catch { /* not JSON */ }
    const wrong = [];
    if (ZOD.test(withoutPlainSentences(error))) wrong.push("zod wording");
    if (/^\s*[[{]/.test(error)) wrong.push("a JSON dump");
    if (/sk-live|4f9a8b7c/.test(raw)) wrong.push("the sent value");
    if (wrong.length) problems.push(`${path} ${response.status}: ${wrong.join(", ")}: ${error.slice(0, 160)}`);
    return { path, status: response.status };
  };
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const probeAll = async (paths) => {
    const results = [];
    for (let i = 0; i < paths.length; i += 8) results.push(...await Promise.all(paths.slice(i, i + 8).map(probe)));
    return results;
  };
  const first = await probeAll(called);
  // Every part of each switched-off feature on, named from the switch's own refusal of a part it does not have.
  for (const path of SWITCHES) {
    const parts = /must be one of: ([^.]+)\./.exec((await post(path, { part: "zz", mode: "on" })).body.error ?? "")?.[1].split(", ") ?? [];
    assert.ok(parts.length, `${path} names its parts`);
    for (const part of parts) assert.equal((await post(path, { part, mode: "on" })).status, 200, `${path} ${part}`);
  }
  assert.equal((await post("/api/accounts/settings", { mode: "on" })).status, 200);
  assert.equal((await post("/api/learn/switch", { mode: "on" })).status, 200);
  const again = await probeAll(first.filter((r) => r.status === 409).map((r) => r.path));
  const results = [...first.filter((r) => r.status !== 409), ...again];
  const refused = results.filter((r) => r.status >= 400 && r.status < 500).length;
  t.diagnostic(`${all.length} paths: ${called.length} called (${refused} refused with a 4xx), ${skipped.length} never called`);
  if (process.env.EVERY_ROUTE_VERBOSE) for (const r of results) t.diagnostic(`${r.status} ${r.path}`);
  assert.ok(refused > 200, `most malformed bodies are refused (${refused})`);
  assert.deepEqual(problems, []);
});
