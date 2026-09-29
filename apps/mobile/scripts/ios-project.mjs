/**
 * Makes the Xcode project Capacitor generated into Branch's: no storyboards (the window is made in
 * code and the launch screen is an Info.plist entry, so building needs no installed simulator), the
 * Branch Swift files, the generated colours-and-words file, the entitlements, and the share extension
 * target the app embeds. It edits project.pbxproj as text with fixed identifiers and does nothing the
 * second time, so it is safe to run after `cap add ios` recreates the project.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..", "ios", "App", "App.xcodeproj", "project.pbxproj");
const APP_GROUP_ID = "504EC3061FED79650016851F";
const id = (n) => `B7A0B7A0B7A0B7A0B7A0${n.toString(16).toUpperCase().padStart(4, "0")}`;
const MARK = "/* Branch: share extension */";

const APP_SOURCES = [["BranchShared.swift", 1], ["BranchPhonePlugin.swift", 2], ["BranchViewController.swift", 3], ["BranchBackground.swift", 4]];
const EXT = { target: id(0x40), configs: id(0x41), debug: id(0x42), release: id(0x43), sources: id(0x44), frameworks: id(0x45),
  resources: id(0x46), embed: id(0x47), proxy: id(0x48), dependency: id(0x49), product: id(0x50), productBuild: id(0x51), group: id(0x52) };

/** Removes the storyboard entries (lines and list items that name them). */
export function dropStoryboards(text) {
  const withoutGroups = text.replace(/\/\* Begin PBXVariantGroup section \*\/[\s\S]*?\/\* End PBXVariantGroup section \*\/\n\n?/, "");
  return withoutGroups.split("\n").filter((line) => !/(Main|LaunchScreen)\.storyboard|Base\.lproj\/(Main|LaunchScreen)/.test(line)).join("\n");
}

const fileRef = (ref, name, type, path = name) => `\t\t${ref} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${type}; path = ${path}; sourceTree = "<group>"; };`;
const buildFile = (ref, file, name, phase) => `\t\t${ref} /* ${name} in ${phase} */ = {isa = PBXBuildFile; fileRef = ${file} /* ${name} */; };`;
const insertAfter = (text, anchor, lines) => text.replace(anchor, `${anchor}\n${lines.join("\n")}`);
const addToList = (text, owner, list, items) =>
  text.replace(new RegExp(`(\\t\\t${owner} /\\* [^*]+ \\*/ = \\{[\\s\\S]*?${list} = \\()`), `$1\n${items.map((item) => `\t\t\t\t${item},`).join("\n")}`);

function appFiles(text) {
  const refs = APP_SOURCES.map(([name, n]) => fileRef(id(n), name, "sourcecode.swift"));
  refs.push(fileRef(id(0x10), "branch-native.json", "text.json"), fileRef(id(0x11), "App.entitlements", "text.plist.entitlements"));
  const builds = APP_SOURCES.map(([name, n]) => buildFile(id(0x100 + n), id(n), name, "Sources"));
  builds.push(buildFile(id(0x110), id(0x10), "branch-native.json", "Resources"), buildFile(id(0x201), id(1), "BranchShared.swift", "Sources"));
  let out = insertAfter(text, "/* Begin PBXFileReference section */", refs);
  out = insertAfter(out, "/* Begin PBXBuildFile section */", builds);
  out = addToList(out, APP_GROUP_ID, "children", [...APP_SOURCES.map(([name, n]) => `${id(n)} /* ${name} */`), `${id(0x10)} /* branch-native.json */`, `${id(0x11)} /* App.entitlements */`]);
  out = addToList(out, "504EC3001FED79650016851F", "files", APP_SOURCES.map(([name, n]) => `${id(0x100 + n)} /* ${name} in Sources */`));
  out = addToList(out, "504EC3021FED79650016851F", "files", [`${id(0x110)} /* branch-native.json in Resources */`]);
  out = out.replaceAll("\t\t\t\tMARKETING_VERSION = 1.0;", "\t\t\t\tMARKETING_VERSION = 0.19.4;");
  return out.replaceAll("\t\t\t\tINFOPLIST_FILE = App/Info.plist;", "\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;");
}

function extensionSettings(debug) {
  return `\t\t${debug ? EXT.debug : EXT.release} /* ${debug ? "Debug" : "Release"} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tAPPLICATION_EXTENSION_API_ONLY = YES;
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ShareExtension/ShareExtension.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = ShareExtension/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t\t"@executable_path/../../Frameworks",\n\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 0.19.4;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.keepoak.branchagent.share;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = ${debug ? "Debug" : "Release"};
\t\t};`;
}

