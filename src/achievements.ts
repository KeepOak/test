import { readFileSync } from "node:fs";
import { inferToolGroup } from "./catalog.js";
import type { AchievementTallies } from "./achievement-tallies.js";

/**
 * phase2/delight: the achievements — 500 in five tiers of exactly 100 (Bronze, Silver, Gold, Diamond,
 * Godly) and five near-impossible ones (SSS+), 505 in all.
 *
 * Every one is earned from something that really happened and was written down: a row in Branch's own
 * records (a finished task, a conversation, a tool that ran, an answered approval, a live voice call;
 * src/achievement-tallies.ts and the audit log) or a moment the owner's own window saw and reported
 * (a theme worn, the acorn turned, a pet chosen; `noticed` below, a closed list). Nothing is granted
 * for time passing and nothing is estimated. The tiers come from how long an everyday owner would
 * take (`days`), sorted and cut into hundreds, so Bronze is what a first week brings and Godly is
 * years of use.
 */
export const achievementTiers = ["Bronze", "Silver", "Gold", "Diamond", "Godly", "SSS+"] as const;
export type AchievementTier = (typeof achievementTiers)[number];
export interface Achievement {
  id: string;
  name: string;
  desc: string;
  kind: string;
  /** What is measured ("tasks", "audit:lockdown.changed", "noticed:theme:light:forest"…) and how many. */
  metric: string;
  goal: number;
  tier: AchievementTier;
}
type Draft = Omit<Achievement, "tier"> & { days: number };

/** What the window may report having seen. Everything else is refused. */
export const petKinds = ["squirrel", "owl", "hedgehog", "fox", "robin", "rabbit", "snail", "fawn",
  // pass 17: the picture pets the window draws from /art/pets (a still and a walk loop each)
  "redpanda", "pangolin", "quokka", "acornling", "goatkid", "piglet",
  // the delight catalogue: Little Branch and the painted pets of the prototype (pass 12), each a still and a walk loop in
  // /art/pets; the painted squirrel is "pet-squirrel", the prototype's own key, as "squirrel" is the pixel one
  "sprout", "mossfrog", "leafhog", "fennec", "otter", "capybara", "cloverbun", "owlet", "shellsnail", "jelly",
  "cloudsheep", "pebblecrab", "caterpillar", "sprigdragon", "turtle", "penguin", "puppy", "kitten", "raccoon", "koala",
  "sloth", "fruitbat", "bumblebee", "beetle", "duckling", "hamster", "sealpup", "octopus", "chameleon", "firefly",
  "dustbunny", "mossgolem", "narwhal", "pet-squirrel", "elephant"] as const;
export const petNames: Record<(typeof petKinds)[number], string> = {
  squirrel: "Squirrel", owl: "Owl", hedgehog: "Hedgehog", fox: "Fox", robin: "Robin", rabbit: "Rabbit", snail: "Snail", fawn: "Deer fawn",
  redpanda: "Red panda", pangolin: "Pangolin", quokka: "Quokka", acornling: "Acorn sprite", goatkid: "Goat kid", piglet: "Teacup piglet",
  sprout: "Little Branch", mossfrog: "Moss frog", leafhog: "Leaf hog", fennec: "Fennec", otter: "Otter",
  capybara: "Capybara", cloverbun: "Clover bun", owlet: "Owlet", shellsnail: "Shell snail", jelly: "Jelly",
  cloudsheep: "Cloud sheep", pebblecrab: "Pebble crab", caterpillar: "Caterpillar", sprigdragon: "Sprig dragon",
  turtle: "Turtle", penguin: "Penguin", puppy: "Puppy", kitten: "Kitten", raccoon: "Raccoon", koala: "Koala",
  sloth: "Sloth", fruitbat: "Fruit Bat", bumblebee: "Bumblebee", beetle: "Beetle", duckling: "Duckling",
  hamster: "Hamster", sealpup: "Seal Pup", octopus: "Octopus", chameleon: "Chameleon", firefly: "Firefly",
  dustbunny: "Dust bunny", mossgolem: "Moss Golem", narwhal: "Narwhal", "pet-squirrel": "Squirrel",
  elephant: "Elephant",
};
export const seasons = ["spring", "summer", "autumn", "winter"] as const;
export const backgroundKinds = ["picture", "video", "animation", "3d"] as const;
export const noticedFlags: Record<string, [string, string, string]> = {
  // The old window's acorn, re-mapped to the new window's moments (the ids are kept, so what was earned stays earned):
  // the tree at the foot of the list, and turning the season behind the glass yourself.
  "acorn-shown": ["Keeper of the tree", "Keep the tree at the foot of the list.", "Looks"],
  "acorn-turned": ["Turn of the season", "Change the season behind the glass yourself.", "Looks"],
  still: ["Still life", "Turn on Keep things still.", "Looks"],
  everything: ["Everything, everywhere", "Choose Technical under How much to show.", "Explorer"], // was Show everything
  "follow-system": ["Follow the sun", "Let Branch follow your computer's light or dark.", "Looks"],
  language: ["Multilingual", "Change the language.", "Explorer"],
  "pet-named": ["Name tag", "Give your pet a name.", "Pets"],
  "pet-talks-off": ["Quiet companion", "Ask your pet to stop talking.", "Pets"],
  quiet: ["Quiet please", "Keep achievements quiet (this one doesn't pop up).", "Secrets"],
  "style-3d": ["Third dimension", "Draw the acorn and the pet in 3D.", "Looks"],
  lonely: ["It's lonely over here", "Hide everything that can be hidden.", "Secrets"],
};

