import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxStart } from "./sandbox-backends.js";

/** Tightens a prepared OS wall to scratch plus interpreter/runtime files, never the owner's disk. */
export async function pluginScratchWall(start: SandboxStart, interpreter: string, staging: string, platform: NodeJS.Platform): Promise<SandboxStart> {
  const real = await realpath(interpreter), bin = dirname(real);
  if (bin === homedir()) throw new Error("The plugin interpreter sits directly in the owner home; install it in a program folder before evaluation.");
  const runtime = [...new Set([bin, join(dirname(bin), "lib"), "/usr", "/bin", "/lib", "/lib64"])]
    .filter(path => path !== "/" && path !== dirname(staging));
  const args = [...start.args];
  if (platform === "linux") {
    const at = args.findIndex((arg, i) => arg === "--ro-bind" && args[i + 1] === "/" && args[i + 2] === "/");
    if (at < 0) throw new Error("The plugin evaluation wall was not prepared with bubblewrap.");
    const roots = [];
    for (const path of runtime) if (await stat(path).catch(() => null)) roots.push("--ro-bind", path, path);
    args.splice(at, 3, "--tmpfs", "/", ...roots, "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache");
  } else if (platform === "darwin") {
    const at = args.indexOf("-p") + 1, profile = args[at];
    if (!at || !profile?.includes("(allow file-read*)")) throw new Error("The plugin evaluation wall was not prepared with seatbelt.");
    const paths = [...runtime, staging, "/System/Library", "/Library/Apple", "/dev", "/private/var/db/dyld"];
    args[at] = profile.replace("(allow file-read*)", paths.map((_path, i) => `(allow file-read* (subpath (param "PLUGIN_READ_${i}")))`).join("\n"))
      .replace("(allow user-preference-read)", "")
      .replace('(allow mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (local-name "com.apple.cfprefsd.agent"))', "");
    args.splice(at + 1, 0, ...paths.map((path, i) => `-DPLUGIN_READ_${i}=${path}`));
  } else throw new Error("This system has no supported strong plugin evaluation wall.");
  return { ...start, args };
}
