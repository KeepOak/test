/* Clicks the controls Q002 made live and confirms each change through the engine's own GET route; then runs nothing
   else. Run against a throwaway engine only (it changes the engine's knobs and preferences):
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-no-more-coming-soon.cjs
   The dead-controls count is design/redesign/tools/audit-dead-controls.cjs. */
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}
const settle = (page, ms = 800) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1300);
}
const notGreyed = async (page, sel) => (await page.locator(sel).first().getAttribute("aria-disabled")) !== "true";

async function models(page) {
  await openPage(page, "models");
  for (const [id, typed, card, field, want] of [["m-spend", "3", "limits", "spendCapDollars", 3], ["m-retries", "4", "limits", "apiRetries", 4],
    ["m-first", "90", "limits", "localFirstReplySeconds", 90], ["m-rounds", "20", "limits", "maxModelRounds", 20],
    ["m-tooltime", "45", "commands", "toolTimeoutSeconds", 45], ["m-toolkb", "8", "commands", "toolAnswerChars", 8000]]) {
    const box = page.locator(`#${id}`);
    await box.fill(typed);
    await box.dispatchEvent("change");
    await settle(page);
    const v = (await api("knobs")).values[card][field];
    check(`${id} saves ${card}.${field}`, v === want, `${field}=${v}`);
  }
  await page.locator("#m-spend").fill("");
  await page.locator("#m-spend").dispatchEvent("change");
  await settle(page);
  /* Taking the cap away makes Branch less careful: the engine refuses without the owner's tick, and says so. */
  const refused = (await page.locator(".toast").allTextContents()).join(" | ");
  check("m-spend emptied: the engine keeps the cap and its refusal is shown", (await api("knobs")).values.limits.spendCapDollars === 3 && /less careful/.test(refused), refused.slice(0, 80));
  await page.locator('[data-act="m-par"][data-v="3"]').click(); await settle(page);
  check("m-par: sub-tasks at once", (await api("knobs")).values.subtasks.parallelSubtasks === 3);
  await page.locator('[data-act="m-tier"][data-v="flex"]').click(); await settle(page);
  check("m-tier: service tier", (await api("knobs")).values.reasoning.serviceTier === "flex");
  const preset = (await api("state")).models?.presets?.[0]?.id; // a connection to choose, when this engine has one
  if (preset) {
    await page.locator(`[data-act="m-sub"][data-v="${preset}"]`).click(); await settle(page);
    check("m-sub: model for sub-tasks", (await api("knobs")).values.subtasks.subtaskModel === preset);
  }
  await page.locator('[data-act="m-sub"][data-v=""]').click(); await settle(page);
  check("m-sub: Same model is null", (await api("knobs")).values.subtasks.subtaskModel === null);
}

async function local(page) {
  await openPage(page, "local");
  /* A runtime this computer doesn't have (the engine's own list says which). */
  /* One the page draws "Look for it" for: a runtime that is running without being installed (a server on its port) is drawn found. */
  let missing = null;
  for (const r of (await api("local-models")).oneClick.runtimes.filter((one) => !one.installed))
    if (await page.locator(`[data-act="lm-look"][data-id="${r.id}"]`).count()) { missing = r; break; }
  if (!missing) { check("lm-look: every runtime is here, nothing to look for", true); return; }
  await page.locator(`[data-act="lm-look"][data-id="${missing.id}"]`).click();
  await settle(page, 1500);
  const note = (await api("local-models")).oneClick.runtimes.find((r) => r.id === missing.id).installNote;
  const toasts = (await page.locator(".toast").allTextContents()).join(" | ");
  check("lm-look: asks again, then says how to get it in the engine's words", toasts.includes(note), toasts.slice(0, 120));
  await page.locator('[data-act="lm-add"][data-id="vllm"]').click();
  await page.locator(".dlg").first().waitFor({ timeout: 10000 }).catch(() => {});
  check("lm-add: the add dialog opens at vLLM's form", (await page.locator(".dlg").count()) > 0 && /vLLM/.test(await page.locator(".dlg").first().innerText()));
  await page.keyboard.press("Escape");
  await settle(page);
}

