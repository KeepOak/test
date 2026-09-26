/* Dead-control audit: clicks every visible, enabled control of the redesigned window with a real mouse and records
   whether anything observable happened, in four states of a brand-new install. Static checks (check-live, check-fakes)
   read the source; this reads the running window.

   States, each on its own throwaway engine (fresh BRANCH_DATA_DIR, workspace and integrations file, free port):
     A  brand-new: no model, setup dismissed, no conversations
     B  the same with setup open (every setup step)
     C  a test model (an OpenAI-shaped stand-in this script serves on 127.0.0.1) and one conversation with messages
     D  a Trunk's conversation (same stand-in model)
   Places: the conversation, Overview, Inbox, Automations, Library, Team, Customize (each tab), Settings (every page of the
   nav at the Technical level), the title bar, the sidebar and the status bar, and every popover or dialog a control opens,
   one level deep and then two.

   A click is: mouse move, down, 120 ms, up. Within 1.5 s it must cause one of: a DOM change outside the control itself
   (snapshot diff, minus what changes on its own while idle), a popover / dialog / toast, a view change, a request to
   /api that is not background polling, a download, a clipboard write, window.open, or focus moving into a new region.
   Result: OK, DEAD (nothing), ERROR (page or console error, a 5xx, or a refusal with no visible sentence),
   REFUSED-HONEST (the engine refused and the window said so), SKIPPED (deny-list: deletes, sends, spends, uninstalls,
   signs out, locks, mic/camera/screen, starts or downloads software), SOON (greyed "Coming soon", never clicked).

   Build first (the full build):  npx tsc -p . && node scripts/copy-fonts.mjs && node scripts/copy-suites.mjs && node scripts/copy-data.mjs
   Run:  node design/redesign/tools/audit-dead-controls.cjs
         STATES=A,C  PLACES=chat,overview  DEPTH=1  (optional filters)
   Writes design/redesign/tools/out/dead-controls-<state>.json and .md, and dead-controls-soon.md; screenshots of DEAD and
   ERROR controls go to C:/Users/bishi/AppData/Local/Temp/claude-session-files/dead-controls/.
   Never uses port 3210 or 3300, never the owner's data; the browser may reach only the engine it started. */
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, relative } = require("node:path");
let playwright;
try { playwright = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright"); }
catch { playwright = require("playwright"); }

const ROOT = resolve(__dirname, "../../..");
const OUT = join(__dirname, "out");
const SHOTS = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/dead-controls";
const STATES = (process.env.STATES || "A,B,C,D").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_PLACES = process.env.PLACES ? process.env.PLACES.split(",") : null;
const DEPTH = Number(process.env.DEPTH ?? 2);
const FORBIDDEN_PORTS = new Set([3210, 3299, 3300]);
const WINDOW_MS = 1500, HOLD_MS = 120, POLL_MS = 150;
const REPLY = "Done. Here is what I found:\n\n- one\n- two\n\n```js\nconsole.log(1)\n```";

/* ---------- the deny-list: never clicked, listed as SKIPPED ---------- */
const DENY_ACTS = {
  remove: "deletes", "bg-remove": "deletes", "bg-remove-yes": "deletes", "my-del": "deletes", "my-del-yes": "deletes",
  "lm-rm": "deletes", "flow-rm": "deletes", "hb-rm": "deletes", "tool-rm": "deletes", "pin-rm8": "deletes", matrm15: "deletes",
  qrm15: "deletes", forget: "deletes", "aa-gone": "deletes", keyreset15: "deletes a key", tidydo15: "deletes memories",
  "acct-out": "signs out", signin: "signs in to an outside service", "acct-up": "spends money",
  lock: "locks", lockscreen: "locks", quit: "quits", "restart16": "restarts", "gw-restart": "starts a process",
  install: "installs software", "plug-add": "installs software", "lm-get": "downloads a model", "dl-go": "downloads software",
  "lm-run": "starts a local model (heavy CPU)", updgo15: "installs an update", "mcp-save": "starts an outside server",
  "mcp-test": "contacts an outside server", "cli-add": "installs software",
  "team-invite-go": "sends an invite", "p-inv-go": "sends an invite", invite: "sends an invite",
  rec: "microphone", dict: "microphone", voice: "microphone", call: "microphone", "v-ans": "microphone",
  "teach-start": "records the screen", stage: "takes over the screen", takeover: "takes over the screen",
  "self-apply": "changes Branch's own code", selfdo15: "changes Branch's own code",
  hide: "hides a part of the window for good", send: "sends a message",
  sugg: "sends a message (starts a task, adds a conversation)", sugg15: "sends a message (starts a task, adds a conversation)",
};
const DENY_LABEL = [
  [/\b(delete|remove|forget|erase|wipe|uninstall|clear all)\b/i, "deletes"],
  [/\bsign(ing)? (out|in)\b|\blog ?out\b/i, "signs in or out"],
  [/\block\b/i, "locks"],
  [/\bsend\b|\binvite\b/i, "sends a message"],
  [/\b(buy|purchase|pay|upgrade|subscribe|top up)\b/i, "spends money"],
  [/\b(quit|restart|shut ?down)\b/i, "stops the app"],
  [/\binstall\b|\bdownload (the )?(model|update)/i, "installs or downloads"],
  [/\b(record|microphone|camera|dictat\w*|call|share (my |the )?screen)\b/i, "mic/camera/screen"],
  [/\b(start (with|when)|at login|when (i|you) log in|startup)\b/i, "changes startup"],
  [/\b(remote access|tunnel|open to the internet)\b/i, "exposes the engine"],
];
const DENY_ID = { "side-q": "a text field", "set-q": "a text field" };
const denyReason = (it) => DENY_ACTS[it.act] || DENY_ID[it.id]
  || (it.href && !it.sameOrigin ? "external link" : "")
  || (DENY_LABEL.find(([re]) => re.test(it.label.slice(0, 40))) ?? [])[1] || "";

/* ---------- already known, being fixed elsewhere ---------- */
const KNOWN = [
  [(p, it) => ["pane", "chatmenu"].includes(it.act) && p.name === "chat" && !p.spec.chat, "known: side panel / chatmenu in a new conversation"],
  [(p, it) => it.resize === "side", "known: sidebar resize edge"],
  [(p, it) => it.act === "project", "known: Projects rows"],
  [(p, it) => it.act === "places14", "known: Places header"],
  [(p) => p.spec.ob === 6, "known: setup's tools step"],
  [(p, it) => p.spec.ob === 7 && (["ob-boot", "ob-upd"].includes(it.id) || it.act === "ob-gw"), "known: setup's keep-running switches"],
];
const knownNote = (p, it) => (KNOWN.find(([m]) => m(p, it)) ?? [])[1] || "";

/* ---------- where each control is drawn and handled (public/) ---------- */
function sourceIndex() {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
  walk(join(ROOT, "public/app"));
  for (const f of ["i18n.js", "widget.js"]) if (fs.existsSync(join(ROOT, "public", f))) files.push(join(ROOT, "public", f));
  const renders = new Map(), handlers = new Map(), ids = new Map(), literals = new Map();
  const add = (map, key, at) => { if (!map.has(key)) map.set(key, []); if (map.get(key).length < 4) map.get(key).push(at); };
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel.endsWith("core/features.js")) continue;
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      for (const m of line.matchAll(/data-act="([\w-]+)"/g)) add(renders, m[1], at);
      for (const m of line.matchAll(/\b(?:mi|radio|prov|seg\w*|chip\w*|btn\w*)\(\s*(?:[^,()]*\?\s*)?"([\w-]+)"/g)) add(renders, m[1], at);
      for (const m of line.matchAll(/\bon\(\s*"([\w-]+)"/g)) add(handlers, m[1], at);
      for (const m of line.matchAll(/\bid="([\w-]+)"|\bctl\(\s*"([\w-]+)"/g)) add(ids, m[1] || m[2], at);
      for (const m of line.matchAll(/["'`]([\w-]{3,})["'`]/g)) add(literals, m[1], at);
    });
  }
  return { renders, handlers, ids, literals };
}
let SRC;
function whereDrawn(it) {
  if (it.act) return (SRC.renders.get(it.act) ?? SRC.literals.get(it.act) ?? []).join(", ");
  if (it.id) return (SRC.ids.get(it.id) ?? []).join(", ");
  if (it.resize) return (SRC.literals.get(`data-resize="${it.resize}"`) ?? []).join(", ") || "public/app/shell/shell.js (data-resize)";
  return "";
}
const whereHandled = (it) => (it.act ? (SRC.handlers.get(it.act) ?? []).join(", ") : "");

/* ---------- the stand-in model (states C and D) ---------- */
function startStub() {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] })); return; }
    const body = JSON.parse(raw || "{}"), usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: REPLY } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/* ---------- a throwaway engine ---------- */