function extensionObjects(text) {
  const refs = [fileRef(id(0x20), "ShareViewController.swift", "sourcecode.swift"), fileRef(id(0x21), "Info.plist", "text.plist.xml"),
    fileRef(id(0x22), "ShareExtension.entitlements", "text.plist.entitlements"), fileRef(id(0x23), "branch-native.json", "text.json"),
    `\t\t${EXT.product} /* ShareExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ShareExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };`];
  const builds = [buildFile(id(0x220), id(0x20), "ShareViewController.swift", "Sources"), buildFile(id(0x223), id(0x23), "branch-native.json", "Resources"),
    `\t\t${EXT.productBuild} /* ShareExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${EXT.product} /* ShareExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`];
  let out = insertAfter(text, "/* Begin PBXFileReference section */", refs);
  out = insertAfter(out, "/* Begin PBXBuildFile section */", builds);
  const phase = (uuid, isa, name, files) => `\t\t${uuid} /* ${name} */ = {\n\t\t\tisa = ${isa};\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n${files.map((f) => `\t\t\t\t${f},\n`).join("")}\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};`;
  out = insertAfter(out, "/* Begin PBXFrameworksBuildPhase section */", [phase(EXT.frameworks, "PBXFrameworksBuildPhase", "Frameworks", [])]);
  out = insertAfter(out, "/* Begin PBXResourcesBuildPhase section */", [phase(EXT.resources, "PBXResourcesBuildPhase", "Resources", [`${id(0x223)} /* branch-native.json in Resources */`])]);
  out = insertAfter(out, "/* Begin PBXSourcesBuildPhase section */", [phase(EXT.sources, "PBXSourcesBuildPhase", "Sources",
    [`${id(0x220)} /* ShareViewController.swift in Sources */`, `${id(0x201)} /* BranchShared.swift in Sources */`])]);
  return out;
}

function extensionTarget(text) {
  let out = text.replace("/* End PBXBuildFile section */", `/* End PBXBuildFile section */

${MARK}
/* Begin PBXContainerItemProxy section */
\t\t${EXT.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 504EC2FC1FED79650016851F /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${EXT.target};
\t\t\tremoteInfo = ShareExtension;
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXCopyFilesBuildPhase section */
\t\t${EXT.embed} /* Embed Foundation Extensions */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t${EXT.productBuild} /* ShareExtension.appex in Embed Foundation Extensions */,
\t\t\t);
\t\t\tname = "Embed Foundation Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXCopyFilesBuildPhase section */`);
  out = out.replace("/* End PBXGroup section */", `\t\t${EXT.group} /* ShareExtension */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${id(0x20)} /* ShareViewController.swift */,
\t\t\t\t${id(0x21)} /* Info.plist */,
\t\t\t\t${id(0x22)} /* ShareExtension.entitlements */,
\t\t\t\t${id(0x23)} /* branch-native.json */,
\t\t\t);
\t\t\tpath = ShareExtension;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */`);
  out = out.replace("/* End PBXNativeTarget section */", `\t\t${EXT.target} /* ShareExtension */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${EXT.configs} /* Build configuration list for PBXNativeTarget "ShareExtension" */;
\t\t\tbuildPhases = (
\t\t\t\t${EXT.sources} /* Sources */,
\t\t\t\t${EXT.frameworks} /* Frameworks */,
\t\t\t\t${EXT.resources} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ShareExtension;
\t\t\tproductName = ShareExtension;
\t\t\tproductReference = ${EXT.product} /* ShareExtension.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXTargetDependency section */
\t\t${EXT.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${EXT.target} /* ShareExtension */;
\t\t\ttargetProxy = ${EXT.proxy} /* PBXContainerItemProxy */;
\t\t};
/* End PBXTargetDependency section */`);
  out = out.replace("/* End XCBuildConfiguration section */", `${extensionSettings(true)}\n${extensionSettings(false)}\n/* End XCBuildConfiguration section */`);
  out = out.replace("/* End XCConfigurationList section */", `\t\t${EXT.configs} /* Build configuration list for PBXNativeTarget "ShareExtension" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${EXT.debug} /* Debug */,
\t\t\t\t${EXT.release} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */`);
  return out;
}

function wireExtension(text) {
  let out = text.replace(/(\t\t504EC2FB1FED79650016851F = \{[\s\S]*?children = \()/, `$1\n\t\t\t\t${EXT.group} /* ShareExtension */,`);
  out = addToList(out, "504EC3051FED79650016851F", "children", [`${EXT.product} /* ShareExtension.appex */`]);
  out = out.replace(/(\t\t\t\t504EC3021FED79650016851F \/\* Resources \*\/,\n)/, `$1\t\t\t\t${EXT.embed} /* Embed Foundation Extensions */,\n`);
  out = out.replace(/(\t\t504EC3031FED79650016851F \/\* App \*\/ = \{[\s\S]*?dependencies = \()/, `$1\n\t\t\t\t${EXT.dependency} /* PBXTargetDependency */,`);
  out = out.replace(/(\t\t\t\t504EC3031FED79650016851F \/\* App \*\/,\n)(\t\t\t\);)/, `$1\t\t\t\t${EXT.target} /* ShareExtension */,\n$2`);
  return out.replace(/(\t\t\t\t\t504EC3031FED79650016851F = \{[\s\S]*?\};\n)/, `$1\t\t\t\t\t${EXT.target} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 26.0;\n\t\t\t\t\t};\n`);
}

export function brandProject(text) {
  if (text.includes(MARK)) return text;
  return wireExtension(extensionTarget(extensionObjects(appFiles(dropStoryboards(text)))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = await readFile(PROJECT, "utf8");
  const after = brandProject(before);
  if (after !== before) await writeFile(PROJECT, after);
  console.log(after === before ? "The Xcode project is already Branch's." : "The Xcode project now carries Branch's files and share extension.");
}
