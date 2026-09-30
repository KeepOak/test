import { link, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultGatewayConfig, gatewayFile, loadGatewayConfig, type LoadedConfig } from "../never-break/gateway-config.js";

/** Migrate an absent desktop gateway preference to ON; exclusive creation never overwrites an owner's OFF. */
export async function desktopGatewayConfig(dataDir: string): Promise<LoadedConfig> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, gatewayFile);
  const part = `${path}.${randomUUID()}.part`;
  try {
    const handle = await open(part, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ ...defaultGatewayConfig(), mode: "on" }, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    // Publish complete bytes exclusively, so a concurrent first launch cannot read a half-written preference.
    await link(part, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await unlink(part).catch(() => undefined); }
  return loadGatewayConfig(dataDir);
}