function freePort() {
  return new Promise((ok, bad) => {
    const s = net.createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => (FORBIDDEN_PORTS.has(port) ? freePort().then(ok, bad) : ok(port))); });
  });
}
/* No model, no outside network: every BRANCH_* and provider key is dropped, and the engine's own fetches go through a
   proxy that is not there (src/pinned-fetch.ts honours NODE_USE_ENV_PROXY), except to this computer. */
function engineEnv(dirs, port, stubPort) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^BRANCH_|API_KEY|OPENAI|ANTHROPIC|GEMINI|OLLAMA|MISTRAL|GROQ|OPENROUTER|_PROXY$/i.test(k)) env[k] = v;
  Object.assign(env, { BRANCH_DATA_DIR: dirs.data, BRANCH_WORKSPACE: dirs.workspace, BRANCH_PORT: String(port), BRANCH_INTEGRATIONS: dirs.integrations,
    NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost,::1" });
  if (stubPort) Object.assign(env, { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${stubPort}/v1`, BRANCH_MODEL: "stand-in", BRANCH_API_KEY: "local-test" });
  return env;
}
async function startEngine(stubPort) {
  const base = fs.mkdtempSync(join(tmpdir(), "branch-dead-controls-"));
  const dirs = { base, data: join(base, "data"), workspace: join(base, "workspace"), integrations: join(base, "integrations.json") };
  fs.mkdirSync(dirs.workspace, { recursive: true });
  fs.writeFileSync(dirs.integrations, "{}");
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "start"], { cwd: dirs.workspace, env: engineEnv(dirs, port, stubPort), stdio: ["ignore", "pipe", "pipe"] });
  const token = await new Promise((ok, bad) => {
    bad = ((fail) => (error) => { child.kill(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); fail(error); })(bad);
    let out = "";
    const timer = setTimeout(() => bad(new Error(`the engine did not start:\n${out}`)), 90000);
    const read = (chunk) => { out += chunk; const m = /paste into browser\): ([a-f0-9]+)/.exec(out); if (m) { clearTimeout(timer); ok(m[1]); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => bad(new Error(`the engine exited (${code}):\n${out}`)));
  });
  return { child, port, token, dirs, base: `http://127.0.0.1:${port}` };
}
async function stopEngine(engine) {
  if (!engine) return;
  if (engine.child.exitCode === null) {
    const gone = new Promise((ok) => engine.child.once("exit", ok));
    engine.child.kill();
    await Promise.race([gone, new Promise((ok) => setTimeout(ok, 8000))]);
  }
  fs.rmSync(engine.dirs.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
async function api(engine, path, body) {
  const r = await fetch(`${engine.base}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${engine.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${data?.error ?? r.status}`);
  return data;
}

/* ---------- what runs inside the page ---------- */
function pageKit() {
  const CTL = "[data-act],button,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=switch],[role=option],input[type=checkbox],input[type=radio],input.sw,select,[data-resize],a[href],summary";
  const ATTRS = ["data-act", "data-v", "data-id", "aria-pressed", "aria-checked", "aria-expanded", "aria-current", "aria-selected", "aria-disabled", "aria-invalid", "hidden", "open", "disabled", "src", "role", "type"];
  const REGIONS = [".pop", ".scrim", ".ob9", ".first", ".tour-layer", ".welcome10", ".toast", ".titlebar", "#side", "#statusbar", "#main"];
  const OVERLAYS = ".pop, .scrim, .ob9, .first, .tour-layer, [role=dialog]";
  const log = { opens: [], clip: [], downloads: [], ev: [] };
  const A = { log, cur: null, mods: null };
  window.__A = A;
  window.open = (url) => { log.opens.push(String(url)); return null; };
  try {
    const c = navigator.clipboard;
    if (c) { c.writeText = async (t) => { log.clip.push(String(t).slice(0, 60)); }; c.write = async () => { log.clip.push("[item]"); }; }
  } catch { /* no clipboard */ }
  const exec = document.execCommand.bind(document);
  document.execCommand = (cmd, ...rest) => { if (/copy|cut/i.test(cmd)) log.clip.push("execCommand " + cmd); return exec(cmd, ...rest); };
  const aclick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download || /^blob:|^data:/.test(this.href)) log.downloads.push(this.download || this.href.slice(0, 40)); return aclick.call(this); };
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const desc = (el) => !el || !el.tagName ? String(el) : `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.dataset?.act ? `[data-act=${el.dataset.act}]` : ""}`;
  /* What the press really hit: the element under the pointer at each event, whether it is the control under audit (by
     identity, or by its key when a redraw drew it anew between aiming and pressing), and whether the element pressed at
     pointerdown was still in the page at pointerup (a redraw in between swallows the click). */
  const isSelf = (t) => !!A.cur && (A.cur === t || A.cur.contains(t) || (t?.closest && t.closest(CTL) && key(t.closest(CTL)) === A.curKey));
  for (const type of ["pointerdown", "pointerup", "click"]) {
    document.addEventListener(type, (e) => {
      if (!A.cur) return;
      if (type === "pointerdown") A.pd = e.target;
      log.ev.push({ type, on: desc(e.target), self: isSelf(e.target), connected: type === "pointerup" ? !!A.pd?.isConnected : true });
    }, true);
  }
  const label = (el) => norm(el.getAttribute("aria-label") || el.innerText || el.dataset.tip || el.title || el.placeholder || el.value || (el.labels?.[0]?.innerText) || desc(el)).slice(0, 70);
  const key = (el) => [el.dataset.act || "", el.dataset.v || "", el.dataset.id || "", el.dataset.k || "", el.dataset.place || "", el.id || "", el.dataset.resize || "", el.tagName, label(el)].join("|");
  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const regionOf = (el) => REGIONS.find((s) => el?.closest?.(s)) || "body";
  /* The element a person would press: a hidden checkbox is pressed through its visible label. */
  const pressable = (el) => (el.tagName === "INPUT" && !visible(el) && el.closest("label") && visible(el.closest("label")) ? el.closest("label") : el);
  function controls(sels) {
    const seen = new Set(), out = [];
    for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of [root, ...root.querySelectorAll(CTL)]) {
      if (!el.matches(CTL) || seen.has(el)) continue;
      seen.add(el); out.push(el);
    }
    return out;
  }
  function find(k, nth, sels) { let i = -1; for (const el of controls(sels)) if (key(el) === k && ++i === nth) return el; return null; }
  function soonWhy(el) {
    const F = A.mods?.F, X = A.mods?.X, act = el.dataset.act, why = [];
    if (act) {
      if (!(act in F.FEATURES)) why.push("not in FEATURES");
      else if (F.FEATURES[act] === "soon") why.push("FEATURES says soon");
      if (!F.isLive(act)) why.push("never markLive'd");
      if (!X.has(act)) why.push("no handler registered");
    } else if (el.matches("input, select, textarea")) {
      const name = "sw:" + (el.id || el.dataset.sw || "");
      if (!F.isLive(name)) why.push(`${name} never markLive'd`);
    }
    return why.join("; ") || "greyed in its own code";
  }
  function describe(el, k, nth) {
    const tip = el.dataset.tip || "", ariaDis = el.getAttribute("aria-disabled") === "true";
    const target = pressable(el);
    const href = el.tagName === "A" ? el.getAttribute("href") : "";
    return { key: k, nth, tag: el.tagName.toLowerCase(), type: el.type || "", act: el.dataset.act || "", v: el.dataset.v || "", dataId: el.dataset.id || "",
      k: el.dataset.k || "", id: el.id || "", sw: el.dataset.sw || "", cls: typeof el.className === "string" ? el.className : "", role: el.getAttribute("role") || "",
      label: label(el), visible: visible(target), region: regionOf(el), resize: el.dataset.resize || "",
      soon: el.classList.contains("soon") || (ariaDis && /coming soon/i.test(tip)), why: "",
      disabled: el.disabled === true, ariaDisabled: ariaDis, greyBox: !!el.parentElement?.closest("[aria-disabled='true']"),
      handler: el.dataset.act ? A.mods.X.has(el.dataset.act) : null,
      field: el.tagName === "SELECT", checkbox: el.tagName === "INPUT" && /checkbox|radio/.test(el.type),
      href, sameOrigin: !href || href.startsWith("#") || href.startsWith("/") || href.startsWith(location.origin) };
  }
  A.load = async () => {
    if (A.mods) return;
    const [F, X, St, ui, dom, chat, setup] = await Promise.all(["/app/core/features.js", "/app/core/actions.js", "/app/core/state.js", "/app/core/ui.js", "/app/core/dom.js", "/app/chat/chat.js", "/app/flows/setup.js"].map((u) => import(u)));
    A.mods = { F, X, S: St.S, ui, dom, chat, setup };
  };
  A.list = (sels) => {
    const counts = {};
    return controls(sels).map((el) => {
      const k = key(el), nth = (counts[k] = (counts[k] ?? -1) + 1), d = describe(el, k, nth);
      if (d.soon || d.greyBox) d.why = d.soon ? soonWhy(el) : "inside a greyed box (listen() ignores clicks under aria-disabled)";
      return d;
    });
  };
  A.prep = (k, nth, sels) => {
    const el = find(k, nth, sels);
    if (!el) return null;
    const target = pressable(el);
    target.scrollIntoView({ block: "center", inline: "center" });
    const r = target.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    A.cur = target; A.curKey = k; A.pd = null; log.ev = []; log.opens = []; log.clip = []; log.downloads = [];
    const onScreen = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    const chosen = ["aria-pressed", "aria-selected", "aria-current", "aria-checked"].some((a) => el.getAttribute(a) === "true") && !el.matches("input") || !!el.closest("li.now");
    return { x, y, w: r.width, onScreen, chosen, covered: !!top && !target.contains(top), top: desc(top), checked: el.checked ?? null, region: regionOf(el), side: document.getElementById("side")?.getBoundingClientRect().width ?? 0 };
  };
  A.after = (k, nth, sels) => {
    const el = find(k, nth, sels), active = document.activeElement;
    const inSelf = !!A.cur && (A.cur === active || A.cur.contains(active));
    return { checked: el ? el.checked ?? null : null, focus: active && active !== document.body && !inSelf ? regionOf(active) : "", focusOn: desc(active),
      ev: log.ev.slice(), opens: log.opens.slice(), clip: log.clip.slice(), downloads: log.downloads.slice(), side: document.getElementById("side")?.getBoundingClientRect().width ?? 0 };
  };
  A.snap = (k, nth, sels) => {
    const self = k ? find(k, nth, sels) : null, out = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(".tipx, .petbox, .pet-say") || el.tagName === "SCRIPT" || el.tagName === "STYLE" || !el.getClientRects().length) continue;
      const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join("")).replace(/\d+/g, "#").slice(0, 80);
      const attrs = ATTRS.filter((a) => el.hasAttribute(a)).map((a) => `${a}=${el.getAttribute(a)}`).join(",");
      const input = el.tagName === "INPUT" ? `chk=${el.checked}` : "";
      const sig = `${el.tagName}.${typeof el.className === "string" ? el.className : ""}[${attrs}]${input}"${own}"`;
      out.push(self && (el === self || self.contains(el)) ? "SELF|" + sig : sig);
    }
    return out;
  };
  const ids = new WeakMap(); let nextId = 1;
  A.overlays = () => [...document.querySelectorAll(OVERLAYS)].filter((el) => el.getClientRects().length).map((el) => {
    if (!ids.has(el)) ids.set(el, nextId++);
    const cls = el.classList.contains("pop") ? ".pop" : el.classList.contains("scrim") ? ".scrim" : el.classList.contains("ob9") ? ".ob9" : el.classList.contains("first") ? ".first" : el.classList.contains("tour-layer") ? ".tour-layer" : "[role=dialog]";
    return { id: ids.get(el), sel: cls, toast: false };
  });
  A.keys = (sels) => [...new Set(controls(sels).filter((el) => visible(pressable(el))).map((el) => key(el).replace(/\d+/g, "#")))].sort().join("\n");
  A.toast = () => norm(document.querySelector(".toast")?.innerText ?? "");
  A.fp = () => {
    const S = A.mods.S, app = document.getElementById("app");
    return JSON.stringify({ view: S.view, chat: S.chat, setPage: S.view === "settings" ? S.setPage : "", level: S.view === "settings" ? S.level : "", shut: S.placesShut,
      tab: S.tabs?.[S.view] ?? "", ob: S.ob ? S.ob.i : null, cls: ["side-hidden", "focus", "side-open"].filter((c) => app?.classList.contains(c)).join(","),
      overlays: [...document.querySelectorAll(".pop, .scrim, .ob9:not(.dead), .first, .tour-layer")].length, path: location.pathname + location.hash });
  };
  /* Closes what a press opened and puts back the window's own kept choices that a press may have flipped (the Places
     fold, the Settings level), and the conversation's find bar. */
  A.clean = (base) => {
    const { ui, S, dom, X } = A.mods;
    ui.closePop(); ui.closeDlg();
    document.getElementById("app")?.classList.remove("side-hidden", "focus", "side-open");
    if (document.querySelector(".find9") && X.has("find-close")) X.run("find-close");
    if (base && (S.placesShut !== base.shut || S.level !== base.level)) { S.placesShut = base.shut; S.level = base.level; dom.renderNow(); }
  };
  A.base = () => ({ shut: A.mods.S.placesShut, level: A.mods.S.level });
  /* Goes to a place through the window's own modules, not through the controls under audit. */
  A.go = async (spec) => {
    await A.load();
    const { S, dom, chat, setup, ui } = A.mods;
    ui.closePop(); ui.closeDlg();
    if (spec.ob == null && S.ob) { document.querySelector(".ob9")?.remove(); S.ob = null; }
    if (spec.chat) { S.view = "chat"; await chat.openConversation(spec.chat); }
    S.view = spec.view ?? "chat";
    if (spec.tab) S.tabs[spec.view] = spec.tab;
    if (spec.level) S.level = spec.level;
    if (spec.setPage) { const b = document.createElement("button"); b.dataset.act = "setpage"; b.dataset.v = spec.setPage; b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); }
    dom.renderNow();
    if (spec.ob != null) {
      if (!S.ob) await setup.openSetup(1);
      if (spec.ob > 0) { S.ob.trust = true; const b = document.createElement("button"); b.dataset.act = "ob-go"; b.dataset.v = String(spec.ob); b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); }
    }
  };
  A.highlight = (k, nth, sels) => { const el = find(k, nth, sels); if (el) { pressable(el).style.outline = "3px solid #ff00ff"; pressable(el).style.outlineOffset = "2px"; } };
}

