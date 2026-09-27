// The stress test's B001-B008: applies each named mutation (to dist/ or public/) in turn, runs
// tests/stress-test-fixes.test.mjs, prints which tests went red, and puts the file back (checked by hash). Exits 1 when any
// mutation leaves every test green. Run from the repo root after `npx tsc -p .`: node design/redesign/tools/mutate-stress-fixes.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (text) => createHash("sha256").update(text).digest("hex");
/** [name, [file, from, to]...]: every change of one mutation, each found exactly once. */
const M = [
  ["S1 B008 greyed on sign-in instead of the engine's answer for the caller", ["public/app/places/switch-on.js", "export const trunkCanUse = (preset) => !preset?.trunkUse || preset.trunkUse.ok === true;", "export const trunkCanUse = (preset) => !preset?.signIn;"]],
  ["S2 B008 greyed whenever the engine gives no answer", ["public/app/places/switch-on.js", "export const trunkCanUse = (preset) => !preset?.trunkUse || preset.trunkUse.ok === true;", "export const trunkCanUse = (preset) => preset?.trunkUse?.ok === true;"]],
  ["S3 the prompts switch posts the wrong body", ["public/app/places/switch-on.js", 'post: ["prompts/settings", { mode: "when-needed" }]', 'post: ["prompts/settings", { enabled: true }]']],
  ["S4 the switch drawn for anybody", ["public/app/places/switch-on.js", "const act = ownerHere()", "const act = true"]],
  ["S5 a switch the engine kept off is believed", ["public/app/places/switch-on.js", 'if (mode === "off") throw new Error', 'if (false) throw new Error']],
  ["S6 B001 History draws no tile while off", ["public/app/places/inbox.js", 'if (recMode === "off" && (E.state.runs ?? []).length) return', 'if (false) return']],
  ["S7 B001 Watch again back to a lone toast", ["public/app/places/inbox.js", 'openDlg({ title: t("recordings.title"), body: recordingsOff(error.message) })', 'toast(error.message)']],
  ["S8 B002 Add pressable with an empty box", ["public/app/places/automations.js", 'data-act="nl-add"${boxEmpty()}', 'data-act="nl-add"']],
  ["S9 B005 no switch above saved prompts", ["public/app/places/automations.js", '${promptsOff() ? offTile("prompts"', '${false ? offTile("prompts"']],
  ["S10 B005 Save pressable on a blank form", ["public/app/flows/prompts.js", 'data-act="prompt-save" disabled>', 'data-act="prompt-save">']],
  ["S11 B006 Triggers without the procedures switch", ["public/app/places/automations.js", '${proceduresMode === "off" ? offTile("procedures"', '${false ? offTile("procedures"']],
  ["S12 B007 Board's sentence without its switch", ["public/app/places/automations.js", 'boardProblem ? offTile("board", boardProblem)', 'boardProblem ? ""']],
  ["S13 B003 Add it greyed again", ["public/app/places/automations17.js", '"orderaddb17", "sw:order-in-b17"', '"sw:order-in-b17"']],
  ["S14 B004 raw tool calls as steps", ["public/app/flows/flow-editor.js", "text: toolWords.get(s.tool) || s.tool", "text: [s.tool, argsText(s.args)].join(\" \")"]],
  ["S15 B008 a sign-in connection pickable for a Trunk", ["public/app/flows/trunk.js", '${trunkCanUse(p) ? "" : "disabled"}', '']],
  ["S17 B006 procedures switched on without the owner's yes", ["dist/autonomy/api.js", 'return looser && mode !== "off"', 'return false && mode !== "off"']],
  ["S18 B006 procedures switched on under Lockdown with the yes", ["dist/autonomy/api.js", "confirmLoosening, lockdownActive(autonomy.store, autonomy.owner));", "confirmLoosening, false);"]],
  ["S19 B006 the window sends the yes before the owner gives it", ["public/app/places/switch-on.js", "await api(path, confirmLoosening ? { ...body, confirmLoosening: true } : body);", "await api(path, { ...body, confirmLoosening: true });"]],
  ["S16 B008 the message sent anyway", ["public/app/chat/chat.js", 'if (trunkModelRefused()) { S.drafts[C.sessionId ?? "new"] = prompt; showModelMenu(); return; }', '']],
];

const results = [];
for (const [name, ...changes] of M) {
  const originals = new Map();
  for (const [file] of changes) if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  const edited = new Map(originals);
  for (const [file, from, to] of changes) {
    const text = edited.get(file);
    if (text.split(from).length !== 2) throw new Error(`${name}: pattern not found exactly once in ${file}`);
    edited.set(file, text.replace(from, to));
  }
  let run;
  try {
    for (const [file, text] of edited) writeFileSync(file, text);
    run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", "tests/stress-test-fixes.test.mjs"], { encoding: "utf8" });
  } finally {
    for (const [file, text] of originals) {
      writeFileSync(file, text);
      if (hash(readFileSync(file, "utf8")) !== hash(text)) throw new Error(`${file} not restored`);
    }
  }
  const red = [...new Set((run.stdout + run.stderr).split("\n").filter((line) => /^✖ /.test(line) && !/failing tests/.test(line)))];
  results.push(`${red.length ? "RED  " : "GREEN"} ${name}\n${red.map((line) => `      ${line.replace(/ \(\d+(\.\d+)?ms\)$/, "")}`).join("\n")}`);
}
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("GREEN")) ? 1 : 0);
