/** SELF-207: a repeatable code change in the nightly harness's disposable workspace.
 * Static contract checks measure actual file edits, never the assistant's report.
 * This is a small settings-code fixture, not proof of shipping a change to Branch itself. */
import { readFile } from "node:fs/promises";
import { check } from "./util.mjs";

const files = ["settings.json", "settings.schema.json", "controls.json", "settings.mjs"];
const fixture = new URL("../fixtures/self-development-knob/", import.meta.url);
const canonical = (text) => text.replace(/\s+/g, "");
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

async function seed(ctx) {
  const originals = {};
  for (const name of files) {
    originals[name] = await readFile(new URL(name, fixture), "utf8");
    await ctx.write(`knob-app/${name}`, originals[name]);
  }
  return originals;
}

export const selfDevelopmentTasks = [{
  id: "self-development-add-knob", area: "self-development", title: "Add a settings knob across configuration, schema, controls and reader",
  needsTools: true, timeoutMs: 300_000,
  async run(ctx) {
    const originals = await seed(ctx);
    const run = await ctx.ask("In the isolated workspace, read all four files under knob-app/. Add the boolean setting compactMode, default false, preserving showTimestamp. "
      + "Add compactMode to settings.json, its boolean schema with default false and the required list in settings.schema.json, and a toggle labelled Compact mode in controls.json. "
      + "Preserve the existing timestampVisible function. Append this exact public reader contract to settings.mjs (formatting may differ): "
      + "export function compactModeEnabled(settings) { return settings.compactMode === true; } "
      + "Change only those four files. This is an isolated fixture: do not use GitHub, publish, merge, restart Branch, or change the engine's own settings.", { approve: true });
    const after = {};
    for (const name of files) after[name] = await ctx.read(`knob-app/${name}`);
    const settings = parse(after["settings.json"]), schema = parse(after["settings.schema.json"]), controls = parse(after["controls.json"]);
    const expectedCode = originals["settings.mjs"] + "export function compactModeEnabled(settings) { return settings.compactMode === true; }";
    return { checks: [
      check("engine completed the edit", run.status === "completed", run.status),
      check("configuration preserves old default and adds false", settings?.showTimestamp === true && settings?.compactMode === false && Object.keys(settings).length === 2),
      check("strict schema declares both boolean defaults", schema?.type === "object" && schema?.additionalProperties === false
        && schema?.properties?.showTimestamp?.type === "boolean" && schema?.properties?.showTimestamp?.default === true
        && schema?.properties?.compactMode?.type === "boolean" && schema?.properties?.compactMode?.default === false
        && Object.keys(schema.properties).length === 2 && Array.isArray(schema.required)
        && schema.required.length === 2 && schema.required.includes("showTimestamp") && schema.required.includes("compactMode")),
      check("controls preserve the old toggle and expose the knob", Array.isArray(controls) && controls.length === 2
        && controls.some((c) => c.key === "showTimestamp" && c.type === "toggle" && c.label === "Show timestamp")
        && controls.some((c) => c.key === "compactMode" && c.type === "toggle" && c.label === "Compact mode")),
      check("reader preserves old code and implements exact contract", typeof after["settings.mjs"] === "string"
        && canonical(after["settings.mjs"]) === canonical(expectedCode)),
    ], detail: "Static file contract; no model judge, UI or release proof" };
  },
}];