/* ---------- one browser page per state, with its listeners ---------- */
async function openPage(browser, engine) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
  const allowed = new URL(engine.base).host;
  await ctx.route("**/*", (route) => { const u = new URL(route.request().url()); return /^(data|blob):/.test(u.protocol) || u.host === allowed ? route.continue() : route.abort(); });
  await ctx.addInitScript(pageKit);
  const page = await ctx.newPage();
  const rec = { req: [], res: [], cons: [], errs: [], dl: [], nav: [] };
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) rec.nav.push({ url: r.url(), t: Date.now() });
    if (u.pathname.startsWith("/api/")) rec.req.push({ m: r.method(), p: u.pathname, t: Date.now() });
  });
  page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 400) rec.res.push({ p: u.pathname, s: r.status(), t: Date.now() }); });
  page.on("console", (m) => { if (m.type() === "error") rec.cons.push({ text: m.text().slice(0, 240), t: Date.now() }); });
  page.on("pageerror", (e) => rec.errs.push({ text: String(e.message).slice(0, 240), t: Date.now() }));
  page.on("download", (d) => { rec.dl.push(d.suggestedFilename()); d.cancel().catch(() => {}); });
  page.on("filechooser", () => { rec.fc++; }); // a listener keeps the native picker from opening
  rec.fc = 0;
  return { ctx, page, rec };
}
async function signIn(page, engine) {
  await page.goto(engine.base + "/");
  await page.getByLabel("Session token").fill(engine.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine", { timeout: 30000 });
  await page.evaluate(() => window.__A.load());
  await page.waitForTimeout(1500);
}

/* ---------- the four states ---------- */
const PREPARE = {
  async A(page) {
    await page.waitForSelector(".ob9", { timeout: 6000 }).catch(() => null);
    if (await page.locator('.ob9 [data-act="ob-close"]').count()) await page.locator('.ob9 [data-act="ob-close"]').click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    return {};
  },
  async B(page) {
    await page.waitForSelector(".ob9", { timeout: 6000 }).catch(() => null);
    return {};
  },
  async C(page, engine) {
    await api(engine, "onboarding", { done: true });
    const first = await api(engine, "run", { prompt: "Hello, what can you do?" });
    await api(engine, "run", { prompt: "Give me a short list.", sessionId: first.sessionId });
    await page.reload(); await page.waitForSelector("#side .machine"); await page.evaluate(() => window.__A.load());
    return { chat: first.sessionId };
  },
  async D(page, engine) {
    await api(engine, "onboarding", { done: true });
    await api(engine, "trunks/switch", { part: "trunks", mode: "on" });
    const trunk = (await api(engine, "trunks", { name: "Scout" })).trunk;
    await api(engine, `trunks/${trunk.id}/say`, { text: "Hello Scout, what can you do?" });
    await page.reload(); await page.waitForSelector("#side .machine"); await page.evaluate(() => window.__A.load());
    return { chat: trunk.chatSessionId };
  },
};
const SHELL = [".titlebar", "#side", "#statusbar", ".welcome10"];
async function placesFor(state, page, prep) {
  if (state === "B") {
    return Array.from({ length: 11 }, (_, k) => ({ name: `setup step ${k}`, group: `setup-${k}`, spec: { ob: k }, roots: [".ob9"] }));
  }
  const chat = { name: "chat", group: "chat", spec: { view: "chat", chat: prep.chat ?? null }, roots: ["#main"], shell: true };
  if (state === "D") return [chat];
  const out = [chat];
  for (const view of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    await page.evaluate((v) => window.__A.go({ view: v }), view);
    await page.waitForTimeout(600);
    out.push({ name: view, group: view, spec: { view }, roots: ["#main", ".tb-head14"] });
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#main [data-act="ptab"][role="tab"]')].map((b) => [b.dataset.place, b.dataset.v]));
    for (const [place, tab] of tabs) if (place === view) out.push({ name: `${view} › ${tab}`, group: view, spec: { view, tab }, roots: ["#main", ".tb-head14"] });
  }
  await page.evaluate(() => window.__A.go({ view: "settings", level: "technical" }));
  await page.waitForTimeout(800);
  out.push({ name: "settings nav", group: "settings-nav", spec: { view: "settings", level: "technical", setPage: "general" }, roots: ["#main .set-nav", ".tb-head14"] });
  const pages = await page.evaluate(() => [...document.querySelectorAll('#main [data-act="setpage"]')].map((b) => b.dataset.v));
  for (const id of pages) out.push({ name: `settings › ${id}`, group: `settings-${id}`, spec: { view: "settings", level: "technical", setPage: id }, roots: ["#main .set-page"] });
  return out;
}

/* ---------- observing one click ---------- */
const BACKGROUND = /^\/api\/(profiles|events|stream)/;
function multiset(list) { const m = new Map(); for (const s of list) m.set(s, (m.get(s) ?? 0) + 1); return m; }
function diff(before, after, noise) {
  const a = multiset(before), b = multiset(after), changed = [];
  for (const [s, n] of b) if ((a.get(s) ?? 0) !== n && !noise.has(s)) changed.push(s);
  for (const [s, n] of a) if (!b.has(s) && n && !noise.has(s)) changed.push(s);
  const other = changed.filter((s) => !s.startsWith("SELF|"));
  return { other, self: changed.length - other.length };
}
async function learnNoise(page, run) {
  const s1 = await page.evaluate(() => window.__A.snap());
  const t0 = Date.now();
  await page.waitForTimeout(900);
  const s2 = await page.evaluate(() => window.__A.snap());
  const noise = new Set();
  const a = multiset(s1), b = multiset(s2);
  for (const s of new Set([...a.keys(), ...b.keys()])) if (a.get(s) !== b.get(s)) noise.add(s);
  for (const r of run.rec.req) if (r.t >= t0 && r.m === "GET") run.bgGets.add(r.p);
  for (const c of run.rec.cons) if (c.t >= t0) run.bgCons.add(c.text);
  return noise;
}
async function press(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
}
/* The side list's edge is dragged, not clicked: a real resize changes the list's width. */
async function drag(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y, { steps: 4 });
  await page.mouse.move(x + 60, y, { steps: 4 });
  await page.mouse.up();
}
/* A request that changes something (not a GET) counts; a GET alone is only reading, which a person cannot see, so it is
   noted but does not make a control live (the window polls /api/lock, /api/profiles and more on its own). */
