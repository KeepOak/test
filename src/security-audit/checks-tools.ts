import { isAbsolute as posixAbsolute } from "node:path/posix";
import { isAbsolute as windowsAbsolute } from "node:path/win32";
import { channelsOn, check, hostOf, isLoopback, listed, privateHost, shellOn } from "./kit.js";
import { downloadsWhatItRuns, packageOfLaunch } from "./package-launch.js";
import { inside } from "./synced.js";
import type { SecurityCheck, SecuritySnapshot } from "./types.js";

/** Programs the assistant may run, the web and the browser, and add-ons. */

/** Programs that run whatever they are handed, so allowing one allows everything. */
const interpreters = /^(ba|z|fi|k|c|tc|da)?sh$|^(pwsh|powershell|cmd|python\d*(\.\d+)?|py|node|deno|bun|perl|ruby|php|osascript|lua|tclsh|wscript|cscript|mshta|rundll32|env|sudo|doas|xargs)$/i;
const programOf = (path: string): string => (path.split(/[\\/]/).pop() ?? "").replace(/\.(exe|com)$/i, "");
const absolute = (path: string, platform: NodeJS.Platform) => (platform === "win32" ? windowsAbsolute(path) : posixAbsolute(path));

const executables = (snapshot: SecuritySnapshot) => snapshot.integrations?.shell?.executables ?? [];
const servers = (snapshot: SecuritySnapshot) => snapshot.integrations?.mcp ?? [];

export const commandChecks: SecurityCheck[] = [
  check("commands.any-program", "commands", "warn", "The assistant's programs are not ones that run anything", (snapshot) => {
    const open = executables(snapshot).filter((entry) => interpreters.test(programOf(entry.path)));
    return open.length ? {
      detail: `The assistant may run ${listed(open.map((entry) => `${entry.alias} (${programOf(entry.path)})`))}, which will run any script or command it is handed, so allowing it allows everything.`,
      advice: "List the specific programs the work needs instead, or keep \"Ask before changes\" on so each command is shown to you first.",
    } : null;
  }),
  check("commands.program-in-workspace", "commands", "critical", "The assistant cannot rewrite a program it is allowed to run", (snapshot) => {
    const within = executables(snapshot).filter((entry) => inside(snapshot.workspace, entry.path, snapshot.platform));
    return within.length ? {
      detail: `${listed(within.map((entry) => entry.alias))} ${within.length === 1 ? "lives" : "live"} inside the workspace, where the assistant can change files, so it could change what the program does and then run it.`,
      advice: "Point the launch settings at a copy of the program outside the workspace.",
    } : null;
  }),
  check("commands.reach-internet-from-chat", "commands", "warn", "Programs cannot reach the internet when people message from outside", (snapshot) =>
    shellOn(snapshot) && channelsOn(snapshot) && !snapshot.integrations?.shell?.netless ? {
      detail: "People can message the assistant from outside, and the programs it runs can reach the internet, so a message could have something sent out.",
      advice: "Set \"netless\": true under shell in the launch settings file, or give those rules the \"no internet\" box.",
    } : null),
  check("commands.no-windows-job", "commands", "warn", "Windows holds programs to their memory and time limits", (snapshot) =>
    snapshot.platform === "win32" && shellOn(snapshot) && snapshot.integrations?.shell?.useJobObject === false ? {
      detail: "Programs the assistant runs are not handed to Windows to be held to their limits, so a runaway one can use the whole computer.",
      advice: "Remove \"useJobObject\": false from the launch settings file.",
    } : null),
  check("commands.inherit-path", "commands", "info", "Programs are started from a fixed place, not from wherever PATH points", (snapshot) =>
    snapshot.integrations?.shell?.inheritEnv.includes("PATH") ? {
      detail: "Programs the assistant runs inherit your PATH, so a program they start by name comes from whichever folder is first on it.",
      advice: "Leave PATH out of inheritEnv unless a program really needs it.",
    } : null),
  check("commands.hook-lets-through", "commands", "warn", "A check that fails does not let the action through", (snapshot) => {
    const open = (snapshot.integrations?.hooks ?? []).filter((hook) => hook.event === "tool.before" && hook.onTimeout === "allow");
    return open.length ? {
      detail: `${listed(open.map((hook) => hook.id))} ${open.length === 1 ? "is a check" : "are checks"} run before a tool, but if it fails or takes too long the tool runs anyway.`,
      advice: "Set onTimeout to \"ask\" for that hook, so a check that cannot answer holds the call for your yes.",
    } : null;
  }),
  check("commands.container-image-unpinned", "commands", "info", "Scripts sent to a container use a fixed image", (snapshot) => {
    const used = snapshot.policy.rules.some((rule) => rule.backend === "docker");
    const image = snapshot.sandboxImage;
    return used && !image.includes("@sha256:") ? {
      detail: `Scripts sent to a container run in ${image}, which names a tag rather than one exact image, so what runs can change when the image is updated.`,
      advice: "Name the image by its digest (image@sha256:…) in Settings → Computer.",
    } : null;
  }),
];

