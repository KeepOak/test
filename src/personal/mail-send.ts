import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import type { SignIn } from "./signin.js";
import { runOrigin } from "../key-context.js";

export const MailPreviewSchema = z.object({
  to: z.array(z.string().trim().email().max(254)).min(1).max(20),
  cc: z.array(z.string().trim().email().max(254)).max(20).default([]),
  subject: z.string().max(200).regex(/^[^\r\n]*$/, "The subject cannot contain line breaks"),
  text: z.string().min(1).max(5000),
  // Declare unsupported payloads so the registry cannot discard these as unknown keys.
  attachments: z.array(z.never()).max(0).default([]),
  bcc: z.array(z.never()).max(0).default([]),
}).strict();
export type MailPreview = z.infer<typeof MailPreviewSchema>;
export const MailSendSchema = z.object({ previewId: z.string().uuid() }).strict();
export const mailSendTools = new Set(["gmail.send", "outlook.send"]);
type Kept = { scope: string; connection: string; expires: number; json: string };

/** Immutable, bounded, local previews. The model cannot change approved bytes or reuse a send. */
class MailPreviews {
  private readonly kept = new Map<string, Kept>();
  constructor(private readonly store: Store, private readonly signIn: SignIn) {}
  private scope(c: ToolContext): string {
    const run = this.store.run(c.runId);
    if ((c.source ?? "owner") !== "owner" || (run && runOrigin(this.store, c.runId).source !== "owner"))
      throw new Error("Send mail from an owner-started conversation in the app window.");
    const scope = c.approvalKey ?? run?.sessionId ?? c.runId;
    if (!scope) throw new Error("Make and send mail previews within an owner conversation.");
    return scope;
  }
  create(input: unknown, context: ToolContext) {
    const value = MailPreviewSchema.parse(input), previewId = randomUUID();
    for (const [id, entry] of this.kept) if (entry.expires <= Date.now()) this.kept.delete(id);
    if (this.kept.size >= 32) throw new Error("Too many mail previews. Wait for an old preview to expire.");
    this.kept.set(previewId, { scope: this.scope(context), connection: this.signIn.mailPreviewIdentity(),
      expires: Date.now() + 10 * 60_000, json: JSON.stringify(value) });
    return { previewId, draft: value, sent: false, expiresInMinutes: 10,
      note: "Local draft preview only. Review it, then the Send tool asks for your one-time confirmation. No attachments or hidden recipients." };
  }
  read(id: string, context: ToolContext): MailPreview {
    const entry = this.kept.get(id);
    if (!entry || entry.expires <= Date.now() || entry.scope !== this.scope(context)
      || entry.connection !== this.signIn.mailPreviewIdentity())
      throw new Error("This mail preview expired or belongs to another conversation or sign-in. Make a new preview.");
    return MailPreviewSchema.parse(JSON.parse(entry.json));
  }
  take(id: string, context: ToolContext): MailPreview {
    const value = this.read(id, context);
    this.kept.delete(id); // Before any await/network: races and uncertain send outcomes cannot resend it.
    return value;
  }
}

export function registerMailSending(registry: Pick<ToolRegistry, "register">, prefix: "gmail" | "outlook",
  store: Store, signIn: SignIn, send: (draft: MailPreview, unchanged: () => void) => Promise<unknown>): void {
  const previews = new MailPreviews(store, signIn);
  registry.register({ name: `${prefix}.preview_send`, permission: "personal.read", parameters: MailPreviewSchema, reach: "local",
    description: "Make a local plain-text draft preview before sending mail. Sends nothing. Review all recipients and the full text before using send.",
    target: input => `${prefix}: local mail preview to ${input.to.join(", ")}; copies ${input.cc.join(", ")}`,
    execute: async (input, context) => previews.create(input, context) });
  registry.register({ name: `${prefix}.send`, permission: "personal.write", parameters: MailSendSchema,
    description: "Send an unchanged local draft preview from preview_send, only after the owner's explicit one-time Send confirmation. A preview can be submitted once.",
    target: (input, context) => {
      const v = previews.read(input.previewId, context);
      return `${prefix}: Send?\nTo: ${v.to.join(", ")}\nCc: ${v.cc.join(", ")}\nSubject: ${v.subject}\n\n${v.text}\n\nNo attachments. No hidden recipients.`;
    },
    execute: async (input, context) => {
      const draft = previews.take(input.previewId, context), identity = signIn.mailPreviewIdentity();
      const unchanged = () => {
        context.signal.throwIfAborted();
        if (identity !== signIn.mailPreviewIdentity()) throw new Error("Your sign-in changed. Make a new mail preview.");
      };
      return send(draft, unchanged);
    } });
}
