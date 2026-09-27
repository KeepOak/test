import type { Proposal } from "./changes.js";

/**
 * R17-S03: whole-app presets. Each one sets many switches at once; the owner is shown every
 * change first and only the ones they tick are made (src/settings-kit/changes.ts). A preset never
 * names a connection, a key or a folder, only switches and choices from the catalogue.
 */
export interface Preset {
  id: string;
  name: string;
  t: string;
  about: string;
  aboutT: string;
  sets: Proposal[];
}

const set = (key: string, field: string, value: string | boolean | number): Proposal => ({ key, field, value });
const off = (...keys: string[]): Proposal[] => keys.map((key) => set(key, "mode", "off"));

export const presets: readonly Preset[] = [
  {
    id: "private", name: "Private and local", t: "settings-kit.preset.private",
    about: "Keeps what you do on this computer: local models first, sound never sent anywhere, nothing counted or shared.",
    aboutT: "settings-kit.preset.private-about",
    sets: [
      set("local-models", "mode", "on"), set("voice", "keepAudioOnThisComputer", true),
      ...off("asks-analytics", "execution-metrics", "asks-answer-engine", "asks-runtimes", "asks-nodes", "memory-history", "speech-engines"),
      set("folder_trust_mode", "mode", "on"), set("os-sandbox", "mode", "on"), set("os-sandbox", "network", "none"),
    ],
  },
  {
    id: "cheapest", name: "Cheapest", t: "settings-kit.preset.cheapest",
    about: "Spends as little as it can: free models on this computer when they will do, and no extra model calls on the side.",
    aboutT: "settings-kit.preset.cheapest-about",
    sets: [
      set("local-models", "mode", "on"),
      ...off("approval_reviewer", "fly-core", "speech-engines", "asks-runtimes"),
      set("reflection", "reflection", "off"), set("reflection", "newSkills", "off"), set("voice", "autoReadAloud", false),
    ],
  },
  {
    id: "capable", name: "Most capable", t: "settings-kit.preset.capable",
    about: "Every helper ready when the work calls for it, with the safety checks kept on.",
    aboutT: "settings-kit.preset.capable-about",
    sets: [
      ...["media-programs", "command-catalog", "prompt-library", "asks-answer-engine", "fly-core", "run-recording"]
        .map((key) => set(key, "mode", "when-needed")),
      set("goal-undo", "goal", "when-needed"), set("goal-undo", "snapshots", "when-needed"),
      set("reflection", "reflection", "when-needed"), set("reflection", "newSkills", "when-needed"),
      set("loop_guard", "mode", "on"), set("approval_reviewer", "mode", "when-needed"),
    ],
  },
  {
    id: "hands-off", name: "Hands-off", t: "settings-kit.preset.hands-off",
    about: "Gets on with work inside your workspace without asking about every step, with guards that stop it going round in circles and let you go back.",
    aboutT: "settings-kit.preset.hands-off-about",
    sets: [
      set("policy", "preset", "workspace"), set("approval_reviewer", "mode", "on"), set("loop_guard", "mode", "on"),
      set("goal-undo", "goal", "on"), set("goal-undo", "snapshots", "on"), set("run-recording", "mode", "when-needed"),
    ],
  },
  {
    id: "careful", name: "Careful", t: "settings-kit.preset.careful",
    about: "Asks before any change and before new websites, checks folders and add-ons, and keeps programs behind the wall.",
    aboutT: "settings-kit.preset.careful-about",
    // Q235: a preset named Careful never makes anything less careful: its own approvals ask before every change and
    // before web lookups, so it is no looser than the workspace default or Ask before changes.
    sets: [
      set("policy", "preset", "careful"), set("policy", "unmatchedCommands", "ask"),
      set("approval_reviewer", "mode", "on"), set("loop_guard", "mode", "on"), set("folder_trust_mode", "mode", "on"),
      set("security-check", "audit", "when-needed"), set("security-check", "malware", "on"),
      set("os-sandbox", "mode", "on"),
    ],
  },
];

export const presetFor = (id: string): Preset | undefined => presets.find((preset) => preset.id === id);