const downloadKinds = new Set(["exe", "msi", "dmg", "pkg", "app", "sh", "bat", "cmd", "ps1", "jar", "apk", "deb", "rpm", "scr", "vbs", "js", "command"]);

export const webChecks: SecurityCheck[] = [
  check("web.private-addresses", "web", "warn", "The assistant cannot reach your home network", (snapshot) =>
    snapshot.network.allowPrivateAddresses ? {
      detail: "The assistant may open addresses on this computer and your private network, such as your router or other devices' admin pages.",
      advice: "Turn off \"reach private addresses\" in Settings → Computer, unless a task really needs it.",
    } : null),
  check("web.fake-ip-proxy", "web", "warn", "Branch looks up site names itself, so none can lead into your home network", (snapshot) =>
    snapshot.network.fakeIpProxy === true ? {
      detail: "A fake-IP proxy is trusted: a site whose name looks up to an address in 198.18.0.0/15 is let through, and the proxy does the name lookups, so Branch cannot see where that site really is. A name that really points at this computer or your home network can get through.",
      advice: "Set fakeIpProxy to false in the web section of the launch settings file, unless you use Clash, Mihomo, Surge, Stash or sing-box in fake-IP mode.",
    } : null),
  check("web.anywhere-with-chat", "web", "info", "The sites the assistant reads are limited when people message from outside", (snapshot) =>
    channelsOn(snapshot) && snapshot.network.allowedHosts === null ? {
      detail: "People can message the assistant from outside, and it may read any website.",
      advice: "List the sites it may reach in Settings → Computer, if its work allows.",
    } : null),
  check("web.instructions-only-noted", "web", "info", "Instructions hidden in web pages are taken out, not just noted", (snapshot) =>
    channelsOn(snapshot) && (snapshot.integrations?.web?.injection ?? "redact") === "warn" ? {
      detail: "Text on a web page that reads like orders to the assistant is only pointed out, and people can reach the assistant from outside.",
      advice: "Set injection to \"redact\" or \"block\" under web in the launch settings file.",
    } : null),
  check("web.browser-plain-site", "web", "warn", "The browser only opens sites over encrypted connections", (snapshot) => {
    const plain = (snapshot.integrations?.browser?.allowedOrigins ?? []).filter((origin) => origin.startsWith("http://") && !isLoopback(hostOf(origin) ?? ""));
    return plain.length ? {
      detail: `The browser may open ${listed(plain)} without encryption, so anyone on the network can read or change the pages.`,
      advice: "Use the https:// address of those sites in the launch settings file.",
    } : null;
  }),
  check("web.browser-local-site", "web", "info", "The browser does not open pages on your own network", (snapshot) => {
    const local = (snapshot.integrations?.browser?.allowedOrigins ?? []).filter((origin) => privateHost(hostOf(origin) ?? ""));
    return local.length ? {
      detail: `The browser may open ${listed(local)}, which is on this computer or your private network.`,
      advice: "Remove it from allowedOrigins unless a task needs it.",
    } : null;
  }),
  check("web.browser-many-sites", "web", "info", "The browser is limited to a handful of sites", (snapshot) => {
    const count = snapshot.integrations?.browser?.allowedOrigins.length ?? 0;
    return count > 10 ? {
      detail: `The browser may open ${count} different sites.`,
      advice: "Keep the list to the sites the work really needs.",
    } : null;
  }),
  check("web.browser-saves-programs", "web", "warn", "The browser does not keep programs a website sends", (snapshot) => {
    const risky = (snapshot.integrations?.browser?.downloadTypes ?? []).filter((kind) => downloadKinds.has(kind.toLowerCase()));
    return risky.length ? {
      detail: `The browser may keep ${listed(risky.map((kind) => `.${kind}`))} files, which are programs or scripts that could be run later.`,
      advice: "Remove those endings from downloadTypes in the launch settings file.",
    } : null;
  }),
  check("web.trace-plain-address", "web", "warn", "Traces are only sent over an encrypted connection", (snapshot) => {
    const host = hostOf(snapshot.traceExport.endpoint);
    return snapshot.traceExport.enabled && snapshot.traceExport.endpoint.startsWith("http://") && host && !isLoopback(host) ? {
      detail: `Traces of what the assistant did are sent to ${host} without encryption.`,
      advice: "Use an https:// address in Settings → Advanced.",
    } : null;
  }),
];

const broadPermissions = /^(shell|files\.write|secrets|browser\.(click|fill|upload)|desktop|computer|remote|process)/;