const RUNGS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250,
  1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000];
const DAY_RUNGS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 100, 120, 150, 180, 200, 250, 300, 365, 400, 500, 600, 730, 1000, 1095, 1461, 1826, 2000, 2500, 3000];
const STREAK_RUNGS = [2, 3, 4, 5, 6, 7, 10, 14, 21, 28, 30, 45, 50, 60, 75, 90, 100, 120, 150, 180, 200, 250, 300, 365, 500, 730, 1000];
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const number = (n: number): string => n.toLocaleString("en-GB");
const plural = (n: number, one: string, many = `${one}s`): string => `${number(n)} ${n === 1 ? one : many}`;

interface Ladder { metric: string; kind: string; pace: number; rungs: number[]; name: (n: number) => string; desc: (n: number) => string }
/** The long ladders. They fill the catalogue up to 500 in turns, first rungs first. */
const ladders: Ladder[] = [
  { metric: "tasks", kind: "Getting started", pace: 8, rungs: RUNGS, name: (n) => (n === 1 ? "Sprout" : `${plural(n, "task")} done`), desc: (n) => `Finish ${plural(n, "task")}.` },
  { metric: "conversations", kind: "Getting started", pace: 3, rungs: RUNGS.filter((n) => n <= 50000), name: (n) => plural(n, "conversation"), desc: (n) => `Have ${plural(n, "conversation")}.` },
  { metric: "days", kind: "Every day", pace: 0.7, rungs: DAY_RUNGS, name: (n) => `${plural(n, "day")} together`, desc: (n) => `Finish a task on ${plural(n, "different day")}.` },
  { metric: "streak", kind: "Every day", pace: 0.45, rungs: STREAK_RUNGS, name: (n) => `${number(n)}-day streak`, desc: (n) => `Finish a task every day for ${plural(n, "day")} in a row.` },
  { metric: "src:schedule", kind: "Automations", pace: 2, rungs: RUNGS.filter((n) => n <= 30000), name: (n) => `${plural(n, "scheduled run")}`, desc: (n) => `Let schedules finish ${plural(n, "task")}.` },
  { metric: "src:channel", kind: "Chat apps", pace: 3, rungs: RUNGS.filter((n) => n <= 30000), name: (n) => `${plural(n, "chat app task")}`, desc: (n) => `Finish ${plural(n, "task")} asked for from a chat app.` },
  { metric: "src:trigger", kind: "Automations", pace: 1, rungs: RUNGS.filter((n) => n <= 20000), name: (n) => `${plural(n, "triggered task")}`, desc: (n) => `Finish ${plural(n, "task")} a trigger started.` },
  { metric: "audit:approval.decided", kind: "Safety", pace: 4, rungs: RUNGS.filter((n) => n <= 50000), name: (n) => (n === 1 ? "Yes or no" : `${plural(n, "approval")} answered`), desc: (n) => `Answer ${plural(n, "approval question")}.` },
  { metric: "tool:all", kind: "Tools", pace: 40, rungs: RUNGS, name: (n) => `${plural(n, "tool")} used`, desc: (n) => `Let tasks use tools ${plural(n, "time")}.` },
  { metric: "tool:files", kind: "Tools", pace: 10, rungs: RUNGS.filter((n) => n <= 50000), name: (n) => `${plural(n, "file step")}`, desc: (n) => `Let tasks read or change files ${plural(n, "time")}.` },
  { metric: "tool:web", kind: "Tools", pace: 6, rungs: RUNGS.filter((n) => n <= 50000), name: (n) => `${plural(n, "web lookup")}`, desc: (n) => `Let tasks look things up on the web ${plural(n, "time")}.` },
  { metric: "tool:browser", kind: "Tools", pace: 4, rungs: RUNGS.filter((n) => n <= 30000), name: (n) => `${plural(n, "browser step")}`, desc: (n) => `Let tasks use the browser ${plural(n, "time")}.` },
  { metric: "tool:code", kind: "Tools", pace: 6, rungs: RUNGS.filter((n) => n <= 50000), name: (n) => `${plural(n, "code step")}`, desc: (n) => `Let tasks run code or commands ${plural(n, "time")}.` },
  { metric: "tool:memory", kind: "Tools", pace: 3, rungs: RUNGS.filter((n) => n <= 20000), name: (n) => `${plural(n, "memory step")}`, desc: (n) => `Let tasks use what Branch remembers ${plural(n, "time")}.` },
  { metric: "tool:documents", kind: "Tools", pace: 1, rungs: RUNGS.filter((n) => n <= 10000), name: (n) => `${plural(n, "document step")}`, desc: (n) => `Let tasks read or write documents ${plural(n, "time")}.` },
  { metric: "event:voice.transcribed", kind: "Voice", pace: 2, rungs: RUNGS.filter((n) => n <= 20000), name: (n) => (n === 1 ? "Written out" : `${plural(n, "recording")} written out`), desc: (n) => `Have tasks write out ${plural(n, "sound recording")}.` },
  { metric: "event:voice.live.started", kind: "Voice", pace: 0.4, rungs: RUNGS.filter((n) => n <= 5000), name: (n) => (n === 1 ? "Voice of reason" : `${plural(n, "live conversation")}`), desc: (n) => `Talk live ${plural(n, "time")}.` },
  { metric: "stopped", kind: "Safety", pace: 0.3, rungs: RUNGS.filter((n) => n <= 2500), name: (n) => (n === 1 ? "Stop right there" : `${plural(n, "task")} stopped`), desc: (n) => `Stop ${plural(n, "running task")}.` },
];