async function others(page) {
  await openPage(page, "appearance");
  const before = (await api("state")).preferences?.reduceMotion === true;
  await page.locator("#a-still").click(); await settle(page);
  check("a-still saves reduceMotion", (await api("state")).preferences?.reduceMotion === !before);
  await page.locator("#a-still").click(); await settle(page);
  await openPage(page, "advanced");
  await page.locator('[data-act="ad-orders"]').click(); await settle(page);
  const orders = (await api("autonomy/orders")).orders;
  check("ad-orders lists the engine's standing orders", (await page.locator(".dlg").count()) > 0 && (await page.locator(".dlg .prow").count()) === orders.length, `orders=${orders.length}`);
  await page.keyboard.press("Escape");
  await openPage(page, "gateway");
  check("gw-restart is live on Gateway before Branch itself was opened", await notGreyed(page, '[data-act="gw-restart"]'));
}

/* The rest of the controls Q002 wired (review round): each step opens its page, changes the control, proves the change
   through the engine's GET and puts the engine's value back. A step that throws is a failure, with the engine's words. */
const STEPS = [
  ["scrim6", async (page, api, check, openPage) => {
    const before = (await api("delight")).settings.background;
    if (!before.on) await api("delight/settings", { background: { on: true } });
    await openPage(page, "appearance");
    const want = before.scrim === 45 ? 50 : 45;
    await page.locator("#scrim6").evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event("change", { bubbles: true })); }, want);
    await page.waitForTimeout(800);
    const after = (await api("delight")).settings.background;
    check("scrim6 saves delight background.scrim", after.scrim === want, `scrim=${after.scrim}`);
    const layer = await page.evaluate(() => document.getElementById("bgLayer")?.style.getPropertyValue("--scrim"));
    check("scrim6 is laid on the background layer", Number(layer) === want / 100, `--scrim=${layer}`);
    await api("delight/settings", { background: { scrim: before.scrim, ...(before.on ? {} : { on: false }) } });
  }],
  ["see", async (page, api, check, openPage) => {
    const prefs = (await api("state")).preferences, bg = (await api("delight")).settings.background;
    if (!bg.on) await api("delight/settings", { background: { on: true } });
    const want = prefs.seeThrough === 40 ? 45 : 40;
    await openPage(page, "appearance");
    await page.locator("#see").evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event("change", { bubbles: true })); }, want);
    await page.waitForTimeout(800);
    check("see saves preferences.seeThrough", (await api("state")).preferences.seeThrough === want);
    await page.reload(); await page.locator("#main").waitFor({ timeout: 60000 }); await page.waitForTimeout(1500); // the session survives a reload (verify-achievements.cjs:94)
    const see = await page.evaluate(() => document.getElementById("app")?.style.getPropertyValue("--see"));
    check("see is applied after a reload (needs the main.js drawWidth hook)", see === `${want}%`, `--see=${see}`);
    await api("preferences", { ...(await api("state")).preferences, seeThrough: prefs.seeThrough });
    if (!bg.on) await api("delight/settings", { background: { on: false } });
  }],
  ["models (m-planning, m-openrouter, f15-fewer-rounds, f15-keep-claude-s-cache-warm, m-vid)", async (page, api, check, openPage) => {
    const saved = (await api("model-savings")).values, fr = (await api("coding")).modes["fewer-rounds"], vid = (await api("reach")).modes.video;
    await openPage(page, "models");
    const pressedLv = page.locator('[data-act="setlevel"][aria-pressed="true"]'), lv = (await pressedLv.count()) ? await pressedLv.first().getAttribute("data-v") : null;
    await page.locator('[data-act="setlevel"][data-v="technical"]').first().click(); await page.waitForTimeout(800);
    const preset = (await api("state")).models?.presets?.[0]?.id; // a connection to choose, when this engine has one
    if (preset) {
      await page.locator(`[data-act="m-planning"][data-v="${preset}"]`).click(); await page.waitForTimeout(800);
      check("m-planning saves phases.planModel", (await api("model-savings")).values.phases.planModel === preset);
    }
    await page.locator('[data-act="m-planning"][data-v=""]').click(); await page.waitForTimeout(800);
    check("m-planning: Same model is null", (await api("model-savings")).values.phases.planModel === null);
    await page.locator('[data-act="m-openrouter"][data-v="throughput"]').click(); await page.waitForTimeout(800);
    let o = (await api("model-savings")).values.openrouter;
    check("m-openrouter Fastest: on, sort throughput", o.mode === "on" && o.sort === "throughput");
    await page.locator('[data-act="m-openrouter"][data-v="price"]').click(); await page.waitForTimeout(800);
    o = (await api("model-savings")).values.openrouter;
    check("m-openrouter Cheapest: on, sort price", o.mode === "on" && o.sort === "price");
    check("Only ones I list stays greyed with its reason", (await page.locator('[data-v="only"][data-why="m-openrouter-only"]').getAttribute("aria-disabled")) === "true");
    await page.locator("#f15-fewer-rounds").click(); await page.waitForTimeout(800);
    const fr2 = (await api("coding")).modes["fewer-rounds"];
    check("f15-fewer-rounds flips the coding part", (fr === "off") === (fr2 !== "off"), `${fr} -> ${fr2}`);
    const s = await api("model-savings"), claude = s.connections.some((c) => s.keptWarmProviders.includes(c.provider));
    if (claude) {
      await page.locator("#f15-keep-claude-s-cache-warm").click(); await page.waitForTimeout(800);
      check("keep warm saves keepAlive.mode", (await api("model-savings")).values.keepAlive.mode === (saved.keepAlive.mode === "on" ? "off" : "on"));
    } else check("keep warm greyed with its reason (no Claude API-key connection)", (await page.locator('input[data-why="keep-warm-no-claude"]').getAttribute("aria-disabled")) === "true");
    await page.locator('[data-act="mtab"][data-v="media"]').click(); await page.waitForTimeout(500);
    await page.locator("#m-vid").click(); await page.waitForTimeout(800);
    const vid2 = (await api("reach")).modes.video;
    check("m-vid flips the reach part video", (vid === "off") === (vid2 !== "off"), `${vid} -> ${vid2}`);
    check("m-img greyed with its reason", (await page.locator("#m-img").getAttribute("aria-disabled")) === "true");
    await page.locator('[data-act="mtab"][data-v="connections"]').click();
    await api("coding/switch", { part: "fewer-rounds", mode: fr });
    await api("reach/switch", { part: "video", mode: vid });
    for (const card of ["phases", "openrouter", "keepAlive"]) await api("model-savings", { card, values: saved[card] });
    if (lv) await page.locator(`[data-act="setlevel"][data-v="${lv}"]`).click();
  }],
  ["knob boxes and m-effort (lead extra fixes)", async (page, api, check, openPage) => {
    const k0 = (await api("knobs")).values;
    await api("knobs", { card: "limits", values: { spendCapDollars: 2.5 } });
    await openPage(page, "appearance"); await openPage(page, "models"); // reopening re-reads GET /api/knobs
    const pressedLv = page.locator('[data-act="setlevel"][aria-pressed="true"]'), lv = (await pressedLv.count()) ? await pressedLv.first().getAttribute("data-v") : null;
    await page.locator('[data-act="setlevel"][data-v="technical"]').first().click(); await page.waitForTimeout(800);
    check("m-spend shows the engine figure unrounded", (await page.locator("#m-spend").inputValue()) === "2.5");
    await page.locator("#m-spend").fill("2.5"); await page.locator("#m-spend").dispatchEvent("change"); await page.waitForTimeout(800);
    check("retyping 2.5 keeps the cap (no raise refused)", (await api("knobs")).values.limits.spendCapDollars === 2.5);
    await page.locator("#m-toolkb").fill("2.3"); await page.locator("#m-toolkb").dispatchEvent("change"); await page.waitForTimeout(800);
    check("m-toolkb 2.3 KB saves 2300 characters", (await api("knobs")).values.commands.toolAnswerChars === 2300);
    const st = await api("state"), id = st.activeModel?.presetId, p = st.models.presets.find((x) => x.id === id);
    if (p?.thinking?.levels?.includes("low")) {
      await page.locator('[data-act="m-effort"][data-v="low"]').click(); await page.waitForTimeout(800);
      check("m-effort saves effortByModel for the connection in use", (await api("knobs")).values.reasoning.effortByModel[id] === "low");
    } else check("m-effort greyed: the connection in use takes no level", (await page.locator('[data-why="m-effort-none"]').count()) > 0);
    await api("knobs", { card: "limits", values: { spendCapDollars: k0.limits.spendCapDollars }, confirmLoosening: true });
    await api("knobs", { card: "commands", values: { toolAnswerChars: k0.commands.toolAnswerChars } });
    await api("knobs", { card: "reasoning", values: { effortByModel: k0.reasoning.effortByModel } });
    if (lv) await page.locator(`[data-act="setlevel"][data-v="${lv}"]`).click();
  }],
  ["spoken morning brief", async (page, api, check, openPage) => {
    await openPage(page, "voice");
    const lv = page.locator('[data-act="setlevel"][data-v="technical"]').first();
    if (await lv.count()) { await lv.click(); await page.waitForTimeout(900); }
    const before = (await api("personal")).modes["spoken-brief"];
    const box = page.locator("#f15-spoken-morning-brief");
    check("spoken brief switch is live", (await box.getAttribute("aria-disabled")) !== "true");
    check("spoken brief shows the engine's value", (await box.isChecked()) === (before !== "off"), `mode=${before}`);
    await box.evaluate((el) => { el.checked = !el.checked; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForTimeout(900);
    const after = (await api("personal")).modes["spoken-brief"];
    check("spoken brief switch saves personal spoken-brief", before === "off" ? after === "when-needed" : after === "off", `${before} -> ${after}`);
    check("spoken brief redraws from the engine", (await page.locator("#f15-spoken-morning-brief").isChecked()) === (after !== "off"));
    await api("personal/switch", { part: "spoken-brief", mode: before });
  }],
  ["advanced switches (Settings level >= 1)", async (page, api, check, openPage) => {
    await openPage(page, "advanced");
    const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await page.waitForTimeout(200); } };
    const onMode = (m) => Boolean(m) && m !== "off";
    const cases = [
      ["f15-match-by-meaning", async () => (await api("memory/retrieval")).settings.useEmbeddings, (v) => api("memory/retrieval", { useEmbeddings: v }), (v) => v === true],
      ["f15-keep-a-history-in-git", async () => (await api("memory/history")).mode, (m) => api("memory/history", { mode: m }), onMode],
      ["f15-report-only-what-changed", async () => (await api("heartbeat")).switches.notifyGate, (m) => api("heartbeat/switches", { notifyGate: m }), onMode],
      ["f15-checks-and-retries-in-procedures", async () => (await api("flows-boards")).modes["recipe-checks"], (m) => api("flows-boards/switch", { part: "recipe-checks", mode: m }), onMode],
      ["f15-start-when-a-usb-device-is-plugged-in", async () => (await api("reach")).modes.usb, (m) => api("reach/switch", { part: "usb", mode: m }), onMode],
      ["f15-check-a-skill-is-ready-first", async () => (await api("autonomy")).modes.readiness, (m) => api("autonomy/switch", { part: "readiness", mode: m }), onMode],
      ["f15-search-x", async () => (await api("personal")).modes["x-search"], (m) => api("personal/switch", { part: "x-search", mode: m }), onMode],
      ["f15-video-tools", async () => (await api("media/programs")).settings.mode, (m) => api("media/programs", { mode: m }), onMode],
    ];
    for (const [id, raw, put, isOn] of cases) {
      const original = await raw(), before = isOn(original);
      const box = page.locator("#" + id);
      check(id + " enabled", await box.isEnabled(), "");
      check(id + " shows the engine's value", (await box.isChecked()) === before, String(original));
      await box.click();
      check(id + " changes the engine", await until(async () => isOn(await raw()) === !before), "was " + original);
      check(id + " redrawn from the engine", await until(async () => (await page.locator("#" + id).isChecked()) === !before), "");
      await put(original);
      check(id + " restored", (await raw()) === original, String(original));
    }
  }],
  ["ad-facts", async (page, api, check, openPage) => {
    await openPage(page, "advanced");
    const cap = async () => (await api("state")).memoryCapacity;
    const { count, maxFacts } = await cap();
    const box = page.locator("#ad-facts");
    check("ad-facts enabled", await box.isEnabled(), "");
    check("ad-facts shows the engine's value", (await box.inputValue()) === String(maxFacts), String(maxFacts));
    const next = maxFacts < 500 ? maxFacts + 1 : Math.max(count, 1, maxFacts - 1);
    await box.fill(String(next)); await box.press("Tab");
    await page.waitForTimeout(1500);
    check("ad-facts saved to the engine", (await cap()).maxFacts === next, String(next));
    await page.locator("#ad-facts").fill("abc"); await page.locator("#ad-facts").press("Tab"); await page.waitForTimeout(800);
    check("a non-number is not sent", (await cap()).maxFacts === next, "");
    await api("memory/capacity", { maxFacts });
    check("ad-facts restored", (await cap()).maxFacts === maxFacts, String(maxFacts));
  }],
  ["outside memory (ad-outside)", async (page, api, check, openPage) => {
    await openPage(page, "advanced");
    const before = (await api("learning-more/providers")).active;
    check("outside memory shows the engine's value", (await page.locator('[data-act="ad-outside"][aria-pressed="true"]').getAttribute("data-v")) === before, before);
    const target = before === "hindsight" ? "none" : "hindsight";
    await page.locator('[data-act="ad-outside"][data-v="' + target + '"]').click();
    await page.waitForTimeout(1500);
    check("choice saved to the engine", (await api("learning-more/providers")).active === target, target);
    check("choice redrawn pressed", (await page.locator('[data-act="ad-outside"][data-v="' + target + '"]').getAttribute("aria-pressed")) === "true", "");
    await api("learning-more/providers", { active: before });
    check("outside memory restored", (await api("learning-more/providers")).active === before, before);
  }],
  ["restored demo readouts (read-only; nothing to restore; permissions rows need level >= 2)", async (page, api, check, openPage) => {
    const open = async (pageId, key) => {
      await openPage(page, pageId);
      const btn = page.locator('[data-act="demob17"][data-k="' + key + '"]');
      check(key + " button drawn and live", (await btn.count()) === 1 && !((await btn.getAttribute("class")) || "").includes("soon"), "");
      await btn.click();
      await page.waitForSelector(".demo-b17", { timeout: 5000 });
      const text = await page.locator(".demo-b17").innerText();
      await page.locator('[data-act="dlg-close"]').first().click();
      return text;
    };
    const onWord = (m) => (m && m !== "off" ? "On" : "Off");
    let text = await open("permissions", "loopguard"); check("loopguard shows the engine's mode", text.includes(onWord((await api("loop-guard")).mode)), text);
    const ch = await api("channels");
    text = await open("permissions", "chatperm"); check("chatperm lists the engine's lines", (ch.permissions?.rules || []).every((r) => text.includes(r.channel)), text);
    text = await open("gateway", "delivery"); check("delivery lists what is outstanding", (ch.outstanding || []).every((d) => text.includes(d.channel)), text);
    const props = (await api("memory/proposals")).proposals;
    text = await open("advanced", "followup"); check("followup shows the engine's mode", text.includes(onWord((await api("chat-engine")).mode)), text);
    text = await open("advanced", "consolidate"); check("consolidate lists the merges", props.filter((p) => p.kind === "merge").every((p) => text.includes((p.text || p.note).slice(0, 20))), text);
    text = await open("advanced", "kcards"); check("kcards lists the cards", props.filter((p) => p.kind === "knowledge-card").every((p) => text.includes(p.card.title)), text);
    const talk = (await api("settings-kit/history")).records.filter((r) => r.source === "talk");
    text = await open("self", "talksettings"); check("talksettings lists changes made by talking", talk.every((r) => text.includes(r.changes[0]?.setting ?? "")), text);
    const chapters = (await api("help")).chapters;
    text = await open("updates", "handbook"); check("handbook lists the chapters", chapters.every((c) => text.includes(c.title)), text);
    const ed = await api("workspace-editor/settings");
    text = await open("computer", "editor"); check("editor shows its switch, or the folder while on", ed.mode === "off" ? text.includes("Off") : true, ed.mode);
  }],
  ["gw-carry", async (page, api, check, openPage) => {
    const before = (await api("never-break")).mode;
    await openPage(page, "gateway");
    const box = page.locator("#gw-carry");
    check("gw-carry is live", (await box.getAttribute("aria-disabled")) !== "true");
    const was = await box.isChecked();
    await box.click();
    await page.waitForTimeout(900);
    const after = (await api("never-break")).mode;
    check("gw-carry saves the gateway mode", was ? after === "when-needed" : after === "on", `before=${before} after=${after}`);
    check("gw-carry redrawn from the engine", (await page.locator("#gw-carry").isChecked()) === (after === "on"), after);
    await api("never-break", { mode: before });
    check("gw-carry restored", (await api("never-break")).mode === before, before);
  }],
  ["tool-retry", async (page, api, check, openPage) => {
    // Seed one of your own servers at an address nothing answers, so it shows "It didn't start" with Retry. A dead address
    // cannot change the GET, so the proof is the engine's own answer to the start POST and the toast showing its words.
    const added = await api("mcp/servers", { name: "Seed retry", server: { transport: "http", url: "http://127.0.0.1:9/mcp" } });
    const id = added.server.id;
    const before = (await api("mcp/servers")).servers.find((s) => s.id === id);
    check("seeded server is in error", Boolean(before?.error), JSON.stringify(before?.error ?? null));
    await page.evaluate(() => { const b = document.createElement("button"); b.dataset.act = "ptab"; b.dataset.place = "customize"; b.dataset.v = "tools"; document.body.append(b); b.click(); b.remove(); });
    await page.waitForTimeout(1500);
    await page.locator(`[data-act="t9-sel"][data-v="${id}"]`).click();
    await page.waitForTimeout(500);
    const retry = page.locator(`[data-act="tool-retry"][data-id="${id}"]`);
    check("Retry is live", (await retry.getAttribute("aria-disabled")) !== "true");
    const started = page.waitForResponse((r) => r.url().includes(`/api/mcp/servers/${encodeURIComponent(id)}/start`) && r.request().method() === "POST", { timeout: 15000 });
    await retry.click();
    const res = await started;
    const body = await res.json().catch(() => null);
    const words = res.ok() ? body?.said : body?.error;
    check("engine answered the start", typeof words === "string" && words.length > 0, `${res.status()} ${words}`);
    await page.waitForTimeout(400);
    const toastText = (await page.locator(".toast").last().textContent().catch(() => "")) ?? "";
    check("toast shows the engine's words", toastText.includes(String(words).slice(0, 40)), toastText);
    const after = (await api("mcp/servers")).servers.find((s) => s.id === id);
    check("server still listed after Retry", Boolean(after), JSON.stringify(after?.error ?? null));
    await api(`mcp/servers/${encodeURIComponent(id)}/remove`, {});
    check("seed removed", !(await api("mcp/servers")).servers.some((s) => s.id === id));
  }],
  ["voice", async (page, api, check, openPage) => {
    const before = await api("voice/settings");
    await openPage(page, "voice");
    const off = page.locator('[data-act="v-voice"][data-v="off"]');
    check("v-voice is live", (await off.getAttribute("aria-disabled")) !== "true");
    await api("voice/settings", { autoReadAloud: true });
    await openPage(page, "voice");
    await page.locator('[data-act="v-voice"][data-v="off"]').click();
    await page.waitForTimeout(800);
    check("v-voice Off saves autoReadAloud false", (await api("voice/settings")).autoReadAloud === false);
    const one = page.locator('[data-act="v-voice"]:not([data-v="off"])').first();
    if (await one.count()) {
      const name = await one.getAttribute("data-v");
      await one.click(); await page.waitForTimeout(800);
      const s = await api("voice/settings");
      check("v-voice picks a computer voice", s.voiceId === name && s.autoReadAloud === true, name);
    }
    await api("voice/settings", { voiceId: before.voiceId, autoReadAloud: before.autoReadAloud });
  }],
  ["vim keys", async (page, api, check, openPage) => {
    const until = async (f) => { for (let i = 0; i < 20; i++) { if (await f()) return true; await page.waitForTimeout(150); } return false; };
    const before = (await api("comfort")).values.keys.vim === true;
    await openPage(page, "general");
    const lv = await page.locator('[data-act="setlevel"][aria-pressed="true"]').getAttribute("data-v");
    await page.click('[data-act="setlevel"][data-v="advanced"]');
    const sw = page.locator("#f15-vim-keys-in-the-message-box");
    await sw.waitFor();
    check("vim: switch shows the engine's value", (await sw.isChecked()) === before, `engine ${before}`);
    check("vim: switch is live", (await sw.getAttribute("aria-disabled")) !== "true");
    await sw.click();
    check("vim: flip saved (GET /api/comfort keys.vim)", await until(async () => (await api("comfort")).values.keys.vim === !before));
    if (before) await page.locator("#f15-vim-keys-in-the-message-box").click();
    check("vim: on for the box test", await until(async () => (await api("comfort")).values.keys.vim === true));
    await page.keyboard.press("Control+N"); // a new conversation: its message box (Ctrl+N is the engine's default key)
    const box = page.locator("#prompt");
    if (!(await box.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
      const s = ((await api("sessions")).sessions ?? [])[0];
      if (s) await page.evaluate((id) => { location.hash = "open=" + id; }, s.sessionId);
      await box.waitFor();
    }
    await box.fill(""); await box.click(); await page.keyboard.type("ab cd");
    await page.keyboard.press("Escape");
    check("vim: Esc -> moving (data-vim=normal)", (await page.locator("#prompt").getAttribute("data-vim")) === "normal");
    await page.keyboard.press("0"); await page.keyboard.press("h"); await page.keyboard.press("l");
    check("vim: h/l move and type nothing", (await page.locator("#prompt").inputValue()) === "ab cd");
    await page.keyboard.press("0"); await page.keyboard.press("x");
    check("vim: x deletes under the cursor", (await page.locator("#prompt").inputValue()) === "b cd");
    await page.keyboard.press("i");
    check("vim: i -> typing (data-vim=insert)", (await page.locator("#prompt").getAttribute("data-vim")) === "insert");
    await page.keyboard.type("Z");
    check("vim: typing again", (await page.locator("#prompt").inputValue()) === "Zb cd");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    check("vim: second Esc leaves the box", await page.evaluate(() => document.activeElement?.id !== "prompt"));
    await page.locator("#prompt").fill("");
    await openPage(page, "general");
    const sw2 = page.locator("#f15-vim-keys-in-the-message-box"); await sw2.waitFor();
    if ((await sw2.isChecked()) !== before) await sw2.click();
    check("vim: restored", await until(async () => (await api("comfort")).values.keys.vim === before));
    if (lv) await page.click(`[data-act="setlevel"][data-v="${lv}"]`);
  }],
  ["message times", async (page, api, check, openPage) => {
    const until = async (f) => { for (let i = 0; i < 20; i++) { if (await f()) return true; await page.waitForTimeout(150); } return false; };
    const before = (await api("comfort")).values.display.timestamps === true;
    await openPage(page, "general");
    const lv = await page.locator('[data-act="setlevel"][aria-pressed="true"]').getAttribute("data-v");
    await page.click('[data-act="setlevel"][data-v="advanced"]');
    const always = page.locator('[data-act="mtimes15"][data-v="always"]');
    await always.waitFor();
    check("times: seg shows the engine's value", (await always.getAttribute("aria-pressed")) === String(before), `engine ${before}`);
    check("times: Never greyed with its reason", (await page.locator('[data-why="f15-message-times"]').getAttribute("aria-disabled")) === "true");
    await always.click();
    check("times: Always saved (GET /api/comfort display.timestamps)", await until(async () => (await api("comfort")).values.display.timestamps === true));
    const list = (await api("sessions")).sessions ?? [];
    let sid = null;
    for (const s of list) {
      const d = await api("sessions/" + s.sessionId);
      if ((d.messages ?? []).some((m) => m.at && (m.role === "user" || m.role === "assistant"))) { sid = s.sessionId; break; }
    }
    if (!sid) check("times: a time on a message", false, "no conversation with messages in this engine");
    else {
      await page.evaluate((id) => { location.hash = "open=" + id; }, sid);
      await page.waitForSelector(".u > time.at15, .b time.at15", { timeout: 8000 }).catch(() => {});
      const n = await page.locator(".u > time.at15, .b time.at15").count();
      const dt = n ? await page.locator("time.at15").first().getAttribute("datetime") : null;
      check("times: Always puts a time on each message", n > 0 && !Number.isNaN(Date.parse(dt)), `${n} times, first ${dt}`);
      check("times: no second time in the hover row", (await page.locator(".msg-acts .ts15").count()) === 0);
    }
    await openPage(page, "general");
    await page.locator('[data-act="mtimes15"][data-v="hover"]').click();
    check("times: On hover saved", await until(async () => (await api("comfort")).values.display.timestamps === false));
    if (sid) {
      await page.evaluate((id) => { location.hash = "open=" + id; }, sid);
      await page.waitForSelector(".msg-acts .ts15", { state: "attached", timeout: 8000 }).catch(() => {});
      check("times: On hover keeps the time in the action row only", (await page.locator("time.at15").count()) === 0 && (await page.locator(".msg-acts .ts15").count()) > 0);
    }
    if (before) await api("comfort", { card: "display", values: { timestamps: true } });
    check("times: restored", (await api("comfort")).values.display.timestamps === before);
    if (lv) { await openPage(page, "general"); await page.click(`[data-act="setlevel"][data-v="${lv}"]`); }
  }],
  ["find nearby (last: it leaves a dialog)", async (page, api, check, openPage) => {
    // Developer is shown only at the Technical level.
    await openPage(page, "developer");
    const btn = page.locator('.settings [data-act="addcomp"][data-why="f15-find-branch-on-other-computers-nearby"]');
    check("find-nearby row is live", (await btn.getAttribute("aria-disabled")) !== "true");
    await btn.click();
    await page.waitForTimeout(1500);
    check("Add a computer opened on the network tab", (await page.locator(".dlg #ac-found").count()) === 1);
    const view = await api("devices/find").catch((e) => ({ error: e.message }));
    check("engine is looking (or refused in its own words in the tab)", view.looking === true || (await page.locator(".dlg #ac-found [role=status]").count()) === 1, JSON.stringify(view).slice(0, 120));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(3000);
    const after = await api("devices/find").catch(() => ({ looking: false }));
    check("looking stops when the dialog closes", after.looking === false, JSON.stringify(after).slice(0, 80));
  }],
];

async function more(page) {
  for (const [name, step] of STEPS) {
    try { await step(page, api, check, openPage); } catch (error) { check(`${name}: ran to the end`, false, String(error.message).split("\n")[0].slice(0, 160)); }
    await page.keyboard.press("Escape");
  }
}

(async () => {
  await api("onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await models(page);
  await local(page);
  await others(page);
  await more(page);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  if (results.some((ok) => !ok)) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
