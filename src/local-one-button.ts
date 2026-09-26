import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { offers } from "./local-catalogue.js";
import type { Fit, MachineRoom } from "./local-fit.js";
import { installableRunners, type InstallableRunner } from "./local-install.js";
import { runtimeInfo } from "./local-launch.js";
import { localModelName } from "./local-models.js";
import { lockdownActive } from "./lockdown.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { audit } from "./audit.js";
import { currentPerson } from "./people/context.js";
import type { Store } from "./store.js";

/**
 * mac7/one-click (issue #107): the one button that takes a computer with nothing on it to a model
 * that answers — install the program, choose a model that fits, download it, connect it, prove it.
 *
 * Installing a program is the one thing Branch does that changes the owner's own computer, so it
 * has its own switch, which ships off, and it is the owner's alone. It is refused to a message from
 * a chat app, to a short-lived key (which is also how another computer reaches this one), to
 * somebody else using this computer under their own profile, to a Trunk, and to work a schedule or
 * a trigger started; and it is refused outright while Lockdown is on. Even for the owner it always
 * asks first: the plan is shown — what, from where, how big, how it is checked — and only the exact
 * plan they agreed to is carried out.
 */

export const oneButtonSetting = "local-runner-install";
const SavedSchema = z.object({ mode: FeatureModeSchema.optional() }).loose();
export const OneButtonSettingsSchema = z.object({ mode: FeatureModeSchema }).strict();

/** Whether Branch may install a program that runs models. "off" until the owner says otherwise. */
export function oneButtonMode(store: Pick<Store, "get">, owner: string): FeatureMode {
  if (lockdownActive(store, owner)) return "off";
  const saved = SavedSchema.safeParse(store.get("settings", owner, oneButtonSetting)?.data ?? {});
  return saved.success ? (saved.data.mode ?? "off") : "off";
}
/**
 * mac7/clean-uninstall: whether Branch may use a system installer, which puts the program outside
 * Branch and leaves it behind when Branch is removed. No by default; the card says so either way.
 */
export const runnerPlaceSetting = "local-runner-place";
const PlaceSchema = z.object({ systemWide: z.boolean().optional() }).loose();
export function systemWideAllowed(store: Pick<Store, "get">, owner: string): boolean {
  if (lockdownActive(store, owner)) return false;
  const saved = PlaceSchema.safeParse(store.get("settings", owner, runnerPlaceSetting)?.data ?? {});
  return saved.success ? (saved.data.systemWide ?? false) : false;
}

export function saveOneButtonMode(store: Store, owner: string, input: unknown): { mode: FeatureMode } {
  const { mode } = OneButtonSettingsSchema.parse(input);
  store.save("settings", owner, oneButtonSetting, { mode });
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "whether Branch may install a program that runs models",
    reason: `Changed from Settings to ${mode}`, outcome: "saved",
  });
  return { mode };
}

/* ---------------------------------------------------------------- who may press it */

export const installOffRefusal =
  "Branch is not set up to install a program that runs models. Turn that on in Settings, under \"Installing a program that runs models\", first.";
export const installLockdownRefusal =
  "Lockdown is on, so nothing is installed on this computer. Turn Lockdown off in Settings to allow this again.";
export const installChatRefusal =
  "A message from a chat app cannot install a program on this computer: a chat cannot prove who is typing. Do it in the Branch app.";
export const installShortLivedRefusal =
  "A short-lived key cannot install a program on this computer, and neither can another computer reaching this one. Do it in the Branch app.";
export const installTrunkRefusal =
  "A Trunk cannot install a program on this computer. Only you can, in the Branch app.";
export const installPersonRefusal =
  "Installing a program on this computer belongs to the owner. Switch back to the owner's profile to do it.";
export const installStartedElsewhereRefusal =
  "Only work you started yourself may install a program on this computer. A schedule, a trigger or another AI tool cannot.";

/**
 * Who pressed it. Every route and tool that reaches the button says so here, so the guard decides
 * from what the caller handed in and does not lean on a block somewhere upstream.
 * - `source`: "owner" for the owner's own app window; "channel" for a chat app; "schedule",
 *   "trigger", "mcp" and the rest for work that started on its own.
 * - `person`: the household profile using the app (the window's profile switch or a person's own
 *   key); null or absent for the owner.
 * - `shortLivedKey`: the request came with a short-lived key, which is also how another computer
 *   reaches this one.
 * - `trunkKeys`: set when a Trunk is asking.
 */
export interface PressContext {
  source?: string | undefined;
  runId?: string | undefined;
  trunkKeys?: unknown;
  person?: string | null | undefined;
  shortLivedKey?: boolean | undefined;
}
type Events = { events(runId: string): { kind: string; data: Record<string, unknown> }[] };

/** Why this caller may not install a program, or null. Checked before anything is fetched or run. */
export function installGuard(
  store: Pick<Store, "get"> & Partial<Events>, owner: string, context: PressContext,
  person?: string | null,
): string | null {
  if (lockdownActive(store, owner)) return installLockdownRefusal;
  if (oneButtonMode(store, owner) === "off") return installOffRefusal;
  return callerGuard(store, context, person);
}

/**
 * mac7/adapt: who is asking, apart from any switch — a chat message, a short-lived key (which is
 * also how another computer reaches this one), somebody else's profile, a Trunk, or work a schedule
 * or a trigger started. Split out of `installGuard` so a second owner-only feature asks exactly the
 * same question of exactly the same code, instead of keeping a second copy of these seven rules.
 */
