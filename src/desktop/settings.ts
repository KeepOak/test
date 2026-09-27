import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerFromEnv } from "../providers.js";

const fields = {
  // "demo" is how this file has always written "no connection saved"; it names no model and never starts one.
  provider: z.enum(["demo", "openai", "anthropic"]),
  endpoint: z.string().max(2048),
  model: z.string().max(256),
};
const storedSchema = z.object({
  ...fields, encryptedKey: z.string().max(32768),
}).strict();
const inputSchema = z.object({
  ...fields, apiKey: z.string().max(8192),
}).strict();
type Stored = z.infer<typeof storedSchema>;
export interface KeyEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
const empty: Stored = {
  provider: "demo", endpoint: "", model: "", encryptedKey: "",
};

export class DesktopSettings {
  private value: Stored = { ...empty };
  private saving = false;
  private issue: string | null = null;
  constructor(private path: string, private encryption: KeyEncryption) {}
  async load(): Promise<void> {
    try {
      const content = await readFile(this.path);
      if (content.length > 65536) throw new Error("Oversized settings");
      this.value = storedSchema.parse(JSON.parse(content.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.value = { ...empty };
      this.issue = "Saved model settings could not be read. Save a new connection in Settings › Models.";
    }
  }
  summary() {
    const { provider, endpoint, model, encryptedKey } = this.value;
    return {
      provider, endpoint, model, hasKey: Boolean(encryptedKey),
      canStoreKey: this.encryption.available(),
      issue: this.issue,
    };
  }
  reportConnectionIssue(): void {
    this.issue = "Saved model connection could not be opened. Replace the key in Settings › Models.";
  }
  environment(): NodeJS.ProcessEnv {
    // Nothing saved: no model is set up, so none is named and every message is refused until one is.
    if (this.value.provider === "demo") return {};
    if (!this.encryption.available())
      throw new Error("Device key storage is unavailable");
    try {
      return {
        BRANCH_PROVIDER: this.value.provider,
        BRANCH_ENDPOINT: this.value.endpoint,
        BRANCH_MODEL: this.value.model,
        BRANCH_API_KEY: this.encryption.decrypt(
          Buffer.from(this.value.encryptedKey, "base64"),
        ),
      };
    } catch {
      throw new Error("Saved model key could not be unlocked on this device");
    }
  }
  async save(input: unknown) {
    if (this.saving) throw new Error("Model settings are already being saved");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid model settings");
    this.saving = true;
    try {
      const next = this.prepare(parsed.data);
      await this.persist(next);
      this.value = next;
      this.issue = null;
      return this.summary();
    } finally {
      this.saving = false;
    }
  }
  private prepare(input: z.infer<typeof inputSchema>): Stored {
    if (input.provider === "demo") return { ...empty };
    const { provider, endpoint, model, apiKey } = input;
    providerFromEnv({ BRANCH_PROVIDER: provider, BRANCH_ENDPOINT: endpoint,
      BRANCH_MODEL: model, BRANCH_API_KEY: "settings-validation" });
    if (!this.encryption.available())
      throw new Error("Device key storage is unavailable; use launch environment configuration");
    const sameDestination = provider === this.value.provider &&
      endpoint === this.value.endpoint;
    if (!apiKey && (!sameDestination || !this.value.encryptedKey))
      throw new Error("Enter an API key for this provider and endpoint");
    let encryptedKey = this.value.encryptedKey;
    try {
      if (apiKey) encryptedKey = this.encryption.encrypt(apiKey).toString("base64");
    } catch {
      throw new Error("Model key could not be protected on this device");
    }
    return { provider, endpoint, model, encryptedKey };
  }
  private async persist(value: Stored): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw new Error("Desktop model settings could not be saved");
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
