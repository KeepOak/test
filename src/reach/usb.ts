import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { audit } from "../audit.js";
import type { PosixExec } from "../integrations/desktop-script-posix.js";
import type { Store } from "../store.js";
import { quoteLine, reachMode, reachRecord, requireReach } from "./settings.js";

/**
 * R17-084: starting a task when a particular USB device is plugged in.
 *
 * The owner names each device exactly (vendor id, product id, and the serial number when it has one)
 * with the words the task should start with, and switches each one on separately; a new rule starts
 * switched off. Nothing is looked at while this part is off. When it is on, the list of plugged-in
 * devices is read once a minute, and a task starts only for a device that was not there at the last
 * look, has a rule that is on, and has not started one in the last ten minutes.
 *
 *   Linux  /sys/bus/usb/devices/<port>/idVendor, idProduct, serial, product: plain files, read only.
 *   Mac    `ioreg -p IOUSB -l -w 0`, which only reads the USB registry and asks for no permission.
 *
 * Both readers are handed in, so tests use fakes and nothing is read from the owner's machine. The
 * task starts through the same door as a timed job (`start`, wired to `Runtime.run` with the
 * schedule's source), so the owner's approval rules hold it exactly as they hold a schedule.
 *
 * The idea is PicoClaw's device service (MIT); this is an independent implementation.
 */
export interface UsbDevice { vendorId: string; productId: string; serial: string; name: string }
export type UsbLister = () => Promise<UsbDevice[]>;

const Hex4 = z.string().trim().toLowerCase().regex(/^[0-9a-f]{4}$/, "Four hexadecimal digits, as the device list shows");
export const UsbRuleSchema = z.object({
  id: z.string().uuid(),
  vendorId: Hex4,
  productId: Hex4,
  /** Empty means any device of this make and model. */
  serial: z.string().trim().max(120).default(""),
  label: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean().default(false),
}).strict();
export type UsbRule = z.infer<typeof UsbRuleSchema>;
const RulesSchema = z.object({ rules: z.array(UsbRuleSchema).max(20).default([]) }).strict();
const rulesKey = "reach-usb-rules";
export const usbGapMs = 10 * 60_000;

const fourHex = (text: string): string => text.trim().toLowerCase().replace(/^0x/, "").padStart(4, "0").slice(-4);

/** Linux: every device folder under /sys/bus/usb/devices that has a vendor and a product id. */
export function linuxUsbLister(root = "/sys/bus/usb/devices"): UsbLister {
  return async () => {
    const names = await readdir(root).catch(() => [] as string[]);
    const read = (dir: string, file: string) => readFile(join(root, dir, file), "utf8").then((t) => t.trim()).catch(() => "");
    const found = await Promise.all(names.slice(0, 256).map(async (dir) => ({
      vendorId: await read(dir, "idVendor"), productId: await read(dir, "idProduct"),
      serial: await read(dir, "serial"), name: await read(dir, "product"),
    })));
    return found.filter((d) => /^[0-9a-f]{4}$/i.test(d.vendorId) && /^[0-9a-f]{4}$/i.test(d.productId))
      .map((d) => ({ ...d, vendorId: fourHex(d.vendorId), productId: fourHex(d.productId) }));
  };
}

export const ioregPath = "/usr/sbin/ioreg";
export const ioregArgs = ["-p", "IOUSB", "-l", "-w", "0"];

/** Mac: the devices `ioreg` lists, each entry read from its `"idVendor" = 1452` style lines. */
export function parseIoreg(text: string): UsbDevice[] {
  return text.split(/\n(?=[ |]*\+-o )/).flatMap((block) => {
    const number = (key: string): string | null => { const m = new RegExp(`"${key}" = (\\d+)`).exec(block); return m ? Number(m[1]).toString(16).padStart(4, "0") : null; };
    const text = (key: string): string => new RegExp(`"${key}" = "([^"]*)"`).exec(block)?.[1] ?? "";
    const vendorId = number("idVendor"), productId = number("idProduct");
    return vendorId && productId ? [{ vendorId, productId, serial: text("USB Serial Number"), name: text("USB Product Name") }] : [];
  });
}
export function macUsbLister(exec: PosixExec): UsbLister {
  return async () => {
    const outcome = await exec(ioregPath, ioregArgs, AbortSignal.timeout(10000));
    return outcome.exitCode === 0 ? parseIoreg(outcome.stdout) : [];
  };
}