function signals(run, t0, after, overlaysBefore, overlaysAfter, prep) {
  const req = run.rec.req.filter((r) => r.t >= t0 && !BACKGROUND.test(r.p));
  const writes = req.filter((r) => r.m !== "GET"), reads = req.filter((r) => r.m === "GET" && !run.bgGets.has(r.p));
  const opened = overlaysAfter.find((o) => !overlaysBefore.some((b) => b.id === o.id));
  const out = [];
  if (opened) out.push(`opened ${opened.sel}`);
  if (writes.length) out.push(`/api: ${[...new Set(writes.map((r) => `${r.m} ${r.p}`))].slice(0, 3).join(", ")}`);
  if (after.opens.length) out.push(`window.open ${after.opens[0]}`);
  const nav = run.rec.nav.find((n) => n.t >= t0);
  if (nav) out.push(`navigates the window to ${nav.url.slice(0, 80)}`);
  if (after.clip.length) out.push("clipboard write");
  if (after.downloads.length || run.rec.dl.length > run.dlMark) out.push("download");
  if (run.rec.fc > run.fcMark) out.push("file chooser opened");
  if (after.focus && after.focus !== prep.region) out.push(`focus moved to ${after.focus}`);
  return { out, opened: opened?.sel ?? null, reads: [...new Set(reads.map((r) => r.p))].slice(0, 4) };
}
function problems(run, t0) {
  const errs = run.rec.errs.filter((e) => e.t >= t0).map((e) => `pageerror: ${e.text}`);
  const cons = run.rec.cons.filter((c) => c.t >= t0 && !run.bgCons.has(c.text) && !/Failed to load resource/.test(c.text)).map((c) => `console: ${c.text}`);
  const res = run.rec.res.filter((r) => r.t >= t0);
  return { errors: [...errs, ...cons], refused: res.filter((r) => r.s < 500), broken: res.filter((r) => r.s >= 500) };
}
function forensic(prep, after, it) {
  const ev = after.ev, down = ev.find((e) => e.type === "pointerdown"), up = ev.find((e) => e.type === "pointerup"), click = ev.find((e) => e.type === "click");
  if (!prep.onScreen) return "could not be brought on screen";
  if (prep.covered) return `covered by ${prep.top}`;
  if (up && !up.connected) return "a redraw replaced it during the press (redraw swallowed the click)";
  if (!click) return down ? "no click event followed the press" : "the press never reached it";
  if (!click.self) return `the click landed on ${click.on}`;
  if (it.greyBox) return "inside an aria-disabled box: listen() ignores it";
  if (it.act && !it.handler) return `no handler registered for data-act="${it.act}"`;
  if (it.act && /^(input|textarea)/.test(after.focusOn)) return `its handler bails on an empty field: it only moves focus to ${after.focusOn}, with no sentence`;
  if (it.act) return "its handler ran and changed nothing (bails early?)";
  if (it.checkbox) return "the box flips but nothing reads it";
  return "no data-act and no listener that changes anything";
}
async function observe(page, run, place, it, sels) {
  const prep = await page.evaluate(([k, n, s]) => window.__A.prep(k, n, s), [it.key, it.nth, sels]);
  if (!prep) return { result: "GONE", detail: "not found when its turn came" };
  const before = await page.evaluate(([k, n, s]) => window.__A.snap(k, n, s), [it.key, it.nth, sels]);
  const ovBefore = await page.evaluate(() => window.__A.overlays());
  const [keysBefore, fpBefore] = await page.evaluate((s) => [window.__A.keys(s), window.__A.fp()], sels);
  run.dlMark = run.rec.dl.length; run.fcMark = run.rec.fc;
  const t0 = Date.now();
  if (it.resize) await drag(page, prep.x, prep.y); else await press(page, prep.x, prep.y);
  let found = null, after, d, sig;
  for (let waited = 0; waited <= WINDOW_MS; waited += POLL_MS) {
    await page.waitForTimeout(POLL_MS);
    const now = await page.evaluate(([k, n, s]) => window.__A.snap(k, n, s), [it.key, it.nth, sels]);
    after = await page.evaluate(([k, n, s]) => window.__A.after(k, n, s), [it.key, it.nth, sels]);
    d = diff(before, now, run.noise);
    sig = signals(run, t0, after, ovBefore, await page.evaluate(() => window.__A.overlays()), prep);
    if (!found && (d.other.length || sig.out.length || (it.resize && Math.abs(after.side - prep.side) > 5))) { found = Date.now(); }
    if (found && Date.now() - found > 300) break;
  }
  const toast = await page.evaluate(() => window.__A.toast());
  /* Controls this press revealed in place (a fold opened, a bar shown): walked like a popover's. */
  const had = new Set(keysBefore.split("\n"));
  const [keysAfter, fpAfter] = await page.evaluate((s) => [window.__A.keys(s), window.__A.fp()], sels).catch(() => ["", ""]);
  const revealed = sig.opened || fpAfter !== fpBefore ? [] : keysAfter.split("\n").filter((k) => k && !had.has(k));
  if (process.env.DEBUG) console.log(`\n  ${it.act || it.label}: ${JSON.stringify({ other: d.other.slice(0, 6), self: d.self, sig: sig.out, ev: after.ev, revealed: revealed.length })}`);
  return { ...classify({ run, place, it, prep, after, d, sig, toast, t0 }), revealed };
}
function classify({ run, place, it, prep, after, d, sig, toast, t0 }) {
  const p = problems(run, t0), happened = [...sig.out];
  if (d.other.length) happened.push(`DOM: ${d.other.length} change(s), e.g. ${d.other[0].slice(0, 90)}`);
  if (it.resize) happened.push(`side width ${Math.round(prep.side)} → ${Math.round(after.side)}`);
  if (toast) happened.push(`toast "${toast.slice(0, 80)}"`);
  const reads = sig.reads.length ? ` (read only: GET ${sig.reads.join(", ")})` : "";
  const base = { happened, opened: sig.opened, covered: prep.covered ? prep.top : "" };
  if (p.errors.length || p.broken.length) return { ...base, result: "ERROR", detail: [...p.errors, ...p.broken.map((r) => `${r.s} ${r.p}`)].join(" | ") };
  if (p.refused.length) {
    const said = toast || d.other.some((s) => /"[^"]{8,}"$/.test(s));
    return said ? { ...base, result: "REFUSED-HONEST", detail: `${p.refused.map((r) => `${r.s} ${r.p}`).join(", ")} · ${toast || "a sentence appeared"}` }
      : { ...base, result: "ERROR", detail: `refused with no visible sentence: ${p.refused.map((r) => `${r.s} ${r.p}`).join(", ")}` };
  }
  const resized = it.resize && Math.abs(after.side - prep.side) > 5;
  if (sig.out.length || d.other.length || resized) return { ...base, result: "OK", detail: happened.join("; ") };
  if (it.checkbox && prep.checked !== null && after.checked === prep.checked) return { ...base, result: "DEAD", detail: "the switch snaps back; nothing sent", diagnosis: "snaps back after a redraw, nothing saved" };
  /* Only the control's own pressed/checked state moved: inside a dialog or setup that is a choice read on Save; anywhere
     else nothing opened and nothing was kept, so it is dead to the person pressing it. */
  if (prep.chosen) return { ...base, result: "OK", chosen: true, detail: `already the chosen one; pressing it again changes nothing${reads}` };
  if (d.self && /\.scrim|\.ob9|\.first|\.pop/.test(it.region)) return { ...base, result: "OK", selfOnly: true, detail: "only the control itself changed (a choice in a form); nothing sent" };
  if (d.self) return { ...base, result: "DEAD", detail: `only its own pressed/checked state changed${reads}`, diagnosis: "toggles its own state; nothing opens, nothing is saved" };
  return { ...base, result: "DEAD", detail: `nothing observable within 1.5 s${reads}`, diagnosis: forensic(prep, after, it) };
}