/* ---------- the fixed ones ---------- */
let themeList: [string, string][] | null = null;
/** The 44 themes, read from the window's own catalogue so the two lists can never disagree. */
export function themeNames(): [string, string][] {
  if (themeList) return themeList;
  try {
    const text = readFileSync(new URL("../public/theme-catalogue.js", import.meta.url), "utf8");
    themeList = [...text.matchAll(/^\s*\["([a-z0-9-]+)", "([^"]+)", "[a-z-]+", \{/gm)].map((m) => [m[1], m[2]] as [string, string]);
  } catch { themeList = []; }
  return themeList;
}
const draft = (metric: string, goal: number, kind: string, name: string, desc: string, days: number): Draft =>
  ({ id: `${metric}:${goal}`, metric, goal, kind, name, desc, days });
function themeDrafts(): Draft[] {
  const themes = themeNames();
  const out = themes.flatMap(([id, name], i) => [
    draft(`noticed:theme:light:${id}`, 1, "Looks", `${name} by daylight`, `Wear ${name} in light mode.`, 1 + i * 0.02),
    draft(`noticed:theme:dark:${id}`, 1, "Looks", `${name} by moonlight`, `Wear ${name} in dark mode.`, 1.4 + i * 0.02),
  ]);
  const counts = [3, 5, 10, 20, 30, 40].filter((n) => n < themes.length).concat(themes.length ? [themes.length] : []);
  for (const n of counts)
    out.push(draft("noticed:themes", n, "Looks", n === themes.length ? "Every leaf on the tree" : `${n} themes tried`, `Wear ${n} different themes.`, n * 0.4));
  return out;
}
function looks(): Draft[] {
  const out = themeDrafts();
  for (const s of seasons) out.push(draft(`noticed:season:${s}`, 1, "Looks", `The oak in ${s}`, `See the oak in ${s}.`, 1.2));
  out.push(draft("noticed:seasons", 4, "Looks", "Four seasons", "See the oak in every season.", 3));
  const bg: Record<(typeof backgroundKinds)[number], [string, string]> = { picture: ["Your own view", "a picture"], video: ["Moving pictures", "a video"], animation: ["Flip book", "an animation"], "3d": ["Sculpture garden", "a 3D object"] };
  for (const kind of backgroundKinds) out.push(draft(`noticed:bg:${kind}`, 1, "Looks", bg[kind][0], `Put ${bg[kind][1]} behind the glass.`, 2.5));
  for (const n of [1, 3, 6, 10]) out.push(draft("noticed:pages", n, "Explorer", n === 1 ? "Settled in" : `${n} Settings pages`, `Open ${plural(n, "page")} of Settings.`, n * 0.5));
  for (const [flag, [name, desc, kind]] of Object.entries(noticedFlags))
    out.push(draft(`noticed:flag:${flag}`, 1, kind, name, desc, flag === "lonely" ? 6 : flag === "quiet" ? 4 : 2));
  return out;
}
/** The pets with a "Met the …" achievement of their own: the first fourteen. The delight catalogue's later pets are chosen
 *  and kept like the rest but add none, so the 500 keep their long ladders (a 100-day streak) and every tier stays put. */
const metPets = petKinds.slice(0, 14);
function pets(): Draft[] {
  const out = metPets.map((kind, i) => draft(`noticed:pet:${kind}`, 1, "Pets", `Met the ${petNames[kind].toLowerCase()}`, `Choose the ${petNames[kind].toLowerCase()} as your pet.`, 1.5 + i * 0.1));
  for (const n of [1, 10, 25, 50, 100, 250, 500, 1000])
    out.push(draft("noticed:pats", n, "Pets", n === 1 ? "Pat pat" : `${plural(n, "pat")}`, `Pat your pet ${plural(n, "time")}.`, 1 + n / 15));
  return out;
}
/** [what is counted, the goals, kind, the name for a goal, how many an everyday owner makes a day, the sentence] */
type Row = [string, number[], string, (n: number) => string, number, (n: number) => string];
const auditRows: Row[] = [
  ["lockdown.changed", [1, 10, 50], "Safety", (n) => (n === 1 ? "Lockdown drill" : `Lockdown ${plural(n, "time")}`), 0.1, (n) => `Switch Lockdown on or off ${plural(n, "time")}.`],
  ["channel.paired", [1, 2, 3, 5], "Chat apps", (n) => (n === 1 ? "Paired" : `${plural(n, "chat app")} paired`), 0.05, (n) => `Pair ${plural(n, "chat app")}.`],
  ["secret.used", [1, 10, 100, 1000], "Safety", (n) => (n === 1 ? "Kept secret" : `${plural(n, "secret")} handed over safely`), 1, (n) => `Let a task use a secret from the locker ${plural(n, "time")}.`],
  ["connection.changed", [1, 3, 5, 10], "Getting started", (n) => (n === 1 ? "Connected" : `${plural(n, "connection change")}`), 0.1, (n) => `Add or remove a model connection ${plural(n, "time")}.`],
  ["data.exported", [1, 5, 25], "Explorer", (n) => (n === 1 ? "Paper trail" : `${plural(n, "export")}`), 0.05, (n) => `Export something ${plural(n, "time")}.`],
  ["data.imported", [1, 3], "Getting started", (n) => (n === 1 ? "Moving in" : `${plural(n, "import")}`), 0.03, (n) => `Bring things in from another assistant ${plural(n, "time")}.`],
  ["token.issued", [1, 5, 25], "Explorer", (n) => (n === 1 ? "Key maker" : `${plural(n, "key")} made or taken back`), 0.05, (n) => `Make or take back a short-lived key ${plural(n, "time")}.`],
  ["browser.borrowed", [1, 10, 100], "Tools", (n) => (n === 1 ? "Borrowed browser" : `Browser borrowed ${plural(n, "time")}`), 0.2, (n) => `Lend Branch your own browser ${plural(n, "time")}.`],
  ["network.connected", [1, 10, 100, 500], "Voice", (n) => (n === 1 ? "Open line" : `${plural(n, "open line")}`), 0.3, (n) => `Hold a live connection, such as a voice call, ${plural(n, "time")}.`],
  ["hook.blocked", [1, 10, 100], "Safety", (n) => (n === 1 ? "House rules" : `Your checks held ${plural(n, "time")}`), 0.1, (n) => `Have one of your own checks stop or hold something ${plural(n, "time")}.`],
  ["profile.switched", [1, 10, 100], "People", (n) => (n === 1 ? "Family" : `${plural(n, "profile switch", "profile switches")}`), 0.1, (n) => `Switch profiles ${plural(n, "time")}.`],
  ["practice.switched", [1], "Getting started", () => "Practice run", 0.1, () => "Switch practice mode on or off."],
  ["mcp.tried", [1, 5, 25], "Explorer", (n) => (n === 1 ? "Tool server" : `${plural(n, "tool server")} tried`), 0.05, (n) => `Try another AI tool's server ${plural(n, "time")}.`],
  ["history.pruned", [1, 5], "Explorer", (n) => (n === 1 ? "Spring clean" : `${plural(n, "clear-out")}`), 0.03, (n) => `Clear out old conversations ${plural(n, "time")}.`],
  ["policy.changed", [1, 10, 50], "Safety", (n) => (n === 1 ? "Rule maker" : `${plural(n, "rule change")}`), 0.1, (n) => `Change when Branch checks with you ${plural(n, "time")}.`],
  ["limit.reached", [1], "Safety", () => "Speed limit", 0.05, () => "Have a limit you set hold something back."],
];
const recordRows: Row[] = [
  ["schedules", [1, 3, 5, 10, 25], "Automations", (n) => (n === 1 ? "On a schedule" : `${plural(n, "schedule")}`), 0.1, (n) => `Have ${plural(n, "schedule")}.`],
  ["procedures", [1, 3, 5, 10, 25], "Automations", (n) => (n === 1 ? "Saved steps" : `${plural(n, "procedure")}`), 0.1, (n) => `Save ${plural(n, "procedure")}.`],
  ["specialists", [1, 3, 5, 10], "Explorer", (n) => (n === 1 ? "Specialist" : `${plural(n, "specialist")}`), 0.07, (n) => `Have ${plural(n, "specialist")}.`],
  ["triggers", [1, 3, 5, 10], "Automations", (n) => (n === 1 ? "Tripwire" : `${plural(n, "trigger")}`), 0.07, (n) => `Have ${plural(n, "trigger")}.`],
  ["webhooks", [1, 3, 5], "Automations", (n) => (n === 1 ? "Webhook hello" : `${plural(n, "webhook")}`), 0.05, (n) => `Have ${plural(n, "outgoing webhook")}.`],
  ["workflows", [1, 3, 5, 10], "Automations", (n) => (n === 1 ? "Workflow" : `${plural(n, "workflow")}`), 0.05, (n) => `Have ${plural(n, "workflow")}.`],
  ["memory", [1, 10, 50, 100, 250, 500, 1000], "Explorer", (n) => (n === 1 ? "Memory lane" : `${plural(n, "thing")} remembered`), 1, (n) => `Have Branch remember ${plural(n, "thing")}.`],
];
const eventRows: Row[] = [
  ["trunk.turn", [1, 10, 100, 1000], "Trunks", (n) => (n === 1 ? "Trunk talk" : `${plural(n, "Trunk turn")}`), 2, (n) => `Let Trunks take ${plural(n, "turn")} in a conversation.`],
  ["team.ran", [1, 10, 100], "Trunks", (n) => (n === 1 ? "Team player" : `${plural(n, "team run")}`), 0.2, (n) => `Run a team of assistants ${plural(n, "time")}.`],
  ["heartbeat.notified", [1, 10, 100, 500], "Automations", (n) => (n === 1 ? "Check-in" : `${plural(n, "check-in")}`), 0.5, (n) => `Get ${plural(n, "check-in")} with news.`],
  ["skill.candidate_drafted", [1, 5, 25, 100], "Explorer", (n) => (n === 1 ? "Skill up" : `${plural(n, "skill")} drafted`), 0.1, (n) => `Have Branch draft ${plural(n, "skill")}.`],
  ["learning.reviewed", [1, 10, 100], "Explorer", (n) => (n === 1 ? "Lessons learned" : `${plural(n, "task")} looked back on`), 0.2, (n) => `Let Branch look back on ${plural(n, "task")} to learn from them.`],
  ["voice.spoken", [1, 10, 100, 1000], "Voice", (n) => (n === 1 ? "Read aloud" : `${plural(n, "answer")} read aloud`), 1, (n) => `Hear ${plural(n, "answer")} read aloud.`],
  ["voice.live.interrupted", [1, 10, 100], "Voice", (n) => (n === 1 ? "Excuse me" : `Cut in ${plural(n, "time")}`), 0.2, (n) => `Cut in on a live voice answer ${plural(n, "time")}.`],
  ["documents.question", [1, 10, 100], "Explorer", (n) => (n === 1 ? "Ask the documents" : `${plural(n, "document question")}`), 0.5, (n) => `Ask your documents ${plural(n, "question")}.`],
  ["wasm.ran", [1, 10], "Explorer", (n) => (n === 1 ? "Little program" : `${plural(n, "little program")} run`), 0.1, (n) => `Run a WebAssembly add-on ${plural(n, "time")}.`],
];
const rows = (prefix: string, list: Row[]): Draft[] =>
  list.flatMap(([key, rungs, kind, name, pace, desc]) => rungs.map((n) => draft(`${prefix}:${key}`, n, kind, name(n), desc(n), n / pace)));
function times(): Draft[] {
  const out: Draft[] = [];
  const hours: [string, string, string, number[]][] = [["night", "Night owl", "after midnight and before five", [1, 10, 50, 100, 500]],
    ["early", "Early bird", "between five and seven in the morning", [1, 10, 50, 100, 500]], ["noon", "Lunch break", "between noon and one", [1, 10, 100]]];
  for (const [key, name, when, rungs] of hours) for (const n of rungs)
    out.push(draft(`hour:${key}`, n, "Every day", n === 1 ? name : `${name} ×${number(n)}`, `Finish ${plural(n, "task")} ${when}.`, n * 5));
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  days.forEach((day, i) => out.push(draft(`weekday:${i}`, 1, "Every day", `A ${day} task`, `Finish a task on a ${day}.`, 3 + i * 0.1)));
  for (const n of [1, 10, 100, 1000]) out.push(draft("weekend", n, "Every day", n === 1 ? "Weekend worker" : `${plural(n, "weekend task")}`, `Finish ${plural(n, "task")} on a weekend.`, n * 2));
  for (const n of [10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450])
    out.push(draft("earned", n, "Secrets", `Collector: ${number(n)}`, `Earn ${plural(n, "other achievement")}.`, n * 0.8));
  return out;
}

/* ---------- the catalogue ---------- */
/** Evenly spaced rungs from each ladder, first and last included, until the catalogue holds 500. */
function fill(need: number): Draft[] {
  const sizes = ladders.map((l) => l.rungs.length);
  const total = sum(sizes);
  const take = sizes.map((size) => Math.max(2, Math.floor((size * need) / total)));
  const at = (i: number): number => take[i] ?? 0;
  for (let i = 0; sum(take) < need; i = (i + 1) % take.length) if (at(i) < (sizes[i] ?? 0)) take[i] = at(i) + 1;
  for (let i = 0; sum(take) > need; i = (i + 1) % take.length) if (at(i) > 2) take[i] = at(i) - 1;
  return ladders.flatMap((l, i) => spaced(l.rungs, at(i)).map((n) => draft(l.metric, n, l.kind, l.name(n), l.desc(n), n / l.pace)));
}
/** k rungs spread evenly over a ladder, its first and last included. */
function spaced(rungs: number[], k: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < k; j++) out.push(rungs[Math.round((j * (rungs.length - 1)) / Math.max(1, k - 1))] ?? 0);
  return [...new Set(out)];
}
const secretsOfSecrets = (leaves: number): Achievement[] => [
  ["streak", 3650, "Ten-year streak", "Finish a task every single day for ten years."],
  ["earned", 500, "The whole tree", "Earn every one of the other 500 achievements."],
  ["tasks", 1000000, "A million tasks", "Finish 1,000,000 tasks."],
  ["noticed:leaves", leaves, "Every leaf, every season, every light", "Wear every theme, light and dark, in each of the four seasons."],
  ["solstice", 1, "Solstice at midnight", "Finish a task in the first hour of 21 December."],
].map(([metric, goal, name, desc]) => ({ id: `sss:${metric}`, metric: String(metric), goal: Number(goal), name: String(name), desc: String(desc), kind: "Secrets", tier: "SSS+" as const }));

