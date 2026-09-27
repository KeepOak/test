/**
 * Writes the native files that carry a colour or a word, from the same sources the window uses:
 * the theme table (public/theme-catalogue.js, through web/palette.js) and the language files
 * (public/locales). None of these files is kept in git; they are made again before every build, so
 * a change of design reaches the phone apps without anyone typing a colour into Xcode or Gradle.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NATIVE_THEME, androidColour, nativePalettes } from "../web/palette.js";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
export const APP_ID = "com.keepoak.branchagent";
export const APP_NAME = "Branch Agent";
export const APP_GROUP = "group.com.keepoak.branchagent";
export const LANGUAGES = ["en", "fr", "es", "de"];

/** The words the native pieces say: every `phone.*` key, in each language. */
export async function nativeWords(root = repo) {
  const words = {};
  for (const language of LANGUAGES) {
    const all = JSON.parse(await readFile(join(root, "public", "locales", `${language}.json`), "utf8"));
    words[language] = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith("phone.")));
  }
  return words;
}

/** `webDebug` is only for checking a debug build on an emulator (BRANCH_MOBILE_WEB_DEBUG=1); releases never set it. */
export function capacitorConfig(palettes, webDebug = false) {
  return {
    appId: APP_ID,
    appName: APP_NAME,
    webDir: "www",
    backgroundColor: palettes.dark.ground,
    loggingBehavior: "none",
    server: { androidScheme: "https", iosScheme: "capacitor", cleartext: false },
    android: { allowMixedContent: false, captureInput: false, webContentsDebuggingEnabled: webDebug, backgroundColor: palettes.dark.ground },
    ios: { contentInset: "never", backgroundColor: palettes.dark.ground, scrollEnabled: true, limitsNavigationsToAppBoundDomains: false },
    plugins: { CapacitorHttp: { enabled: false }, CapacitorCookies: { enabled: false } },
  };
}

const xmlText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "\\\"").replace(/'/g, "\\'").replace(/^([@?])/, "\\$1");
export function androidColours(palette) {
  const rows = Object.entries(palette).filter(([, value]) => /^#[0-9A-F]{6}$/.test(value))
    .map(([role, value]) => `    <color name="branch_${role.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}">${androidColour(value)}</color>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Made by apps/mobile/scripts/native-files.mjs from public/theme-catalogue.js. Do not edit. -->\n<resources>\n${rows.join("\n")}\n</resources>\n`;
}
/**
 * Android only accepts a resource name of letters, digits and underscores that starts with a letter,
 * so a key like `comfort.network.old-node` fails the release build. Everything else becomes `_`, and
 * a name that would start with a digit is given a letter in front.
 */
export const resourceName = (key) => {
  const name = key.replace(/[^A-Za-z0-9]/g, "_");
  return /^[A-Za-z]/.test(name) ? name : `k_${name}`;
};
export function androidStrings(words) {
  const rows = Object.entries(words).map(([key, text]) => `    <string name="${resourceName(key)}">${xmlText(text)}</string>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Made by apps/mobile/scripts/native-files.mjs from public/locales. Do not edit. -->\n<resources>\n${rows.join("\n")}\n</resources>\n`;
}
const component = (hex, at) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(3);
/** An Xcode colour set with a light and a dark appearance. */
export function iosColourSet(light, dark) {
  const colour = (hex) => ({ "color-space": "srgb", components: { red: component(hex, 1), green: component(hex, 3), blue: component(hex, 5), alpha: "1.000" } });
  return {
    colors: [
      { idiom: "universal", color: colour(light) },
      { idiom: "universal", appearances: [{ appearance: "luminosity", value: "dark" }], color: colour(dark) },
    ],
    info: { author: "xcode", version: 1 },
  };
}

async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
export async function writeNativeFiles(root = app) {
  const catalogue = await import(pathToFileURL(join(repo, "public", "theme-catalogue.js")).href);
  const palettes = nativePalettes(catalogue, NATIVE_THEME);
  const words = await nativeWords();
  const shared = `${JSON.stringify({ palettes, words, appGroup: APP_GROUP }, null, 2)}\n`;
  await put(join(root, "capacitor.config.json"), `${JSON.stringify(capacitorConfig(palettes, process.env.BRANCH_MOBILE_WEB_DEBUG === "1"), null, 2)}\n`);
  await put(join(root, "www", "branch-native.json"), shared);
  const android = join(root, "android", "app", "src", "main");
  if (existsSync(android)) {
    await put(join(android, "res", "values", "branch_colors.xml"), androidColours(palettes.light));
    await put(join(android, "res", "values-night", "branch_colors.xml"), androidColours(palettes.dark));
    await put(join(android, "res", "values", "branch_strings.xml"), androidStrings(words.en));
    for (const language of LANGUAGES.filter((l) => l !== "en"))
      await put(join(android, "res", `values-${language}`, "branch_strings.xml"), androidStrings({ ...words.en, ...words[language] }));
  }
  const ios = join(root, "ios", "App");
  if (existsSync(ios)) {
    for (const [role, name] of [["ground", "BranchGround"], ["accent", "BranchAccent"], ["text", "BranchText"]])
      await put(join(ios, "App", "Assets.xcassets", `${name}.colorset`, "Contents.json"), `${JSON.stringify(iosColourSet(palettes.light[role], palettes.dark[role]), null, 2)}\n`);
    await put(join(ios, "App", "branch-native.json"), shared);
    await put(join(ios, "ShareExtension", "branch-native.json"), shared);
  }
  return { palettes, words };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { palettes } = await writeNativeFiles();
  console.log(`Native colours and words written (ground ${palettes.dark.ground} / ${palettes.light.ground}).`);
}