/* ---------- putting the window back ---------- */
async function restore(page, run, place) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate((b) => window.__A.clean(b), run.base).catch(() => {});
  if (await settled(page, run)) return;
  await page.evaluate((spec) => window.__A.go(spec), place.spec).catch(() => {});
  await page.waitForTimeout(250);
  if (await settled(page, run)) return;
  /* Still not as it was (a bar left open, a mode left on): the saved choices are put back and the window loaded again. */
  await page.evaluate((ls) => { localStorage.clear(); for (const [k, v] of Object.entries(JSON.parse(ls))) localStorage.setItem(k, v); }, run.ls).catch(() => {});
  await page.goto(run.engine.base + "/").catch(() => {});
  await page.waitForSelector("#side .machine", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => window.__A.load());
  if (run.state === "A") { await page.evaluate(() => { const { S } = window.__A.mods; if (S.ob) { document.querySelector(".ob9")?.remove(); S.ob = null; } }); }
  await page.waitForTimeout(800);
  await enter(page, run, place);
  run.reloads++;
}
/* The window is back where the place started: same view and overlays (fp), and the same visible controls. */
async function settled(page, run) {
  const [fp, keys] = await page.evaluate((s) => [window.__A.fp(), window.__A.keys(s)], run.keySels).catch(() => ["", ""]);
  if (process.env.DEBUG && (fp !== run.fp || keys !== run.keys)) {
    const was = new Set(run.keys.split("\n")), now = new Set(keys.split("\n"));
    console.log(`\n  not settled: fp ${fp === run.fp ? "same" : `${run.fp} -> ${fp}`}; keys gone ${JSON.stringify([...was].filter((k) => !now.has(k)).slice(0, 3))} new ${JSON.stringify([...now].filter((k) => !was.has(k)).slice(0, 3))}`);
  }
  return fp === run.fp && keys === run.keys;
}
async function enter(page, run, place) {
  if (!page.url().startsWith(run.engine.base)) {
    await page.goto(run.engine.base + "/");
    await page.waitForSelector("#side .machine", { timeout: 20000 });
    await page.evaluate(() => window.__A.load());
  }
  await page.evaluate((spec) => window.__A.go(spec), place.spec);
  await page.waitForTimeout(place.spec.ob != null || place.spec.chat ? 900 : 600);
  run.keySels = [...place.roots, ...SHELL];
  run.base = await page.evaluate(() => window.__A.base());
  [run.fp, run.keys] = await page.evaluate((s) => [window.__A.fp(), window.__A.keys(s)], run.keySels);
}
/* Opens the chain of popovers/dialogs that leads to a nested control. */
/* A popover or dialog may read the engine before it draws its rows, so each next step is waited for (up to 4 s). */
async function waitFor(page, it, sels) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await page.evaluate(([k, n, s]) => { const all = window.__A.list(s).filter((d) => d.key === k); return all.length > n; }, [it.key, it.nth, sels]).catch(() => false)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}
async function openChain(page, run, place, chain, want) {
  if (!(await settled(page, run))) await restore(page, run, place);
  for (const [i, link] of chain.entries()) {
    if (i > 0 && !(await waitFor(page, link.it, link.sels))) return false;
    const prep = await page.evaluate(([k, n, s]) => window.__A.prep(k, n, s), [link.it.key, link.it.nth, link.sels]);
    if (!prep) return false;
    await press(page, prep.x, prep.y);
    await page.waitForTimeout(300);
  }
  return want ? waitFor(page, want.it, want.sels) : true;
}