const keyOf = (d: Pick<UsbDevice, "vendorId" | "productId" | "serial">): string => `${d.vendorId}:${d.productId}:${d.serial}`;
export const matches = (rule: UsbRule, device: UsbDevice): boolean =>
  rule.vendorId === device.vendorId && rule.productId === device.productId && (!rule.serial || rule.serial === device.serial);

export interface UsbDeps {
  store: Store; owner: string; list: UsbLister;
  /** Starts the task the way a schedule does. */
  start: (prompt: string, label: string) => Promise<unknown>;
  now?: () => number;
}

export class UsbTrigger {
  /** Real fresh plug events only, after the existing USB opt-in and first-scan suppression. */
  readonly onPlugged = new Set<(device: UsbDevice) => void>();
  private seen: Set<string> | null = null;
  private readonly last = new Map<string, number>();
  constructor(private readonly deps: UsbDeps) {}

  rules(): UsbRule[] { return reachRecord(this.deps.store, this.deps.owner, rulesKey, RulesSchema).rules; }

  /**
   * Adds or changes a rule. A new rule is always off; switching it on is a separate step. Integration
   * review: changing which device a rule answers or the task it starts switches it off again, so a
   * yes is never carried over to something the owner did not say yes to. A new name alone keeps it.
   */
  save(input: unknown): UsbRule[] {
    requireReach(this.deps.store, this.deps.owner, "usb");
    const rule = UsbRuleSchema.parse(input);
    const old = this.rules().find((r) => r.id === rule.id);
    const same = old && old.vendorId === rule.vendorId && old.productId === rule.productId && old.serial === rule.serial && old.prompt === rule.prompt;
    const next = { ...rule, enabled: same ? old.enabled : false };
    const rules = [...this.rules().filter((r) => r.id !== rule.id), next];
    RulesSchema.parse({ rules });
    this.deps.store.save("settings", this.deps.owner, rulesKey, { rules });
    return rules;
  }
  enable(id: string, on: boolean): UsbRule[] {
    requireReach(this.deps.store, this.deps.owner, "usb");
    if (!this.rules().some((r) => r.id === id)) throw new Error("There is no device rule with that id.");
    const rules = this.rules().map((r) => (r.id === id ? { ...r, enabled: on } : r));
    this.deps.store.save("settings", this.deps.owner, rulesKey, { rules });
    audit(this.deps.store, this.deps.owner, { action: "policy.changed", actor: this.deps.owner,
      subject: `the USB device rule ${rules.find((r) => r.id === id)!.label}`, reason: on ? "switched on" : "switched off", outcome: "saved" });
    return rules;
  }
  remove(id: string): UsbRule[] {
    requireReach(this.deps.store, this.deps.owner, "usb");
    const rules = this.rules().filter((r) => r.id !== id);
    this.deps.store.save("settings", this.deps.owner, rulesKey, { rules });
    return rules;
  }

  /** What is plugged in now, for choosing a device in the window. */
  async devices(): Promise<UsbDevice[]> {
    requireReach(this.deps.store, this.deps.owner, "usb");
    return (await this.deps.list()).map((d) => ({ ...d, serial: quoteLine(d.serial, 120), name: quoteLine(d.name, 120) }));
  }

  /** One look. The first look only learns what is already plugged in; nothing starts for those. */
  async tick(): Promise<string[]> {
    if (reachMode(this.deps.store, this.deps.owner, "usb") === "off") { this.seen = null; return []; }
    const rules = this.rules().filter((r) => r.enabled);
    const now = await this.deps.list().catch(() => null);
    if (!now) return [];
    const keys = new Set(now.map(keyOf));
    const fresh = this.seen ? now.filter((d) => !this.seen!.has(keyOf(d))) : [];
    this.seen = keys;
    for (const device of fresh) for (const listener of this.onPlugged) {
      try { listener(device); } catch { /* An event subscriber cannot disable existing USB rules. */ }
    }
    const started: string[] = [];
    const at = this.deps.now?.() ?? Date.now();
    for (const rule of rules) {
      if (!fresh.some((d) => matches(rule, d)) || at - (this.last.get(rule.id) ?? -Infinity) < usbGapMs) continue;
      this.last.set(rule.id, at);
      started.push(rule.id);
      await this.deps.start(rule.prompt, `USB device plugged in: ${rule.label}`).catch(() => undefined);
    }
    return started;
  }
}