export const addonChecks: SecurityCheck[] = [
  check("add-ons.unpinned-package", "add-ons", "warn", "Outside servers fetched from the internet name an exact version", (snapshot) => {
    const loose = servers(snapshot).filter((server) => server.transport === "stdio" && packageOfLaunch(server.command, server.args)?.version === null);
    return loose.length ? {
      detail: `${listed(loose.map((server) => server.id))} ${loose.length === 1 ? "is" : "are"} downloaded fresh each time without a version, so a new release — or a hijacked one — runs without you seeing it.`,
      advice: "Add the version to the package name, for example some-server@1.4.2.",
    } : null;
  }),
  check("add-ons.malware-check-off", "add-ons", "warn", "Packages are looked up in the malware list before they start", (snapshot) => {
    const fetched = servers(snapshot).filter((server) => server.transport === "stdio" && downloadsWhatItRuns(server.command, server.args));
    return fetched.length && snapshot.switches.malware === "off" ? {
      detail: `${listed(fetched.map((server) => server.id))} ${fetched.length === 1 ? "is" : "are"} downloaded from a package registry when started, and nothing checks the package against the list of known malware first.`,
      advice: "Turn on \"Check add-ons for malware\" on this card.",
    } : null;
  }),
  check("add-ons.package-unreadable", "add-ons", "info", "Every downloaded server can be looked up", (snapshot) => {
    const unknown = servers(snapshot).filter((server) => server.transport === "stdio"
      && downloadsWhatItRuns(server.command, server.args) && !packageOfLaunch(server.command, server.args));
    return unknown.length ? {
      detail: `${listed(unknown.map((server) => server.id))} ${unknown.length === 1 ? "is" : "are"} fetched from a git address, a file or a script rather than a package name, so the malware list cannot be asked about ${unknown.length === 1 ? "it" : "them"}.`,
      advice: "Use the published package name and version if there is one.",
    } : null;
  }),
  check("add-ons.server-by-name", "add-ons", "info", "Outside servers are started from a full address", (snapshot) => {
    const loose = servers(snapshot).filter((server) => server.transport === "stdio" && server.command
      && !absolute(server.command, snapshot.platform) && !downloadsWhatItRuns(server.command, server.args));
    return loose.length ? {
      detail: `${listed(loose.map((server) => server.id))} ${loose.length === 1 ? "is" : "are"} started by name, so whichever program with that name comes first on PATH is the one that runs.`,
      advice: "Write the program's full address as its command.",
    } : null;
  }),
  check("add-ons.server-many-keys", "add-ons", "info", "Each outside server is handed only the keys it needs", (snapshot) => {
    const heavy = servers(snapshot).filter((server) => server.envKeys.length > 3);
    return heavy.length ? {
      detail: `${listed(heavy.map((server) => `${server.id} (${server.envKeys.length} keys)`))} ${heavy.length === 1 ? "is" : "are"} handed several keys.`,
      advice: "Hand each server only the keys its own service needs.",
    } : null;
  }),
  check("add-ons.plugin-unfingerprinted", "add-ons", "warn", "Every plugin was installed with a fingerprint", (snapshot) => {
    const loose = snapshot.plugins.filter((plugin) => !plugin.fingerprinted);
    if (!loose.length) return null;
    const on = loose.filter((plugin) => plugin.enabled);
    return {
      severity: on.length ? "critical" : "warn",
      detail: `${listed(loose.map((plugin) => plugin.id))} ${loose.length === 1 ? "was" : "were"} put in the plugins folder by hand, so there is no record of what the code was when you agreed to it${on.length ? `, and ${listed(on.map((plugin) => plugin.id))} ${on.length === 1 ? "is" : "are"} switched on` : ""}.`,
      advice: "Install plugins through Customize → Plugins, which keeps a fingerprint of the code.",
    };
  }),
  check("add-ons.plugin-changed", "add-ons", "critical", "No plugin has changed since you installed it", (snapshot) => {
    const changed = snapshot.plugins.filter((plugin) => plugin.fingerprinted && !plugin.unchanged);
    if (!changed.length) return null;
    return {
      severity: changed.some((plugin) => plugin.enabled) ? "critical" : "warn",
      detail: `The code of ${listed(changed.map((plugin) => plugin.id))} is not what it was when you installed it.`,
      advice: "Switch it off and install it again from a copy you trust, in Customize → Plugins.",
    };
  }),
  check("add-ons.plugin-broad", "add-ons", "info", "Plugins you switched on ask only for what they need", (snapshot) => {
    const broad = snapshot.plugins.filter((plugin) => plugin.enabled && plugin.permissions.some((name) => broadPermissions.test(name)));
    return broad.length ? {
      detail: `${listed(broad.map((plugin) => plugin.id))} may run programs, change files or use saved secrets.`,
      advice: "Check you still need that, in Customize → Plugins.",
    } : null;
  }),
  check("add-ons.skill-flagged", "add-ons", "warn", "No skill that looked risky is switched on", (snapshot) => {
    const flagged = snapshot.skills.filter((skill) => skill.active && skill.findings > 0);
    return flagged.length ? {
      detail: `${listed(flagged.map((skill) => skill.name))} ${flagged.length === 1 ? "is" : "are"} switched on although the scan found something worth a look.`,
      advice: "Read what the scan found in Customize → Skills, and switch it off if you are not sure.",
    } : null;
  }),
];