export function callerGuard(
  store: Pick<Store, "get"> & Partial<Events>, context: PressContext,
  person?: string | null,
): string | null {
  const events = store as unknown as Events;
  const origin = context.runId && typeof events.events === "function" ? runOrigin(events, context.runId) : null;
  // Whichever says "somebody else" wins: what the caller handed in, or what the request carries.
  const who = person ?? context.person ?? currentPerson()?.profileId ?? null;
  if (context.shortLivedKey || startedWithShortLivedKey() || origin?.shortLivedKey) return installShortLivedRefusal;
  if (typeof events.events === "function" && startedFromChat(context, events)) return installChatRefusal;
  if (context.trunkKeys) return installTrunkRefusal;
  if (who || origin?.personProfileId || origin?.lentTo) return installPersonRefusal;
  if ((context.source ?? "owner") !== "owner" || (origin && origin.source !== "owner")) return installStartedElsewhereRefusal;
  return null;
}

/* ---------------------------------------------------------------- a small, a middle and a large */

export interface SizeChoice {
  size: "small" | "medium" | "large";
  /** The model and the size of it, as the setup route wants them. */
  model: string;
  quant: string;
  name: string;
  params: string;
  downloadBytes: number;
  fit: Fit;
  context: number;
  /** What this choice means for this computer, in plain words. */
  guidance: string;
  tools: boolean;
}

const wording: Record<SizeChoice["size"], string> = {
  small: "The quickest to download and the lightest to run. It answers fast and handles everyday questions, and it is the safe choice on a computer with little memory to spare.",
  medium: "A good balance for most people: noticeably better answers than the small one, still comfortable on a computer with memory to spare.",
  large: "The best answers of the three, and the slowest. It only makes sense when this computer has plenty of free memory, and the download is the biggest.",
};
const fitWords: Record<Fit, string> = {
  well: "It fits this computer comfortably.",
  tight: "It only just fits on this computer right now, so expect slow replies.",
  no: "It will not fit on this computer as things stand.",
};

/**
 * Three choices from Branch's own list, sized for this computer: the smallest download, the largest
 * that still fits, and one in between. Every one can use tools, because a model that cannot use
 * tools can only talk, and the button is meant to leave the owner with an assistant that works.
 */
export function sizeChoices(room: MachineRoom, runner: InstallableRunner): { choices: SizeChoice[]; recommended: SizeChoice | null } {
  const all = offers(room, runner).filter((offer) => offer.tools).flatMap((offer) => offer.variants.map((variant) => ({
    model: offer.id, quant: variant.quant, name: offer.name, params: offer.params, tools: offer.tools,
    downloadBytes: variant.downloadBytes, fit: variant.fit, context: variant.context,
  }))).sort((a, b) => a.downloadBytes - b.downloadBytes);
  if (all.length === 0) return { choices: [], recommended: null };
  const fits = all.filter((one) => one.fit !== "no");
  const top = (fits.length ? fits : all)[Math.max(0, (fits.length ? fits : all).length - 1)]!;
  const picks = [all[0]!, all[Math.floor(all.length / 2)]!, top];
  const sizes: SizeChoice["size"][] = ["small", "medium", "large"];
  const choices: SizeChoice[] = [];
  for (const [index, pick] of picks.entries()) {
    const size = sizes[index]!;
    if (choices.some((one) => one.model === pick.model && one.quant === pick.quant)) continue;
    choices.push({ ...pick, size, guidance: `${wording[size]} ${fitWords[pick.fit]}` });
  }
  const comfortable = [...choices].reverse().find((one) => one.fit === "well");
  return { choices, recommended: comfortable ?? choices[0] ?? null };
}

/* ---------------------------------------------------------------- what the route takes */

const runnerEnum = z.enum(installableRunners as unknown as [InstallableRunner, ...InstallableRunner[]]);
export const ButtonPlanSchema = z.object({
  runner: runnerEnum.optional(),
  /**
   * mac7/clean-uninstall: ask for the system-wide copy instead of the one inside Branch. Off by
   * default, because a system installer leaves the program behind when Branch is removed.
   */
  systemWide: z.boolean().optional(),
}).strict();
export const ButtonGoSchema = z.object({
  runner: runnerEnum.optional(),
  /** mac7/clean-uninstall: the owner deliberately chose the copy that lives outside Branch. */
  systemWide: z.boolean().optional(),
  /** Which of the three the owner picked; the comfortable one when they picked none. */
  size: z.enum(["small", "medium", "large"]).optional(),
  /**
   * The exact Ollama model the owner picked (one of the hardware recommendations, a name such as
   * "llama3.1:8b"). When it is given, that model is set up after the install instead of a size.
   */
  name: localModelName.optional(),
  /**
   * The plan the owner said yes to, word for word. Without it nothing is installed: a yes can only
   * ever agree to the plan that was shown on the screen.
   */
  agreedPlan: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();
export type ButtonGo = z.infer<typeof ButtonGoSchema>;

export const needsAgreementNote = (name: string): string =>
  `Branch has not installed anything. Read what it would install above, then press the button again to let it install ${name}.`;
export const planChangedNote =
  "What Branch would install has changed since you looked, so nothing was installed. Read it again and press the button again.";
export const notInstalledNote = (name: string): string =>
  `${name} still is not on this computer after the install finished, so Branch stopped rather than pretend it worked. ${runtimeInfo.ollama.installNote}`;