let built: Achievement[] | null = null;
/** All 505, Bronze first. Built once; the order and the ids never depend on what anybody has earned. */
export function achievementCatalogue(): Achievement[] {
  if (built) return built;
  const fixed = [...looks(), ...pets(), ...rows("audit", auditRows), ...rows("records", recordRows), ...rows("event", eventRows), ...times()];
  const seen = new Set(fixed.map((d) => d.id));
  const all = [...fixed, ...fill(500 - fixed.length).filter((d) => !seen.has(d.id))];
  if (all.length !== 500) throw new Error(`The achievements add up to ${all.length}, not 500`);
  all.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
  const ranked = all.map(({ days: _days, ...rest }, i) => ({ ...rest, tier: rankFor(i) }));
  const done = [...ranked, ...secretsOfSecrets(themeNames().length * 2 * seasons.length)];
  built = done;
  return done;
}

/* ---------- measuring ---------- */
/** What the owner's window has seen, as the owner's own record keeps it (src/delight.ts). */
export interface Noticed {
  themes: string[];
  leaves: string[];
  seasons: string[];
  pages: string[];
  pets: string[];
  pats: number;
  backgrounds: string[];
  flags: string[];
}
export interface AchievementFacts {
  tallies: AchievementTallies;
  /** The audit log's counts by action (src/audit.ts). */
  audit: Record<string, number>;
  /** How many saved records of each kind the owner has (schedules, procedures, memory…). */
  records: Record<string, number>;
  noticed: Noticed;
  /** How many of the 500 are already earned, for the Collector ones and "The whole tree". */
  earned: number;
}
/** The longest run of days in a row. A streak only ever pauses: the best one is what counts. */
export function bestStreak(days: string[]): number {
  let best = 0, run = 0, last = Number.NaN;
  for (const day of days) {
    const at = Date.parse(`${day}T00:00:00Z`);
    run = at - last === 86400000 ? run + 1 : 1;
    best = Math.max(best, run);
    last = at;
  }
  return best;
}
function toolCount(group: string, tools: Record<string, number>): number {
  return sum(Object.entries(tools).filter(([name]) => group === "all" || inferToolGroup(name) === group).map(([, n]) => n));
}
function hourCount(which: string, hours: Record<string, number>): number {
  const range = which === "night" ? [0, 1, 2, 3, 4] : which === "early" ? [5, 6] : [12];
  return sum(range.map((h) => hours[String(h).padStart(2, "0")] ?? 0));
}
function noticedCount(tail: string, seen: Noticed): number {
  const [what, ...rest] = tail.split(":");
  const value = rest.join(":");
  const has = (list: string[]): number => (list.includes(value) ? 1 : 0);
  if (what === "theme") return has(seen.themes);
  if (what === "themes") return new Set(seen.themes.map((t) => t.split(":")[1])).size;
  if (what === "season") return has(seen.seasons);
  if (what === "seasons") return seen.seasons.length;
  if (what === "pages") return seen.pages.length;
  if (what === "pet") return has(seen.pets);
  if (what === "pats") return seen.pats;
  if (what === "bg") return has(seen.backgrounds);
  if (what === "flag") return has(seen.flags);
  if (what === "leaves") return seen.leaves.length;
  return 0;
}
/** How far along one measure is, from the facts alone. */
export function measure(metric: string, facts: AchievementFacts): number {
  const [head, ...rest] = metric.split(":");
  const tail = rest.join(":"), t = facts.tallies;
  switch (head) {
    case "tasks": return t.tasks;
    case "stopped": return t.stopped;
    case "conversations": return t.conversations;
    case "days": return t.days.length;
    case "streak": return bestStreak(t.days);
    case "src": return t.bySource[tail] ?? 0;
    case "hour": return hourCount(tail, t.hours);
    case "weekday": return t.weekdays[tail] ?? 0;
    case "weekend": return (t.weekdays["0"] ?? 0) + (t.weekdays["6"] ?? 0);
    case "solstice": return t.solstice;
    case "tool": return toolCount(tail, t.tools);
    case "event": return t.events[tail] ?? 0;
    case "audit": return facts.audit[tail] ?? 0;
    case "records": return facts.records[tail] ?? 0;
    case "noticed": return noticedCount(tail, facts.noticed);
    case "earned": return facts.earned;
    default: return 0;
  }
}
/** The owner's rank: Bronze until 100 are earned, then Silver, Gold, Diamond and Godly by the hundred. */
export function rankFor(earned: number): AchievementTier {
  return achievementTiers[Math.min(4, Math.floor(earned / 100))] ?? "Bronze";
}
