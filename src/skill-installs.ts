import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { shippedUnlessChosen } from "./ship-on.js";
import type { createBranch } from "./index.js";
import { FeatureModeSchema } from "./feature-switches.js";
import { PackageInstallSchema } from "./skill-packages.js";
import { agentSkillPackage, readAgentSkill, writeAgentSkill } from "./agent-skills.js";
import { describeFindings, scanSkill } from "./skill-scan.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { fetchGitHubSkill, quarantineGitHubSkill, takeGitHubSkill, requireGitHubSkillOwner } from "./skill-github.js";
import { readSkillPackage } from "./skill-package.js";
import { skillDocumentLimit } from "./skill-document.js";

/**
 * Bucket 12 (A2374, A0776): installing and removing a skill while Branch runs, with a written
 * account of what happened — what was opened, what was checked, what was left out, what it may do,
 * and the exact reason when it stopped. The last thirty accounts are kept and shown under
 * Customize › Skills. The install itself is the same code as everywhere else (registry, package,
 * pasted SKILL.md, or an Agent Skills folder turned into a package), so a skill still arrives
 * switched off and still passes the same scan.
 *
 *   GET  /api/skill-installs            the switch, the accounts (newest first) and the skills installed
 *   GET  /api/skill-installs/export     ?skill=<id>: that skill as an Agent Skills folder (zip)
 *   POST /api/skill-installs/settings   the three-way switch (ships off)
 *   POST /api/skill-installs/inspect    what an Agent Skills folder holds; nothing is installed
 *   POST /api/skill-installs/install    install one, and write down how it went
 *   POST /api/skill-installs/remove     remove one, and write down how it went
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export const handlesSkillInstallsPath = (path: string): boolean => path === "/api/skill-installs" || path.startsWith("/api/skill-installs/");
const settingsKey = "skill-installs", logKey = "skill-install-log", keep = 30;
export const SkillInstallSettingsSchema = z.object({ mode: FeatureModeSchema.default("off") }).strict();
export const skillInstallsOff = "The install record is switched off. Switch it on under Customize › Skills.";

const fileField = PackageInstallSchema.shape.file;
export const InstallRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent-skill"), file: fileField, approve: z.boolean().default(false), allow: PackageInstallSchema.shape.allow }).strict(),
  z.object({ kind: z.literal("package"), file: fileField, approve: z.boolean().default(false), allow: PackageInstallSchema.shape.allow }).strict(),
  z.object({ kind: z.literal("registry"), url: z.string().url().max(2000), skillId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("document"), document: z.string().min(1).max(skillDocumentLimit) }).strict(),
]);
type InstallRequest = z.infer<typeof InstallRequestSchema>;

export interface InstallRecord {
  id: string; at: string; action: "install" | "remove"; source: string; name: string;
  ok: boolean; steps: string[]; error?: string;
}

// The owner's rule (ships on, 2026-09-26): a skill is installed only from a file or place the owner names, and it arrives switched off; none of (a)–(f).
export const skillInstallsShipAs = "when-needed" as const;

export function skillInstallMode(app: Pick<Branch, "store" | "runtime">) {
  const saved = SkillInstallSettingsSchema.safeParse(app.store.get("settings", app.runtime.owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(app.store, app.runtime.owner, settingsKey, saved.data, { mode: skillInstallsShipAs }).mode : "off";
}
export function installRecords(app: Pick<Branch, "store" | "runtime">): InstallRecord[] {
  const data = app.store.get("settings", app.runtime.owner, logKey)?.data as { records?: InstallRecord[] } | undefined;
  return Array.isArray(data?.records) ? data.records : [];
}
function remember(app: Branch, record: InstallRecord): InstallRecord {
  app.store.save("settings", app.runtime.owner, logKey, { records: [record, ...installRecords(app)].slice(0, keep) });
  return record;
}

/** Runs one install or removal and keeps the account of it, whether it worked or not. */
async function recorded<T>(app: Branch, action: InstallRecord["action"], source: string, work: (note: (text: string) => void, name: (value: string) => void) => Promise<T>) {
  const steps: string[] = [];
  let label = "";
  const base = { id: randomUUID(), at: new Date().toISOString(), action, source };
  try {
    const result = await work((text) => steps.push(app.runtime.hideSecrets(text)), (value) => { label = value; });
    return { result, record: remember(app, { ...base, name: label, ok: true, steps }) };
  } catch (error) {
    const reason = app.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
    steps.push(`Stopped: ${reason}`);
    const record = remember(app, { ...base, name: label, ok: false, steps, error: reason });
    return { result: null, record };
  }
}

