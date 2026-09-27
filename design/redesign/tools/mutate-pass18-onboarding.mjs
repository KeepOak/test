// Proves tests/pass18-onboarding-window.test.mjs guards pass 18c's setup: each mutation below is applied to the window's
// source in place, the test is run and must fail (RED), and the file is put back byte for byte. Then the test runs once
// on the real source and must pass (GREEN). Run from the repository root after `npx tsc -p .`:
//   node design/redesign/tools/mutate-pass18-onboarding.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TEST = "tests/pass18-onboarding-window.test.mjs";
const MUTATIONS = [
  ["the wizard back to eleven steps", "public/app/flows/setup.js",
    'const WIZARD = ["welcome", "models", "trunks"];',
    'const WIZARD = ["welcome", "where", "models", "yours", "trunks", "reach", "tools", "keep", "people", "more", "check"];'],
  ["a tick written in (the prototype's where: true)", "public/app/places/overview.js",
    "const completed = new Set(E.state.onboarding.completed ?? []);",
    'const completed = new Set(["where", ...(E.state.onboarding.completed ?? [])]);'],
  ["Hide kept only in the window", "public/app/places/overview.js",
    "try { await saveProgress({ finishHidden: true }); }",
    "try { E.state.onboarding.finishHidden = true; }"],
  ["the Guide menu says Done once the wizard ends", "public/app/flows/setup.js",
    'return done === FINISH.length ? t("window.shell.shell.all-done")',
    'return done === FINISH.length || p.finishedAt ? t("window.shell.shell.all-done")'],
  ["the gateway line kept only in the window", "public/app/flows/keep18.js",
    'gw: async (on) => { const view = await api("never-break", { mode: on ? "on" : "off" }); K.gw = view.mode; K.note = !!view.note; },',
    'gw: async (on) => { K.gw = on ? "on" : "off"; K.note = true; },'],
  ["updating by itself kept only in the window", "public/app/flows/keep18.js",
    'upd: async (on) => { const view = await api("comfort", { card: "notify", values: { autoUpdate: on ? "install" : "off" } }); K.upd = view.values?.notify?.autoUpdate ?? K.upd; },',
    'upd: async (on) => { K.upd = on ? "install" : "off"; },'],
  ["the gateway line drawn on whatever the engine says", "public/app/flows/keep18.js",
    'K.gw != null && K.gw !== "off", off("gw"',
    'true, off("gw"'],
  ["the owner's name no longer asked", "public/app/places/overview.js",
    "people: () => nameField(),",
    'people: () => "",'],
  ["no phone in Reach it anywhere", "public/app/places/overview.js",
    'reach: () => `<button class="btn sm" type="button" data-act="pair">${ic("phone", "s")}${t("studio.tab.phone")}</button>`,',
    'reach: () => "",'],
  ["Where Branch runs no longer on General", "public/app/settings/pages/general.js",
    '${ownerHere() ? where() : ""}', ""],
  ["a sign-in address opened on any host", "public/app/settings/more18.js",
    'u.protocol === "https:" && u.hostname === host ? u.href : null', 'u.protocol === "https:" ? u.href : null'],
  ["a restore that replaces what is there", "public/app/settings/more18.js",
    'apiBytes("restore", ', 'apiBytes("restore?replace=1", '],
  ["the client secret drawn back into its field", "public/app/settings/more18.js",
    'type="password" id="more18-${id}-secret" value=""', 'type="password" id="more18-${id}-secret" value="${esc(s.clientSecretName)}"'],
  ["the client secret kept in the window", "public/app/settings/more18.js",
    "    secret.value = \"\";", ""],
  ["the client secret never saved", "public/app/settings/more18.js",
    "if (value) await api(`personal/signin/${id}/secret`, { value });", ""],
  ["Welcome without Bring back your Branch", "public/app/flows/setup.js",
    "</label></div>${bringBack(o)}`;", "</label></div>`;"],
];

const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=1", TEST], { encoding: "utf8", timeout: 300000 }).status;
let bad = 0;
for (const [name, file, from, to] of MUTATIONS) {
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) { console.log(`SKIPPED (not found once): ${name}`); bad++; continue; }
  try {
    writeFileSync(file, original.replace(from, to));
    const status = run();
    console.log(`${status === 0 ? "GREEN (the test missed it)" : "RED"}: ${name}`);
    if (status === 0) bad++;
  } finally {
    writeFileSync(file, original);
  }
  if (readFileSync(file, "utf8") !== original) throw new Error(`${file} was not restored`);
}
const green = run();
console.log(`${green === 0 ? "GREEN" : "RED (the real source fails)"}: unmutated`);
if (green !== 0) bad++;
process.exit(bad ? 1 : 0);
