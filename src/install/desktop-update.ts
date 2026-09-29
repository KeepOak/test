import { connectDesktopControl } from "../desktop/gateway-control.js";
import { desktopUpdateReceiptSchema, type DesktopUpdateReceipt } from "../desktop/update-receipt.js";

export async function desktopUpdateCommand(input: {
  dataDir: string; yes: boolean; json?: boolean; print: (line: string) => void;
}, request = requestDesktopUpdate): Promise<number> {
  try {
    const receipt = await request(input.dataDir, input.yes);
    input.print(input.json ? JSON.stringify({ outcome: receipt.accepted ? "requested" : "status", ...receipt })
      : receipt.words + (receipt.accepted ? " Request accepted; the resident updater installs at the next safe moment. This command does not claim installation completed." : " Run `branch update --yes` to request installation."));
    return 0;
  } catch (error) {
    const words = error instanceof Error ? error.message : String(error);
    input.print(input.json ? JSON.stringify({ outcome: "refused", accepted: false, error: words }) : words);
    return 1;
  }
}

/** The running installed desktop owns every build, check and handover; this command only asks it. */
export async function requestDesktopUpdate(dataDir: string, install: boolean): Promise<DesktopUpdateReceipt> {
  const client = await connectDesktopControl(dataDir, {}, "cli").catch(() => null);
  if (!client) throw new Error("A desktop gateway with CLI update support is not running for this data folder. Open the installed Branch first. Nothing was stopped or installed.");
  try { return desktopUpdateReceiptSchema.parse(await client.link.call("owner-update", { install }, 40_000)); }
  finally { client.close(); }
}