type View = { name: string; activeVersion: number | null; headVersion: number; versions: { findings: unknown[] }[] };
function describeInstalled(note: (text: string) => void, view: View): void {
  const findings = view.versions[0]?.findings.length ?? 0;
  note(findings ? `The scan found ${findings} thing${findings === 1 ? "" : "s"} to look at before switching it on.` : "The scan found nothing to worry about.");
  note(`Installed "${view.name}" as version ${view.headVersion}, switched ${view.activeVersion === null ? "off until you turn it on" : "on"}.`);
}

async function installPackage(app: Branch, input: Extract<InstallRequest, { kind: "agent-skill" | "package" }>, note: (text: string) => void, name: (value: string) => void) {
  let bytes: Buffer = Buffer.from(input.file, "base64");
  note(`Opened the file (${Math.ceil(bytes.length / 1024)} KB).`);
  if (input.kind === "agent-skill") {
    const folder = readAgentSkill(bytes);
    note(`Found the Agent Skills folder "${folder.folder ?? folder.name}" with ${Object.keys(folder.notes).length} text reference(s).`);
    for (const item of folder.leftOut) note(`Left out ${item.path}: ${item.why}.`);
    bytes = agentSkillPackage(folder);
  }
  const preview = app.skillPackages.inspect(bytes);
  name(preview.manifest.name);
  note(`Every file matches its fingerprint (${preview.manifest.name} ${preview.manifest.packageVersion} by ${preview.manifest.author}).`);
  note(`It asks to: ${preview.permissions.map((entry) => entry.why).join("; ")}.`);
  if (!input.approve) { note("Nothing was installed: it is waiting for your yes."); return preview; }
  const done = app.skillPackages.install(bytes, true, input.allow);
  if (!("skill" in done)) throw new Error("The package was not installed.");
  for (const tool of done.leftOut) note(`Not registered, because you did not allow it: ${tool}.`);
  describeInstalled(note, done.skill as View);
  return done;
}

async function install(app: Branch, input: InstallRequest, note: (text: string) => void, name: (value: string) => void): Promise<unknown> {
  if (input.kind === "agent-skill" || input.kind === "package") return installPackage(app, input, note, name);
  if (input.kind === "registry") {
    name(input.skillId);
    note(`Asked ${new URL(input.url).host} for its list of skills.`);
    const done = await app.skillRegistry.install(input.url, input.skillId);
    note(`The file matches the fingerprint "${done.origin.registryName}" published; its signature is ${done.origin.signed}.`);
    describeInstalled(note, done as unknown as View);
    return done;
  }
  note("Read the pasted instructions.");
  const installed = app.store.skills.install(app.runtime.owner, { document: input.document });
  name(installed.name);
  // Integrator (bucket 12): pasted instructions arrive switched off, like a package or a registry skill.
  if (installed.activeVersion !== null) app.store.skills.disable(app.runtime.owner, installed.id, { expectedRevision: installed.revision });
  const done = app.store.skills.view(app.runtime.owner, installed.id);
  describeInstalled(note, done as unknown as View);
  return done;
}

async function remove(app: Branch, body: unknown, note: (text: string) => void, name: (value: string) => void) {
  const { skillId } = z.object({ skillId: z.string().uuid() }).strict().parse(body);
  const owner = app.runtime.owner, view = app.store.skills.view(owner, skillId);
  name(view.name);
  const tools = app.skillPackages.list().find((entry) => entry.skillId === skillId)?.tools ?? [];
  app.store.skills.remove(owner, skillId, { expectedRevision: view.revision });
  app.skillPackages.forget(skillId);
  app.store.delete("settings", owner, `skill-github:${skillId}`);
  note(`Removed "${view.name}", which was switched ${view.activeVersion === null ? "off" : "on"}.`);
  note(tools.length ? `Took its ${tools.length} tool(s) out of the list: ${tools.join(", ")}.` : "It had no tools of its own to take out.");
  return { removed: true };
}

function exportSkill(app: Branch, url: URL) {
  if (skillInstallMode(app) === "off") throw new Error(skillInstallsOff);
  const id = z.string().uuid().parse(url.searchParams.get("skill"));
  const view = app.store.skills.view(app.runtime.owner, id);
  const saved = app.store.get("settings", app.runtime.owner, `skill-package:${id}`)?.data as { files?: Record<string, string> } | undefined;
  const files = saved?.files ?? {};
  // Integrator (bucket 12): a skill that carries a key is not written out; the rest is masked as a last guard.
  const keys = [view.document, ...Object.values(files)].flatMap((text) => scanSkill(text).filter((found) => found.kind === "secret"));
  if (keys.length) throw new Error(`This skill was not saved as a folder because it ${describeFindings(keys)}. Take the key out first.`);
  return writeAgentSkill(app.runtime.hideSecrets(view.document), app.runtime.hideSecrets(files));
}