/* ---------- auditing controls ---------- */
const slug = (s) => String(s || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const via = (chain) => chain.map((c) => c.it.act || c.it.label).join(" › ");
function record(run, place, chain, it, fields) {
  const row = { state: run.state, place: place.name, path: via(chain), act: it.act, v: it.v, id: it.id,
    label: it.label, region: it.region, drawn: whereDrawn(it), handled: whereHandled(it), known: knownNote(place, it), ...fields };
  run.rows.push(row);
  return row;
}
function soonRow(run, place, chain, it) {
  const k = `${place.group}|${it.key}`;
  if (run.soonSeen.has(k)) return;
  run.soonSeen.add(k);
  run.soon.push({ state: run.state, place: place.name, path: via(chain), act: it.act, id: it.id, v: it.v, label: it.label,
    why: it.why, visible: it.visible, drawn: whereDrawn(it), known: knownNote(place, it) });
}
async function shoot(page, run, place, it, sels) {
  await page.evaluate(([k, n, s]) => window.__A.highlight(k, n, s), [it.key, it.nth, sels]).catch(() => {});
  const file = `${SHOTS}/${run.state}-${slug(place.name)}-${slug(it.act || it.id || it.label)}-${++run.shots}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}
/* One control: skipped, listed, or pressed and watched. Returns the overlay it opened, if any. */
async function auditControl(page, run, place, chain, it, sels) {
  if (it.soon || it.greyBox) { soonRow(run, place, chain, it); if (it.soon) return null; }
  if (!it.visible) return null;
  const done = `${place.group}|${chain.map((c) => c.it.key).join(">")}|${it.key}|${it.nth}`;
  if (run.done.has(done)) return null;
  run.done.add(done);
  if (it.disabled || it.ariaDisabled) { record(run, place, chain, it, { result: "DISABLED", detail: "disabled, not greyed as Coming soon" }); return null; }
  if (it.field) { record(run, place, chain, it, { result: "FIELD", detail: "a select; not pressed" }); return null; }
  const deny = denyReason(it);
  if (deny) { record(run, place, chain, it, { result: "SKIPPED", detail: deny }); return null; }
  if (chain.length && !(await openChain(page, run, place, chain, { it, sels }))) { record(run, place, chain, it, { result: "GONE", detail: "its popover could not be opened again" }); return null; }
  let out;
  try { out = await observe(page, run, place, it, sels); }
  catch (error) {
    const nav = run.rec.nav.at(-1);
    out = nav && Date.now() - nav.t < 5000 ? { result: "OK", detail: `navigates the window away, to ${nav.url.slice(0, 80)}` }
      : { result: "ERROR", detail: `audit failed: ${String(error.message).split("\n")[0]}` };
  }
  const { revealed, ...fields } = out;
  const row = record(run, place, chain, it, fields);
  if (row.result === "DEAD" || row.result === "ERROR") row.screenshot = await shoot(page, run, place, it, sels);
  process.stdout.write(row.result === "OK" ? "." : row.result === "DEAD" ? "D" : row.result === "ERROR" ? "E" : "r");
  await restore(page, run, place);
  if (out.result !== "OK") return null;
  if (out.opened) return { sels: [out.opened], only: null };
  return revealed?.length ? { sels, only: new Set(revealed) } : null;
}
/* Walks the controls in `sels` (only those in `only`, for controls a press revealed in place), then, up to DEPTH, the
   ones inside each popover or dialog a control opened, reopening the chain before every press. */
async function walk(page, run, place, sels, chain, depth, only = null) {
  if (chain.length) { await restore(page, run, place); if (!(await openChain(page, run, place, chain))) return; }
  let items = await page.evaluate((s) => window.__A.list(s), sels).catch(() => []);
  if (only) items = items.filter((it) => only.has(it.key.replace(/\d+/g, "#")));
  const nested = [];
  for (const it of items) {
    if (chain.length) await restore(page, run, place);
    const next = await auditControl(page, run, place, chain, it, sels);
    if (next && depth < DEPTH) nested.push({ it, sels, next });
  }
  for (const n of nested) await walk(page, run, place, n.next.sels, [...chain, { it: n.it, sels: n.sels }], depth + 1, n.next.only);
}
async function auditPlace(page, run, place) {
  const t0 = Date.now();
  process.stdout.write(`\n[${run.state}] ${place.name} `);
  await enter(page, run, place);
  run.noise = await learnNoise(page, run);
  if (place.shell) await walk(page, run, { ...place, group: "shell" }, SHELL, [], 0);
  await enter(page, run, place);
  await walk(page, run, place, place.roots, [], 0);
  process.stdout.write(` ${Math.round((Date.now() - t0) / 1000)}s, ${run.reloads} reloads`);
}

const STATE_WORDS = {
  A: "brand-new: no model, setup dismissed, no conversations",
  B: "brand-new with setup open (every step)",
  C: "a test model (local stand-in) and one conversation with messages",
  D: "a Trunk's conversation (local stand-in model)",
};
async function auditState(browser, state, stub) {
  const engine = await startEngine(state === "C" || state === "D" ? stub.address().port : null);
  const { ctx, page, rec } = await openPage(browser, engine);
  const run = { state, engine, rec, rows: [], soon: [], soonSeen: new Set(), done: new Set(), bgGets: new Set(), bgCons: new Set(), shots: 0, dlMark: 0, reloads: 0, noise: new Set(), fp: "", keys: "", keySels: [], ls: "{}" };
  try {
    await signIn(page, engine);
    const prep = await PREPARE[state](page, engine);
    run.ls = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    let places = await placesFor(state, page, prep);
    if (ONLY_PLACES) places = places.filter((p) => ONLY_PLACES.some((n) => p.name.startsWith(n)));
    for (const place of places) {
      try { await auditPlace(page, run, place); }
      catch (error) { console.log(`\n  place failed: ${error.message.split("\n")[0]}`); run.rows.push({ state, place: place.name, result: "ERROR", detail: `place failed: ${error.message.split("\n")[0]}` }); }
    }
  } finally {
    await ctx.close().catch(() => {});
    await stopEngine(engine);
  }
  write(run);
  return run;
}

/* ---------- reports ---------- */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head, rows) => rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") : "_none_";
const byPlace = (a, b) => a.place.localeCompare(b.place) || (a.path || "").localeCompare(b.path || "") || (a.act || "").localeCompare(b.act || "");
const name = (r) => r.act || (r.id ? "#" + r.id : "");
function write(run) {
  const { state, rows, soon } = run;
  fs.writeFileSync(join(OUT, `dead-controls-${state}.json`), JSON.stringify({ state, words: STATE_WORDS[state], at: new Date().toISOString(), rows, soon }, null, 2));
  const count = (r) => rows.filter((x) => x.result === r).length;
  const pick = (...rs) => rows.filter((x) => rs.includes(x.result)).sort(byPlace);
  const md = [
    `# Dead controls, state ${state}: ${STATE_WORDS[state]}`, "",
    `Run ${new Date().toISOString()} by design/redesign/tools/audit-dead-controls.cjs.`, "",
    `OK ${count("OK")} · DEAD ${count("DEAD")} · ERROR ${count("ERROR")} · REFUSED-HONEST ${count("REFUSED-HONEST")} · SKIPPED ${count("SKIPPED")} · SOON ${soon.length} · DISABLED ${count("DISABLED")} · GONE ${count("GONE")}`, "",
    "## DEAD and ERROR", "",
    table(["Place", "Via", "data-act", "Label", "State", "Result", "Diagnosis / detail", "Known", "Drawn at", "Handler", "Screenshot"],
      pick("DEAD", "ERROR").map((r) => [r.place, r.path, name(r), r.label, state, r.result, r.diagnosis ? `${r.diagnosis} (${r.detail})` : r.detail, r.known, r.drawn, r.handled, r.screenshot ?? ""])), "",
    "## REFUSED-HONEST", "", table(["Place", "Via", "data-act", "Label", "Detail"], pick("REFUSED-HONEST").map((r) => [r.place, r.path, name(r), r.label, r.detail])), "",
    "## Changed only itself (check by hand)", "", table(["Place", "Via", "data-act", "Label", "Drawn at"], rows.filter((r) => r.selfOnly).sort(byPlace).map((r) => [r.place, r.path, name(r), r.label, r.drawn])), "",
    "## SOON (greyed Coming soon, never pressed)", "", table(["Place", "Via", "data-act / id", "Label", "State", "Why greyed", "Known", "Drawn at"],
      [...soon].sort(byPlace).map((r) => [r.place, r.path, name(r), r.label, state, r.why, r.known, r.drawn])), "",
    "## SKIPPED (deny-list)", "", table(["Place", "Via", "data-act", "Label", "Why"], pick("SKIPPED").map((r) => [r.place, r.path, name(r), r.label, r.detail])), "",
    "## DISABLED and GONE", "", table(["Place", "Via", "data-act", "Label", "Result", "Detail"], pick("DISABLED", "GONE").map((r) => [r.place, r.path, name(r), r.label, r.result, r.detail])), "",
    "## OK", "", "<details><summary>Every control that did something</summary>", "", table(["Place", "Via", "data-act", "Label", "What happened"], pick("OK").map((r) => [r.place, r.path, name(r), r.label, r.detail])), "", "</details>", "",
  ].join("\n");
  fs.writeFileSync(join(OUT, `dead-controls-${state}.md`), md);
}
/* One inventory of everything greyed as Coming soon, across the states that have been run (their JSON files). */
function writeSoon() {
  const all = new Map();
  for (const s of ["A", "B", "C", "D"]) {
    const file = join(OUT, `dead-controls-${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const r of JSON.parse(fs.readFileSync(file, "utf8")).soon) {
      const k = `${name(r)}|${r.label}`;
      const e = all.get(k) ?? { ...r, states: new Set(), places: new Set() };
      e.states.add(s); e.places.add(r.path ? `${r.place} › ${r.path}` : r.place);
      all.set(k, e);
    }
  }
  const rows = [...all.values()].sort((a, b) => name(a).localeCompare(name(b)));
  const md = ["# Everything greyed as Coming soon", "", `${rows.length} controls, from the states run by design/redesign/tools/audit-dead-controls.cjs.`, "",
    table(["data-act / id", "Label", "Why greyed", "States", "Places", "Known", "Drawn at"],
      rows.map((r) => [name(r), r.label, r.why, [...r.states].join(","), [...r.places].slice(0, 4).join("; "), r.known, r.drawn]))].join("\n");
  fs.writeFileSync(join(OUT, "dead-controls-soon.md"), md + "\n");
}

(async () => {
  if (!fs.existsSync(join(ROOT, "dist/cli.js"))) { console.error("Build first: npx tsc -p . && node scripts/copy-fonts.mjs && node scripts/copy-suites.mjs && node scripts/copy-data.mjs"); process.exit(2); }
  SRC = sourceIndex();
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const stub = await startStub();
  const browser = await playwright.chromium.launch({ headless: true });
  const summary = [];
  try {
    for (const state of STATES) {
      const run = await auditState(browser, state, stub);
      const n = (r) => run.rows.filter((x) => x.result === r).length;
      summary.push(`${state}: OK ${n("OK")}, DEAD ${n("DEAD")}, ERROR ${n("ERROR")}, REFUSED-HONEST ${n("REFUSED-HONEST")}, SKIPPED ${n("SKIPPED")}, SOON ${run.soon.length}`);
    }
  } finally {
    await browser.close();
    stub.close();
  }
  writeSoon();
  console.log("\n" + summary.join("\n"));
  console.log(`Reports in ${OUT}`);
})().catch((error) => { console.error(error); process.exit(1); });
