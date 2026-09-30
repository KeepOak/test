/* privacy: proves Settings › Your data in the real window against a FRESH engine, reading every change back through the
   engine's own routes (GET /api/your-data, /api/your-data/export/<id>, /api/audit). Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-data.cjs
   Test data it makes through the engine: one imported conversation ("plan the picnic") and one remembered fact.
   Screenshots go to SHOTS (default %TEMP%/claude-session-files/your-data). Nothing launches a desktop window. */
const { mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { inflateRawSync } = require("node:zlib");
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const SHOTS = process.env.SHOTS || join(process.env.TEMP || ".", "claude-session-files", "your-data");
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const kind = (summary, name) => summary.kinds.find((k) => k.kind === name);
/** The names and contents of a .zip's entries (deflate or stored), read from its central directory. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20), nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(packed) : packed;
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

async function signIn(browser) {
  await api("onboarding", { done: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  return { page, errors };
}
async function openPage(page) {
  await page.keyboard.press("Control+Comma");
  await page.locator('[data-act="setpage"][data-v="data"]').click();
  await page.locator('.set-col [data-act="data-export"]').waitFor({ timeout: 15000 });
}

async function seed() {
  await api("sessions/import", { format: "branch-agent-conversation", version: 1, exportedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "plan the picnic" }, { role: "assistant", content: "Bring sandwiches." }] });
  await api("memory/import", { jsonl: JSON.stringify({ id: "verify-data-fact", data: { text: "Likes picnics by the river" } }) });
  await api("comfort", { card: "notify", values: { autoUpdate: "check" } });
}

async function checkKeptAndLeaves(page) {
  const summary = await api("your-data");
  const rows = await page.locator(".set-col .sec").first().locator(".prow").allInnerTexts();
  const talk = rows.find((r) => r.startsWith("Conversations")) ?? "", mem = rows.find((r) => r.startsWith("Memory")) ?? "";
  const n = kind(summary, "conversations").count, m = kind(summary, "memory").count;
  const line = (row) => row.split(/\r?\n/)[1] ?? "";
  check("1 what's kept shows the engine's counts and folder", n >= 1 && m >= 1 && line(talk).startsWith(`${n} · `)
    && line(mem).startsWith(`${m} · `) && (await page.locator(".set-col code").innerText()) === summary.folder, talk.replace(/\r?\n/g, " | "));
  const updates = page.locator('.set-col .prow', { hasText: "Update checks" });
  const listed = summary.leaves.some((l) => l.kind === "updates") && await updates.count() === 1;
  await updates.locator('[data-act="setpage"]').click();
  const opened = await page.locator('[data-act="setpage"][data-v="notifications"][aria-current="true"]').count() === 1;
  check("1 what leaves lists update checks from the real setting, and Open goes to its page", listed && opened);
  await page.screenshot({ path: join(SHOTS, "1-your-data.png"), fullPage: true });
  await page.locator('[data-act="setpage"][data-v="data"]').click();
}

async function checkExport(page) {
  await page.locator('.set-col [data-act="data-export"]').click();
  const sawBar = await page.locator(".set-col progress.prog-p18").waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.locator('.set-col [data-act="data-dl"]').waitFor({ timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('.set-col [data-act="data-dl"]').click()]);
  const file = join(SHOTS, "export.zip");
  await download.saveAs(file);
  const files = unzip(readFileSync(file));
  const names = Object.keys(files);
  const md = names.find((n) => /^conversations\/.*\.md$/.test(n));
  const noKey = !names.some((n) => /locker\.key|\.sqlite$/.test(n));
  check("2 export writes a real .zip with a real download: conversation, memory, no key", md && String(files[md]).includes("plan the picnic")
    && String(files["memory.json"]).includes("Likes picnics") && names.includes("keys-and-connections.json") && noKey && sawBar, names.join(", "));
  await page.screenshot({ path: join(SHOTS, "2-export.png"), fullPage: true });
}

async function tryDelete(page, words) {
  await page.locator('.set-col [data-act="data-del"]').click();
  await page.locator("#data-del-in").fill(words);
  await page.locator('.dlg [data-act="data-del-go"]').click();
  await page.waitForTimeout(600);
}

async function checkLockdown(page) {
  const before = await api("your-data");
  await api("lockdown", { on: true });
  await page.locator('[data-act="setpage"][data-v="data"]').click();
  await tryDelete(page, "delete everything");
  const still = await api("your-data");
  const toast = await page.locator(".toast").allInnerTexts().catch(() => []);
  check("3 under Lockdown, delete is refused and nothing goes", kind(before, "conversations").count > 0 && kind(still, "conversations").count === kind(before, "conversations").count
    && kind(still, "memory").count === kind(before, "memory").count && toast.some((t) => /Lockdown is on/.test(t)), toast.join(" | "));
  await page.screenshot({ path: join(SHOTS, "3-lockdown.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await api("lockdown", { on: false });
}

async function checkDelete(page) {
  const before = kind(await api("your-data"), "conversations").count;
  await tryDelete(page, "nope");
  const kept = before > 0 && kind(await api("your-data"), "conversations").count === before;
  await page.keyboard.press("Escape");
  await tryDelete(page, "delete everything");
  const after = await api("your-data");
  const audit = await api("audit?limit=20");
  const logged = (audit.entries ?? audit).some?.((e) => e.action === "history.pruned" && /Your data/.test(e.reason));
  check("4 wrong words keep everything; the typed phrase deletes it all, and it is written down", kept
    && kind(after, "conversations").count === 0 && kind(after, "memory").count === 0 && logged, `before ${before}, kept ${kept}, after ${kind(after, "conversations").count}/${kind(after, "memory").count}, logged ${logged}`);
  await page.screenshot({ path: join(SHOTS, "4-deleted.png"), fullPage: true });
}

(async () => {
  await seed();
  const browser = await chromium.launch();
  const { page, errors } = await signIn(browser);
  try {
    await openPage(page);
    await checkKeptAndLeaves(page);
    await checkExport(page);
    await checkLockdown(page);
    await checkDelete(page);
  } finally {
    check("page errors: none", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