async function change(app: Branch, path: string, body: unknown): Promise<unknown> {
  const owner = app.runtime.owner;
  app.store.profiles.requireOwner("Installing skills");
  if (path === "/api/skill-installs/settings") {
    const value = SkillInstallSettingsSchema.parse(body ?? {});
    recordedWrite(app.store, owner, byCard(settingsKey), [settingsKey], () => app.store.save("settings", owner, settingsKey, value));
    return value;
  }
  if (skillInstallMode(app) === "off") throw new Error(skillInstallsOff);
  if (path === "/api/skill-installs/github") return inspectGitHub(app, body);
  if (path === "/api/skill-installs/github/install") return installGitHub(app, body);
  if (path === "/api/skill-installs/inspect") {
    const { file } = z.object({ file: fileField }).strict().parse(body);
    const folder = readAgentSkill(Buffer.from(file, "base64"));
    return { folder: { name: folder.name, folder: folder.folder, references: Object.keys(folder.notes), leftOut: folder.leftOut }, ...app.skillPackages.inspect(agentSkillPackage(folder)) };
  }
  if (path === "/api/skill-installs/install") {
    const input = InstallRequestSchema.parse(body);
    return recorded(app, "install", input.kind, (note, name) => install(app, input, note, name));
  }
  if (path === "/api/skill-installs/remove") return recorded(app, "remove", "installed", (note, name) => remove(app, body, note, name));
  return undefined;
}

/** Every kept text file is scanned before a preview is quarantined, and again before its one-use install. */
function githubFindings(app: Branch, bytes: Buffer) {
  const { files } = readSkillPackage(bytes);
  const findings = Object.entries(files).flatMap(([path, text]) => scanSkill(text).map((finding) => ({ ...finding, path }))).slice(0, 20);
  return { findings, blocked: findings.length > 0 && app.store.skills.policy(app.runtime.owner) === "block" };
}
async function inspectGitHub(app: Branch, body: unknown) {
  const fetched = await fetchGitHubSkill(app, body);
  requireGitHubSkillOwner(app);
  if (skillInstallMode(app) === "off") throw new Error(skillInstallsOff);
  const bytes = agentSkillPackage(fetched.folder, `${fetched.origin.owner}/${fetched.origin.repo}`.slice(0, 120));
  const origin = { ...fetched.origin, digest: createHash("sha256").update(bytes).digest("hex") };
  const preview = app.skillPackages.inspect(bytes), scanned = githubFindings(app, bytes);
  const ticket = quarantineGitHubSkill(app, bytes, origin);
  return { ticket, origin, ...preview, ...scanned, leftOut: [...fetched.leftOut, ...fetched.folder.leftOut.map((file) => file.path)] };
}
async function installGitHub(app: Branch, body: unknown) {
  requireGitHubSkillOwner(app);
  const { ticket } = z.object({ ticket: z.string().uuid(), approve: z.literal(true) }).strict().parse(body);
  const entry = takeGitHubSkill(app, ticket);
  try {
    if (githubFindings(app, entry.bytes).blocked) throw new Error("This GitHub skill is blocked by the current skill scan policy.");
    return await recorded(app, "install", "github", async (note, name) => {
      requireGitHubSkillOwner(app);
      note(`Read the pinned GitHub tree ${entry.origin.treeSha} from ${entry.origin.owner}/${entry.origin.repo}.`);
      const done = await installPackage(app, { kind: "package", file: entry.bytes.toString("base64"), approve: true, allow: [] }, note, name);
      if (!("skill" in done)) throw new Error("The GitHub skill was not installed.");
      requireGitHubSkillOwner(app);
      const skill = done.skill as View & { id: string };
      app.store.save("settings", app.runtime.owner, `skill-github:${skill.id}`, { ...entry.origin, skillVersion: skill.headVersion });
      return { ...done, origin: entry.origin };
    });
  } finally { entry.bytes.fill(0); }
}

/** Answers one request under /api/skill-installs, or undefined when the address is not one of these. */
export async function skillInstallsApi(app: Branch, method: string, url: URL, readBody: () => Promise<unknown>): Promise<unknown> {
  const path = url.pathname;
  if (method === "GET" && path === "/api/skill-installs") {
    const skills = app.store.skills.list(app.runtime.owner).map((skill) => ({ id: skill.id, name: skill.name, enabled: skill.activeVersion !== null }));
    return { mode: skillInstallMode(app), records: installRecords(app), skills };
  }
  if (method === "GET" && path === "/api/skill-installs/export") return exportSkill(app, url);
  if (method !== "POST") return undefined;
  return change(app, path, await readBody());
}
