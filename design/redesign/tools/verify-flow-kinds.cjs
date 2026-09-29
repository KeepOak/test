// Checks the flow editor's step kinds and the separate yes to what a procedure repeats, against a running engine, each
// confirmed through the engine's own routes. No model is needed: nothing here runs a step.
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-flow-kinds.cjs
// On a throwaway engine only (fresh BRANCH_DATA_DIR): it switches procedures on (and back off) and makes one procedure.
// 1. Every kind can be picked (none greyed), and each is drawn in the prototype's words.
// 2. Adding a Repeat, an "If it says" with both ways and a Wait, then Save and "Approve version 2", keeps them
//    (GET /api/autonomy/procedures: kinds, times 5, the words, 30 minutes).
// 3. The engine's own question about what it would repeat opens with the procedure; until it is answered the procedure
//    does not run (POST …/run says why). flow-unatt Yes answers it (GET /api/autonomy/procedures: unattended).
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (path, body) => {
  const r = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
  return data;
};
let failures = 0;
const check = (ok, what, note = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${note ? `  (${note})` : ""}`); if (!ok) failures++; };

(async () => {
  const before = (await api("autonomy")).modes?.procedures ?? "off";
  await api("onboarding", { done: true });
  await api("autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
  const { procedure } = await api("autonomy/procedures", { name: `Price check ${Date.now().toString(36)}`, level: "ask-to-start", start: { kind: "manual" },
    steps: [{ title: "Read", prompt: "Read the supplier pages." }] });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator('.side-nav [data-act="view"][data-v="automations"]').first().click();
    await page.locator('[data-act="ptab"][data-place="automations"][data-v="procedures"]').first().click();
    await page.locator(`[data-act="flow"][data-id="${procedure.id}"]`).click();
    const dlg = page.locator(".dlg");
    await dlg.locator("#fk-0").waitFor();
    const kinds = await gselChoices(dlg.locator("#fk-0"));
    check(kinds.filter((c) => c.off).length === 0 && kinds.length === 8, "every kind of step can be picked");
    const add = async (kind, text) => {
      const j = await dlg.locator("[id^='fk-']").count();
      await dlg.locator('[data-act="flow-add"]').click();
      await pickGsel(dlg.locator(`#fk-${j}`), kind);
      await dlg.locator(`#ft-${j}`).fill(text);
      return j;
    };
    await add("loop", "Check the prices again.");
    const cond = await add("if", "cheaper");
    await dlg.locator(`#fy-${cond}`).fill("Draft an order.");
    await dlg.locator(`#fn-${cond}`).fill("Just report the prices.");
    await add("wait", "30 minutes");
    const pic = await dlg.locator("#flow-pic").innerHTML();
    check(/Repeat \(up to 5\)/.test(pic) && /If it says “cheaper”/.test(pic) && /Yes: Draft an order\./.test(pic) && /Wait: 30 minutes/.test(pic), "each kind is drawn in the prototype's words");
    await dlg.locator('[data-act="flow-save"]').click();
    await dlg.locator('[data-act="ppapprove17d"]').click();
    const note = page.locator(".dlg .un-flow");
    await note.waitFor({ timeout: 15000 });
    const kept = (await api("autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
    const s = kept.procedure.steps;
    check(kept.version === 2 && s.map((x) => x.kind ?? "do").join() === "do,loop,if,wait" && s[1].times === 5 && s[2].contains === "cheaper" && s[2].yes === "Draft an order." && s[2].no === "Just report the prices." && s[3].minutes === 30,
      "ppapprove17d keeps every kind (GET /api/autonomy/procedures)", s.map((x) => x.kind ?? "do").join(", "));
    check(/repeat and run steps without asking each time/.test(await note.innerText()) && /up to 5 times/.test(await note.innerText()), "the engine's own question opens with the procedure, in its words");
    const held = await api(`autonomy/procedures/${procedure.id}/run`, {});
    check(held.started === false && /waits for your yes to what it would repeat/.test(held.reason), "until then it does not run (POST …/run)", held.reason);
    await note.locator('[data-act="flow-unatt"][data-v="yes"]').click();
    await note.waitFor({ state: "detached" });
    const allowed = (await api("autonomy/procedures")).procedures.find((p) => p.id === procedure.id);
    check(!!allowed.unattended?.fingerprint, "flow-unatt Yes answers it (GET /api/autonomy/procedures unattended)");
    check(errors.length === 0, "no page errors", errors.join("; "));
  } finally {
    await browser.close();
    await api(`autonomy/procedures/${procedure.id}/remove`, {}).catch((e) => console.log("cleanup:", e.message));
    await api("autonomy/switch", { part: "procedures", mode: before }).catch((e) => console.log("cleanup:", e.message));
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
